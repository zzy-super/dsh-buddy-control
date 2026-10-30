---
name: buddy-control
description: 用 DSH 当中控台：先摸清本机装了什么、缺什么并全自动部署（装软件、打通 MCP/插件/模型），再把活派给 CodeBuddy / WorkBuddy 并自己验收——不合格就给修改方向打回同一会话返工。派活、返工、换机器部署、多文件改造、要求「必须过验收 / 必须改到对」的任务时加载。
---

# Buddy 中控：部署 + 派活 + 验收 + 返工

工具来自 `dsh-buddy-control` 插件。核心纪律：**验收靠 DSH 自己看产物，不靠 worker 的自述**；不合格就打回，`reject` 比手写第二遍便宜。

## 什么时候用

- 换机器 / 第一次用 / 不确定装没装：`buddy_discover` → `buddy_deploy`
- 活够大、值得派出去（多文件改造、整份文档、跑构建/测试、批量整理）：`buddy_run`
- 要求「必须对」而不是「大概对」：一定要带 `acceptance` + `checks`
- 只想问一句、不需要验收：用 `console_delegate`（`dsh-console` 插件），别开监督流程

## 第 0 步：这台机器能用吗

永远先 `buddy_status`（零成本）。看到 `missing` 非空、或 `workers.*.installed:false`、或路径不对，就走部署：

```js
buddy_discover({ refresh: true })          // 装了什么、在哪、缺的怎么装
buddy_deploy({ apply: true, acceptInstall: true, profile: { model: "latest" } })
```

- `buddy_deploy` 返回 `verified.ok:true` 才算部署成功——它最后会用一次真实调用（PONG + 模型核对）验收。**只看 `application` 或安装成功不算。**
- 装软件必须 `apply:true` **且** `acceptInstall:true`；只给 `apply` 会停在 `planned`。
- 失败时读 `failed[].detail`（一条一个原因），修掉再调一次；所有 step 幂等。
- 部署不是一次性的：改了 `profile`（比如要加 MCP、加插件、换模型）就再跑一次，已收敛的 step 会返回 `present`，不会重复写。

## 工具本身不对时

`buddy_doctor` 先跑：它查插件挂载、依赖、账本、技能、设备、模型漂移、最近失败，每条带 `fix`，并给一段脱敏 `report`。把 `report` 贴出去就是一份完整现场。

有一种它诊断不到：日志里 `failed to import ... ERR_MODULE_NOT_FOUND`，所有 `buddy_*` 工具都不出现——那是插件加载期挂了，跑包里的 `install.ps1`。其余症状查 `TROUBLESHOOTING.md`。

## 别把「路径不对」当成「没装」

插件运行时用的是**发现结果**，配置里的 `codebuddyEntry` / `workbuddyEntry` 只是首选值：

- WorkBuddy 的安装路径来自注册表 `DisplayIcon`（`InstallLocation` 常常是空的）；
- 所有盘符的 `Program Files`、`%LOCALAPPDATA%\Programs` 都是候选；
- CodeBuddy CLI 探各 npm 全局根。

所以报「找不到」时，先 `buddy_discover` 看真实路径和 `missing`，不要直接改配置里的路径。

## 标准闭环

1. **先看状态**（零成本）：`buddy_status`。确认 worker 在、模型 `compliant: true`、有没有 `drift`。
2. **派活**：`buddy_run`，三件事必须给全：
   - `task`：自包含。worker 没有你的上下文，别写「刚才那个文件」。
   - `acceptance`：你打算怎么判它。写成可打勾的条目，不要写「做好一点」。
   - `checks`：能机械判定的部分（文件在不在、JSON 合不合法、命令退码、正则命中）。有 check 就不用把整篇产物读进来，省 token。
3. **自己验收**：读关键产物（`read`/`grep`），对照 `acceptance` 逐条过。**不要**把 worker 的 `result` 当证据。
4. **判定**：
   - 过 → `buddy_review({runId, verdict: "accept", criteria})`
   - 不过 → `buddy_review({runId, verdict: "reject", issues: [...], directions})`
5. **打回要点**（这决定返工质量）：
   - `issues` 一条一个具体缺陷，带 `where`（文件:行）和 `direction`（怎么改）。
   - `directions` 写「只改什么、不要动什么」，防止 worker 顺手重写已通过的部分。
   - `severity` 用 `blocker` / `major` / `minor`，让 worker 知道先修哪个。
   - 空 reject（没 issue 也没 directions）会被工具拒绝——这是有意的。
6. **收尾**：检查项全绿后再 `accept`。轮次打光（默认 4 轮）会返回 `exhausted`：说明任务太大，拆小重派，不要无限重试。

## 判断是「活没干好」还是「工人缺能力」

`ok: false` 或者产出明显不对时，先 `buddy_gaps({runId})`：

| gap | 含义 | 动作 |
| --- | --- | --- |
| `auth` | 没登录 | `autoFixable:false`，让用户人工 `/login`；别重试 |
| `missing-mcp` | MCP 服务没起/没配 | `buddy_provision({mcp:{name,url}, apply:true})` |
| `missing-tool` | 调了没有的工具 | 启用对应 Buddy 插件：`buddy_provision({plugin:"…", apply:true})` |
| `permission` | 被权限层拦 | `buddy_provision({runId, apply:true})` 会 trust 工作目录；或在下次 run 里提 `permissionMode` |
| `missing-executable` / `missing-node-package` | 缺命令/包 | `buddy_provision({npmPackage:"…", apply:true, confirmInstall:true})` |
| `model` | 模型 id 不被接受 | `buddy_provision({model:"<id>", apply:true})` 或下次 run 显式传 `model` |
| `context` / `timeout` | 任务过大/过慢 | 拆任务、加 `timeoutSec`；不要归因于工人能力 |
| `no-result` | 没跑完就退 | 看 `stderr` 尾巴，加 `maxTurns` 重试一次 |

**关键判断**：`buddy_gaps` 返回空，说明工人该有的都有——那就是方案问题，继续打回，别去装插件。

## 模型纪律

- 不要随便传 `model`。默认 `latest` 会解析到 CLI 支持的最新 DeepSeek id。
- 每次结果里的 `model.observed` / `model.verified` 是**实际**请求的模型（来自 providerData），不是猜的。
- `model.drift` 出现 = worker 回落到别的模型 → `buddy_provision({model:"<pinned>", apply:true})` 钉死。
- 报告给用户时带上 `model.label`（例如 V4.1-1017）和 `model.observed`，别只说「用了最新模型」。

## 省 token

- `result` 只保留最终答案（限长 `maxOutputChars`），不要贴转录。
- 能写成 `checks` 的验收不要靠读全文。
- 一轮读完就下结论；不要为了「再看看」多跑一轮 worker。

## 边界

- 插件只改 worker 自己的配置（`~/.codebuddy`），不碰 DSH profile。
- `buddy_provision` / `buddy_deploy` 默认只出计划；写盘前会留 `.bak-<时间戳>` 备份。
- 登录、配额、网络被墙这类缺口不是插件能修的，直接告诉用户。
- 设备画像在 `~/.dsh/buddy-control/devices/<主机名>.json`；`buddy_status.devices` 列出所有跑过的设备。远程设备目前要各自在本机跑 DSH——没有 SSH 落地，别假装能推。
