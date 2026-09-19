'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const deployer = require('../deployer');
const { notifyRefresh } = require('../sse');
const { DEPLOY_STAGE_INDEX } = require('../stages');
const router = express.Router();

const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 部署限频：每项目 10 秒一次（防持 key 者并发推包打爆内存/磁盘）
const deployLastAt = new Map(); // projectId -> epoch ms

function findProject(req) {
  const accessKey = req.query.accessKey || req.headers['x-access-key'];
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
    const now = Date.now();
    const last = deployLastAt.get(project.id) || 0;
    const windowMs = config.deployRateLimitMs;
    if (now - last < windowMs) {
      const retryAfter = Math.ceil((windowMs - (now - last)) / 1000);
      return res
        .status(429)
        .json({ ok: false, code: 'RATE_LIMITED', error: `部署过于频繁，请 ${retryAfter} 秒后重试`, retryAfterSeconds: retryAfter });
    }
    deployLastAt.set(project.id, now);

    const type = ['static', 'package'].includes(req.query.type) ? req.query.type : 'node';
    const start = String(req.query.start || '').trim() || (type === 'node' ? 'npm start' : '');
    const install = req.query.install === '1';
    const dir = String(req.query.dir || '');
    const pkgFile = String(req.query.file || '').trim();
    if (type === 'package' && !pkgFile) {
      return res.status(400).json({ ok: false, code: 'INVALID_FILE', error: '安装包交付需用 ?file=<安装包文件名> 指定（CLI: --deploy --type package --file <路径>）' });
    }
    if (type !== 'package' && deployer.resolveAppDir(project, dir) === null) {
      return res.status(400).json({ ok: false, code: 'INVALID_DIR', error: `dir 非法：必须位于应用目录内部（收到 "${dir}"）` });
    }

    const result = type === 'package'
      ? await deployer.deployPackage(project, { file: pkgFile }, req.body)
      : await deployer.deployProject(project, { type, start, install, dir }, req.body);
    if (!result.ok) {
      const code = result.code || 'DEPLOY_FAILED';
      return res.status(code === 'INVALID_FILE' ? 400 : 500).json({ ok: false, code, error: result.error, logTail: result.logTail });
    }
    notifyRefresh('deploy');

    // 自动上报「上线部署」：仅当下一个待完成节点恰好是它
    const fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    let stageReported = false;
    let note = null;
    if (fresh.completed_stages === DEPLOY_STAGE_INDEX - 1) {
      const evidence = JSON.stringify({ deploy: 'auto', probe: result.probe, type }).slice(0, 4000);
      const upd = db.prepare(
        `UPDATE projects SET completed_stages = ${DEPLOY_STAGE_INDEX}, status = 'deployed',
            last_report_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
          WHERE id = ? AND revoked = 0 AND archived = 0`
      ).run(project.id);
      if (upd.changes === 0) {
        // 竞态：校验后被吊销/归档——不写「成功」审计，避免审计与真实进度不符
        db.prepare(
          'INSERT INTO reports (project_id, stage, ok, reject_code, message, ip) VALUES (?, ?, 0, ?, ?, ?)'
        ).run(project.id, 'deployment', 'KEY_REVOKED', '自动部署完成但项目状态已变化（吊销/归档），未上报节点', req.ip || '');
        note = '部署成功但项目状态已变化（可能被吊销/归档），未上报「上线部署」节点';
      } else {
        db.prepare(
          'INSERT INTO reports (project_id, stage, ok, reject_code, message, ip, evidence) VALUES (?, ?, 1, NULL, ?, ?, ?)'
        ).run(project.id, 'deployment', '自动部署成功（服务端探活通过）', req.ip || '', evidence);
        stageReported = true;
      }
    } else if (fresh.completed_stages < DEPLOY_STAGE_INDEX - 1) {
      note = `部署成功但未自动上报「上线部署」：流程尚未进行到该节点（当前 ${fresh.completed_stages}/8，部署为第 6 节点），请先按顺序完成前置节点`;
    } else {
      note = '重新部署完成（部署节点此前已完成，进度不变）';
    }
    if (stageReported) notifyRefresh('report');

    res.json({
      ok: true,
      code: 'DEPLOYED',
      deployUrl: `http://${config.publicHost}:${project.port}`,
      deliverable: type,
      artifactUrl: type === 'package' ? `http://${config.publicHost}:${project.port}/${encodeURIComponent(result.artifactName || pkgFile)}` : undefined,
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
