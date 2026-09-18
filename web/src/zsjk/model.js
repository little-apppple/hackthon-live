// zsjk 大屏聚合纯函数：消费 /api/snapshot 的 departments（deptTree），不碰 JSX、不发请求
// 口径与旧大屏同源：进度用快照 progress（加权），人气 = 项目 hits 合计；revoked 项目随 deptTree 展示即计入

const MEMBER_SEP = /[、，,;；/／|\s]+/;

// "张三、李四, 王五" → ['张三', '李四', '王五']：多分隔符拆分、trim、滤空、组内去重
export function splitMembers(str) {
  if (!str) return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(str).split(MEMBER_SEP)) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// 岛院列表（岛院 = 部门，小组层级归并不展示）：项目按快照组序平铺
export function aggregateIslands(departments) {
  return (departments || []).map((d) => {
    const projects = (d.groups || []).flatMap((g) => g.projects || []);
    return {
      id: d.id,
      name: d.name,
      progress: d.progress || 0,
      projectCount: projects.length,
      hits: projects.reduce((s, p) => s + (p.hits || 0), 0),
      projects,
    };
  });
}

// 全部项目平铺（带所属岛院），供岛屿详情「全部岛院」视图使用
export function flattenIslandProjects(departments) {
  return aggregateIslands(departments).flatMap((island) =>
    island.projects.map((p) => ({ ...p, islandId: island.id, islandName: island.name }))
  );
}

// 人员维度：members 跨项目拆分，同名合并为一人
export function aggregatePeople(departments) {
  const byName = new Map();
  for (const island of aggregateIslands(departments)) {
    for (const p of island.projects) {
      for (const name of splitMembers(p.members)) {
        let person = byName.get(name);
        if (!person) {
          person = { name, projects: [], islands: [], hits: 0 };
          byName.set(name, person);
        }
        person.projects.push(p);
        person.hits += p.hits || 0;
        if (!person.islands.includes(island.name)) person.islands.push(island.name);
      }
    }
  }
  const people = [...byName.values()];
  for (const person of people) {
    person.island = person.islands[0] || null;
    person.projectCount = person.projects.length;
    person.avgProgress = person.projectCount
      ? Math.round(person.projects.reduce((s, p) => s + (p.progress || 0), 0) / person.projectCount)
      : 0;
  }
  return people;
}

// 人员维度 KPI 四卡：榜上人员 / 人均参与 / 平均完成率 / 最高人气
export function peopleKpis(people) {
  if (!people || people.length === 0) return { total: 0, avgPer: 0, avgCompletion: 0, maxHits: 0 };
  const participations = people.reduce((s, p) => s + p.projectCount, 0);
  return {
    total: people.length,
    avgPer: Math.round((participations / people.length) * 100) / 100,
    avgCompletion: Math.round(people.reduce((s, p) => s + p.avgProgress, 0) / people.length),
    maxHits: people.reduce((m, p) => Math.max(m, p.hits), 0),
  };
}

// 岛院分组与顺序（固定口径，来源：赛事发布图 2026-09）：业务岛 4 座 + 职能岛 2 座
// 名单中出现配置之外的岛院时，地图归入「其他岛院」组、排序排在已知岛之后，保证注册新建岛院仍可见
export const ISLAND_GROUPS = [
  { name: '业务岛', islands: ['交规院岛', '道路院岛', '隧交院岛', '景观院岛'] },
  { name: '职能岛', islands: ['管理支撑岛', '技术经营岛'] },
];
export const ISLAND_ORDER = ISLAND_GROUPS.flatMap((g) => g.islands);

// 岛院列表 → [{name:'业务岛', islands:[...]}, ...]；组内顺序 = 发布图顺序，缺岛不出空组
export function groupIslands(islands) {
  const byName = new Map((islands || []).map((i) => [i.name, i]));
  const used = new Set();
  const groups = ISLAND_GROUPS.map((g) => {
    const members = g.islands.map((n) => byName.get(n)).filter(Boolean);
    for (const m of members) used.add(m.name);
    return { name: g.name, islands: members };
  });
  const rest = (islands || []).filter((i) => !used.has(i.name));
  if (rest.length > 0) groups.push({ name: '其他岛院', islands: rest });
  return groups.filter((g) => g.islands.length > 0);
}

// 展示顺序：发布图固定顺序优先（详情页下拉/列表用），未知岛院排在其后、稳定按 id
export function orderIslands(islands) {
  const rank = new Map(ISLAND_ORDER.map((n, i) => [n, i]));
  return [...(islands || [])].sort((a, b) => {
    const ra = rank.has(a.name) ? rank.get(a.name) : ISLAND_ORDER.length;
    const rb = rank.has(b.name) ? rank.get(b.name) : ISLAND_ORDER.length;
    if (ra !== rb) return ra - rb;
    return (a.id || 0) - (b.id || 0);
  });
}

const PEOPLE_KEYS = {
  projectCount: (p) => p.projectCount,
  hits: (p) => p.hits,
  avgProgress: (p) => p.avgProgress,
  name: (p) => p.name,
};

// 表头排序：key ∈ PEOPLE_KEYS，dir ∈ asc/desc；默认参与项目数降序（同数按人气降序）
export function sortPeople(people, key = 'projectCount', dir = 'desc') {
  const get = PEOPLE_KEYS[key] || PEOPLE_KEYS.projectCount;
  const mul = dir === 'asc' ? 1 : -1;
  return [...(people || [])].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb), 'zh') * mul;
    if (vb !== va) return (va - vb) * mul; // 数值列：desc 大在前
    return b.hits - a.hits; // 平局：人气高的在前
  });
}
