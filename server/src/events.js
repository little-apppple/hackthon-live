'use strict';
const db = require('./db');
const config = require('./config');

// 活动辅助：唯一活跃活动（大屏与管理端默认上下文），缺失时兜底创建
function getActiveEvent() {
  let ev = db.prepare('SELECT * FROM events WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  if (!ev) ev = db.prepare('SELECT * FROM events ORDER BY id LIMIT 1').get();
  if (!ev) {
    db.prepare('INSERT INTO events (name, end_time, is_active) VALUES (?, ?, 1)').run(
      config.eventName,
      config.eventEndTime || null
    );
    ev = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  } else if (!ev.is_active) {
    db.prepare('UPDATE events SET is_active = 1 WHERE id = ?').run(ev.id);
    ev = { ...ev, is_active: 1 };
  }
  return ev;
}

// 切换活跃活动（全库仅一个 is_active=1）
function activateEvent(id) {
  const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(id);
  if (!ev) return false;
  db.transaction(() => {
    db.prepare('UPDATE events SET is_active = 0').run();
    db.prepare('UPDATE events SET is_active = 1 WHERE id = ?').run(id);
  })();
  return true;
}

module.exports = { getActiveEvent, activateEvent };
