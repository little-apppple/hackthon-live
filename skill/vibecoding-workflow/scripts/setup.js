#!/usr/bin/env node
'use strict';
// vibecoding-workflow 环境准备 CLI（零依赖，Node 18+）
// 用法：
//   node setup.js                 # 检测依赖 + 生成缺失的 CLAUDE.md / AGENTS.md
//   node setup.js --fix           # 检测 + 自动安装可安装项（npm 依赖、同步 skill 到 .claude/skills/）
//   node setup.js --force         # 覆盖重新生成 CLAUDE.md / AGENTS.md
//   node setup.js --project <目录>  # 面向其他项目执行（默认当前工作目录）
//   node setup.js --check         # 只检测不改动
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const REPORTER_SRC = path.join(SKILL_DIR, '..', 'hackathon-reporter', 'scripts', 'report.js');
const TEMPLATE = path.join(SKILL_DIR, 'templates', 'CLAUDE.md');

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length || args[i + 1].startsWith('--')) return null;
  return args[i + 1];
}
const FLAG_FIX = args.includes('--fix');
const FLAG_FORCE = args.includes('--force');
const FLAG_CHECK = args.includes('--check');
const PROJECT = path.resolve(argOf('--project') || process.cwd());
// report.js 命中任一位置即可：skill 源码同级，或项目 .claude/skills/ 里的已安装副本
function reporterAvailable() {
  if (fs.existsSync(REPORTER_SRC)) return REPORTER_SRC;
  const inProject = path.join(PROJECT, '.claude', 'skills', 'hackathon-reporter', 'scripts', 'report.js');
  if (fs.existsSync(inProject)) return inProject;
  return null;
}

let ok = 0;
let warn = 0;
let fixed = 0;
function pass(name) { ok++; console.log(`  ✓ ${name}`); }
function fail(name, extra) { warn++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
function note(msg) { console.log(`  · ${msg}`); }

function has(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}
function rel(p) { return path.relative(PROJECT, p).split(path.sep).join('/'); }

function writeDoc(filename) {
  const target = path.join(PROJECT, filename);
  if (fs.existsSync(target) && !FLAG_FORCE) {
    note(`${filename} 已存在，跳过（--force 可覆盖）`);
    return false;
  }
  let content = fs.readFileSync(TEMPLATE, 'utf8');
  const rep = reporterAvailable();
  content = content.replace(/\{\{REPORTER_PATH\}\}/g, rep ? rel(rep) : '<skill目录>/hackathon-reporter/scripts/report.js');
  fs.writeFileSync(target, content, 'utf8');
  console.log(`  + 已生成 ${filename}${FLAG_FORCE ? '（覆盖）' : ''}`);
  fixed++;
  return true;
}

console.log(`── vibecoding-workflow 环境检测（项目根：${PROJECT}）──\n`);

// 1. Node >= 18（cpSync 等依赖较新 API，低于 18 直接退出）
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(`  ✗ Node.js v${process.versions.node} 低于 18，本脚本要求 ≥18，请升级后重试`);
  process.exit(1);
}
pass(`Node.js v${process.versions.node}（≥18）`);

// 2. git
has('git') ? pass('git 可用') : fail('git 不可用', '流程第一步 git init / pull --rebase 依赖它');

// 3. hackathon-reporter skill（上报依赖）
const rep = reporterAvailable();
rep ? pass(`hackathon-reporter skill 存在（上报依赖：${rep}）`)
  : fail('hackathon-reporter skill 缺失', `期望 ${REPORTER_SRC} 或 ${path.join(PROJECT, '.claude', 'skills', 'hackathon-reporter', 'scripts', 'report.js')}`);

// 4. hackathon.config.json（参赛必需）
if (fs.existsSync(path.join(PROJECT, 'hackathon.config.json'))) {
  pass('hackathon.config.json 存在（参赛配置）');
} else {
  note('hackathon.config.json 不存在——非参赛项目可忽略；参赛项目请向赛事管理员索取 serverUrl 与 accessKey');
}

// 5. 项目 npm 依赖（存在 package.json 时检查）
if (fs.existsSync(path.join(PROJECT, 'package.json'))) {
  if (fs.existsSync(path.join(PROJECT, 'node_modules'))) {
    pass('npm 依赖已安装（node_modules 存在）');
  } else if (FLAG_FIX && !FLAG_CHECK) {
    console.log('  … 执行 npm install …');
    try {
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { cwd: PROJECT, stdio: 'inherit', shell: process.platform === 'win32' });
      fixed++; pass('npm install 完成');
    } catch (e) {
      fail('npm install 失败', String(e.message).split('\n')[0]);
    }
  } else {
    fail('npm 依赖未安装', '运行 --fix 自动执行 npm install');
  }
}

// 5b. E2E 工具链：先判定该项目是否真的依赖浏览器 E2E，再决定 Edge/无头策略检测的严重级别
console.log('');
const isWin = process.platform === 'win32';
// verify 命令或 package.json 依赖指向浏览器工具时才算「需要浏览器」，否则 Edge 缺失只提示不阻塞
function browserE2eNeeded() {
  try {
    const verify = JSON.parse(fs.readFileSync(path.join(PROJECT, 'hackathon.config.json'), 'utf8')).verify || {};
    if (/playwright|cypress|agent-browser/i.test(`${verify.api || ''} ${verify.e2e || ''}`)) return true;
  } catch { /* 无配置或解析失败按不需要处理，verify 检测段另行提示 */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((k) => /playwright|cypress/i.test(k));
  } catch { /* ignore */ }
  return false;
}
const needBrowser = browserE2eNeeded();
let edgePath = null;
if (!isWin) {
  note('非 Windows 环境，跳过 Edge 检测（E2E 推荐 channel 方案对应系统品牌浏览器）');
} else {
  for (const p of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]) {
    if (fs.existsSync(p)) { edgePath = p; break; }
  }
  if (edgePath) {
    pass(`系统 Edge 可用（E2E 免浏览器下载）：${edgePath}`);
  } else if (needBrowser) {
    fail('未找到系统 Edge', '项目依赖浏览器 E2E 而 Playwright channel 方案依赖 Edge；请确认已安装，或执行 agent-browser install 下载 Chrome for Testing');
  } else {
    note('未找到系统 Edge——当前项目未声明浏览器 E2E 依赖，仅提示不阻塞');
  }

  // Edge 无头模式被组策略禁用时 channel:'msedge' 启动失败，提前探出来
  let headlessBlocked = false;
  for (const hive of ['HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge']) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', 'HeadlessModeEnabled'], { stdio: 'pipe' }).toString();
      const m = out.match(/HeadlessModeEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
      if (m && parseInt(m[1], 16) === 0) headlessBlocked = true;
    } catch { /* 键不存在 = 未禁用（默认启用） */ }
  }
  if (headlessBlocked) {
    const msg = 'Edge 无头模式被组策略禁用（HeadlessModeEnabled=0）——headless 启动会失败：请管理员调整策略，或测试配置改用 headed 模式';
    needBrowser ? fail(msg) : note(`提示（当前项目未声明浏览器 E2E 依赖）：${msg}`);
  } else {
    note('Edge 无头策略正常（未发现 HeadlessModeEnabled=0）');
  }
}

// verify.api / verify.e2e 命令指向的工具是否已安装（在验收才发现就晚了）
function pkgInstalled(...segments) {
  // 依次探测项目 node_modules 与上级（monorepo 依赖提升）目录
  for (const base of [PROJECT, path.dirname(PROJECT)]) {
    if (fs.existsSync(path.join(base, 'node_modules', ...segments))) return true;
  }
  return false;
}
function checkVerifyTool(cmd, key) {
  if (!cmd) return;
  if (/playwright/i.test(cmd)) {
    const installed = pkgInstalled('@playwright', 'test') || pkgInstalled('playwright');
    installed ? pass(`verify.${key} 指向 Playwright，依赖已安装`)
      : fail(`verify.${key} 指向 Playwright 但未安装`, '执行 npm i -D @playwright/test；确认 playwright.config 里 use.channel="msedge"（用系统 Edge，无需 npx playwright install）');
    if (!isWin) note(`verify.${key}（Playwright）非 Windows 提示：channel 方案需系统品牌浏览器（如 Chrome），否则需执行 npx playwright install chromium`);
  } else if (/cypress/i.test(cmd)) {
    pkgInstalled('cypress')
      ? pass(`verify.${key} 指向 Cypress，依赖已安装`)
      : fail(`verify.${key} 指向 Cypress 但未安装`, '执行 npm i -D cypress（Cypress 需另行下载其自带浏览器依赖）');
  } else if (/agent-browser/i.test(cmd)) {
    has('agent-browser') ? pass(`verify.${key} 指向 agent-browser，CLI 可用`)
      : fail(`verify.${key} 指向 agent-browser 但 CLI 不可用`, 'npm i -g agent-browser；无 Chrome 时执行 agent-browser install 下载 Chrome for Testing，或加 --executable-path 指向 msedge.exe');
  }
}
const hackathonCfg = path.join(PROJECT, 'hackathon.config.json');
if (fs.existsSync(hackathonCfg)) {
  try {
    const verify = JSON.parse(fs.readFileSync(hackathonCfg, 'utf8')).verify || {};
    checkVerifyTool(verify.api, 'api');
    checkVerifyTool(verify.e2e, 'e2e');
    if (!verify.e2e) note('verify.e2e 未配置——acceptance 卡点会跳过 E2E 步骤，参赛项目请在 testing 节点补齐');
  } catch (e) {
    fail('hackathon.config.json 解析失败', String(e.message).split('\n')[0]);
  }
}

// 6. CLAUDE.md / AGENTS.md 生成
console.log('');
if (FLAG_CHECK) {
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    fs.existsSync(path.join(PROJECT, f)) ? pass(`${f} 已存在`) : fail(`${f} 缺失`, '默认运行本脚本即可自动生成');
  }
} else {
  console.log('── 文档生成 ──');
  writeDoc('CLAUDE.md');
  writeDoc('AGENTS.md');
}

// 7. skill 安装到 .claude/skills/（项目级，随仓库走）
console.log('');
const dest = path.join(PROJECT, '.claude', 'skills');
if (FLAG_FIX && !FLAG_CHECK) {
  const srcRoot = fs.existsSync(REPORTER_SRC) ? path.join(SKILL_DIR, '..') : null;
  if (!srcRoot) {
    note('skill 源目录不可用，跳过 .claude/skills 同步（上报依赖以项目内已安装副本为准）');
  } else {
    for (const name of ['vibecoding-workflow', 'hackathon-reporter']) {
      const src = path.join(srcRoot, name);
      const dst = path.join(dest, name);
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) { fail(`skill ${name} 源缺失`); continue; }
      if (fs.existsSync(dst)) { note(`.claude/skills/${name} 已存在，跳过同步（源更新后删除该目录再重跑 --fix）`); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      fixed++; pass(`已安装 skill → .claude/skills/${name}`);
    }
  }
} else {
  const names = ['vibecoding-workflow', 'hackathon-reporter'];
  for (const name of names) {
    fs.existsSync(path.join(dest, name, 'SKILL.md'))
      ? pass(`${name} 已安装到 .claude/skills/`)
      : note(`${name} 未安装到 .claude/skills/（--fix 可同步，随仓库走、按项目生效）`);
  }
}

console.log(`\n结果：${ok} 项通过，${warn} 项待处理${fixed ? `，本次自动完成 ${fixed} 项` : ''}。`);
if (warn > 0 && !FLAG_FIX) console.log('提示：加 --fix 自动安装可安装项；生成文档用默认运行或 --force 覆盖。');
process.exit(warn > 0 ? 1 : 0);
