# CLAUDE.md / AGENTS.md —— 项目级 Agent 约束（Vibe Coding 体系）

> 由 vibecoding-workflow skill 的 `scripts/setup.js` 生成。来源：《Vibe Coding 开发流程与体系》+ 黑客松上报纪律。
> 本文件每次会话进入上下文，只放约束与偏好；规格与计划放 `docs/`。CLAUDE.md 与 AGENTS.md 内容一致（跨工具事实标准：Claude 读前者，Codex/Cursor 等读后者）。

## 工作方式（Karpathy 四原则）

- **Think Before Coding**：先理解需求和现有代码再动手；方案有歧义先问我，一次一个问题
- **Simplicity First**：最少的代码、文件、抽象；不做投机功能，不过早抽象
- **Surgical Changes**：手术式修改，只动该动的地方，保持既有代码风格；能改就不重写
- **Goal-Driven Execution**：每个任务先明确验收标准；没有运行证据（测试输出/命令结果）不得宣称完成

## 变更强制约束（每一条都是硬约束）

1. 任务开始前：对比本地与远端分支，有落后先 `pull --rebase`，再开始变更；
2. **SDD 强制**：任何非琐碎变更（拿不准是否琐碎，一律按非琐碎处理）先落规格（做什么、边界、验收标准，进 docs/），获我确认后才写实现代码——丢弃式原型/设计稿不算实现代码，可先行产出，但同样须我确认；需求有歧义用 grill-me 方式一次一问，不确定能否获取的数据先验证再写进规格，禁止假设；
3. **TDD 强制**：关键路径（业务逻辑、钱、权限、数据完整性）先写测试、亲眼看它失败，再实现到通过；样式、文案、一次性脚本（用后即弃、不入库）豁免；
4. 变更完成后：本地跑全量测试，前端核心旅程用浏览器自动化完整回归；
5. 测试发现问题：先自行修复并重跑；只有需求歧义、破坏性变更或连续 3 轮修复仍未通过时，停下来输出反馈待我确认，不擅自扩大改动范围；
6. 全部通过后：中文提交信息（一行主题 + 必要时正文说明"为什么"），提交并推送远端；参赛项目随后按下方卡点上报。

> 开发模式固定为 SDD + TDD：superpowers 已安装时用其技能承载以上门禁（brainstorming / test-driven-development / code-review）；未安装则按同等门禁手动执行——执行器可缺，标准不降。

## 流程卡点（与 hackathon-reporter 八节点一一对应）

用 `node skill/hackathon-reporter/scripts/report.js --next` 驱动工作循环：完成一个节点立即上报，禁止跳节点。**仅参赛项目（存在 `hackathon.config.json`）执行上报命令**；非参赛项目只按卡点表做本地验收检查，不执行任何 report.js 上报/验收命令。**用户参与是硬要求：需求用户写、原型用户选、最终提交用户确认。**

| VibeCoding 阶段 | 卡点 | 上报 |
|---|---|---|
| 需求共创：用户亲笔填需求模板（Agent 深搜产出）→ grill-me 追问 → PRD 闭环落盘 docs/prd.md | requirements | `--stage requirements` |
| 方案/接口契约定稿（技术栈固定 Node.js 全栈 + node:sqlite） | design | `--stage design` |
| 原型确认：可选设计模板链接（如 designmd.app），须用户确认 | prototype | `--stage prototype` |
| TDD 实现，核心功能可运行 | coding | `--stage coding` |
| 自检循环（≤3 轮）+ 交叉 review（全新上下文，P0/P1 清零）+ E2E 回归全绿 | testing | `--stage testing` |
| 构建并部署 | deployment | `--deploy`（推荐）/ `--stage deployment` |
| 终验门禁（有新鲜运行证据才宣称完成） | acceptance | 只能 `--verify`（手工上报视为违规）；verify.api/e2e 未配置会被跳过，testing 节点就要补齐 |
| 用户终审：用户本人 `--submit` 交互确认，作品定格为评分版本；Agent 严禁代确认 | submission | `--submit`（仅用户亲手） |

**迭代循环**：上线后用户可 `--loop` 开新一轮（进度重置、大屏显示 LOOP×n、历史留审计），每轮重走全部卡点。

没有新鲜验证证据不宣称完成；交叉 review 用全新上下文（不带实现者会话历史），P0/P1 清零才放行。

## 偏好

- 技术栈：Node.js 全栈 + SQLite（Node 22.5+ 优先内置 `node:sqlite`，免原生编译）；一门主栈走到底，不中途换栈，确有必要再加 Python/Go
- 运行时 Node.js ≥18；测试与工具脚本优先零依赖写法（参考本项目 scripts/ 与 report.js 的风格）
- E2E：Playwright Test + `channel: 'msedge'`（Windows + 系统预装 Edge 环境下免浏览器下载；无系统品牌浏览器的机器才允许 `npx playwright install`）；接口为主的项目可用零依赖 HTTP 脚本；agent 交互走查可选 agent-browser
- 提交信息中文；每完成一个可验证的小任务就提交

## 禁止（安全红线）

- 不提交 `.env`、密钥、任何凭据；`hackathon.config.json` 含 accessKey，绝不进入对话、git 与部署产物
- 未经我确认，不执行删除数据、改动数据库结构、对外发布的操作
- 不为让验证通过而删测试、改断言、绕过检查
- 不为"完善"而重构与本任务无关的代码
