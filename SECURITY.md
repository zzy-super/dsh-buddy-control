# 安全性

这个插件会启动子进程、写配置文件、装软件，所以安全边界必须写清楚，而不是一句「放心用」。

## 一句话结论

**它不联网、不收集遥测、不持有任何模型或账号凭据；所有写操作都限定在两个目录内，且默认只出计划、要显式开关才真的执行。** 真正的风险来自你让它启动的 CodeBuddy / WorkBuddy —— 它们以你的权限运行，能改文件，能力边界由 `permissionMode` 决定。

## 它能碰什么 / 不能碰什么

| 类别 | 具体 |
| --- | --- |
| **写** | ① `~/.codebuddy/settings.json`（`enabledPlugins` / `trustedDirectories` / `model`）② `~/.codebuddy/mcp.json`（`mcpServers`）③ `~/.dsh/buddy-control/**`（运行台账、设备画像）④ 运行 `install.ps1` 时：`~/.dsh/skills/buddy-control/SKILL.md` 和插件目录内的 `node_modules/@deepseek-ai/dsh-tools` 目录联接 |
| **不写** | 你的代码仓库、DSH 的 profile 配置、`~/.workbuddy`、系统 PATH、注册表 |
| **读** | 注册表三个 Uninstall 分支（只读名称/版本/安装路径）、`~/.codebuddy` 的两个配置文件、设备画像与台账 |
| **启动** | `codebuddy`（node）、`workbuddy`（node 或 WorkBuddy.exe）、`powershell`（读注册表）、`where`、`npm --version`；超时时用 `taskkill` 中止整棵进程树 |
| **网络** | **插件自身零请求**。唯一的出站发生在你显式批准的 `winget install` / `npm install -g` 里；worker CLI 自己连模型服务，那是它的行为 |

## 三道开关

| 操作 | 需要的参数 | 缺省行为 |
| --- | --- | --- |
| 改 worker 配置 | `apply:true` | 只返回 `planned`，一个字节都不写 |
| 装软件（winget） | `apply:true` **且** `acceptInstall:true` | 只出命令，不执行 |
| 装 npm 全局包 | `apply:true` **且** `confirmInstall:true`，包名还要过白名单正则 | 同上 |

写配置前会把原文件复制成 `settings.json.bak-<时间戳>`，误改可以直接回滚。

## 权限模式：真正该小心的地方

`permissionMode` 决定 worker 能不能不经询问就改文件、跑命令：

| 模式 | 含义 |
| --- | --- |
| `acceptEdits`（默认） | 能写文件，危险命令仍会拦 |
| `bypassPermissions` | **跳过确认**。只在隔离目录 / 你完全信任的仓库里用 |
| `plan` | 只读，出方案不动手 |

`buddy_run` 的 `cwd` 是 worker 的活动边界，别把它指向家目录或系统目录。

## 台账里可能有敏感内容

`~/.dsh/buddy-control/runs/*.json` 会原样保存**任务文本和 worker 的产出**。如果你在任务里贴过密钥、内部地址、客户数据，它们就在里面。

- 分享前先删：`Remove-Item ~/.dsh/buddy-control/runs -Recurse`（只影响历史，不影响功能）。
- `devices/*.json` 只存软件清单，没有任务内容。

## 报告脱敏（`buddy_doctor`）

`report` 字段在生成时就替换了：家目录 → `~`、用户名 → `USER`、`sk-` 开头 → `sk-***`、`Bearer …` → `Bearer ***`。

**局限**：这是字符串替换，不是 DLP。任务正文和文件内容不在报告里，但路径里若含非用户名的敏感信息（例如项目代号）不会被处理。不确定就用 `{report:false}` 只拿结构化结论。

## 提示注入面

worker 的产出是**不可信数据**，不是指令：

- DSH 只把它当文本读，验收由 DSH 自己看产物 + 确定性 `checks` 决定。
- 插件不会执行 worker 产出里的任何命令。
- 打回意见由 DSH 写，worker 无法通过产出改变验收标准。

## 供应链

- **零第三方依赖**：只用 DSH 自带的 `@deepseek-ai/dsh-tools`，没有 `dependencies`，没有 `postinstall` 脚本。
- 全部逻辑在单个 `index.js` 里，可从头读到尾；`install.ps1` 也只做目录联接和文件拷贝。
- 仓库里没有任何凭据、token、私有地址。默认配置里的安装路径是空的，靠运行时发现。
- 发布包可自检：`node --check index.js` + `install.ps1 -Check`。

## 出事了怎么办

1. 停止：插件管理里禁用 `buddy-control`（不会影响已装软件）。
2. 回滚配置：把 `~/.codebuddy/settings.json.bak-*` 覆盖回去。
3. 清台账：删 `~/.dsh/buddy-control`。
4. 撤销凭据：如果你给过 PAT，去 GitHub → Settings → Developer settings → Tokens 删除。
5. 卸载软件：`winget uninstall Tencent.WorkBuddy`、`npm uninstall -g @tencent-ai/codebuddy-code`。

## 已知未覆盖项

- **Windows 专属**：设备发现依赖注册表与 `winget`，其他系统只按配置路径查找。
- **没有远程部署**，因此也没有跨机的凭据传递问题。
- **WorkBuddy 登录态**：插件不读、不写、不解密 `~/.workbuddy/keyblob`；它只会报「需要人工 `/login`」。
