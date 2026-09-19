import React from 'react';
import { useNavigate } from 'react-router-dom';
import * as echarts from 'echarts';
import ZsjkShell, { ZsjkBoot } from './ZsjkShell.jsx';
import { useSnapshot } from '../useSnapshot.js';
import HotList from '../dashboard/HotList.jsx';
import { aggregateIslands, groupIslands, orderIslands } from './model.js';

// 作战地图：标题(150) + 岛院卡 3 列(488) + 四图(254)，预算 150+24+488+24+254+ticker76 = 1016
// 每座岛院有独立「点亮」开关（localStorage 持久化，键含活动 id 防止换库/重建后 id 复用串状态）：
//   关 → 该岛卡置灰（四图中同步置灰）；开 → 火焰扫过卡片由灰转亮
const OFF_KEY = 'zk-island-off-';

function readOffMap() {
  const off = {};
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(OFF_KEY)) off[k.slice(OFF_KEY.length)] = localStorage.getItem(k) === '1';
    }
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return off;
}

export default function MapPage() {
  const { snapshot, connected } = useSnapshot();
  const navigate = useNavigate();
  const [offMap, setOffMap] = React.useState(readOffMap);
  const [litTick, setLitTick] = React.useState({}); // 每次点亮 +1：重挂卡片以重放点火动画

  const scopedKey = (id) => `${snapshot?.eventId ?? 0}:${id}`;
  const toggleIsland = (e, id) => {
    e.stopPropagation(); // 不触发岛卡跳转
    const key = scopedKey(id);
    const nowOff = !offMap[key]; // 当前开着 → 点完熄灭；反之点亮
    try {
      localStorage.setItem(OFF_KEY + key, nowOff ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (!nowOff) setLitTick((t) => ({ ...t, [id]: (t[id] || 0) + 1 })); // 点亮时重放火焰
    setOffMap((m) => ({ ...m, [key]: nowOff }));
  };

  if (!snapshot) return <ZsjkBoot />;
  const islands = aggregateIslands(snapshot.departments);
  const islandGroups = groupIslands(islands);
  const orderedIslands = orderIslands(islands); // 三图同横轴同序=发布图固定顺序（名单外岛院殿后）
  const totalProjects = islands.reduce((s, i) => s + i.projectCount, 0);
  const waiting = (snapshot.loadingProjects || []).length;
  const dimNames = orderedIslands.filter((i) => offMap[i.id]).map((i) => i.name);

  const renderIsland = (island, gi, i) => {
    const off = !!offMap[scopedKey(island.id)];
    return (
      <div
        key={`${island.id}:${off ? 'off' : `lit${litTick[island.id] || 0}`}`}
        className={`zk-island ${off ? 'is-off' : 'lit-anim'}`}
        style={{ '--i': gi * 4 + i }}
        onClick={() => navigate(`/zsjk/island?unit=${island.id}`)}
        title={off ? '已熄灭 · 点右侧开关点亮 · 点卡片看详情' : '点击进入岛屿详情'}
      >
        <span className="zk-flame" />
        <div className="zk-island-head">
          <div className="zk-island-name">{island.name}</div>
          <button
            className={`zk-switch mini ${off ? '' : 'on'}`}
            onClick={(e) => toggleIsland(e, island.id)}
            title={off ? '点亮该岛院' : '熄灭该岛院'}
          >
            <i />
          </button>
        </div>
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
    );
  };

  return (
    <ZsjkShell snapshot={snapshot} connected={connected}>
      <div className="zk-map-title">
        <div className="zk-map-title-row">
          <span className="zk-rowline" />
          <span className="zk-art">作战地图</span>
          <span className="zk-rowline r" />
        </div>
        <div className="zk-map-sub">
          <b>{islands.length}</b> 座岛院 · <b>{totalProjects}</b> 个立项 · 已上线{' '}
          <b>{snapshot.kpi.deployed}</b> · 整体完成 <b>{snapshot.kpi.completion}%</b>
          {waiting > 0 && (
            <>
              {' '}
              · 等待启动 <b>{waiting}</b> 队
            </>
          )}{' '}
          · 数据实时同步
        </div>
      </div>

      <div className="zk-island-groups">
        {islandGroups.map((group, gi) => (
          <section className={`zk-island-group ${group.name === '业务岛' ? 'is-biz' : 'is-rest'}`} key={group.name}>
            <div className="zk-group-label">
              {group.name}
              <span>{group.islands.length} 座</span>
            </div>
            <div className={`zk-group-grid ${group.islands.length <= 2 && group.name !== '业务岛' ? 'is-col' : ''}`}>
              {group.islands.map((island, i) => renderIsland(island, gi, i))}
            </div>
          </section>
        ))}
      </div>

      <div className="zk-charts">
        <div className="zk-chart">
          <IslandChart title="立项数" unit=" 个" islands={orderedIslands} field="projectCount" red dimNames={dimNames} />
        </div>
        <div className="zk-chart">
          <IslandChart title="进度值（加权）" unit="%" islands={orderedIslands} field="progress" max={100} dimNames={dimNames} />
        </div>
        <div className="zk-chart">
          <IslandChart title="岛院人气值 · 按项目汇总" unit="" islands={orderedIslands} field="hits" red dimNames={dimNames} />
        </div>
        <div className="zk-chart">
          <div className="zk-card-title">
            项目人气榜 TOP5
            <span className="t-dim">全场合计 {snapshot.kpi.totalHits}</span>
          </div>
          <div className="zk-embed">
            <HotList items={snapshot.hotProjects} totalHits={snapshot.kpi.totalHits} />
          </div>
        </div>
      </div>
    </ZsjkShell>
  );
}

// 三图同横轴同序（岛院序）；柱宽 ≤54、4 条网格线、柱顶数值标签；熄灭岛置灰
function IslandChart({ title, islands, field, unit, max, red, dimNames = [] }) {
  const ref = React.useRef(null);
  const chartRef = React.useRef(null);
  const cats = islands.map((i) => i.name);
  const values = islands.map((i) => i[field]);
  const dimSig = dimNames.join('|');

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
    const dim = new Set(dimNames);
    chart.setOption({
      grid: { left: 6, right: 6, top: 30, bottom: 2, containLabel: true },
      tooltip: { show: false },
      xAxis: {
        type: 'category',
        data: cats,
        axisLine: { lineStyle: { color: 'rgba(200,200,200,0.25)' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#7a7a7a',
          fontSize: 12,
          interval: 0,
          rotate: 22,
          hideOverlap: false,
          formatter: (name) => (dim.has(name) ? `{dim|${name}}` : name),
          rich: { dim: { color: 'rgba(122,122,122,0.45)' } },
        },
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
          data: values.map((v, i) =>
            dim.has(cats[i])
              ? { value: v, itemStyle: { color: 'rgba(122,122,122,0.35)' }, label: { color: 'rgba(122,122,122,0.6)' } }
              : v
          ),
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
  }, [cats.join('|'), values.join('|'), unit, max, red, dimSig]);

  return (
    <>
      <div className="zk-card-title">{title}</div>
      <div className="zk-chart-body" ref={ref} />
    </>
  );
}
