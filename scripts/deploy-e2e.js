'use strict';
// 自动部署端到端测试（独立服务实例 + 独立部署目录）：
//   node scripts/deploy-e2e.js
// 覆盖：node 应用上传部署 + 探活 + 自动上报部署节点 + 重启/停止；静态站部署；未到节点的部署不上报。
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp-deploy');
const PORT = 3400;
const BASE = `http://localhost:${PORT}`;
const CLI = path.join(ROOT, 'skill', 'hackathon-reporter', 'scripts', 'report.js');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { cwd, stdio: 'inherit' });
    c.on('exit', (code) => resolve(code));
  });
}

async function tryFetch(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ok: true, status: r.status, text: await r.text() };
  } catch {
    return { ok: false };
  }
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      RATE_LIMIT_MS: '300',
      DB_PATH: path.join(TMP, 'test.db'),
      DEPLOY_ROOT: path.join(TMP, 'deploys'),
      PUBLIC_HOST: 'localhost',
      ADMIN_PASSWORD: 'test123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(BASE + '/healthz')).ok;
    } catch {
      await sleep(250);
    }
  }
  check('测试服务启动', up);
  if (!up) process.exit(1);

  let proj1 = null;
  let proj2 = null;
  let proj3 = null;
  let cookie = '';
  try {
    const login = await fetch(BASE + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test123' }),
    });
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const create = async (name, groupIdx) => {
      await fetch(BASE + '/api/admin/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: '研发中心' }),
      });
      for (const g of ['一组', '二组', '三组']) {
        await fetch(BASE + '/api/admin/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ departmentId: 1, name: g }),
        });
      }
      const groups = await (await fetch(BASE + '/api/admin/groups?departmentId=1', { headers: { Cookie: cookie } })).json();
      return (
        await (
          await fetch(BASE + '/api/admin/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ groupId: groups.groups[groupIdx].id, name }),
          })
        ).json()
      );
    };
    proj1 = await create('node 应用部署用例', 0);
    proj2 = await create('静态站部署用例', 1);
    proj3 = await create('未到节点部署用例', 2);
    check('项目创建', proj1.ok && proj2.ok && proj3.ok);

    // fixture：node 应用（package.json start = node server.js，监听 PORT）
    const fxNode = path.join(TMP, 'fixture-node');
    fs.mkdirSync(fxNode, { recursive: true });
    fs.writeFileSync(
      path.join(fxNode, 'package.json'),
      JSON.stringify({ name: 'fx-node', scripts: { start: 'node server.js' } }, null, 2)
    );
    fs.writeFileSync(
      path.join(fxNode, 'server.js'),
      `const http=require('http');const port=Number(process.env.PORT)||8080;` +
        `http.createServer((q,s)=>{s.setHeader('Content-Type','text/plain; charset=utf-8');s.end('hello-deploy')}).listen(port,'0.0.0.0',()=>console.log('up on',port))`
    );
    // fixture：静态站
    const fxStatic = path.join(TMP, 'fixture-static');
    fs.mkdirSync(fxStatic, { recursive: true });
    fs.writeFileSync(path.join(fxStatic, 'index.html'), '<h1>static-deploy-ok</h1>');

    // 配置文件（deploy.dir 指向打包目录：打包后目录内容即部署根）
    fs.writeFileSync(
      path.join(TMP, 'config1.json'),
      JSON.stringify({ serverUrl: BASE, accessKey: proj1.accessKey, deploy: { type: 'node', install: true, dir: 'fixture-node' } }, null, 2)
    );
    fs.writeFileSync(
      path.join(TMP, 'config2.json'),
      JSON.stringify({ serverUrl: BASE, accessKey: proj2.accessKey, deploy: { type: 'static', dir: 'fixture-static' } }, null, 2)
    );
    fs.writeFileSync(
      path.join(TMP, 'config3.json'),
      JSON.stringify({ serverUrl: BASE, accessKey: proj3.accessKey, deploy: { type: 'node', dir: 'fixture-node' } }, null, 2)
    );

    // proj1：先走完 1-5 节点，再部署 → 自动上报部署节点
    console.log('\n-- node 应用：上传部署 + 自动上报 --');
    for (const st of ['requirements', 'design', 'prototype', 'coding', 'testing']) {
      const code = await runCli(['--config', 'config1.json', '--stage', st, '--message', 'deploy-e2e'], TMP);
      check(`上报 ${st}`, code === 0);
    }
    const d1 = await runCli(['--config', 'config1.json', '--deploy'], TMP);
    check('--deploy 退出码 0', d1 === 0);
    const s1 = await (await fetch(BASE + `/api/report/status?accessKey=${proj1.accessKey}`)).json();
    check('部署节点自动上报（6/7）', s1.completedStages === 6 && s1.progress === 86, JSON.stringify(s1));
    const hit1 = await tryFetch(`http://localhost:${proj1.port}`);
    check('部署的应用可访问', hit1.ok && hit1.text === 'hello-deploy', JSON.stringify(hit1));

    // 管理端：重启 / 停止
    const restart = await fetch(BASE + `/api/admin/deploys/${proj1.id}/restart`, { method: 'POST', headers: { Cookie: cookie } });
    check('管理端重启成功', restart.ok);
    await sleep(500);
    const hitRestart = await tryFetch(`http://localhost:${proj1.port}`);
    check('重启后仍可访问', hitRestart.ok && hitRestart.text === 'hello-deploy');
    const deploys = await (await fetch(BASE + '/api/admin/deploys', { headers: { Cookie: cookie } })).json();
    const st1 = deploys.deploys.find((x) => x.projectId === proj1.id);
    check('部署列表状态 running', st1?.status === 'running', JSON.stringify(st1));
    await fetch(BASE + `/api/admin/deploys/${proj1.id}/stop`, { method: 'POST', headers: { Cookie: cookie } });
    await sleep(500);
    const hitStopped = await tryFetch(`http://localhost:${proj1.port}`);
    check('停止后端口不再响应', !hitStopped.ok);
    await fetch(BASE + `/api/admin/deploys/${proj1.id}/start`, { method: 'POST', headers: { Cookie: cookie } });
    await sleep(500);
    const hitStarted = await tryFetch(`http://localhost:${proj1.port}`);
    check('再次启动后恢复访问', hitStarted.ok && hitStarted.text === 'hello-deploy');

    // proj2：静态站
    console.log('\n-- 静态站部署 --');
    const d2 = await runCli(['--config', 'config2.json', '--deploy'], TMP);
    check('静态站 --deploy 退出码 0', d2 === 0);
    const hit2 = await tryFetch(`http://localhost:${proj2.port}`);
    check('静态站内容可访问', hit2.ok && hit2.text.includes('static-deploy-ok'), JSON.stringify(hit2));

    // proj3：流程未到部署节点 → 部署成功但不自动上报
    console.log('\n-- 未到节点的部署 --');
    const d3 = await runCli(['--config', 'config3.json', '--deploy'], TMP);
    check('部署本身成功', d3 === 0);
    const s3 = await (await fetch(BASE + `/api/report/status?accessKey=${proj3.accessKey}`)).json();
    check('进度未被推进（仍 0/7）', s3.completedStages === 0, JSON.stringify(s3));
  } finally {
    // 收尾：先通过 API 停掉所有部署（级联杀掉服务端拉起的子进程），再杀测试服务
    try {
      for (const p of [proj1, proj2, proj3].filter(Boolean)) {
        await fetch(BASE + `/api/admin/deploys/${p.id}/stop`, { method: 'POST', headers: { Cookie: cookie } }).catch(() => {});
      }
    } catch {
      /* 尽力清理 */
    }
    server.kill();
    await sleep(800);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* Windows 文件锁延迟 */
    }
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
