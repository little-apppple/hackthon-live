'use strict';
// 课程物料包下载（GET /api/course-pack）：
// 把 hackathon-reporter / vibecoding-workflow / superpowers / agent-browser 打成一整套 tgz，
// 并把上报地址 + 本期注册令牌烘入 skill/hackathon-reporter/server.json——参赛队下载解压即接入。
// 物料源：仓库自带 skill/ 两目录 + course-assets/（superpowers、agent-browser，见 README；缺失则跳过该目录）。
//
// 缓存与并发（评审修复）：
// - 缓存键 = 物料「内容指纹（相对路径+大小+mtime）+ serverUrl + 令牌」哈希；物料或配置一变自动重打
// - 每个键一个在飞 Promise：并发请求共享同一次构建，不会拿到「别人那次」的产物
// - 先写临时文件再 rename 原子替换：下载中的旧文件永不被就地截断
// - 构建失败一律 reject 成 5xx，不让异常冒泡崩掉大屏；构建/下载留审计日志
// - 公开端点按 IP 限频（默认 10 次/分，可配 COURSE_PACK_RATE_PER_MIN）
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
const RATE_PER_MIN = Number(process.env.COURSE_PACK_RATE_PER_MIN) || 10;

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

// 复制时排除的目录（VCS 元数据/依赖）：superpowers 自带 .git，无意义且增大包体
const COPY_SKIP = new Set(['.git', 'node_modules', '.github']);

// 物料内容指纹：遍历文件收集 相对路径+大小+mtime 后哈希（只读元数据，114MB 二进制也很快）
function treeFingerprint(dir, prefix = '') {
  const parts = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (COPY_SKIP.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) parts.push(treeFingerprint(full, rel));
    else {
      const st = fs.statSync(full);
      parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
  }
  return parts.join('\n');
}

function packFingerprint(serverUrl, token) {
  const h = crypto.createHash('sha1');
  for (const m of MATERIALS) {
    if (!fs.existsSync(m.src)) continue;
    h.update(m.dest).update(treeFingerprint(m.src));
  }
  h.update(serverUrl).update(token);
  return h.digest('hex').slice(0, 16);
}

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
  const steps = [
    '解压到参赛项目根目录；',
    '报名：node skill/hackathon-reporter/scripts/report.js --init',
    '  部门填岛院名、小组填队伍名、项目名自定，自动换取 accessKey（幂等）；',
    '接入 AI 编程工具：把 skill/ 与 superpowers/ 里需要的技能目录复制（或链接）到所用工具的技能目录（如 .claude/skills/）；',
  ];
  if (included.has('agent-browser')) {
    steps.push('安装浏览器自动化 CLI：cd agent-browser && npm install -g .（要求 Node ≥ 24；装完 agent-browser --help 验证）；');
  }
  steps.push('比赛流程：node skill/hackathon-reporter/scripts/report.js --next 按引导推进八节点。');
  lines.push('', '安装步骤：');
  steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  return lines.join('\n');
}

// 每键一个在飞构建 Promise；完成后不删除成品文件，仅从表中移除
const inflight = new Map();

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
        fs.cpSync(m.src, path.join(tmp, m.dest), {
          recursive: true,
          filter: (src) => !COPY_SKIP.has(path.basename(src)),
        });
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
          try {
            if (err) throw err;
            // 临时文件 + 原子替换：并发下载中的旧缓存文件绝不被就地截断
            const staging = `${outFile}.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            fs.writeFileSync(staging, stdout);
            fs.renameSync(staging, outFile);
            // 清理其它键的历史缓存，避免 data 目录堆积多份 ~53MB
            try {
              for (const f of fs.readdirSync(CACHE_DIR)) {
                if (f.startsWith('course-pack-') && f.endsWith('.tgz') && path.join(CACHE_DIR, f) !== outFile) {
                  fs.rmSync(path.join(CACHE_DIR, f), { force: true });
                }
              }
            } catch {
              /* 清理失败不影响主流程 */
            }
            resolve(included);
          } catch (e) {
            reject(e);
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        }
      );
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      reject(e);
    }
  });
}

// 公开端点的轻量限频（按 IP，默认 10 次/分）：包体 ~53MB，防止开场同时点击打满出口带宽
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= RATE_PER_MIN) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // 防内存膨胀（IP 基数异常时重置）
  return false;
}

router.get('/course-pack', async (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  try {
    if (rateLimited(ip)) {
      console.warn(`[course-pack] 限频拒绝 ip=${ip}`);
      return res.status(429).json({ ok: false, error: '下载过于频繁，请一分钟后再试' });
    }
    const eventId = getActiveEvent().id;
    const token = currentRegisterToken(eventId);
    const serverUrl = `http://${config.publicHost}:${config.port}`;
    const key = packFingerprint(serverUrl, token);
    const outFile = path.join(CACHE_DIR, `course-pack-${key}.tgz`);

    if (!fs.existsSync(outFile)) {
      let build = inflight.get(key);
      if (!build) {
        console.log(`[course-pack] 开始打包 key=${key} ip=${ip}`);
        build = buildPack(outFile, serverUrl, token)
          .then((included) => console.log(`[course-pack] 打包完成 key=${key} 物料=${[...included].join(',')}`))
          .finally(() => inflight.delete(key));
        inflight.set(key, build);
      }
      await build; // 同键并发共享同一次构建；失败会 reject 到下面统一 500
    }
    if (!fs.existsSync(outFile)) {
      return res.status(503).json({ ok: false, error: '物料包正在生成，请稍后重试' });
    }
    console.log(`[course-pack] 下载 key=${key} ip=${ip}`);
    res.download(outFile, 'ai-camp-course-pack.tgz', (err) => {
      // 下载中途出错（客户端断开/文件被清）：不把 fs 错误透给全局中间件，更不暴露服务器路径
      if (err && !res.headersSent) res.status(503).json({ ok: false, error: '下载失败，请重试' });
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
