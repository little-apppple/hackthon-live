'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// 兼容层：node:sqlite（Node 22+ 内置，免原生编译）上提供 better-sqlite3 风格的
// prepare().run/get/all、pragma 与 transaction，业务代码无需感知差异。
class Db {
  constructor(file) {
    this.native = new DatabaseSync(file, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
  }

  exec(sql) {
    return this.native.exec(sql);
  }

  pragma(str) {
    return this.native.exec(`PRAGMA ${str}`);
  }

  prepare(sql) {
    const stmt = this.native.prepare(sql);
    return {
      run: (...params) => stmt.run(...params),
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
    };
  }

  transaction(fn) {
    return (...args) => {
      this.native.exec('BEGIN');
      try {
        const result = fn(...args);
        this.native.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          this.native.exec('ROLLBACK');
        } catch {
          /* 事务已回滚 */
        }
        throw e;
      }
    };
  }
}

const db = new Db(config.dbPath);
db.pragma('journal_mode = WAL');

// ---------- 表结构（活动隔离版） ----------
const SCHEMA = {
  events: `CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  end_time TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
)`,

  departments: `CREATE TABLE departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(event_id, name)
)`,

  groups: `CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(event_id, department_id, name)
)`,

  projects: `CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  access_key TEXT NOT NULL UNIQUE,
  port INTEGER NOT NULL,
  completed_stages INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'loading',
  revoked INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  last_report_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
)`,

  reports: `CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  stage TEXT,
  ok INTEGER NOT NULL,
  reject_code TEXT,
  message TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
)`,

  settings: `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
};

const TABLES_EXTRA = `CREATE TABLE IF NOT EXISTS hit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  terminal TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'web',
  ts INTEGER NOT NULL
)`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_hit_events_lookup ON hit_events(project_id, terminal, ts DESC);
CREATE INDEX IF NOT EXISTS idx_hit_events_ts ON hit_events(ts);
-- 端口唯一性只约束未归档行：归档后端口即回到可分配池（跨活动全局唯一，绑定真实监听）
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_port_active ON projects(port) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id);
CREATE INDEX IF NOT EXISTS idx_departments_event ON departments(event_id);
CREATE INDEX IF NOT EXISTS idx_projects_event ON projects(event_id);
`;

function columnsOf(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

// 列迁移（幂等）：集中所有 ADD COLUMN。旧库重建路径需在建表后、拷贝数据前再调用一次，
// 否则新列不存在会导致拷贝失败或取值丢失。
function applyColumnMigrations() {
  const adds = [
    'ALTER TABLE reports ADD COLUMN evidence TEXT',
    'ALTER TABLE projects ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE projects ADD COLUMN client_id TEXT',
    'ALTER TABLE projects ADD COLUMN hits INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE projects ADD COLUMN deliverable TEXT NOT NULL DEFAULT 'web'",
    'ALTER TABLE projects ADD COLUMN artifact_name TEXT',
    'ALTER TABLE projects ADD COLUMN members TEXT',
    'ALTER TABLE projects ADD COLUMN summary TEXT',
    'ALTER TABLE projects ADD COLUMN value TEXT',
    'ALTER TABLE projects ADD COLUMN features TEXT',
    'ALTER TABLE projects ADD COLUMN scenario TEXT',
    'ALTER TABLE projects ADD COLUMN ai_score INTEGER',
    'ALTER TABLE projects ADD COLUMN ai_score_detail TEXT',
    'ALTER TABLE projects ADD COLUMN ai_scored_at TEXT',
    'ALTER TABLE projects ADD COLUMN last_seen_at TEXT',
  ];
  for (const sql of adds) {
    try {
      db.exec(sql);
    } catch {
      /* 列已存在 */
    }
  }
}

// 首次建库
if (columnsOf('events').length === 0) db.exec(SCHEMA.events);
for (const t of ['departments', 'groups', 'projects', 'reports', 'settings']) {
  if (columnsOf(t).length === 0) db.exec(SCHEMA[t]);
}

// 迁移：无活动概念的旧库 → 全部数据归入默认活动（id=1）
if (columnsOf('departments').length > 0 && !columnsOf('departments').includes('event_id')) {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  const tx = db.transaction(() => {
    const defaultEvent = db.prepare('SELECT id FROM events ORDER BY id LIMIT 1').get();
    const eid = defaultEvent ? defaultEvent.id : 1;
    for (const t of ['departments', 'groups', 'projects']) {
      db.exec(`ALTER TABLE ${t} RENAME TO ${t}__old`);
      db.exec(SCHEMA[t]);
    }
    applyColumnMigrations(); // 新表建好后先补列，保证下面的拷贝能带上新列的值
    if (!defaultEvent) {
      db.prepare('INSERT INTO events (id, name, end_time, is_active) VALUES (?, ?, ?, 1)').run(
        eid,
        config.eventName,
        config.eventEndTime || null
      );
    }
    db.exec(`INSERT INTO departments (id, event_id, name, sort_order, created_at) SELECT id, ${eid}, name, sort_order, created_at FROM departments__old`);
    db.exec(`INSERT INTO groups (id, event_id, department_id, name, sort_order, created_at) SELECT id, ${eid}, department_id, name, sort_order, created_at FROM groups__old`);
    // 动态拷贝：旧表实际存在的列（含 hits/loop_count/client_id 等新增列）都要带上，否则新列值会被默认值覆盖
    const baseCols = ['id', 'group_id', 'name', 'description', 'access_key', 'port', 'completed_stages', 'status', 'revoked', 'archived', 'last_report_at', 'created_at', 'updated_at'];
    const extraCols = ['loop_count', 'client_id', 'hits', 'deliverable', 'artifact_name', 'members', 'summary', 'value', 'features', 'scenario', 'ai_score', 'ai_score_detail', 'ai_scored_at', 'last_seen_at'];
    const oldCols = new Set(columnsOf('projects__old'));
    const copyCols = [...baseCols, ...extraCols.filter((c) => oldCols.has(c))];
    db.exec(`INSERT INTO projects (event_id, ${copyCols.join(', ')})
             SELECT ${eid}, ${copyCols.join(', ')} FROM projects__old`);
    for (const t of ['departments', 'groups', 'projects']) {
      db.exec(`DROP TABLE ${t}__old`);
    }
  });
  tx();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
  console.log('[db] 已迁移旧数据到默认活动');
}

// 轻量迁移：验收自动化的证据 JSON
try {
  db.exec('ALTER TABLE reports ADD COLUMN evidence TEXT');
} catch {
  /* 列已存在 */
}

// 迁移：迭代轮次（--loop 开新一轮时 +1，进度重置）
try {
  db.exec('ALTER TABLE projects ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 1');
} catch {
  /* 列已存在 */
}

// 迁移：人气值（点击统计，按「终端 + 项目 + 时间窗」去重）
try {
  db.exec('ALTER TABLE projects ADD COLUMN hits INTEGER NOT NULL DEFAULT 0');
} catch {}

// 迁移：项目展示信息（注册时采集，用于大屏/后台展示）与交付形态
for (const col of ['members', 'summary', 'value', 'features', 'scenario', 'artifact_name']) {
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
  } catch {}
}
try {
  db.exec("ALTER TABLE projects ADD COLUMN deliverable TEXT NOT NULL DEFAULT 'web'");
} catch {}

// 迁移：AI 参考评分（提交后自动计算并上报）
try {
  db.exec('ALTER TABLE projects ADD COLUMN ai_score INTEGER');
} catch {}
try {
  db.exec('ALTER TABLE projects ADD COLUMN ai_score_detail TEXT');
} catch {}
try {
  db.exec('ALTER TABLE projects ADD COLUMN ai_scored_at TEXT');
} catch {}

// 迁移：客户端唯一标识（首次接入时生成并绑定，防止重名队伍互相覆盖）
try {
  db.exec('ALTER TABLE projects ADD COLUMN client_id TEXT');
} catch {
  /* 列已存在 */
}

// reports.evidence 的列需要在新旧两种建库路径后都存在
if (!columnsOf('reports').includes('evidence')) {
  try {
    db.exec('ALTER TABLE reports ADD COLUMN evidence TEXT');
  } catch {
    /* 已存在 */
  }
}

db.exec(TABLES_EXTRA);
db.exec(INDEXES);

// 启动自检：必需列缺失说明迁移链路有问题——失败退出，避免带病启动后大屏/后台全 500
function assertRequiredColumns() {
  const required = ['loop_count', 'client_id', 'hits', 'deliverable', 'artifact_name', 'members', 'summary', 'value', 'features', 'scenario', 'ai_score', 'last_seen_at'];
  const cols = new Set(columnsOf('projects'));
  const missing = required.filter((c) => !cols.has(c));
  if (missing.length) {
    console.error('[db] 数据库迁移异常，缺少必需列: ' + missing.join(', '));
    console.error('[db] 请备份数据库后重试，或联系维护者；为避免数据错乱本次启动终止。');
    process.exit(1);
  }
}
applyColumnMigrations(); // 正常路径的列迁移（旧库重建路径已在内部调用过）
assertRequiredColumns();
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

module.exports = db;
