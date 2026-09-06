'use strict';
const db = require('./db');
const config = require('./config');
const { getActiveEvent } = require('./events');
const { STAGES, progressPercent } = require('./stages');

// 按活动构建大屏快照；eventId 缺省为当前活跃活动
function buildSnapshot(eventId) {
  const event = Number.isFinite(eventId) && eventId > 0
    ? db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) || getActiveEvent()
    : getActiveEvent();
  const eid = event.id;

  const kpiRow = db
    .prepare(
      `SELECT COUNT(DISTINCT d.id) AS departments,
              COUNT(DISTINCT g.id) AS groups,
              COUNT(p.id) AS projects,
              COALESCE(SUM(CASE WHEN p.status = 'deployed' THEN 1 ELSE 0 END), 0) AS deployed,
              COALESCE(SUM(CASE WHEN p.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(AVG(CASE WHEN p.archived = 0 THEN p.completed_stages END), 0) AS avg_stages
         FROM departments d
         LEFT JOIN groups g ON g.department_id = d.id
         LEFT JOIN projects p ON p.group_id = g.id AND p.archived = 0
        WHERE d.event_id = ?`
    )
    .get(eid);

  const departments = db
    .prepare('SELECT id, name, sort_order FROM departments WHERE event_id = ? ORDER BY sort_order, id')
    .all(eid);

  const groups = db
    .prepare('SELECT id, name, department_id FROM groups WHERE event_id = ? ORDER BY sort_order, id')
    .all(eid);

  const projects = db
    .prepare(
      `SELECT id, group_id, name, description, port, completed_stages,
              status, revoked, last_report_at, created_at
         FROM projects
        WHERE event_id = ? AND archived = 0
        ORDER BY id`
    )
    .all(eid);

  const projectsByGroup = new Map();
  for (const p of projects) {
    p.progress = progressPercent(p.completed_stages);
    p.link = config.publicHost ? `http://${config.publicHost}:${p.port}` : null;
    if (!projectsByGroup.has(p.group_id)) projectsByGroup.set(p.group_id, []);
    projectsByGroup.get(p.group_id).push(p);
  }

  const deptTree = departments.map((d) => {
    const deptGroups = groups
      .filter((g) => g.department_id === d.id)
      .map((g) => {
        const gProjects = projectsByGroup.get(g.id) || [];
        const avg =
          gProjects.length === 0
            ? 0
            : gProjects.reduce((s, p) => s + p.completed_stages, 0) / (gProjects.length * STAGES.length);
        return {
          id: g.id,
          name: g.name,
          progress: Math.round(avg * 100),
          projectCount: gProjects.length,
          projects: gProjects,
        };
      });
    const totalProjects = deptGroups.reduce((s, g) => s + g.projectCount, 0);
    const avg =
      totalProjects === 0
        ? 0
        : deptGroups.reduce((s, g) => s + g.projects.reduce((x, p) => x + p.completed_stages, 0), 0) /
          (totalProjects * STAGES.length);
    return {
      id: d.id,
      name: d.name,
      progress: Math.round(avg * 100),
      groupCount: deptGroups.length,
      projectCount: totalProjects,
      groups: deptGroups,
    };
  });

  const events = db
    .prepare(
      `SELECT r.id, r.stage, r.ok, r.reject_code, r.created_at,
              p.name AS project, p.id AS project_id,
              g.name AS grp, d.name AS department
         FROM reports r
         JOIN projects p ON p.id = r.project_id
         JOIN groups g ON g.id = p.group_id
         JOIN departments d ON d.id = g.department_id
        WHERE p.event_id = ?
        ORDER BY r.id DESC
        LIMIT 60`
    )
    .all(eid);

  const loadingProjects = [];
  for (const d of deptTree) {
    for (const g of d.groups) {
      for (const p of g.projects) {
        if (p.status === 'loading' && !p.revoked) {
          loadingProjects.push({
            projectId: p.id,
            name: p.name,
            department: d.name,
            group: g.name,
            port: p.port,
            createdAt: p.created_at,
          });
        }
      }
    }
  }

  return {
    eventId: eid,
    eventName: event.name,
    eventEndTime: event.end_time || null,
    serverTime: new Date().toISOString(),
    stages: STAGES,
    kpi: {
      departments: kpiRow.departments || 0,
      groups: kpiRow.groups || 0,
      projects: kpiRow.projects || 0,
      deployed: kpiRow.deployed || 0,
      done: kpiRow.done || 0,
      completion: Math.round((kpiRow.avg_stages / STAGES.length) * 100),
    },
    departments: deptTree,
    events,
    loadingProjects,
  };
}

module.exports = { buildSnapshot };
