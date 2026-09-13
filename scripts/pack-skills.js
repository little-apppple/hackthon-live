#!/usr/bin/env node
'use strict';
// 打技能包：把 skill/ 下两个技能打成 tgz，并内置上报地址与本期注册令牌（server.json）。
// 参赛者解压到项目根（得到 skill/ 目录），在项目根执行
//   node skill/hackathon-reporter/scripts/report.js --init
// 即进入自助注册模式（引导填部门/小组/项目名 → 换取 accessKey）。
//
// 用法：
//   node scripts/pack-skills.js                                # 服务端 = http://<PUBLIC_HOST|localhost>:<PORT|3000>
//   node scripts/pack-skills.js --server http://1.2.3.4:50000  # 指定对外地址（令牌也从该服务端签发）
//   ADMIN_PASSWORD=xxx node scripts/pack-skills.js             # 管理密码（缺省用服务端配置值）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('../server/src/config');

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const serverUrl = (argOf('--server') || argOf('--host') || `http://${config.publicHost}:${config.port}`).replace(/\/+$/, '');
const password = process.env.ADMIN_PASSWORD || config.adminPassword;

// 登录管理后台并取本期注册令牌（未签发则自动生成；轮换用 POST /api/admin/register-token）
async function fetchRegisterToken() {
  const login = await fetch(serverUrl + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`管理密码登录失败（HTTP ${login.status}），可用 ADMIN_PASSWORD 环境变量指定`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const r = await fetch(serverUrl + '/api/admin/register-token', { headers: { Cookie: cookie } });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.token) throw new Error(`获取注册令牌失败（HTTP ${r.status}）：服务端版本可能过旧`);
  return body.token;
}

(async () => {
  let registerToken;
  try {
    registerToken = await fetchRegisterToken();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  const ROOT = path.resolve(__dirname, '..');
  const OUT = path.join(ROOT, 'hackathon-skills.tgz');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-pack-'));

  // 复制技能目录（排除运行时产物），写入内置上报地址与注册令牌
  for (const name of ['hackathon-reporter', 'vibecoding-workflow']) {
    fs.cpSync(path.join(ROOT, 'skill', name), path.join(tmp, 'skill', name), { recursive: true });
  }
  fs.writeFileSync(
    path.join(tmp, 'skill', 'hackathon-reporter', 'server.json'),
    JSON.stringify({ serverUrl, registerToken, packedAt: new Date().toISOString() }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(tmp, '安装说明.txt'),
    [
      `黑客松参赛技能包（已内置上报地址：${serverUrl}）`,
      '',
      '1. 把本包解压到你的参赛项目根目录（解压后得到 skill/ 目录）；',
      '2. 在项目根目录执行：node skill/hackathon-reporter/scripts/report.js --init',
      '   按提示填写部门 / 小组 / 项目名称，自动换取 accessKey（幂等，重复执行返回同一密钥）；',
      '3. 之后用 --next 驱动比赛流程：--next → 干活 → 按给出的命令上报 → 再 --next。',
    ].join('\n')
  );

  // tar 输出到 stdout 再落盘：避免 Windows 盘符路径被 GNU tar 当作远程主机
  const buf = execFileSync('tar', ['-czf', '-', '-C', tmp, '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
  fs.writeFileSync(OUT, buf);
  fs.rmSync(tmp, { recursive: true, force: true });
  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`✓ 技能包已生成: ${OUT}（${size} KB）`);
  console.log(`  内置上报地址: ${serverUrl}`);
  console.log(`  注册令牌: 已从服务端取回并烘入（token 明文不打印；轮换用 POST /api/admin/register-token）`);
  console.log('  下发后解压到参赛项目根目录，执行 node skill/hackathon-reporter/scripts/report.js --init 即可接入。');
})();
