# 技能包下发与自助注册 · 使用手册

> 适用版本：支持 `POST /api/register` 自助注册的服务端（2026-09 之后）。
> 本手册覆盖「**管理员打包下发技能包 → 参赛队 init 自助注册 → 卡点上报与部署验收**」的完整闭环；
> 通用大屏操作见 [USERGUIDE.md](USERGUIDE.md)，部署运维见 [README.md](../README.md)。
> 下文以 `http://47.108.217.153:50000` 为例，请替换为你的服务端地址。

---

## 0. 流程总览

```
管理员                                    参赛小组（AI Agent 代为操作）
  │
  ├─ 建活动（名单可留空，注册时自动录入）
  ├─ node scripts/pack-skills.js            ──►  hackathon-skills.tgz
  │    （自动登录取本期注册令牌，连同上报地址烘入 server.json）
  ├─ 把 tgz 发给各队（群文件/内网共享）      ──►  解压到参赛项目根目录
  │                                              │
  │                                         node skill/hackathon-reporter/scripts/report.js --init
  │                                              │  填：部门 / 小组 / 项目名称
  │                                         POST /api/register（带注册令牌）
  │                                              ▼
  ├─ 后台可见：名单自动录入、端口已预留     ◄──  返回 accessKey（幂等：同名只发一次）
  │                                              │
  └─ 大屏实时看进度                     ──►  --next 工作循环 → 上报 → 部署 → 验收
```

**幂等与客户端绑定（核心设计）**：每个项目首次接入时生成唯一客户端标识 `clientId`（`cli_` 开头，写入 `hackathon.config.json`），并绑定到服务端项目。

- **同一 clientId** 重复注册 → 返回**同一把 accessKey**（可安全重跑、可多处补发；名称以首次注册为准）；
- **不同 clientId** 使用完全相同的「部门 + 小组 + 项目名称」→ 被拒绝（409 `NAME_TAKEN`），**不会互相覆盖进度**；
- 换机器/重装请把 `hackathon.config.json` 一起带走；丢失时由管理员在后台「解绑客户端」后重新接入。

---

## 1. 赛事管理员

### 1.1 赛前：打包技能包（推荐方式）

前置：服务已启动、本期活动已「设为当前」。**名单不必预录**——各队注册时自动录入。

```bash
# 在服务器（或能访问服务端的机器）上，项目根目录执行：
ADMIN_PASSWORD=你的管理密码 node scripts/pack-skills.js --server http://47.108.217.153:50000
```

产出 `hackathon-skills.tgz`（约 25KB），内含：

| 内容 | 说明 |
|---|---|
| `skill/hackathon-reporter/` | 上报/部署/验收 CLI（零依赖，Node ≥18） |
| `skill/vibecoding-workflow/` | Vibe Coding 流程 skill（可选安装） |
| `skill/hackathon-reporter/server.json` | **上报地址 + 本期注册令牌**（打包时自动写入） |
| `安装说明.txt` | 参赛队三步接入指引 |

把 tgz 发到参赛群/内网共享即可。

**注册令牌管理**：

- 令牌按「当前活动」签发（`reg_` 开头），打包时脚本自动从后台取回烘入，明文不落日志；
- `GET /api/admin/register-token` 幂等签发（同一期重复取是同一个令牌）；
- `POST /api/admin/register-token` **轮换**：旧技能包的令牌立即失效，需要重新打包下发（令牌怀疑泄露时用）；
- 每期活动的令牌相互独立，下一期打包时自动换新。

### 1.2 两种接入模式怎么选

| 模式 | 流程 | 适合 |
|---|---|---|
| **A · 自助注册**（本手册） | 打包下发 → 各队 `--init` 填三个名字自动报名 | 开赛现场集中报名、队伍多、名单未定 |
| **B · 后台建项目发 key**（原有流程） | 后台「项目与密钥」手工建项目 → 复制配置 JSON 发给该队 | 名单已确定、想逐队审核、补录遗漏队伍 |

两种模式可混用：后台手工创建的项目，同名自助注册会**直接返回后台发的那把密钥**（幂等），不会重复建项。

### 1.3 比赛中：注册相关的管理

- **注册审计**：每次成功注册写入动态流（显示为「自助注册」），含时间与来源 IP；管理员事后可追溯；
- **客户端绑定**：后台项目列表的「客户端」列显示已绑定的 clientId 前缀，用于区分同名/近似项目；队伍换机器或丢失配置时，点该列按钮「解绑」清空绑定，该队即可用新配置重新接入（原 accessKey 不变）；
- **名单修正**：注册产生的部门/小组出现在后台「名单管理」，可改名（改名后该队原密钥不受影响）；
- **吊销/恢复**：与手工建的项目一致（项目列表 → 吊销）；被吊销的项目即使同名重新注册，也只会取回原密钥并被 CLI 拒绝继续，需管理员「恢复」；
- **防刷**：注册接口每 IP 限频 10 次/分钟（按直连 IP 计——**勿把服务置于未配置 realip 的反向代理之后**，否则所有队伍共享一个 IP 会被集体限频）。

---

## 2. 参赛小组

### 2.1 接入（三步）

**① 解压技能包**到你的参赛项目根目录（解压后得到 `skill/` 目录）。

**② 自动注册**（在项目根目录，Agent 可代为执行）：

```bash
node skill/hackathon-reporter/scripts/report.js --init
```

按提示依次输入 **部门、小组、项目名称**（可加一句项目简介，回车跳过）。也可一次性带参：

```bash
node skill/hackathon-reporter/scripts/report.js --init \
  --department 研发中心 --group 先锋队 --project 智能周报助手
```

成功后会看到：

```
✓ 注册成功，已录入名单并预留部署端口
  accessKey: hk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  部署端口: 4100（http://47.108.217.153:4100）
```

**注册信息（用于大屏/后台展示）**：`--init` 会依次提示填写 一句话需求（展示用，非流程里的需求分析）/ 参与人员（人员维度页数据源，建议填全）/ 项目价值 / 核心功能 / 应用场景（均可回车跳过）。也可一次性带参：

```bash
node skill/hackathon-reporter/scripts/report.js --init --department 研发中心 --group 先锋队 --project 智能周报助手 \
  --members "张三、李四" --summary "一句话需求" --value "业务价值" --features "功能A、功能B" --scenario "使用场景"
```

信息显示在大屏项目详情（点击项目卡）与后台「查看」中；**同一客户端重跑 `--init --force` 可更新**（名称与密钥不变）。

**③ 开始干活**：`--init` 成功后会**自动运行环境检测**（Node/git/服务端可达性/verify 配置/.gitignore 是否忽略 accessKey 配置等），并输出六步「用户引导」——照着提示走即可；之后随时可单独执行 `node skill/hackathon-reporter/scripts/report.js --doctor` 重新检测。然后进入工作循环（`--next` 查看下一节点工作项 → 完成后按给出的命令上报 → 再 `--next`）。完整循环说明见 [USERGUIDE.md §2.2](USERGUIDE.md)。

### 2.2 幂等：你不用担心这些场景

| 场景 | 结果 |
|---|---|
| `--init` 执行了两次 / 中途断网重跑 | 返回**同一把** accessKey，安全 |
| 换了台电脑重新接入（带着原 config） | 同样返回原密钥，配置重新生成 |
| 误把项目名写错、注册了个新项目 | 错误项目请找管理员归档删除；正确名称重新 `--init --force` |
| `--init --force` 重跑 | **clientId 保持不变**，仍绑定到同一项目 |
| 同一小组做两个项目 | 需在**另一个目录**接入（会生成新 clientId）；一个 clientId 始终对应一个项目——同名/换名都不会变成第二个项目 |
| 两个队名称完全相同（不同 clientId） | 第二队被拒 409 `NAME_TAKEN`——提醒其确认是否已注册过，或改名/请管理员处理 |

### 2.3 注册之后：补两处配置

打开项目根目录的 `hackathon.config.json`（`--init` 已自动生成），按需修改：

```json
{
  "serverUrl": "http://47.108.217.153:50000",
  "accessKey": "hk_你的密钥",
  "deployUrl": "http://47.108.217.153:4100",
  "deploy": { "type": "node", "start": "npm start", "install": true, "dir": "." },
  "verify": { "api": "npm run test:api", "e2e": "npm run test:e2e" }
}
```

- **端口是报名时分配的**，你的应用必须监听它（Node 服务监听 `process.env.PORT` 即可，`--deploy` 会自动注入）；
- `verify.api` / `verify.e2e` 指向你自己的测试命令（建议在「本地测试」节点写好，线上验收要跑它们）；
- 纯前端静态站把 `deploy` 改为 `{ "type": "static", "dir": "dist" }`。

### 2.4 进阶：让 Agent 按 Vibe Coding 流程走（可选）

技能包里还有 `vibecoding-workflow` skill，它把需求→设计→原型→编码→测试→部署→验收组织成带硬门禁的流程，且卡点与上报节点一一对应。在项目根执行一次：

```bash
node skill/vibecoding-workflow/scripts/setup.js          # 检测环境 + 生成 CLAUDE.md/AGENTS.md
node skill/vibecoding-workflow/scripts/setup.js --fix    # npm 依赖安装 + skill 装入 .claude/skills/
```

### 2.5 注册环节出错速查

| 报错 | 含义 | 处理 |
|---|---|---|
| `REGISTER_TOKEN_INVALID` | 技能包缺令牌或令牌已轮换 | 用**本期最新**下发的技能包；或找管理员要令牌后 `--register-token <令牌>` 直填 |
| `RATE_LIMITED`（注册） | 同 IP 注册超 10 次/分钟 | 等一分钟再试 |
| `INVALID_PARAMS` | 部门/小组/项目名有空或超 50 字 | 检查后重试 |
| `NAME_TAKEN` | 该「部门/小组/项目名」已被其他客户端注册 | 确认是否本队已接入过（找回原 `hackathon.config.json`）；否则改名，或请管理员解绑/归档旧项目 |
| `CLIENT_MISMATCH` | 该密钥已绑定其他客户端（手工发 key 模式） | 换机器接入导致：请管理员在后台「解绑客户端」后重试 |
| `NO_FREE_PORT` | 端口池分配完毕 | 联系管理员调整端口区间或归档旧项目 |
| `PORT_CONFLICT` | 注册瞬间端口被占（罕见） | 原样重跑 `--init --force` |
| `HTTP 404` | 服务端版本过旧，不支持自助注册 | 改用管理员发 key 模式：`--init --server-url <地址> --access-key <密钥>` |
| 提示密钥已被吊销 | 同名项目先前被管理员吊销 | 联系管理员「恢复」，或换项目名重新注册 |

---

## 3. 安全模型（管理员须知）

- **令牌即报名能力**：持有本期令牌才能注册；部门/小组/项目名虽在大屏公开可见，但没有令牌无法换取任何 accessKey；
- **令牌明文随包分发**：请通过可信渠道（内部群、内网共享）下发 tgz；泄露时 `POST /api/admin/register-token` 轮换并重新打包；
- **传输前提**：令牌经 HTTP 明文传输，适用于内网/可信网络环境；公网部署建议上 HTTPS 反代（注意 realip 配置，见 §1.3）；
- **最小授权**：令牌只用于注册，不能上报、不能部署——每队后续操作仍由其独立 accessKey 鉴权，可单独吊销。
