import React, { useState } from 'react';

// 停滞/活跃：以服务端时间为基准，避免各终端时钟差异
function minutesSince(iso, serverIso) {
  if (!iso) return null;
  const t = new Date(String(iso).replace(' ', 'T')).getTime();
  const base = serverIso ? new Date(serverIso).getTime() : Date.now();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((base - t) / 60000));
}

const AUDIENCE_FALLBACK = {
  requirements: '有想法了', design: '方案定了', prototype: '有样子了', coding: '在写代码',
  testing: '在自测', deployment: '能玩了', acceptance: '机器验过', submission: '定稿提交',
};

const STATUS_TEXT = {
  loading: '等待启动',
  active: '进行中',
  deployed: '已上线',
  done: '已完成',
  submitted: '已提交',
};
export default function ProjectCard({ project, stages, serverTime, onOpenDetail }) {
  const revoked = !!project.revoked;
  const status = revoked ? 'revoked' : project.status;
  const stageNames = stages || [];
  const currentStage =
    project.completed_stages < stageNames.length ? stageNames[project.completed_stages] : null;
  const linkReady = !revoked && project.completed_stages >= 6 && project.link;
  const loop = project.loop_count || 1;
  const isPackage = project.deliverable === 'package';
  const stalledMin = minutesSince(project.stageStartedAt || project.created_at, serverTime);
  const seenMin = minutesSince(project.lastSeenAt, serverTime);
  const nextStage = stageNames.find((x) => x.index === project.completed_stages + 1);
  const audience = (nextStage || {}).audience || AUDIENCE_FALLBACK[(nextStage || {}).id];
  const playable = !revoked && project.completed_stages >= 6;
  const stale = stalledMin !== null && stalledMin >= 30 && status === 'active';

  return (
    <div
      className={`project-card ${revoked ? 'is-revoked' : ''}`}
      data-status={status}
      onClick={() => onOpenDetail && onOpenDetail(project)}
      title="点击查看项目详情"
    >
      <div className="pc-top">
        <span className="pc-name" title={project.name}>
          {project.name}
          {loop > 1 && <span className="pc-loop" title={`第 ${loop} 轮迭代`}>LOOP×{loop}</span>}
        </span>
        <span className={`pc-badge badge-${status}`}>
          {status === 'loading' && <span className="spin-dot" />}
          {revoked ? '已吊销' : STATUS_TEXT[status] || status}
        </span>
      </div>
      <div className="pc-stages">
        {stageNames.map((s, i) => {
          const idx = i + 1;
          const base = idx <= project.completed_stages ? 'done' : idx === project.completed_stages + 1 ? 'current' : 'todo';
          const skipped = isPackage && s.id === 'prototype';
          const cls = skipped ? 'skipped' : base === 'done' && s.verified ? 'done verified' : base;
          return (
            <React.Fragment key={s.id}>
              {i > 0 && <span className={`pc-link ${idx <= project.completed_stages ? 'l-done' : ''}`} />}
              <span
                className={`pc-dot ${cls}`}
                title={`${s.index}. ${s.name}${s.audience ? ` · ${s.audience}` : ''}${s.verified ? '（服务端验证）' : '（小组自报）'}${skipped ? ' · 该项目类型不涉及' : ''}`}
              />
            </React.Fragment>
          );
        })}
        <span className="pc-percent">{project.progress}%</span>
      </div>
      <div className="pc-bottom">
        {typeof project.hits === 'number' && project.hits > 0 && (
          <span className="pc-hits" title="人气值（按终端去重）">
            人气 {project.hits}
          </span>
        )}
        <span className="pc-stage-hint">
          {revoked
            ? '上报已被禁用'
            : status === 'loading'
              ? '等待小组首次上报'
              : status === 'done'
                ? '线上验收通过 · 待用户最终提交'
                : status === 'submitted'
                  ? '最终参赛作品 · 评分版本已定格'
                  : stale
                    ? `停滞中：${currentStage ? currentStage.name : '—'} · 已 ${stalledMin >= 60 ? `${Math.floor(stalledMin / 60)}h${stalledMin % 60}m` : `${stalledMin}m`}未上报`
                    : `当前节点：${currentStage ? currentStage.name : '—'}${audience ? ` · ${audience}` : ''}${stalledMin !== null ? ` · 已 ${stalledMin >= 60 ? `${Math.floor(stalledMin / 60)}h${stalledMin % 60}m` : `${stalledMin}m`}` : ''}${seenMin !== null && seenMin >= 15 ? `（最近活动 ${seenMin >= 60 ? `${Math.floor(seenMin / 60)}h` : `${seenMin}m`}前）` : ''}`}
        </span>
        {linkReady && !isPackage && (
          <a
            className="pc-link-btn"
            href={`/api/hit/go?projectId=${project.id}`}
            target="_blank"
            rel="noreferrer"
            title={project.link}
            onClick={(e) => e.stopPropagation()}
          >
            ▶ 打开项目
          </a>
        )}
        {playable && <span className="pc-playable" title="已上线，评委可直接体验">可体验</span>}
        {project.deliverable === 'package' && project.artifactUrl && project.completed_stages >= 6 && !revoked && (
          <a
            className="pc-link-btn"
            href={`/api/hit/go?projectId=${project.id}`}
            target="_blank"
            rel="noreferrer"
            title={project.artifactUrl}
            onClick={(e) => e.stopPropagation()}
          >
            ⬇ 下载安装包
          </a>
        )}
      </div>
    </div>
  );
}
