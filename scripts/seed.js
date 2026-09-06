'use strict';
// 初始名单导入：node scripts/seed.js [--file data/seed-roster.json]
const fs = require('fs');
const path = require('path');

const db = require('../server/src/db');
const { getActiveEvent } = require('../server/src/events');

const eventId = getActiveEvent().id;

const file = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : path.join(__dirname, '..', 'data', 'seed-roster.json');

if (!fs.existsSync(file)) {
  console.error(`名单文件不存在: ${file}`);
  process.exit(1);
}

const roster = JSON.parse(fs.readFileSync(file, 'utf-8'));

const getDept = db.prepare('SELECT id FROM departments WHERE event_id = ? AND name = ?');
const addDept = db.prepare('INSERT INTO departments (event_id, name, sort_order) VALUES (?, ?, ?)');
const getGroup = db.prepare('SELECT id FROM groups WHERE department_id = ? AND name = ?');
const addGroup = db.prepare('INSERT INTO groups (event_id, department_id, name, sort_order) VALUES (?, ?, ?, ?)');

let deptCreated = 0;
let groupCreated = 0;

const run = db.transaction(() => {
  (roster.departments || []).forEach((d, di) => {
    const name = typeof d === 'string' ? d : d.name;
    const groups = typeof d === 'string' ? [] : d.groups || [];
    let dept = getDept.get(eventId, name);
    if (!dept) {
      addDept.run(eventId, name, di);
      dept = getDept.get(eventId, name);
      deptCreated++;
      console.log(`+ 部门 ${name}`);
    }
    groups.forEach((g, gi) => {
      if (!getGroup.get(dept.id, g)) {
        addGroup.run(eventId, dept.id, g, gi);
        groupCreated++;
        console.log(`  + 小组 ${g}`);
      }
    });
  });
});
run();

console.log(`\n导入完成：新增部门 ${deptCreated} 个，新增小组 ${groupCreated} 个（已存在的跳过，导入到活动 #${eventId}）。`);
console.log('下一步：打开管理后台 → 项目与密钥 → 选择部门/小组创建项目并生成 accesskey。');
