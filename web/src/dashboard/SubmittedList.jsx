import React from 'react';

// 已提交作品列表：项目完成最终提交后进入此榜，按提交时间倒序
export default function SubmittedList({ items, onOpenDetail }) {
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
          <div className="submitted-item" key={p.projectId} onClick={() => onOpenDetail && onOpenDetail(p)} title="点击查看项目详情">
            <span className="submitted-rank">{String(i + 1).padStart(2, '0')}</span>
            <div className="submitted-info">
              <div className="submitted-name" title={p.name}>
                {p.name}
                {(p.loop_count || 1) > 1 && <span className="pc-loop">LOOP×{p.loop_count}</span>}
              </div>
              <div className="submitted-meta">
                {p.department} · {p.grp}
                <span className="submitted-time">{String(p.last_report_at || '').slice(11, 16)}</span>
                {typeof p.hits === 'number' && p.hits > 0 && <span className="submitted-hits">人气 {p.hits}</span>}
                {typeof p.ai_score === 'number' && (
                  <span className="submitted-score" title="AI 参考分（机器可判定 85 分 + 主观项 15 分待评委评审）">
                    AI {p.ai_score}
                  </span>
                )}
              </div>
            </div>
            {(p.artifactUrl || p.link) && (
              <a
                className="submitted-link"
                href={`/api/hit/go?projectId=${p.projectId}`}
                target="_blank"
                rel="noreferrer"
                title={p.artifactUrl || p.link}
                onClick={(e) => e.stopPropagation()}
              >
                {p.deliverable === 'package' ? '下载' : '打开'}
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
