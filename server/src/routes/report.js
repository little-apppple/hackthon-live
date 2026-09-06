'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { stageByRef, stageByIndex, deriveStatus, progressPercent, DEPLOY_STAGE_INDEX } = require('../stages');
const { notifyRefresh } = require('../sse');
const { probeLocalPort } = require('../ports');

const router = express.Router();

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
      error: 'stage 无效，应为 1-7 的序号或节点标识',
      validStages: ['requirements', 'design', 'prototype', 'coding', 'testing', 'deployment', 'acceptance'],
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
      nextStage: expected <= 7 ? stageByIndex(expected) : null,
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
  const next = st.index < 7 ? stageByIndex(st.index + 1) : null;

  let finalMessage;
  if (st.index === DEPLOY_STAGE_INDEX && !deployProbe.ok) {
    finalMessage = '已记录上线部署（⚠ 服务端探测端口未响应，请确认应用已启动并监听预留端口）';
  } else if (st.index === DEPLOY_STAGE_INDEX) {
    finalMessage = '已上线部署（服务端探活通过），大屏链接已开放访问';
  } else if (st.index === 7) {
    finalMessage = '全部节点完成，比赛进度 100%！';
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

// Agent 查询当前进度与下一节点（409 自愈 / --verify 定位部署地址用）
router.get('/report/status', (req, res) => {
  const accessKey = req.query.accessKey;
  if (!accessKey) return res.status(400).json({ ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' });
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(String(accessKey).trim());
  if (!project || project.archived) {
    return res.status(404).json({ ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' });
  }
  const next = project.completed_stages < 7 ? stageByIndex(project.completed_stages + 1) : null;
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
