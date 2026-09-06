import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// 名单管理：部门 / 小组 CRUD + CSV 批量导入（每行：部门,小组）；全部作用于所选活动
export default function RosterPanel({ eventId, onRosterChanged }) {
  const [departments, setDepartments] = useState([]);
  const [selectedDept, setSelectedDept] = useState(null);
  const [groups, setGroups] = useState([]);
  const [newDept, setNewDept] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [csv, setCsv] = useState('');
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  const ev = (url) => (url.includes('?') ? `${url}&eventId=${eventId}` : `${url}?eventId=${eventId}`);

  const loadDepts = useCallback(async () => {
    const { data } = await api.get(ev('/api/admin/departments'));
    if (data?.ok) {
      setDepartments(data.departments);
      setSelectedDept((cur) => (cur && data.departments.some((d) => d.id === cur) ? cur : data.departments[0]?.id ?? null));
    }
  }, [eventId]);

  const loadGroups = useCallback(async (deptId) => {
    if (!deptId) return setGroups([]);
    const { data } = await api.get(`/api/admin/groups?departmentId=${deptId}`);
    if (data?.ok) setGroups(data.groups);
  }, []);

  useEffect(() => {
    loadDepts();
  }, [loadDepts]);
  useEffect(() => {
    loadGroups(selectedDept);
  }, [selectedDept, loadGroups]);

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };
  const rosterChanged = () => {
    loadDepts();
    onRosterChanged?.();
  };

  const addDept = async () => {
    if (!newDept.trim()) return;
    const { ok, data } = await api.post(ev('/api/admin/departments'), { name: newDept.trim() });
    if (ok) {
      setNewDept('');
      rosterChanged();
      flash('部门已添加');
    } else flash(data?.error || '添加失败', false);
  };

  const renameDept = async (d) => {
    const name = prompt('修改部门名称', d.name);
    if (!name || name.trim() === d.name) return;
    const { ok, data } = await api.put(`/api/admin/departments/${d.id}`, { name: name.trim() });
    if (ok) {
      loadDepts();
      flash('已重命名');
    } else flash(data?.error || '失败', false);
  };

  const delDept = async (d) => {
    if (!confirm(`确认删除部门「${d.name}」？`)) return;
    const { ok, data } = await api.del(`/api/admin/departments/${d.id}`);
    if (ok) {
      loadDepts();
      flash('部门已删除');
    } else flash(data?.error || '失败', false);
  };

  const addGroup = async () => {
    if (!newGroup.trim() || !selectedDept) return;
    const { ok, data } = await api.post(ev('/api/admin/groups'), { departmentId: selectedDept, name: newGroup.trim() });
    if (ok) {
      setNewGroup('');
      loadGroups(selectedDept);
      loadDepts();
      flash('小组已添加');
    } else flash(data?.error || '添加失败', false);
  };

  const renameGroup = async (g) => {
    const name = prompt('修改小组名称', g.name);
    if (!name || name.trim() === g.name) return;
    const { ok, data } = await api.put(`/api/admin/groups/${g.id}`, { name: name.trim() });
    if (ok) {
      loadGroups(selectedDept);
      flash('已重命名');
    } else flash(data?.error || '失败', false);
  };

  const delGroup = async (g) => {
    if (!confirm(`确认删除小组「${g.name}」？`)) return;
    const { ok, data } = await api.del(`/api/admin/groups/${g.id}`);
    if (ok) {
      loadGroups(selectedDept);
      loadDepts();
      flash('小组已删除');
    } else flash(data?.error || '失败', false);
  };

  const importCsv = async () => {
    const text = csv.trim();
    if (!text) return;
    const { ok, data } = await api.postCsv(ev('/api/admin/import/csv'), text);
    if (ok) {
      setCsv('');
      loadDepts();
      flash(`导入完成：新增部门 ${data.deptCreated} 个，新增小组 ${data.groupCreated} 个${data.errors.length ? `，${data.errors.length} 行有误` : ''}`);
    } else flash(data?.error || '导入失败', false);
  };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result || ''));
    reader.readAsText(f, 'utf-8');
    e.target.value = '';
  };

  return (
    <div className="roster-panel">
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      <div className="roster-cols">
        <section className="admin-card">
          <h2>部门</h2>
          <div className="add-row">
            <input
              value={newDept}
              onChange={(e) => setNewDept(e.target.value)}
              placeholder="新部门名称"
              onKeyDown={(e) => e.key === 'Enter' && addDept()}
            />
            <button onClick={addDept}>添加</button>
          </div>
          <ul className="entity-list">
            {departments.map((d) => (
              <li key={d.id} className={d.id === selectedDept ? 'on' : ''} onClick={() => setSelectedDept(d.id)}>
                <span className="entity-name">
                  {d.name}
                  <em>{d.group_count} 组</em>
                </span>
                <span className="entity-ops">
                  <button title="重命名" onClick={(e) => { e.stopPropagation(); renameDept(d); }}>✎</button>
                  <button title="删除" onClick={(e) => { e.stopPropagation(); delDept(d); }}>✕</button>
                </span>
              </li>
            ))}
            {departments.length === 0 && <li className="list-empty">暂无部门</li>}
          </ul>
        </section>

        <section className="admin-card">
          <h2>
            小组 <em className="h-sub">{departments.find((d) => d.id === selectedDept)?.name || '未选择部门'}</em>
          </h2>
          <div className="add-row">
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              placeholder="新小组名称"
              disabled={!selectedDept}
              onKeyDown={(e) => e.key === 'Enter' && addGroup()}
            />
            <button onClick={addGroup} disabled={!selectedDept}>
              添加
            </button>
          </div>
          <ul className="entity-list">
            {groups.map((g) => (
              <li key={g.id}>
                <span className="entity-name">
                  {g.name}
                  <em>{g.project_count} 项目</em>
                </span>
                <span className="entity-ops">
                  <button title="重命名" onClick={() => renameGroup(g)}>✎</button>
                  <button title="删除" onClick={() => delGroup(g)}>✕</button>
                </span>
              </li>
            ))}
            {groups.length === 0 && <li className="list-empty">{selectedDept ? '暂无小组' : '请先选择部门'}</li>}
          </ul>
        </section>
      </div>

      <section className="admin-card">
        <h2>
          CSV 批量导入 <em className="h-sub">每行一条：部门,小组（小组可留空；支持表头 部门,小组）</em>
        </h2>
        <textarea
          className="csv-area"
          rows={6}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={'部门,小组\n研发中心,先锋队\n研发中心,破晓\n市场部,闪电组'}
        />
        <div className="csv-actions">
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
            选择 CSV 文件
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt" hidden onChange={onFile} />
          <button onClick={importCsv} disabled={!csv.trim()}>
            导入
          </button>
        </div>
      </section>
    </div>
  );
}
