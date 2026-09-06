import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

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
          progress: { show: true, overlap: false, roundCap: true, clip: false, itemStyle: { color: '#22d3ee' } },
          axisLine: { lineStyle: { width: 10, color: [[1, 'rgba(148,163,184,0.18)']] } },
          splitLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          title: { show: false },
          detail: {
            valueAnimation: true,
            fontSize: 22,
            offsetCenter: [0, 0],
            formatter: '{value}%',
            color: '#e2f6ff',
            fontFamily: 'Consolas, monospace',
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
      <Stat label="已部署上线" value={kpi.deployed} tone="green" sub={kpi.projects ? `占比 ${Math.round((kpi.deployed / kpi.projects) * 100)}%` : ''} />
      <Stat label="验收完成" value={kpi.done} tone="gold" sub={kpi.projects ? `占比 ${Math.round((kpi.done / kpi.projects) * 100)}%` : ''} />
      <div className="kpi-ring-card">
        <div ref={ringRef} className="kpi-ring" />
        <div className="kpi-ring-label">整体完成率</div>
      </div>
    </section>
  );
}

function Stat({ label, value, tone, sub }) {
  return (
    <div className={`kpi-card tone-${tone}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">
        {label}
        {sub && <span className="kpi-sub">{sub}</span>}
      </div>
    </div>
  );
}
