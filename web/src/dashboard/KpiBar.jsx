import React, { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';

// 数值变化时跳动一下（现场远距离也能感知到"数字变了"）
function useBump(value) {
  const prev = useRef(value);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setBump(true);
      const t = setTimeout(() => setBump(false), 600);
      return () => clearTimeout(t);
    }
  }, [value]);
  return bump;
}

function Stat({ label, value, tone, sub }) {
  const bump = useBump(value);
  return (
    <div className={`kpi-card tone-${tone}`}>
      <div className={`kpi-value ${bump ? 'bump' : ''}`}>{value}</div>
      <div className="kpi-label">
        {label}
        {sub && <span className="kpi-sub">{sub}</span>}
      </div>
    </div>
  );
}

export default function KpiBar({ kpi }) {
  const ringRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ringRef.current) return;
    if (!chartRef.current) {
      chartRef.current = echarts.init(ringRef.current, null, { renderer: 'canvas' });
    }
    chartRef.current.setOption({
      series: [
        {
          type: 'gauge',
          startAngle: 90,
          endAngle: -270,
          radius: '100%',
          pointer: { show: false },
          progress: { show: true, overlap: false, roundCap: true, clip: false, itemStyle: { color: '#c23b22', shadowColor: 'rgba(194, 59, 34, 0.6)', shadowBlur: 10 } },
          axisLine: { lineStyle: { width: 10, color: [[1, 'rgba(200, 200, 200, 0.12)']] } },
          splitLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          title: { show: false },
          detail: {
            valueAnimation: true,
            fontSize: 22,
            offsetCenter: [0, 0],
            formatter: '{value}%',
            color: '#e8e8e8',
            fontFamily: 'Courier New, monospace',
          },
          data: [{ value: kpi.completion, name: 'completion' }],
        },
      ],
    });
    const onResize = () => chartRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [kpi.completion]);

  return (
    <section className="kpi-bar">
      <Stat label="参赛部门" value={kpi.departments} tone="cyan" />
      <Stat label="参赛小组" value={kpi.groups} tone="blue" />
      <Stat label="参赛项目" value={kpi.projects} tone="violet" />
      {/* 主指标：能玩了（已上线）/ 定稿（已提交）；验收完成作为副文案，避免三档口径混淆 */}
      <Stat label="已上线" value={kpi.deployed} tone="green" sub={kpi.projects ? `能玩了 · 占比 ${Math.round((kpi.deployed / kpi.projects) * 100)}%` : ''} />
      <Stat
        label="已提交"
        value={kpi.submitted ?? 0}
        tone="gold"
        sub={kpi.projects ? `定稿 · 占比 ${Math.round(((kpi.submitted ?? 0) / kpi.projects) * 100)}%${kpi.done ? ` · 验收通过 ${kpi.done}` : ''}` : ''}
      />
      <div className="kpi-ring-card">
        <div ref={ringRef} className="kpi-ring" />
        <div className="kpi-ring-label">整体完成率</div>
      </div>
    </section>
  );
}
