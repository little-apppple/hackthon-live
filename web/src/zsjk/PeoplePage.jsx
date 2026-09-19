import React from 'react';
import ZsjkShell, { ZsjkBoot } from './ZsjkShell.jsx';
import { useSnapshot } from '../useSnapshot.js';
import { aggregatePeople, peopleKpis, sortPeople } from './model.js';

// 人员维度：头部(140：标题+4 KPI) + 表格(776：thead 54 可排序 / 行 66 可展开)，预算 140+24+776+ticker76 = 1016
// 人员由各项目 members 拆分聚合（同名合并）；四列均可点排序，默认参与项目数降序

const COLUMNS = [
  { key: 'name', label: '人员' },
  { key: 'projectCount', label: '参与项目数' },
  { key: 'avgProgress', label: '完成情况（加权进度）' },
  { key: 'hits', label: '项目人气值' },
];

const STATUS_TEXT = {
  loading: '等待启动', active: '进行中', deployed: '已上线', done: '已完成', submitted: '已提交',
};

const AVATAR_TINTS = ['rgba(194,59,34,0.20)', 'rgba(194,59,34,0.10)', 'rgba(200,200,200,0.10)', 'rgba(232,90,58,0.16)', 'rgba(122,122,122,0.16)'];

export default function PeoplePage() {
  const { snapshot, connected } = useSnapshot();
  const [sort, setSort] = React.useState({ key: 'projectCount', dir: 'desc' });
  const [openName, setOpenName] = React.useState(null);

  if (!snapshot) return <ZsjkBoot />;
  const people = sortPeople(aggregatePeople(snapshot.departments), sort.key, sort.dir);
  const kpi = peopleKpis(people);

  const toggleSort = (key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  };

  return (
    <ZsjkShell snapshot={snapshot} connected={connected}>
      <div className="zk4-head">
        <div>
          <div className="zk4-h1">人员维度</div>
          <div className="zk4-sub">
            {kpi.total} 位参与者 · 点击表头排序（默认按参与项目数）· 点击行查看参与项目
          </div>
        </div>
        <div className="zk4-kpis">
          <div className="zk4-kpi">
            <b>{kpi.total}</b>
            <span>榜上人员</span>
          </div>
          <div className="zk4-kpi">
            <b>{kpi.avgPer}</b>
            <span>人均参与（项目）</span>
          </div>
          <div className="zk4-kpi">
            <b>
              {kpi.avgCompletion}
              <small>%</small>
            </b>
            <span>平均完成率</span>
          </div>
          <div className="zk4-kpi">
            <b>🔥 {kpi.maxHits}</b>
            <span>最高人气</span>
          </div>
        </div>
      </div>

      <div className="zk4-table">
        <div className="zk4-thead">
          {COLUMNS.map((c) => (
            <button
              key={c.key}
              className={`zk4-th ${sort.key === c.key ? 'active' : ''}`}
              onClick={() => toggleSort(c.key)}
              title="点击排序"
            >
              {c.label}
              <span>{sort.key === c.key ? (sort.dir === 'desc' ? '▼' : '▲') : '▾'}</span>
            </button>
          ))}
        </div>
        <div className="zk4-tbody">
          {people.length === 0 && <div className="zk4-empty">暂无人员数据 · 等待各队注册时填写参与人员</div>}
          {people.map((person) => {
            const open = openName === person.name;
            return (
              <React.Fragment key={person.name}>
                <div
                  className={`zk4-row ${open ? 'open' : ''}`}
                  onClick={() => setOpenName(open ? null : person.name)}
                  title={open ? '点击收起' : '点击展开参与项目'}
                >
                  <div className="zk4-person">
                    <div
                      className="zk4-avatar"
                      style={{ background: AVATAR_TINTS[(person.name.charCodeAt(0) || 0) % AVATAR_TINTS.length] }}
                    >
                      {person.name.slice(0, 1)}
                    </div>
                    <div className="zk4-person-info">
                      <b>{person.name}</b>
                      <span>
                        {person.island || '—'}
                        {person.islands.length > 1 ? ` 等 ${person.islands.length} 座岛院` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="zk4-count">
                    {person.projectCount} <small>个</small>
                  </div>
                  <div className="zk4-meter">
                    <div className="zk4-track">
                      <i style={{ width: `${person.avgProgress}%` }} />
                    </div>
                    <span className="zk4-meter-num">{person.avgProgress}%</span>
                  </div>
                  <div className="zk4-meter">
                    <span>🔥</span>
                    <div className="zk4-track dim">
                      <i style={{ width: `${kpi.maxHits ? (person.hits / kpi.maxHits) * 100 : 0}%` }} />
                    </div>
                    <span className="zk4-meter-num">{person.hits}</span>
                  </div>
                  <span className="zk4-arrow">▼</span>
                </div>
                {open && (
                  <div className="zk4-expand">
                    <div className="zk4-expand-title">参与项目（{person.projectCount}）</div>
                    {person.projects.map((p) => (
                      <div className="zk4-pex" key={p.id}>
                        <div className="zk4-pex-name">
                          <b title={p.name}>{p.name}</b>
                          <span>
                            P-{String(p.id).padStart(3, '0')} · {p.revoked ? '已吊销' : STATUS_TEXT[p.status] || p.status}
                          </span>
                        </div>
                        <div className="zk4-track" style={{ maxWidth: 'none' }}>
                          <i style={{ width: `${p.progress}%` }} />
                        </div>
                        <span className="zk4-meter-num">{p.progress}%</span>
                        <span className="zk4-badge">{p.deliverable === 'package' ? '安装包' : 'Web'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </ZsjkShell>
  );
}
