'use strict';
const path = require('path');

function intEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const config = {
  port: intEnv('PORT', 3000),
  adminPassword: process.env.ADMIN_PASSWORD || 'hackathon2026',
  portPoolStart: intEnv('PORT_POOL_START', 4100),
  portPoolEnd: intEnv('PORT_POOL_END', 4999),
  publicHost: process.env.PUBLIC_HOST || 'localhost',
  eventName: process.env.EVENT_NAME || '企业黑客松大赛',
  eventEndTime: process.env.EVENT_END_TIME || '',
  rateLimitMs: intEnv('RATE_LIMIT_MS', 10000),
  sessionTtlMs: intEnv('SESSION_TTL_MS', 24 * 3600 * 1000),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hackathon.db'),
  webDist: path.join(__dirname, '..', '..', 'web', 'dist'),
  // 自动部署（方案 A：构建产物上传 + 服务端托管）
  deployRoot: process.env.DEPLOY_ROOT || path.join(__dirname, '..', 'data', 'deploys'),
  deployMaxMb: intEnv('DEPLOY_MAX_MB', 200),
  deployStartTimeoutMs: intEnv('DEPLOY_START_TIMEOUT_MS', 60000),
  // 部署子进程的 PATH 前缀（如 /opt/node22/bin，保证项目用指定版本的 node/npm）
  deployPathPrepend: process.env.DEPLOY_PATH_PREPEND || '',
};

if (config.portPoolEnd - config.portPoolStart < 0) {
  throw new Error('PORT_POOL_END 必须大于等于 PORT_POOL_START');
}

module.exports = config;
