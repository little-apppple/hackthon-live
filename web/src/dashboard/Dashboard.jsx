import React from 'react';
import Scale from '../Scale.jsx';
import { useSnapshot } from '../useSnapshot.js';
import KpiBar from './KpiBar.jsx';
import DeptGrid from './DeptGrid.jsx';
import Spotlight from './Spotlight.jsx';
import EventFeed from './EventFeed.jsx';

export default function Dashboard() {
  const { snapshot, connected } = useSnapshot();

  if (!snapshot) {
    return (
      <Scale>
        <div className="boot">
          <div className="boot-ring" />
          <div>正在连接赛事数据…</div>
        </div>
      </Scale>
    );
  }

  return (
    <Scale>
      <div className="dash">
        <header className="dash-header">
          <div className="header-left">
            <span className="live-dot" data-on={connected} title={connected ? '实时连接正常' : '连接中断，自动重连中'} />
            <span className="event-name">{snapshot.eventName}</span>
            <span className="header-sub">现场进度驾驶舱</span>
          </div>
          <div className="header-title">HACKATHON LIVE</div>
          <div className="header-right">
            <Countdown endTime={snapshot.eventEndTime} />
            <a className="admin-link" href="/admin" target="_blank" rel="noreferrer">管理后台</a>
          </div>
        </header>
        <div className="dash-body">
          <main className="dash-main">
            <KpiBar kpi={snapshot.kpi} />
            <DeptGrid departments={snapshot.departments} stages={snapshot.stages} />
          </main>
          <aside className="dash-side">
            <Spotlight loadingProjects={snapshot.loadingProjects} />
            <EventFeed events={snapshot.events} />
          </aside>
        </div>
      </div>
    </Scale>
  );
}

function Countdown({ endTime }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!endTime) return <div className="countdown hidden" />;
  const target = new Date(endTime).getTime();
  if (!Number.isFinite(target)) return null;
  let diff = Math.max(0, Math.floor((target - now) / 1000));
  const d = Math.floor(diff / 86400);
  diff -= d * 86400;
  const h = Math.floor(diff / 3600);
  diff -= h * 3600;
  const m = Math.floor(diff / 60);
  const s = diff - m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  const over = target <= now;
  return (
    <div className={`countdown ${over ? 'over' : ''}`}>
      <span className="cd-label">{over ? '已结束' : '距结束'}</span>
      <span className="cd-value">
        {d > 0 && `${d}天 `}
        {pad(h)}:{pad(m)}:{pad(s)}
      </span>
    </div>
  );
}
