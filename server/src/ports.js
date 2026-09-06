'use strict';
const net = require('net');
const db = require('./db');
const config = require('./config');

// 当前端口区间：后台可调（settings 表持久化），环境变量仅作首次默认值
function getPoolRange() {
  let start = null;
  let end = null;
  try {
    const s = db.prepare("SELECT value FROM settings WHERE key = 'pool_start'").get();
    const e = db.prepare("SELECT value FROM settings WHERE key = 'pool_end'").get();
    if (s) start = Number(s.value);
    if (e) end = Number(e.value);
  } catch {
    /* settings 未就绪时退回环境变量默认值 */
  }
  if (!Number.isInteger(start) || start <= 0) start = config.portPoolStart;
  if (!Number.isInteger(end) || end <= 0) end = config.portPoolEnd;
  return { start, end };
}

function setPoolRange(start, end) {
  db.transaction(() => {
    for (const [k, v] of [
      ['pool_start', String(start)],
      ['pool_end', String(end)],
    ]) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(k, v);
    }
  })();
}

// 试绑定探测端口是否未被系统占用
function probePortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

// 分配一个「未被其他项目预留（未归档的）且本机未被占用」的端口。
// 探测在事务外完成；真正写入靠 projects.port 唯一约束兜底并发，冲突则换下一个重试。
async function allocatePort() {
  const { start, end } = getPoolRange();
  const used = new Set(
    db.prepare('SELECT port FROM projects WHERE archived = 0').all().map((r) => r.port)
  );
  const candidates = [];
  for (let p = start; p <= end; p++) {
    if (!used.has(p)) candidates.push(p);
  }
  if (candidates.length === 0) {
    const err = new Error(`端口池 ${start}-${end} 已全部分配完毕`);
    err.code = 'NO_FREE_PORT';
    throw err;
  }
  for (const port of candidates) {
    if (await probePortFree(port)) return port;
  }
  const err = new Error('端口池中所有空闲端口均被系统占用，请调整端口区间');
  err.code = 'NO_FREE_PORT';
  throw err;
}

// 探测本机端口是否已有 HTTP 服务响应（用于「上线部署」节点的服务端软校验）
async function probeLocalPort(port) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
        redirect: 'manual',
      });
      return { ok: true, httpStatus: res.status };
    } catch {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  return { ok: false, error: '端口无 HTTP 响应' };
}

function poolSummary() {
  const { start, end } = getPoolRange();
  const rows = db
    .prepare(
      `SELECT p.port, p.id AS project_id, p.name AS project_name, p.revoked, p.archived,
              d.name AS department, g.name AS grp, e.name AS event_name
         FROM projects p
         JOIN groups g ON g.id = p.group_id
         JOIN departments d ON d.id = g.department_id
         JOIN events e ON e.id = p.event_id
        WHERE p.archived = 0
        ORDER BY p.port`
    )
    .all();
  return {
    start,
    end,
    total: end - start + 1,
    used: rows.length,
    free: end - start + 1 - rows.length,
    allocations: rows,
  };
}

module.exports = { allocatePort, poolSummary, probePortFree, probeLocalPort, getPoolRange, setPoolRange };
