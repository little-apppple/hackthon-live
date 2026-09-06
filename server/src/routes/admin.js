'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { getActiveEvent, activateEvent } = require('../events');
const { createSession, destroySession, isAuthed, requireAuth } = require('../auth');
const { allocatePort, poolSummary, setPoolRange } = require('../ports');
const deployer = require('../deployer');
const { notifyRefresh } = require('../sse');
const { STAGES } = require('../stages');

const router = express.Router();

// Express 4 不捕获 async 异常，统一包装防止进程崩溃
const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function genAccessKey() {
  return 'hk_' + crypto.randomBytes(16).toString('hex');
}

function isUniqueViolation(e) {
  return e?.errcode === 2067 || /UNIQUE constraint failed/i.test(e?.message || '');
}

// 请求的活动上下文：?eventId= 显式指定，缺省为当前活跃活动
function resolveEventId(req) {
  const e = Number(req.query.eventId);
  if (Number.isFinite(e) && e > 0) {
    const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(e);
    if (ev) return ev.id;
  }
  return getActiveEvent().id;
}

// ---------- 认证 ----------
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== config.adminPassword) {
    return res.status(401).json({ ok: false, code: 'BAD_PASSWORD', error: '管理密码错误' });
  }
  createSession(res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ ok: true, authed: isAuthed(req) });
});

router.use(requireAuth);

// ---------- 活动 ----------
router.get('/events', (req, res) => {
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.end_time, e.is_active, e.created_at,
              (SELECT COUNT(*) FROM departments d WHERE d.event_id = e.id) AS department_count,
              (SELECT COUNT(*) FROM groups g WHERE g.event_id = e.id) AS group_count,
              (SELECT COUNT(*) FROM projects p WHERE p.event_id = e.id AND p.archived = 0) AS project_count
         FROM events e ORDER BY e.id`
    )
    .all();
  const active = getActiveEvent();
  res.json({ ok: true, events: rows, activeEventId: active.id });
});

router.post('/events', (req, res) => {
  const name = (req.body?.name || '').trim();
  const endTime = (req.body?.endTime || '').trim() || null;
  if (!name) return res.status(400).json({ ok: false, error: '活动名称不能为空' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  // 第一个活动自动成为当前活动，其余默认待用
  const info = db.prepare('INSERT INTO events (name, end_time, is_active) VALUES (?, ?, ?)').run(name, endTime, count === 0 ? 1 : 0);
  notifyRefresh('event-created');
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/events/:id', (req, res) => {
  const name = (req.body?.name || '').trim();
  const endTime = req.body?.endTime === undefined ? undefined : (req.body?.endTime || '').trim() || null;
  if (!name) return res.status(400).json({ ok: false, error: '活动名称不能为空' });
  const info = db.prepare('UPDATE events SET name = ?, end_time = COALESCE(?, end_time) WHERE id = ?').run(name, endTime, req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: '活动不存在' });
  notifyRefresh('event-updated');
  res.json({ ok: true });
});

// 切换当前活动：大屏默认展示与后台默认上下文随之切换
router.post('/events/:id/activate', (req, res) => {
  if (!activateEvent(req.params.id)) return res.status(404).json({ ok: false, error: '活动不存在' });
  notifyRefresh('event-switch');
  res.json({ ok: true });
});

router.delete('/events/:id', (req, res) => {
  const id = req.params.id;
  const dept = db.prepare('SELECT COUNT(*) AS n FROM departments WHERE event_id = ?').get(id);
  const activeProj = db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND archived = 0')
    .get(id);
  if (dept.n > 0 || activeProj.n > 0) {
    return res.status(409).json({ ok: false, error: '该活动下仍有部门/小组/进行中项目，清空后才能删除' });
  }
  // 已归档项目与审计随之清除（归档即代表赛事数据不再保留）
  db.transaction(() => {
    db.prepare('DELETE FROM reports WHERE project_id IN (SELECT id FROM projects WHERE event_id = ?)').run(id);
    db.prepare('DELETE FROM projects WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
  })();
  getActiveEvent(); // 兜底：若删的是当前活动，重新选中/创建
  notifyRefresh('event-deleted');
  res.json({ ok: true });
});

// ---------- 部门（按活动隔离） ----------
router.get('/departments', (req, res) => {
  const eventId = resolveEventId(req);
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.sort_order,
              (SELECT COUNT(*) FROM groups g WHERE g.department_id = d.id) AS group_count
         FROM departments d WHERE d.event_id = ? ORDER BY d.sort_order, d.id`
    )
    .all(eventId);
  res.json({ ok: true, eventId, departments: rows });
});

router.post('/departments', (req, res) => {
  const eventId = resolveEventId(req);
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '部门名称不能为空' });
  try {
    const info = db.prepare('INSERT INTO departments (event_id, name) VALUES (?, ?)').run(eventId, name);
    notifyRefresh('roster');
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ ok: false, error: '该活动下部门名称已存在' });
  }
});

router.put('/departments/:id', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '部门名称不能为空' });
  try {
    const info = db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, req.params.id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: '部门不存在' });
    notifyRefresh('roster');
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ ok: false, error: '同活动下部门名称已存在' });
  }
});

router.delete('/departments/:id', (req, res) => {
  const g = db.prepare('SELECT COUNT(*) AS n FROM groups WHERE department_id = ?').get(req.params.id);
  if (g.n > 0) return res.status(409).json({ ok: false, error: '该部门下仍有小组，请先删除小组' });
  const info = db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: '部门不存在' });
  notifyRefresh('roster');
  res.json({ ok: true });
});

// ---------- 小组（随部门挂活动） ----------
router.get('/groups', (req, res) => {
  const eventId = resolveEventId(req);
  const departmentId = req.query.departmentId;
  const rows = departmentId
    ? db
        .prepare(
          `SELECT g.id, g.name, g.department_id,
                  (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id AND p.archived = 0) AS project_count
             FROM groups g WHERE g.department_id = ? ORDER BY g.sort_order, g.id`
        )
        .all(departmentId)
    : db
        .prepare(
          `SELECT g.id, g.name, g.department_id,
                  (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id AND p.archived = 0) AS project_count
             FROM groups g WHERE g.event_id = ? ORDER BY g.department_id, g.sort_order, g.id`
        )
        .all(eventId);
  res.json({ ok: true, eventId, groups: rows });
});

router.post('/groups', (req, res) => {
  const { departmentId } = req.body || {};
  const name = (req.body?.name || '').trim();
  if (!name || !departmentId) return res.status(400).json({ ok: false, error: '参数缺失' });
  const dept = db.prepare('SELECT id, event_id FROM departments WHERE id = ?').get(departmentId);
  if (!dept) return res.status(404).json({ ok: false, error: '部门不存在' });
  try {
    const info = db.prepare('INSERT INTO groups (event_id, department_id, name) VALUES (?, ?, ?)').run(dept.event_id, dept.id, name);
    notifyRefresh('roster');
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ ok: false, error: '该部门下小组名称已存在' });
  }
});

router.put('/groups/:id', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '小组名称不能为空' });
  try {
    const info = db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, req.params.id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: '小组不存在' });
    notifyRefresh('roster');
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ ok: false, error: '同部门下小组名称已存在' });
  }
});

router.delete('/groups/:id', (req, res) => {
  const p = db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE group_id = ? AND archived = 0')
    .get(req.params.id);
  if (p.n > 0) return res.status(409).json({ ok: false, error: '该小组下仍有项目，请先归档项目' });
  const info = db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: '小组不存在' });
  notifyRefresh('roster');
  res.json({ ok: true });
});

// ---------- CSV 批量导入（导入到指定活动，格式：部门,小组） ----------
router.post('/import/csv', (req, res) => {
  const eventId = resolveEventId(req);
  const text = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: '请以 text/csv 提交或提供 csv 字段' });
  }
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ ok: false, error: '内容为空' });

  if (/^(部门|department)\s*[,，]/i.test(lines[0])) lines.shift();

  const getDept = db.prepare('SELECT id FROM departments WHERE event_id = ? AND name = ?');
  const addDept = db.prepare('INSERT INTO departments (event_id, name) VALUES (?, ?)');
  const getGroup = db.prepare('SELECT id FROM groups WHERE department_id = ? AND name = ?');
  const addGroup = db.prepare('INSERT INTO groups (event_id, department_id, name) VALUES (?, ?, ?)');

  let deptCreated = 0;
  let groupCreated = 0;
  const errors = [];
  const run = db.transaction(() => {
    for (const [i, line] of lines.entries()) {
      const cols = line.split(/[,，\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      const deptName = cols[0];
      const groupName = cols[1] || '';
      if (!deptName) {
        errors.push(`第 ${i + 1} 行：部门名为空`);
        continue;
      }
      let dept = getDept.get(eventId, deptName);
      if (!dept) {
        addDept.run(eventId, deptName);
        dept = getDept.get(eventId, deptName);
        deptCreated++;
      }
      if (groupName) {
        let group = getGroup.get(dept.id, groupName);
        if (!group) {
          addGroup.run(eventId, dept.id, groupName);
          groupCreated++;
        }
      }
    }
  });
  run();
  notifyRefresh('roster');
  res.json({ ok: true, eventId, deptCreated, groupCreated, errors });
});

// ---------- 项目与 accesskey（按活动隔离） ----------
router.get('/projects', (req, res) => {
  const eventId = resolveEventId(req);
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.port, p.access_key, p.completed_stages, p.status,
              p.revoked, p.archived, p.last_report_at, p.created_at,
              g.name AS group_name, g.id AS group_id, d.name AS department_name, d.id AS department_id
         FROM projects p
         JOIN groups g ON g.id = p.group_id
         JOIN departments d ON d.id = g.department_id
        WHERE p.event_id = ?
        ORDER BY p.archived, d.sort_order, d.id, g.sort_order, g.id, p.id`
    )
    .all(eventId);
  res.json({ ok: true, eventId, projects: rows });
});

// 创建项目：一个事务内生成 accesskey + 分配预留端口（端口池跨活动全局唯一）
router.post('/projects', aw(async (req, res) => {
  const { groupId, name } = req.body || {};
  const description = (req.body?.description || '').trim();
  const projectName = (name || '').trim();
  if (!groupId || !projectName) {
    return res.status(400).json({ ok: false, error: '请选择小组并填写项目名称' });
  }
  const group = db
    .prepare(
      `SELECT g.id, g.event_id, g.name, d.name AS department_name
         FROM groups g JOIN departments d ON d.id = g.department_id
        WHERE g.id = ?`
    )
    .get(groupId);
  if (!group) return res.status(404).json({ ok: false, error: '小组不存在' });

  try {
    const port = await allocatePort();
    const accessKey = genAccessKey();
    const info = db
      .prepare('INSERT INTO projects (event_id, group_id, name, description, access_key, port) VALUES (?, ?, ?, ?, ?, ?)')
      .run(group.event_id, group.id, projectName, description, accessKey, port);
    notifyRefresh('project-created');
    res.json({
      ok: true,
      id: info.lastInsertRowid,
      accessKey,
      port,
      deployUrl: `http://${config.publicHost}:${port}`,
      configTemplate: {
        serverUrl: `http://${config.publicHost}:${config.port}`,
        accessKey,
        deployUrl: `http://${config.publicHost}:${port}`,
      },
    });
  } catch (e) {
    if (e.code === 'NO_FREE_PORT') return res.status(503).json({ ok: false, error: e.message });
    if (isUniqueViolation(e)) {
      return res.status(409).json({ ok: false, error: '端口或密钥刚被占用，请重试' });
    }
    throw e;
  }
}));

router.post('/projects/:id/revoke', (req, res) => {
  const info = db
    .prepare("UPDATE projects SET revoked = 1, updated_at = datetime('now','localtime') WHERE id = ? AND archived = 0")
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: '项目不存在或已归档' });
  notifyRefresh('revoke');
  res.json({ ok: true });
});

router.post('/projects/:id/restore', (req, res) => {
  const info = db
    .prepare("UPDATE projects SET revoked = 0, updated_at = datetime('now','localtime') WHERE id = ? AND archived = 0")
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: '项目不存在或已归档' });
  notifyRefresh('restore');
  res.json({ ok: true });
});

// 归档（软删除）：端口与密钥随之退出预留，项目从大屏消失，审计日志保留
router.post('/projects/:id/archive', aw(async (req, res) => {
  const info = db
    .prepare("UPDATE projects SET archived = 1, updated_at = datetime('now','localtime') WHERE id = ? AND archived = 0")
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: '项目不存在或已归档' });
  await deployer.stopProject(Number(req.params.id)).catch(() => {}); // 归档即停服
  notifyRefresh('archive');
  res.json({ ok: true });
}));

// 彻底删除已归档项目（连同其审计记录）；未归档项目必须先归档
router.delete('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT id, name, archived FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: '项目不存在' });
  if (!p.archived) return res.status(409).json({ ok: false, error: '项目未归档，请先归档再彻底删除' });
  db.transaction(() => {
    db.prepare('DELETE FROM reports WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  })();
  notifyRefresh('destroy');
  res.json({ ok: true });
});

// ---------- 端口池（全局，占用明细标注活动；区间后台可调并持久化） ----------
router.get('/ports', (req, res) => {
  res.json({ ok: true, pool: poolSummary() });
});

router.put('/ports', (req, res) => {
  const start = Number(req.body?.start);
  const end = Number(req.body?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return res.status(400).json({ ok: false, error: '端口区间必须为整数' });
  }
  if (start < 1024 || end > 65535 || start > end) {
    return res.status(400).json({ ok: false, error: '区间无效：需满足 1024 ≤ 起始 ≤ 结束 ≤ 65535' });
  }
  const allocated = db.prepare('SELECT port FROM projects WHERE archived = 0 ORDER BY port').all();
  const outside = allocated.filter((p) => p.port < start || p.port > end).map((p) => p.port);
  if (outside.length > 0) {
    return res.status(409).json({
      ok: false,
      code: 'PORTS_OUTSIDE_RANGE',
      error: `有 ${outside.length} 个已预留端口不在新区间内，请先归档这些项目，或把区间扩大到覆盖它们`,
      ports: outside,
    });
  }
  setPoolRange(start, end);
  notifyRefresh('port-pool');
  res.json({ ok: true, pool: poolSummary() });
});

// ---------- 部署管理 ----------
router.get('/deploys', (req, res) => {
  res.json({ ok: true, deploys: deployer.listStatus() });
});

router.post('/deploys/:id/restart', aw(async (req, res) => {
  const r = await deployer.restartProject(Number(req.params.id));
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
  notifyRefresh('deploy');
  res.json({ ok: true, status: deployer.getStatus(Number(req.params.id)) });
}));

router.post('/deploys/:id/stop', aw(async (req, res) => {
  const r = await deployer.stopProject(Number(req.params.id));
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
  notifyRefresh('deploy');
  res.json({ ok: true, status: deployer.getStatus(Number(req.params.id)) });
}));

router.post('/deploys/:id/start', aw(async (req, res) => {
  const r = await deployer.startProject(Number(req.params.id));
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error, logTail: r.logTail });
  notifyRefresh('deploy');
  res.json({ ok: true, status: deployer.getStatus(Number(req.params.id)) });
}));

// ---------- 元信息 ----------
router.get('/meta', (req, res) => {
  const active = getActiveEvent();
  res.json({
    ok: true,
    stages: STAGES,
    publicHost: config.publicHost,
    serverPort: config.port,
    activeEventId: active.id,
  });
});

module.exports = router;
