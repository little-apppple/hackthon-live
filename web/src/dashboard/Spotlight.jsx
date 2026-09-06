import React, { useEffect, useState } from 'react';

// loading 项目高亮轮播：每 4 秒切换一个等待启动的项目
export default function Spotlight({ loadingProjects }) {
  const [idx, setIdx] = useState(0);
  const items = loadingProjects || [];

  useEffect(() => {
    if (items.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 4000);
    return () => clearInterval(t);
  }, [items.length]);

  useEffect(() => {
    if (idx >= items.length) setIdx(0);
  }, [items.length, idx]);

  return (
    <section className="spotlight">
      <div className="panel-title">
        <span>新项目 · 等待启动</span>
        <span className="panel-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="spotlight-empty">暂无 loading 项目</div>
      ) : (
        <>
          <div className="spotlight-card">
            <div className="spotlight-loading">
              <span className="loader" />
            </div>
            <div className="spotlight-info">
              <div className="spotlight-name">{items[idx]?.name}</div>
              <div className="spotlight-meta">
                {items[idx]?.department} · {items[idx]?.group}
              </div>
              <div className="spotlight-meta dim">端口 {items[idx]?.port} 已预留 · 等待首次上报</div>
            </div>
          </div>
          {items.length > 1 && (
            <div className="spotlight-dots">
              {items.map((_, i) => (
                <span key={i} className={`sdot ${i === idx ? 'on' : ''}`} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
