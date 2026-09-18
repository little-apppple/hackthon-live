'use strict';
const express = require('express');
const { buildSnapshot } = require('../snapshot');
const { parseCookies } = require('../auth');
const crypto = require('crypto');

// 快照请求即签发终端 Cookie：让评委进入大屏时就拿到身份，点击时无需再经历"无 Cookie"分支
function ensureTerminal(req, res) {
  const given = parseCookies(req).hk_term;
  if (/^t_[a-z0-9_]{6,40}$/.test(given || '')) return;
  const terminal = `t_${crypto.randomBytes(12).toString('hex')}`;
  res.setHeader('Set-Cookie', `hk_term=${terminal}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`);
}
const { handleStream } = require('../sse');
const router = express.Router();

router.get('/snapshot', (req, res) => {
  ensureTerminal(req, res);
  const eventId = Number(req.query.eventId);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, snapshot: buildSnapshot(Number.isFinite(eventId) ? eventId : undefined) });
});

router.get('/stream', handleStream);

module.exports = router;
