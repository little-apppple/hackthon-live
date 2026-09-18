// 人气上报：终端标识存 localStorage（同一终端对同一项目 60 秒内只计一次）
const TERMINAL_KEY = 'hk_terminal_id';
// 可选的手动上报（按钮默认已改走 /api/hit/go 服务端跳转计数，无需 JS）。
// 终端标识由服务端 Cookie 决定（hk_term），这里不再自带 id，避免与 Cookie 口径分叉。
export function reportHit(projectId, kind) {
  try {
    fetch('/api/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, kind }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 忽略 */
  }
}
