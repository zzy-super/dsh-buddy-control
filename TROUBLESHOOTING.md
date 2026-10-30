# 排障手册

出问题先跑 **`buddy_doctor`**：它把设备、插件挂载方式、依赖、账本、模型、最近失败都查一遍，每条问题带一句 `fix`，最后给一段**已脱敏**的 `report`（家目录变 `~`、用户名变 `USER`、`sk-` 打码），可以直接贴给别人看。

```js
buddy_doctor()          // 诊断
buddy_doctor({report:false})   // 只看结构化结论，不要文本
```

## 唯一诊断不到的情况：工具根本不出现

如果 DSH 里**一个 `buddy_*` 工具都没有**，或日志里出现：

```
failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools'
```

这是插件加载期就挂了，任何工具都来不及运行。根因：插件目录是被 profile 软链引用的本地 checkout，**Node 按真实路径解析依赖**，所以它必须自己能看到 `@deepseek-ai/dsh-tools`。

修：

```powershell
cd ~\.dsh\local-plugins\dsh-buddy-control
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会建一个目录联接 `node_modules\@deepseek-ai\dsh-tools → ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools`，装好技能，最后用真实的 `import('./index.js')` 探针确认能加载。`-Check` 只检查不改动。

然后到插件管理里把 `buddy-control` **关掉再打开**（改完代码也走这一步；HMR 不覆盖被链接的包——这点是实测的）。

## 症状 → 原因 → 处理

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `buddy_deploy` 里安装步骤一直是 `planned` | 只给了 `apply`，没给 `acceptInstall` | 两个都给：`{apply:true, acceptInstall:true}` |
| `buddy_run` 返回 `needsLogin` / `gaps:[{kind:"auth"}]` | CodeBuddy 没登录，或 WorkBuddy headless 无法登录 | CodeBuddy：终端跑一次 `codebuddy` 用 `/login`。WorkBuddy：它自带的 CLI 只能交互登录，headless 拿不到桌面端加密的登录态——这是产品限制，不是插件问题 |
| 报「CodeBuddy CLI not found」但它明明装着 | 配置路径写错，或装在非常规位置 | `buddy_discover` 看 `components.codebuddy-cli.path`；运行时会自动回落到发现结果，配置里的路径只是首选值 |
| WorkBuddy 检测不到 | 注册表 `DisplayIcon` 也找不到 | `buddy_discover({refresh:true})` 看 `registry`；实在不行在配置里显式给 `workbuddyExe` |
| `model.policy: "fallback"` | CLI `--help` 里没有 `Currently supported: (...)`，模型列表读不到 | 手动试 `node <entry> --help`；或直接传 `model: "deepseek-v4.1-flash"` 固定 |
| `model.drift` | worker 自己 `settings.json` 里的 `model` 和插件锁的不一致 | `buddy_provision({model:"<锁定值>", apply:true})` |
| 每轮 `checks` 都不过 | 打回意见不够具体，worker 不知道改哪 | reject 时每条 issue 都给 `where`（文件:行）+`direction`（怎么改）；空 reject 会被工具直接拒绝 |
| 返回 `status:"exhausted"` | 修满轮次还没达标 | 任务太大：拆小重派；或 `buddy_review({maxRounds:6})` |
| worker 说某个 MCP 工具没有 | MCP 服务没起 / 没写进 worker 的 `mcp.json` | `buddy_provision({mcp:{name,url}, apply:true})`，先确认端口通 |
| 尝试里有 `permission_denials` | 权限模式太紧 | 下次 run 传 `permissionMode:"bypassPermissions"`，或 `buddy_provision({runId, apply:true})` 信任工作目录 |
| `winget install` 失败（`No package found`） | 包 id 变了 | 配置里改 `workbuddyPackageId` / `nodePackageId`；用 `winget search <名字>` 查新 id |
| 改完 `index.js` 没生效 | HMR 不覆盖链接包 | 插件管理里关掉再打开；语法错会显示为激活失败，先 `node --check index.js` |
| 账本越来越大 | 每轮产出都落盘 | `~/.dsh/buddy-control/runs` 可以删旧的；`devices` 建议留着，它是跨设备对照 |

## 找谁帮忙

1. `buddy_doctor()` → 复制 `report`。
2. 加上复现的三样：调了哪个工具、参数是什么（去掉敏感内容）、返回里 `failed`/`gaps` 的原文。
3. 贴回去。有 `report` 的话，路径、版本、挂载方式、模型解析都不用再问一遍。

## 不用猜的几条事实

- Windows 上 WorkBuddy 的注册表 `InstallLocation` 常为空，真正可靠的是 `DisplayIcon`（去掉尾部 `,0`）。
- 本机实测注册表里 `DisplayIcon = D:\Program Files\WorkBuddy\WorkBuddy.exe`，所以装到 D 盘也能被发现。
- `Tencent.WorkBuddy`、`OpenJS.NodeJS.LTS` 两个 winget id 在本机用 `winget show` 验证过存在。
- WorkBuddy headless 登录态在 `~/.workbuddy/keyblob`，是 Electron 加密的，CLI 解不开。
