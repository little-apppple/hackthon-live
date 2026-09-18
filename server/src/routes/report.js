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

  // 通过全部校验：推进节点（带守卫：校验后到写入前可能被吊销/归档/loop）
  const newStatus = deriveStatus(st.index, true);
  const upd = db
    .prepare(
      `UPDATE projects
          SET completed_stages = ?, status = ?, last_report_at = datetime('now','localtime'),
              updated_at = datetime('now','localtime')
        WHERE id = ? AND revoked = 0 AND archived = 0`
    )
    .run(st.index, newStatus, project.id);
  if (upd.changes === 0) {
    audit(project.id, st.id, 0, 'INVALID_KEY', msg, ip);
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: '项目状态已变化（可能被吊销/归档/迭代），请重新查询' });
  }
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

// 自助注册（技能包 --init 注册模式）：以**客户端标识 clientId** 为幂等键——
// 同一 clientId 重复注册返回同一项目（与名称无关）；不同 clientId 撞上已绑定的
// 部门/小组/项目名 → 409 NAME_TAKEN，避免重名队伍互相覆盖。
// 另外仍要求携带本期活动注册令牌（管理员签发、打包时烘入 server.json）；每 IP 限频；成功注册写入审计。
const CLIENT_ID_RE = /^cli_[0-9a-f]{32}$/;
const registerAttempts = new Map(); // ip -> epoch ms 数组
const loopLastAt = new Map(); // projectId -> epoch ms（loop 每项目 10s 窗口）

// 人气上报限频（每 IP 每分钟 60 次）与明细清理（只保留去重窗口所需的时间范围）
const hitAttempts = new Map(); // ip -> epoch ms 数组
function hitRateLimited(ip) {
  const now = Date.now();
  const arr = (hitAttempts.get(ip) || []).filter((t) => now - t < 60 * 1000);
  if (arr.length >= 60) return true;
  arr.push(now);
  hitAttempts.set(ip, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hitAttempts) {
    if (!arr.some((t) => now - t < 60 * 1000)) hitAttempts.delete(ip);
  }
  try {
    db.prepare('DELETE FROM hit_events WHERE ts < ?').run(now - Math.max(config.hitWindowMs * 10, 3600000));
  } catch {
    /* 清理失败不影响服务 */
  }
}, 10 * 60 * 1000).unref();
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [ip, arr] of registerAttempts) {
    if (!arr.some((t) => t >= cutoff)) registerAttempts.delete(ip);
  }
}, 60 * 1000).unref();
function registerRateLimited(ip) {
  const now = Date.now();
  const arr = (registerAttempts.get(ip) || []).filter((t) => now - t < 60 * 1000);
  if (arr.length >= config.registerRateLimitPerMin) return true;
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
  const clientId = String(req.body?.clientId ?? '').trim();
  // 展示信息（注册时采集，用于大屏/后台展示）：参与人员、需求简述、价值、功能、场景
  const info = {
    members: String(req.body?.members ?? '').trim().slice(0, 200),
    summary: String(req.body?.summary ?? '').trim().slice(0, 300),
    value: String(req.body?.value ?? '').trim().slice(0, 300),
    features: String(req.body?.features ?? '').trim().slice(0, 500),
    scenario: String(req.body?.scenario ?? '').trim().slice(0, 300),
  };
  if (!deptName || !groupName || !projectName) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_PARAMS',
      error: 'department / group / project 均不能为空（各限 50 字符内）',
    });
  }
  if (clientId && !CLIENT_ID_RE.test(clientId)) {
    return res.status(400).json({ ok: false, code: 'INVALID_CLIENT_ID', error: 'clientId 格式无效（应为 cli_ + 32 位十六进制）' });
  }
  const event = getActiveEvent();
  if (!verifyRegisterToken(event.id, req.body?.registerToken)) {
    return res.status(401).json({
      ok: false,
      code: 'REGISTER_TOKEN_INVALID',
      error: '注册令牌缺失或不正确：请使用本期下发的技能包（内含注册令牌），或向赛事管理员索取',
    });
  }

  const NAME_TAKEN = () =>
    Object.assign(new Error('NAME_TAKEN'), {
      regCode: 'NAME_TAKEN',
      payload: {
        ok: false,
        code: 'NAME_TAKEN',
        error: `「${deptName} / ${groupName} / ${projectName}」已被其他客户端注册。如果这确实是你们队已注册的项目，请找回原接入配置（含 clientId）；否则更换项目名，或联系管理员解绑`,
      },
    });

  const byClient = (cid) =>
    cid
      ? db
          .prepare('SELECT * FROM projects WHERE event_id = ? AND client_id = ? AND archived = 0')
          .get(event.id, cid)
      : null;
  const byName = () =>
    db
      .prepare(
        `SELECT p.* FROM projects p
           JOIN groups g ON g.id = p.group_id
           JOIN departments d ON d.id = g.department_id
          WHERE p.event_id = ? AND d.name = ? AND g.name = ? AND p.name = ? AND p.archived = 0`
      )
      .get(event.id, deptName, groupName, projectName);

  // 解析顺序：clientId 命中 → 名字命中（未绑定则认领 / 已绑定同一客户端则复用 / 他人占用则冲突）
  const resolveExisting = () => {
    const mine = byClient(clientId);
    if (mine) return mine;
    const named = byName();
    if (!named) return null;
    if (!named.client_id) {
      if (clientId) {
        db.prepare('UPDATE projects SET client_id = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ? AND client_id IS NULL').run(clientId, named.id);
        named.client_id = clientId;
        audit(named.id, 'bind', 1, null, '存量项目认领客户端绑定', ip);
      }
      return named;
    }
    if (clientId && named.client_id === clientId) return named;
    throw NAME_TAKEN();
  };

  let project = null;
  let createdNow = false;
  let nameMismatch = null;
  try {
    project = resolveExisting();
  } catch (e) {
    if (e.regCode === 'NAME_TAKEN') return res.status(409).json(e.payload);
    throw e;
  }
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
          // 并发重入：事务内重新按 clientId / 名字解析，冲突直接拒绝
          const existing = resolveExisting();
          if (existing) return { project: existing, created: false };
          let dept = db.prepare('SELECT id FROM departments WHERE event_id = ? AND name = ?').get(event.id, deptName);
          if (!dept) db.prepare('INSERT INTO departments (event_id, name) VALUES (?, ?)').run(event.id, deptName);
          dept = db.prepare('SELECT id FROM departments WHERE event_id = ? AND name = ?').get(event.id, deptName);
          let group = db.prepare('SELECT id FROM groups WHERE department_id = ? AND name = ?').get(dept.id, groupName);
          if (!group) db.prepare('INSERT INTO groups (event_id, department_id, name) VALUES (?, ?, ?)').run(event.id, dept.id, groupName);
          group = db.prepare('SELECT id FROM groups WHERE department_id = ? AND name = ?').get(dept.id, groupName);
          const inserted = db
            .prepare('INSERT INTO projects (event_id, group_id, name, description, access_key, port, client_id, members, summary, value, features, scenario) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(event.id, group.id, projectName, description, genAccessKey(), port, clientId || null, info.members, info.summary, info.value, info.features, info.scenario);
          return { project: db.prepare('SELECT * FROM projects WHERE id = ?').get(inserted.lastInsertRowid), created: true };
        });
        const run = tx(); // transaction() 返回包装函数，必须调用才执行
        project = run.project;
        createdNow = run.created;
        break;
      } catch (e) {
        if (e.regCode === 'NAME_TAKEN') return res.status(409).json(e.payload);
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
  if (!createdNow) {
    // 同一客户端重注册：允许更新展示信息（改成员/补简介等），不影响名称与密钥
    if (clientId && project.client_id === clientId) {
      const fields = ['members', 'summary', 'value', 'features', 'scenario'].filter((k) => info[k]);
      if (fields.length) {
        db.prepare(`UPDATE projects SET ${fields.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`)
          .run(...fields.map((k) => info[k]), project.id);
        for (const k of fields) project[k] = info[k];
        audit(project.id, 'register', 1, null, `更新展示信息（${fields.join('/')}）`, ip);
      }
    }
    // 幂等命中：提示名称是否与首次绑定的不一致（项目名称以首次注册为准）
    const bound = db
      .prepare(
        `SELECT d.name AS dept, g.name AS grp, p.name AS project FROM projects p
           JOIN groups g ON g.id = p.group_id JOIN departments d ON d.id = g.department_id
          WHERE p.id = ?`
      )
      .get(project.id);
    if (bound && (bound.dept !== deptName || bound.grp !== groupName || bound.project !== projectName)) {
      nameMismatch = `本次提交的名称与首次注册不一致（已绑定为「${bound.dept} / ${bound.grp} / ${bound.project}」，以首次为准；如需改名请联系管理员）`;
    }
  }
  audit(project.id, 'register', 1, null, createdNow ? '自助注册（新项目）' : '自助注册（幂等补发密钥）', ip);

  res.json({
    ok: true,
    code: 'REGISTERED',
    idempotent: !createdNow,
    clientId: project.client_id || null,
    clientBound: !!project.client_id,
    warning: nameMismatch || (project.revoked ? '该密钥已被管理员吊销，请联系赛事管理员恢复' : undefined),
    revoked: !!project.revoked,
    eventId: event.id,
    projectName: project.name,
    info: { members: project.members, summary: project.summary, value: project.value, features: project.features, scenario: project.scenario },
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
  const wasSubmitted = project.completed_stages >= STAGES.length;
  const newLoop = project.loop_count + 1;
  db.prepare(
    `UPDATE projects
        SET loop_count = ?, completed_stages = 0, status = 'active',
            updated_at = datetime('now','localtime')
      WHERE id = ? AND revoked = 0 AND archived = 0`
  ).run(newLoop, project.id);
  audit(
    project.id,
    'loop',
    1,
    null,
    `开启第 ${newLoop} 轮迭代（上一轮完成 ${project.completed_stages}/${STAGES.length}）${wasSubmitted ? '；⚠ 解冻已提交作品，需重新提交' : ''}`,
    ip
  );
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

// 客户端绑定（手工发 key 模式：--init 落盘后调用；也用于校验绑定状态）
// 首次绑定成功；同一 clientId 重复调用幂等；已绑定其他 clientId → 409 CLIENT_MISMATCH（防止一把密钥在多台机器上互相覆盖）
router.post('/bind-client', (req, res) => {
  const { accessKey, clientId } = req.body || {};
  if (!accessKey || typeof accessKey !== 'string') {
    return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  }
  const cid = String(clientId ?? '').trim();
  if (!CLIENT_ID_RE.test(cid)) {
    return res.status(400).json({ ok: false, code: 'INVALID_CLIENT_ID', error: 'clientId 格式无效（应为 cli_ + 32 位十六进制）' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(accessKey.trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }
  if (project.revoked) {
    return res.status(403).json({ ok: false, code: 'KEY_REVOKED', error: '该 accessKey 已被管理员吊销，请联系管理员' });
  }
  if (!project.client_id) {
    db.prepare("UPDATE projects SET client_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND client_id IS NULL").run(cid, project.id);
    audit(project.id, 'bind', 1, null, '手工模式绑定客户端标识', req.ip || '');
    return res.json({ ok: true, code: 'BOUND', bound: true, clientId: cid });
  }
  if (project.client_id === cid) {
    return res.json({ ok: true, code: 'BOUND', bound: true, idempotent: true, clientId: cid });
  }
  return res.status(409).json({
    ok: false,
    code: 'CLIENT_MISMATCH',
    error: '该密钥已绑定其他客户端（可能已在另一台机器接入过）。如确需迁移，请管理员在后台「解绑客户端」后重试',
  });
});

// 人气值：点击上报（大屏上点击「打开项目」或「下载安装包」时触发）
// 去重规则：同一终端对同一项目，在 hitWindowMs（默认 60 秒）内的多次点击只计一次
router.post('/hit', (req, res) => {
  const ip = req.ip || '';
  if (hitRateLimited(ip)) {
    return res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: '点击上报过于频繁' });
  }
  const projectId = Number(req.body?.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ ok: false, code: 'INVALID_PROJECT', error: '缺少有效的 projectId' });
  }
  const kind = req.body?.kind === 'package' ? 'package' : 'web';
  const project = db.prepare('SELECT id, revoked, archived FROM projects WHERE id = ?').get(projectId);
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_PROJECT', error: '项目不存在' });
  }
  // 终端标识：前端 localStorage 生成的随机串；缺失时回退 IP + UA（弱标识）
  const rawTerminal = String(req.body?.terminal ?? '').trim().slice(0, 64);
  const terminal = rawTerminal || `ip:${crypto.createHash('sha256').update(`${ip}|${req.headers['user-agent'] || ''}`).digest('hex').slice(0, 32)}`;

  const now = Date.now();
  const last = db
    .prepare('SELECT ts FROM hit_events WHERE project_id = ? AND terminal = ? ORDER BY ts DESC LIMIT 1')
    .get(projectId, terminal);
  if (last && now - last.ts < config.hitWindowMs) {
    const hits = db.prepare('SELECT hits FROM projects WHERE id = ?').get(projectId)?.hits ?? 0;
    return res.json({ ok: true, counted: false, hits, windowMs: config.hitWindowMs });
  }

  db.transaction(() => {
    db.prepare('INSERT INTO hit_events (project_id, terminal, kind, ts) VALUES (?, ?, ?, ?)').run(projectId, terminal, kind, now);
    db.prepare("UPDATE projects SET hits = hits + 1, updated_at = datetime('now','localtime') WHERE id = ?").run(projectId);
  })();
  const hits = db.prepare('SELECT hits FROM projects WHERE id = ?').get(projectId)?.hits ?? 0;
  notifyRefresh('hit');
  res.json({ ok: true, counted: true, hits, windowMs: config.hitWindowMs });
});

// 查询人气值（大屏/后台/CLI 复用）
router.get('/hits', (req, res) => {
  const accessKey = req.headers['x-access-key'] || req.query.accessKey;
  if (accessKey) {
    const project = db.prepare('SELECT id, name, hits, deliverable FROM projects WHERE access_key = ?').get(String(accessKey).trim());
    if (!project) return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
    return res.json({ ok: true, projectName: project.name, hits: project.hits || 0, deliverable: project.deliverable });
  }
  const event = getActiveEvent();
  const rows = db
    .prepare(
      `SELECT p.id AS projectId, p.name, p.hits FROM projects p
        WHERE p.event_id = ? AND p.archived = 0 AND p.revoked = 0
        ORDER BY p.hits DESC, p.id DESC LIMIT 20`
    )
    .all(event.id);
  res.json({ ok: true, eventId: event.id, projects: rows });
});

// Agent 查询当前进度与下一节点（409 自愈 / --verify 定位部署地址用）
// AI 参考评分：最终提交后由 CLI 自动计算并上报（机器可判定维度 + 证据；主观项单列不计入自动分）
// 只接受已提交（8/8）的项目；允许重算覆盖（以最后一次为准），历史留审计
router.post('/score', aw(async (req, res) => {
  const { accessKey, score, detail } = req.body || {};
  const ip = req.ip || '';
  if (!accessKey || typeof accessKey !== 'string') {
    return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(accessKey.trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }
  if (project.revoked) {
    return res.status(403).json({ ok: false, code: 'KEY_REVOKED', error: '该 accessKey 已被管理员吊销' });
  }
  // 参数校验先于状态校验（与 /register 的约定一致：格式错误一律 400）
  const value = Number(score);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return res.status(400).json({ ok: false, code: 'INVALID_SCORE', error: 'score 需为 0-100 的整数' });
  }
  if (project.completed_stages < STAGES.length) {
    return res.status(409).json({
      ok: false,
      code: 'SCORE_NOT_ALLOWED',
      error: `仅最终提交（${STAGES.length}/${STAGES.length}）后可上报 AI 参考分，当前 ${project.completed_stages}/${STAGES.length}`,
    });
  }
  const detailJson = detail && typeof detail === 'object' ? JSON.stringify(detail).slice(0, 20000) : null;
  db.prepare(
    `UPDATE projects SET ai_score = ?, ai_score_detail = ?, ai_scored_at = datetime('now','localtime'),
        updated_at = datetime('now','localtime')
      WHERE id = ? AND revoked = 0 AND archived = 0`
  ).run(value, detailJson, project.id);
  audit(project.id, 'score', 1, null, `AI 参考分 ${value}`, ip, detailJson);
  notifyRefresh('score');
  res.json({ ok: true, code: 'SCORED', score: value, scoredAt: new Date().toISOString().slice(0, 19).replace('T', ' ') });
}));

// 查询已上报的 AI 参考分（大屏/后台/CLI 复用）
router.get('/score', (req, res) => {
  const accessKey = req.headers['x-access-key'] || req.query.accessKey;
  if (!accessKey) return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(String(accessKey).trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }
  res.json({
    ok: true,
    projectName: project.name,
    score: project.ai_score,
    scoredAt: project.ai_scored_at,
    detail: project.ai_score_detail ? JSON.parse(project.ai_score_detail) : null,
  });
});

// Agent 查询当前进度与下一节点（409 自愈 / --verify 定位部署地址用）
// accessKey 优先取请求头（避免出现在 URL/日志/Referer 中），兼容旧版 CLI 的 query 传参
router.get('/report/status', (req, res) => {
  const accessKey = req.headers['x-access-key'] || req.query.accessKey;
  if (!accessKey) return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(String(accessKey).trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }
  const next = project.completed_stages < STAGES.length ? stageByIndex(project.completed_stages + 1) : null;
  // 过程审计统计：供 AI 评分采集证据（违规/刷上报等）
  const stat = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS rejects,
              SUM(CASE WHEN reject_code = 'STAGE_OUT_OF_ORDER' THEN 1 ELSE 0 END) AS outOfOrder,
              SUM(CASE WHEN reject_code = 'RATE_LIMITED' THEN 1 ELSE 0 END) AS rateLimited,
              SUM(CASE WHEN reject_code = 'INVALID_STAGE' THEN 1 ELSE 0 END) AS invalidStage
         FROM reports WHERE project_id = ?`
    )
    .get(project.id) || {};
  res.json({
    ok: true,
    revoked: !!project.revoked,
    projectName: project.name,
    port: project.port,
    loopCount: project.loop_count || 1,
    clientId: project.client_id || null,
    completedStages: project.completed_stages,
    progress: progressPercent(project.completed_stages),
    nextStage: next,
    score: project.ai_score,
    stats: {
      reports: stat.total || 0,
      rejects: stat.rejects || 0,
      outOfOrder: stat.outOfOrder || 0,
      rateLimited: stat.rateLimited || 0,
      invalidStage: stat.invalidStage || 0,
    },
  });
});

module.exports = router;
