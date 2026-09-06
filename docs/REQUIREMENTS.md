# 企业黑客松大赛实时大屏系统 · 需求文档

> 版本：v1.0（2026-09-04，经 grill-me 访谈确认）
> 状态：需求已确认，待开发

---

## 一、项目概述

为企业内黑客松大赛构建一套 **Node.js 全栈 + SQLite** 的实时进度大屏系统，包含三部分：

1. **现场驾驶舱大屏**（公开只读）：实时展示各部门 → 各小组 → 各项目的比赛进度；
2. **管理后台**（管理员登录）：录入名单、创建项目、生成 accesskey 并预留部署端口；
3. **上报 Skill**（交付给参赛项目的 AI 编程 Agent 使用）：在各流程节点完成时自动向服务端上报进度。

所有参赛项目最终部署到**同一台服务器**，各自占用生成 accesskey 时预留的独占端口；大屏项目卡在部署节点完成后开放链接，新开 Tab 即可访问。

## 二、角色与术语

| 角色/术语 | 说明 |
|---|---|
| 管理员 | 赛事组织者，操作管理后台 |
| 参赛项目 Agent | 各小组使用的 AI 编程 Agent（如 ZCode），安装我们交付的上报 Skill |
| 部门 Department | 参赛单位一级组织，赛前录入 |
| 小组 Group | 部门内的参赛小队，赛前录入，一个部门含多个小组 |
| 项目 Project | 小组的参赛作品，一个小组含多个项目 |
| 节点 Stage | 项目生命周期的 7 个固定阶段 |
| accesskey | 每个项目唯一的上报凭证，与预留端口绑定发放 |
| loading 项目 | 已生成 accesskey、尚未收到任何上报的项目，在大屏以 loading 态展示 |

## 三、核心业务模型（已确认决策）

### 3.1 流程节点：共 7 个

> 原始需求写"六个节点"但列出 7 个阶段，已确认 **以 7 个为准**。

| # | 节点 | 英文标识 | 完成后效果 |
|---|---|---|---|
| 1 | 需求分析 | `requirements` | 进度 14% |
| 2 | 方案设计 | `design` | 进度 29% |
| 3 | 原型设计 | `prototype` | 进度 43% |
| 4 | 代码开发 | `coding` | 进度 57% |
| 5 | 本地测试 | `testing` | 进度 71% |
| 6 | 上线部署 | `deployment` | 进度 86%，**部署链接开放点击** |
| 7 | 线上验收 | `acceptance` | 进度 100%，显示"已完成"徽章 |

### 3.2 进度模型：纯离散节点

- 每个项目维护 `已完成节点数`（0–7），**只能按顺序单调前进**，不允许跳节点、不允许回退。
- **总进度百分比 = 已完成节点数 / 7 × 100**，由服务端推导，不接受自定义百分比。
- 项目展示状态（服务端推导）：
  - `loading`：accesskey 已生成，收到 0 次上报 → 大屏显示 loading 动画卡片；
  - `进行中`：已完成 1–5 个节点；
  - `已部署`：完成第 6 节点（上线部署），链接可点击；
  - `已完成`：完成第 7 节点（线上验收），进度 100%。

### 3.3 端口与部署

- 服务端维护**可配置端口池**（默认 4100–4999，环境变量 `PORT_POOL_START` / `PORT_POOL_END`）。
- 管理员生成 accesskey 时，服务端在**同一事务内**自动分配一个端口，满足：
  1. 未被池内其他项目预留（SQLite 唯一约束保证）；
  2. 本机未被占用（分配时用 `net.createServer` 试绑定探测，失败自动换下一个）。
- 项目部署链接 = `http://{PUBLIC_HOST}:{port}`，`PUBLIC_HOST` 为环境变量（如 `192.168.1.100`）。

### 3.4 项目卡生命周期

```
管理员创建项目+生成accesskey+预留端口
        │
        ▼
  [loading] 大屏立即出现 loading 卡片
        │  首次上报「需求分析」完成
        ▼
  [进行中] 每次上报推进一个节点
        │  上报「上线部署」完成
        ▼
  [已部署] 链接可点击，新开 Tab 访问 http://PUBLIC_HOST:port
        │  上报「线上验收」完成
        ▼
  [已完成] 进度 100%，完成徽章
```

### 3.5 流程约束监管（强约束 + 可吊销）

服务端是唯一真相源，skill 只是客户端便利层：

- **顺序强制**：上报的节点必须等于 `已完成节点数 + 1`，否则拒绝（HTTP 409，返回当前应上报的节点）；被拒请求不消耗限频窗口，自愈重报不受罚；
- **限频**：每项目成功上报间隔 ≥ 10 秒，超频拒绝（HTTP 429，返回建议重试秒数）；
- **吊销**：管理员可吊销 accesskey，吊销后所有上报拒绝（HTTP 403）；
- **审计**：所有上报（成功与被拒）均写入 reports 审计表，含 IP、时间、拒绝原因、evidence 证据 JSON；
- **错误码自愈**：所有拒绝响应携带结构化错误码与提示，由 skill 解读并指导 Agent 纠正后重试。

### 3.6 线上验收自动化

前 6 个节点由 Agent 按 skill 判断标准自主上报；第 7 节点「线上验收」改为**自动化验证驱动**，不靠自我申报：

1. 「上线部署」上报时，服务端主动探测项目预留端口是否有 HTTP 响应（软校验，结果记入 evidence，探活失败在大屏响应中警告）；
2. 验收由 skill CLI 的 `--verify` 命令执行：**探活（重试 8 次）→ 接口测试（项目配置 `verify.api`）→ E2E 测试（`verify.e2e`）**，命令通过 `DEPLOY_URL` 环境变量获得线上地址；
3. 三步全部通过后 CLI 自动上报验收并附证据；任一步失败退出码 3、不上报，`--dry` 可只验证不上报；
4. 部署地址确定顺序：`--url` > 配置 `deployUrl` > 服务端预留端口。

## 四、功能需求

### 4.1 现场驾驶舱大屏（`/`，公开只读）

设计基准 1920×1080，暗色科技风，ECharts + 自绘组件：

- **顶部 KPI 栏**：部门数、小组数、项目总数、整体完成率、比赛倒计时（可选，读 `EVENT_END_TIME`）；
- **中部部门矩阵**：按部门分区卡片 → 部门内小组行（小组进度条）→ 小组内项目卡（7 节点进度点 + 状态色 + 项目名）；
- **右侧实时动态流**：滚动展示最新上报事件（"XX部门·YY组·ZZ项目 完成代码开发"），loading 项目高亮置顶轮播；
- **已部署项目卡**：链接按钮高亮可点击，`target="_blank"` 新开 Tab；
- 数据经 **SSE** 实时推送，断线由 `EventSource` 自动重连，重连后全量刷新一次。

### 4.2 管理后台（`/admin`，单密码 + Cookie Session）

- **登录**：环境变量 `ADMIN_PASSWORD` 单密码登录，签发 HttpOnly Cookie 会话；大屏接口不受影响；
- **名单管理**：部门/小组的增删改查；支持 **CSV 批量导入**；附带 seed 脚本一次性导入初始名单（JSON）；
- **项目管理**：选择部门 → 选择小组 → 填写项目名 → 创建。创建时**一个事务内**完成：生成 accesskey + 分配预留端口；
- **accesskey 管理**：列表查看所有项目的 accesskey（内网工具，允许重复查看）、复制、**吊销/恢复**；
- **端口视图**：端口池使用情况一览（已预留/空闲）。

### 4.3 上报 API（公开，accesskey 鉴权）

```
POST /api/report
{ "accessKey": "hk_xxx", "stage": "coding", "message": "核心功能开发完成" }
```

- `stage` 接受节点英文标识或序号 1–7；
- 成功：更新项目进度，SSE 广播，返回 `{ ok: true, progress: 57, nextStage: "testing" }`；
- 失败：结构化错误 `{ ok: false, code: "STAGE_OUT_OF_ORDER" | "KEY_REVOKED" | "RATE_LIMITED" | "INVALID_KEY", ... }`；
- 附带 `GET /api/report/status`（携带 accessKey）供 Agent 查询当前进度与下一节点。

### 4.4 上报 Skill（交付物：`skill/hackathon-reporter/`）

- **`SKILL.md`**：指导 AI 编程 Agent 在 7 个节点各自完成时（需求分析产出文档、方案评审通过、原型定稿、代码开发完成、测试通过、部署成功、验收通过）调用上报脚本；说明各错误码的纠正策略（409 → 先查询 status 再上报正确节点；429 → 等待重试；403 → 停止上报并提示用户联系管理员）；
- **`scripts/report.js`**：零依赖 Node 脚本（Node 18+ 全局 fetch），从参赛项目根目录 `hackathon.config.json` 读取 `accessKey` 与服务端地址：
  ```bash
  node report.js --stage coding --message "核心功能完成"
  node report.js --status        # 查询当前进度与下一节点
  ```
- 凭证发放流程：管理员后台生成 → 将 accesskey 连同 `hackathon.config.json` 模板发给各小组，放入其参赛项目根目录。

## 五、非功能需求

| 项 | 决策 |
|---|---|
| 后端 | Node.js + Express + SQLite（实现采用 Node 22.5+ 内置 `node:sqlite`，Windows 环境无 VS 编译链时免原生编译；数据层 API 与 better-sqlite3 同构） |
| 前端 | Vite + React + ECharts，构建产物由 Express 托管，生产环境**单进程** `node server` |
| 实时 | SSE（`GET /api/stream`），15s 心跳，连接断开自动全量补发 |
| 部署 | 同一台内网服务器：大屏服务占一个端口（默认 3000），参赛项目占各自预留端口 |
| 安全 | 大屏只读公开；写接口全部鉴权（后台 Cookie / 上报 accesskey）；accesskey 服务端存储，接口不回传全文之外的敏感信息 |
| 环境 | 大屏端口 `PORT`、管理密码 `ADMIN_PASSWORD`、端口池 `PORT_POOL_START/END`、展示主机 `PUBLIC_HOST`、倒计时 `EVENT_END_TIME`（可选）、赛事名 `EVENT_NAME`（可选） |

## 六、数据模型（SQLite）

```
departments   id, name, sort_order, created_at
groups        id, department_id FK, name, created_at
projects      id, group_id FK, name, access_key UNIQUE, port UNIQUE,
              completed_stages 0-7, status(loading|active|deployed|done|revoked),
              created_at, updated_at
reports       id, project_id FK, stage, ok(0|1), reject_code, message, ip, created_at
```

- 端口分配：事务内 `SELECT` 池内空闲端口 → 探测本机占用 → `INSERT`（唯一约束兜底并发）；
- 所有进度变更均由 reports 驱动，projects 表只是聚合结果，可随时由审计日志重放校验。

## 七、交付物清单

```
dashboard/
├─ docs/REQUIREMENTS.md            # 本文档
├─ package.json                    # npm workspaces（server + web）
├─ server/                         # Express API + SSE + SQLite + 静态托管
├─ web/                            # Vite + React：大屏页 + 管理后台页
├─ skill/hackathon-reporter/       # SKILL.md + scripts/report.js + 配置模板
├─ scripts/seed.js                 # 初始名单导入（示例名单 JSON）
└─ README.md                       # 部署运维手册
```

## 八、已确认决策记录（grill-me 访谈结论）

| # | 议题 | 结论 |
|---|---|---|
| 1 | 节点数量 | 7 个（原文"六个"为笔误） |
| 2 | 进度模型 | 纯离散节点，百分比 = 完成节点数/7 |
| 3 | 技术栈 | Express + better-sqlite3 + Vite/React/ECharts，单仓库单进程 |
| 4 | 实时机制 | SSE |
| 5 | Skill 形态 | SKILL.md + 零依赖 CLI 脚本 |
| 6 | 端口策略 | 端口池自动分配（4100–4999 可配），事务 + 占用探测 |
| 7 | 链接可点时机 | 上线部署节点完成即可点击（验收完成额外显示完成徽章） |
| 8 | 监管强度 | 强约束（顺序单调、限频 10s）+ accesskey 可吊销 + 全量审计 |
| 9 | 后台认证 | 单密码（环境变量）+ Cookie Session |
| 10 | 名单录入 | 后台 CRUD + seed 脚本 + CSV 导入 |
| 11 | 大屏布局 | 顶部 KPI + 部门矩阵 + 右侧实时动态流，暗色科技风 |
| 12 | 线上验收 | 自动化验收：部署后由 skill CLI `--verify` 执行探活→接口测试→E2E，全部通过才自动上报验收（附证据入审计表）；「上线部署」上报时服务端主动探活项目端口作为软校验 |
| 13 | 自动部署 | 方案 A（构建产物托管）：skill CLI `--deploy` 打包上传（排除 node_modules/.git，上限默认 200MB），服务端解压到 `data/deploys/<项目ID>/`、按需 npm install、以预留端口启动（static 类型服务端托管），探活通过自动上报「上线部署」；崩溃自动重启（≤10 次）、服务重启自动恢复；归档项目自动停服；流程未到部署节点时只部署不推进进度 |
| 14 | 多期活动 | 引入「活动」顶层隔离单元：部门/小组/项目/上报全部挂 event_id，跨活动互不可见、可重名；唯一「当前活动」供大屏默认展示与后台默认上下文，可切换；活动名/倒计时随活动存储；accesskey 与端口池全局唯一；删除活动需先清空（已归档项目随之清除）；服务重启只恢复当前活动的部署 |
| 15 | 端口区间 | 端口池区间后台可调并持久化（settings 表，env 仅作首次默认值）；校验：1024≤起≤止≤65535，新区间必须覆盖全部已预留端口（否则 409 列出冲突端口）；保存即生效影响后续分配，已分配端口不迁移；分配时试绑定探测自动跳过本机占用端口 |

## 九、默认策略（未单独访谈，按以下默认实现，可后续调整）

- accesskey 在后台可重复查看（内网工具，不做"仅显示一次"）；
- 项目不可物理删除，仅支持归档（软删除），保证审计链完整；
- 被拒上报同样写入审计表并标注拒绝原因；
- 不做 v1 范围：多管理员账号、比赛重置按钮、历史比赛归档、移动端适配。
