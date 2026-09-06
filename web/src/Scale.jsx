import React, { useEffect, useState } from 'react';

// 大屏按 1920×1080 设计，等比缩放适配任意分辨率
export default function Scale({ children }) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <div className="viewport">
      <div className="screen" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
