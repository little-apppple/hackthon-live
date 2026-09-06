import React, { useState } from 'react';

const STATUS_TEXT = {
  loading: '等待启动',
  active: '进行中',
  deployed: '已上线',
  done: '已完成',
};
const STATUS_CLASS = {
  loading: 'st-loading',
  active: 'st-active',
  deployed: 'st-deployed',
  done: 'st-done',
};

export default function ProjectCard({ project, stages }) {
  const revoked = !!project.revoked;
  const status = revoked ? 'revoked' : project.status;
  const stageNames = stages || [];
  const currentStage =
    project.completed_stages < stageNames.length ? stageNames[project.completed_stages] : null;
  const linkReady = !revoked && project.completed_stages >= 6 && project.link;

  return (
    <div className={`project-card ${STATUS_CLASS[status] || ''} ${revoked ? 'is-revoked' : ''}`} data-status={status}>
      <div className="pc-top">
        <span className="pc-name" title={project.name}>
          {project.name}
        </span>
        <span className={`pc-badge badge-${status}`}>
          {status === 'loading' && <span className="spin-dot" />}
          {revoked ? '已吊销' : STATUS_TEXT[status] || status}
        </span>
      </div>
      <div className="pc-stages">
        {stageNames.map((s, i) => {
          const idx = i + 1;
          const cls =
            idx <= project.completed_stages ? 'done' : idx === project.completed_stages + 1 ? 'current' : 'todo';
          return (
            <React.Fragment key={s.id}>
              {i > 0 && <span className={`pc-link ${idx <= project.completed_stages ? 'l-done' : ''}`} />}
              <span className={`pc-dot ${cls}`} title={`${s.index}. ${s.name}`} />
            </React.Fragment>
          );
        })}
        <span className="pc-percent">{project.progress}%</span>
      </div>
      <div className="pc-bottom">
        <span className="pc-stage-hint">
          {revoked
            ? '上报已被禁用'
            : status === 'loading'
              ? '等待小组首次上报'
              : status === 'done'
                ? '全部节点完成 · 线上验收通过'
                : `当前节点：${currentStage ? currentStage.name : '—'}`}
        </span>
        {linkReady && (
          <a className="pc-link-btn" href={project.link} target="_blank" rel="noreferrer" title={project.link}>
            ▶ 打开项目
          </a>
        )}
      </div>
    </div>
  );
}
