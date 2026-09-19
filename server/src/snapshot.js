'use strict';
const db = require('./db');
const config = require('./config');
const { getActiveEvent } = require('./events');
const { STAGES, progressPercent, DEPLOY_STAGE_INDEX, DONE_STAGE_INDEX } = require('./stages');

// 'YYYY-MM-DD HH:MM:SS'（服务端本地时间）→ epoch 毫秒；解析失败返回 null
function toEpochMs(s) {
  if (!s) return null;
  const t = new Date(String(s).replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? t : null;
}

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
              COALESCE(SUM(CASE WHEN p.completed_stages >= ${DEPLOY_STAGE_INDEX} THEN 1 ELSE 0 END), 0) AS deployed,
              COALESCE(SUM(CASE WHEN p.completed_stages >= ${DONE_STAGE_INDEX} THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(SUM(CASE WHEN p.archived = 0 AND p.revoked = 0 THEN p.hits ELSE 0 END), 0) AS total_hits,
              COALESCE(AVG(CASE WHEN p.archived = 0 THEN p.completed_stages END), 0) AS avg_stages,
              COALESCE(SUM(CASE WHEN p.archived = 0 THEN p.completed_stages ELSE 0 END), 0) AS sum_stages
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
      `SELECT id, group_id, name, description, port, completed_stages, loop_count,
              status, revoked, last_report_at, created_at,
              members, summary, value, features, scenario, deliverable, artifact_name, hits, ai_score, last_seen_at
         FROM projects
        WHERE event_id = ? AND archived = 0
        ORDER BY id`
    )
    .all(eid);


  // 未归档项目：KPI 完成率按各项目「加权进度」取平均（与分组/部门口径一致）
  const activeProjects = projects.filter((p) => !p.archived);

  // 最近一次部署探活结果（区分「探活通过」与「探活失败仍上报」两种情况）
  const probeRows = db
    .prepare(
      `SELECT r.project_id, r.evidence FROM reports r
        WHERE r.stage = 'deployment' AND r.ok = 1 AND r.evidence IS NOT NULL
        ORDER BY r.id DESC`
    )
    .all();
  const probeOkByProject = new Map();
  for (const row of probeRows) {
    if (probeOkByProject.has(row.project_id)) continue; // 只取最近一条
    try {
      const ev = JSON.parse(row.evidence);
      probeOkByProject.set(row.project_id, ev?.serverProbe?.ok === true);
    } catch {
      /* 证据非 JSON 忽略 */
    }
  }
  for (const p of activeProjects) {
    if (p.completed_stages >= DEPLOY_STAGE_INDEX) p.deployProbeOk = probeOkByProject.get(p.id) ?? null;
  }

  const projectsByGroup = new Map();
  for (const p of projects) {
    p.progress = progressPercent(p.completed_stages);
    p.link = config.publicHost ? `http://${config.publicHost}:${p.port}` : null;
    p.department = null;
    p.grp = null;
    // 与 link 同口径：未到「上线部署」节点（含 loop 重置后）不下发安装包直链，避免详情弹窗露出上一轮产物
    p.artifactUrl = p.deliverable === 'package' && p.artifact_name && config.publicHost && p.completed_stages >= DEPLOY_STAGE_INDEX ? `http://${config.publicHost}:${p.port}/${p.artifact_name}` : null;
    // 停滞/活跃信号：当前节点从上次成功上报开始计时；last_seen_at 由 CLI 调用（--next/--status/上报）续期
    p.stageStartedAt = p.last_report_at || p.created_at;
    p.lastSeenAt = p.last_seen_at || null;
    // 同时下发 epoch 毫秒：浏览器时区与服务端不一致时，字符串解析会偏差
    p.stageStartedAtMs = toEpochMs(p.stageStartedAt);
    p.lastSeenAtMs = toEpochMs(p.lastSeenAt);
    // 该项目不适用的节点（安装包/CLI 类不涉及原型）：服务端统一判定，前端只渲染
    p.skippedStages = p.deliverable === 'package' ? ['prototype'] : [];
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
            : gProjects.reduce((s, p) => s + progressPercent(p.completed_stages), 0) / (gProjects.length * 100);
        for (const p of gProjects) {
          p.department = d.name;
          p.grp = g.name;
        }
  // 未归档项目：KPI 完成率按各项目加权进度取平均（与分组/部门口径一致）

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
        : deptGroups.reduce((s, g) => s + g.projects.reduce((x, p) => x + progressPercent(p.completed_stages), 0), 0) /
          (totalProjects * 100);
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

  // 人气榜：按点击量取前 5（去重后的人气值）
  const hotProjects = db
    .prepare(
      `SELECT p.id AS projectId, p.name, p.hits, p.deliverable, p.artifact_name, p.port, p.status, p.completed_stages,
              g.name AS grp, d.name AS department
         FROM projects p
         JOIN groups g ON g.id = p.group_id
         JOIN departments d ON d.id = g.department_id
        WHERE p.event_id = ? AND p.archived = 0 AND p.revoked = 0 AND p.hits > 0
        ORDER BY p.hits DESC, p.id DESC LIMIT 5`
    )
    .all(eid)
    .map((p) => ({ ...p, progress: progressPercent(p.completed_stages || 0), link: config.publicHost ? `http://${config.publicHost}:${p.port}` : null,
      artifactUrl: p.deliverable === 'package' && p.artifact_name && config.publicHost && (p.completed_stages || 0) >= DEPLOY_STAGE_INDEX ? `http://${config.publicHost}:${p.port}/${p.artifact_name}` : null }));

  // 已提交（最终参赛作品）列表：按提交时间倒序，供大屏「已完成项目列表」与烟花通知使用
  const submittedProjects = db
    .prepare(
      `SELECT p.id AS projectId, p.name, p.loop_count, p.port, p.last_report_at, p.ai_score, p.ai_scored_at,
              p.completed_stages, p.members, p.summary, p.value, p.features, p.scenario, p.deliverable, p.artifact_name, p.hits,
              g.name AS grp, d.name AS department
         FROM projects p
         JOIN groups g ON g.id = p.group_id
         JOIN departments d ON d.id = g.department_id
        WHERE p.event_id = ? AND p.archived = 0 AND p.revoked = 0 AND p.completed_stages >= ${STAGES.length}
        ORDER BY p.last_report_at DESC, p.id DESC`
    )
    .all(eid)
    .map((p) => ({
      ...p,
      progress: progressPercent(p.completed_stages || 0),
      link: config.publicHost ? `http://${config.publicHost}:${p.port}` : null,
      artifactUrl: p.deliverable === 'package' && p.artifact_name && config.publicHost && (p.completed_stages || 0) >= DEPLOY_STAGE_INDEX ? `http://${config.publicHost}:${p.port}/${p.artifact_name}` : null,
    }));

  return {
    eventId: eid,
    eventName: event.name,
    eventEndTime: event.end_time || null,
    serverTime: new Date().toISOString(),
    // 未归档项目（用于 KPI 完成率的加权平均）


    stages: STAGES,
    kpi: {
      departments: kpiRow.departments || 0,
      groups: kpiRow.groups || 0,
      projects: kpiRow.projects || 0,
      deployed: kpiRow.deployed || 0,
      done: kpiRow.done || 0,
      submitted: submittedProjects.length,
      totalHits: kpiRow.total_hits || 0,
      // 完成率口径与分组/部门一致：各项目「加权进度」的平均（此前用平均阶段数换算会偏低）
      completion: activeProjects.length
        ? Math.round(activeProjects.reduce((sum, p) => sum + progressPercent(p.completed_stages), 0) / activeProjects.length)
        : 0,
    },
    departments: deptTree,
    events,
    loadingProjects,
    submittedProjects,
    hotProjects,
  };
}

module.exports = { buildSnapshot };
