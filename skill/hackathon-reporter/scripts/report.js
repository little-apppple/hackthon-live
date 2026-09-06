#!/usr/bin/env node
'use strict';
// 黑客松进度上报 CLI（零依赖，Node 18+）
// 用法：
//   node report.js --stage coding --message "核心功能完成"
//   node report.js --status
//   node report.js --deploy [--dir dist] [--type node|static] [--start "npm start"] [--no-install]
//   node report.js --verify [--url <部署地址>] [--dry]   # 线上验收自动化
//   node report.js --config /path/to/hackathon.config.json --stage 4
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const USAGE = `用法:
  node report.js --init [--server-url <地址> --access-key <密钥>] [--deploy-url <地址>] [--force]
  node report.js --next [--config <路径>]
  node report.js --stage <节点标识|序号> [--message "说明"] [--config <路径>]
  node report.js --status [--config <路径>]
  node report.js --deploy [--dir <目录>] [--type node|static] [--start <命令>] [--no-install] [--config <路径>]
  node report.js --verify [--url <部署地址>] [--dry] [--config <路径>]
节点: requirements(1) design(2) prototype(3) coding(4) testing(5) deployment(6) acceptance(7)
--init: 首次接入：生成 hackathon.config.json（缺参时进入交互问答），完成后自动展示第一个工作项
--next: 查看下一节点工作项（工作循环入口：--next → 干活 → 上报 → 再 --next）
--deploy: 打包并上传到服务端自动部署到预留端口，探活通过后自动上报「上线部署」
--verify: 探活 + 接口测试 + E2E 全部通过后自动上报「线上验收」（退出码 3 = 验证未通过）`;

const ONBOARDING = `── 首次使用接入引导 ──────────────────────────────
本 skill 驱动你的比赛全流程，接入只需两步：

① 向赛事管理员索取两样东西：
   - 赛事服务端地址（形如 http://<服务器IP>:<端口>）
   - 本项目的 accessKey（hk_ 开头，报名后由管理员发放）

② 在项目根目录执行自动配置：
   node report.js --init
   （交互式问答；也可一次性带参：
     node report.js --init --server-url http://… --access-key hk_…）

配置完成后执行 node report.js --next 即可开始比赛流程：
  --next 查看下一节点工作项 → 干活 → 按给出的命令上报 → 再 --next
  七个节点：需求分析→方案设计→原型设计→代码开发→本地测试→上线部署→线上验收
──────────────────────────────────────────────`;

// 每个节点的工作项指引（与服务端节点定义对齐）
const STAGE_GUIDE = {
  requirements: {
    name: '需求分析',
    done: '需求清单/文档产出，圈定可演示的核心场景',
    tips: ['列出功能清单并排优先级，明确演示主线', '砍掉演示主线之外的一切（时间有限）'],
    cmd: 'node report.js --stage requirements --message "一句话成果"',
  },
  design: {
    name: '方案设计',
    done: '技术选型、架构、核心接口契约定稿',
    tips: ['先定核心接口契约——coding 和验收测试都依赖它', '选团队最熟的技术栈，不引入新框架'],
    cmd: 'node report.js --stage design --message "一句话成果"',
  },
  prototype: {
    name: '原型设计',
    done: '页面/交互原型完成并确认',
    tips: ['确定验收 E2E 要覆盖的核心流程路径', '原型确认后再动手写代码，避免返工'],
    cmd: 'node report.js --stage prototype --message "一句话成果"',
  },
  coding: {
    name: '代码开发',
    done: '核心功能全部完成、可运行',
    tips: ['服务必须监听 process.env.PORT（自动部署靠它注入端口）', '本地开发可回退默认端口'],
    cmd: 'node report.js --stage coding --message "一句话成果"',
  },
  testing: {
    name: '本地测试',
    done: '核心流程自测通过、无明显 bug',
    tips: ['直接编写 hackathon.config.json 里 verify.api / verify.e2e 指向的测试脚本——这就是验收要用的', '测试覆盖演示主线即可'],
    cmd: 'node report.js --stage testing --message "一句话成果"',
  },
  deployment: {
    name: '上线部署',
    done: '应用已在预留端口上运行并可访问',
    tips: ['推荐 --deploy：服务端自动注入端口、起服、探活、上报', '手动路径：自行监听预留端口启动成功后 --stage deployment'],
    cmd: 'node report.js --deploy',
  },
  acceptance: {
    name: '线上验收',
    done: '探活 + 接口测试 + E2E 全部通过（自动化验证，不靠自我申报）',
    tips: ['确保 hackathon.config.json 的 verify.api / verify.e2e 已配置并可跑通', '可用 --dry 先验证不上报'],
    cmd: 'node report.js --verify',
  },
};

function parseArgs(argv) {
  const args = { config: 'hackathon.config.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') args.stage = argv[++i];
    else if (a === '--message') args.message = argv[++i];
    else if (a === '--status') args.status = true;
    else if (a === '--next') args.next = true;
    else if (a === '--init') args.init = true;
    else if (a === '--server-url') args.serverUrl = argv[++i];
    else if (a === '--access-key') args.accessKey = argv[++i];
    else if (a === '--deploy-url') args.deployUrl = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--verify') args.verify = true;
    else if (a === '--deploy') args.deploy = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--dry') args.dry = true;
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--install') args.install = true;
    else if (a === '--no-install') args.noInstall = true;
    else if (a === '--config') args.config = argv[++i];
    else {
      console.error(`未知参数: ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
  return args;
}

function loadConfig(file) {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) {
    console.error(`✗ 未找到配置文件: ${p}`);
    console.error(ONBOARDING);
    process.exit(1);
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!cfg.serverUrl || !cfg.accessKey) {
      console.error('✗ 配置文件缺少 serverUrl 或 accessKey 字段');
      process.exit(1);
    }
    return cfg;
  } catch (e) {
    console.error(`✗ 配置文件解析失败: ${e.message}`);
    process.exit(1);
  }
}

async function callApi(cfg, urlPath, options) {
  // 小 JSON 请求默认 20s 超时：服务端挂起时让网络重试机制有机会接管
  const opts = { signal: AbortSignal.timeout(20000), ...options };
  const res = await fetch(cfg.serverUrl.replace(/\/$/, '') + urlPath, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body };
}

// 网络波动自动重试（超时/连接失败），仅用于小请求；部署上传不适用
async function callApiWithRetry(cfg, urlPath, options, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await callApi(cfg, urlPath, options);
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        console.log(`⚠ 网络波动，${i * 2} 秒后自动重试（第 ${i}/${attempts - 1} 次）…`);
        await new Promise((r) => setTimeout(r, i * 2000));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.init) return cmdInit(args);
  const cfg = loadConfig(args.config);

  if (args.verify) {
    if (args.stage) console.warn('⚠ 已同时指定 --stage，验收模式下将被忽略（验收由 --verify 自动上报）');
    return cmdVerify(args, cfg);
  }
  if (args.deploy) {
    if (args.stage) console.warn('⚠ 已同时指定 --stage，部署模式下将被忽略（上线部署由 --deploy 自动上报）');
    return cmdDeploy(args, cfg);
  }

  if (args.next) return cmdNext(args, cfg);

  if (args.status) {
    try {
      const { status, body } = await callApiWithRetry(
        cfg,
        `/api/report/status?accessKey=${encodeURIComponent(cfg.accessKey)}`
      );
      if (status === 200 && body?.ok) {
        if (body.revoked) {
          console.error('✗ 该 accessKey 已被吊销，请联系赛事管理员。');
          process.exit(1);
        }
        console.log(`项目: ${body.projectName}`);
        console.log(`进度: ${body.completedStages}/7（${body.progress}%）`);
        console.log(body.nextStage ? `下一节点: ${body.nextStage.index}. ${body.nextStage.name} (${body.nextStage.id})` : '全部节点已完成 🎉');
        process.exit(0);
      }
      printApiError(status, body);
    } catch {
      networkError();
    }
    return;
  }

  if (!args.stage) {
    console.error(USAGE);
    process.exit(2);
  }

  const payload = JSON.stringify({ accessKey: cfg.accessKey, stage: args.stage, message: args.message || '' });
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload };

  try {
    let { status, body } = await callApiWithRetry(cfg, '/api/report', options);

    // 限频自动等待重试一次
    if (status === 429 && body?.retryAfterSeconds) {
      const wait = Math.min(body.retryAfterSeconds, 15);
      console.log(`⏳ 上报过于频繁，${wait} 秒后自动重试…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      ({ status, body } = await callApiWithRetry(cfg, '/api/report', options));
    }

    if (status === 200 && body?.ok) {
      const bar = '█'.repeat(body.completedStages) + '░'.repeat(7 - body.completedStages);
      console.log(`✓ ${body.message}`);
      console.log(`  [${bar}] ${body.completedStages}/7（${body.progress}%）`);
      if (body.deployProbe === 'unreachable') {
        console.log('  ⚠ 服务端未探测到端口响应，请确认应用已监听预留端口');
      }
      if (body.nextStage) console.log(`  下一节点: ${body.nextStage.index}. ${body.nextStage.name} (${body.nextStage.id})`);
      process.exit(0);
    }
    printApiError(status, body);
  } catch {
    networkError();
  }
}

// ---------- 首次接入：--init 生成配置并展示第一个工作项 ----------

async function ask(rl, question) {
  return rl.question(question);
}

async function cmdInit(args) {
  const target = path.resolve(process.cwd(), 'hackathon.config.json');
  if (fs.existsSync(target) && !args.force) {
    console.log('✓ 已存在 hackathon.config.json，无需重复初始化。');
    console.log('  如需覆盖重新生成：node report.js --init --force');
    return cmdNext(args, loadConfig(args.config));
  }

  let serverUrl = args.serverUrl;
  let accessKey = args.accessKey;
  let deployUrl = args.deployUrl;

  if (!serverUrl || !accessKey) {
    console.log('== 黑客松 skill 首次接入 ==');
    console.log('需要两样东西（向赛事管理员索取）：服务端地址、本项目 accessKey\n');
    const readline = require('readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!serverUrl) serverUrl = await ask(rl, '① 赛事服务端地址（如 http://47.108.217.153:50000）: ');
      if (!accessKey) accessKey = await ask(rl, '② 本项目 accessKey（hk_ 开头）: ');
      if (!deployUrl) {
        const d = (await ask(rl, '③ 部署地址 deployUrl（可选，分配端口确认后填，回车跳过）: ')).trim();
        if (d) deployUrl = d;
      }
    } finally {
      rl.close();
    }
  }

  serverUrl = String(serverUrl || '').trim().replace(/\/+$/, '');
  accessKey = String(accessKey || '').trim();
  if (!/^https?:\/\//.test(serverUrl)) {
    console.error('✗ 服务端地址需以 http:// 或 https:// 开头');
    process.exit(2);
  }
  if (!accessKey.startsWith('hk_')) {
    console.error('✗ accessKey 应以 hk_ 开头，请核对管理员发放的内容');
    process.exit(2);
  }

  const cfg = {
    serverUrl,
    accessKey,
    deploy: { type: 'node', start: 'npm start', install: true, dir: '.' },
    verify: { api: 'npm run test:api', e2e: 'npm run test:e2e' },
  };
  if (deployUrl) cfg.deployUrl = String(deployUrl).trim();
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n✓ 已生成 ${target}`);
  console.log('  接下来进入工作循环：--next 查看工作项 → 干活 → 按给出的命令上报 → 再 --next');
  console.log('  注意：testing 节点前请把 verify.api / verify.e2e 指向你的真实测试命令（验收要跑它们）；');
  console.log('  纯前端静态站把 deploy 改为 { "type": "static", "dir": "dist" }。');
  return cmdNext(args, cfg);
}

// ---------- 工作循环：--next 返回下一节点工作项 ----------

async function cmdNext(args, cfg) {
  let status;
  try {
    const r = await callApiWithRetry(cfg, `/api/report/status?accessKey=${encodeURIComponent(cfg.accessKey)}`);
    status = r.body;
    if (r.status !== 200 || !status?.ok) return printApiError(r.status, r.body);
  } catch {
    return networkError();
  }
  if (status.revoked) {
    console.error('✗ 该 accessKey 已被吊销，无法继续。请联系赛事管理员。');
    process.exit(1);
  }

  console.log(`== 黑客松工作项 ==`);
  console.log(`项目: ${status.projectName}`);
  console.log(`进度: ${status.completedStages}/7（${status.progress}%）`);

  if (!status.nextStage) {
    console.log('\n🎉 全部节点已完成，比赛流程结束。评委可通过大屏访问项目。');
    process.exit(0);
  }

  const guide = STAGE_GUIDE[status.nextStage.id];
  console.log(`\n▶ 下一节点 ${status.nextStage.index}. ${status.nextStage.name} (${status.nextStage.id})`);
  if (!guide) {
    // 新旧版本短暂混跑时的兜底：服务端有、本地指引表没有的节点
    console.log('  完成标准: 见赛事说明（本地指引表未收录该节点）');
    console.log('  完成后执行:');
    console.log(`    node report.js --stage ${status.nextStage.id} --message "一句话成果"`);
    process.exit(0);
  }
  console.log(`  完成标准: ${guide.done}`);
  console.log('  建议动作:');
  guide.tips.forEach((t) => console.log(`    - ${t}`));
  console.log('  完成后执行:');
  console.log(`    ${guide.cmd}`);
  process.exit(0);
}

// ---------- 自动部署：打包 → 上传 → 服务端起服 → 自动上报「上线部署」 ----------

async function cmdDeploy(args, cfg) {
  const dcfg = cfg.deploy || {};
  const type = args.type || dcfg.type || 'node';
  if (!['node', 'static'].includes(type)) {
    console.error(`✗ 无效的部署类型: ${type}（应为 node 或 static）`);
    process.exit(2);
  }
  const dir = args.dir || dcfg.dir || '.';
  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) {
    console.error(`✗ 打包目录不存在: ${absDir}`);
    process.exit(2);
  }

  // 启动命令：--start > 配置 > package.json 推断 > npm start
  let startCmd = args.start || dcfg.start || '';
  if (type === 'node' && !startCmd) {
    const pkgPath = path.join(absDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        startCmd = pkg.scripts?.start || (pkg.main ? `node ${pkg.main}` : '');
      } catch {
        /* package.json 解析失败按无处理 */
      }
    }
  }
  if (type === 'node' && !startCmd) {
    console.error('✗ 未指定启动命令：用 --start "npm start"，或在 package.json 配置 scripts.start，或在 hackathon.config.json 配置 deploy.start');
    process.exit(2);
  }

  const install = args.noInstall ? false : (args.install ?? dcfg.install ?? type === 'node');

  console.log('== 黑客松自动部署 ==');
  console.log(`类型: ${type}${type === 'node' ? ` | 启动: ${startCmd}${install ? ' | 先安装依赖' : ''}` : ''}`);

  // 1. 打包（tgz；排除 node_modules、.git 与含 accessKey 的本地配置，避免经静态托管泄露；
  //    tar 输出到 stdout，避免 Windows 盘符路径被 GNU tar 当作远程主机）
  console.log(`→ 打包 ${absDir} …`);
  let body;
  try {
    const chunks = [];
    await new Promise((resolve, reject) => {
      const t = spawn(
        'tar',
        ['-czf', '-', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'hackathon.config.json', '.'],
        {
          cwd: absDir,
          stdio: ['ignore', 'pipe', 'inherit'],
        }
      );
      t.stdout.on('data', (c) => chunks.push(c));
      t.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
      t.on('error', reject);
    });
    body = Buffer.concat(chunks);
  } catch (e) {
    console.error(`✗ 打包失败: ${e.message}（需要 tar 命令：Win10+ 自带，或安装 Git Bash）`);
    process.exit(1);
  }
  if (!body.length) {
    console.error('✗ 打包结果为空');
    process.exit(1);
  }

  // 2. 上传部署
  console.log(`→ 上传 ${(body.length / 1024 / 1024).toFixed(1)} MB 并部署到预留端口…`);
  const q = new URLSearchParams({ accessKey: cfg.accessKey, type, start: startCmd, install: install ? '1' : '0' });
  try {
    const res = await fetch(cfg.serverUrl.replace(/\/$/, '') + '/api/deploy?' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body,
      signal: AbortSignal.timeout(300000),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      console.log(`✓ 部署成功: ${data.deployUrl}`);
      if (data.stageReported) {
        console.log('  已自动上报「上线部署」，大屏链接已开放访问。');
        console.log('  进度: 6/7（86%）  下一节点: 7. 线上验收 (acceptance)');
        console.log('  下一步: 验收时执行 node report.js --verify');
      } else if (data.note) {
        console.log(`  ${data.note}`);
      }
      process.exit(0);
    }
    if (data?.logTail) console.error('---- 应用日志（末尾）----\n' + data.logTail + '\n----');
    printApiError(res.status, data);
  } catch {
    networkError();
  }
}

// ---------- 验收自动化：探活 → 接口测试 → E2E → 自动上报验收 ----------

function runCommand(cmd, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function probeLiveness(url, retries) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      return { ok: true, detail: `HTTP ${res.status}` };
    } catch (e) {
      if (i < retries) {
        console.log(`  探活第 ${i}/${retries} 次失败，1.5 秒后重试…`);
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        return { ok: false, detail: e.cause?.code || e.name || '无响应' };
      }
    }
  }
}

async function cmdVerify(args, cfg) {
  const verifyCfg = cfg.verify || {};
  console.log('== 黑客松线上验收自动化 ==');

  // 1. 定位部署地址与当前进度
  let status;
  try {
    const r = await callApiWithRetry(cfg, `/api/report/status?accessKey=${encodeURIComponent(cfg.accessKey)}`);
    status = r.body;
    if (r.status !== 200 || !status?.ok) return printApiError(r.status, r.body);
  } catch {
    return networkError();
  }
  if (status.revoked) {
    console.error('✗ 该 accessKey 已被吊销，无法验收。');
    process.exit(1);
  }
  if (status.completedStages >= 7) {
    console.log('✓ 该项目已全部完成并通过验收，无需重复验收。');
    process.exit(0);
  }
  if (status.completedStages < 6) {
    console.error(`✗ 尚未完成「上线部署」节点（当前 ${status.completedStages}/6），先部署并上报 deployment 后再验收。`);
    process.exit(1);
  }

  let url = args.url || verifyCfg.url || cfg.deployUrl;
  if (!url) {
    url = `http://localhost:${status.port}`;
    console.log('ℹ 未配置部署地址（--url / hackathon.config.json 的 deployUrl），按应用在本机运行处理。');
    console.log('  若应用部署在赛事服务器上，请用 --url 或配置 deployUrl 指向公网地址。');
  }
  url = url.replace(/\/+$/, '');
  console.log(`目标: ${url}\n`);

  // 2. 探活
  console.log('→ 探活检查…');
  const liveness = await probeLiveness(url, verifyCfg.livenessRetries || 8);
  console.log(liveness.ok ? `✓ 探活通过（${liveness.detail}）` : `✗ 探活失败: ${liveness.detail}`);
  if (!liveness.ok) {
    console.error('\n✗ 验收未通过：应用探活失败，不会上报验收。请确认已部署并监听预留端口。');
    process.exit(3);
  }

  // 3. 接口测试 / E2E（项目自定义命令，DEPLOY_URL 环境变量注入目标地址）
  const results = { liveness: { ok: true, detail: liveness.detail } };
  for (const [kind, label] of [
    ['api', '接口测试'],
    ['e2e', 'E2E 测试'],
  ]) {
    const cmd = verifyCfg[kind];
    if (!cmd) {
      console.log(`\n- 未配置${label}（hackathon.config.json 的 verify.${kind}），跳过`);
      results[kind] = { skipped: true };
      continue;
    }
    console.log(`\n→ 运行${label}: ${cmd}`);
    const ok = await runCommand(cmd, process.cwd(), { DEPLOY_URL: url, VERIFY_PORT: String(status.port) });
    results[kind] = { ok };
    console.log(ok ? `✓ ${label}通过` : `✗ ${label}失败`);
    if (!ok) {
      console.error(`\n✗ 验收未通过：${label}未通过，已停止，不会上报验收。修复后重新执行 --verify。`);
      process.exit(3);
    }
  }

  if (args.dry) {
    console.log('\n--dry 模式：验证全部通过，但未上报验收。去掉 --dry 正式验收。');
    process.exit(0);
  }

  // 4. 全部通过 → 自动上报验收（附证据）
  console.log('\n→ 验证全部通过，自动上报「线上验收」…');
  const payload = JSON.stringify({
    accessKey: cfg.accessKey,
    stage: 'acceptance',
    message: args.message || '线上验收通过（探活+接口测试+E2E 自动化验证）',
    evidence: { verify: results, deployUrl: url },
  });
  try {
    const acceptOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload };
    let { status: httpStatus, body } = await callApiWithRetry(cfg, '/api/report', acceptOpts);
    if (httpStatus === 429 && body?.retryAfterSeconds) {
      const wait = Math.min(body.retryAfterSeconds, 15);
      console.log(`⏳ 上报过于频繁，${wait} 秒后自动重试…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      ({ status: httpStatus, body } = await callApiWithRetry(cfg, '/api/report', acceptOpts));
    }
    if (httpStatus === 200 && body?.ok) {
      console.log(`\n🎉 ${body.message}`);
      console.log('  比赛流程全部完成，评委已可通过大屏访问项目。');
      process.exit(0);
    }
    return printApiError(httpStatus, body);
  } catch {
    networkError();
  }
}

function printApiError(status, body) {
  const code = body?.code || 'UNKNOWN';
  const err = body?.error || `HTTP ${status}`;
  console.error(`✗ 上报失败 [${code}]: ${err}`);
  if (code === 'STAGE_OUT_OF_ORDER' && body?.expectedStage) {
    console.error(`  请先完成并上报节点 ${body.expectedStage.index}. ${body.expectedStage.name} (${body.expectedStage.id})`);
    console.error(`  或执行 node report.js --status 查看当前进度。`);
  }
  if (code === 'STAGE_ALREADY_DONE') {
    if (body?.nextStage) {
      console.error(`  该节点已完成，下一节点是 ${body.nextStage.index}. ${body.nextStage.name} (${body.nextStage.id})`);
    } else {
      console.error('  全部节点已完成，验收早已通过。');
    }
  }
  if (code === 'KEY_REVOKED') console.error('  上报通道已被管理员禁用，请联系赛事管理员。');
  if (code === 'INVALID_KEY') console.error('  请检查 hackathon.config.json 中的 accessKey 是否正确。');
  process.exit(1);
}

function networkError() {
  console.error('✗ 网络错误 [NETWORK_ERROR]: 无法连接赛事服务端，请检查网络与 serverUrl 配置。');
  process.exit(1);
}

main();
