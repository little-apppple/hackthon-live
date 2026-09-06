# 企业黑客松大赛实时大屏系统

Node.js 全栈（Express + node:sqlite + Vite/React/ECharts）的黑客松现场驾驶舱：**多期活动数据完全隔离**，大屏实时展示 **部门 → 小组 → 项目** 三级进度，项目通过 **上报 Skill** 自动汇报 7 个流程节点、`--deploy` 自动部署到预留端口、`--verify` 自动化线上验收。SQLite 使用 Node 22.5+ 内置的 `node:sqlite`，无需任何原生编译。

完整需求见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。

## 目录结构

```
dashboard/
├─ server/            # Express API + SSE + SQLite（单进程生产服务，node:sqlite 内置驱动）
├─ web/               # Vite + React：大屏页(/) + 管理后台(/admin)
├─ skill/hackathon-reporter/   # 发给参赛项目的上报 skill（SKILL.md + report.js）
├─ scripts/seed.js    # 初始名单导入
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
npm run demo           # 生成各阶段混合的演示项目数据（开发/演示用）
npm run smoke          # 端到端冒烟测试（75 项断言：认证/CSV/上报强约束/探活/吊销/端口复用/审计/活动隔离/端口区间）
npm run verify:e2e     # 验收自动化端到端测试（通过/失败/未部署三条路径）
npm run deploy:e2e     # 自动部署端到端测试（node/static/自动上报/重启停止/未到节点）
```

- 大屏：`http://localhost:3000/`
- 管理后台：`http://localhost:3000/admin`（默认密码 `hackathon2026`）
- 开发模式：`npm run dev:server` + `npm run dev:web`（Vite 5173，/api 自动代理）

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
| `DEPLOY_ROOT` | server/data/deploys | 自动部署产物与运行目录 |
| `DEPLOY_MAX_MB` | 200 | 部署产物大小上限 |
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
5. **自动部署（上线部署节点）**：小组 Agent 执行 `node report.js --deploy`——自动打包上传（排除 node_modules/.git），服务端解压到 `data/deploys/<项目ID>/`、按需 `npm install`、以预留端口启动（或托管静态站），60 秒内探活通过后**自动上报「上线部署」**并点亮大屏链接。崩溃自动重启（最多 10 次），服务重启后自动恢复全部部署。
6. **线上验收（自动化）**：小组 Agent 执行 `node report.js --verify`——依次完成**线上应用探活 → 接口测试（`verify.api`）→ E2E 测试（`verify.e2e`）**，全部通过后自动上报验收并附证据；任一步失败则不上报（退出码 3），修复后重试。
7. **监管**：后台可查看各项目部署进程状态、停止/启动/重启；可随时吊销/恢复 accesskey、归档项目（归档自动停服并释放端口）；所有上报（含被拒）与部署/验收证据都有审计记录。

## API 一览

公开：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/report` | 上报节点完成 `{accessKey, stage, message, evidence?}` |
| GET | `/api/report/status?accessKey=` | 查询进度、下一节点与预留端口 |
| POST | `/api/deploy?accessKey=&type=&start=&install=` | 上传构建产物（raw tgz/zip body）自动部署 |
| GET | `/api/deploy/status?accessKey=` | 查询部署进程状态 |
| GET | `/api/snapshot` | 大屏全量快照 |
| GET | `/api/stream` | SSE 实时刷新信号 |
| GET | `/healthz` | 健康检查 |

管理（需 Cookie）：

`POST /api/admin/login` · `GET/POST/PUT/DELETE /api/admin/events` · `POST /api/admin/events/:id/activate` · `GET/POST/PUT/DELETE /api/admin/departments|groups（?eventId=）` · `POST /api/admin/import/csv（?eventId=）` · `GET/POST /api/admin/projects（?eventId=）` · `POST /api/admin/projects/:id/revoke|restore|archive` · `DELETE /api/admin/projects/:id（彻底删除已归档）` · `GET /api/admin/ports` · `GET /api/admin/deploys` · `POST /api/admin/deploys/:id/start|stop|restart` · `GET /api/admin/meta`

上报错误码：`INVALID_KEY`(404) / `KEY_REVOKED`(403) / `RATE_LIMITED`(429) / `INVALID_STAGE`(400) / `STAGE_OUT_OF_ORDER`·`STAGE_ALREADY_DONE`(409)。上报可携带 `evidence` 对象；「上线部署」上报时服务端会主动探测项目端口并记录探活结果。

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

- 节点只能按 7 节点顺序单调前进，禁跳节点、禁回退、禁重复；
- 每项目上报间隔 ≥ 10 秒（含被拒请求）；
- accesskey 吊销后立即拒绝上报；
- 所有上报写入 `reports` 审计表（IP、时间、拒绝原因）。
