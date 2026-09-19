import React from 'react';

// 全局事件滚动条：[实时动态标签固定] + [视口 flex:1 两端 5% 渐隐] + [连接状态/管理入口]
// 无缝循环：轨道渲染 K 份内容、位移 -100%/K（等于一份宽度）；K 按「单份宽度 ≥ 视口」动态放大，
// 事件很少（开局/彩排）时也能铺满视口、不留空档。无事件时占位符静态展示（不进动画轨道）
const STAGE_NAMES = {
  requirements: '需求分析', design: '方案设计', prototype: '原型设计', coding: '代码开发',
  testing: '本地测试', deployment: '上线部署', acceptance: '线上验收', submission: '最终提交',
  register: '自助注册', loop: '迭代重启',
};

function timeStr(ts) {
  const m = String(ts || '').match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : '';
}

function evText(e) {
  const who = `${e.department} · ${e.grp} · ${e.project}`;
  return e.ok ? `${who} 完成「${STAGE_NAMES[e.stage] || e.stage}」` : `${who} 上报被拒（${e.reject_code}）`;
}

export default function Ticker({ events, running = true, connected = true }) {
  // 快照事件按 id 倒序（最新在前），滚动轨道按时间序播放
  const items = (events || []).slice(0, 30).reverse();
  const [copies, setCopies] = React.useState(2);
  const viewRef = React.useRef(null);
  const trackRef = React.useRef(null);

  // 单份内容宽度不足视口一半时会留空档，按需增大份数（上限 12 份防异常）
  React.useEffect(() => {
    const measure = () => {
      const view = viewRef.current;
      const track = trackRef.current;
      if (!view || !track || items.length === 0) return;
      const one = track.scrollWidth / copies;
      const vw = view.clientWidth;
      if (!one || !vw) return;
      const need = Math.min(12, Math.max(2, Math.ceil((2 * vw) / one)));
      if (need !== copies) setCopies(need);
    };
    measure();
    const view = viewRef.current;
    if (!view) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    return () => ro.disconnect();
  }, [items.length, copies]);

  const seq = [];
  for (let c = 0; c < copies; c += 1) {
    for (const e of items) seq.push({ e, k: `${e.id}-${c}` });
  }

  return (
    <div className={`zk-ticker ${running ? '' : 'is-paused'}`}>
      <span className="zk-ticker-tag">
        <i className="zk-live-dot" />
        实时动态
      </span>
      <div className="zk-ticker-viewport" ref={viewRef}>
        {items.length === 0 ? (
          <span className="zk-ticker-dim">暂无上报动态 · 等待第一份信号…</span>
        ) : (
          <div
            className="zk-ticker-track"
            ref={trackRef}
            style={{ '--dur': `${Math.max(30, items.length * 5)}s`, '--copies': copies }}
          >
            {seq.map(({ e, k }) => (
              <span className={`zk-ticker-item ${e.ok ? '' : 'tk-reject'}`} key={k}>
                <b className="tk-time">{timeStr(e.created_at)}</b>
                <b>{evText(e)}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="zk-ticker-status" title={connected ? '实时连接正常' : '连接中断，自动重连中'}>
        <i className="zk-live-dot" data-on={connected} />
        <span className={`zk-live-text ${connected ? '' : 'off'}`}>{connected ? 'LIVE' : '信号中断'}</span>
        <a className="zk-admin-link" href="/admin" target="_blank" rel="noreferrer">
          管理后台
        </a>
      </span>
    </div>
  );
}
