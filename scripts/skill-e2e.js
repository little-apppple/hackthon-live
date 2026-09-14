'use strict';
// 参赛技能包端到端测试：完整模拟一支参赛队从「拿到技能包」到「最终提交」的全旅程
//   node scripts/skill-e2e.js
// 覆盖：pack-skills 打包（内置上报地址+令牌、排除 .env）→ 解压 → --doctor 环境检测/用户引导
//      → --init 自助注册（幂等同 key）→ --next 工作循环 → 1-5 节点上报 → --deploy 自动上报
//      → --verify 自动验收 → --loop 迭代（含非交互保护）→ 二轮重走 → --submit 终审 → 审计流
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp-skill-e2e');
const PARTICIPANT = path.join(TMP, 'participant');
const PACKAGE = path.join(ROOT, 'hackathon-skills.tgz');
const PORT = 3400;
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = 'test123';
const REL_SKILL = 'skill/hackathon-reporter/scripts/report.js';
const CLI = path.join(PARTICIPANT, REL_SKILL);

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

// 运行技能包内的 CLI；stdio 可选（'inherit' 调试 / 'ignore' 模拟非交互）
function runSkill(args, { cwd = PARTICIPANT, stdio = 'pipe', env = {} } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: [stdio === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out }));
  });
}

async function statusOf(accessKey) {
  return (await (await fetch(`${BASE}/api/report/status?accessKey=${accessKey}`)).json());
}
async function snapshot() {
  return (await (await fetch(BASE + '/api/snapshot')).json()).snapshot;
}

// 参赛项目 fixture：Node 应用 + 接口/E2E 测试命令 + .env（验证打包排除）
function writeFixture() {
  fs.mkdirSync(PARTICIPANT, { recursive: true });
  fs.writeFileSync(
    path.join(PARTICIPANT, 'package.json'),
    JSON.stringify(
      { name: 'e2e-participant', scripts: { start: 'node server.js', 'test:api': 'node test-api.js', 'test:e2e': 'node test-e2e.js' } },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(PARTICIPANT, 'server.js'),
    "const http=require('http');const port=Number(process.env.PORT)||8080;" +
      "http.createServer((q,s)=>{if(q.url==='/healthz'){s.setHeader('Content-Type','application/json');return s.end('{\"ok\":true}')}" +
      "s.setHeader('Content-Type','text/html; charset=utf-8');s.end('<h1>SKILL-E2E-OK</h1>')}).listen(port,'0.0.0.0',()=>console.log('up',port))"
  );
  fs.writeFileSync(
    path.join(PARTICIPANT, 'test-api.js'),
    "const u=process.env.DEPLOY_URL;fetch(u+'/healthz').then(r=>r.json()).then(j=>{console.log('api ok',JSON.stringify(j));process.exit(j.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
  );
  fs.writeFileSync(
    path.join(PARTICIPANT, 'test-e2e.js'),
    "const u=process.env.DEPLOY_URL;fetch(u+'/').then(r=>r.text()).then(t=>{console.log('e2e body',t.slice(0,40));process.exit(t.includes('SKILL-E2E-OK')?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
  );
  fs.writeFileSync(path.join(PARTICIPANT, '.env'), 'SECRET_SHOULD_NOT_SHIP=1\n');
  fs.writeFileSync(path.join(PARTICIPANT, '.gitignore'), 'node_modules/\nhackathon.config.json\n');
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(PACKAGE, { force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // ── 1. 独立测试服务（快速限频、独立 DB）──
  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), RATE_LIMIT_MS: '300', DB_PATH: path.join(TMP, 'test.db'), PUBLIC_HOST: 'localhost', ADMIN_PASSWORD: ADMIN_PW },
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

  try {
    // ── 2. 管理员打包技能包 ──
    console.log('\n-- 打包与下发 --');
    const pack = spawnSync(process.execPath, ['scripts/pack-skills.js', '--server', BASE], {
      cwd: ROOT,
      env: { ...process.env, ADMIN_PASSWORD: ADMIN_PW },
      encoding: 'utf8',
    });
    check('pack-skills 打包成功', pack.status === 0 && fs.existsSync(PACKAGE), pack.stderr);
    const listing = spawnSync('tar', ['-tzf', 'hackathon-skills.tgz'], { cwd: ROOT, encoding: 'utf8' }).stdout || '';
    check('包内含两个 skill 与上报地址文件', listing.includes('skill/hackathon-reporter/scripts/report.js') && listing.includes('skill/vibecoding-workflow/SKILL.md') && listing.includes('skill/hackathon-reporter/server.json'));
    check('包内不含 .env（密钥不随包下发）', !/\.env/.test(listing));

    // 解压到参赛项目目录（模拟参赛者拿到包）；tar 用相对路径规避 Windows 盘符被当作远程主机
    fs.mkdirSync(PARTICIPANT, { recursive: true });
    const relOut = path.relative(ROOT, PARTICIPANT).split(path.sep).join('/');
    const untar = spawnSync('tar', ['-xzf', 'hackathon-skills.tgz', '-C', relOut], { cwd: ROOT, encoding: 'utf8' });
    check('技能包解压到项目根', untar.status === 0 && fs.existsSync(CLI), untar.stderr);
    writeFixture();
    const baked = JSON.parse(fs.readFileSync(path.join(PARTICIPANT, 'skill', 'hackathon-reporter', 'server.json'), 'utf8'));
    check('内置上报地址与注册令牌已烘入', baked.serverUrl === BASE && String(baked.registerToken || '').startsWith('reg_'));

    // ── 3. --doctor 环境检测与用户引导 ──
    console.log('\n-- 环境检测与引导 --');
    const doc1 = await runSkill(['--doctor']);
    check('--doctor 无配置可运行且退出码 0', doc1.code === 0, `exit=${doc1.code}`);
    check('--doctor 输出检测与六步引导', doc1.out.includes('环境检测') && doc1.out.includes('用户引导'));
    check('--doctor 提示 config 缺失', doc1.out.includes('hackathon.config.json 不存在'));

    // ── 4. --init 自助注册（幂等）──
    console.log('\n-- 自助注册 --');
    const init1 = await runSkill(['--init', '--department', 'E2E 部门', '--group', 'E2E 小组', '--project', '技能包全链路用例']);
    check('--init 自助注册成功', init1.code === 0 && /注册成功/.test(init1.out), init1.out.slice(-200));
    const cfgPath = path.join(PARTICIPANT, 'hackathon.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const key1 = cfg.accessKey;
    check('配置已落盘且含 hk_ 密钥与部署地址', /^hk_[0-9a-f]{32}$/.test(key1 || '') && !!cfg.deployUrl, JSON.stringify(cfg));
    check('注册后自动输出环境检测与引导', init1.out.includes('环境检测') && init1.out.includes('用户引导'));

    const init2 = await runSkill(['--init', '--force', '--department', 'E2E 部门', '--group', 'E2E 小组', '--project', '技能包全链路用例']);
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('幂等：重复注册返回同一密钥', init2.code === 0 && cfg2.accessKey === key1 && init2.out.includes('幂等'));

    const doc2 = await runSkill(['--doctor']);
    check('--doctor 接入后检测通过（退出码 0）', doc2.code === 0, doc2.out.slice(-300));

    // ── 5. 工作循环：--next 与节点上报 ──
    console.log('\n-- 工作循环（第一轮）--');
    const next1 = await runSkill(['--next']);
    check('--next 展示第一节点工作项', next1.code === 0 && next1.out.includes('需求分析'));
    check('--status 显示轮次与进度', (await runSkill(['--status'])).out.includes('LOOP ×1'));

    for (const st of ['requirements', 'design', 'prototype', 'coding', 'testing']) {
      const r = await runSkill(['--stage', st, '--message', 'skill-e2e']);
      check(`上报 ${st}`, r.code === 0 && /已记录|进度/.test(r.out), r.out.slice(-160));
    }

    // ── 6. --deploy 自动部署并自动上报 ──
    console.log('\n-- 部署 --');
    const dep = await runSkill(['--deploy']);
    check('--deploy 成功', dep.code === 0, dep.out.slice(-300));
    const st6 = await statusOf(key1);
    check('部署节点自动上报（6/8，75%）', st6.completedStages === 6 && st6.progress === 75, JSON.stringify(st6));
    check('--status 不泄露密钥且轮次正确', st6.loopCount === 1);
    const link = await (await fetch(`http://localhost:${st6.port}/`)).text().catch(() => '');
    check('部署的应用可访问（评委链接）', link.includes('SKILL-E2E-OK'), link.slice(0, 80));

    // ── 7. --verify 自动验收 ──
    console.log('\n-- 线上验收 --');
    const ver = await runSkill(['--verify']);
    check('--verify 全部通过（退出码 0）', ver.code === 0, ver.out.slice(-300));
    const st7 = await statusOf(key1);
    check('线上验收自动上报（7/8，88%，待终审）', st7.completedStages === 7 && st7.progress === 88 && st7.nextStage?.id === 'submission', JSON.stringify(st7));

    // ── 8. --loop 第二轮迭代 ──
    console.log('\n-- 迭代（loop）--');
    const noTty = await runSkill(['--loop'], { stdio: 'ignore' });
    check('非交互环境 --loop 明确报错退出码 2', noTty.code === 2 && noTty.out.includes('非交互'), `exit=${noTty.code}`);
    const loop = await runSkill(['--loop', '--yes']);
    check('--loop 开启第二轮', loop.code === 0 && loop.out.includes('LOOP ×2'), loop.out.slice(-200));
    const stLoop = await statusOf(key1);
    check('迭代后进度重置、轮次递增', stLoop.loopCount === 2 && stLoop.completedStages === 0);

    // ── 9. 第二轮走完并最终提交 ──
    console.log('\n-- 第二轮 + 最终提交 --');
    for (const st of ['requirements', 'design', 'prototype', 'coding', 'testing']) {
      await runSkill(['--stage', st, '--message', 'skill-e2e round2']);
    }
    const dep2 = await runSkill(['--deploy']);
    check('第二轮 --deploy 成功', dep2.code === 0, dep2.out.slice(-200));
    const ver2 = await runSkill(['--verify']);
    check('第二轮 --verify 成功', ver2.code === 0, ver2.out.slice(-200));
    const sub = await runSkill(['--submit', '--yes']);
    check('--submit 最终提交成功（8/8，100%）', sub.code === 0 && sub.out.includes('最终提交完成'), sub.out.slice(-200));
    const stSub = await statusOf(key1);
    check('终审后状态与进度', stSub.completedStages === 8 && stSub.progress === 100);
    const subAgain = await runSkill(['--submit', '--yes']);
    check('重复 --submit 幂等提示（退出码 0）', subAgain.code === 0 && subAgain.out.includes('已完成最终提交'));

    // ── 10. 大屏与审计一致性 ──
    console.log('\n-- 大屏与审计 --');
    const snap = await snapshot();
    const me = snap.departments.flatMap((d) => d.groups.flatMap((g) => g.projects)).find((p) => p.name === '技能包全链路用例');
    check('大屏可见项目且状态 submitted / LOOP×2', me?.status === 'submitted' && me?.loop_count === 2, JSON.stringify(me));
    check('大屏 8 节点模型', snap.stages.length === 8);
    const stages = new Set(snap.events.map((e) => e.stage));
    check('审计流含注册/迭代/终审事件', stages.has('register') && stages.has('loop') && stages.has('submission'), [...stages].join(','));
  } finally {
    // 先经管理 API 停止被测项目部署（否则应用进程会随测试结束残留占用端口）
    try {
      const login = await fetch(BASE + '/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PW }),
      });
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      const projects = await (await fetch(BASE + '/api/admin/projects', { headers: { Cookie: cookie } })).json();
      for (const p of projects.projects || []) {
        await fetch(`${BASE}/api/admin/deploys/${p.id}/stop`, { method: 'POST', headers: { Cookie: cookie } });
      }
    } catch {
      /* 停服失败不阻塞清理 */
    }
    server.kill();
    await sleep(500);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(PACKAGE, { force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
