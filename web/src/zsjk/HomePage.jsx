import React from 'react';
import ZsjkShell, { ZsjkBoot } from './ZsjkShell.jsx';
import { useSnapshot } from '../useSnapshot.js';
import SubmittedList from '../dashboard/SubmittedList.jsx';
import ProjectDetail from '../dashboard/ProjectDetail.jsx';

// 首页：banner(170) + video-row(420, mock) + bottom-row(310：讲师 mock + 3 天流程 mock + 参赛接入卡)
// 预算 170+20+420+20+310+ticker76 = 1016

// mock 占位：视频/讲师/流程待真实素材到位后替换（spec §8）
const VIDEOS = [
  { tag: '开幕回放', dur: '12:48', title: 'AI创变营 · 开幕式', desc: '赛道解读与规则说明' },
  { tag: '赛队采访', dur: '05:21', title: '岛院赛队 · 采访实录', desc: '立项思路与备赛日常' },
  { tag: '花絮集锦', dur: '08:03', title: '现场花絮 · 集锦', desc: ' coding 深夜与 coffee' },
];

const FLOW = [
  { day: 'Day 1', date: 'D1 · 上午', title: '组队开题', desc: '岛院组队、领取技能包，AI Agent 自助报名立项' },
  { day: 'Day 2', date: 'D2 · 全天', title: '开发冲刺', desc: '八节点推进，上线部署与自动化验收' },
  { day: 'Day 3', date: 'D3 · 下午', title: '路演评审', desc: '最终提交定格评分版本，现场路演与颁奖' },
];

export default function HomePage() {
  const { snapshot, connected } = useSnapshot();
  const [detail, setDetail] = React.useState(null);
  if (!snapshot) return <ZsjkBoot />;
  return (
    <ZsjkShell snapshot={snapshot} connected={connected}>
      <div className="zk-banner">
        <div className="zk-banner-left">
          <h1 className="zk-h1">
            招商交科<em> · </em>AI创变营
          </h1>
          <p className="zk-banner-sub">
            企业黑客松现场进度驾驶舱：以「岛院」为作战单位，AI Agent 按八节点上报真实进度，
            上线部署与线上验收由服务端机器验证——大屏实时呈现每座岛院的立项、进度与人气。
          </p>
        </div>
        <div className="zk-metas">
          <div className="zk-meta is-wide">
            <span className="zk-meta-label">距结束</span>
            <span className="zk-meta-value is-red is-count">
              <CountdownText endTime={snapshot.eventEndTime} />
            </span>
          </div>
          <div className="zk-meta">
            <span className="zk-meta-label">立项数</span>
            <span className="zk-meta-value">
              {snapshot.kpi.projects}
              <small>个</small>
            </span>
          </div>
          <div className="zk-meta">
            <span className="zk-meta-label">已上线</span>
            <span className="zk-meta-value">
              {snapshot.kpi.deployed}
              <small>队</small>
            </span>
          </div>
          <div className="zk-meta">
            <span className="zk-meta-label">已提交</span>
            <span className="zk-meta-value">
              {snapshot.kpi.submitted}
              <small>队</small>
            </span>
          </div>
        </div>
      </div>

      <div className="zk-videos">
        {VIDEOS.map((v) => (
          <div className="zk-video" key={v.title}>
            <div className="zk-vcover">
              <span className="zk-vtag">{v.tag}</span>
              <span className="zk-vplay">▶</span>
              <span className="zk-vdur">{v.dur}</span>
            </div>
            <div className="zk-vmeta">
              <b>{v.title}</b>
              <span>{v.desc}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="zk-bottom">
        <div className="zk-card">
          <div className="zk-card-title">
            带队讲师
            <span className="t-dim">HOST</span>
          </div>
          <div className="zk-host">
            <div className="zk-host-avatar">师</div>
            <div className="zk-host-info">
              <span className="zk-host-name">待公布</span>
              <span className="zk-host-role">AI创变营 · 领队导师</span>
              <div className="zk-host-bio">
                占位简介：带队讲师信息确定后在此展示（头像 / 姓名 / 职务 / 一句话简介）。
              </div>
            </div>
          </div>
        </div>

        <div className="zk-card">
          <div className="zk-card-title">
            3 天流程
            <span className="t-dim">AGENDA</span>
          </div>
          <div className="zk-flow">
            {FLOW.map((f) => (
              <div className="zk-flow-col" key={f.day}>
                <span className="zk-flow-day">{f.day}</span>
                <span className="zk-flow-date">{f.date}</span>
                <span className="zk-flow-title">{f.title}</span>
                <span className="zk-flow-desc">{f.desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="zk-card">
          <div className="zk-card-title">
            参赛接入
            <span className="t-dim">AI AGENT 自助报名</span>
          </div>
          <JoinCard />
        </div>

        <div className="zk-card">
          <div className="zk-card-title">
            已提交作品
            <span className="t-dim">{snapshot.submittedProjects.length} 队 · 定格评分版本</span>
          </div>
          <div className="zk-embed">
            <SubmittedList items={snapshot.submittedProjects} onOpenDetail={setDetail} />
          </div>
        </div>
      </div>

      <ProjectDetail project={detail} stages={snapshot.stages} onClose={() => setDetail(null)} />
    </ZsjkShell>
  );
}

// 可复制接入卡：下载课程物料包 → 粘贴提示词给 AI 编程助手 → 自动装技能并引导报名
const INIT_PROMPT =
  '请在项目级安装此压缩包里的 4 个 skill（hackathon-reporter、vibecoding-workflow、superpowers、agent-browser），' +
  '安装完成后引导我完成参赛报名：依次向我询问 岛院名、项目名、项目详情（参与人员、需求、价值、功能、场景；小组未单独提供时用项目名代替），' +
  '然后执行 node skill/hackathon-reporter/scripts/report.js --init 完成报名（幂等），并按八节点流程驱动比赛推进与上报。';

function JoinCard() {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INIT_PROMPT);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = INIT_PROMPT;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <>
      <div className="zk-join-steps">
        <span>
          <b className="st">①</b>
          <a className="zk-join-dl" href="/api/course-pack" download="ai-camp-course-pack.tgz" title="下载课程物料包（含参赛上报技能 + superpowers + agent-browser，已内置上报地址）">
            下载课程物料包
          </a>
          ，解压到参赛项目根目录
        </span>
        <span>
          <b className="st">②</b>
          <b>复制下方提示词</b>发给 AI 编程助手：它会装好全部技能，并逐项问你报名信息
        </span>
        <span>
          <b className="st">③</b>
          <b>完成报名</b>：自动录入名单、预留部署端口，大屏即可见你的岛院
        </span>
      </div>
      <div className="zk-cmd">
        请在项目级安装此压缩包里的 4 个 skill（hackathon-reporter、vibecoding-workflow、superpowers、agent-browser），安装完成后引导我完成参赛报名：依次向我询问 岛院名、项目名、项目详情（参与人员、需求、价值、功能、场景；小组未单独提供时用项目名代替），然后执行 node skill/hackathon-reporter/scripts/report.js --init 完成报名（幂等），并按八节点流程驱动比赛推进与上报。
        <button className={`zk-cmd-copy ${copied ? 'ok' : ''}`} onClick={copy} title="复制提示词">
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <div className="zk-join-hint">报名信息之后也能在对话里补充，AI 会同步到大屏展示；重复执行幂等。</div>
    </>
  );
}

function CountdownText({ endTime }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!endTime) return '进行中';
  const target = new Date(endTime).getTime();
  if (!Number.isFinite(target)) return '进行中';
  if (target <= now) return '已结束';
  let diff = Math.max(0, Math.floor((target - now) / 1000));
  const d = Math.floor(diff / 86400);
  diff -= d * 86400;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff - h * 3600) / 60);
  const s = diff - h * 3600 - m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    <>
      {d > 0 ? `${d}天 ` : ''}
      {pad(h)}:{pad(m)}:{pad(s)}
    </>
  );
}
