import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

// 活动管理：每期活动的数据完全隔离（部门/小组/项目/上报/部署互不可见）
export default function EventsPanel({ onChanged, activeEventId }) {
  const [events, setEvents] = useState([]);
  const [name, setName] = useState('');
  const [endTime, setEndTime] = useState('');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const { data } = await api.get('/api/admin/events');
    if (data?.ok) setEvents(data.events);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const create = async () => {
    if (!name.trim()) return flash('活动名称不能为空', false);
    const { ok, data } = await api.post('/api/admin/events', { name: name.trim(), endTime: endTime.trim() });
    if (ok) {
      setName('');
      setEndTime('');
      load();
      onChanged();
      flash(`活动「${name.trim()}」已创建`);
    } else flash(data?.error || '创建失败', false);
  };

  const activate = async (ev) => {
    if (!confirm(`把「${ev.name}」设为当前活动？大屏默认展示与后台默认上下文将切换到该活动。`)) return;
    const { ok, data } = await api.post(`/api/admin/events/${ev.id}/activate`);
    if (ok) {
      load();
      onChanged();
      flash(`已切换到「${ev.name}」`);
    } else flash(data?.error || '切换失败', false);
  };

  const rename = async (ev) => {
    const name2 = prompt('修改活动名称', ev.name);
    if (!name2 || name2.trim() === ev.name) return;
    const { ok, data } = await api.put(`/api/admin/events/${ev.id}`, { name: name2.trim() });
    if (ok) {
      load();
      onChanged();
      flash('已重命名');
    } else flash(data?.error || '失败', false);
  };

  const editEndTime = async (ev) => {
    const t = prompt('比赛结束时间（ISO 格式，如 2026-09-05T18:00:00；留空清除倒计时）', ev.end_time || '');
    if (t === null) return;
    const { ok, data } = await api.put(`/api/admin/events/${ev.id}`, { name: ev.name, endTime: t.trim() });
    if (ok) {
      load();
      flash('结束时间已更新');
    } else flash(data?.error || '失败', false);
  };

  const del = async (ev) => {
    if (!confirm(`确认删除活动「${ev.name}」？仅能删除没有任何部门/项目的空活动。`)) return;
    const { ok, data } = await api.del(`/api/admin/events/${ev.id}`);
    if (ok) {
      load();
      onChanged();
      flash('活动已删除');
    } else flash(data?.error || '删除失败', false);
  };

  return (
    <div className="events-panel">
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      <section className="admin-card">
        <h2>
          新建活动
          <em className="h-sub">每期活动的部门、小组、项目、上报与部署数据完全隔离，互不影响</em>
        </h2>
        <div className="create-row">
          <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="活动名称（如：2026 秋季黑客松）" />
          <input className="grow" value={endTime} onChange={(e) => setEndTime(e.target.value)} placeholder="结束时间（可选，ISO：2026-09-05T18:00:00）" />
          <button onClick={create}>创建</button>
        </div>
      </section>

      <section className="admin-card">
        <h2>活动列表</h2>
        <table className="proj-table">
          <thead>
            <tr>
              <th>#</th>
              <th>活动名称</th>
              <th>结束时间</th>
              <th>部门</th>
              <th>小组</th>
              <th>项目</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id} className={ev.id === activeEventId ? 'row-active-event' : ''}>
                <td className="mono">{ev.id}</td>
                <td className="cell-name">{ev.name}</td>
                <td className="mono">{ev.end_time || '—'}</td>
                <td>{ev.department_count}</td>
                <td>{ev.group_count}</td>
                <td>{ev.project_count}</td>
                <td>
                  {ev.id === activeEventId ? (
                    <span className="status-chip c-deployed">当前活动</span>
                  ) : (
                    <span className="status-chip c-archived">待用</span>
                  )}
                </td>
                <td className="cell-ops">
                  {ev.id !== activeEventId && (
                    <button className="op good" onClick={() => activate(ev)}>设为当前</button>
                  )}
                  <button className="op" onClick={() => rename(ev)}>改名</button>
                  <button className="op" onClick={() => editEndTime(ev)}>结束时间</button>
                  <button className="op warn" onClick={() => del(ev)}>删除</button>
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={8} className="list-empty">暂无活动，请在上方创建</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
