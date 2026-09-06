'use strict';
// 端到端冒烟测试（UTF-8 安全，不经过控制台编码）：
//   node scripts/smoke.js [baseUrl]
const base = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '');
let cookie = '';
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function api(method, path, body, useAuth = true) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (useAuth && cookie) headers['Cookie'] = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

(async () => {
  console.log(`\n== 1. 认证 ==`);
  {
    const bad = await api('POST', '/api/admin/login', { password: 'wrong' }, false);
    check('错误密码被拒 401', bad.status === 401);
    const noAuth = await api('GET', '/api/admin/projects', undefined, false);
    check('未登录访问被拒 401', noAuth.status === 401);
    const login = await api('POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD || 'hackathon2026' }, false);
    check('正确密码登录成功', login.status === 200 && login.data.ok);
    cookie = (login.setCookie || '').split(';')[0];
    check('签发会话 Cookie', cookie.startsWith('hk_admin='));
  }

  console.log(`\n== 2. CSV 导入（UTF-8 中文）==`);
  const deptAId = { id: null };
  {
    const csv = '部门,小组\n测试部门A,创新组\n测试部门A,飞跃组\n测试部门B,';
    const res = await fetch(base + '/api/admin/import/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', Cookie: cookie },
      body: csv,
    });
    const d = await res.json();
    check('CSV 导入成功（重复导入幂等）', d.ok && Array.isArray(d.errors), JSON.stringify(d));
    const depts = await api('GET', '/api/admin/departments');
    const a = depts.data.departments.find((x) => x.name === '测试部门A');
    check('中文部门名正确存储', !!a);
    deptAId.id = a?.id;
    const groups = await api('GET', `/api/admin/groups?departmentId=${a?.id}`);
    check('中文小组名正确存储', groups.data.groups.some((g) => g.name === '创新组'));
  }

  console.log(`\n== 3. 创建项目（accesskey + 端口分配）==`);
  const created = [];
  const groupIds = [];
  {
    const groups = await api('GET', `/api/admin/groups?departmentId=${deptAId.id}`);
    check('CSV 导入的小组可用于建项目', groups.data.groups.length >= 2);
    for (let i = 0; i < 2; i++) {
      groupIds.push(groups.data.groups[i].id);
      const r = await api('POST', '/api/admin/projects', {
        groupId: groups.data.groups[i].id,
        name: i === 0 ? '智能周报助手' : '实时投票墙',
        description: '冒烟测试项目',
      });
      check(`项目${i + 1} 创建成功`, r.data.ok, JSON.stringify(r.data));
      check(`项目${i + 1} accesskey 格式`, /^hk_[0-9a-f]{32}$/.test(r.data.accessKey || ''));
      check(`项目${i + 1} 端口在池内`, r.data.port >= 4100 && r.data.port <= 4999);
      created.push(r.data);
    }
    check('端口不重复', created[0].port !== created[1].port);
  }
  const key1 = created[0].accessKey;

  console.log(`\n== 4. 大屏快照（loading 状态）==`);
  {
    const snap = await api('GET', '/api/snapshot', undefined, false);
    const s = snap.data.snapshot;
    check('快照可用', !!s);
    const projs = s.departments.flatMap((d) => d.groups.flatMap((g) => g.projects));
    const mine = projs.find((p) => p.id === created[0].id);
    check('新项目 status=loading', mine?.status === 'loading');
    check('loadingProjects 含新项目', s.loadingProjects.some((p) => p.projectId === created[0].id));
    check('链接主机正确', mine?.link === `http://localhost:${created[0].port}`);
  }

  console.log(`\n== 5. 上报强约束 ==`);
  {
    const noKey = await api('POST', '/api/report', { stage: 'requirements' }, false);
    check('缺 accesskey 400', noKey.status === 400 && noKey.data.code === 'INVALID_KEY');
    const badKey = await api('POST', '/api/report', { accessKey: 'hk_x', stage: 1 }, false);
    check('无效 accesskey 404', badKey.status === 404 && badKey.data.code === 'INVALID_KEY');
    const badStage = await api('POST', '/api/report', { accessKey: key1, stage: 'nope' }, false);
    check('非法节点 400', badStage.status === 400 && badStage.data.code === 'INVALID_STAGE');
    const skip = await api('POST', '/api/report', { accessKey: key1, stage: 'coding' }, false);
    check('跳节点被拒 409', skip.status === 409 && skip.data.code === 'STAGE_OUT_OF_ORDER');
    check('提示应上报节点', skip.data.expectedStage?.id === 'requirements');
    const ok1 = await api('POST', '/api/report', { accessKey: key1, stage: 1, message: '需求完成' }, false);
    check('需求分析上报成功', ok1.data.ok && ok1.data.progress === 14);
    const dup = await api('POST', '/api/report', { accessKey: key1, stage: 'requirements' }, false);
    check('重复上报被拒 409', dup.status === 409 && dup.data.code === 'STAGE_ALREADY_DONE');
    const throttled = await api('POST', '/api/report', { accessKey: key1, stage: 'design' }, false);
    check('限频 429', throttled.status === 429 && throttled.data.code === 'RATE_LIMITED');
    const st = await api('GET', `/api/report/status?accessKey=${key1}`, undefined, false);
    check('status 进度正确', st.data.completedStages === 1 && st.data.nextStage.id === 'design');
    check('status 返回预留端口', st.data.port === created[0].port);
  }

  console.log(`\n== 6. 吊销/恢复/归档（归档释放端口）==`);
  {
    await new Promise((r) => setTimeout(r, 10000)); // 等限频窗口
    await api('POST', `/api/admin/projects/${created[0].id}/revoke`);
    const rev = await api('POST', '/api/report', { accessKey: key1, stage: 'design' }, false);
    check('吊销后上报被拒 403', rev.status === 403 && rev.data.code === 'KEY_REVOKED');
    await api('POST', `/api/admin/projects/${created[0].id}/restore`);
    const ok2 = await api('POST', '/api/report', { accessKey: key1, stage: 'design' }, false);
    check('恢复后可继续上报', ok2.data.ok && ok2.data.progress === 29);
    // 归档项目2，端口应释放并被复用
    const before = created[1].port;
    await api('POST', `/api/admin/projects/${created[1].id}/archive`);
    const r3 = await api('POST', '/api/admin/projects', { groupId: groupIds[0], name: '端口复用验证' });
    check('归档释放端口被复用', r3.data.port === before, `期望 ${before} 实际 ${r3.data.port}`);
    await api('POST', `/api/admin/projects/${r3.data.id}/archive`);
  }

  console.log(`\n== 7. 部署链接开放（第 6 节点后）==`);
  let deployResp = null;
  {
    for (const stage of ['prototype', 'coding', 'testing', 'deployment']) {
      await new Promise((r) => setTimeout(r, 10000));
      const r = await api('POST', '/api/report', { accessKey: key1, stage }, false);
      check(`上报 ${stage} 成功`, r.data.ok, JSON.stringify(r.data));
      if (stage === 'deployment') deployResp = r;
    }
    check('部署响应携带服务端探活字段', deployResp && 'deployProbe' in deployResp.data);
    check('端口无服务时探活为 unreachable', deployResp?.data?.deployProbe === 'unreachable');
    const snap = await api('GET', '/api/snapshot', undefined, false);
    const mine = snap.data.snapshot.departments
      .flatMap((d) => d.groups.flatMap((g) => g.projects))
      .find((p) => p.id === created[0].id);
    check('状态变为 deployed', mine.status === 'deployed');
    await new Promise((r) => setTimeout(r, 10000)); // 避开限频窗口
    const done = await api('POST', '/api/report', { accessKey: key1, stage: 'acceptance' }, false);
    check('线上验收完成 100%', done.data.ok && done.data.progress === 100);
    check('deployLinkReady 标记', done.data.deployLinkReady === true);
    const snapDone = await api('GET', '/api/snapshot', undefined, false);
    check('验收完成后仍计入已部署 KPI', snapDone.data.snapshot.kpi.deployed >= 1, JSON.stringify(snapDone.data.snapshot.kpi));
    check('验收完成 KPI 计数', snapDone.data.snapshot.kpi.done >= 1);
  }

  console.log(`\n== 8. 审计 ==`);
  {
    const projects = await api('GET', '/api/admin/projects');
    check('项目列表可查', projects.data.ok);
    const events = await api('GET', '/api/snapshot', undefined, false);
    const rejects = events.data.snapshot.events.filter((e) => !e.ok);
    check('被拒上报进入动态流', rejects.length >= 3, `被拒 ${rejects.length} 条`);
  }

  console.log(`\n== 9. 活动隔离 ==`);
  {
    // 9.1 活动列表与默认活动
    const list1 = await api('GET', '/api/admin/events');
    check('活动列表可查', list1.data.ok && list1.data.events.length >= 1);
    const ev1 = list1.data.events.find((e) => e.id === list1.data.activeEventId);
    check('存在当前活动', !!ev1);

    // 9.2 创建第二期活动（默认待用）
    const created2 = await api('POST', '/api/admin/events', { name: '第二期测试活动' });
    check('创建第二期活动', created2.data.ok);
    const ev2Id = created2.data.id;

    // 9.3 第二期活动的部门不会出现在默认活动
    await api('POST', `/api/admin/departments?eventId=${ev2Id}`, { name: '活动二专属部门' });
    const dActive = await api('GET', '/api/admin/departments');
    check('当前活动看不到第二期部门', !dActive.data.departments.some((d) => d.name === '活动二专属部门'));
    const dEv2 = await api('GET', `/api/admin/departments?eventId=${ev2Id}`);
    check('第二期活动可见自己的部门', dEv2.data.departments.some((d) => d.name === '活动二专属部门'));

    // 9.4 大屏快照按活动隔离
    const snapActive = await api('GET', '/api/snapshot', undefined, false);
    const snapEv2 = await api('GET', `/api/snapshot?eventId=${ev2Id}`, undefined, false);
    check('当前活动快照不含第二期部门', !snapActive.data.snapshot.departments.some((d) => d.name === '活动二专属部门'));
    check('第二期快照只含自己的部门', snapEv2.data.snapshot.departments.length === 1 && snapEv2.data.snapshot.departments[0].name === '活动二专属部门');
    check('第二期快照活动名正确', snapEv2.data.snapshot.eventName === '第二期测试活动');
    check('第二期快照无项目', snapEv2.data.snapshot.kpi.projects === 0);

    // 9.5 同名部门在不同活动互不冲突（唯一约束是 event_id + name）
    const dup = await api('POST', `/api/admin/departments?eventId=${ev2Id}`, { name: '活动二专属部门' });
    check('同活动重名被拒', dup.status === 409);
    await api('POST', '/api/admin/departments', { name: '活动二专属部门' });
    const dActive2 = await api('GET', '/api/admin/departments');
    check('不同活动可同名部门', dActive2.data.departments.some((d) => d.name === '活动二专属部门'));

    // 9.6 切换当前活动：默认快照随之切换，切回后恢复
    await api('POST', `/api/admin/events/${ev2Id}/activate`);
    const list2 = await api('GET', '/api/admin/events');
    check('切换后 is_active 更新', list2.data.activeEventId === ev2Id);
    const snapAfter = await api('GET', '/api/snapshot', undefined, false);
    check('切换后默认快照展示第二期', snapAfter.data.snapshot.eventName === '第二期测试活动');
    await api('POST', `/api/admin/events/${ev1.id}/activate`);
    const snapBack = await api('GET', '/api/snapshot', undefined, false);
    check('切回后默认快照恢复', snapBack.data.snapshot.eventName === ev1.name && snapBack.data.snapshot.kpi.projects > 0);

    // 9.7 端口池跨活动全局唯一
    const dEv2b = await api('GET', `/api/admin/departments?eventId=${ev2Id}`);
    const gEv2 = await api('POST', '/api/admin/groups', { departmentId: dEv2b.data.departments[0].id, name: '第二期小组' });
    check('第二期小组创建', gEv2.data.ok);
    const p2 = await api('POST', '/api/admin/projects', { groupId: gEv2.data.id, name: '第二期项目' });
    check('第二期项目创建成功', p2.data.ok);
    check('端口与未归档项目不冲突', p2.data.port !== created[0].port, `第二期 ${p2.data.port} vs 智能周报助手 ${created[0].port}`);
    const listProjEv2 = await api('GET', `/api/admin/projects?eventId=${ev2Id}`);
    check('项目按活动隔离', listProjEv2.data.projects.length === 1 && listProjEv2.data.projects[0].name === '第二期项目');

    // 9.8 删除保护与清理
    const delFull = await api('DELETE', `/api/admin/events/${ev2Id}`);
    check('非空活动删除被拒', delFull.status === 409);
    for (const pr of listProjEv2.data.projects) {
      await api('POST', `/api/admin/projects/${pr.id}/archive`);
      const destroyed = await api('DELETE', `/api/admin/projects/${pr.id}`);
      check('归档项目可彻底删除', destroyed.data.ok, JSON.stringify(destroyed.data));
    }
    for (const dd of dEv2.data.departments) {
      const gs = await api('GET', `/api/admin/groups?departmentId=${dd.id}`);
      for (const g of gs.data.groups) await api('DELETE', `/api/admin/groups/${g.id}`);
      await api('DELETE', `/api/admin/departments/${dd.id}`);
    }
    const dActive3 = await api('GET', '/api/admin/departments');
    for (const dd of dActive3.data.departments.filter((d) => d.name === '活动二专属部门')) {
      await api('DELETE', `/api/admin/departments/${dd.id}`);
    }
    const delEmpty = await api('DELETE', `/api/admin/events/${ev2Id}`);
    check('清空后可删除第二期', delEmpty.data.ok, JSON.stringify(delEmpty.data));
  }

  console.log(`\n== 10. 端口区间配置 ==`);
  {
    // 10.1 默认区间（env 4100-4999）
    const pool0 = await api('GET', '/api/admin/ports');
    check('默认区间可查', pool0.data.ok && pool0.data.pool.start === 4100 && pool0.data.pool.end === 4999);

    // 10.2 非法区间被拒
    const bad1 = await api('PUT', '/api/admin/ports', { start: 200, end: 300 });
    check('小于 1024 被拒', bad1.status === 400);
    const bad2 = await api('PUT', '/api/admin/ports', { start: 4200, end: 4100 });
    check('起止倒置被拒', bad2.status === 400);
    const bad3 = await api('PUT', '/api/admin/ports', { start: 4100.5, end: 4200 });
    check('非整数被拒', bad3.status === 400);

    // 10.3 收缩到已预留端口之外被拒（智能周报助手占着 4100）
    const shrink = await api('PUT', '/api/admin/ports', { start: 4200, end: 4299 });
    check('排除已预留端口被拒', shrink.status === 409 && shrink.data.code === 'PORTS_OUTSIDE_RANGE', JSON.stringify(shrink.data));
    check('错误信息列出冲突端口', Array.isArray(shrink.data.ports) && shrink.data.ports.includes(created[0].port));

    // 10.4 改为覆盖已预留端口的区间 → 新项目从区间内分配（区间留足余量避开机器端口噪音）
    const narrow = await api('PUT', '/api/admin/ports', { start: 4100, end: 4199 });
    check('合法区间保存成功', narrow.data.ok && narrow.data.pool.start === 4100 && narrow.data.pool.end === 4199);
    const groups = await api('GET', '/api/admin/groups?departmentId=1');
    const inRange = await api('POST', '/api/admin/projects', { groupId: groups.data.groups[0].id, name: '窄区间项目' });
    check(
      '新项目端口落在新区间内且避开已占用',
      inRange.data.ok && inRange.data.port > 4100 && inRange.data.port <= 4199,
      JSON.stringify(inRange.data)
    );

    // 10.5 区间耗尽报错
    const full = await api('PUT', '/api/admin/ports', { start: 4100, end: 4101 });
    check('区间被占满仍可保存（只影响新分配）', full.data.ok);

    // 10.6 恢复默认区间并清理
    const restore = await api('PUT', '/api/admin/ports', { start: 4100, end: 4999 });
    check('恢复默认区间', restore.data.ok && restore.data.pool.end === 4999);
    await api('POST', `/api/admin/projects/${inRange.data.id}/archive`);
    const destroyed = await api('DELETE', `/api/admin/projects/${inRange.data.id}`);
    check('测试项目已清理', destroyed.data.ok);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
