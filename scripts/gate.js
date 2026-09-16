'use strict';
// 回归闸门：一条命令跑完全部套件，任一失败即失败退出（提交/发布前必跑）
//   node scripts/gate.js   （等价 npm test / npm run gate）
// 套件：smoke（API 冒烟，需外部服务实例，本脚本自动拉起）
//      → verify-e2e（验收自动化）→ deploy-e2e（自动部署）→ skill-e2e（技能包全旅程）
// 说明：smoke 内置 10 秒限频等待，故整套约需 4-6 分钟。
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp-gate');
const SMOKE_PORT = 3500;
const SMOKE_BASE = `http://localhost:${SMOKE_PORT}`;
const ADMIN_PW = 'test123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];

function parseResult(out) {
  const m = out.match(/结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

function runSuite(name, args, { env = {}, cwd = ROOT } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(TMP, `${name}.log`), out);
  const parsed = parseResult(out);
  const ok = r.status === 0 && parsed && parsed.failed === 0;
  results.push({ name, ok, ...(parsed || {}), seconds: ((Date.now() - started) / 1000).toFixed(0) });
  console.log(`${ok ? '✓' : '✗'} ${name}：${parsed ? `${parsed.passed} 通过 / ${parsed.failed} 失败` : `退出码 ${r.status}`}（${((Date.now() - started) / 1000).toFixed(0)}s）`);
  if (!ok) console.log(`  失败详情见 ${path.relative(ROOT, path.join(TMP, `${name}.log`))}`);
  return ok;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log('== 回归闸门 ==\n');

  // smoke 需要外部服务实例：自动拉起隔离服务（独立 DB/端口，用默认限频以匹配其 10s 断言）
  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(SMOKE_PORT),
      DB_PATH: path.join(TMP, 'smoke.db'),
      PUBLIC_HOST: 'localhost',
      ADMIN_PASSWORD: ADMIN_PW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(SMOKE_BASE + '/healthz')).ok;
    } catch {
      await sleep(250);
    }
  }
  if (!up) {
    console.error('✗ 冒烟测试服务未能启动');
    server.kill();
    process.exit(1);
  }

  try {
    runSuite('smoke', ['scripts/smoke.js', SMOKE_BASE], { env: { ADMIN_PASSWORD: ADMIN_PW } });
  } finally {
    server.kill();
    await sleep(500);
  }

  runSuite('verify-e2e', ['scripts/verify-e2e.js']);
  runSuite('deploy-e2e', ['scripts/deploy-e2e.js']);
  runSuite('skill-e2e', ['scripts/skill-e2e.js']);

  const totalPassed = results.reduce((s, r) => s + (r.passed || 0), 0);
  const totalFailed = results.reduce((s, r) => s + (r.failed || 0), 0);
  const bad = results.filter((r) => !r.ok);
  // 回归证据落盘：AI 评分据此判定「全量回归通过」（含 commit 与断言数，防止用旧证据顶替）
  try {
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || '';
    fs.writeFileSync(
      path.join(ROOT, '.gate-last-pass.json'),
      JSON.stringify({ at: new Date().toISOString(), commit, suites: results, totalPassed, totalFailed }, null, 2),
      'utf8'
    );
  } catch {
    /* 证据写入失败不影响闸门结论 */
  }
  console.log(`\n== 闸门结果：${results.length - bad.length}/${results.length} 套件通过，共 ${totalPassed} 项断言，${totalFailed} 项失败 ==`);
  if (bad.length) console.log(`未通过：${bad.map((r) => r.name).join('、')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(bad.length ? 1 : 0);
})().catch((e) => {
  console.error('闸门异常:', e);
  process.exit(1);
});
