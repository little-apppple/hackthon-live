import React from 'react';
import { NavLink } from 'react-router-dom';
import Scale from '../Scale.jsx';
import Ticker from './Ticker.jsx';
import NotificationCenter from '../dashboard/NotificationCenter.jsx';
import './zsjk.css';

const ASCII_LOGO = String.raw`
 _   _ _____ _   _ _____ _    _   _ ___ ___
| | | |_   _| | | | ____| |  | | | |_ _/ __|
| |_| | | | | |_| |  _| | |__| |_| || |\__ \
|  _  | | | |  _  | |___|____|  _  || |___) |
|_| |_| |_| |_| |_|_____|     |_| \___|____/
`;

// zsjk 四页共用骨架：stage 1920×1080 缩放 → pad(32/64) → 页面内容(flex:1) + ticker(56+20)
// syncOn=false 时 stage 加 .zk-off（岛卡/图表置灰、ticker 停止），由作战地图页开关控制
// 全局附加：通知中心（提交烟花/阶段气泡，?celebrate=1 彩排）+ ticker 上的连接状态与管理后台入口
export default function ZsjkShell({ snapshot, connected = true, syncOn = true, dimmable = false, children }) {
  const celebrate = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('celebrate') === '1';
  return (
    <Scale>
      <div className={`zk-stage ${dimmable && !syncOn ? 'zk-off' : ''}`}>
        <div className="zk-pad">
          <div className="zk-page">{children}</div>
          <Ticker events={snapshot?.events} running={syncOn} connected={connected} />
        </div>
        <nav className="zk-navpill">
          <NavLink to="/zsjk" end>首页</NavLink>
          <NavLink to="/zsjk/map">作战地图</NavLink>
          <NavLink to="/zsjk/island">岛屿详情</NavLink>
          <NavLink to="/zsjk/people">人员维度</NavLink>
        </nav>
        <NotificationCenter events={snapshot?.events} stages={snapshot?.stages} demoCelebrate={celebrate} />
      </div>
    </Scale>
  );
}

// 快照加载前的启动屏（复用旧大屏 boot 视觉）
export function ZsjkBoot() {
  return (
    <Scale>
      <div className="boot">
        <pre className="ascii-logo">{ASCII_LOGO.trim()}</pre>
        <div className="ascii-tag">SIGNAL LOST · CHANNEL 47</div>
        <div>
          searching for live feed<span className="ascii-cursor" />
        </div>
        <div className="boot-ring" />
        <div>正在连接赛事数据…</div>
      </div>
    </Scale>
  );
}
