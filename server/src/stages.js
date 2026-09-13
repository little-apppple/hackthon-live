'use strict';

// 八个流程节点：进度为纯离散模型，progress = completedStages / STAGES.length * 100
// 第 8 节点 submission（最终提交）只能由参赛者本人经 CLI 交互确认后上报，作为最终参赛待评分作品
const STAGES = [
  { index: 1, id: 'requirements', name: '需求分析' },
  { index: 2, id: 'design', name: '方案设计' },
  { index: 3, id: 'prototype', name: '原型设计' },
  { index: 4, id: 'coding', name: '代码开发' },
  { index: 5, id: 'testing', name: '本地测试' },
  { index: 6, id: 'deployment', name: '上线部署' },
  { index: 7, id: 'acceptance', name: '线上验收' },
  { index: 8, id: 'submission', name: '最终提交' },
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

function progressPercent(completedStages) {
  return Math.round((completedStages / STAGES.length) * 100);
}

module.exports = {
  STAGES,
  DEPLOY_STAGE_INDEX,
  DONE_STAGE_INDEX,
  LOOP_MIN_STAGE_INDEX,
  VALID_STAGE_IDS,
  stageByRef,
  stageByIndex,
  deriveStatus,
  progressPercent,
};
