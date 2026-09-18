// 人气上报：终端标识存 localStorage（同一终端对同一项目 60 秒内只计一次）
const TERMINAL_KEY = 'hk_terminal_id';
export function terminalId() {
  try {
    let v = localStorage.getItem(TERMINAL_KEY);
    if (!v) {
      v = 't_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(TERMINAL_KEY, v);
    }
    return v;
  } catch {
    return '';
  }
}

// 点击「打开项目 / 下载安装包」时调用；失败静默（不影响跳转）
export function reportHit(projectId, kind) {
  try {
    fetch('/api/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, kind, terminal: terminalId() }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 忽略 */
  }
}
