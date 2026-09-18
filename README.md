# 企业黑客松大赛实时大屏系统

Node.js 全栈（Express + node:sqlite + Vite/React/ECharts）的黑客松现场驾驶舱，**支持 Web 应用与安装包（非 Web 应用）两类交付**：**多期活动数据完全隔离**，大屏实时展示 **部门 → 小组 → 项目** 三级进度，项目通过 **上报 Skill** 自动汇报 8 个流程节点（最终提交由用户本人确认）、`--deploy` 自动部署到预留端口、`--verify` 自动化线上验收。SQLite 使用 Node 22.5+ 内置的 `node:sqlite`，无需任何原生编译。

完整需求见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)，**分角色使用手册见 [docs/USERGUIDE.md](docs/USERGUIDE.md)**（管理员 / 参赛小组 / 评委观众），**技能包下发与自助注册手册见 [docs/REGISTRATION.md](docs/REGISTRATION.md)**。

## 目录结构

```
dashboard/
├─ server/            # Express API + SSE + SQLite（单进程生产服务，node:sqlite 内置驱动）
├─ web/               # Vite + React：大屏页(/) + 管理后台(/admin)
├─ skill/hackathon-reporter/   # 发给参赛项目的上报 skill（SKILL.md + report.js）
├─ skill/vibecoding-workflow/  # Vibe Coding 开发流程 skill（卡点与上报八节点对齐 + setup.js）
├─ scripts/seed.js    # 初始名单导入
├─ scripts/pack-skills.js # 打参赛技能包（tgz，内置上报地址，参赛者 --init 自助注册）
├─ scripts/smoke.js   # 端到端冒烟测试
├─ scripts/verify-e2e.js # 验收自动化端到端测试
├─ scripts/deploy-e2e.js # 自动部署端到端测试
├─ scripts/demo-data.js # 演示数据生成
└─ data/seed-roster.json       # 名单示例（部门/小组）
```

## 端口区间配置

项目部署端口从「端口池」中分配，区间在**管理后台 → 项目与密钥 → 端口池条带 → 调整区间**中可随时修改并持久化（存于 SQLite settings 表，重启后仍生效；环境变量 `PORT_POOL_START/END` 只作为首次启动的默认值）。

规则：

- 新区间必须满足 `1024 ≤ 起始 ≤ 结束 ≤ 65535`；
- 新区间必须覆盖所有已预留端口（未归档项目），否则拒绝并列出冲突端口——已部署项目的端口不会因调整区间而失效或迁移；
- 保存立即生效，影响之后的新分配；区间内端口耗尽时报错提示调整区间；
- 端口在本机被其他程序占用时分配器会自动跳过（试绑定探测）。

## 多期活动（数据隔离）

系统以「活动」为顶层隔离单元，每期活动拥有完全独立的一套数据：

| 范围 | 隔离方式 |
|---|---|
| 部门 / 小组 / 项目 / 上报动态 | 全部挂在 `event_id` 下，互不可见；同活动内名称唯一，跨活动可重名 |
| 大屏展示 | 默认展示**当前活动**（唯一 `is_active=1`），可 `GET /api/snapshot?eventId=N` 看任意一期 |
| 管理后台 | 头部活动切换器选择要管理的活动；「活动管理」页创建/改名/设结束时间/切换/删除 |
| 活动名与倒计时 | 每期活动自己的 `name` / `end_time`（创建时可填，替代全局环境变量） |
| accesskey / 端口池 | 全局唯一：accesskey 不随活动切换失效；端口跨活动不重复（绑定真实监听） |
| 删除保护 | 有部门或进行中项目的活动不可删除；已归档项目在删除活动时随之清除，也可在项目列表单独「彻底删除」 |
| 自动部署恢复 | 服务重启后只恢复**当前活动**的部署进程 |

生命周期：赛前创建活动 → 录名单 → 发 accesskey → 比赛 → 归档项目 → 下期活动创建并「设为当前」。旧库首次启动自动迁移：全部数据归入默认活动（活动名取 `EVENT_NAME`）。

## 快速开始

```bash
npm install            # 安装全部依赖（workspaces）
npm run seed           # 导入示例名单（可用 --file 指定自定义名单 JSON）
npm run build          # 构建前端到 web/dist
npm start              # 启动服务（默认 http://localhost:3000）
```

辅助脚本：

```bash
npm test               # 回归闸门：一键跑完下面全部套件（smoke + 三套 E2E），任一失败即退出非 0
npm run demo           # 生成各阶段混合的演示项目数据（开发/演示用）
npm run migrate:e2e    # 旧库迁移回归（构造 legacy 库 → 迁移 → 断言快照/后台可用、数据保留）
npm run smoke          # 端到端冒烟测试（104 项断言：认证/CSV/上报强约束/探活/吊销/端口复用/审计/活动隔离/端口区间/自助注册/loop 迭代/最终提交）
npm run verify:e2e     # 验收自动化端到端测试（通过/失败/未部署三条路径）
npm run skill:e2e      # 参赛技能包全旅程端到端测试（打包→解压→doctor→自助注册→八节点→部署→验收→loop→终审）
npm run deploy:e2e     # 自动部署端到端测试（node/static/自动上报/重启停止/未到节点）
```

- 大屏：`http://localhost:3000/`（含**已提交作品榜**、提交时**全屏烟花 + 2 秒庆祝横幅**、阶段完成**底部短气泡**（多条逐一排队，提交类插队）；彩排演示访问 `/?celebrate=1`）
- 管理后台：`http://localhost:3000/admin`（默认密码 `hackathon2026`）
- 开发模式：`npm run dev:server` + `npm run dev:web`（Vite 5173，/api 自动代理）
- 迭代口径：`--loop` 开新一轮后进度与 KPI 按**当前轮次**统计（历史在审计流）；loop 后大屏项目卡链接暂时熄灭（进入新一轮），需在新一轮重新走到「上线部署」节点后链接才恢复（服务端部署进程在旧链接熄灭期间仍在运行，可从后台管理）
- 技能包下发：`node scripts/pack-skills.js --server http://<对外IP>:<端口>`（`--host` 为别名）产出 `hackathon-skills.tgz`（已内置上报地址）。参赛者解压到项目根后执行 `node skill/hackathon-reporter/scripts/report.js --init`，填部门/小组/项目名即完成报名并换取 accessKey——幂等：相同「部门/小组/项目名」只发一次密钥，重复执行返回同一密钥；管理员后台手工建项目发 key 的流程继续可用（`--init --server-url … --access-key …`）。

## Vibe Coding 开发流程 skill

`skill/vibecoding-workflow/` 把《Vibe Coding 开发流程与体系》落成可执行的 agent 流程，其八个卡点与 hackathon-reporter 的八节点上报一一对应（requirements → design → prototype → coding → testing → deployment → acceptance → submission，支持 `--loop` 多轮迭代），且要求用户深度参与：需求由用户填写模板+grill-me 共创、原型可选设计模板链接、最终提交由用户本人 `--submit` 确认。在任何项目根目录运行：

```bash
node skill/vibecoding-workflow/scripts/setup.js          # 检测依赖（Node≥18/git/reporter skill）+ 生成缺失的 CLAUDE.md、AGENTS.md
node skill/vibecoding-workflow/scripts/setup.js --fix    # 自动安装：npm 依赖 + 把两个 skill 同步进 .claude/skills/
node skill/vibecoding-workflow/scripts/setup.js --force  # 覆盖重新生成 CLAUDE.md / AGENTS.md
node skill/vibecoding-workflow/scripts/setup.js --check  # 只检测不改动
node skill/vibecoding-workflow/scripts/setup.js --project <目录>  # 面向其他项目执行
```

零依赖（Node 18+），退出码 0/1 表示有无待处理项；本仓库根目录的 CLAUDE.md / AGENTS.md 即由它生成。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | 大屏服务端口 |
| `ADMIN_PASSWORD` | hackathon2026 | 管理后台密码 |
| `PORT_POOL_START` / `PORT_POOL_END` | 4100 / 4999 | 项目部署端口池的**初始默认值**（后台可随时调整并持久化，见下文「端口区间」） |
| `PUBLIC_HOST` | localhost | 大屏上展示的部署链接主机（改成服务器内网 IP） |
| `EVENT_NAME` | 企业黑客松大赛 | 大屏顶部赛事名 |
| `EVENT_END_TIME` | 空 | 比赛倒计时截止时间（ISO，如 `2026-09-05T18:00:00`），空则不显示 |
| `DB_PATH` | server/data/hackathon.db | SQLite 文件路径 |
| `RATE_LIMIT_MS` | 10000 | 每项目上报最小间隔 |
| `SESSION_TTL_MS` | 86400000 | 管理后台会话有效期 |
| `DEPLOY_PATH_PREPEND` | - | 部署进程 PATH 前置目录（如 /opt/node22/bin） |
| `DEPLOY_ROOT` | server/data/deploys | 自动部署产物与运行目录 |
| `DEPLOY_MAX_MB` | 200 | 部署产物大小上限（解包后大小/文件数同样受配额限制） |
| `HIT_RATE_PER_TERMINAL` | 30 | 每终端每分钟人气上报上限 |
| `HIT_RATE_PER_IP` | 600 | 每 IP 每分钟人气上报上限（仅限频，不用于去重） |
| `HIT_WINDOW_MS` | 60000 | 人气去重窗口（同终端同项目重复点击只计一次） |
| `REGISTER_RATE_LIMIT_PER_MIN` | 10 | 自助注册每 IP 每分钟上限 |
| `DEPLOY_RATE_LIMIT_MS` | 10000 | 同一项目两次部署的最小间隔（自动部署防刷） |
| `DEPLOY_START_TIMEOUT_MS` | 60000 | 部署启动探活超时 |

生产环境启动示例：

```bash
ADMIN_PASSWORD=赛事密码 PUBLIC_HOST=192.168.1.100 EVENT_END_TIME=2026-09-05T18:00:00 npm start
```

## 赛事操作流程

1. **赛前**：管理后台 → 名单管理，录入/导入部门与小组（CSV 格式：每行 `部门,小组`）。
2. **赛前或赛中**：项目与密钥 → 选部门 → 选小组 → 填项目名 → 创建。系统一个事务内生成 accesskey 并预留一个空闲端口，弹窗里一键复制发给小组的 `hackathon.config.json`。
3. **发放 skill**：把 `skill/hackathon-reporter/` 整个目录发给各参赛小组，放入其 AI 编程 Agent 的 skill 目录；小组把配置写入参赛项目根目录 `hackathon.config.json`。
4. **赛中**：小组的 Agent 每完成一个节点自动上报，大屏 SSE 实时刷新。
5. **自动部署（上线部署节点）**：小组 Agent 执行 `node report.js --deploy`——自动打包上传（排除 node_modules/.git），服务端解压到 `data/deploys/<项目ID>/`、按需 `npm install`、以预留端口启动（或托管静态站），60 秒内探活通过后**自动上报「上线部署」**并点亮大屏链接。崩溃自动重启（最多 10 次）；服务重启后只恢复**当前活动**的部署进程。
6. **线上验收（自动化）**：小组 Agent 执行 `node report.js --verify`——依次完成**线上应用探活 → 接口测试（`verify.api`）→ E2E 测试（`verify.e2e`）**，全部通过后自动上报验收并附证据；任一步失败则不上报（退出码 3），修复后重试。
7. **监管**：后台可查看各项目部署进程状态、停止/启动/重启；可随时吊销/恢复 accesskey、归档项目（归档自动停服并释放端口）；所有上报（含被拒）与部署/验收证据都有审计记录。

## 人气值（点击统计）

评委/观众在大屏点击「▶ 打开项目」或「⬇ 下载安装包」时，前端上报一次点击，形成项目**人气值**。

**终端身份（IP 不参与去重）**：同一公网 IP 下常有多个终端（会场 wifi / NAT），用 IP 去重会把不同人并成一个人，因此采用三级级联：

1. **服务端签发的 Cookie `hk_term`**（首选）：每个浏览器实例一个随机标识，随请求自动携带，不依赖 JS，一年有效；
2. **请求体 `terminal`**（兼容老客户端，同样需 `t_` 前缀）；
3. **都没有时当场签发新的随机终端**——所以无 Cookie 的客户端（curl 等）每次都会被当作新终端，**IP 只用于限频，不用于去重**。

- **去重口径**：同一终端对同一项目，在 `HIT_WINDOW_MS`（默认 60 秒）内的多次点击只计一次；
- **点击入口**：大屏按钮指向同源端点 `GET /api/hit/go?projectId=N`——服务端计数后 302 跳到真实地址，**禁用 JS 或直接点链也会计数**；
- **展示**：项目卡显示「人气 n」、右侧**人气榜**（前 5 名 + 进度条 + 全部项目合计）、管理端项目表同步显示；快照 `kpi.totalHits` 为全场人气合计；
- **存储**：`projects.hits` 冗余计数（读快照即可，无需聚合）；明细在 `hit_events` 表（仅用于窗口去重，定期清理超过窗口 10 倍或 1 小时以上的记录）；
- **限频与防滥用**：每终端 30 次/分、每 IP 600 次/分（仅限频、不参与去重）；**校验先于限频**，无效请求不消耗预算，避免同一出口 IP 被连坐；未到「上线部署」节点的项目不计数（`409 NOT_DEPLOYED`）；终端标识只认服务端签发的 Cookie（前端不再自报，防止伪造刷量）。

## 交付形态与注册信息

**两类交付**（自动识别或显式指定）：

| 类型 | 命令 | 完成判定 |
|---|---|---|
| Web 应用（node/static） | `--deploy`（默认 node）/ `--deploy --dir dist --type static` | 预留端口探活通过 |
| **安装包（非 Web 应用）** | `--deploy --type package --file dist/setup.exe` | 上传成功 + **下载链接可用**（探活 + 附件头 + 大小一致） |

- 支持格式：exe / msi / zip / 7z / tar.gz / apk / dmg / pkg / deb / rpm / jar / appimage，单包上限同 `DEPLOY_MAX_MB`；
- 安装包发布后预留端口提供落地页（含「下载安装包」按钮）与直链 `http://<主机>:<端口>/<文件名>`；
- 验收：`--verify --file <本地包>` 自动校验探活 + 下载可用 + 大小一致 + 附件头，通过后自动上报验收节点；
- 大屏与后台按交付形态显示「打开项目」或「下载安装包」。

**注册信息（大屏/后台展示用）**：自助注册可一并提交 `members`（参与人员）、`summary`（需求简述）、`value`（价值）、`features`（功能）、`scenario`（场景）；CLI 交互注册逐项提示（可跳过），也支持同名命令行参数一次性带参；**同一客户端重注册可更新这些信息**。大屏点击项目卡/已提交榜项弹出详情，管理端项目表「查看」读同一份信息。

## AI 参考评分

参赛者执行 `--submit` 完成最终提交后，**自动**采集证据计算参考分并上报（`--no-score` 可跳过；`--score` 可单独重算，`--dry` 只算不报）。

- **评分规范**：[docs/AI-SCORING.md](docs/AI-SCORING.md)（维度、权重、判定方法、红线）
- **构成**：机器可判定 85 分（需求闭环 / 工程纪律 / 测试质量 / 交付上线）+ 主观项 15 分（单列待评委评审）+ 红线扣分（密钥入库、跳节点、刷上报等）
- **证据链**：每项得分附证据行（文件路径、git 提交时间、服务端审计统计）；证据缺失即 0 分，不做善意推定
- **产物**：项目内生成 `docs/ai-score.md`（可读报告）与 `docs/ai-score.json`（结构化明细）；服务端存档于 `projects.ai_score / ai_score_detail`，大屏已提交榜显示 `AI 85` 徽标，管理端项目表可见
- **定位**：参考分，**不替代人工评审**

## 安全说明

**已实施的加固**（面向内网/可信网络部署）：

| 项 | 措施 |
|---|---|
| 部署目录穿越 | `dir` 参数三层校验（路由 400 / 解包前拒绝 / 启动期兜底），越界一律拒绝 |
| 静态托管 | `serve` 拒绝 `.env*`、`hackathon.config.json`、`*.pem`、`*.key`；CLI 打包同样排除 `.env` |
| 调度面密钥不外泄 | 部署子进程采用**环境变量白名单**（只给 PATH/PORT/临时目录等），不继承 `ADMIN_PASSWORD` 等 |
| 运行身份 | systemd 以专用非 root 用户 `hackathon` 运行，密钥放独立 `EnvironmentFile`（600） |
| 点击劫持 / 注入 | 全站安全响应头：`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy`、严格 CSP |
| CSRF | 带 Cookie 的管理写操作校验 `Origin`（跨站拒绝；CLI/curl 无 Origin 放行） |
| 密钥进日志 | `accessKey` 支持 `x-access-key` 请求头传输（CLI 已改用），不再强制出现在 URL/日志/Referer |
| 注册与上报 | 本期注册令牌鉴权 + 每 IP 限频；上报/迭代/部署均有限频（部署 10s/项目，可配） |
| 资源耗尽 | 部署产物上限 + **解包后文件数与总大小配额**（防 tar 炸弹/磁盘打满） |
| 其他 | 登录限频（5 次/分/IP）、吊销即停服、归档释放端口、审计留痕（含 IP 与来源） |

**已知残余风险（部署前请评估）**：

1. **部署 = 在服务器上执行代码**：`--start` 与上传产物由参赛队控制，且部署进程与看板同机（虽已是非 root 用户，仍能读到同用户的数据库文件）。要彻底隔离需容器/沙箱，或把部署与调度分到两台机器；
2. **明文 HTTP**：密钥与会话在链路上明文传输，公网/不可信网络请务必前置 HTTPS（如 Nginx/Caddy 反代），配好后 Cookie 会带 `Secure`；
3. **数据库内 `accessKey` 为明文**（含注册令牌）：备份目录 `/opt/hackathon-live.bak-*` 已收紧为 700，请限制服务器登录权限并定期清理旧备份。

## API 一览

公开：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/report` | 上报节点完成 `{accessKey, stage, message, evidence?}` |
| POST | `/api/register` | 自助注册：`{department, group, project, clientId, registerToken, description?}` → 录入名单+预留端口+发 accessKey；**以 clientId 幂等**（同一 clientId 重跑返回同一 key，换名亦然）；不同 clientId 撞同名 → 409 `NAME_TAKEN`。需本期注册令牌（管理员 `/api/admin/register-token` 签发）；错误码 `INVALID_PARAMS` / `INVALID_CLIENT_ID` / `REGISTER_TOKEN_INVALID` / `NAME_TAKEN` / `NO_FREE_PORT` / `PORT_CONFLICT`，每 IP 限频 10 次/分钟（按直连 IP 计，勿置于无 realip 配置的反向代理之后） |
| POST | `/api/deploy?type=package&file=<包名>` | 非 Web 应用：上传安装包（raw body），服务端在预留端口发布下载链接（落地页 + 附件下载），下载可用即视为部署完成 |
| POST | `/api/hit` | 人气上报（JS 可选路径）：`{projectId, terminal?, kind?}`——按「终端 + 项目 + `HIT_WINDOW_MS`」去重；终端取 Cookie `hk_term` 或请求体，缺失时当场签发；每终端 30 次/分、每 IP 600 次/分限频 |
| GET | `/api/hit/go?projectId=` | 人气 + 跳转：计数后 302 到项目线上地址（安装包交付则直达安装包），不依赖前端 JS；未部署/已吊销项目不计数并跳回大屏 |
| GET | `/api/hits` | 查询人气值：带 `x-access-key` 返回单项目，否则返回当前活动人气前 20 |
| POST | `/api/score` | AI 参考评分上报（**仅最终提交后**）：`{accessKey, score(0-100), detail}`，参数错误 `INVALID_SCORE`(400)/未提交 `SCORE_NOT_ALLOWED`(409)；评分规范见 docs/AI-SCORING.md |
| GET | `/api/score` | 查询已存档的参考分与明细（`x-access-key` 请求头） |
| POST | `/api/bind-client` | 手工发 key 模式绑定客户端：`{accessKey, clientId}`；首次绑定成功、同 clientId 幂等、他人已绑定 → 409 `CLIENT_MISMATCH` |
| GET | `/api/report/status?accessKey=` | 查询进度（含 loopCount）、下一节点与预留端口 |
| POST | `/api/loop` | `{accessKey}` 开新一轮迭代：进度重置、loop_count+1（≥上线部署才允许）；409 `LOOP_NOT_ALLOWED` |
| POST | `/api/deploy?accessKey=&type=&start=&install=` | 上传构建产物（raw tgz/zip body）自动部署 |
| GET | `/api/deploy/status?accessKey=` | 查询部署进程状态 |
| GET | `/api/snapshot` | 大屏全量快照 |
| GET | `/api/stream` | SSE 实时刷新信号 |
| GET | `/healthz` | 健康检查 |

管理（需 Cookie）：

`POST /api/admin/login` · `GET/POST/PUT/DELETE /api/admin/events` · `POST /api/admin/events/:id/activate` · `GET/POST/PUT/DELETE /api/admin/departments|groups（?eventId=）` · `POST /api/admin/import/csv（?eventId=）` · `GET/POST /api/admin/projects（?eventId=）` · `POST /api/admin/projects/:id/revoke|restore|archive` · `DELETE /api/admin/projects/:id（彻底删除已归档）` · `POST /api/admin/projects/:id/rebind-client（解绑客户端标识）` · `GET/POST /api/admin/register-token（本期注册令牌签发/轮换）` · `GET /api/admin/ports` · `GET /api/admin/deploys` · `POST /api/admin/deploys/:id/start|stop|restart` · `GET /api/admin/meta`

上报错误码：`INVALID_KEY`(404) / `KEY_REVOKED`(403) / `RATE_LIMITED`(429) / `INVALID_STAGE`(400) / `STAGE_OUT_OF_ORDER`·`STAGE_ALREADY_DONE`(409)；loop 错误码：`LOOP_NOT_ALLOWED`(409)。上报可携带 `evidence` 对象；「上线部署」上报时服务端会主动探测项目端口并记录探活结果。

## 自动部署

「上线部署」节点由服务端代为部署，小组无需登录服务器：

```
Agent 执行: node report.js --deploy [--dir dist] [--type node|static] [--start "npm start"] [--no-install]
        │
        ▼
1. 打包：目标目录打为 tgz（排除 node_modules / .git）
        ▼
2. 上传：POST /api/deploy（accesskey 鉴权，上限 DEPLOY_MAX_MB 默认 200MB）
        ▼
3. 起服：解压到 data/deploys/<项目ID>/app → node 类型按需 npm install --omit=dev
          再以 PORT=<预留端口> 启动（static 类型由服务端直接托管静态文件）
        ▼
4. 探活：DEPLOY_START_TIMEOUT_MS（默认 60s）内探测预留端口
        ▼ 通过
自动上报「上线部署」（证据入审计表）→ 大屏链接点亮 → 崩溃自动重启（最多 10 次）
        ▼ 失败
返回错误 + 应用日志末尾，不上报；流程未到该节点时部署成功但不推进进度
```

`hackathon.config.json` 的 `deploy` 配置：`{ "type": "node"|"static", "start": "npm start", "install": true, "dir": "." }`，均可被 CLI 参数覆盖。部署地址确定顺序：`--url` > 配置 `deployUrl` > 服务端预留端口（`http://localhost:<port>`）。

## 验收自动化

第 7 节点「线上验收」不靠自我申报，由 skill CLI 的 `--verify` 命令驱动：

```
部署完成（deployment 已上报）
        │  node report.js --verify
        ▼
1. 探活：HTTP 请求部署地址，最多重试 8 次
        ▼
2. 接口测试：运行 hackathon.config.json 里 verify.api 命令（注入 DEPLOY_URL 环境变量）
        ▼
3. E2E 测试：运行 verify.e2e 命令（同样注入 DEPLOY_URL）
        ▼ 全部通过
自动上报「线上验收」+ 验证证据（evidence 入审计表）→ 大屏 100% 徽章
        ▼ 任一步失败
退出码 3，不上报验收；修复后重新 --verify（--dry 可只验证不上报）
```

部署地址确定顺序：`--url` > 配置 `deployUrl` > 服务端预留端口（`http://localhost:<port>`）。

## 监管规则（服务端强制）

- 节点只能按 8 节点顺序单调前进，禁跳节点、禁回退、禁重复；
- 每项目成功上报间隔 ≥ 10 秒（被拒请求不消耗限频窗口）；
- accesskey 吊销后立即拒绝上报；
- 所有上报写入 `reports` 审计表（IP、时间、拒绝原因）。
