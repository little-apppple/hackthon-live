'use strict';
// 演示数据：直接写库，快速构造各阶段混合的比赛现场状态（仅开发/演示用）
//   node scripts/demo-data.js
const crypto = require('crypto');
const db = require('../server/src/db');
const { getActiveEvent } = require('../server/src/events');
const { STAGES, deriveStatus, progressPercent } = require('../server/src/stages');

const eventId = getActiveEvent().id;

const key = () => 'hk_' + crypto.randomBytes(16).toString('hex');

// [小组名, 部门名, 项目名, 已完成节点数, 描述]
const plan = [
  ['先锋队', '研发中心', '智能周报助手', 7, 'AI 自动汇总团队动态生成周报'],
  ['先锋队', '研发中心', 'CodeFlow 流水线看板', 6, '研发效能流水线可视化'],
  ['破晓小组', '研发中心', '实时投票墙', 4, '现场大屏互动投票'],
  ['深空实验室', '研发中心', 'AR 资产巡检', 2, 'AR 眼镜辅助机房巡检'],
  ['体验突击队', '产品与设计部', '设计系统魔方', 5, '企业级组件设计系统'],
  ['创想工坊', '产品与设计部', 'AI 海报工场', 3, '一句话生成营销海报'],
  ['算法纵队', '数据智能部', '工单智能分派', 4, 'NLP 自动分派维修工单'],
  ['数据飞轮', '数据智能部', '异常指标侦探', 1, '时序指标自动归因'],
  ['增长黑客团', '市场与运营部', '裂变海报引擎', 0, '社交裂变海报生成器'],
  ['品牌新星', '市场与运营部', '直播弹幕仪表盘', 0, '直播互动数据大屏'],
];

const messages = {
  1: '需求清单产出，圈定 5 个核心场景',
  2: '技术方案定稿：React + Express + SQLite',
  3: '原型完成，Figma 12 页全流程走查通过',
  4: '核心功能开发完成，接口自测通过',
  5: '本地测试通过，修复 3 个缺陷',
  6: '已部署到预留端口，线上可访问',
  7: '线上验收通过，评委确认',
};

const insProject = db.prepare(
  'INSERT INTO projects (event_id, group_id, name, description, access_key, port, completed_stages, status, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const insReport = db.prepare(
  'INSERT INTO reports (project_id, stage, ok, reject_code, message, ip, created_at) VALUES (?, ?, 1, NULL, ?, ?, ?)'
);
const findGroup = db.prepare(
  `SELECT g.id FROM groups g JOIN departments d ON d.id = g.department_id WHERE g.name = ? AND d.name = ? AND d.event_id = ?`
);

// 参数绑定不执行 SQL 函数，时间在 JS 侧生成（本地时区，格式同 datetime('now','localtime')）
function localTime(minsAgo = 0) {
  const d = new Date(Date.now() - minsAgo * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let port = 4100;
const run = db.transaction(() => {
  for (const [groupName, deptName, projName, done, desc] of plan) {
    const g = findGroup.get(groupName, deptName, eventId);
    if (!g) {
      console.warn(`跳过（找不到 ${deptName}/${groupName}）: ${projName}`);
      continue;
    }
    const status = deriveStatus(done, done > 0);
    const createdAt = localTime(done * 35 + 60);
    const p = insProject.run(eventId, g.id, projName, desc, key(), port++, done, status, 0, createdAt);
    const pid = p.lastInsertRowid;
    // 回溯生成与进度一致的审计历史（每节点间隔约 35 分钟）
    for (let i = 1; i <= done; i++) {
      const minsAgo = (done - i) * 35 + 10;
      insReport.run(pid, STAGES[i - 1].id, messages[i], '192.168.1.' + (20 + (pid % 200)), localTime(minsAgo));
    }
    console.log(`+ ${deptName}/${groupName} → ${projName}（${done}/7 ${progressPercent(done)}%）`);
  }
  // 一个被吊销的项目，验证大屏灰显
  const g = findGroup.get('数据飞轮', '数据智能部', eventId);
  insProject.run(eventId, g.id, '旧版聊天机器人', '已停报的演示项目', key(), port++, 3, 'active', 1, localTime(300));
  console.log(`+ 数据智能部/数据飞轮 → 旧版聊天机器人（已吊销）`);
});
run();
console.log('\n演示数据就绪。');
