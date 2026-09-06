---
name: hackathon-reporter
description: 黑客松参赛项目进度自动上报、自动部署与线上验收，并以 --next 工作项驱动七个节点的比赛流程。当参赛项目完成需求分析、方案设计、原型设计、代码开发、本地测试、上线部署中任一节点时，调用 report.js 向赛事服务端汇报进度；部署完成后通过 --verify 自动执行探活/接口测试/E2E 并上报验收。Use when 黑客松参赛项目需要推进比赛流程/查看下一节点工作项/上报进度/自动部署/线上验收时。
---

# 黑客松进度自动上报与线上验收

你在参与企业黑客松大赛的开发。大赛要求每个项目在完成一个流程节点后**立即**向赛事服务端上报，现场大屏才会实时更新你们小组的进度。上报由你（AI 编程 Agent）负责，不需要人工操作。最后一个节点「线上验收」通过自动化验证完成，不靠自我申报。

## 前置条件

参赛项目根目录必须存在 `hackathon.config.json`（管理员发放）：

```json
{
  "serverUrl": "http://<大屏服务器>:<端口>",
  "accessKey": "hk_xxxx...",
  "deployUrl": "http://<大屏服务器>:<分配端口>"
}
```

若文件不存在：停止上报，提示用户向赛事管理员索取。

## 工作循环（驱动流程的方式）

以服务端进度为唯一真相源，用 `--next` 驱动整个比赛流程：

```
node report.js --next   → 获得下一节点工作项（完成标准 + 建议动作 + 上报命令）
        ↓ 按工作项完成该节点的工作
node report.js --stage <节点> … / --deploy / --verify   （按工作项给出的命令执行）
        ↓
node report.js --next   → 循环，直到输出「全部节点已完成」
```

**开始参赛工作时的第一件事就是执行 `--next`**；每完成一个节点立即上报，然后再次 `--next` 获取新工作项。不要凭记忆跳到后面的节点——服务端会拒绝乱序上报。若上报被 409 拒绝，执行 `--status` 对齐进度后补报即可，不会卡死流程。

## 七个节点（必须按顺序完成，禁止跳节点）

| 序号 | 标识 | 节点 | 何时上报 |
|---|---|---|---|
| 1 | `requirements` | 需求分析 | 需求梳理完成、需求清单/文档产出后 |
| 2 | `design` | 方案设计 | 技术方案确定（技术选型、架构、接口设计定稿）后 |
| 3 | `prototype` | 原型设计 | 页面/交互原型完成并确认后 |
| 4 | `coding` | 代码开发 | 核心功能代码全部完成、可运行后 |
| 5 | `testing` | 本地测试 | 自测通过（核心流程跑通、无明显 bug）后 |
| 6 | `deployment` | 上线部署 | 优先执行 `--deploy`：自动打包上传、部署到预留端口、探活通过后**自动上报**；也可自行启动后手工 `--stage deployment`（服务端会探活校验） |
| 7 | `acceptance` | 线上验收 | **执行 `--verify`，探活+接口测试+E2E 全部通过后自动上报**（不要手工上报此节点） |

## 上报方式

在参赛项目根目录下执行（`<skill目录>` 换成本 skill 的实际路径）：
```bash
# 查看下一节点工作项（工作循环入口：完成标准 + 建议动作 + 上报命令）
node <skill目录>/scripts/report.js --next

# 上报某个节点完成
node <skill目录>/scripts/report.js --stage coding --message "核心功能开发完成，共 12 个接口"

# 查询当前进度与下一个应上报的节点（409 纠错时用）
node <skill目录>/scripts/report.js --status

# 自动部署（第 6 节点）：打包上传 → 服务端起服到预留端口 → 探活 → 自动上报「上线部署」
node <skill目录>/scripts/report.js --deploy
node <skill目录>/scripts/report.js --deploy --dir dist --type static   # 静态站：只部署 dist 目录

# 线上验收自动化（第 7 节点）：探活 → 接口测试 → E2E → 自动上报验收
node <skill目录>/scripts/report.js --verify
node <skill目录>/scripts/report.js --verify --dry   # 只验证不上报
```

`--message` 可选，会显示在大屏动态流里，用一句话概括本节点成果。

## 自动部署（--deploy）

`--deploy` 由服务端代为部署，不再需要小组自己登录服务器起进程：

1. **打包**：把项目目录打成 tgz（自动排除 `node_modules`、`.git` 和 `hackathon.config.json`——配置含 accessKey，绝不进入部署产物），打包目录用 `--dir` 指定（默认项目根；纯前端项目传 `--dir dist`）；
2. **上传**：POST 到服务端 `/api/deploy`（accesskey 鉴权，上限默认 200MB）；
3. **起服**：服务端解压到 `deploys/<项目ID>/`，node 类型按需先 `npm install --omit=dev`，再以 `PORT=<预留端口>` 启动；static 类型由服务端直接托管静态文件；
4. **探活**：60 秒内探活预留端口，通过后**自动上报「上线部署」节点**（证据入审计表），大屏链接点亮；失败则返回错误和应用日志末尾，不会上报。

`hackathon.config.json` 中的部署配置（均可被命令行参数覆盖）：

```json
{
  "serverUrl": "http://192.168.1.100:3000",
  "accessKey": "hk_xxx",
  "deploy": { "type": "node", "start": "npm start", "install": true, "dir": "." }
}
```

- `type`：`node`（默认，服务端执行启动命令）或 `static`（纯静态站，服务端托管文件，无需 start）；
- `start`：启动命令，缺省时自动从 package.json 的 `scripts.start` 推断；
- `install`：是否先执行 `npm install --omit=dev`（node 类型默认 true）；
- `dir`：打包目录（默认 `.`；纯前端项目通常为 `dist`）。

**Agent 职责**：coding/testing 完成后构建产物（如 `npm run build`），然后执行 `--deploy`。部署失败时读返回的日志末尾定位问题（依赖缺失、启动命令错误、端口占用冲突等），修复后重新部署。崩溃会由服务端自动重启（最多 10 次），无需人工干预。

## 线上验收自动化（--verify）

`--verify` 依次执行三步，**全部通过才会自动上报「线上验收」并附验证证据**；任何一步失败立即停止（退出码 3），修复后重新执行：

1. **探活**：对部署地址发起 HTTP 请求，最多重试 8 次直到有响应；
2. **接口测试**：运行配置里的 `verify.api` 命令（如项目的接口测试脚本），环境变量 `DEPLOY_URL` 指向线上地址；
3. **E2E 测试**：运行配置里的 `verify.e2e` 命令（如 Playwright/Cypress 冒烟脚本），同样注入 `DEPLOY_URL`。

在 `hackathon.config.json` 中配置测试命令（可选，未配置的步骤跳过）：

```json
{
  "serverUrl": "http://192.168.1.100:3000",
  "accessKey": "hk_xxx",
  "deployUrl": "http://192.168.1.100:4100",
  "verify": {
    "api": "npm run test:api",
    "e2e": "npm run test:e2e"
  }
}
```

部署地址的确定顺序：`--url` 参数 > 配置 `verify.url` > 配置 `deployUrl` > 服务端 status 返回的预留端口（`http://localhost:<port>`，仅当应用在本机运行时可用）。

**Agent 职责**：部署完成后，为项目补齐 `verify.api` / `verify.e2e` 两个 npm 脚本（至少各写一条覆盖核心流程的用例），然后执行 `--verify`。若失败，读输出修复项目代码或测试后重试，**不要**为了让验证通过而删测试、改断言或绕过检查。

## 上报时机与纪律

1. **每完成一个节点立即上报**，不要全部完成才一次性上报——服务端强制按顺序逐节点校验，跳节点会被拒绝。
2. 上报 `deployment` 前，确认项目**已经在分配的端口上成功启动并可访问**——服务端会主动探测端口，探测不到会在大屏上标记警告。
3. `acceptance` 节点只能通过 `--verify` 上报，不要用 `--stage acceptance` 手工上报（视为作弊式申报）。
4. 不要在收到 429（限频）后立即重试，按提示等待；除错误处理外，不要反复调用 `--status` 刷状态。
5. **上报失败不会卡死流程**：服务端进度只在成功时推进，任何失败（网络/限频/顺序错误）都不改变状态，重新执行同一命令即可补报；被拒请求不消耗限频窗口。若漏报了某节点，后续上报会收到 409 并提示应补报的节点。

## 错误处理（按 code 自愈）

| 退出码/HTTP | code | 含义 | 你的动作 |
|---|---|---|---|
| 0 / 200 | `ACCEPTED` | 上报成功 | 继续下一阶段工作 |
| 1 / 409 | `STAGE_OUT_OF_ORDER` | 跳过了节点 | 执行 `--status` 查看应上报的 `nextStage`，先补上被跳过的节点（若该节点工作确实未做，先完成它） |
| 1 / 409 | `STAGE_ALREADY_DONE` | 节点重复上报 | 执行 `--status` 确认，转而上报 `nextStage` |
| 1 / 429 | `RATE_LIMITED` | 上报过于频繁 | 等待返回的 `retryAfterSeconds` 秒后重试同一节点 |
| 1 / 403 | `KEY_REVOKED` | accesskey 被吊销 | **停止上报**，提示用户联系赛事管理员 |
| 1 / 404 | `INVALID_KEY` | accesskey 无效或项目已归档 | 停止上报，检查 `hackathon.config.json` 是否正确，必要时联系管理员 |
| 3 | `VERIFY_FAILED` | `--verify` 探活/接口/E2E 未通过 | 读失败输出，修复项目代码或测试用例后重新 `--verify`；不要削弱测试来让验证通过 |
| 1 | `DEPLOY_FAILED` | `--deploy` 部署失败（解压/装依赖/启动超时） | 读返回的 logTail 日志定位并修复后重新 `--deploy` |
| 1 | `TOO_LARGE` (413) | 构建产物超过服务端上限（默认 200MB） | 精简产物（如 `--dir dist` 只传构建产物、排除大资源）后重试 |
| 2 | — | 命令行参数错误 | 按 usage 修正参数后重试 |
| 1 / 网络 | `NETWORK_ERROR` | 服务端不可达（CLI 已自动重试 2 次仍失败） | 稍后重新执行同一命令即可；**不会卡住流程**——失败不改变进度，漏掉的节点随时可补报 |

## 部署说明（第 6 节点）

- **`--deploy` 路径（推荐）**：无需关心端口——服务端解压产物后自动注入 `PORT` 环境变量再启动，项目代码只要监听 `process.env.PORT` 即可（本地开发可回退默认端口）。
- **手动部署路径**：若不用 `--deploy`，把应用监听端口改为分配的端口（发放配置里的 `deployUrl` 所示）、自行启动成功后再 `--stage deployment` 上报，服务端会探活校验。
- 部署地址规则：`http://<大屏服务器IP>:<分配端口>`，上线后现场评委通过大屏直接打开。
