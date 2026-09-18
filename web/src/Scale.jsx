import React, { useEffect, useState } from 'react';

// 大屏按 1920×1080 设计：等比缩放适配任意分辨率，非 16:9 视口下水平垂直居中（两侧留黑边）
// 注意 transform 会使 position:fixed 后代（navpill/弹窗遮罩）以本组件为包含块，正是期望行为
export default function Scale({ children }) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    fit();
    window.addEventListener('resize', fit);
    // 兜底：部分嵌入式内核/大屏盒子视口变化不派发 resize 事件，用文档尺寸观察兜住
    const ro = new ResizeObserver(fit);
    ro.observe(document.documentElement);
    return () => {
      window.removeEventListener('resize', fit);
      ro.disconnect();
    };
  }, []);
  return (
    <div className="viewport">
      <div className="screen" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
