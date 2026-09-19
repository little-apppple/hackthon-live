import React from 'react';

// 全局事件滚动条：[实时动态标签固定] + [视口 flex:1 两端 5% 渐隐] + [连接状态/管理入口]
// running=false 时暂停（作战地图页受「实时同步」开关控制）；connected=false 时状态灯转灰并提示信号中断
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
  // 快照事件按 id 倒序（最新在前），滚动轨道按时间序播放；复制一份实现无缝循环
  const items = (events || []).slice(0, 30).reverse();
  const seq = items.length > 0 ? [...items, ...items] : [];
  return (
    <div className={`zk-ticker ${running ? '' : 'is-paused'}`}>
      <span className="zk-ticker-tag">
        <i className="zk-live-dot" />
        实时动态
      </span>
      <div className="zk-ticker-viewport">
        <div
          className="zk-ticker-track"
          style={{ '--dur': `${Math.max(30, items.length * 5)}s` }}
        >
          {seq.length === 0 && <span className="zk-ticker-dim">暂无上报动态 · 等待第一份信号…</span>}
          {seq.map((e, i) => (
            <span className={`zk-ticker-item ${e.ok ? '' : 'tk-reject'}`} key={`${e.id}-${i}`}>
              <b className="tk-time">{timeStr(e.created_at)}</b>
              <b>{evText(e)}</b>
            </span>
          ))}
        </div>
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
