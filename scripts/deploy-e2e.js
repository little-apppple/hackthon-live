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

  let proj1 = null, projPkg, projWeird;
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
    check('部署节点自动上报（6/8）', s1.completedStages === 6 && s1.progress === 75, JSON.stringify(s1));
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
    // ---- 安装包交付（非 Web 应用：上传安装包，下载链接可用即视为部署完成）----
    console.log('\n-- 安装包交付 --');
    const pkgDir = path.join(TMP, 'fixture-package');
    fs.mkdirSync(pkgDir, { recursive: true });
    const pkgName = 'DemoApp-Setup-1.0.0.zip';
    const pkgBuf = Buffer.alloc(512 * 1024);
    pkgBuf.write('PK\\x03\\x04', 0, 'binary');
    fs.writeFileSync(path.join(pkgDir, pkgName), pkgBuf);
    projPkg = await create('安装包交付用例', 2);
    fs.writeFileSync(
      path.join(pkgDir, 'hackathon.config.json'),
      JSON.stringify({ serverUrl: BASE, accessKey: projPkg.accessKey, deploy: { type: 'package', file: pkgName } }, null, 2)
    );
    for (const st of ['requirements', 'design', 'prototype', 'coding', 'testing']) {
      const code = await runCli(['--stage', st, '--message', 'deploy-e2e-pkg'], pkgDir);
      check(`安装包项目上报 ${st}`, code === 0);
    }
    const dPkg = await runCli(['--deploy', '--type', 'package', '--file', pkgName], pkgDir);
    check('安装包 --deploy 退出码 0', dPkg === 0);
    const sPkg = await (await fetch(BASE + `/api/report/status?accessKey=${projPkg.accessKey}`)).json();
    check('安装包发布后自动上报部署节点（6/8）', sPkg.completedStages === 6 && sPkg.progress === 75, JSON.stringify(sPkg));
    const landingRes = await fetch(`http://localhost:${projPkg.port}/`).catch(() => null);
    const landingText = landingRes ? await landingRes.text() : '';
    check('落地页可访问且含下载入口', landingRes?.status === 200 && /下载安装包/.test(landingText));
    const dlRes = await fetch(`http://localhost:${projPkg.port}/${pkgName}`).catch(() => null);
    const dlBuf = dlRes ? Buffer.from(await dlRes.arrayBuffer()) : Buffer.alloc(0);
    check(
      '安装包下载链接可用（200 + 附件头 + 大小一致）',
      dlRes?.status === 200 && /attachment/i.test(dlRes.headers.get('content-disposition') || '') && dlBuf.length === pkgBuf.length,
      JSON.stringify({ status: dlRes?.status, disp: dlRes?.headers.get('content-disposition'), size: dlBuf.length })
    );
    const snapPkg = await (await fetch(BASE + '/api/snapshot')).json();
    const itemPkg = snapPkg.snapshot.departments
      .flatMap((x) => x.groups.flatMap((g) => g.projects))
      .find((x) => x.id === projPkg.id);
    check(
      '快照标记为安装包交付并给出下载地址',
      itemPkg?.deliverable === 'package' && /DemoApp-Setup-1\.0\.0\.zip$/.test(itemPkg?.artifactUrl || ''),
      JSON.stringify({ deliverable: itemPkg?.deliverable, artifactUrl: itemPkg?.artifactUrl })
    );
    const vPkg = await runCli(['--verify', '--file', pkgName], pkgDir);
    check('安装包 --verify 通过（退出码 0）', vPkg === 0);
    const sPkg2 = await (await fetch(BASE + `/api/report/status?accessKey=${projPkg.accessKey}`)).json();
    check('安装包验收自动上报（7/8）', sPkg2.completedStages === 7 && sPkg2.progress === 90, JSON.stringify(sPkg2));
    // ---- P1 回归：文件名消毒一致性 / 形态复位 / 带人气项目可删除 ----
    console.log('\n-- 交付形态与消毒回归 --');
    const weirdDir = path.join(TMP, 'fixture-weird');
    fs.mkdirSync(weirdDir, { recursive: true });
    const weirdLocal = 'My Setup 1.2 (beta).zip'; // 含空格与括号：消毒后应变为 My_Setup_1.2_(beta).zip
    const weirdBuf = Buffer.alloc(64 * 1024);
    weirdBuf.write('PK\\x03\\x04', 0, 'binary');
    fs.writeFileSync(path.join(weirdDir, weirdLocal), weirdBuf);
    projWeird = await create('文件名消毒用例', 0);
    fs.writeFileSync(
      path.join(weirdDir, 'hackathon.config.json'),
      JSON.stringify({ serverUrl: BASE, accessKey: projWeird.accessKey, deploy: { type: 'package', file: weirdLocal } }, null, 2)
    );
    for (const st of ['requirements', 'design', 'prototype', 'coding', 'testing']) {
      await runCli(['--stage', st, '--message', 'deploy-e2e-weird'], weirdDir);
    }
    const dWeird = await runCli(['--deploy', '--type', 'package', '--file', weirdLocal], weirdDir);
    check('含特殊字符的安装包名可发布', dWeird === 0);
    const sWeird = await (await fetch(BASE + `/api/report/status?accessKey=${projWeird.accessKey}`)).json();
    check('status 透出交付形态与消毒后的包名', sWeird.deliverable === 'package' && /^[\w.\-()]+\.zip$/.test(sWeird.artifactName || '') && sWeird.artifactName !== weirdLocal, JSON.stringify({ deliverable: sWeird.deliverable, artifactName: sWeird.artifactName }));
    const dlWeird = await fetch(`http://localhost:${projWeird.port}/${encodeURIComponent(sWeird.artifactName)}`).catch(() => null);
    const dlWeirdBuf = dlWeird ? Buffer.from(await dlWeird.arrayBuffer()) : Buffer.alloc(0);
    check('按消毒后包名的直链可用', dlWeird?.status === 200 && dlWeirdBuf.length === weirdBuf.length, JSON.stringify({ status: dlWeird?.status, size: dlWeirdBuf.length }));
    const vWeird = await runCli(['--verify', '--file', weirdLocal], weirdDir);
    check('特殊字符包的 --verify 通过（按服务端包名校验）', vWeird === 0);

    // package → node 重部署：交付形态应复位为 web，不再给出失效下载入口
    const cfgWeirdPath = path.join(weirdDir, 'hackathon.config.json');
    const cfgWeird = JSON.parse(fs.readFileSync(cfgWeirdPath, 'utf8'));
    delete cfgWeird.deploy;
    fs.writeFileSync(cfgWeirdPath, JSON.stringify(cfgWeird, null, 2));
    fs.writeFileSync(path.join(weirdDir, 'package.json'), JSON.stringify({ name: 'fx-weird', scripts: { start: 'node server.js' } }, null, 2));
    fs.writeFileSync(path.join(weirdDir, 'server.js'), "const http=require('http');http.createServer((q,s)=>s.end('web-again')).listen(Number(process.env.PORT)||8080)");
    const dBack = await runCli(['--deploy'], weirdDir);
    check('改为 Web 交付后重部署成功', dBack === 0);
    const sBack = await (await fetch(BASE + `/api/report/status?accessKey=${projWeird.accessKey}`)).json();
    check('交付形态复位为 web（清掉安装包标记）', sBack.deliverable === 'web' && !sBack.artifactName, JSON.stringify({ deliverable: sBack.deliverable, artifactName: sBack.artifactName }));
    const snapBack = await (await fetch(BASE + '/api/snapshot')).json();
    const itemBack = snapBack.snapshot.departments.flatMap((x) => x.groups.flatMap((g) => g.projects)).find((x) => x.id === projWeird.id);
    check('快照不再给出失效的安装包链接', itemBack?.deliverable === 'web' && !itemBack?.artifactUrl);

    // 带人气记录的项目必须能彻底删除（hit_events 外键）
    await fetch(BASE + '/api/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projWeird.id, terminal: 't_regression01', kind: 'web' }),
    });
    await fetch(BASE + `/api/admin/projects/${projWeird.id}/archive`, { method: 'POST', headers: { Cookie: cookie } });
    const delRes = await fetch(BASE + `/api/admin/projects/${projWeird.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    check('有人气记录的项目可彻底删除（外键清理）', delRes.status === 200, `HTTP ${delRes.status}`);

  } finally {
    // 收尾：先通过 API 停掉所有部署（级联杀掉服务端拉起的子进程），再杀测试服务
    try {
      for (const p of [proj1, proj2, proj3, projPkg, projWeird].filter(Boolean)) {
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
