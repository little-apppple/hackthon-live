'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { stageByRef, stageByIndex, deriveStatus, progressPercent, DEPLOY_STAGE_INDEX, LOOP_MIN_STAGE_INDEX, VALID_STAGE_IDS, STAGES } = require('../stages');
const { notifyRefresh } = require('../sse');
const { allocatePort, probeLocalPort } = require('../ports');
const { getActiveEvent } = require('../events');

const router = express.Router();

function isUniqueViolation(e) {
  return e?.errcode === 2067 || /UNIQUE constraint failed/i.test(e?.message || '');
}

function genAccessKey() {
  return 'hk_' + crypto.randomBytes(16).toString('hex');
}

// Express 4 不捕获 async 异常，统一包装防止进程崩溃
const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 每项目上报限频（内存计时，含被拒请求，防刷）
const lastAttemptAt = new Map(); // projectId -> epoch ms
setInterval(() => {
  const cutoff = Date.now() - config.rateLimitMs * 5;
  for (const [id, ts] of lastAttemptAt) {
    if (ts < cutoff) lastAttemptAt.delete(id);
  }
}, 60 * 1000).unref();

function audit(projectId, stage, ok, rejectCode, message, ip, evidenceJson) {
  db.prepare(
    'INSERT INTO reports (project_id, stage, ok, reject_code, message, ip, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(projectId, stage, ok ? 1 : 0, rejectCode || null, message || '', ip || '', evidenceJson || null);
}

router.post('/report', aw(async (req, res) => {
  const { accessKey, stage, message } = req.body || {};
  const ip = req.ip || '';
  const msg = typeof message === 'string' ? message.slice(0, 300) : '';

  if (!accessKey || typeof accessKey !== 'string') {
    return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(accessKey.trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }

  if (project.revoked) {
    audit(project.id, String(stage ?? ''), 0, 'KEY_REVOKED', msg, ip);
    return res
      .status(403)
      .json({ ok: false, code: 'KEY_REVOKED', error: '该 accessKey 已被管理员吊销，请联系管理员' });
  }

  const st = stageByRef(stage);
  if (!st) {
    audit(project.id, String(stage ?? ''), 0, 'INVALID_STAGE', msg, ip);
    return res.status(400).json({
      ok: false,
      code: 'INVALID_STAGE',
      error: `stage 无效，应为 1-${STAGES.length} 的序号或节点标识`,
      validStages: VALID_STAGE_IDS,
    });
  }

  const expected = project.completed_stages + 1;
  if (st.index < expected) {
    audit(project.id, st.id, 0, 'STAGE_ALREADY_DONE', msg, ip);
    return res.status(409).json({
      ok: false,
      code: 'STAGE_ALREADY_DONE',
      error: `节点「${st.name}」已完成，不能重复上报`,
      completedStages: project.completed_stages,
      nextStage: expected <= STAGES.length ? stageByIndex(expected) : null,
    });
  }
  if (st.index > expected) {
    audit(project.id, st.id, 0, 'STAGE_OUT_OF_ORDER', msg, ip);
    return res.status(409).json({
      ok: false,
      code: 'STAGE_OUT_OF_ORDER',
      error: `节点顺序错误：应先完成「${stageByIndex(expected).name}」。禁止跳节点。`,
      completedStages: project.completed_stages,
      expectedStage: stageByIndex(expected),
    });
  }

  // 限频放在全部校验之后：被拒请求不消耗窗口，409 自愈可立即重报正确的节点
  const now = Date.now();
  const last = lastAttemptAt.get(project.id) || 0;
  const waitMs = config.rateLimitMs - (now - last);
  if (waitMs > 0) {
    audit(project.id, st.id, 0, 'RATE_LIMITED', msg, ip);
    const retryAfter = Math.ceil(waitMs / 1000);
    return res.status(429).json({
      ok: false,
      code: 'RATE_LIMITED',
      error: `上报过于频繁，请 ${retryAfter} 秒后重试`,
      retryAfterSeconds: retryAfter,
    });
  }
  lastAttemptAt.set(project.id, now);

  // 证据链：客户端证据（探活/接口/E2E 结果等）+ 服务端对部署节点的端口探活
  let evidence = null;
  if (req.body?.evidence && typeof req.body.evidence === 'object' && !Array.isArray(req.body.evidence)) {
    evidence = { ...req.body.evidence };
  }
  let deployProbe = null;
  if (st.index === DEPLOY_STAGE_INDEX) {
    deployProbe = await probeLocalPort(project.port);
    evidence = { ...(evidence || {}), serverProbe: deployProbe };
  }
  const evidenceJson = evidence ? JSON.stringify(evidence).slice(0, 4000) : null;

  // 通过全部校验：推进节点
  const newStatus = deriveStatus(st.index, true);
  db.prepare(
    `UPDATE projects
        SET completed_stages = ?, status = ?, last_report_at = datetime('now','localtime'),
            updated_at = datetime('now','localtime')
      WHERE id = ?`
  ).run(st.index, newStatus, project.id);
  audit(project.id, st.id, 1, null, msg, ip, evidenceJson);

  const progress = progressPercent(st.index);
  const next = st.index < STAGES.length ? stageByIndex(st.index + 1) : null;

  let finalMessage;
  if (st.index === DEPLOY_STAGE_INDEX && !deployProbe.ok) {
    finalMessage = '已记录上线部署（⚠ 服务端探测端口未响应，请确认应用已启动并监听预留端口）';
  } else if (st.index === DEPLOY_STAGE_INDEX) {
    finalMessage = '已上线部署（服务端探活通过），大屏链接已开放访问';
  } else if (st.index === STAGES.length) {
    finalMessage = '最终提交完成，作品已定格为参赛评分版本！';
  } else {
    finalMessage = `「${st.name}」已记录，当前进度 ${progress}%`;
  }
  notifyRefresh('report');

  res.json({
    ok: true,
    code: 'ACCEPTED',
    stage: st,
    completedStages: st.index,
    progress,
    deployLinkReady: st.index >= DEPLOY_STAGE_INDEX,
    deployProbe: deployProbe ? (deployProbe.ok ? 'ok' : 'unreachable') : undefined,
    nextStage: next,
    message: finalMessage,
  });
}));

// 自助注册（技能包 --init 注册模式）：幂等——同一当前活动内「部门/小组/项目名」
// 只生成一次 accessKey，重复调用返回同一密钥（可安全重跑、可多处下发）。
// 安全模型：注册需携带本期活动的注册令牌（管理员经 /api/admin/register-token 签发、
// 打包技能包时烘入 server.json），防止用公开大屏上的部门/小组/项目名推导任意 accessKey；
// 每 IP 限频；成功注册写入审计。
const registerAttempts = new Map(); // ip -> epoch ms 数组
const loopLastAt = new Map(); // projectId -> epoch ms（loop 每项目 10s 窗口）
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [ip, arr] of registerAttempts) {
    if (!arr.some((t) => t >= cutoff)) registerAttempts.delete(ip);
  }
}, 60 * 1000).unref();
function registerRateLimited(ip) {
  const now = Date.now();
  const arr = (registerAttempts.get(ip) || []).filter((t) => now - t < 60 * 1000);
  if (arr.length >= 10) return true;
  arr.push(now);
  registerAttempts.set(ip, arr);
  return false;
}
function verifyRegisterToken(eventId, token) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`register_token:${eventId}`);
  if (!row || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(String(token).trim());
  const b = Buffer.from(row.value);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/register', aw(async (req, res) => {
  const ip = req.ip || '';
  if (registerRateLimited(ip)) {
    return res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: '注册请求过于频繁，请稍后重试', retryAfterSeconds: 60 });
  }
  const norm = (v) => String(v ?? '').trim().slice(0, 50);
  const deptName = norm(req.body?.department);
  const groupName = norm(req.body?.group);
  const projectName = norm(req.body?.project);
  const description = String(req.body?.description ?? '').trim().slice(0, 200);
  if (!deptName || !groupName || !projectName) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_PARAMS',
      error: 'department / group / project 均不能为空（各限 50 字符内）',
    });
  }
  const event = getActiveEvent();
  if (!verifyRegisterToken(event.id, req.body?.registerToken)) {
    return res.status(401).json({
      ok: false,
      code: 'REGISTER_TOKEN_INVALID',
      error: '注册令牌缺失或不正确：请使用本期下发的技能包（内含注册令牌），或向赛事管理员索取',
    });
  }

  const findProject = () =>
    db
      .prepare(
        `SELECT p.* FROM projects p
           JOIN groups g ON g.id = p.group_id
           JOIN departments d ON d.id = g.department_id
          WHERE p.event_id = ? AND d.name = ? AND g.name = ? AND p.name = ? AND p.archived = 0`
      )
      .get(event.id, deptName, groupName, projectName);

  let project = findProject();
  let createdNow = false;
  if (!project) {
    // 端口探测含异步 IO，放事务外；并发重入由事务内的二次查找兜底。
    // 开赛集中注册时并发请求会探到同一个空闲端口，端口唯一约束冲突时换端口重试（最多 3 次）。
    let port = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (port === null) port = await allocatePort();
      } catch (e) {
        if (e.code === 'NO_FREE_PORT') {
          return res.status(503).json({ ok: false, code: 'NO_FREE_PORT', error: e.message });
        }
        throw e;
      }
      try {
        const tx = db.transaction(() => {
          let dept = db.prepare('SELECT id FROM departments WHERE event_id = ? AND name = ?').get(event.id, deptName);
          if (!dept) db.prepare('INSERT INTO departments (event_id, name) VALUES (?, ?)').run(event.id, deptName);
          dept = db.prepare('SELECT id FROM departments WHERE event_id = ? AND name = ?').get(event.id, deptName);
          let group = db.prepare('SELECT id FROM groups WHERE department_id = ? AND name = ?').get(dept.id, groupName);
          if (!group) db.prepare('INSERT INTO groups (event_id, department_id, name) VALUES (?, ?, ?)').run(event.id, dept.id, groupName);
          group = db.prepare('SELECT id FROM groups WHERE department_id = ? AND name = ?').get(dept.id, groupName);
          const again = db
            .prepare('SELECT * FROM projects WHERE event_id = ? AND group_id = ? AND name = ? AND archived = 0')
            .get(event.id, group.id, projectName);
          if (again) return { project: again, created: false }; // 并发重入：另一请求刚建好，直接复用
          const info = db
            .prepare('INSERT INTO projects (event_id, group_id, name, description, access_key, port) VALUES (?, ?, ?, ?, ?, ?)')
            .run(event.id, group.id, projectName, description, genAccessKey(), port);
          return { project: db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid), created: true };
        });
        const run = tx(); // transaction() 返回包装函数，必须调用才执行
        project = run.project;
        createdNow = run.created;
        break;
      } catch (e) {
        if (isUniqueViolation(e) && attempt < 3) {
          port = null; // 端口在探测后被并发占用：换下一个候选端口重来
          continue;
        }
        if (isUniqueViolation(e)) {
          return res.status(409).json({ ok: false, code: 'PORT_CONFLICT', error: '注册冲突（端口/密钥刚被占用），请重试' });
        }
        throw e;
      }
    }
    notifyRefresh('project-created');
  }
  audit(project.id, 'register', 1, null, createdNow ? '自助注册（新项目）' : '自助注册（幂等补发密钥）', ip);

  res.json({
    ok: true,
    code: 'REGISTERED',
    idempotent: !createdNow,
    revoked: !!project.revoked,
    warning: project.revoked ? '该密钥已被管理员吊销，请联系赛事管理员恢复' : undefined,
    eventId: event.id,
    projectName: project.name,
    accessKey: project.access_key,
    port: project.port,
    deployUrl: `http://${config.publicHost}:${project.port}`,
    configTemplate: {
      serverUrl: `http://${config.publicHost}:${config.port}`,
      accessKey: project.access_key,
      deployUrl: `http://${config.publicHost}:${project.port}`,
    },
  });
}));

// 开新一轮迭代（loop）：上线部署完成后，可调整需求重新走全流程
// 幂等安全：进度重置只在成功响应时发生；loop_count 单调递增，历史上报记录全部保留在审计中
router.post('/loop', aw(async (req, res) => {
  const { accessKey } = req.body || {};
  const ip = req.ip || '';
  if (!accessKey || typeof accessKey !== 'string') {
    return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(accessKey.trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }
  // 每项目 10 秒窗口限频：防 agent 死循环误调把轮次刷爆（复用 /report 的窗口语义）
  const now = Date.now();
  const lastLoopAt = loopLastAt.get(project.id) || 0;
  if (now - lastLoopAt < 10000) {
    const retryAfter = Math.ceil((10000 - (now - lastLoopAt)) / 1000);
    return res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: `操作过于频繁，请 ${retryAfter} 秒后重试`, retryAfterSeconds: retryAfter });
  }
  loopLastAt.set(project.id, now);
  if (project.revoked) {
    audit(project.id, 'loop', 0, 'KEY_REVOKED', '', ip);
    return res.status(403).json({ ok: false, code: 'KEY_REVOKED', error: '该 accessKey 已被管理员吊销，请联系管理员' });
  }
  if (project.completed_stages < LOOP_MIN_STAGE_INDEX) {
    audit(project.id, 'loop', 0, 'LOOP_NOT_ALLOWED', '', ip);
    return res.status(409).json({
      ok: false,
      code: 'LOOP_NOT_ALLOWED',
      error: `至少完成「上线部署」（${LOOP_MIN_STAGE_INDEX}/${STAGES.length}）才能开启新一轮迭代`,
      completedStages: project.completed_stages,
      nextStage: stageByIndex(project.completed_stages + 1),
    });
  }
  const newLoop = project.loop_count + 1;
  db.prepare(
    `UPDATE projects
        SET loop_count = ?, completed_stages = 0, status = 'active',
            updated_at = datetime('now','localtime')
      WHERE id = ?`
  ).run(newLoop, project.id);
  audit(project.id, 'loop', 1, null, `开启第 ${newLoop} 轮迭代（上一轮完成 ${project.completed_stages}/${STAGES.length}）`, ip);
  notifyRefresh('loop');

  res.json({
    ok: true,
    code: 'LOOP_STARTED',
    loopCount: newLoop,
    completedStages: 0,
    progress: 0,
    nextStage: stageByIndex(1),
    message: `已进入第 ${newLoop} 轮迭代：调整需求后重新走流程，历史记录保留在审计中`,
  });
}));

// Agent 查询当前进度与下一节点（409 自愈 / --verify 定位部署地址用）
router.get('/report/status', (req, res) => {
  const accessKey = req.query.accessKey;
  if (!accessKey) return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(String(accessKey).trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }
  const next = project.completed_stages < STAGES.length ? stageByIndex(project.completed_stages + 1) : null;
  res.json({
    ok: true,
    revoked: !!project.revoked,
    projectName: project.name,
    port: project.port,
    completedStages: project.completed_stages,
    progress: progressPercent(project.completed_stages),
    nextStage: next,
  });
});

module.exports = router;
