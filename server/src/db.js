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

const INDEXES = `
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

// 首次建库
if (columnsOf('events').length === 0) db.exec(SCHEMA.events);
for (const t of ['departments', 'groups', 'projects', 'reports', 'settings']) {
  if (columnsOf(t).length === 0) db.exec(SCHEMA[t]);
}

// 轻量迁移：验收自动化的证据 JSON
try {
  db.exec('ALTER TABLE reports ADD COLUMN evidence TEXT');
} catch {
  /* 列已存在 */
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
    if (!defaultEvent) {
      db.prepare('INSERT INTO events (id, name, end_time, is_active) VALUES (?, ?, ?, 1)').run(
        eid,
        config.eventName,
        config.eventEndTime || null
      );
    }
    db.exec(`INSERT INTO departments (id, event_id, name, sort_order, created_at) SELECT id, ${eid}, name, sort_order, created_at FROM departments__old`);
    db.exec(`INSERT INTO groups (id, event_id, department_id, name, sort_order, created_at) SELECT id, ${eid}, department_id, name, sort_order, created_at FROM groups__old`);
    db.exec(`INSERT INTO projects (id, event_id, group_id, name, description, access_key, port, completed_stages, status, revoked, archived, last_report_at, created_at, updated_at)
             SELECT id, ${eid}, group_id, name, description, access_key, port, completed_stages, status, revoked, archived, last_report_at, created_at, updated_at FROM projects__old`);
    for (const t of ['departments', 'groups', 'projects']) {
      db.exec(`DROP TABLE ${t}__old`);
    }
  });
  tx();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
  console.log('[db] 已迁移旧数据到默认活动');
}

// reports.evidence 的列需要在新旧两种建库路径后都存在
if (!columnsOf('reports').includes('evidence')) {
  try {
    db.exec('ALTER TABLE reports ADD COLUMN evidence TEXT');
  } catch {
    /* 已存在 */
  }
}

db.exec(INDEXES);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

module.exports = db;
