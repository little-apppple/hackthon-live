'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const deployer = require('../deployer');
const { notifyRefresh } = require('../sse');
const router = express.Router();

const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function findProject(req) {
  const accessKey = req.query.accessKey;
  if (!accessKey) return { code: 400, body: { ok: false, code: 'INVALID_KEY', error: '缺少 accessKey' } };
  const project = db.prepare('SELECT * FROM projects WHERE access_key = ?').get(String(accessKey).trim());
  if (!project || project.archived) {
    return { code: 404, body: { ok: false, code: 'INVALID_KEY', error: 'accessKey 无效' } };
  }
  if (project.revoked) {
    return { code: 403, body: { ok: false, code: 'KEY_REVOKED', error: '该 accessKey 已被管理员吊销' } };
  }
  return { project };
}

// 部署：raw body = tgz/zip 构建产物，query 携带 type/start/install/dir
router.post(
  '/',
  express.raw({ type: () => true, limit: `${config.deployMaxMb + 10}mb` }),
  aw(async (req, res) => {
    const found = findProject(req);
    if (found.code) return res.status(found.code).json(found.body);
    const project = found.project;

    if (!req.body || !req.body.length) {
      return res.status(400).json({ ok: false, code: 'EMPTY_ARCHIVE', error: '请求体为空，应上传 tgz/zip 构建产物' });
    }
    if (req.body.length > config.deployMaxMb * 1024 * 1024) {
      return res
        .status(413)
        .json({ ok: false, code: 'TOO_LARGE', error: `构建产物超过上限 ${config.deployMaxMb}MB` });
    }

    const type = req.query.type === 'static' ? 'static' : 'node';
    const start = String(req.query.start || '').trim() || (type === 'node' ? 'npm start' : '');
    const install = req.query.install === '1';
    const dir = String(req.query.dir || '');

    const result = await deployer.deployProject(project, { type, start, install, dir }, req.body);
    if (!result.ok) {
      return res.status(500).json({ ok: false, code: 'DEPLOY_FAILED', error: result.error, logTail: result.logTail });
    }
    notifyRefresh('deploy');

    // 自动上报「上线部署」：仅当下一个待完成节点恰好是它
    const fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    let stageReported = false;
    let note = null;
    if (fresh.completed_stages === 5) {
      const evidence = JSON.stringify({ deploy: 'auto', probe: result.probe, type }).slice(0, 4000);
      db.prepare(
        `UPDATE projects SET completed_stages = 6, status = 'deployed',
            last_report_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
          WHERE id = ?`
      ).run(project.id);
      db.prepare(
        'INSERT INTO reports (project_id, stage, ok, reject_code, message, ip, evidence) VALUES (?, ?, 1, NULL, ?, ?, ?)'
      ).run(project.id, 'deployment', '自动部署成功（服务端探活通过）', req.ip || '', evidence);
      stageReported = true;
    } else if (fresh.completed_stages < 5) {
      note = `部署成功但未自动上报「上线部署」：流程尚未进行到该节点（当前 ${fresh.completed_stages}/6），请先按顺序完成前置节点`;
    } else {
      note = '重新部署完成（部署节点此前已完成，进度不变）';
    }
    if (stageReported) notifyRefresh('report');

    res.json({
      ok: true,
      code: 'DEPLOYED',
      deployUrl: `http://${config.publicHost}:${project.port}`,
      status: deployer.getStatus(project.id),
      probe: result.probe,
      stageReported,
      note,
    });
  })
);

// 部署状态查询（CLI / 小组自助）
router.get('/status', (req, res) => {
  const found = findProject(req);
  if (found.code) return res.status(found.code).json(found.body);
  const st = deployer.getStatus(found.project.id);
  res.json({
    ok: true,
    deployed: !!st,
    deployUrl: st ? `http://${config.publicHost}:${found.project.port}` : null,
    deploy: st,
  });
});

module.exports = router;
