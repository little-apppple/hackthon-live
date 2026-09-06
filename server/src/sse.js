'use strict';

// SSE 广播中心：推轻量 refresh 信号，客户端收到后拉取全量快照（保证一致性，避免增量合并 bug）
const clients = new Set();

function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function notifyRefresh(reason) {
  broadcast('refresh', JSON.stringify({ reason, ts: Date.now() }));
}

// 15s 心跳防代理断连
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': hb\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 15000).unref();

module.exports = { handleStream, broadcast, notifyRefresh };
