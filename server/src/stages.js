'use strict';

// 八个流程节点：进度为纯离散模型，progress = completedStages / STAGES.length * 100
// 第 8 节点 submission（最终提交）只能由参赛者本人经 CLI 交互确认后上报，作为最终参赛待评分作品
// weight：进度加权（按真实耗时分布，避免「写完 PRD 就 25%」的观感误差）
// audience：面向现场观众的通俗说法（悬停/副文案展示，不改节点语义）
// verified：该节点是否由服务端机器验证（部署/验收），用于区分「自报」与「已验证」
const STAGES = [
  { index: 1, id: 'requirements', name: '需求分析', audience: '有想法了', weight: 5, verified: false },
  { index: 2, id: 'design', name: '方案设计', audience: '方案定了', weight: 5, verified: false },
  { index: 3, id: 'prototype', name: '原型设计', audience: '有样子了', weight: 5, verified: false },
  { index: 4, id: 'coding', name: '代码开发', audience: '在写代码', weight: 30, verified: false },
  { index: 5, id: 'testing', name: '本地测试', audience: '在自测', weight: 15, verified: false },
  { index: 6, id: 'deployment', name: '上线部署', audience: '能玩了', weight: 15, verified: true },
  { index: 7, id: 'acceptance', name: '线上验收', audience: '机器验过', weight: 15, verified: true },
  { index: 8, id: 'submission', name: '最终提交', audience: '定稿提交', weight: 10, verified: true },
];

const DEPLOY_STAGE_INDEX = 6; // 上线部署完成即开放链接
const DONE_STAGE_INDEX = 7; // 线上验收完成
const LOOP_MIN_STAGE_INDEX = DEPLOY_STAGE_INDEX; // 上线后才能开启新一轮迭代
const VALID_STAGE_IDS = STAGES.map((s) => s.id);

function stageByRef(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const idx = Number(ref);
    return STAGES.find((s) => s.index === idx) || null;
  }
  const id = String(ref).trim().toLowerCase();
  return STAGES.find((s) => s.id === id) || null;
}

function stageByIndex(index) {
  return STAGES.find((s) => s.index === index) || null;
}

// 展示状态：loading（0 次上报）→ active（1-5）→ deployed（6，链接开放）→ done（7）→ submitted（8，最终参赛作品）
function deriveStatus(completedStages, hasReported) {
  if (completedStages >= STAGES.length) return 'submitted';
  if (completedStages >= DONE_STAGE_INDEX) return 'done';
  if (completedStages >= DEPLOY_STAGE_INDEX) return 'deployed';
  if (completedStages > 0 || hasReported) return 'active';
  return 'loading';
}

// 加权进度：累计已完成节点的权重（0-100）
function progressPercent(completedStages) {
  const done = Math.max(0, Math.min(STAGES.length, Number(completedStages) || 0));
  let sum = 0;
  for (const st of STAGES) {
    if (st.index <= done) sum += st.weight;
  }
  return sum;
}

// 项目可选跳过「原型设计」（安装包/CLI 类项目不涉及）：显示层用于标注该节点不适用
function isStageSkipped(stageId, deliverable) {
  return deliverable === 'package' && stageId === 'prototype';
}

module.exports = {
  STAGES,
  isStageSkipped,
  DEPLOY_STAGE_INDEX,
  DONE_STAGE_INDEX,
  LOOP_MIN_STAGE_INDEX,
  VALID_STAGE_IDS,
  stageByRef,
  stageByIndex,
  deriveStatus,
  progressPercent,
};
