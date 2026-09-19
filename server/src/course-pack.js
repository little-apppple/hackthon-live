'use strict';
// 课程物料包下载（GET /api/course-pack）：
// 把 hackathon-reporter / vibecoding-workflow / superpowers / agent-browser 打成一整套 tgz，
// 并把上报地址 + 本期注册令牌烘入 skill/hackathon-reporter/server.json——参赛队下载解压即接入。
// 物料源：仓库自带 skill/ 两目录 + course-assets/（superpowers、agent-browser，见 README；缺失则跳过该目录）。
// 缓存：按「注册令牌 + 物料版本」落盘 server/data/ 下，令牌轮换或换缓存文件即重建（删除缓存文件可强制重打）。
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');
const config = require('./config');
const { getActiveEvent } = require('./events');

const router = express.Router();

const ROOT = path.join(__dirname, '..', '..'); // server/src/ → 仓库根
const ASSETS_DIR = process.env.COURSE_ASSETS_DIR || path.join(ROOT, 'course-assets');
const CACHE_DIR = path.dirname(config.dbPath); // server/data/

// 与 routes/admin.js 的 ensureRegisterToken 同键同格式（幂等取当前令牌）
function currentRegisterToken(eventId) {
  const key = `register_token:${eventId}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const token = 'reg_' + crypto.randomBytes(24).toString('base64url');
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, token);
  return token;
}

// 物料清单：dest 为包内路径；assets: true 表示来自 course-assets（可选，缺失跳过）
const MATERIALS = [
  { src: path.join(ROOT, 'skill', 'hackathon-reporter'), dest: 'skill/hackathon-reporter', serverJson: true },
  { src: path.join(ROOT, 'skill', 'vibecoding-workflow'), dest: 'skill/vibecoding-workflow' },
  { src: path.join(ASSETS_DIR, 'superpowers'), dest: 'superpowers', assets: true, label: 'Superpowers 技能集' },
  { src: path.join(ASSETS_DIR, 'agent-browser'), dest: 'agent-browser', assets: true, label: 'Agent Browser CLI' },
];

function buildReadme(serverUrl, included) {
  const lines = [
    `AI创变营 · 课程物料包（已内置上报地址：${serverUrl}）`,
    '',
    '包含物料：',
    '  skill/hackathon-reporter    参赛上报 CLI（--init 自助报名 / --next 驱动流程 / --deploy / --verify）',
    '  skill/vibecoding-workflow   Vibe Coding 开发流程技能（八卡点对齐上报节点）',
  ];
  if (included.has('superpowers')) lines.push('  superpowers/                Superpowers 技能集（brainstorming / TDD / code-review 等）');
  if (included.has('agent-browser')) lines.push('  agent-browser/              Agent Browser CLI（AI 浏览器自动化，含多平台可执行文件）');
  lines.push(
    '',
    '安装步骤：',
    '  1. 解压到参赛项目根目录；',
    '  2. 报名：node skill/hackathon-reporter/scripts/report.js --init',
    '     部门填岛院名、小组填队伍名、项目名自定，自动换取 accessKey（幂等）；',
    '  3. 接入 AI 编程工具：把 skill/ 与 superpowers/ 里需要的技能目录复制（或链接）',
    '     到所用工具的技能目录（如 .claude/skills/）后即可使用；',
  );
  if (included.has('agent-browser')) {
    lines.push(
      '  4. 安装浏览器自动化 CLI：cd agent-browser && npm install -g .',
      '     （要求 Node ≥ 24；装完命令行执行 agent-browser --help 验证）',
    );
  }
  lines.push('  5. 比赛流程：node skill/hackathon-reporter/scripts/report.js --next 按引导推进八节点。');
  return lines.join('\n');
}

let building = null; // 并发下载共用同一次构建
let cacheKey = '';

function buildPack(outFile, serverUrl, token) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'course-pack-'));
    const included = new Set();
    try {
      for (const m of MATERIALS) {
        if (!fs.existsSync(m.src)) {
          if (m.assets) continue; // 可选物料缺失：跳过并在说明中反映
          throw new Error(`物料缺失：${m.src}`);
        }
        fs.cpSync(m.src, path.join(tmp, m.dest), { recursive: true });
        included.add(m.dest.split('/')[0]);
      }
      fs.writeFileSync(
        path.join(tmp, 'skill', 'hackathon-reporter', 'server.json'),
        JSON.stringify({ serverUrl, registerToken: token, packedAt: new Date().toISOString() }, null, 2) + '\n'
      );
      fs.writeFileSync(path.join(tmp, '安装说明.txt'), buildReadme(serverUrl, included));
      // tar 输出到 stdout 再落盘：Windows 盘符绝对路径会被 GNU tar 当作远程主机（与 pack-skills.js 同坑）
      // encoding:'buffer'——stdout 是二进制 gzip 流，默认 utf8 解码会损坏数据
      execFile(
        'tar',
        ['-czf', '-', '-C', tmp, '.'],
        { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
        (err, stdout) => {
          fs.rmSync(tmp, { recursive: true, force: true });
          if (err) return reject(err);
          fs.writeFileSync(outFile, stdout);
          resolve(included);
        }
      );
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      reject(e);
    }
  });
}

router.get('/course-pack', async (req, res, next) => {
  try {
    const eventId = getActiveEvent().id;
    const token = currentRegisterToken(eventId);
    const tokenHash = crypto.createHash('sha1').update(token).digest('hex').slice(0, 10);
    const assetsStamp = fs.existsSync(ASSETS_DIR)
      ? String(fs.statSync(ASSETS_DIR).mtimeMs)
      : 'none';
    const key = `${tokenHash}:${crypto.createHash('sha1').update(assetsStamp).digest('hex').slice(0, 8)}`;
    const outFile = path.join(CACHE_DIR, `course-pack-${key}.tgz`);

    if (!fs.existsSync(outFile) || cacheKey !== key) {
      if (!building) {
        cacheKey = key;
        const serverUrl = `http://${config.publicHost}:${config.port}`;
        building = buildPack(outFile, serverUrl, token).finally(() => {
          building = null;
        });
      }
      await building;
    }
    res.download(outFile, 'ai-camp-course-pack.tgz');
  } catch (e) {
    next(e);
  }
});

module.exports = router;
