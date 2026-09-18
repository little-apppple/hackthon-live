import React from 'react';
import { useNavigate } from 'react-router-dom';
import * as echarts from 'echarts';
import ZsjkShell, { ZsjkBoot } from './ZsjkShell.jsx';
import { useSnapshot } from '../useSnapshot.js';
import { aggregateIslands } from './model.js';

// 作战地图：标题(150) + 岛院卡 3 列(488) + 三图(254)，预算 150+24+488+24+254+ticker76 = 1016
// 右上角「实时同步」开关：localStorage 持久化；关闭 → 岛卡/图表置灰、ticker 停止

const SYNC_KEY = 'zk-map-sync';

export default function MapPage() {
  const { snapshot } = useSnapshot();
  const navigate = useNavigate();
  const [syncOn, setSyncOn] = React.useState(() => localStorage.getItem(SYNC_KEY) !== '0');
  React.useEffect(() => {
    localStorage.setItem(SYNC_KEY, syncOn ? '1' : '0');
  }, [syncOn]);

  if (!snapshot) return <ZsjkBoot />;
  const islands = aggregateIslands(snapshot.departments);
  const totalProjects = islands.reduce((s, i) => s + i.projectCount, 0);

  return (
    <ZsjkShell snapshot={snapshot} syncOn={syncOn} dimmable>
      <div className="zk-map-title">
        <button
          className="zk-sync"
          onClick={() => setSyncOn((v) => !v)}
          title={syncOn ? '点击暂停实时同步' : '点击恢复实时同步'}
        >
          实时同步
          <span className={`zk-switch ${syncOn ? 'on' : ''}`}>
            <i />
          </span>
        </button>
        <div className="zk-map-title-row">
          <span className="zk-rowline" />
          <span className="zk-art">作战地图</span>
          <span className="zk-rowline r" />
        </div>
        <div className="zk-map-sub">
          <b>{islands.length}</b> 座岛院 · <b>{totalProjects}</b> 个立项 · 数据实时同步
        </div>
      </div>

      <div className={`zk-islands zk-dimmable ${syncOn ? 'on' : ''}`} key={syncOn ? 'on' : 'off'}>
        {islands.map((island, i) => (
          <div
            className="zk-island"
            key={island.id}
            style={{ '--i': i }}
            onClick={() => navigate(`/zsjk/island?unit=${island.id}`)}
            title="点击进入岛屿详情"
          >
            <div className="zk-island-name">{island.name}</div>
            <div className="zk-island-nums">
              <div>
                <span className="zk-mlabel">立项数</span>
                <span className="zk-inum">
                  {island.projectCount}
                  <small> 个</small>
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="zk-mlabel">进度值</span>
                <span className={`zk-inum ${island.progress >= 100 ? 'is-red' : ''}`}>
                  {island.progress}
                  <small>%</small>
                </span>
              </div>
            </div>
            <div className="zk-island-bar">
              <i style={{ width: `${island.progress}%` }} />
            </div>
            <div className="zk-island-hits">
              🔥 人气值
              <b>{island.hits}</b>
            </div>
          </div>
        ))}
      </div>

      <div className="zk-charts zk-dimmable">
        <div className="zk-chart">
          <IslandChart title="立项数" unit=" 个" islands={islands} field="projectCount" red />
        </div>
        <div className="zk-chart">
          <IslandChart title="进度值（加权）" unit="%" islands={islands} field="progress" max={100} />
        </div>
        <div className="zk-chart">
          <IslandChart title="实时人气值 · 按项目汇总" unit="" islands={islands} field="hits" red />
        </div>
      </div>
    </ZsjkShell>
  );
}

// 三图同横轴同序（岛院序）；柱宽 ≤54、4 条网格线、柱顶数值标签
function IslandChart({ title, islands, field, unit, max, red }) {
  const ref = React.useRef(null);
  const chartRef = React.useRef(null);
  const cats = islands.map((i) => i.name);
  const values = islands.map((i) => i[field]);

  React.useEffect(() => {
    chartRef.current = echarts.init(ref.current);
    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption({
      grid: { left: 6, right: 6, top: 30, bottom: 2, containLabel: true },
      tooltip: { show: false },
      xAxis: {
        type: 'category',
        data: cats,
        axisLine: { lineStyle: { color: 'rgba(200,200,200,0.25)' } },
        axisTick: { show: false },
        axisLabel: { color: '#7a7a7a', fontSize: 13, interval: 0, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        max: max ?? null,
        splitNumber: 4,
        minInterval: 1,
        axisLabel: { show: false },
        splitLine: { lineStyle: { color: 'rgba(200,200,200,0.08)' } },
      },
      series: [
        {
          type: 'bar',
          data: values,
          barMaxWidth: 54,
          itemStyle: {
            borderRadius: [2, 2, 0, 0],
            color: red
              ? new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: '#e85a3a' },
                  { offset: 1, color: 'rgba(194,59,34,0.25)' },
                ])
              : new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: 'rgba(232,90,58,0.75)' },
                  { offset: 1, color: 'rgba(200,200,200,0.12)' },
                ]),
          },
          label: { show: true, position: 'top', color: '#e8e8e8', fontSize: 13, formatter: `{c}${unit}` },
        },
      ],
      animationDurationUpdate: 400,
    });
  }, [cats.join('|'), values.join('|'), unit, max, red]);

  return (
    <>
      <div className="zk-card-title">{title}</div>
      <div className="zk-chart-body" ref={ref} />
    </>
  );
}
