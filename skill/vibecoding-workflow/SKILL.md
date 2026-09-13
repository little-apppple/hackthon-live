---
name: vibecoding-workflow
description: 基于《Vibe Coding 开发流程与体系》的 AI 辅助开发全流程 skill，把需求共创（用户填模板+grill-me）→计划拆解→TDD 实现→Loop Review→E2E 回归→部署上线→用户终审提交组织成带硬门禁的迭代循环，且八个卡点与黑客松 hackathon-reporter 的八节点上报一一对应（支持 --loop 多轮迭代，大屏显示 LOOP×n）。Use when 新项目启动/按 VibeCoding 流程开发/参赛项目需要按比赛卡点推进/开启新一轮迭代/需要生成 CLAUDE.md、AGENTS.md 或自动检测安装 skill 依赖时。
---

# Vibe Coding 开发流程（卡点对齐版）

你按《Vibe Coding 开发流程与体系》的纪律驱动开发。流程不是用来限制模型的，而是用来保证结果**可验证、可回滚、可沉淀**——每个阶段有机器可判定的验收标准，验收不过不进入下一阶段。

## 目标

1. 把一个想法推进到「线上可访问 + 有新鲜验证证据」的完成态；
2. 每过一个卡点立即向赛事服务端上报（参赛时），大屏实时可见；
3. 收尾沉淀一条可复用经验，让下一轮 prompt 更短。

## 边界（绝对不做）

- **禁止跳卡点**：服务端强制按序校验，跳节点上报会被 409 拒绝；被跳过的工作也不会凭空完成。
- **禁止无证据宣称完成**：没有本次会话新鲜产生的运行输出/测试结果/E2E 证据，不得说「完成」。
- **禁止为通过验证而削弱验证**：不删测试、不改断言、不绕过检查。
- **禁止密钥进上下文**：`hackathon.config.json`（含 accessKey）、`.env` 内容永不读取、永不提交、永不进入部署产物。

## 卡点与上报的对应关系（八个门禁）

工作循环的每一步既是 VibeCoding 生命周期阶段，也是 report 的上报卡点。**用户参与是硬要求：需求用户写、原型用户选、最终提交用户确认——Agent 是助手不是决策者。**

| # | VibeCoding 阶段 | 卡点 | 机器可判定验收标准 | 上报动作 |
|---|---|---|---|---|
| 1 | 需求澄清 → 规格沉淀 | `requirements` | **用户亲笔填写需求模板**（Agent 按项目名深度搜索后产出模板供参考）→ grill-me 式追问补盲 → docs/prd.md 落盘：每条输入有来源、每条输出有去向、每条流程可跑通，不确定的数据先验证再落笔，禁止假设 | `--stage requirements` |
| 2 | 计划拆解 → 方案定稿 | `design` | 技术选型**固定为 Node.js 全栈 + node:sqlite**（除非用户明确要求更换）；架构与核心接口契约定稿，任务清单人工过目 | `--stage design` |
| 3 | 原型确认 | `prototype` | **可选流程**：用户从设计模板站（如 https://designmd.app）选模板发链接，按模板实现原型；无模板则自行产出。原型必须获得用户确认，E2E 要覆盖的核心旅程清单（5–10 条）定稿 | `--stage prototype` |
| 4 | TDD 实现 | `coding` | 核心功能可运行；关键路径先看到测试失败再实现到通过 | `--stage coding` |
| 5 | Loop Review + E2E 回归 | `testing` | 自检循环（≤3 轮）全绿 + 核心旅程 E2E 通过，有输出证据 | `--stage testing` |
| 6 | 构建部署 | `deployment` | `--deploy` 打包上传、探活通过（自动上报） | `--deploy`，或手动起服后 `--stage deployment`（服务端探活校验） |
| 7 | 终验门禁 | `acceptance` | `--verify` 探活+接口+E2E 全绿（自动上报，附证据）。注意：verify 配置里未设置的步骤会被跳过——参赛项目必须在 testing 节点补齐 `verify.api` / `verify.e2e`，否则验收会「真空通过」 | `--verify`（唯一合规路径；手工 `--stage acceptance` 视为违规申报） |
| 8 | 用户终审 | `submission` | **用户本人执行 `--submit` 并在终端确认**——当前线上版本定格为最终参赛待评分作品；Agent 严禁代为确认或用 `--stage submission` 绕过 | `--submit`（用户亲手） |

**流程是一个 loop 不是一条线**：第 6 节点上线后，用户可调整需求再走一遍全流程——`--loop` 开新一轮（进度重置、大屏显示 `LOOP×n`、历史留审计），每轮仍走全部八个卡点。

Loop Review 三层（由内到外）：自检循环（实现者，重试预算 3 轮，超了就汇报而不是死循环）→ 交叉 review（全新上下文的 subagent 或跨模型，评审者不得携带实现者会话历史，P0/P1 清零才算过）→ 终验门禁（新鲜证据）。

## 工作循环

```
node <skill目录>/../hackathon-reporter/scripts/report.js --next   ← 永远从这里开始
        ↓ 按 VibeCoding 纪律完成该卡点的工作（上表「验收标准」全绿）
node report.js --stage <卡点> / --deploy / --verify / --submit
        ↓
node report.js --next   ← 循环；上线后可 --loop 开新一轮迭代
```

非参赛项目没有服务端时，同样按八卡点顺序推进，只是不执行上报命令；每张表的「验收标准」仍是硬门禁。

## 首次接入 / 环境准备

在项目根目录执行一次：

```bash
node <skill目录>/scripts/setup.js            # 检测依赖 + 生成缺失的 CLAUDE.md / AGENTS.md
node <skill目录>/scripts/setup.js --fix      # 自动安装可安装项（npm 依赖、.claude/skills 同步）
node <skill目录>/scripts/setup.js --force    # 覆盖重新生成 CLAUDE.md / AGENTS.md
node <skill目录>/scripts/setup.js --check    # 只检测不改动
node <skill目录>/scripts/setup.js --project <目录>   # 面向其他项目执行（默认当前目录）
```

退出码：0 = 无待处理项（提示类 note 不影响）；1 = 存在待处理项（脚本化调用时据此判断）。

## 技术栈约定（默认）

- **首选 Node.js 全栈 + SQLite**：一门 TypeScript 吃下 Web/API/小程序/桌面/CLI 约九成场景，agent 先验最强；SQLite 零部署零运维（Node 22.5+ 可用内置 `node:sqlite`，免原生编译），个人与比赛项目尺度完全够用，量大再换 Postgres；
- **一门主栈走到底**：中途换栈等于亲手换掉 agent 的最强先验；确有必要再扩（数据/AI → Python，高并发底层 → Go）；
- 参赛硬性约束：node 类型项目必须监听 `process.env.PORT`（自动部署靠它注入端口）。

## E2E 测试方案（默认约定）

目标是外部依赖最少（用户环境：Windows + 系统预装 Edge）：

- **无人值守验收（`verify.e2e`）：Playwright Test + `channel: 'msedge'`**——唯一新增依赖是 `@playwright/test` 一个 npm 包，浏览器直接用系统 Edge，**禁止运行 `npx playwright install`**（限 Windows + 系统预装 Edge 环境；无系统品牌浏览器的机器才允许安装）；
- 接口为主的项目可退回零依赖 HTTP 脚本（本项目 `scripts/smoke.js` 即此模式）；
- testing 卡点的 agent 交互走查：可选 agent-browser（无 Chrome 时 `--executable-path` 指向 `msedge.exe` 或 `agent-browser install`），非必需、不进项目依赖。

setup.js 对以上依赖的检测是**门控的**：仅当项目 verify 命令或 package.json 依赖声明指向 playwright/cypress/agent-browser 时，Edge 缺失/无头策略禁用才计为待处理（fail），否则降级为提示——纯接口项目不会被假阻塞。检测项：系统 Edge、Edge 无头组策略（`HeadlessModeEnabled=0` 会导致 headless 启动失败）、verify 命令指向的工具是否已安装（含 monorepo 依赖提升的上级 node_modules）。

setup 自动检测：Node ≥18、git、项目依赖、hackathon-reporter skill（本 skill 的上报依赖）、`hackathon.config.json`（参赛必需，缺失时提示向管理员索取）、CLAUDE.md/AGENTS.md。

## 知识沉淀（收尾复盘）

- 约束与偏好 → CLAUDE.md / AGENTS.md；术语 → CONTEXT.md；一次性规格 → docs/specs/、docs/plans/；可复用方法论 → skill。各归其位，不写错层。
- 复盘只提炼「下次还会遇到」的经验。四问：① 重复出现 ≥3 次？② 需要跨会话保持稳定一致？③ 产出机器可判定？④ 过程需要模型的主观判断（纯机械的写成脚本更好）？——基本全「是」才值得写成 skill，否则用更轻的形态。

## 错误处理

上报/部署/验证的错误码自愈方式与 hackathon-reporter 完全一致（409 补报、429 等待、KEY_REVOKED 停手上报、VERIFY_FAILED 修复后重验），见 `<skill目录>/../hackathon-reporter/SKILL.md` 的错误处理表。上报失败不卡流程：失败不改变进度，随时可补报。
