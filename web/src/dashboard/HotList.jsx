import React from 'react';

// 人气榜：按去重后的点击量（人气值）排序
export default function HotList({ items, totalHits }) {
  const list = items || [];
  const max = Math.max(1, ...list.map((p) => p.hits || 0));
  return (
    <div className="hot-panel">
      <div className="panel-title">
        人气榜
        <span className="panel-count" title="全部项目人气合计">
          {totalHits ?? list.reduce((s, p) => s + (p.hits || 0), 0)}
        </span>
      </div>
      <div className="hot-list">
        {list.length === 0 && <div className="hot-empty">还没有点击 · 评委点开作品即产生人气</div>}
        {list.map((p, i) => (
          <div className="hot-item" key={p.projectId}>
            <span className="hot-rank">{String(i + 1).padStart(2, '0')}</span>
            <div className="hot-info">
              <div className="hot-name" title={`${p.department} · ${p.grp}`}>
                {p.name}
              </div>
              <div className="hot-bar">
                <div className="hot-bar-fill" style={{ width: `${Math.round(((p.hits || 0) / max) * 100)}%` }} />
              </div>
            </div>
            <span className="hot-count">{p.hits || 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
