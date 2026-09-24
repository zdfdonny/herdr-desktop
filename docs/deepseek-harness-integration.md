# DeepSeek Harness（DSH）智能体接入方案调研

> 本文记录把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）
> 接入 herdr-desktop 作为一类「智能体」的调研结论与落地建议，供后续开发决策使用。
> 调研基线：DSH `@deepseek-ai/dsh@0.1.7-rc.1`（本机 npm 全局安装，bin 名 `dsh`）。

---

## 1. 结论摘要（TL;DR）

- DSH 不是一个像 Claude Code / Codex 那样的**终端 TUI** agent；它没有内置 `tui` profile。
  它的交互面是 **Web GUI**（`dsh web`）、**一次性任务**（`dsh headless`）、**ACP stdio**、
  **SDK JSON-RPC stdio** 四种。
- 因此「把 `dsh` 塞进现有 terminal pane 当交互式 TUI」这条路走不通（与其它 agent 不同）。
- 推荐分三步落地：
  1. **Phase 1（最快见效）**：把 `dsh headless "<任务>"` 作为「一次性任务 pane」接入——
     只改 preset + 检测 manifest + 环境注入，复用现有 PTY/pane 生命周期。
  2. **Phase 2（体验最好）**：主进程托管 `dsh web --no-open --port`，用 `<webview>` 把 DSH
     浏览器 GUI 内嵌成一种新 pane 类型（最贴合 DSH 的主力人机界面）。
  3. **Phase 3（长期第一等公民）**：实现 ACP v1 客户端，`dsh --profile acp` 结构化接入，
     让 DSH 会话状态变成 herdr-desktop 的第一等 GUI 数据（对齐架构文档 5.2/5.5 的哲学）。
- 最小可用改动（Phase 1）约 1–2 天；Phase 2 约一周；Phase 3 是较大的独立工程。

---

## 2. herdr-desktop 现状：智能体是如何「接入」的

herdr-desktop 是多 agent 终端管理器（Electron）。一个「智能体」在现有模型里就是
**一条可被 PTY spawn 的命令**，外加一套**终端快照检测规则**。接入一个新 agent 的完整链路：

| 环节 | 位置 | 作用 |
|------|------|------|
| 预设清单 | `src/stores/agentsStore.ts` → `AGENT_PRESETS` | 定义 `{ id, label, command }`，创建时按 PATH 可用性过滤 |
| 可用性探测 | `electron/platform/{win,unix}.ts` → `resolveExecutable` / `isCommandAvailable` | PATH×PATHEXT（Windows）或 PATH+X_OK（Unix）解析命令 |
| 两阶段 spawn | `electron/ipc/router.ts` → `spawnAgent` / `attachPane` | 先建 pane → 终端量尺寸 → 用精确尺寸启动 PTY |
| PTY 启动 | `electron/runtime/pty-manager.ts` → `spawn` | `command` 按空白拆 token，`.cmd/.bat` 用 `cmd.exe /d /c` 包装 |
| 状态检测 | `shared/detect-manifest.ts` + `electron/runtime/agent-detector.ts` | 命令名/品牌词识别 + blocked/working/done 关键词判定 |
| 环境注入 | `electron/ipc/router.ts` → `launchEnvFor` | 按命令注入代理环境变量（可复用的注入点） |

关键结论：**接入一个新 agent = 加一个 preset + 加一条识别规则 +（可选）注入环境变量**。
真正决定「接入难度」的是这个 agent 以什么形态运行（TUI / Web / 一次性 / 协议）。

---

## 3. DeepSeek Harness 是什么

- npm 包：`@deepseek-ai/dsh`，版本 `0.1.7-rc.1`，bin：`dsh`（Windows 下是 `dsh.cmd` 垫片）。
- 仓库：`deepseek-ai/deepseek-harness`，CLI 位于 `apps/cli`。
- `dsh` 是一个 **profile 启动器**：`dsh --profile <name>` 或缩写 `dsh <name>`，
  按「插件 bundle 补丁层」组合出一个运行时。
- 自带 profile 模板（`@deepseek-ai/dsh-app-boot` 的 `PROFILE_TEMPLATES`）：

  | profile | bundle 组合 | 形态 |
  |---------|-------------|------|
  | `web` | base + dsh-web-app | 浏览器 GUI（聊天 / 模型 / 设置 / 会话历史） |
  | `headless` | base + dsh-headless | 一次性任务：stdout 打印最终答案后退出 |
  | `acp` | base + dsh-acp-app | ACP v1 stdio JSON-RPC（Agent Client Protocol） |
  | `sdk` | base + dsh-sdk-app | SDK JSON-RPC stdio server |
  | `sdk-minimal` | dsh-sdk-minimal | 极简 SDK stdio |

- 数据与凭据根目录：`$DSH_HOME`（默认 `~/.dsh`，Windows 即 `%USERPROFILE%\.dsh`）。
  - profile 位于 `$DSH_HOME/profiles/<name>`；
  - 凭据文件 `$DSH_HOME/.credentials.yaml`；
  - 凭据优先级：**启动环境 `DEEPSEEK_API_KEY` > 凭据文件 > 项目 `.env` > `$DSH_HOME/.env`**。
- DSH 自带头less/Web 的代理支持（`dsh-http-proxy` 读 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`），
  与 herdr-desktop 现有的 `proxyAgents` 注入天然互补。

> 注意：`dsh` 无默认 profile，直接 `dsh` 会报错要求 `--profile`；所以 preset 命令必须写成
> `dsh headless` / `dsh web` 这种「子命令 = profile 名」的形式。

---

## 4. 四种接入面与对应方案

### 方案 A —— `dsh headless` 一次性任务 pane（低工作量，先做）

- 形态：`dsh headless "<任务>"` 在 PTY pane 里跑，推理打 stderr，最终答案打 stdout，
  任务完成退出码 0，中止/出错退出码 1；`--json` 可输出逐行 JSON 事件流，`--session-id`
  可延续同一会话。
- 接入方式：新增 preset `command: 'dsh headless'`，任务文本走 `SpawnAgentParams.args`
  （该字段已存在，`pty-manager` 已支持 args 拼接）；识别规则加 `['dsh', '\\bdsh\\b']`；
  复用 `pty:exit` 把 `exitCode===0` 映射为 `done`。
- 优点：完全复用现有 PTY/pane/检测/持久化链路，改动最小；适合「批处理 / 一次性问答」。
- 缺点：一次性，无交互后续；任务文本含空格需要走 args 而不是整条 command 字符串。

### 方案 B —— 托管 `dsh web` 浏览器 GUI（中等工作量，体验最佳）

- 形态：主进程 `child_process.spawn('dsh', ['web', '--no-open', '--port', '<空闲端口>'])`，
  捕获 stdout 里的 `dsh web: <带 token 的 URL>` 行，在 Electron 里用 `<webview>`（或 BrowserView）
  加载该 URL 完成 cookie 认证，再导航到不含 token 的干净 URL。
- 接入方式：新增一种「web agent pane」类型；新建一个 DSH 子进程生命周期模块
  （端口分配、token 握手、pane 关闭时 kill）；Renderer 增加 `<webview>` 面板。
- 优点：DSH 的主力交互界面（多会话聊天、模型/设置管理、会话历史）完整可用；
  与 herdr-desktop「一个窗口并排监控多个 agent」的定位契合。
- 缺点：工作量中等；需处理 CSP、端口冲突、认证 cookie、进程生命周期；
  每个 DSH agent 占一个本地端口。

### 方案 C —— ACP / SDK 协议结构化接入（高工作量，长期最优）

- 形态：主进程 spawn `dsh --profile acp`（或 `sdk`），stdio 走 JSON-RPC，主进程实现
  ACP v1 客户端（`session/new`、`session/prompt`、`session/list`、`session/resume`、
  `session/close`），把会话状态直接投影进 `SessionState`，渲染端做原生聊天面板。
- 优点：状态是结构化第一等数据（无需终端快照检测），支持会话恢复，最贴合
  `docs/architecture.md` 的「agent 状态成为 GUI 第一等数据，而非终端透传」哲学；
  也符合 herdr 原项目对 ACP 的支持方向。
- 缺点：需要实现/引入 ACP 客户端（DSH 已依赖 `@agentclientprotocol/sdk@1.4.0`，
  可复用该公开 SDK），新建协议 pane 类型与流式 UI，工作量最大。

### 方案 D —— 进程内嵌入 `@deepseek-ai/dsh-*` 库（不推荐）

- DSH 是 ESM + Cordis 插件加载器 + profile boot + 原生 addon 的进程模型，SDK/ACP 明确以
  **stdio 子进程**为边界设计；进程内嵌入会与 Electron 主进程的模块解析、生命周期、
  native addon 冲突。**结论：保持子进程边界，不做进程内嵌入。**

### 方案对比

| 维度 | A（headless） | B（web 内嵌） | C（ACP/SDK） | D（进程内） |
|------|---------------|---------------|--------------|-------------|
| 工作量 | 低（~1–2 天） | 中（~1 周） | 高（独立工程） | —（不建议） |
| 交互性 | 一次性 | 完整 GUI | 结构化/可脚本 | — |
| 状态检测 | 复用 exit/关键词 | 无需检测 | 结构化状态 | — |
| 贴合现有架构 | 高（纯 pane） | 中（新 pane 类型） | 高（第一等数据） | 低 |
| 风险 | 低 | 中（CSP/端口/认证） | 中（协议实现） | 高 |

---

## 5. 推荐落地路径

### Phase 1（先做，快速让 DSH 可用）

1. `src/stores/agentsStore.ts` 的 `AGENT_PRESETS` 增加：
   `{ id: 'dsh', label: 'DeepSeek Harness', command: 'dsh headless' }`
   （如需普通终端体验可另加 `dsh web`，但建议先只上 headless）。
2. `shared/detect-manifest.ts` 的 `AGENT_IDENTITY` 增加 `['dsh', '\\bdsh\\b']`。
3. `electron/ipc/router.ts` 的 `launchEnvFor`（现有代理注入点）扩展支持按命令注入
   `DEEPSEEK_API_KEY`（若用户未走 `$DSH_HOME/.credentials.yaml`）；或直接依赖 DSH 自身凭据
   存储（继承 `DSH_HOME` 环境即可）。
4. 任务输入：给「DeepSeek Harness」preset 走 args 传任务文本（`spawnAgent` 已支持 `args`），
   UI 上弹一个任务输入框；`pty:exit` 的 exitCode 映射为 `done`/`blocked`。

### Phase 2（体验升级）

1. 新建 `electron/runtime/dsh-web.ts`：端口分配（从 `3080` 起找空闲端口）、
   spawn `dsh web --no-open --port <p>`、解析 stdout 启动 URL（含 token）。
2. `shared/state.ts` / `shared/protocol.ts` 扩展一种 `web` 类型的 pane，或复用 pane 模型
   加 `kind: 'pty' | 'web'` 字段（向后兼容：旧快照默认 `pty`）。
3. `src/index.html` CSP：`<webview>` 是独立 guest，不受宿主 `default-src 'self'` 强约束，
   优先用 `<webview>`（若用 `<iframe>` 则需放宽 `frame-src http://127.0.0.1:*`）。
4. 关闭 pane / 退出应用时 kill DSH 子进程（复用 `PtyManager` 之外的统一子进程管理）。

### Phase 3（长期）

1. 引入 `@agentclientprotocol/sdk` 作为 ACP 客户端依赖。
2. 主进程 spawn `dsh --profile acp`，实现 `session/*` 客户端，映射到 `SessionState`。
3. 渲染端做原生聊天/流式面板，替代终端快照检测，状态变化走结构消息（对齐 5.2 单向数据流）。

---

## 6. 风险与注意事项

1. **无 TUI**：不要把 DSH 当交互式终端 agent 接入，`dsh` 裸跑会因缺 `--profile` 报错。
2. **Windows `.cmd` 垫片**：`dsh` 解析为 `dsh.cmd`，herdr-desktop 的 `isWindowsBatchFile` +
   `cmd.exe /d /c` 已能正确处理；无需额外改动，但要保证 `resolveExecutable('dsh')` 命中。
3. **CSP**：`src/index.html` 的 `default-src 'self'` 会拦 `<iframe>` 跨源；用 `<webview>`
   或显式放宽 CSP 才能内嵌 `dsh web`。
4. **端口冲突**：`dsh web` 默认 3080，且本机可能已有 DSH GUI 占用；需动态分配空闲端口，
   并作为 pane 元数据持久化/恢复。
5. **认证 token**：`dsh web` 启动 URL 带一次性进程 token，换取签名 cookie；内嵌时必须先加载
   该 URL 完成握手，否则 API/WS 会被拒。
6. **凭据**：优先让 DSH 走 `$DSH_HOME/.credentials.yaml`（免改 herdr-desktop）；若需按项目
   注入 `DEEPSEEK_API_KEY`，复用 `launchEnvFor` 的注入模式，避免密钥进入日志。
7. **版本**：`0.1.7-rc.1` 是 rc 预发布，`PROFILE_TEMPLATES`/CLI 参数可能随版本变化，
   接入时建议锁定版本并做一次 `dsh <profile> --help` 快照校验。
8. **DSH_HOME 环境**：macOS/Linux 从 GUI 启动时继承不到用户 shell 环境，`unix.ts` 已用
   `shell -l -i -c env` 捞登录环境；确认 `DSH_HOME`/`PATH`（含 `dsh` 与 `node`）被一并捞回，
   否则可能误判「未安装」或找不到凭据。

---

## 7. 参考文件清单

- herdr-desktop
  - `src/stores/agentsStore.ts`（`AGENT_PRESETS`）
  - `shared/detect-manifest.ts`（`AGENT_IDENTITY` / `detectStatus`）
  - `electron/ipc/router.ts`（`spawnAgent` / `launchEnvFor`）
  - `electron/runtime/pty-manager.ts`（`spawn` 命令拆分）
  - `electron/platform/win.ts`（`resolveExecutable` / `.cmd` 包装）
  - `shared/state.ts`（`SpawnAgentParams.args`）
  - `src/index.html`（CSP）
- DSH（本机安装 `C:\Users\drpanda\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）
  - `lib/bin.js`（启动器与 profile 解析）
  - `node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（`PROFILE_TEMPLATES`）
  - `node_modules/@deepseek-ai/dsh-headless/README.zh.md`
  - `node_modules/@deepseek-ai/dsh-web-app/README.zh.md`
  - `node_modules/@deepseek-ai/dsh-acp-app/README.zh.md`
  - `node_modules/@deepseek-ai/dsh-sdk-app/README.zh.md`
  - `node_modules/@deepseek-ai/dsh-credentials-local/README.zh.md`
