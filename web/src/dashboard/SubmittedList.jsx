import React from 'react';

// 已提交作品列表：项目完成最终提交后进入此榜，按提交时间倒序
export default function SubmittedList({ items }) {
  const list = items || [];
  return (
    <div className="submitted-panel">
      <div className="panel-title">
        已提交作品
        <span className="panel-count">{list.length}</span>
      </div>
      <div className="submitted-list">
        {list.length === 0 && <div className="submitted-empty">尚无作品完成最终提交</div>}
        {list.map((p, i) => (
          <div className="submitted-item" key={p.projectId}>
            <span className="submitted-rank">{String(i + 1).padStart(2, '0')}</span>
            <div className="submitted-info">
              <div className="submitted-name" title={p.name}>
                {p.name}
                {(p.loop_count || 1) > 1 && <span className="pc-loop">LOOP×{p.loop_count}</span>}
              </div>
              <div className="submitted-meta">
                {p.department} · {p.grp}
                <span className="submitted-time">{String(p.last_report_at || '').slice(11, 16)}</span>
              </div>
            </div>
            {p.link && (
              <a className="submitted-link" href={p.link} target="_blank" rel="noreferrer" title={p.link}>
                打开
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
