'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
// require db 即完成建库
require('./db');

const app = express();
app.disable('x-powered-by');

// 安全响应头：禁止被 iframe 嵌套（防点击劫持）、禁止 MIME 嗅探、收紧 CSP
// （前端无外链脚本/字体，样式为内联 style 属性故保留 'unsafe-inline'）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '512kb' }));

app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/report'));
app.use('/api', require('./routes/dashboard'));
app.use('/api', require('./course-pack'));
app.use('/api/deploy', require('./routes/deploy'));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// 生产模式：托管前端构建产物（SPA fallback）
const distDir = config.webDist;
const indexHtml = path.join(distDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(indexHtml));
} else {
  app.get('/', (req, res) =>
    res
      .status(503)
      .send('前端尚未构建：请先运行 npm run build，或开发模式使用 npm run dev:web（Vite 5173 端口）')
  );
}

// 404 与错误处理
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));
app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  // 保留 body-parser 等中间件给出的 4xx 状态码，未知错误才落 500
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ ok: false, error: err.message || 'Internal Error' });
});

app.listen(config.port, () => {
  const deployer = require('./deployer');
  deployer.recoverOnBoot(); // 恢复重启前部署过的项目
  console.log(`[hackathon-dashboard] 服务已启动: http://localhost:${config.port}`);
  console.log(`  大屏:       http://localhost:${config.port}/`);
  console.log(`  管理后台:   http://localhost:${config.port}/admin`);
  console.log(`  端口池:     ${config.portPoolStart}-${config.portPoolEnd}（项目部署链接主机: ${config.publicHost}）`);
  console.log(`  部署根目录: ${config.deployRoot}（产物上限 ${config.deployMaxMb}MB）`);
  if (config.adminPassword === 'hackathon2026') {
    console.log('  ⚠ 使用默认管理密码 hackathon2026，正式比赛请通过 ADMIN_PASSWORD 环境变量修改');
  }
});
