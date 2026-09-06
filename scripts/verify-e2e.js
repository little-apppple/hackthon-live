'use strict';
// 验收自动化端到端测试（独立测试服务实例，不污染主库）：
//   node scripts/verify-e2e.js
// 覆盖：探活/接口/E2E 全通过 → 自动验收 7/7；E2E 失败 → 不上报验收退出码 3。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp-verify');
const PORT = 3200;
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

async function reportStage(configFile, stage) {
  return runCli(['--config', configFile, '--stage', stage, '--message', 'verify-e2e'], TMP);
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 1. 启动独立测试服务（快速限频 300ms，独立 DB）
  const server = spawn(
    process.execPath,
    ['server/src/index.js'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        RATE_LIMIT_MS: '300',
        DB_PATH: path.join(TMP, 'test.db'),
        PUBLIC_HOST: 'localhost',
        ADMIN_PASSWORD: 'test123',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
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

  try {
    // 2. 登录并创建两个项目
    const login = await fetch(BASE + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test123' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const create = async (name, groupIdx) => {
      // 测试库无 seed 数据，直接通过 API 建部门 + 3 个小组
      const deptRes = await (
        await fetch(BASE + '/api/admin/departments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ name: '研发中心' }),
        })
      ).json();
      const deptId = deptRes.id || 1;
      for (const g of ['一组', '二组', '三组']) {
        await fetch(BASE + '/api/admin/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ departmentId: deptId, name: g }),
        });
      }
      const groups = await (
        await fetch(BASE + `/api/admin/groups?departmentId=${deptId}`, { headers: { Cookie: cookie } })
      ).json();
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
    const proj1 = await create('验收自动化-通过用例', 0);
    const proj2 = await create('验收自动化-失败用例', 1);
    check('项目创建（通过用例）', proj1.ok, JSON.stringify(proj1));
    check('项目创建（失败用例）', proj2.ok, JSON.stringify(proj2));

    // 3. 两个项目端口上各起一个假部署服务（探活目标）
    const dummy1 = http.createServer((req, res) => res.end('ok-demo-1'));
    const dummy2 = http.createServer((req, res) => res.end('ok-demo-2'));
    await new Promise((r) => dummy1.listen(proj1.port, '127.0.0.1', r));
    await new Promise((r) => dummy2.listen(proj2.port, '127.0.0.1', r));

    // 4. 写配置与测试脚本
    fs.writeFileSync(
      path.join(TMP, 'config-pass.json'),
      JSON.stringify(
        { serverUrl: BASE, accessKey: proj1.accessKey, verify: { api: 'node check-api.js', e2e: 'node check-e2e.js' } },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(TMP, 'config-fail.json'),
      JSON.stringify({ serverUrl: BASE, accessKey: proj2.accessKey, verify: { e2e: 'node check-bad.js' } }, null, 2)
    );
    fs.writeFileSync(
      path.join(TMP, 'check-api.js'),
      "fetch(process.env.DEPLOY_URL).then(r=>{console.log('  [check-api] HTTP', r.status); process.exit(r.status < 500 ? 0 : 1)}).catch(()=>process.exit(1))"
    );
    fs.writeFileSync(
      path.join(TMP, 'check-e2e.js'),
      "console.log('  [check-e2e] 冒烟通过 @', process.env.DEPLOY_URL); process.exit(0)"
    );
    fs.writeFileSync(path.join(TMP, 'check-bad.js'), "console.log('  [check-bad] 故意失败'); process.exit(1)");

    // 5. 通过用例：1-5 节点 + 部署 + --verify 自动验收
    console.log('\n-- 通过用例 --');
    for (const st of ['requirements', 'design', 'prototype', 'coding', 'testing']) {
      const code = await reportStage('config-pass.json', st);
      check(`上报 ${st}`, code === 0);
    }
    const depCode = await reportStage('config-pass.json', 'deployment');
    check('上报 deployment', depCode === 0);
    const v1 = await runCli(['--config', 'config-pass.json', '--verify'], TMP);
    check('--verify 全部通过（退出码 0）', v1 === 0, `实际 ${v1}`);
    const s1 = await (await fetch(BASE + `/api/report/status?accessKey=${proj1.accessKey}`)).json();
    check('自动验收后 7/7（100%）', s1.completedStages === 7 && s1.progress === 100, JSON.stringify(s1));
    const v1again = await runCli(['--config', 'config-pass.json', '--verify'], TMP);
    check('重复 --verify 幂等（提示已完成）', v1again === 0);

    // 6. 失败用例：E2E 失败 → 退出码 3，验收不上报
    console.log('\n-- 失败用例 --');
    for (const st of ['requirements', 'design', 'prototype', 'coding', 'testing', 'deployment']) {
      const code = await reportStage('config-fail.json', st);
      check(`上报 ${st}`, code === 0);
    }
    const v2 = await runCli(['--config', 'config-fail.json', '--verify'], TMP);
    check('E2E 失败时 --verify 退出码 3', v2 === 3, `实际 ${v2}`);
    const s2 = await (await fetch(BASE + `/api/report/status?accessKey=${proj2.accessKey}`)).json();
    check('验收未上报（停在 6/7）', s2.completedStages === 6 && s2.progress === 86, JSON.stringify(s2));

    // 7. 部署前置守卫：新项目未部署时 --verify 应失败退出码 1
    console.log('\n-- 前置守卫 --');
    const proj3 = await create('验收自动化-未部署', 2);
    fs.writeFileSync(
      path.join(TMP, 'config-nodeploy.json'),
      JSON.stringify({ serverUrl: BASE, accessKey: proj3.accessKey }, null, 2)
    );
    await reportStage('config-nodeploy.json', 'requirements');
    const v3 = await runCli(['--config', 'config-nodeploy.json', '--verify'], TMP);
    check('未部署时 --verify 拒绝（退出码 1）', v3 === 1, `实际 ${v3}`);
  } finally {
    server.kill();
    await sleep(500);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
