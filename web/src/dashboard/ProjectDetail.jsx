import React, { useEffect } from 'react';

// 项目详情弹层：展示注册时采集的信息（参与人员/需求简述/价值/功能/场景）与交付形态
// 点击项目卡或已提交榜项打开；点击遮罩或按 Esc 关闭
export default function ProjectDetail({ project, stages, onClose }) {
  useEffect(() => {
    if (!project) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, onClose]);

  if (!project) return null;
  const isPackage = project.deliverable === 'package';
  const total = (stages && stages.length) || 8;
  const rows = [
    ['参与人员', project.members],
    ['需求简述', project.summary],
    ['项目价值', project.value],
    ['核心功能', project.features],
    ['应用场景', project.scenario],
  ];
  const filled = rows.filter(([, v]) => v && String(v).trim());

  return (
    <div className="detail-mask" onClick={onClose}>
      <div className="detail-card" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <div>
            <div className="detail-name">{project.name}</div>
            <div className="detail-meta">
              {project.department_name || project.department} · {project.group_name || project.grp}
              <span className="detail-chip">{isPackage ? '安装包交付' : 'Web 应用'}</span>
              {project.loop_count > 1 && <span className="detail-chip">LOOP×{project.loop_count}</span>}
              {typeof project.ai_score === 'number' && <span className="detail-chip red">AI {project.ai_score}</span>}
            </div>
          </div>
          <button className="detail-close" onClick={onClose} title="关闭（Esc）">
            ✕
          </button>
        </div>

        <div className="detail-progress">
          进度 {project.completed_stages}/{total}（{project.progress}%）
          {project.description ? ` · ${project.description}` : ''}
        </div>

        {filled.length === 0 && <div className="detail-empty">该项目注册时未填写展示信息</div>}
        {filled.map(([label, value]) => (
          <div className="detail-row" key={label}>
            <span className="detail-label">{label}</span>
            <span className="detail-value">{value}</span>
          </div>
        ))}

        <div className="detail-actions">
          {project.artifactUrl && (
            <a className="detail-link" href={project.artifactUrl} target="_blank" rel="noreferrer" >
              ⬇ 下载安装包
            </a>
          )}
          {!isPackage && project.link && project.completed_stages >= 6 && (
            <a className="detail-link" href={`/api/hit/go?projectId=${project.projectId || project.id}`} target="_blank" rel="noreferrer">
              ▶ 打开项目
            </a>
          )}
          {isPackage && !project.artifactUrl && <span className="detail-note">安装包尚未上传</span>}
        </div>
      </div>
    </div>
  );
}
