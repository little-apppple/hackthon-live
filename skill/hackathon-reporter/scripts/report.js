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
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

// 与服务端 STAGES.length 对齐的节点总数（八节点模型）
const TOTAL_STAGES = 8;

// 客户端唯一标识：首次接入时生成并绑定到项目，防止重名队伍互相覆盖
const genClientId = () => 'cli_' + crypto.randomBytes(16).toString('hex');

const USAGE = `用法:
  node report.js --init [--server-url <地址> --access-key <密钥>] [--deploy-url <地址>] [--force]     # 手工模式
  node report.js --init [--department <部门> --group <小组> --project <项目名>] [--description <简介>]  # 自助注册模式（技能包内置上报地址时自动启用）
  node report.js --next [--config <路径>]
  node report.js --stage <节点标识|序号> [--message "说明"] [--config <路径>]
  node report.js --status [--config <路径>]
  node report.js --doctor [--config <路径>]   # 环境检测与用户引导（--init 成功后自动运行）
  node report.js --deploy [--dir <目录>] [--type node|static] [--start <命令>] [--no-install] [--config <路径>]
  node report.js --verify [--url <部署地址>] [--dry] [--config <路径>]
节点: requirements(1) design(2) prototype(3) coding(4) testing(5) deployment(6) acceptance(7) submission(8)
--init 两种模式（都幂等，可安全重跑）:
  自助注册: 技能包内置上报地址（server.json）且未提供 --access-key 时启用——引导填写部门/小组/项目名，
            发送到服务端注册（录入名单、预留部署端口）并返回 accessKey；相同「部门/小组/项目名」
            只生成一次密钥，重复执行返回同一密钥
  手工模式: 提供 --access-key（管理员发放）时启用；缺 server-url 时进入交互问答
--next: 查看下一节点工作项（工作循环入口：--next → 干活 → 上报 → 再 --next）
--deploy: 打包并上传到服务端自动部署到预留端口，探活通过后自动上报「上线部署」
--verify: 探活 + 接口测试 + E2E 全部通过后自动上报「线上验收」（退出码 3 = 验证未通过）
--loop: 开新一轮迭代（上线后调整需求重走流程，进度重置、loop_count+1、历史留审计）
--submit: 用户本人确认后上报「最终提交」，当前线上版本定格为参赛评分作品`;

const ONBOARDING = `── 首次使用接入引导（两种模式任选其一）──────────────
模式 A · 自助注册（推荐，技能包内置上报地址时自动生效）：
   node report.js --init
   按提示填写部门、小组、项目名称即可，服务端自动录入名单、
   预留部署端口并发放 accessKey；相同「部门/小组/项目名」只发一次密钥，
   重复执行返回同一密钥（幂等），可安全重跑。
   也可一次性带参：node report.js --init --department <部门> --group <小组> --project <项目名>

模式 B · 管理员发放（后台建好项目后发 key）：
   向赛事管理员索取两样东西：赛事服务端地址、本项目 accessKey（hk_ 开头）
   node report.js --init --server-url http://… --access-key hk_…

配置完成后执行 node report.js --next 即可开始比赛流程：
  --next 查看下一节点工作项 → 干活 → 按给出的命令上报 → 再 --next
  八个节点：需求分析→方案设计→原型设计→代码开发→本地测试→上线部署→线上验收→最终提交
  上线后可 --loop 开新一轮迭代（调整需求重走流程）；--submit 由用户本人确认最终参赛作品
──────────────────────────────────────────────`;

// 每个节点的工作项指引（与服务端节点定义对齐）
// 参与感原则：需求由用户主导（Agent 只做搜索辅助与追问），原型可由用户选模板，最终提交必须用户本人确认
const STAGE_GUIDE = {
  requirements: {
    name: '需求分析',
    done: '用户确认的 PRD 落盘（docs/prd.md），产品逻辑闭环：每个输入/输出都有来源、每条流程都能跑通',
    tips: [
      '已装 superpowers：走 brainstorming 硬门禁——设计获用户批准前禁写任何代码；未装：深搜产出模板给用户填 + grill-me 追问',
      '按项目名深度搜索相关产品/同类实现，产出需求模板给用户参考填写',
      '用 grill-me 方式一次一问补盲点；不确定能否获取的数据/接口先验证再写进 PRD，禁止假设',
      'PRD 必须形成闭环：用户从哪来 → 做什么 → 数据从哪来 → 结果到哪去，断链即打回',
    ],
    cmd: 'node report.js --stage requirements --message "一句话成果"',
  },
  design: {
    name: '方案设计',
    done: '架构与核心接口契约定稿（技术选型固定：Node.js 全栈 + node:sqlite，无需另行讨论）',
    tips: ['技术栈默认 Node.js 全栈 + node:sqlite，除非用户明确要求更换', '先定核心接口契约——coding 和验收测试都依赖它'],
    cmd: 'node report.js --stage design --message "一句话成果"',
  },
  prototype: {
    name: '原型设计',
    done: '页面/交互原型获得用户确认',
    tips: [
      '可选：用户从设计模板站（如 https://designmd.app）选一个模板把链接发来，按模板风格实现原型',
      '用户没给模板则自行产出低注意力成本的原型，交用户确认后再进入开发',
    ],
    cmd: 'node report.js --stage prototype --message "一句话成果"',
  },
  coding: {
    name: '代码开发',
    done: '核心功能全部完成、可运行',
    tips: ['已装 superpowers：executing-plans 按任务清单 TDD（先看失败再实现），复杂任务子代理并行；未装：关键路径 TDD', '服务必须监听 process.env.PORT（自动部署靠它注入端口）', '本地开发可回退默认端口'],
    cmd: 'node report.js --stage coding --message "一句话成果"',
  },
  testing: {
    name: '本地测试',
    done: '核心流程自测通过、无明显 bug',
    tips: ['已装 superpowers：requesting/receiving-code-review 全新上下文独立评审，P0/P1 清零；未装：自检循环 ≤3 轮 + 新上下文交叉 review', '直接编写 hackathon.config.json 里 verify.api / verify.e2e 指向的测试脚本——这就是验收要用的', '测试覆盖演示主线即可'],
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
  submission: {
    name: '最终提交',
    done: '用户本人确认后，当前线上版本定格为最终参赛待评分作品',
    tips: ['必须让用户亲手执行 --submit 并在终端确认，Agent 不得代为确认', '提交前向用户展示线上地址与功能清单，确认这就是要评分的版本'],
    cmd: 'node report.js --submit',
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
    else if (a === '--department') args.department = argv[++i];
    else if (a === '--group') args.group = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--description') args.description = argv[++i];
    else if (a === '--register-token') args.registerToken = argv[++i];
    else if (a === '--loop') args.loop = true;
    else if (a === '--submit') args.submit = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--doctor') args.doctor = true;
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
  if (args.doctor) return cmdDoctor(args); // 无配置也可检测（放 loadConfig 之前）
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
  if (args.loop) return cmdLoop(args, cfg);
  if (args.submit) return cmdSubmit(args, cfg);

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
        console.log(`项目: ${body.projectName}（LOOP ×${body.loopCount || 1}）`);
        console.log(`进度: ${body.completedStages}/8（${body.progress}%）`);
        console.log(body.nextStage ? `下一节点: ${body.nextStage.index}. ${body.nextStage.name} (${body.nextStage.id})` : '最终提交已完成，作品已定格为参赛评分版本');
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
      const bar = '█'.repeat(body.completedStages) + '░'.repeat(Math.max(0, TOTAL_STAGES - body.completedStages));
      console.log(`✓ ${body.message}`);
      console.log(`  [${bar}] ${body.completedStages}/${TOTAL_STAGES}（${body.progress}%）`);
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

// 技能包内置的上报地址与注册令牌（打包时写入 server.json；源码仓库里为空占位）
function bakedConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server.json'), 'utf-8'));
    return {
      serverUrl: String(j.serverUrl || '').trim().replace(/\/+$/, ''),
      registerToken: String(j.registerToken || '').trim(),
    };
  } catch {
    return { serverUrl: '', registerToken: '' };
  }
}

// 注册模式：向服务端自助注册换取 accessKey（以 clientId 幂等，可安全重跑）
async function registerOnServer(serverUrl, registerToken, { department, group, project, description, clientId }) {
  const payload = JSON.stringify({ department, group, project, description: description || '', registerToken, clientId });
  const { status, body } = await callApiWithRetry(
    { serverUrl },
    '/api/register',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }
  );
  if (status === 200 && body?.ok) {
    if (body.revoked) {
      console.error('⚠ 该「部门/小组/项目名」对应的密钥已被管理员吊销，请联系赛事管理员恢复后再继续。');
      process.exit(1);
    }
    return body;
  }
  if (status === 404) {
    console.error('✗ 注册失败：服务端不支持自助注册（HTTP 404）。服务端版本可能过旧——请改用管理员发 key 模式：');
    console.error('  node report.js --init --server-url <地址> --access-key <密钥>');
    process.exit(1);
  }
  if (status === 401 && body?.code === 'REGISTER_TOKEN_INVALID') {
    console.error('✗ 注册失败：注册令牌缺失或不正确。请使用本期下发的技能包（内含注册令牌），或改用管理员发 key 模式。');
    process.exit(1);
  }
  if (status === 409 && body?.code === 'NAME_TAKEN') {
    console.error(`✗ 注册失败：${body.error}`);
    process.exit(1);
  }
  if (status === 400 && body?.code === 'INVALID_CLIENT_ID') {
    console.error('✗ 注册失败：本地客户端标识格式无效，请删除 hackathon.config.json 后重跑 --init 重新生成。');
    process.exit(1);
  }
  console.error(`✗ 注册失败 [${body?.code || 'HTTP ' + status}]: ${body?.error || '未知错误'}`);
  process.exit(1);
}

async function cmdInit(args) {
  const target = path.resolve(process.cwd(), 'hackathon.config.json');
  // 客户端标识：沿用既有配置里的（--force 重跑不变），没有则首次生成并绑定
  let clientId = null;
  try {
    clientId = JSON.parse(fs.readFileSync(target, 'utf-8')).clientId || null;
  } catch {
    /* 首次接入或配置损坏：重新生成 */
  }
  const isFirstBind = !clientId;
  if (!clientId) clientId = genClientId();

  if (fs.existsSync(target) && !args.force) {
    console.log('✓ 已存在 hackathon.config.json，无需重复初始化。');
    console.log('  如需覆盖重新生成：node report.js --init --force');
    return cmdNext(args, loadConfig(args.config));
  }

  const baked = bakedConfig();
  let serverUrl = args.serverUrl || baked.serverUrl;
  let accessKey = args.accessKey;
  let deployUrl = args.deployUrl;
  let boundByRegister = false;

  if (accessKey && (args.department || args.group || args.project)) {
    console.warn('⚠ 已提供 --access-key（手工模式），忽略 --department/--group/--project 注册参数');
  }

  if (serverUrl && !accessKey) {
    // ── 模式 A：自助注册（技能包内置上报地址，未提供 accessKey）──
    const department = args.department;
    const group = args.group;
    const project = args.project;
    if (!department || !group || !project) {
      console.log(`== 黑客松自助注册 ==（服务端：${serverUrl}）`);
      console.log('填写部门 / 小组 / 项目名称，服务端自动录入名单、预留部署端口并发放 accessKey');
      console.log('（幂等：相同「部门/小组/项目名」只发一次密钥，重复执行返回同一密钥）\n');
      const readline = require('readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const d = department || (await ask(rl, '① 部门: ')).trim();
        const g = group || (await ask(rl, '② 小组: ')).trim();
        const p = project || (await ask(rl, '③ 项目名称: ')).trim();
        args.department = d;
        args.group = g;
        args.project = p;
        if (!args.description) {
          const desc = (await ask(rl, '④ 项目一句话简介（可回车跳过）: ')).trim();
          if (desc) args.description = desc;
        }
      } finally {
        rl.close();
      }
    }
    if (!args.department || !args.group || !args.project) {
      console.error('✗ 部门 / 小组 / 项目名称均不能为空（各限 50 字符内）');
      process.exit(2);
    }
    for (const [label, v] of [['部门', args.department], ['小组', args.group], ['项目名称', args.project]]) {
      if (String(v).trim().length > 50) {
        console.error(`✗ ${label}超过 50 字符，请缩短后重试`);
        process.exit(2);
      }
    }
    if (!baked.registerToken && !args.registerToken) {
      console.error('✗ 缺少注册令牌（技能包 server.json 或 --register-token 参数）——请使用本期下发的技能包，或改用管理员发 key 模式：');
      console.error('  node report.js --init --server-url <地址> --access-key <密钥>');
      process.exit(1);
    }
    console.log(`\n→ 向服务端注册（${serverUrl}）…`);
    const r = await registerOnServer(serverUrl, args.registerToken || baked.registerToken, {
      department: args.department,
      group: args.group,
      project: args.project,
      description: args.description,
      clientId,
    });
    accessKey = r.accessKey;
    deployUrl = r.deployUrl;
    boundByRegister = true;
    console.log(
      r.idempotent
        ? '✓ 已找到本客户端此前注册的项目，返回原有 accessKey（按客户端标识幂等）'
        : '✓ 注册成功，已录入名单并预留部署端口'
    );
    console.log(`  accessKey: ${accessKey}`);
    console.log(`  部署端口: ${r.port}（${r.deployUrl}）`);
    if (r.warning) console.warn(`  ⚠ ${r.warning}`);
    if (isFirstBind && r.clientBound) {
      console.log(`  客户端标识: ${clientId}（已绑定到本项目）`);
      console.log('  注意：该标识保存在 hackathon.config.json，换机器/重装请连同配置一起带走；丢失需管理员在后台解绑后重新接入。');
    }
  } else if (!serverUrl || !accessKey) {
    // ── 模式 B：管理员发放（原有交互）──
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
    clientId,
    deploy: { type: 'node', start: 'npm start', install: true, dir: '.' },
    verify: { api: 'npm run test:api', e2e: 'npm run test:e2e' },
  };
  if (deployUrl) cfg.deployUrl = String(deployUrl).trim();
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n✓ 已生成 ${target}`);

  // 手工发 key 模式：把 clientId 绑定到该密钥对应项目（注册模式已在 /api/register 内绑定，无需重复）
  if (isFirstBind && !boundByRegister && serverUrl && accessKey) {
    try {
      const { status, body } = await callApiWithRetry({ serverUrl }, '/api/bind-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessKey, clientId }),
      });
      if (status === 200 && body?.ok) {
        console.log(`  客户端标识: ${clientId}（已绑定到本项目密钥）`);
      } else if (status === 409 && body?.code === 'CLIENT_MISMATCH') {
        console.error(`✗ 客户端绑定失败：${body.error}`);
        process.exit(1);
      } else {
        console.warn(`  ⚠ 客户端标识绑定未完成（HTTP ${status}${body?.code ? ' ' + body.code : ''}）：不影响当前使用，稍后可重跑 --init --force 或联系管理员`);
      }
    } catch {
      console.warn('  ⚠ 客户端标识绑定未完成（网络不可达）：不影响当前使用，联网后重跑 --init --force 即可');
    }
  }
  console.log('  纯前端静态站把 deploy 改为 { "type": "static", "dir": "dist" }。');
  await runDoctor(cfg);
  return cmdNext(args, cfg);
}

// ---------- 环境检测与用户引导（--doctor；--init 成功后自动运行）----------

function readLocalPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

async function runDoctor(cfg, configBroken) {
  const rows = [];
  let failCount = 0;
  let gitAvailable = false;
  const ok = (t) => rows.push(`  ✓ ${t}`);
  const warn = (t, hint) => rows.push(`  ⚠ ${t}\n      → ${hint}`);
  const fail = (t, hint) => {
    failCount++;
    rows.push(`  ✗ ${t}\n      → ${hint}`);
  };

  // 1. Node：18+ 必需；22.5+ 才能「零编译用上 node:sqlite」（默认技术栈）
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 18) fail(`Node.js v${process.versions.node} 过低`, '本 skill 需要 18+；默认技术栈 node:sqlite 需要 22.5+，请升级');
  else if (maj > 22 || (maj === 22 && min >= 5)) ok(`Node.js v${process.versions.node}（满足 node:sqlite）`);
  else warn(`Node.js v${process.versions.node}`, '能跑本 skill，但默认技术栈 node:sqlite 需 22.5+，建议升级后再开发');

  // 2. git
  try {
    execSync('git --version', { stdio: 'pipe' });
    gitAvailable = true;
    ok('git 可用');
  } catch {
    warn('git 不可用', '工作循环第一步的分支同步依赖 git');
  }

  // 3. 配置
  if (configBroken) warn(`hackathon.config.json 无法解析（${configBroken}）`, '执行 node report.js --init --force 重新生成配置');
  else if (cfg) ok('hackathon.config.json 就位（accessKey 已配置）');
  else if (fs.existsSync(path.resolve(process.cwd(), 'hackathon.config.json'))) ok('hackathon.config.json 已存在');
  else warn('hackathon.config.json 不存在', '执行 node report.js --init 完成接入（自助注册或管理员发 key）');

  // 4. 服务端可达
  if (cfg?.serverUrl) {
    try {
      const r = await fetch(cfg.serverUrl.replace(/\/$/, '') + '/healthz', { signal: AbortSignal.timeout(3000) });
      r.ok ? ok(`服务端可达：${cfg.serverUrl}`) : warn(`服务端响应异常 HTTP ${r.status}`, '核对 serverUrl；持续异常联系赛事管理员');
    } catch (e) {
      const why = e?.cause?.code || e?.name || '';
      if (/CERT|TLS|SSL/i.test(why)) {
        warn(`服务端 TLS 证书异常（${why}）`, '网络是通的，但证书校验失败——内网自签证书请联系管理员，或确认 serverUrl 协议');
      } else {
        fail(`服务端不可达：${cfg.serverUrl}${why ? `（${why}）` : ''}`, '检查网络与地址；不影响本地开发，上报时会自动重试');
      }
    }
  }

  // 5. verify 配置
  if (cfg?.verify?.api && cfg?.verify?.e2e) ok('verify.api / verify.e2e 已配置');
  else warn('verify.api / verify.e2e 未配置完整', '「本地测试」节点前写好真实测试命令并填入配置——线上验收会执行它们，未配置的验收步骤会被跳过');

  // 5b. 客户端标识绑定（防止重名队伍互相覆盖）
  if (cfg?.clientId && /^cli_[0-9a-f]{32}$/.test(cfg.clientId)) ok('客户端标识已绑定（clientId 存在于配置中）');
  else if (cfg) warn('配置缺少客户端标识 clientId', '重跑 node report.js --init --force 完成绑定（防止与其他重名队伍互相覆盖进度）');

  // 6. 项目工程
  const pkg = readLocalPkg();
  if (pkg) {
    fs.existsSync(path.resolve(process.cwd(), 'node_modules'))
      ? ok('npm 依赖已安装')
      : warn('node_modules 不存在', '执行 npm install');
    pkg.scripts?.start
      ? ok('package.json 已定义 scripts.start（--deploy 使用）')
      : warn('package.json 缺 scripts.start', '自动部署默认取它作为启动命令，请补充或部署时用 --start 指定');
  } else {
    warn('当前目录没有 package.json', '纯前端静态站可忽略；Node 项目请在此目录初始化工程');
  }

  // 7. accessKey 泄露面：config 必须被 git 忽略（git 可用时用 check-ignore 权威判定，否则退回启发式）
  let ignored = null; // true/false/unknown
  if (gitAvailable) {
    try {
      execSync('git check-ignore hackathon.config.json', { stdio: 'pipe', cwd: process.cwd() });
      ignored = true;
    } catch (e) {
      ignored = e?.status === 1 ? false : null;
    }
  }
  if (ignored === null) {
    try {
      const gi = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf-8');
      ignored = /^.*hackathon\.config\.json\s*$/m.test(gi) && !/^!\s*hackathon\.config\.json/m.test(gi) ? true : false;
    } catch {
      ignored = null; // .gitignore 不存在或不可读
    }
  }
  const fixHint = '该文件含 accessKey！请把 hackathon.config.json 追加进 .gitignore（可让 Agent 执行，或手动加一行），防止提交泄露';
  if (ignored === true) ok('.gitignore 已忽略 hackathon.config.json（accessKey 不会进 git）');
  else if (ignored === false) fail('.gitignore 未忽略 hackathon.config.json', fixHint);
  else warn('无法确认 hackathon.config.json 是否被 git 忽略', fixHint);

  // 8. superpowers（可选工作流组件）：已装用其技能承载 SDD+TDD 门禁，未装按同等门禁手动执行——标准不降
  let superpowers = false;
  const spMarkers = ['superpowers'];
  const scanSuperpowers = (dir, depth) => {
    if (superpowers || depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (spMarkers.includes(e.name)) {
        superpowers = true;
        return;
      }
      scanSuperpowers(path.join(dir, e.name), depth + 1);
    }
  };
  for (const base of ['.claude/plugins', '.claude/skills']) {
    scanSuperpowers(path.join(os.homedir(), ...base.split('/')), 0);
  }
  if (superpowers) {
    ok('检测到 superpowers（各节点按 SDD 硬门禁执行：brainstorming/TDD/独立评审）');
  } else {
    rows.push('  · 未检测到 superpowers（可选组件）——SDD+TDD 门禁不降级：按同等门禁手动执行，八节点上报不受影响');
  }

  // 9. 同包的 vibecoding skill
  const setupJs = path.join(__dirname, '..', '..', 'vibecoding-workflow', 'scripts', 'setup.js');
  if (fs.existsSync(setupJs)) {
    rows.push(`  · 检测到 vibecoding-workflow skill：node ${path.relative(process.cwd(), setupJs).split(path.sep).join('/')} 可生成 CLAUDE.md/AGENTS.md 并做完整依赖检测`);
  }

  console.log('── 环境检测 ──────────────────');
  for (const r of rows) console.log(r);

  console.log('\n── 用户引导 · 下一步 ─────────');
  console.log('① node report.js --next      开始八节点工作循环（Agent 代跑，关键决策由你拍板）');
  console.log('② 需求分析：Agent 会按项目名搜索并给你一份需求模板——请亲自填写，它会用追问帮你补盲点，最终 PRD 必须逻辑闭环');
  console.log('③ 原型阶段：可从设计模板站（如 https://designmd.app）挑一个模板把链接发给 Agent，按它实现');
  console.log('④ 本地测试节点前，把 verify.api / verify.e2e 指向你的真实测试命令');
  console.log('⑤ 上线后想调整需求：node report.js --loop 开新一轮（大屏会显示 LOOP×轮数）');
  console.log('⑥ 全部完成：node report.js --submit 由你本人确认，作品定格为最终参赛评分版本');
  console.log('──────────────────────');
  return failCount;
}

async function cmdDoctor(args) {
  let cfg = null;
  let configBroken = null;
  const p = path.resolve(process.cwd(), args.config);
  if (fs.existsSync(p)) {
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
      configBroken = String(e.message).split('\n')[0];
    }
  }
  const failCount = await runDoctor(cfg, configBroken);
  if (failCount > 0) process.exit(1); // 与 setup.js 约定一致：1 = 存在待处理项（⚠ 不算）
}

// ---------- 迭代与最终提交 ----------

async function confirm(question) {
  // 非交互环境（管道/CI/无 stdin）：既不能静默取消也不能挂起——明确报错退出，提示用 --yes
  if (!process.stdin.isTTY || process.stdin.readableEnded) {
    console.error(`\n✗ 需要交互确认（${question.trim()}）`);
    console.error('  当前运行在非交互环境：确认操作无误后可加 --yes 跳过确认。');
    process.exit(2);
  }
  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answered = new Promise((resolve, reject) => {
    rl.on('close', () => reject(new Error('STDIN_CLOSED')));
  });
  try {
    const a = await Promise.race([rl.question(question).then((v) => String(v).trim().toLowerCase()), answered]);
    return a === 'y' || a === 'yes';
  } catch (e) {
    if (e?.message === 'STDIN_CLOSED') {
      console.error('\n✗ 输入流已关闭，视为取消。');
      return false;
    }
    throw e;
  } finally {
    rl.close();
  }
}

// --loop：开启新一轮迭代（上线后可调整需求重走全流程；进度重置、loop_count+1、历史留审计）
async function cmdLoop(args, cfg) {
  if (!args.yes && !(await confirm('确定开启新一轮迭代？进度将重置并重走全流程，历史记录保留在审计中 [y/N]: '))) {
    console.log('已取消。');
    return;
  }
  try {
    let { status, body } = await callApiWithRetry(cfg, '/api/loop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: cfg.accessKey }),
    });
    if (status === 429 && body?.retryAfterSeconds) {
      const wait = Math.min(body.retryAfterSeconds, 15);
      console.log(`⏳ 操作过于频繁，${wait} 秒后自动重试…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      ({ status, body } = await callApiWithRetry(cfg, '/api/loop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessKey: cfg.accessKey }),
      }));
    }
    if (status === 200 && body?.ok) {
      console.log(`✓ ${body.message}`);
      console.log(`  当前轮次: LOOP ×${body.loopCount}`);
      return cmdNext(args, cfg);
    }
    printApiError(status, body);
  } catch {
    networkError();
  }
}

// --submit：最终提交。必须由参赛用户本人交互确认——Agent 不得代为确认（服务端节点也要求顺序到位）
async function cmdSubmit(args, cfg) {
  let st;
  try {
    const r = await callApiWithRetry(cfg, `/api/report/status?accessKey=${encodeURIComponent(cfg.accessKey)}`);
    if (r.status !== 200 || !r.body?.ok) return printApiError(r.status, r.body);
    st = r.body;
  } catch {
    return networkError();
  }
  if (st.revoked) {
    console.error('✗ 该 accessKey 已被吊销，请联系赛事管理员。');
    process.exit(1);
  }
  if (st.completedStages >= TOTAL_STAGES) {
    console.log('✓ 该项目已完成最终提交，当前线上版本即为参赛评分版本。如需修改请 --loop 开新一轮。');
    process.exit(0);
  }
  if (st.completedStages < TOTAL_STAGES - 1 || !st.nextStage || st.nextStage.id !== 'submission') {
    console.error('✗ 还不能最终提交：请先完成「线上验收」（7/8）。');
    console.error(`  当前进度: ${st.completedStages}/${TOTAL_STAGES}，下一节点: ${st.nextStage ? `${st.nextStage.index}. ${st.nextStage.name}` : '无'}`);
    process.exit(1);
  }
  console.log('== 最终提交确认 ==');
  console.log(`项目: ${st.projectName}`);
  console.log(`部署地址: ${cfg.deployUrl || `http://localhost:${st.port}`}`);
  console.log('确认后，当前线上版本将定格为最终参赛待评分作品（如后续还要修改，可 --loop 开新一轮）。');
  if (!args.yes && !(await confirm('确认提交为最终参赛作品？[y/N]: '))) {
    console.log('已取消，未提交。');
    return;
  }
  const payload = JSON.stringify({
    accessKey: cfg.accessKey,
    stage: 'submission',
    message: args.message || '用户确认最终提交',
    evidence: { confirmedVia: 'cli-interactive' },
  });
  try {
    let { status, body } = await callApiWithRetry(cfg, '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (status === 429 && body?.retryAfterSeconds) {
      const wait = Math.min(body.retryAfterSeconds, 15);
      console.log(`⏳ 上报过于频繁，${wait} 秒后自动重试…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      ({ status, body } = await callApiWithRetry(cfg, '/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }));
    }
    if (status === 200 && body?.ok) {
      console.log('✓ 最终提交完成！当前线上版本即为参赛评分作品。');
      process.exit(0);
    }
    printApiError(status, body);
  } catch {
    networkError();
  }
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
  console.log(`进度: ${status.completedStages}/8（${status.progress}%）`);

  if (!status.nextStage) {
    console.log('\n🎉 最终提交已完成，作品已定格为参赛评分版本。评委可通过大屏访问项目。');
    process.exit(0);
  }
  if (status.nextStage.id === 'submission') {
    console.log('\n★ 七个开发节点已全部完成。最后一个节点「最终提交」必须由参赛用户本人执行：');
    console.log('  node report.js --submit    （终端交互确认后上报，Agent 请引导用户亲自运行）');
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
        ['-czf', '-', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'hackathon.config.json', '--exclude', '.env', '--exclude', '.env.*', '.'],
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
        console.log(`  进度: 6/${TOTAL_STAGES}（75%）  下一节点: 7. 线上验收 (acceptance)`);
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
  if (status.completedStages >= TOTAL_STAGES) {
    console.log('✓ 最终提交已完成，作品已是参赛评分版本。如需修改请 --loop 开新一轮。');
    process.exit(0);
  }
  if (status.completedStages === TOTAL_STAGES - 1) {
    console.log('✓ 验收已通过（7/8）。若这是要评分的版本，请让用户本人执行 --submit 完成最终提交。');
    process.exit(0);
  }
  if (status.completedStages < 6) {
    console.error(`✗ 尚未完成「上线部署」节点（当前 ${status.completedStages}/${TOTAL_STAGES}，部署为第 6 节点），先部署并上报 deployment 后再验收。`);
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
      console.error('  最终提交已完成，作品已是参赛评分版本。如需修改请 --loop 开新一轮。');
    }
  }
  if (code === 'KEY_REVOKED') console.error('  上报通道已被管理员禁用，请联系赛事管理员。');
  if (code === 'INVALID_KEY') console.error('  请检查 hackathon.config.json 中的 accessKey 是否正确。');
  if (code === 'LOOP_NOT_ALLOWED') console.error('  至少完成「上线部署」才能开新一轮迭代。');
  process.exit(1);
}

function networkError() {
  console.error('✗ 网络错误 [NETWORK_ERROR]: 无法连接赛事服务端，请检查网络与 serverUrl 配置。');
  process.exit(1);
}

main();
