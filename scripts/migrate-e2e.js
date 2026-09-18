'use strict';
// 旧库迁移回归测试：
//   node scripts/migrate-e2e.js
// 覆盖：构造「无 event_id 的 legacy 库」（含 reports.evidence、projects.hits 等数据）→ 用该库启动服务
//      → 断言迁移后 /api/snapshot 与 /api/admin/projects 可用（列齐全、数据保留）
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp-migrate');
const PORT = 3600;
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = 'test123';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 node:sqlite 直接构造 legacy 结构：departments 无 event_id，projects 为基础列 + 少量新列数据
function buildLegacyDb(file) {
  const script = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(file)});
db.exec(\`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, end_time TEXT, is_active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))\`);
db.exec(\`CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), UNIQUE(name))\`);
db.exec(\`CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, department_id INTEGER NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), UNIQUE(department_id, name))\`);
db.exec(\`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', access_key TEXT NOT NULL UNIQUE, port INTEGER NOT NULL, completed_stages INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'loading', revoked INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, last_report_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), hits INTEGER NOT NULL DEFAULT 0, loop_count INTEGER NOT NULL DEFAULT 1)\`);
db.exec(\`CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, stage TEXT, ok INTEGER NOT NULL, reject_code TEXT, message TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), evidence TEXT)\`);
db.prepare('INSERT INTO departments (id, name) VALUES (1, ?)').run('legacy 部门');
db.prepare('INSERT INTO groups (id, department_id, name) VALUES (1, 1, ?)').run('legacy 小组');
db.prepare('INSERT INTO projects (id, group_id, name, access_key, port, completed_stages, status, hits, loop_count) VALUES (1, 1, ?, ?, 4700, 6, ?, 77, 3)')
  .run('legacy 项目', 'hk_' + 'a'.repeat(32), 'deployed');
db.prepare('INSERT INTO reports (project_id, stage, ok, message, evidence) VALUES (1, ?, 1, ?, ?)').run('deployment', '旧库上报', '{"old":true}');
db.close();
console.log('legacy db built');
`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构造 legacy 库失败: ${r.stderr}`);
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const dbFile = path.join(TMP, 'legacy.db');
  buildLegacyDb(dbFile);
  check('已构造 legacy 库（departments 无 event_id、projects 含 hits/loop_count 数据）', fs.existsSync(dbFile));

  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, PUBLIC_HOST: 'localhost', ADMIN_PASSWORD: ADMIN_PW },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(BASE + '/healthz')).ok;
    } catch {
      await sleep(250);
    }
  }
  check('迁移后服务可启动', up, log.slice(-300));
  try {
    if (!up) throw new Error('服务未启动');

    const snap = await fetch(BASE + '/api/snapshot');
    const snapBody = await snap.json().catch(() => null);
    check('迁移后快照可用（不因缺列 500）', snap.status === 200 && snapBody?.ok, `HTTP ${snap.status} ${JSON.stringify(snapBody).slice(0, 160)}`);
    check('旧库已有活动并被识别', snapBody?.snapshot?.eventName === 'legacy 活动' || !!snapBody?.snapshot?.eventId, JSON.stringify({ eventName: snapBody?.snapshot?.eventName }));
    check('迁移保留既有数据（项目 + 人气值）', snapBody?.snapshot?.kpi?.totalHits === 77, JSON.stringify(snapBody?.snapshot?.kpi));

    const login = await fetch(BASE + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PW }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const projects = await fetch(BASE + '/api/admin/projects', { headers: { Cookie: cookie } });
    const pBody = await projects.json().catch(() => null);
    check('管理端项目列表可用（新列已补齐）', projects.status === 200 && pBody?.ok, `HTTP ${projects.status}`);
    check('管理端可见迁移后的项目与轮次', pBody?.projects?.[0]?.name === 'legacy 项目' && pBody?.projects?.[0]?.loop_count === 3, JSON.stringify(pBody?.projects?.[0] || {}).slice(0, 160));

    const hits = await fetch(BASE + '/api/hits');
    const hBody = await hits.json().catch(() => null);
    check('人气接口可用', hits.status === 200 && hBody?.ok, `HTTP ${hits.status}`);
    check(
      '旧库上报审计保留',
      Array.isArray(snapBody?.snapshot?.events) && snapBody.snapshot.events.some((e) => e.stage === 'deployment' && e.project === 'legacy 项目'),
      JSON.stringify(snapBody?.snapshot?.events?.slice(0, 1))
    );
  } finally {
    server.kill();
    await sleep(500);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
