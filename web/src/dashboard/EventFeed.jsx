import React from 'react';

function timeStr(ts) {
  if (!ts) return '';
  const m = ts.match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : ts;
}

export default function EventFeed({ events }) {
  return (
    <section className="event-feed">
      <div className="panel-title">
        <span>实时动态</span>
        <span className="live-tag">LIVE</span>
      </div>
      <div className="feed-list">
        {(!events || events.length === 0) && <div className="feed-empty">暂无上报动态</div>}
        {events.map((e) => (
          <div className={`feed-item ${e.ok ? '' : 'feed-reject'}`} key={e.id}>
            <span className="feed-time">{timeStr(e.created_at)}</span>
            <span className="feed-text">
              <b>{e.department}</b> · {e.grp} · {e.project}
              {e.ok ? (
                <>
                  完成「<i>{stageName(e.stage)}</i>」
                </>
              ) : (
                <span className="feed-reject-text">上报被拒（{e.reject_code}）</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

const STAGE_NAMES = {
  requirements: '需求分析',
  design: '方案设计',
  prototype: '原型设计',
  coding: '代码开发',
  testing: '本地测试',
  deployment: '上线部署',
  acceptance: '线上验收',
};

function stageName(id) {
  return STAGE_NAMES[id] || id;
}
