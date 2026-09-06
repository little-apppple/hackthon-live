'use strict';
const express = require('express');
const { buildSnapshot } = require('../snapshot');
const { handleStream } = require('../sse');
const router = express.Router();

router.get('/snapshot', (req, res) => {
  const eventId = Number(req.query.eventId);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, snapshot: buildSnapshot(Number.isFinite(eventId) ? eventId : undefined) });
});

router.get('/stream', handleStream);

module.exports = router;
