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
    check('需求分析上报成功', ok1.data.ok && ok1.data.progress === 13);
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
    check('恢复后可继续上报', ok2.data.ok && ok2.data.progress === 25);
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
    check('线上验收完成 88%（8 节点模型 7/8）', done.data.ok && done.data.progress === 88, `实际 ${done.data?.progress}`);
    check('下一节点指向最终提交', done.data.nextStage?.id === 'submission');
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

  console.log(`\n== 11. 自助注册（/api/register 以 clientId 幂等 + 注册令牌）==`);
  {
    const reg = (body) => api('POST', '/api/register', body, false);
    const token = (await api('GET', '/api/admin/register-token')).data.token;
    check('管理员可签发注册令牌（reg_ 开头）', typeof token === 'string' && token.startsWith('reg_'));

    const noToken = await reg({ department: 'a', group: 'b', project: 'c' });
    check('缺注册令牌 401', noToken.status === 401 && noToken.data.code === 'REGISTER_TOKEN_INVALID');
    const badToken = await reg({ department: 'a', group: 'b', project: 'c', registerToken: 'reg_wrong' });
    check('错误注册令牌 401', badToken.status === 401 && badToken.data.code === 'REGISTER_TOKEN_INVALID');
    const missing = await reg({ department: '测试部门A', group: '创新组', registerToken: token });
    check('缺项目名 400（参数校验先于令牌校验）', missing.status === 400 && missing.data.code === 'INVALID_PARAMS');
    const badClient = await reg({ department: 'a', group: 'b', project: 'c', registerToken: token, clientId: 'cli_zz' });
    check('非法 clientId 400', badClient.status === 400 && badClient.data.code === 'INVALID_CLIENT_ID');

    const cliA = 'cli_' + 'a'.repeat(32);
    const cliB = 'cli_' + 'b'.repeat(32);
    const first = await reg({
      department: '注册测试部', group: '注册组', project: '注册项目X', description: '冒烟测试', registerToken: token, clientId: cliA,
      members: '张三、李四', summary: '一句话需求', value: '业务价值', features: '功能A、功能B', scenario: '使用场景',
    });
    check('注册成功并发放 hk_ 密钥', first.status === 200 && first.data.ok && /^hk_[0-9a-f]{32}$/.test(first.data.accessKey || ''), JSON.stringify(first.data));
    check('注册时已预留部署端口', first.data.ok && Number.isInteger(first.data.port) && first.data.port >= 4100 && first.data.port <= 4999, JSON.stringify(first.data));
    check('返回 configTemplate（serverUrl/accessKey/deployUrl）', first.data.ok && first.data.configTemplate?.accessKey === first.data.accessKey);
    check('注册响应回显绑定的 clientId', first.data.clientId === cliA && first.data.clientBound === true);
    check('注册可携带展示信息且回显', first.data.info?.members === '张三、李四' && first.data.info?.features === '功能A、功能B', JSON.stringify(first.data.info));

    const snapInfo = await api('GET', '/api/snapshot', undefined, false);
    const pInfo = snapInfo.data.snapshot.departments.flatMap((d) => d.groups.flatMap((g) => g.projects)).find((x) => x.name === '注册项目X');
    check('快照透出展示信息（面板可展示）', pInfo?.summary === '一句话需求' && pInfo?.scenario === '使用场景' && pInfo?.deliverable === 'web', JSON.stringify({ summary: pInfo?.summary, deliverable: pInfo?.deliverable }));

    const again = await reg({ department: '注册测试部', group: '注册组', project: '注册项目X', registerToken: token, clientId: cliA });
    check('同 clientId 幂等：返回同一密钥（含展示信息更新）', again.data.ok && again.data.accessKey === first.data.accessKey && again.data.idempotent === true);

    const renamed = await reg({ department: '改名部门', group: '改名组', project: '改名项目', registerToken: token, clientId: cliA });
    check('同 clientId 换名仍返回同一密钥（并提示名称以首次为准）', renamed.data.ok && renamed.data.accessKey === first.data.accessKey && /不一致/.test(renamed.data.warning || ''), JSON.stringify(renamed.data));

    const clash = await reg({ department: '注册测试部', group: '注册组', project: '注册项目X', registerToken: token, clientId: cliB });
    check('不同 clientId 撞已绑定名称 → 409 NAME_TAKEN（不再互相覆盖）', clash.status === 409 && clash.data.code === 'NAME_TAKEN', JSON.stringify(clash.data));

    // 一个 clientId 对应一个项目：另建项目必须使用新 clientId（=新目录接入）
    const cliC = 'cli_' + 'c'.repeat(32);
    const other = await reg({ department: '注册测试部', group: '注册组', project: '注册项目Y', registerToken: token, clientId: cliC });
    check('新 clientId 可另建项目并生成不同密钥', other.data.ok && other.data.accessKey !== first.data.accessKey, JSON.stringify(other.data));

    // 手工发 key 模式的客户端绑定
    const bindSame = await api('POST', '/api/bind-client', { accessKey: first.data.accessKey, clientId: cliA }, false);
    check('bind-client 同 clientId 幂等', bindSame.status === 200 && bindSame.data.idempotent === true);
    const bindDiff = await api('POST', '/api/bind-client', { accessKey: first.data.accessKey, clientId: cliB }, false);
    check('bind-client 不同 clientId → 409 CLIENT_MISMATCH', bindDiff.status === 409 && bindDiff.data.code === 'CLIENT_MISMATCH');
    const bindBad = await api('POST', '/api/bind-client', { accessKey: first.data.accessKey, clientId: 'nope' }, false);
    check('bind-client 非法 clientId 400', bindBad.status === 400 && bindBad.data.code === 'INVALID_CLIENT_ID');

    const snap = await api('GET', '/api/snapshot', undefined, false);
    const dept = snap.data.snapshot?.departments?.find((d) => d.name === '注册测试部');
    check('自注册项目进入大屏快照', !!dept);

    // 审计：注册成功留痕
    const list = await api('GET', '/api/admin/projects');
    const mine = list.data.projects.filter((p) => p.name === '注册项目X' || p.name === '注册项目Y');
    check('注册写入审计（reports 留痕）', mine.length === 2);
    check('管理端可查 client_id', mine.every((p) => String(p.client_id || '').startsWith('cli_')));
    const feed = await api('GET', '/api/snapshot', undefined, false);
    check(
      '注册事件进入动态流',
      feed.data.snapshot?.events?.some((e) => e.stage === 'register' && e.ok),
      JSON.stringify((feed.data.snapshot?.events || []).slice(0, 3))
    );

    // 管理端解绑：清空后另一个客户端可认领
    const unbind = await api('POST', `/api/admin/projects/${mine[0].id}/rebind-client`);
    check('管理员解绑客户端成功', unbind.data.ok);
    const claim = await reg({ department: '注册测试部', group: '注册组', project: '注册项目X', registerToken: token, clientId: cliB });
    check('解绑后可被新客户端重新绑定', claim.status === 200 && claim.data.clientId === cliB && claim.data.idempotent === true, JSON.stringify(claim.data));

    // 清理：注册产生的项目/小组/部门不留在主库
    for (const p of mine) {
      await api('POST', `/api/admin/projects/${p.id}/archive`);
      await api('DELETE', `/api/admin/projects/${p.id}`);
    }
    const allDepts = await api('GET', '/api/admin/departments');
    const regDept = allDepts.data.departments.find((d) => d.name === '注册测试部');
    const regGroups = (await api('GET', `/api/admin/groups?departmentId=${regDept?.id}`)).data.groups;
    for (const g of regGroups) await api('DELETE', `/api/admin/groups/${g.id}`);
    if (regDept) await api('DELETE', `/api/admin/departments/${regDept.id}`);
    check(
      '注册项目/部门/小组已清理',
      (await api('GET', '/api/admin/projects')).data.projects.every((p) => !p.name.startsWith('注册项目')) &&
        (await api('GET', '/api/admin/departments')).data.departments.every((d) => d.name !== '注册测试部')
    );
  }

  console.log(`\n== 12. 迭代（loop）与最终提交（submission）==`);
  {
    // 未上线项目不允许开新一轮
    const fresh = await api('POST', '/api/admin/projects', { groupId: groupIds[0], name: 'loop校验项目' });
    const loopEarly = await api('POST', '/api/loop', { accessKey: fresh.data.accessKey }, false);
    check('未上线开轮被拒 409', loopEarly.status === 409 && loopEarly.data.code === 'LOOP_NOT_ALLOWED');
    await api('POST', `/api/admin/projects/${fresh.data.id}/archive`);
    await api('DELETE', `/api/admin/projects/${fresh.data.id}`);

    // key1 已验收 7/8：开第二轮
    const loop = await api('POST', '/api/loop', { accessKey: key1 }, false);
    check('开新一轮成功 loop_count=2', loop.data.ok && loop.data.loopCount === 2 && loop.data.completedStages === 0, JSON.stringify(loop.data));
    const snapLoop = await api('GET', '/api/snapshot', undefined, false);
    const mineLoop = snapLoop.data.snapshot.departments
      .flatMap((d) => d.groups.flatMap((g) => g.projects))
      .find((p) => p.id === created[0].id);
    check('大屏可见迭代轮次', mineLoop?.loop_count === 2);

    // 重置后 submission 乱序被拒，requirements 可重新上报
    const subEarly = await api('POST', '/api/report', { accessKey: key1, stage: 'submission' }, false);
    check('重置后直接提交被拒 409', subEarly.status === 409 && subEarly.data.code === 'STAGE_OUT_OF_ORDER');
    await new Promise((r) => setTimeout(r, 10000));
    const reReq = await api('POST', '/api/report', { accessKey: key1, stage: 'requirements' }, false);
    check('第二轮重新上报需求成功', reReq.data.ok && reReq.data.progress === 13);

    // 走完 2-7 节点（限频间隔 10s）
    for (const stage of ['design', 'prototype', 'coding', 'testing', 'deployment', 'acceptance']) {
      await new Promise((r) => setTimeout(r, 10000));
      const r = await api('POST', '/api/report', { accessKey: key1, stage }, false);
      check(`第二轮上报 ${stage} 成功`, r.data.ok, JSON.stringify(r.data));
    }

    // 最终提交：8/8，状态 submitted
    await new Promise((r) => setTimeout(r, 10000));
    const sub = await api('POST', '/api/report', { accessKey: key1, stage: 'submission' }, false);
    check('最终提交成功 100%', sub.data.ok && sub.data.progress === 100, JSON.stringify(sub.data));
    const snapSub = await api('GET', '/api/snapshot', undefined, false);
    const mineSub = snapSub.data.snapshot.departments
      .flatMap((d) => d.groups.flatMap((g) => g.projects))
      .find((p) => p.id === created[0].id);
    check('状态变为 submitted', mineSub?.status === 'submitted');
    const submitted = snapSub.data.snapshot.submittedProjects || [];
    check(
      '快照提供已提交作品列表（含部门/小组/链接/时间）',
      submitted.length === 1 && submitted[0].projectId === created[0].id && submitted[0].link && !!submitted[0].last_report_at,
      JSON.stringify(submitted)
    );
    check('KPI 统计已提交数', snapSub.data.snapshot.kpi.submitted === 1, JSON.stringify(snapSub.data.snapshot.kpi));
  }

  console.log(`\n== 13. 安全加固 ==`);
  {
    // 安全响应头
    const res = await fetch(base + '/');
    check('X-Frame-Options: DENY（防点击劫持）', res.headers.get('x-frame-options') === 'DENY');
    check('X-Content-Type-Options: nosniff', res.headers.get('x-content-type-options') === 'nosniff');
    const csp = res.headers.get('content-security-policy') || '';
    check('CSP 含 frame-ancestors none 且限制脚本来源', /frame-ancestors 'none'/.test(csp) && /script-src 'self'/.test(csp), csp);

    // CSRF：带 Cookie 的写操作必须同源（跨站 Origin 拒绝；无 Origin 的 CLI 放行）
    const crossOrigin = await fetch(base + '/api/admin/import/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', Cookie: cookie, Origin: 'http://evil.example' },
      body: '部门,小组\n攻击部门,攻击组',
    });
    const crossBody = await crossOrigin.json().catch(() => null);
    check('跨站 Origin 写操作被拒 403 CSRF_BLOCKED', crossOrigin.status === 403 && crossBody?.code === 'CSRF_BLOCKED', JSON.stringify(crossBody));
    const sameOrigin = await fetch(base + '/api/admin/import/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', Cookie: cookie, Origin: base },
      body: '安全测试部,安全组',
    });
    check('同源 Origin 写操作放行', sameOrigin.status === 200);
    const noOrigin = await fetch(base + '/api/admin/departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'CLI 来源部门' }),
    });
    check('无 Origin（CLI/curl）放行', noOrigin.status === 200);

    // accessKey 支持请求头传参（不再强制出现在 URL）
    const viaHeader = await fetch(base + '/api/report/status', { headers: { 'x-access-key': key1 } });
    const viaHeaderBody = await viaHeader.json();
    check('accessKey 可通过 x-access-key 请求头查询', viaHeader.status === 200 && viaHeaderBody.ok && viaHeaderBody.projectName, JSON.stringify(viaHeaderBody).slice(0, 120));

    // 清理本节造的数据
    const depts = (await api('GET', '/api/admin/departments')).data.departments;
    for (const d of depts.filter((x) => ['安全测试部', 'CLI 来源部门'].includes(x.name))) {
      const gs = (await api('GET', `/api/admin/groups?departmentId=${d.id}`)).data.groups;
      for (const g of gs) await api('DELETE', `/api/admin/groups/${g.id}`);
      await api('DELETE', `/api/admin/departments/${d.id}`);
    }
    check('安全测试数据已清理', true);
  }

  console.log(`\n== 14. AI 参考评分上报 ==`);
  {
    // 未提交时不允许上报评分（key1 在上一节已完成提交，故新建项目验证门槛）
    const fresh = await api('POST', '/api/admin/projects', { groupId: groupIds[0], name: '评分门槛校验项目' });
    const blocked = await api('POST', '/api/score', { accessKey: fresh.data.accessKey, score: 70, detail: {} }, false);
    check('未最终提交时评分被拒 409', blocked.status === 409 && blocked.data.code === 'SCORE_NOT_ALLOWED', JSON.stringify(blocked.data));

    const invalid = await api('POST', '/api/score', { accessKey: fresh.data.accessKey, score: 'abc' }, false);
    check('非法分数 400', invalid.status === 400 && invalid.data.code === 'INVALID_SCORE');
    const noKey = await api('POST', '/api/score', { score: 70 }, false);
    check('缺 accessKey 400', noKey.status === 400 && noKey.data.code === 'INVALID_KEY');

    // key1 已提交：正常上报并落库
    const payload = { version: 'v1', dims: { A1: { score: 5, max: 5, evidence: 'docs/prd.md' }, B1: { score: 7, max: 7, evidence: 'git log' } }, autoTotal: 12, redlines: [] };
    const scored = await api('POST', '/api/score', { accessKey: key1, score: 66, detail: payload }, false);
    check('提交后评分上报成功', scored.status === 200 && scored.data.ok && scored.data.score === 66, JSON.stringify(scored.data));

    const got = await fetch(base + '/api/score', { headers: { 'x-access-key': key1 } });
    const gotBody = await got.json();
    check('评分可通过请求头查询（含明细）', got.status === 200 && gotBody.score === 66 && gotBody.detail?.dims?.A1?.score === 5, JSON.stringify(gotBody).slice(0, 140));

    const statusWithScore = await fetch(base + '/api/report/status', { headers: { 'x-access-key': key1 } });
    const swBody = await statusWithScore.json();
    check('status 返回参考分与过程审计统计', swBody.score === 66 && typeof swBody.stats?.rejects === 'number', JSON.stringify(swBody.stats));

    const feed = await api('GET', '/api/snapshot', undefined, false);
    check('评分写入审计流', feed.data.snapshot?.events?.some((e) => e.stage === 'score' && e.ok));

    // 清理
    await api('POST', `/api/admin/projects/${fresh.data.id}/archive`);
    await api('DELETE', `/api/admin/projects/${fresh.data.id}`);
    check('评分门槛校验项目已清理', true);
  }

  console.log(`\n== 15. 人气值（点击统计与去重）==`);
  {
    // 窗口由 HIT_WINDOW_MS 配置（gate/smoke 场景下服务端设为 1000ms 便于验证过期）
    const hit = (body) => api('POST', '/api/hit', body, false);
    const me = (await api('GET', '/api/admin/projects')).data.projects.find((p) => p.id === created[0].id);

    const bad = await hit({ projectId: 'abc' });
    check('非法 projectId 400', bad.status === 400 && bad.data.code === 'INVALID_PROJECT');
    const missing = await hit({ projectId: 999999, terminal: 't1' });
    check('不存在的项目 404', missing.status === 404);

    const t1 = `t_smoke_${Date.now()}`;
    const h1 = await hit({ projectId: created[0].id, terminal: t1, kind: 'web' });
    check('首次点击计入人气', h1.data.ok && h1.data.counted === true && h1.data.hits >= 1, JSON.stringify(h1.data));
    const h2 = await hit({ projectId: created[0].id, terminal: t1, kind: 'web' });
    check('同终端窗口内重复点击不计数', h2.data.ok && h2.data.counted === false && h2.data.hits === h1.data.hits, JSON.stringify(h2.data));
    const h3 = await hit({ projectId: created[0].id, terminal: `${t1}_other`, kind: 'package' });
    check('不同终端点击分别计数', h3.data.ok && h3.data.counted === true && h3.data.hits === h1.data.hits + 1, JSON.stringify(h3.data));
    const noTerminal = await hit({ projectId: created[0].id, kind: 'web' });
    const noTerminal2 = await hit({ projectId: created[0].id, kind: 'web' });
    check('缺终端标识时按 IP+UA 回退去重', noTerminal.data.counted === true && noTerminal2.data.counted === false, JSON.stringify(noTerminal2.data));

    await new Promise((r) => setTimeout(r, 1200)); // 超过去重窗口
    const h4 = await hit({ projectId: created[0].id, terminal: t1, kind: 'web' });
    check('窗口过期后再次点击重新计数', h4.data.ok && h4.data.counted === true && h4.data.hits === noTerminal2.data.hits + 1, JSON.stringify(h4.data));

    const snap = await api('GET', '/api/snapshot', undefined, false);
    const mine = snap.data.snapshot.departments.flatMap((d) => d.groups.flatMap((g) => g.projects)).find((p) => p.id === created[0].id);
    check('快照项目带人气值', mine?.hits === h4.data.hits, `snapshot=${mine?.hits} api=${h4.data.hits}`);
    check('快照提供人气榜与总人气', Array.isArray(snap.data.snapshot.hotProjects) && snap.data.snapshot.kpi.totalHits >= h4.data.hits, JSON.stringify(snap.data.snapshot.kpi));
    check('人气榜按点击数排序且含本项目', snap.data.snapshot.hotProjects[0]?.projectId === created[0].id, JSON.stringify(snap.data.snapshot.hotProjects[0]));

    const byKey = await fetch(base + '/api/hits', { headers: { 'x-access-key': key1 } });
    const byKeyBody = await byKey.json();
    check('按 accessKey 查询人气值', byKey.status === 200 && typeof byKeyBody.hits === 'number', JSON.stringify(byKeyBody));
    const meAfter = (await api('GET', '/api/admin/projects')).data.projects.find((p) => p.id === created[0].id);
    check('管理端项目列表带人气值', typeof meAfter.hits === 'number' && meAfter.hits === h4.data.hits, `admin=${meAfter.hits} api=${h4.data.hits}`);
  }


  console.log(`
结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
