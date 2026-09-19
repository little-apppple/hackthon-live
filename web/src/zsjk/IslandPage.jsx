import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ZsjkShell, { ZsjkBoot } from './ZsjkShell.jsx';
import { useSnapshot } from '../useSnapshot.js';
import ProjectDetail from '../dashboard/ProjectDetail.jsx';
import { aggregateIslands, orderIslands, splitMembers } from './model.js';

// 岛屿详情：顶栏(88) + 列表(836，thead 54 固定 / tbody 内滚)，预算 88+16+836+ticker76 = 1016
// 入口 /zsjk/island?unit=<deptId>；非法参数回退全部；行点击开 ProjectDetail 弹窗

export default function IslandPage() {
  const { snapshot, connected } = useSnapshot();
  const [params, setParams] = useSearchParams();
  const [detail, setDetail] = React.useState(null);

  if (!snapshot) return <ZsjkBoot />;
  const stages = snapshot.stages;
  const islands = orderIslands(aggregateIslands(snapshot.departments));
  const rawUnit = params.get('unit');
  const unit = Number(rawUnit);
  const active = islands.find((i) => String(i.id) === rawUnit && Number.isFinite(unit)) || null;
  const shown = active ? [active] : islands;

  const allProjects = shown.flatMap((i) => i.projects);
  const avgProgress = allProjects.length
    ? Math.round(allProjects.reduce((s, p) => s + p.progress, 0) / allProjects.length)
    : 0;
  const participants = allProjects.reduce((s, p) => s + splitMembers(p.members).length, 0);

  const onUnitChange = (v) => {
    setParams(v ? { unit: v } : {}, { replace: true });
  };

  return (
    <ZsjkShell snapshot={snapshot} connected={connected}>
      <div className="zk3-top">
        <Link className="zk3-back" to="/zsjk/map">
          ← 返回作战地图
        </Link>
        <select
          className="zk3-select"
          value={active ? String(active.id) : ''}
          onChange={(e) => onUnitChange(e.target.value)}
        >
          <option value="">全部岛院（{islands.length} 座）</option>
          {islands.map((i) => (
            <option value={String(i.id)} key={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <div className="zk3-pills">
          <div className="zk3-pill">
            <b>{allProjects.length}</b>
            <span>项目数</span>
          </div>
          <div className="zk3-pill">
            <b>{avgProgress}%</b>
            <span>平均进度</span>
          </div>
          <div className="zk3-pill">
            <b>{participants}</b>
            <span>参与人次</span>
          </div>
        </div>
      </div>

      <div className="zk3-list">
        <div className="zk3-thead">
          <span>项目名称 / 编号</span>
          <span>进度节点（需求 → 提交 · 8 节点）</span>
          <span>项目说明（人员 · 需求 · 价值）</span>
        </div>
        <div className="zk3-tbody">
          {shown.length === 0 && <div className="zk3-empty">暂无岛院数据</div>}
          {shown.map((island) => (
            <React.Fragment key={island.id}>
              <div className="zk3-grp">
                {island.name}
                <span>
                  {island.projectCount} 个项目 · 平均进度 {island.progress}%
                </span>
              </div>
              {island.projects.length === 0 && <div className="zk3-empty">该岛院暂无立项</div>}
              {island.projects.map((p) => (
                <div className="zk3-row" key={p.id} onClick={() => setDetail(p)} title="点击查看项目详情">
                  <div className="zk3-name">
                    <b title={p.name}>
                      <span className="zk3-name-text">{p.name}</span>
                      {isPlayable(p) && (
                        <span className="zk3-playable" title="已上线，评委可直接点开体验">
                          可体验
                        </span>
                      )}
                    </b>
                    <span>
                      P-{String(p.id).padStart(3, '0')}
                      {(p.loop_count || 1) > 1 ? ` · LOOP×${p.loop_count}` : ''}
                      {p.revoked ? ' · 已吊销' : ''}
                    </span>
                    <StatusLine project={p} stages={stages} serverTime={snapshot.serverTime} />
                  </div>
                  <StageNodes project={p} stages={stages} />
                  <div className="zk3-desc">
                    <div className="zk3-mems">
                      {splitMembers(p.members).slice(0, 6).map((n) => (
                        <span className="zk3-mem" key={n}>
                          {n}
                        </span>
                      ))}
                      {splitMembers(p.members).length > 6 && (
                        <span className="zk3-mem">+{splitMembers(p.members).length - 6}</span>
                      )}
                      <span className="zk3-line">{p.summary || ''}</span>
                    </div>
                    <div className="zk3-line">
                      <i>价值：</i>
                      {p.value || '—'}
                    </div>
                  </div>
                </div>
              ))}
            </React.Fragment>
          ))}
          {allProjects.length === 0 && islands.length > 0 && (
            <div className="zk3-empty">暂无项目 · 等待各岛院立项</div>
          )}
        </div>
      </div>

      <ProjectDetail project={detail} stages={stages} onClose={() => setDetail(null)} />
    </ZsjkShell>
  );
}

// 可体验：已上线且有可达目标（Web 链接或安装包），吊销除外——与旧屏 ProjectCard 口径一致
function isPlayable(p) {
  return !p.revoked && p.completed_stages >= 6 && !!(p.link || p.artifactUrl);
}

// 分钟差（以服务端时间为基准，避免终端时钟偏差）；解析失败返回 null
function minutesSince(iso, serverIso) {
  if (!iso) return null;
  const t = new Date(String(iso).replace(' ', 'T')).getTime();
  const base = serverIso ? new Date(serverIso).getTime() : Date.now();
  if (!Number.isFinite(t) || !Number.isFinite(base)) return null;
  return Math.max(0, Math.round((base - t) / 60000));
}

function fmtMin(m) {
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
}

// 行内状态信号：与旧屏 ProjectCard 文案同口径（停滞 ≥30 分钟标红提示，活跃显示最近活动时间）
function StatusLine({ project, stages, serverTime }) {
  const names = stages || [];
  const cur = names[project.completed_stages] || null;
  let text;
  let stalled = false;
  if (project.revoked) {
    text = '上报已被禁用';
  } else if (project.status === 'loading') {
    text = '等待小组首次上报';
  } else if (project.status === 'submitted') {
    text = '已定格为评分版本';
  } else if (project.status === 'done') {
    text = '线上验收通过 · 待最终提交';
  } else {
    const stalledMin = minutesSince(project.stageStartedAt, serverTime);
    const seenMin = minutesSince(project.lastSeenAt, serverTime);
    const seenTxt = seenMin !== null && seenMin >= 15 ? `（最近活动 ${fmtMin(seenMin)}前）` : '';
    if (stalledMin !== null && stalledMin >= 30) {
      stalled = true;
      text = `停滞中：${cur ? cur.name : '—'} · 已 ${fmtMin(stalledMin)}未上报`;
    } else {
      text = `当前节点：${cur ? `${cur.name}${cur.audience ? ` · ${cur.audience}` : ''}` : '—'}${seenTxt}`;
    }
  }
  return <span className={`zk3-status ${stalled ? 'stalled' : ''}`}>{text}</span>;
}

// 8 节点 dot 条：done/doing/todo 三态 + 自报空心环 / 服务端验证实心微光 + 安装包原型跳过
// 类名复用旧屏 pc-dot/pc-link，语义与 ProjectCard 完全一致
function StageNodes({ project, stages }) {
  const names = stages || [];
  return (
    <div className="zk3-nodes">
      {names.map((s, i) => {
        const idx = i + 1;
        const base = idx <= project.completed_stages ? 'done' : idx === project.completed_stages + 1 ? 'current' : 'todo';
        const notApplicable = (project.skippedStages || []).includes(s.id) && base === 'todo';
        const probeFailed = s.id === 'deployment' && base === 'done' && project.deployProbeOk === false;
        const cls = notApplicable
          ? 'skipped'
          : probeFailed
            ? 'done unverified'
            : base === 'done' && s.verified
              ? 'done verified'
              : base;
        return (
          <React.Fragment key={s.id}>
            {i > 0 && <span className={`pc-link ${idx <= project.completed_stages ? 'l-done' : ''}`} />}
            <span
              className={`pc-dot ${cls}`}
              title={[
                `${s.index}. ${s.name}`,
                s.audience ? `· ${s.audience}` : '',
                `（${s.verifyLabel || (s.verified ? '机器校验' : '小组自报')}）`,
                notApplicable ? '· 该项目类型不涉及' : '',
                probeFailed ? '· ⚠ 最近一次部署服务端探活未通过' : '',
              ].filter(Boolean).join(' ')}
            />
          </React.Fragment>
        );
      })}
      <span className="zk3-pct">{project.progress}%</span>
    </div>
  );
}
