import React, { useEffect, useRef, useState } from 'react';

// 全屏烟花特效（提交作品时触发）：Canvas 粒子，零依赖
// 主题配色沿用 SIGNAL LOST：铁锈红 / 白 / 浅灰；播放结束自动卸载画布
const COLORS = ['#c23b22', '#e85a3a', '#ffffff', '#e8e8e8', '#c8c8c8'];

export default function Fireworks({ active }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 大屏以 1920x1080 逻辑坐标绘制，外层 Scale 负责缩放
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const particles = [];
    const bursts = [];
    const start = performance.now();
    const DURATION = 4600;

    const spawnBurst = (x, y) => {
      const count = reduceMotion ? 0 : 70 + Math.floor(Math.random() * 40);
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.12;
        const speed = 2.2 + Math.random() * 5.4;
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 0.008 + Math.random() * 0.012,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          size: 1.4 + Math.random() * 2.2,
        });
      }
    };

    // 若干次爆发：底部中央发射，随后随机散开
    const schedule = [
      { t: 0, x: 960, y: 720 },
      { t: 260, x: 560, y: 520 },
      { t: 420, x: 1380, y: 560 },
      { t: 900, x: 780, y: 340 },
      { t: 1150, x: 1180, y: 380 },
      { t: 1800, x: 960, y: 500 },
      { t: 2400, x: 640, y: 620 },
      { t: 2600, x: 1300, y: 600 },
    ];

    const frame = (now) => {
      const elapsed = now - start;
      for (const s of schedule) {
        if (elapsed >= s.t && !s.done) {
          s.done = true;
          bursts.push({ x: s.x, y: s.y });
          spawnBurst(s.x, s.y);
        }
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.035; // 重力
        p.vx *= 0.988;
        p.vy *= 0.988;
        p.life -= p.decay;
        if (p.life <= 0.02) {
          particles.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.4, p.size * p.life), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      // 硬截止：到点即清屏并卸载，不被残留粒子无限续命
      if (elapsed < DURATION) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        setDone(true);
      }
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  if (!active || done) return null;
  return <canvas ref={canvasRef} className="fireworks" aria-hidden="true" />;
}
