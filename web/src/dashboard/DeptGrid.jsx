import React from 'react';
import ProjectCard from './ProjectCard.jsx';

export default function DeptGrid({ departments, stages }) {
  if (!departments.length) {
    return (
      <section className="dept-grid empty-hint">
        暂无数据：请到<a href="/admin">管理后台</a>录入部门 / 小组 / 项目名单
      </section>
    );
  }
  return (
    <section className="dept-grid">
      {departments.map((d) => (
        <div className="dept-card" key={d.id}>
          <div className="dept-head">
            <span className="dept-name">{d.name}</span>
            <span className="dept-meta">
              {d.groupCount} 组 · {d.projectCount} 项目
            </span>
            <div className="dept-bar">
              <div className="dept-bar-fill" style={{ width: `${d.progress}%` }} />
            </div>
            <span className="dept-progress">{d.progress}%</span>
          </div>
          <div className="dept-groups">
            {d.groups.length === 0 && <div className="group-empty">暂无小组</div>}
            {d.groups.map((g) => (
              <div className="group-block" key={g.id}>
                <div className="group-head">
                  <span className="group-name">{g.name}</span>
                  <span className="group-meta">{g.projectCount} 项目</span>
                </div>
                <div className="group-projects">
                  {g.projects.length === 0 && <div className="group-empty">暂无项目</div>}
                  {g.projects.map((p) => (
                    <ProjectCard key={p.id} project={p} stages={stages} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
