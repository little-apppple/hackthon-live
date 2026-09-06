'use strict';
const crypto = require('crypto');
const config = require('./config');

// 单管理员密码 + 内存 Cookie Session（内网工具，进程重启后需重新登录，可接受）
const sessions = new Map(); // token -> expiresAt(ms)

setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of sessions) {
    if (exp <= now) sessions.delete(token);
  }
}, 60 * 1000).unref();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + config.sessionTtlMs);
  res.setHeader(
    'Set-Cookie',
    `hk_admin=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`
  );
}

function destroySession(req, res) {
  const token = parseCookies(req).hk_admin;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'hk_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function isAuthed(req) {
  const token = parseCookies(req).hk_admin;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期' });
  }
  next();
}

module.exports = { parseCookies, createSession, destroySession, isAuthed, requireAuth };
