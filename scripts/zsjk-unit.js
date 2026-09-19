'use strict';
// zsjk 大屏聚合纯函数单测：node scripts/zsjk-unit.js
// 覆盖：members 拆分去重 / 岛院聚合（=部门，小组归并）/ 人员聚合（跨项目同名合并）/ KPI / 排序
// 口径与旧大屏一致：进度用快照 progress（加权），人气 hits 合计；revoked 项目随 deptTree 展示即计入
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(`  ✗ ${name}\n      ${e.message}`);
    console.log(`  ✗ ${name}`);
  }
}

// —— 测试夹具：与 /api/snapshot 的 departments（deptTree）同构 ——
function proj(id, name, over = {}) {
  return {
    id,
    name,
    hits: 0,
    progress: 0,
    members: '',
    deliverable: 'web',
    status: 'active',
    completed_stages: 1,
    revoked: false,
    ...over,
  };
}
function grp(id, name, projects) {
  return { id, name, progress: 0, projectCount: projects.length, projects };
}
function dept(id, name, progress, groups) {
  return {
    id,
    name,
    progress,
    groupCount: groups.length,
    projectCount: groups.reduce((s, g) => s + g.projectCount, 0),
    groups,
  };
}

(async () => {
  const m = await import('../web/src/zsjk/model.js');

  console.log('== splitMembers ==');
  await t('中英文分隔符混排拆分 + trim', () => {
    assert.deepStrictEqual(m.splitMembers('张三、李四,王五；赵六/孙七 周八'), [
      '张三', '李四', '王五', '赵六', '孙七', '周八',
    ]);
  });
  await t('同项目内去重 + 滤空', () => {
    assert.deepStrictEqual(m.splitMembers('张三、张三、 、李四'), ['张三', '李四']);
  });
  await t('空值容错', () => {
    assert.deepStrictEqual(m.splitMembers(''), []);
    assert.deepStrictEqual(m.splitMembers(null), []);
    assert.deepStrictEqual(m.splitMembers(undefined), []);
  });

  const departments = [
    dept(1, '道路院', 40, [
      grp(11, 'a组', [
        proj(101, '智慧道路', { hits: 10, progress: 30, members: '张三、李四', status: 'deployed', completed_stages: 6 }),
        proj(102, '道路巡检', { hits: 5, progress: 50, members: '王五', status: 'active', completed_stages: 3 }),
      ]),
      grp(12, 'b组', [proj(103, '路面AI', { progress: 40, members: '张三 / 赵六', status: 'active', completed_stages: 4 })]),
    ]),
    dept(2, '交规院', 80, [
      grp(13, 'c组', [proj(104, '信号优化', { hits: 20, progress: 100, members: '李四、王五', status: 'submitted', completed_stages: 8, deliverable: 'package' })]),
    ]),
    dept(3, '空岛院', 0, [grp(14, 'd组', [])]),
  ];

  console.log('== aggregateIslands（岛院=部门，小组归并）==');
  const islands = m.aggregateIslands(departments);
  await t('岛数 = 部门数，名称/id 透传', () => {
    assert.strictEqual(islands.length, 3);
    assert.deepStrictEqual(islands.map((i) => [i.id, i.name]), [[1, '道路院'], [2, '交规院'], [3, '空岛院']]);
  });
  await t('项目跨小组归并到岛院，顺序 = 快照组序', () => {
    assert.deepStrictEqual(islands[0].projects.map((p) => p.id), [101, 102, 103]);
    assert.strictEqual(islands[0].projectCount, 3);
  });
  await t('人气 = 岛内项目 hits 合计', () => {
    assert.strictEqual(islands[0].hits, 15);
    assert.strictEqual(islands[1].hits, 20);
    assert.strictEqual(islands[2].hits, 0);
  });
  await t('进度值 = 快照部门级 progress（同源不换算）', () => {
    assert.strictEqual(islands[0].progress, 40);
    assert.strictEqual(islands[2].progress, 0);
  });

  console.log('== aggregatePeople（跨项目同名合并）==');
  const people = m.aggregatePeople(departments);
  await t('同名跨项目合并为一人，参与项目计数', () => {
    const zhang = people.find((p) => p.name === '张三');
    assert.strictEqual(zhang.projectCount, 2);
    assert.deepStrictEqual(zhang.projects.map((p) => p.id), [101, 103]);
    const li = people.find((p) => p.name === '李四');
    assert.strictEqual(li.projectCount, 2);
  });
  await t('完成率 = 参与项目加权进度平均（四舍五入）', () => {
    const zhang = people.find((p) => p.name === '张三');
    assert.strictEqual(zhang.avgProgress, Math.round((30 + 40) / 2));
    const wang = people.find((p) => p.name === '王五');
    assert.strictEqual(wang.avgProgress, Math.round((50 + 100) / 2));
  });
  await t('人气 = 参与项目 hits 合计；岛院 = 参与项目所属岛院去重', () => {
    const zhang = people.find((p) => p.name === '张三');
    assert.strictEqual(zhang.hits, 10);
    assert.deepStrictEqual(zhang.islands, ['道路院']);
    const li = people.find((p) => p.name === '李四');
    assert.strictEqual(li.hits, 30);
    assert.deepStrictEqual(li.islands, ['道路院', '交规院']);
    assert.strictEqual(li.island, '道路院');
  });
  await t('revoked 项目计入参与（与旧屏 deptTree 展示口径一致）', () => {
    const withRevoked = [
      dept(9, 'X院', 10, [grp(91, 'g', [proj(901, 'p1', { members: '甲', revoked: true }), proj(902, 'p2', { members: '甲' })])]),
    ];
    const jia = m.aggregatePeople(withRevoked)[0];
    assert.strictEqual(jia.projectCount, 2);
  });
  await t('members 缺失的项目不产生幽灵人员', () => {
    assert.strictEqual(people.find((p) => p.name === ''), undefined);
  });

  console.log('== peopleKpis ==');
  const kpis = m.peopleKpis(people);
  await t('榜上人员 / 人均参与 / 平均完成率 / 最高人气', () => {
    // 人员：张三 李四 王五 赵六 = 4；参与人次 = 2+2+2+1 = 7 → 人均 1.75
    assert.strictEqual(kpis.total, 4);
    assert.strictEqual(kpis.avgPer, 1.75);
    assert.strictEqual(kpis.avgCompletion, Math.round((35 + 65 + 75 + 40) / 4));
    assert.strictEqual(kpis.maxHits, 30);
  });
  await t('空数据全 0', () => {
    assert.deepStrictEqual(m.peopleKpis([]), { total: 0, avgPer: 0, avgCompletion: 0, maxHits: 0 });
  });

  console.log('== 口径一致性加固（评审补充）==');
  await t('aggregateIslands：revoked 项目计入岛院计数与人气（与旧屏 deptTree 口径一致）', () => {
    const withRevoked = [
      dept(9, 'X院', 10, [grp(91, 'g', [proj(901, 'p1', { members: '甲', revoked: true, hits: 7 }), proj(902, 'p2', { members: '乙' })])]),
    ];
    const isl = m.aggregateIslands(withRevoked)[0];
    assert.strictEqual(isl.projectCount, 2);
    assert.strictEqual(isl.hits, 7);
  });
  await t('data/seed-zsjk.json 的岛名与发布图固定名单完全一致（防改名/写错静默落兜底组）', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed-zsjk.json'), 'utf8'));
    const names = (seed.departments || []).map((d) => (typeof d === 'string' ? d : d.name));
    assert.deepStrictEqual(names, m.ISLAND_ORDER);
  });

  console.log('== sortPeople ==');
  await t('默认按参与项目数降序，同数按人气降序', () => {
    const sorted = m.sortPeople(people, 'projectCount', 'desc');
    assert.strictEqual(sorted[0].projectCount, 2);
    assert.strictEqual(sorted[0].hits >= sorted[1].hits, true);
  });
  await t('升序切换 + 人气列排序', () => {
    const byHitsAsc = m.sortPeople(people, 'hits', 'asc');
    assert.strictEqual(byHitsAsc[0].hits, 0);
    const byHitsDesc = m.sortPeople(people, 'hits', 'desc');
    assert.strictEqual(byHitsDesc[0].hits, 30);
  });

  console.log('== 六岛固定分组与顺序（业务岛/职能岛）==');
  const sixIslands = ['道路院岛', '交规院岛', '景观院岛', '隧交院岛', '技术经营岛', '管理支撑岛'].map(
    (name, i) => ({ id: 100 + i, name, projectCount: 1, progress: 0, hits: 0, projects: [] })
  );
  await t('分组配置固定：业务岛 4 岛 + 职能岛 2 岛，成员按发布图顺序', () => {
    assert.deepStrictEqual(
      m.ISLAND_GROUPS.map((g) => g.name),
      ['业务岛', '职能岛']
    );
    assert.deepStrictEqual(m.ISLAND_GROUPS[0].islands, ['交规院岛', '道路院岛', '隧交院岛', '景观院岛']);
    assert.deepStrictEqual(m.ISLAND_GROUPS[1].islands, ['管理支撑岛', '技术经营岛']);
  });
  await t('groupIslands：六岛按组归位，组内顺序 = 发布图顺序（与数据序无关）', () => {
    const groups = m.groupIslands(sixIslands);
    assert.deepStrictEqual(
      groups.map((g) => [g.name, g.islands.map((i) => i.name)]),
      [
        ['业务岛', ['交规院岛', '道路院岛', '隧交院岛', '景观院岛']],
        ['职能岛', ['管理支撑岛', '技术经营岛']],
      ]
    );
  });
  await t('groupIslands：名单外的岛院归入「其他岛院」追加在末尾（保持数据序）', () => {
    const withExtra = [...sixIslands, { id: 200, name: '客串院岛', projectCount: 0, progress: 0, hits: 0, projects: [] }];
    const groups = m.groupIslands(withExtra);
    assert.strictEqual(groups.length, 3);
    assert.deepStrictEqual(groups[2].name, '其他岛院');
    assert.deepStrictEqual(groups[2].islands.map((i) => i.name), ['客串院岛']);
  });
  await t('groupIslands：缺岛不出空组，空数据返回空数组', () => {
    const partial = m.groupIslands(sixIslands.slice(0, 1));
    assert.deepStrictEqual(partial.map((g) => g.name), ['业务岛']);
    assert.deepStrictEqual(m.groupIslands([]), []);
  });
  await t('orderIslands：按发布图顺序重排，名单外岛院排在已知岛之后（稳定按 id）', () => {
    const ordered = m.orderIslands(sixIslands);
    assert.deepStrictEqual(ordered.map((i) => i.name), [
      '交规院岛', '道路院岛', '隧交院岛', '景观院岛', '管理支撑岛', '技术经营岛',
    ]);
    const withIds = [
      { id: 9, name: '客串院岛' },
      { id: 2, name: '道路院岛' },
      { id: 8, name: '另一院岛' },
      { id: 1, name: '交规院岛' },
    ];
    assert.deepStrictEqual(m.orderIslands(withIds).map((i) => [i.name, i.id]), [
      ['交规院岛', 1],
      ['道路院岛', 2],
      ['另一院岛', 8],
      ['客串院岛', 9],
    ]);
  });

  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('单测异常:', e);
  process.exit(1);
});
