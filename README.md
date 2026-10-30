# dsh-buddy-control

DSH 当中控台，CodeBuddy / WorkBuddy 当工人：**派活 → 自己验收 → 不合格带着修改意见打回同一会话返工 → 顺带把工人缺的能力补上**，全程锁最新的 DeepSeek 模型。

它和 `dsh-console` 的分工：`console_delegate` 是「派一次、拿结果」；本插件是「派一次、**判定结果**、不合格就返工，直到过验收」。两个可以同时装。

> **安全性**：插件自身不联网、不收集遥测、不持有任何模型/账号凭据；所有写操作限定在 `~/.codebuddy`（写前备份）和 `~/.dsh/buddy-control`，且默认只出计划。完整边界见 **[SECURITY.md](SECURITY.md)**。

> **非官方项目**：个人作品，与 DeepSeek、腾讯（CodeBuddy / WorkBuddy）**无隶属或背书关系**。它只是在你本机调用你已安装的那些软件，那些软件自身受各自的许可与服务条款约束。

```js
buddy_run({ worker: "codebuddy", task: "...", acceptance: "...", checks: [...] })
buddy_review({ runId, verdict: "reject", issues: [{ where: "a.ts:12", problem: "...", direction: "..." }] })
// → worker 在它自己的会话里收到返工要求，改完自动重跑检查
buddy_review({ runId, verdict: "accept" })
```

## 环境要求

| 项 | 说明 |
| --- | --- |
| DSH | 已装并可加载 profile 插件（本项目是 Host 插件，无 UI 部分） |
| 系统 | **Windows 10/11**。设备发现走注册表 + `where` + `winget`，非 Windows 会降级为「只按配置路径找」 |
| Node | ≥ 20（DSH 自带依赖即可，插件本身无第三方依赖） |
| 工人 | CodeBuddy CLI（`npm i -g @tencent-ai/codebuddy-code`）和/或 WorkBuddy 桌面版，装一个就能干活 |

## 安装（三步）

```powershell
# 1. 放到 DSH 的本地插件目录
git clone <this-repo> "$HOME\.dsh\local-plugins\dsh-buddy-control"

# 2. 建依赖链接 + 装技能 + 自检
cd "$HOME\.dsh\local-plugins\dsh-buddy-control"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 3. 装进 profile（插件管理里 install_bundle 指向这个目录），然后重启 DSH
```

装完先跑 `buddy_doctor()`，再 `buddy_deploy({apply:true, acceptInstall:true})` 收敛设备。

**第 2 步不能省**：DSH 以软链引用本地包，而 Node 按真实路径解析依赖，所以插件目录必须自己能看到 `@deepseek-ai/dsh-tools`；缺了它插件在加载期就失败，所有工具都不会出现（`buddy_doctor` 也救不了，因为那时还没有工具）。

### 一键（给新机器）

```powershell
git clone https://github.com/zzy-super/dsh-buddy-control.git "$env:TEMP\dsh-buddy-control"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\dsh-buddy-control\bootstrap.ps1" -Source "$env:TEMP\dsh-buddy-control"
```

也可以让脚本自己拉：

```powershell
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1        # 默认从 GitHub 克隆
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Check # 只看环境，不动手
```

`bootstrap.ps1` 做三件事：拉取/拷贝到 `~/.dsh/local-plugins/dsh-buddy-control` → 跑 `install.ps1`（依赖链接 + 技能 + import 自检）→ 打印在 DSH 里启用那一步。

> `irm https://raw.githubusercontent.com/... | iex` 这种写法在部分网络下会 502（本机实测如此），所以没把它当主路径；`git clone` 走的是 `github.com`，通常可用。完全离线就下载 zip 解压后用 `-Source <解压目录>`。

**插件装进 DSH 之后，业务侧就是一次调用**：

```js
buddy_deploy({ apply: true, acceptInstall: true })   // 缺软件就装、接口配好、跑一次真实调用验收
```

返回 `verified.ok:true` 才算成功——最后一步是真实的 PONG 调用 + 模型核对，不是「装完了」的自述。

## 功能实现

```
                    ┌───────────── DSH（中控台 / 本插件）─────────────┐
  派活  ─────────▶  │ buddy_run     锁模型 → 拼验收标准 → 起子进程   │
                    │ buddy_review  DSH 看产物判定 → accept / reject │
                    │ buddy_gaps    读本轮产出+stderr → 缺什么能力   │
                    │ buddy_provision / buddy_deploy  补配置、装软件 │
                    └───────────────┬────────────────────────────────┘
                                    │ spawn（stdio 管道，不共享上下文）
                                    ▼
                     CodeBuddy CLI  /  WorkBuddy CLI
                                    │
                                    ▼
                             ~/.dsh/buddy-control/runs/<runId>.json
                                （台账：每轮产出、检查、缺口、结论）
```

**7 个部件，各管一件事：**

1. **派活**（`buddy_run`）—— 把你的任务、验收标准、交付约定拼成一份自包含 prompt。worker 没有你的上下文，所以这些必须写全。
2. **模型锁定** —— 读 `codebuddy --help` 的 supported 列表，挑版本号最高的 DeepSeek id；每次尝试再从 worker 的 `providerData.requestModelId` 取**实际**请求的模型，对不上就报 `model.drift`。
3. **台账**（`runs/<runId>.json`）—— 每轮产出、检查结果、缺口、验收结论落盘。这是「打回能接上上下文」的关键。
4. **会话续接** —— `reject` 用 `--resume <sessionId>` 把修改意见送进 worker **原来那个会话**，它知道自己刚才改了什么，不用从头重做。
5. **确定性验收**（`checks`）—— `file-exists` / `file-contains` / `json-valid` / `command` 六种检查，每次评审都复跑。判定不靠 worker 自述。
6. **缺口诊断**（`buddy_gaps`）—— 扫产出和 stderr，区分「活没干好」和「工人缺能力」：登录、可执行文件、node 包、工具、MCP、权限、模型、上下文、超时。
7. **设备发现 + 部署**（`buddy_discover` / `buddy_deploy`）—— 从注册表 / PATH / 各盘符 Program Files 找真实安装位置；缺的用 winget / npm 装；配置收敛后跑一次真实调用验收。

**为什么能省 token**：worker 全程在自己的进程里烧自己的额度，DSH 只付「派活 + 读结果 + 判定」的钱；产出按 `maxOutputChars` 截断，转录从不回传。

## 八个工具

| 工具 | 干什么 |
| --- | --- |
| `buddy_doctor` | **出问题先跑这个**。查插件挂载方式、依赖、账本可写性、技能、设备、模型漂移、最近失败，每条带一句 `fix`，并给一段脱敏 `report` 可直接贴给别人 |
| `buddy_discover` | 摸清**这台设备**装了什么：node / npm / winget / CodeBuddy CLI / WorkBuddy，装在哪、什么版本、缺的怎么装。路径来自注册表、PATH、各盘符的 Program Files，不写死盘符。按主机名存一份设备画像 |
| `buddy_deploy` | **全自动部署**：装缺的软件 → 配置接口（MCP / 插件 / 信任目录 / 模型）→ 用一次真实调用验收。默认只出计划，`apply:true` 才写，`acceptInstall:true` 才装。幂等 |
| `buddy_run` | 派一次受监督的任务。把验收标准写进 prompt，模型锁到 CLI 能提供的最新 DeepSeek id，返回 `runId` 和「实际用了哪个模型」的证据 |
| `buddy_review` | 记下 DSH 的验收结论。`accept` 结案；`reject` 把 issues + 修改方向**送回同一个 worker 会话**（`--resume`），重跑检查，返回新一轮产出 |
| `buddy_gaps` | 看这次失败是「活没干好」还是「工人缺能力」：登录、可执行文件、node 包、工具、MCP、权限、模型、上下文、超时 |
| `buddy_provision` | 给工人补单项能力：注册 MCP 服务、启用 Buddy 插件、信任目录、锁定模型、装 npm CLI |
| `buddy_status` | 设备、工人真实路径、当前锁定模型、配置漂移、MCP/插件清单、其它设备画像、运行台账。零模型开销 |

`buddy_doctor` / `buddy_discover` / `buddy_status` 都不花模型钱，随便跑。

## 给别人用 / 出问题了怎么办

- 装不上、工具不出现：跑 `install.ps1`（见下方“安装说明”），再 `buddy_doctor`。
- 别的问题：**`TROUBLESHOOTING.md`** 有「症状 → 原因 → 处理」对照表，覆盖本机实际踩过的坑（依赖链接、权限模式、模型回退、HMR 不生效、winget id 改名、WorkBuddy 登录态等）。
- 要找人帮看：`buddy_doctor()` 的 `report` 已脱敏（家目录→`~`、用户名→`USER`、`sk-`→`sk-***`），连同复现参数一起贴即可。

## 换台机器也能用：识别 + 部署

目标机什么都不用改，直接：

```js
buddy_discover({ refresh: true })     // 看成什么、缺什么、装在哪
buddy_deploy({                         // 缺的装上、接口打通、跑一次验证
  apply: true,
  acceptInstall: true,
  profile: {
    model: "latest",
    mcp: [{ name: "unreal", url: "http://127.0.0.1:8000/mcp", type: "http" }],
    plugins: ["docx", "xlsx"],
    trustedDirs: ["D:/work/site"]
  }
})
```

返回每个 step 的 `status`：`present` / `planned` / `installed` / `applied` / `verified` / `failed`，最后一步是**真实调用**（PONG + 模型核对），所以 `verified.ok:true` 才算部署成功。

装什么由检测结果决定，不猜：

| 缺 | 装法 |
| --- | --- |
| node | `winget install --id OpenJS.NodeJS.LTS` |
| CodeBuddy CLI | `npm install -g @tencent-ai/codebuddy-code` |
| WorkBuddy | `winget install --id Tencent.WorkBuddy` |

两个 winget id 都在本机用 `winget show` 验证过存在。**装软件必须同时给 `apply:true` 和 `acceptInstall:true`**，少一个就只出计划。

### 路径发现怎么做的

- Windows 注册表三个 Uninstall 分支里 `DisplayName` 命中 WorkBuddy/CodeBuddy/Node.js 的项，取 `DisplayIcon`（去掉 `,0`）当安装路径 —— 这是唯一可靠的办法：本机 WorkBuddy 的 `InstallLocation` 是空的，而 `DisplayIcon` 是 `D:\Program Files\WorkBuddy\WorkBuddy.exe`。
- 找不到就退到候选目录：所有盘符的 `Program Files`、`Program Files (x86)`、`%LOCALAPPDATA%\Programs`。
- CodeBuddy CLI 探的是各 npm 全局根（`%APPDATA%\npm\node_modules`、`%LOCALAPPDATA%\npm\node_modules`、`nodejs\node_modules`）。
- 运行时 `buddy_run` / `buddy_review` / `buddy_deploy` **都用同一套发现结果**：配置里的路径错了也不影响干活（实测把两条路径改成 `C:\does-not-exist\...` 后仍能调通）。

每台机器的画像存在 `~/.dsh/buddy-control/devices/<主机名>.json`，`buddy_status.devices` 能看到所有跑过的设备。

## 一次典型的闭环

```js
// 1. 派活：验收标准和可判定检查一起给
buddy_run({
  worker: "codebuddy",
  cwd: "D:/work/site",
  task: "把首页改成响应式，断点 640/1024",
  acceptance: "三档断点下无横向滚动；构建通过；不引入新依赖",
  checks: [
    { kind: "command", line: "npm run build", cwd: "D:/work/site" },
    { kind: "file-contains", path: "src/styles/home.css", pattern: "@media \\(max-width: 640px\\)" }
  ]
})

// 2. DSH 自己看产物（不是看 worker 的自述），然后判定
buddy_review({
  runId: "b-20261030-222944-e5mu",
  verdict: "reject",
  issues: [{ severity: "blocker", where: "src/styles/home.css:120", problem: "640px 断点下 .grid 仍是 3 列，出现横向滚动", direction: "在 640px 断点把 .grid 改成 1 列" }],
  directions: "只改断点规则，不要动其它样式"
})
// → 返回 round 2 的产出，检查项复跑结果一起回来
```

被打回的 worker 会在**它自己的会话里**看到改了什么、为什么被打回，所以不会从头重做。

## 模型怎么锁

- 默认 `model: latest`：插件读 `codebuddy --help` 的 supported 列表，取版本号最高的 DeepSeek id（今天解析成 `deepseek-v4.1-flash`）。
- 每次尝试都从 worker 的 `providerData.requestModelId` 取**实际**请求的模型，回填 `model.observed` / `model.verified`。工人悄悄回落到别的模型，会显示成 `model.drift`。
- `requiredModelPattern`（默认 `deepseek-v4\.1`）决定「算不算合规」；`modelLabel`（默认 `V4.1-1017`）是给人看的代号。
- 想彻底钉死：`buddy_provision({ model: "deepseek-v4.1-flash", apply: true })`，会同时写进 `~/.codebuddy/settings.json`，配置被重置也不会漂。

## 能力补齐的边界

只动**工人自己的**配置，不碰 DSH：

- `~/.codebuddy/mcp.json` → 注册 MCP 服务
- `~/.codebuddy/settings.json` → `enabledPlugins` / `trustedDirectories` / `model`
- npm 全局包 → 必须 `apply:true` **且** `confirmInstall:true`，包名走白名单正则

登录类缺口（WorkBuddy headless 无法 `/login`）不会硬修，会明确报 `autoFixable:false` 并给人工动作。

## 落盘

`~/.dsh/buddy-control/` 下有两样东西：

- `runs/<runId>.json` — 每一轮的产出、检查结果、缺口和验收结论。打回时靠它把上下文接回去，所以不要随手删。
- `devices/<主机名>.json` — 这台设备的软件清单画像，多台机器各自的条目互相独立。

## 已知限制（别当成 bug 来报）

- **WorkBuddy headless 无法登录**：桌面端登录态在 `~/.workbuddy/keyblob`，是 Electron 加密的，CLI 解不开。插件会明确报 `auth` 缺口并给人工动作，不假装能修。当前实际干活的是 CodeBuddy。
- **「装软件」分支未在真实缺件环境里跑过**：开发机上 node / CodeBuddy / WorkBuddy 全都在，所以只走到「已存在」。winget 包 id 用 `winget show` 验证过存在，但没有为了测试去卸软件。
- **没有远程部署**：识别和部署针对「DSH 所在的那台设备」。远程机要各自在本机跑 DSH。
- **`modelLabel` 是标签不是 id**：CodeBuddy 的 supported 列表里 DeepSeek 只有 `deepseek-v4.1-flash` / `deepseek-v4-pro`（另有日期快照），并没有 `-1017` 这种串。所以插件做的是「解析最新 + 核对实际 + 漂移告警」，`modelLabel` 只用于报告里的人类可读代号。

## 开发与自检

改完 `index.js`：

```powershell
node --check index.js                                   # 语法
powershell -File .\install.ps1 -Check                   # 依赖链接 / 技能 / 能否 import
```

然后在插件管理里把 `buddy-control` **关掉再打开**——HMR 不覆盖被链接的包，这一点是实测的。最后 `buddy_doctor()` 确认干净。

依赖链接由 `install.ps1` 维护（幂等，`-Check` 只查不改）：建目录联接 → 装 `~/.dsh/skills/buddy-control` 技能 → 用真实 `import('./index.js')` 探针确认能加载。**这一步是唯一 `buddy_doctor` 诊断不到的失败**（插件加载期就挂了，那时还没有工具）。

## 配置项

写在 profile 的 `cordis.patch.yml` 里同 id 的那一行（见本包的 `cordis.patch.yml` 默认值）：
`codebuddyEntry`、`nodePath`、`workbuddyExe`、`workbuddyEntry`、`workbuddyNode`、`permissionMode`、`model`、`fallbackModel`、`modelLabel`、`requiredModelPattern`、`maxOutputChars`、`maxCaptureChars`、`defaultTimeoutSec`、`defaultMaxRounds`、`stateDir`、`nodePackageId`、`workbuddyPackageId`、`codebuddyNpmPackage`。

`codebuddyEntry` / `workbuddyEntry` 现在只是**首选值**：填错、或换台机器后路径不同，运行时会自动回落到发现结果，不用改配置。

## 许可证

**[MIT](LICENSE)** — 可商用、可修改、可再分发、可私有化，保留版权与许可声明即可；**不提供任何担保**。

- 覆盖范围：本仓库的代码与文档（含 `skills/` 里的技能描述）。
- 不覆盖：CodeBuddy、WorkBuddy、DeepSeek Harness 本身，以及它们的名称/标识。要商用这些软件，按各自的条款另办。
- 仓库内**没有**复制任何第三方代码；图标是原创 SVG，运行时只依赖 DSH 自带的 `@deepseek-ai/dsh-tools`（不打包、不分发）。
- 不想用 MIT 的话，换成 Apache-2.0（带专利授权）或 AGPL 都是一次提交的事。
