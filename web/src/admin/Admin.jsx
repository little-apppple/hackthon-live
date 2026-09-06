import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import RosterPanel from './RosterPanel.jsx';
import ProjectsPanel from './ProjectsPanel.jsx';
import EventsPanel from './EventsPanel.jsx';

export default function Admin() {
  const [authed, setAuthed] = useState(null); // null = 检查中
  const [tab, setTab] = useState('projects');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState([]);
  const [activeEventId, setActiveEventId] = useState(null); // 服务器当前活动
  const [eventId, setEventId] = useState(null); // 后台正在管理的活动

  const loadEvents = async (keepCurrent = true) => {
    const { data } = await api.get('/api/admin/events');
    if (data?.ok) {
      setEvents(data.events);
      setActiveEventId(data.activeEventId);
      setEventId((cur) => (keepCurrent && cur && data.events.some((e) => e.id === cur) ? cur : data.activeEventId));
    }
  };

  useEffect(() => {
    api.get('/api/admin/me').then(({ data }) => setAuthed(!!data?.authed));
  }, []);

  useEffect(() => {
    if (authed) loadEvents();
  }, [authed]);

  const login = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    const { ok, data } = await api.post('/api/admin/login', { password });
    setBusy(false);
    if (ok) setAuthed(true);
    else setErr(data?.error || '登录失败');
  };

  const logout = async () => {
    await api.post('/api/admin/logout');
    setAuthed(false);
  };

  if (authed === null) return <div className="admin-page"><div className="boot"><div className="boot-ring" /></div></div>;

  if (!authed) {
    return (
      <div className="admin-page">
        <form className="login-card" onSubmit={login}>
          <h1>赛事管理后台</h1>
          <p className="login-hint">请输入管理员密码</p>
          <input
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            placeholder="管理密码（环境变量 ADMIN_PASSWORD）"
          />
          {err && <div className="form-err">{err}</div>}
          <button disabled={busy || !password}>{busy ? '登录中…' : '登录'}</button>
          <a className="login-back" href="/">← 返回大屏</a>
        </form>
      </div>
    );
  }

  const currentEvent = events.find((e) => e.id === eventId);
  const isViewingActive = eventId === activeEventId;

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-title">
          <span className="live-dot" data-on="true" />
          黑客松大屏 · 管理后台
        </div>
        <div className="event-switch">
          <span className="es-label">管理活动</span>
          <select
            value={eventId ?? ''}
            onChange={(e) => setEventId(Number(e.target.value))}
          >
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
                {ev.id === activeEventId ? '（当前）' : ''}
              </option>
            ))}
          </select>
          {!isViewingActive && currentEvent && (
            <button
              className="btn-ghost es-activate"
              onClick={async () => {
                if (!confirm(`把「${currentEvent.name}」设为当前活动？大屏默认展示将随之切换。`)) return;
                await api.post(`/api/admin/events/${eventId}/activate`);
                loadEvents();
              }}
            >
              设为当前
            </button>
          )}
        </div>
        <nav className="admin-tabs">
          <button className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>
            项目与密钥
          </button>
          <button className={tab === 'roster' ? 'on' : ''} onClick={() => setTab('roster')}>
            名单管理
          </button>
          <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>
            活动管理
          </button>
        </nav>
        <button className="btn-ghost" onClick={logout}>
          退出登录
        </button>
      </header>
      <main className="admin-main">
        {tab === 'projects' && eventId !== null && <ProjectsPanel key={eventId} eventId={eventId} />}
        {tab === 'roster' && eventId !== null && <RosterPanel key={eventId} eventId={eventId} onRosterChanged={loadEvents} />}
        {tab === 'events' && <EventsPanel onChanged={() => loadEvents()} activeEventId={activeEventId} />}
      </main>
    </div>
  );
}
