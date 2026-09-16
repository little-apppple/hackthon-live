import React, { useEffect, useRef, useState } from 'react';
import Fireworks from './Fireworks.jsx';

// 通知中心：把实时事件变成「逐一串行」显示的气泡
// - 最终提交（submission）：全屏烟花 + 居中大气泡（2 秒）
// - 阶段完成（1-7 节点 / 迭代）：底部短气泡（3.5 秒）
// - 多个通知排队，一个播完再播下一个；首次加载不补播历史事件
const STAGE_LABEL = {
  requirements: '需求分析',
  design: '方案设计',
  prototype: '原型设计',
  coding: '代码开发',
  testing: '本地测试',
  deployment: '上线部署',
  acceptance: '线上验收',
  submission: '最终提交',
  loop: '迭代重启',
};

const bubbleDuration = (type) => (type === 'submit' ? 2000 : 3500);

export default function NotificationCenter({ events, stages, demoCelebrate }) {
  const lastSeenRef = useRef(null);
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [fireworksKey, setFireworksKey] = useState(0);
  const timerRef = useRef(0);
  const demoDone = useRef(false);
  const totalStages = (stages && stages.length) || 8;

  // 彩排模式（URL 带 ?celebrate=1）：加载后自动演示一次提交庆祝，便于现场演练与验收
  useEffect(() => {
    if (!demoCelebrate || demoDone.current) return;
    demoDone.current = true;
    setCurrent({
      key: 'demo',
      type: 'submit',
      project: '彩排演示项目',
      department: '演示部门',
      group: '演示小组',
      text: '正式提交 · 定格为参赛评分作品',
    });
    setFireworksKey((k) => k + 1);
    const t = setTimeout(() => setCurrent(null), bubbleDuration('submit'));
    return () => clearTimeout(t);
  }, [demoCelebrate]);

  // 收集新事件（跳过首次加载的历史：只播挂载之后发生的）
  useEffect(() => {
    if (!events || events.length === 0) return;
    const maxId = Math.max(...events.map((e) => e.id));
    if (lastSeenRef.current === null) {
      lastSeenRef.current = maxId;
      return;
    }
    const fresh = events
      .filter((e) => e.id > lastSeenRef.current && e.ok)
      .sort((a, b) => a.id - b.id);
    lastSeenRef.current = maxId;
    if (fresh.length === 0) return;

    const items = fresh
      .filter((e) => e.stage !== 'register') // 注册是报名噪音，不打扰大屏
      .map((e) => {
        if (e.stage === 'submission') {
          return { key: `ev-${e.id}`, type: 'submit', project: e.project, department: e.department, group: e.grp, text: '正式提交 · 定格为参赛评分作品' };
        }
        if (e.stage === 'loop') {
          return { key: `ev-${e.id}`, type: 'info', project: e.project, department: e.department, group: e.grp, text: '开启新一轮迭代' };
        }
        const idx = (stages || []).findIndex((s) => s.id === e.stage);
        const label = STAGE_LABEL[e.stage] || e.stage;
        return {
          key: `ev-${e.id}`,
          type: 'stage',
          project: e.project,
          department: e.department,
          group: e.grp,
          text: idx >= 0 ? `完成「${label}」(${idx + 1}/${totalStages})` : `完成「${label}」`,
        };
      });
    if (items.length) {
      // 最终提交是全场最高光：立即插队播放（不被前面的阶段气泡阻塞），烟花同步触发
      const submit = items.find((i) => i.type === 'submit');
      if (submit) {
        setQueue((q) => [...items.filter((i) => i !== submit), ...q]);
        setCurrent(submit);
        setFireworksKey((k) => k + 1);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCurrent(null), bubbleDuration('submit'));
      } else {
        setQueue((q) => [...q, ...items]);
      }
    }
  }, [events, stages, totalStages]);

  // 串行播放：当前气泡到期后取下一个（队列较长时缩短单条时长，避免通知越积越滞后）
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setCurrent(next);
    const dur = next.type === 'submit' ? bubbleDuration('submit') : queue.length > 5 ? 2200 : bubbleDuration(next.type);
    timerRef.current = setTimeout(() => setCurrent(null), dur);
    return () => clearTimeout(timerRef.current);
  }, [queue, current]);

  return (
    <>
      {fireworksKey > 0 && <Fireworks key={fireworksKey} active />}
      {current && (
        <div className={`notice notice-${current.type}`} key={current.key} role="status">
          <div className="notice-main">
            <span className="notice-tag">{current.type === 'submit' ? 'SUBMITTED' : current.type === 'info' ? 'LOOP' : 'STAGE CLEAR'}</span>
            <span className="notice-project">{current.project}</span>
            <span className="notice-text">{current.text}</span>
          </div>
          <div className="notice-meta">
            {current.department} · {current.group}
          </div>
        </div>
      )}
    </>
  );
}
