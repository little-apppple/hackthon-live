'use strict';
// 部署管理器：接收构建产物 → 解压 → （可选）装依赖 → 启动到预留端口 → 探活 → 崩溃自动重启
// 目录布局：deployRoot/<projectId>/{app/(产物), meta.json(部署配置), app.log(运行日志)}
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const db = require('./db');
const config = require('./config');
const { probeLocalPort } = require('./ports');
const { getActiveEvent } = require('./events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const states = new Map(); // projectId -> {status, desired, proc, staticServer, pid, restarts, startedAt, lastExit, lastDeployAt, meta}

function appRoot(projectId) {
  return path.join(config.deployRoot, String(projectId));
}
function logPath(projectId) {
  return path.join(appRoot(projectId), 'app.log');
}

function ensureState(project) {
  let s = states.get(project.id);
  if (!s) {
    s = {
      projectId: project.id,
      projectName: project.name,
      port: project.port,
      status: 'stopped', // starting|running|stopped|crashed|failed
      desired: 'running', // 运行期望：stopped 后崩溃不再自动拉起
      proc: null,
      staticServer: null,
      pid: null,
      restarts: 0,
      startedAt: null,
      lastExit: null,
      lastDeployAt: null,
      meta: null,
    };
    states.set(project.id, s);
  }
  return s;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* 进程可能已退出 */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
}

function appendLog(projectId, text) {
  try {
    fs.mkdirSync(appRoot(projectId), { recursive: true });
    fs.appendFileSync(logPath(projectId), text);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function logTail(projectId, bytes = 4096) {
  try {
    const st = fs.statSync(logPath(projectId));
    const size = Math.min(bytes, st.size);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(logPath(projectId), 'r');
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

// ---------- 启动器 ----------

function childEnv(project) {
  const extraPath = config.deployPathPrepend ? config.deployPathPrepend + ':' : '';
  return { ...process.env, PORT: String(project.port), HOST: '0.0.0.0', PATH: extraPath + process.env.PATH };
}

function startNodeApp(project, meta, state) {
  const dir = path.join(appRoot(project.id), 'app', meta.dir || '');
  if (!fs.existsSync(dir)) {
    state.status = 'failed';
    return;
  }
  const log = fs.createWriteStream(logPath(project.id), { flags: 'a' });
  log.write(`\n--- [${new Date().toISOString()}] 启动: ${meta.start} (PORT=${project.port}) ---\n`);
  const child = spawn(meta.start, {
    shell: true,
    cwd: dir,
    env: childEnv(project),
    detached: process.platform !== 'win32', // POSIX 下负 PID 杀进程树
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.proc = child;
  state.pid = child.pid;
  state.status = 'starting';
  child.stdout.on('data', (d) => log.write(d));
  child.stderr.on('data', (d) => log.write(d));
  child.on('exit', (code, signal) => {
    log.end(`--- [${new Date().toISOString()}] 退出 code=${code} signal=${signal} ---\n`);
    if (state.proc !== child) return; // 已被新实例取代
    state.proc = null;
    state.pid = null;
    state.lastExit = code;
    if (state.desired === 'running') {
      state.status = 'crashed';
      state.restarts += 1;
      if (state.restarts <= 10) {
        appendLog(project.id, `[deployer] 崩溃自动重启（第 ${state.restarts} 次）\n`);
        setTimeout(() => {
          const s = states.get(project.id);
          if (s && s.desired === 'running' && !s.proc) startByType(project, meta, s);
        }, 2000);
      } else {
        state.status = 'failed';
      }
    } else {
      state.status = 'stopped';
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
};

function startStaticServer(project, meta, state) {
  const root = path.join(appRoot(project.id), 'app', meta.dir || '');
  if (!fs.existsSync(root)) {
    state.status = 'failed';
    return;
  }
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.normalize(path.join(root, p));
      if (!file.startsWith(path.normalize(root))) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        // SPA 兜底到 index.html
        const index = path.join(root, 'index.html');
        if (fs.existsSync(index)) file = index;
        else {
          res.writeHead(404);
          return res.end('Not Found');
        }
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500);
      res.end('Error');
    }
  });
  state.staticServer = server;
  server.listen(project.port, '0.0.0.0', () => {
    state.status = 'running';
    state.startedAt = Date.now();
  });
  server.on('error', (e) => {
    appendLog(project.id, `[deployer] 静态服务监听失败: ${e.message}\n`);
    state.status = 'failed';
  });
}

function startByType(project, meta, state) {
  state.meta = meta;
  if (meta.type === 'static') startStaticServer(project, meta, state);
  else startNodeApp(project, meta, state);
}

// 清理端口上的残留监听进程（上一代服务被强杀时部署应用可能变成孤儿进程）
function killPortListener(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr ":${port} " | findstr LISTENING`, {
        shell: true,
        encoding: 'utf-8',
      });
      for (const line of out.split(/\r?\n/)) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) killTree(pid);
      }
    } else {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
    }
  } catch {
    /* 无监听进程 */
  }
}

// 启动并等待探活通过
async function startAndProbe(project, meta, state) {
  state.desired = 'running';
  state.status = 'starting';
  if (!state.proc && !state.staticServer) killPortListener(project.port);
  startByType(project, meta, state);
  const deadline = Date.now() + config.deployStartTimeoutMs;
  let probe = null;
  while (Date.now() < deadline) {
    if (state.status === 'crashed' && !state.proc) break;
    if (state.status === 'failed') break;
    probe = await probeLocalPort(project.port);
    if (probe.ok) break;
    await sleep(900);
  }
  if (!probe || !probe.ok) {
    await stopProcess(state);
    state.status = 'failed';
    return { ok: false, error: `启动超时（${Math.round(config.deployStartTimeoutMs / 1000)}s）或探活失败，应用可能启动出错` };
  }
  state.status = 'running';
  state.startedAt = Date.now();
  return { ok: true, probe };
}

// ---------- 对外操作 ----------

async function stopProcess(state) {
  state.desired = 'stopped';
  if (state.proc) {
    killTree(state.proc.pid);
    state.proc = null;
    state.pid = null;
  }
  if (state.staticServer) {
    await new Promise((r) => state.staticServer.close(r));
    state.staticServer = null;
  }
}

async function deployProject(project, opts, archiveBuffer) {
  const root = appRoot(project.id);
  const appDir = path.join(root, 'app');
  fs.mkdirSync(root, { recursive: true });

  // 1. 停掉旧实例（Windows 下运行中的文件可能被锁）
  const old = states.get(project.id);
  if (old) await stopProcess(old);
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(appDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
  fs.mkdirSync(appDir, { recursive: true });

  // 2. 写包解压（tar 相对路径 + cwd，规避 Windows 盘符路径被 GNU tar 当作远程主机）
  const tmp = path.join(root, 'upload.bin');
  fs.writeFileSync(tmp, archiveBuffer);
  try {
    execSync('tar -xf ../upload.bin', { cwd: appDir, timeout: 120000, stdio: 'ignore' });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: '解压失败：' + e.message };
  }
  fs.rmSync(tmp, { force: true });

  const meta = {
    type: opts.type,
    start: opts.start || '',
    dir: opts.dir || '',
    install: !!opts.install,
    port: project.port,
    projectName: project.name,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify(meta, null, 2));

  const state = ensureState(project);
  state.restarts = 0;
  state.lastDeployAt = meta.deployedAt;
  state.meta = meta;
  appendLog(project.id, `\n=== [${meta.deployedAt}] 收到新部署 (type=${meta.type} start=${meta.start || '-'} install=${meta.install}) ===\n`);

  // 3. 依赖安装
  if (opts.install && opts.type === 'node') {
    try {
      const out = execSync('npm install --omit=dev --no-audit --no-fund', {
        cwd: appDir,
        timeout: 300000,
        encoding: 'utf-8',
        env: childEnv(project),
      });
      appendLog(project.id, out);
    } catch (e) {
      appendLog(project.id, String(e.stderr || e.message));
      state.status = 'failed';
      return { ok: false, error: '依赖安装失败（npm install）', logTail: logTail(project.id) };
    }
  }

  // 4. 启动 + 探活
  const result = await startAndProbe(project, meta, state);
  if (!result.ok) result.logTail = logTail(project.id);
  return result;
}

async function restartProject(projectId) {
  const root = appRoot(projectId);
  const metaPath = path.join(root, 'meta.json');
  if (!fs.existsSync(metaPath)) return { ok: false, error: '该项目从未部署过' };
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND archived = 0').get(projectId);
  if (!project) return { ok: false, error: '项目不存在或已归档' };
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch {
    return { ok: false, error: '部署元数据损坏，请重新部署' };
  }
  const state = ensureState(project);
  await stopProcess(state);
  state.restarts = 0;
  const r = await startAndProbe(project, meta, state);
  if (!r.ok) r.logTail = logTail(projectId);
  return r;
}

async function stopProject(projectId) {
  const state = states.get(projectId);
  if (!state) return { ok: false, error: '该项目没有运行中的部署' };
  await stopProcess(state);
  state.status = 'stopped';
  return { ok: true };
}

async function startProject(projectId) {
  const metaPath = path.join(appRoot(projectId), 'meta.json');
  if (!fs.existsSync(metaPath)) return { ok: false, error: '该项目从未部署过' };
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND archived = 0').get(projectId);
  if (!project) return { ok: false, error: '项目不存在或已归档' };
  const state = states.get(projectId);
  if (state && (state.proc || state.staticServer)) return { ok: false, error: '部署已在运行中' };
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  return startAndProbe(project, meta, ensureState(project));
}

function getStatus(projectId) {
  const s = states.get(projectId);
  if (!s) return null;
  return {
    projectId: s.projectId,
    projectName: s.projectName,
    port: s.port,
    type: s.meta?.type || null,
    status: s.status,
    pid: s.pid,
    restarts: s.restarts,
    startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    lastExit: s.lastExit,
    lastDeployAt: s.lastDeployAt,
  };
}

function listStatus() {
  return [...states.keys()].map((id) => getStatus(id)).filter(Boolean);
}

// 开机恢复：把之前部署过的项目重新拉起（仅当前活跃活动的项目）
function recoverOnBoot() {
  if (!fs.existsSync(config.deployRoot)) return;
  const active = getActiveEvent();
  for (const name of fs.readdirSync(config.deployRoot)) {
    const metaPath = path.join(config.deployRoot, name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const project = db
        .prepare(
          `SELECT p.* FROM projects p
             JOIN groups g ON g.id = p.group_id
             JOIN departments d ON d.id = g.department_id
            WHERE p.id = ? AND d.event_id = ? AND p.archived = 0`
        )
        .get(Number(name), active.id);
      if (!project) continue;
      const state = ensureState(project);
      state.lastDeployAt = meta.deployedAt;
      killPortListener(project.port); // 防 kill -9 等绕过进程组清理的残留
      startByType(project, meta, state);
      // 异步探活收敛状态（不阻塞其他项目的恢复）
      (async () => {
        const deadline = Date.now() + config.deployStartTimeoutMs;
        while (Date.now() < deadline && state.status === 'starting') {
          const probe = await probeLocalPort(project.port);
          if (probe.ok) {
            state.status = 'running';
            state.startedAt = Date.now();
            return;
          }
          await sleep(1500);
        }
        if (state.status === 'starting') state.status = 'failed';
      })();
      console.log(`[deployer] 已恢复部署：项目 #${project.id}「${project.name}」→ 端口 ${project.port}`);
    } catch (e) {
      console.error(`[deployer] 恢复 ${name} 失败: ${e.message}`);
    }
  }
}

module.exports = { deployProject, restartProject, stopProject, startProject, getStatus, listStatus, recoverOnBoot, logTail };
