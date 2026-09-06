import React, { useCallback, useEffect, useState } from 'react';
import { api, copyText } from '../api.js';

// 项目与密钥：创建项目（事务内生成 accesskey + 预留端口）、吊销/恢复/归档、端口池视图、部署管理
export default function ProjectsPanel({ eventId }) {
  const [departments, setDepartments] = useState([]);
  const [groups, setGroups] = useState([]);
  const [projects, setProjects] = useState([]);
  const [pool, setPool] = useState(null);
  const [meta, setMeta] = useState(null);
  const [deploys, setDeploys] = useState({});
  const [deptId, setDeptId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [created, setCreated] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [poolEdit, setPoolEdit] = useState(null);

  const loadAll = useCallback(async () => {
    const [d, g, p, port, m, dep] = await Promise.all([
      api.get(`/api/admin/departments?eventId=${eventId}`),
      api.get(`/api/admin/groups?eventId=${eventId}`),
      api.get(`/api/admin/projects?eventId=${eventId}`),
      api.get('/api/admin/ports'),
      api.get('/api/admin/meta'),
      api.get('/api/admin/deploys'),
    ]);
    if (d.data?.ok) {
      setDepartments(d.data.departments);
      setDeptId((cur) => (cur && d.data.departments.some((x) => x.id === +cur) ? cur : String(d.data.departments[0]?.id ?? '')));
    }
    if (g.data?.ok) setGroups(g.data.groups);
    if (p.data?.ok) setProjects(p.data.projects);
    if (port.data?.ok) setPool(port.data.pool);
    if (m.data?.ok) setMeta(m.data);
    if (dep.data?.ok) {
      setDeploys(Object.fromEntries((dep.data.deploys || []).map((x) => [x.projectId, x])));
    }
  }, [eventId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const deptGroups = groups.filter((g) => String(g.department_id) === String(deptId));

  const create = async () => {
    if (!groupId || !name.trim()) return flash('请选择小组并填写项目名称', false);
    const { ok, data } = await api.post('/api/admin/projects', {
      groupId: Number(groupId),
      name: name.trim(),
      description: desc.trim(),
    });
    if (ok) {
      setCreated(data);
      setName('');
      setDesc('');
      loadAll();
    } else flash(data?.error || '创建失败', false);
  };

  const act = async (p, action) => {
    const verb = { revoke: '吊销', restore: '恢复', archive: '归档' }[action];
    if (action === 'archive' && !confirm(`确认归档项目「${p.name}」？归档后端口释放、大屏不再显示。`)) return;
    if (action === 'revoke' && !confirm(`确认吊销「${p.name}」的 accesskey？该小组将无法继续上报。`)) return;
    const { ok, data } = await api.post(`/api/admin/projects/${p.id}/${action}`);
    if (ok) {
      flash(`已${verb}「${p.name}」`);
      loadAll();
    } else flash(data?.error || '操作失败', false);
  };

  const deployOp = async (p, action) => {
    const { ok, data } = await api.post(`/api/admin/deploys/${p.id}/${action}`);
    if (ok) {
      flash(`已${deployVerb[action]}「${p.name}」的部署`);
      loadAll();
    } else flash(data?.error || '操作失败', false);
  };

  const visible = projects.filter((p) => (showArchived ? true : !p.archived));
  const groupById = Object.fromEntries(groups.map((g) => [g.id, g]));

  return (
    <div className="projects-panel">
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      {created && <CreatedModal info={created} onClose={() => setCreated(null)} />}

      {pool && (
        <div className="pool-strip">
          端口池 {pool.start}–{pool.end}：已预留 <b>{pool.used}</b> / 空闲 <b className="good">{pool.free}</b>
          <button className="btn-ghost pool-adjust" onClick={() => setPoolEdit({ start: pool.start, end: pool.end, err: null, busy: false })}>
            调整区间
          </button>
        </div>
      )}
      {poolEdit && (
        <div className="modal-mask" onClick={() => setPoolEdit(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>调整端口区间</h2>
            <p className="modal-hint">
              新分配的项目端口将从该区间选取。区间持久保存，重启后仍生效；已预留端口必须保留在区间内（否则请先归档相应项目）。
            </p>
            <div className="pool-edit-row">
              <label>
                起始端口
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={poolEdit.start}
                  onChange={(e) => setPoolEdit({ ...poolEdit, start: e.target.value, err: null })}
                />
              </label>
              <span className="pool-dash">–</span>
              <label>
                结束端口
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={poolEdit.end}
                  onChange={(e) => setPoolEdit({ ...poolEdit, end: e.target.value, err: null })}
                />
              </label>
            </div>
            {poolEdit.err && <div className="form-err pool-err">{poolEdit.err}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setPoolEdit(null)}>
                取消
              </button>
              <button
                disabled={poolEdit.busy}
                onClick={async () => {
                  setPoolEdit({ ...poolEdit, busy: true, err: null });
                  const { ok, data } = await api.put('/api/admin/ports', {
                    start: Number(poolEdit.start),
                    end: Number(poolEdit.end),
                  });
                  if (ok) {
                    setPoolEdit(null);
                    flash('端口区间已更新');
                    loadAll();
                  } else {
                    setPoolEdit({
                      start: poolEdit.start,
                      end: poolEdit.end,
                      busy: false,
                      err: data?.ports?.length ? `${data.error}（${data.ports.join('、')}）` : data?.error || '保存失败',
                    });
                  }
                }}
              >
                {poolEdit.busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="admin-card">
        <h2>创建项目 · 生成 accesskey 并预留端口</h2>
        <div className="create-row">
          <select value={deptId} onChange={(e) => { setDeptId(e.target.value); setGroupId(''); }}>
            <option value="">选择部门</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">选择小组</option>
            {deptGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名称" />
          <input className="grow" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="项目简介（可选）" />
          <button onClick={create}>创建并生成密钥</button>
        </div>
      </section>

      <section className="admin-card">
        <h2>
          项目列表
          <button className="btn-ghost refresh-btn" onClick={loadAll}>刷新状态</button>
          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            显示已归档
          </label>
        </h2>
        <table className="proj-table">
          <thead>
            <tr>
              <th>部门</th>
              <th>小组</th>
              <th>项目</th>
              <th>端口</th>
              <th>进度</th>
              <th>状态</th>
              <th>部署</th>
              <th>accesskey</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} className={p.archived ? 'row-archived' : ''}>
                <td>{p.department_name}</td>
                <td>{p.group_name}</td>
                <td className="cell-name" title={p.description}>{p.name}</td>
                <td className="mono">{p.port}</td>
                <td>
                  <div className="mini-bar">
                    <div style={{ width: `${Math.round((p.completed_stages / 7) * 100)}%` }} />
                  </div>
                  <span className="mini-num">{Math.round((p.completed_stages / 7) * 100)}%</span>
                </td>
                <td>
                  <span className={`status-chip c-${p.archived ? 'archived' : p.revoked ? 'revoked' : p.status}`}>
                    {p.archived ? '已归档' : p.revoked ? '已吊销' : statusText(p.status)}
                  </span>
                </td>
                <td>
                  {deploys[p.id] ? (
                    <span
                      className={`status-chip ${DEPLOY_STATUS_CLASS[deploys[p.id].status] || ''}`}
                      title={deploys[p.id].lastDeployAt ? `部署于 ${deploys[p.id].lastDeployAt}` : ''}
                    >
                      {DEPLOY_STATUS_TEXT[deploys[p.id].status] || deploys[p.id].status}
                    </span>
                  ) : (
                    <span className="dim-cell">—</span>
                  )}
                </td>
                <td>
                  {!p.archived && (
                    <button className="key-btn mono" title="点击复制" onClick={async () => { await copyText(p.access_key); flash('accesskey 已复制'); }}>
                      {p.access_key.slice(0, 11)}…复制
                    </button>
                  )}
                </td>
                <td className="cell-ops">
                  {!p.archived && deploys[p.id] && deploys[p.id].status === 'running' && (
                    <button className="op" onClick={() => deployOp(p, 'stop')}>停止</button>
                  )}
                  {!p.archived && deploys[p.id] && ['crashed', 'failed', 'stopped'].includes(deploys[p.id].status) && (
                    <button className="op good" onClick={() => deployOp(p, 'start')}>启动</button>
                  )}
                  {!p.archived && deploys[p.id] && ['running', 'crashed'].includes(deploys[p.id].status) && (
                    <button className="op" onClick={() => deployOp(p, 'restart')}>重启</button>
                  )}
                  {!p.archived && p.revoked === 0 && (
                    <button className="op warn" onClick={() => act(p, 'revoke')}>吊销</button>
                  )}
                  {!p.archived && p.revoked === 1 && (
                    <button className="op good" onClick={() => act(p, 'restore')}>恢复</button>
                  )}
                  {!p.archived && (
                    <button className="op" onClick={() => act(p, 'archive')}>归档</button>
                  )}
                  {p.archived ? (
                    <button
                      className="op warn"
                      onClick={async () => {
                        if (!confirm(`彻底删除「${p.name}」？其审计记录将一并清除，不可恢复。`)) return;
                        const { ok: ok2, data: d2 } = await api.del(`/api/admin/projects/${p.id}`);
                        if (ok2) {
                          flash(`已彻底删除「${p.name}」`);
                          loadAll();
                        } else flash(d2?.error || '删除失败', false);
                      }}
                    >
                      彻底删除
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="list-empty">
                  暂无项目，请在上方创建
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {projects.some((p) => p.archived) && !showArchived && (
          <p className="archived-note">
            有 {projects.filter((p) => p.archived).length} 个已归档项目被隐藏（勾选"显示已归档"查看）
          </p>
        )}
      </section>
    </div>
  );
}

const DEPLOY_STATUS_TEXT = {
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  crashed: '已崩溃',
  failed: '启动失败',
};
const DEPLOY_STATUS_CLASS = {
  starting: 'c-active',
  running: 'c-deployed',
  stopped: 'c-archived',
  crashed: 'c-revoked',
  failed: 'c-revoked',
};
const deployVerb = { restart: '重启', stop: '停止', start: '启动' };

function statusText(s) {
  return { loading: '等待启动', active: '进行中', deployed: '已上线', done: '已完成' }[s] || s;
}

function CreatedModal({ info, onClose }) {
  const [copied, setCopied] = useState('');
  const cfg = JSON.stringify(info.configTemplate, null, 2);
  const copy = async (text, label) => {
    await copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>✅ 项目已创建，密钥与端口已预留</h2>
        <div className="kv">
          <span>部署端口</span>
          <b className="mono">{info.port}</b>
        </div>
        <div className="kv">
          <span>部署地址（上线后可访问）</span>
          <b className="mono">{info.deployUrl}</b>
        </div>
        <div className="kv">
          <span>accesskey{copied === 'key' ? '（已复制）' : '（点击复制）'}</span>
          <b className="mono key-copy" onClick={() => copy(info.accessKey, 'key')} title="点击复制">
            {info.accessKey}
          </b>
        </div>
        <p className="modal-hint">把下面的配置文件发给该小组，放到其参赛项目根目录 hackathon.config.json：</p>
        <pre className="cfg-pre">{cfg}</pre>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => copy(cfg, 'cfg')}>
            {copied === 'cfg' ? '已复制 ✓' : '复制配置'}
          </button>
          <button onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
