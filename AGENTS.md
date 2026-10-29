# herdr-desktop

多智能体管理桌面应用 —— 让编程智能体运行其上的运行时（Electron + React + TypeScript）。

## 技术栈

- Electron 44 / React 19 / TypeScript 5.7
- electron-vite（Vite 6）构建，electron-builder 打包
- @xterm/xterm + node-pty 终端，zustand 状态管理

## 常用命令

使用 npm，不要使用 pnpm：

```bash
npm run dev         # 开发模式
npm run build       # 构建主进程 / 预加载 / 渲染产物
npm run test:all    # **提交前跑这一个**：typecheck + 3 个守卫 + 21 个测试（约 20s，1142 断言）
npm run typecheck   # 只跑类型检查
npm run test:sort   # 单个测试（其余 test:* 同理）
npm run check:agent-boundaries   # 智能体边界 lint（禁止业务代码里判断 agent id）
npm run check:encoding           # 编码守卫：禁止 UTF-8 BOM（CI 必跑）
```

`test:all` 是唯一的提交前入口：它按「类型 → 静态守卫 → 主进程核心 → 渲染层」的顺序跑全部脚本，
任何一个失败则退出码非 0，并在末尾打印汇总表。新增测试脚本时记得把它加进
`scripts/test-all.mjs` 的 `STEPS`（否则 CI 不会跑到）。

## 目录结构

- `electron/` —— 主进程：`main.ts`、`preload.ts`、`ipc/`、`runtime/`、`agents/`、`platform/`、`support/`
- `electron/ipc/` —— IPC 层：`router.ts`（**门面**，只做编排与转调）、`channels.ts`（通道常量）、`handlers/`（通道注册）、`notification-scheduler.ts`、`services/`（协作对象，见下）
- `electron/ipc/services/` —— 从 `IpcRouter` 抽出的协作对象：`pane-lifecycle-service`（两阶段创建/重启/恢复/关闭）、`agent-state-service`（状态上报与仲裁）、`web-agent-service`（web 托管）、`renderer-bridge`（渲染端输出）、`state-arbiter`（完成判定规则）、`dsh-session-binding`（会话→pane 路由）、`reviving-panes`、`env-probe`、`pane-errors`
- `src/` —— 渲染进程（React）：`components/`、`stores/`、`styles/`、`i18n/`、`xterm/`
- `shared/` —— 主/渲染进程共享的类型与协议（`protocol.ts`、`state.ts`、`detect/`、`agents/`）
- `shared/agents/` —— **智能体定义**（见下）：`agent-id.ts`、`descriptor.ts`、`registry.ts`、`status.ts`、`spec/`（`policy` / `integration-spec` / `detection-spec` / `resume-spec` 等契约）、`descriptors/<agent>.ts`
- `electron/agents/` —— **智能体主进程实现**：`registry.ts`、`installer.ts`（契约）、`installers/index.ts`（id → 工厂表）、`installers/`（各智能体安装器）、`assets/<agent>/`（集成资产）
- `scripts/` —— 构建与测试脚本
- `build/` —— 构建资源（图标等）
- `docs/` —— 文档

## 路径别名

- `@shared/*` → `shared/*`
- `@electron/*` → `electron/*`
- `@renderer/*` → `src/*`

## 开发规范

### TypeScript

- tsconfig 开启严格模式（`strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`），提交前必须通过 `npm run typecheck`。
- 类型导入用 `import type`，避免运行时引入。
- 刻意未使用的参数用 `_` 前缀命名（如 `_reportUrl`、`_event`）。
- 尽量避免 `any`；处理未知 JSON 结构时可局部使用 `Record<string, any>` 并注释说明。

### 代码风格

- 注释用中文；块注释 `/** */`，行注释 `//`。
- **文件编码必须是 UTF-8 无 BOM**。BOM 会让 Vite 的 `JSON.parse` 失败（`package.json` 带 BOM 时整个 CSS 链路挂掉），而 `typecheck` 与全部 `test:*` 仍全绿 —— 只有 `npm run dev` 才暴露。`npm run check:encoding` 守卫（CI 必跑），修复用 `node scripts/check-encoding.mjs --fix`。
- 批量改写文件不要用 PowerShell 的 `Set-Content -Encoding utf8` / `-replace`：前者可能写入 BOM，后者的反引号是转义前缀（`` `a `` → BEL）且跨行正则极易删多。改用 Node 脚本 + `fs.writeFileSync(path, text, 'utf8')`，或直接用编辑工具。
- 命名：文件/目录用 kebab-case（如 `agent-detector.ts`），React 组件用 PascalCase（如 `AgentPicker.tsx`），变量/函数用 camelCase。
- 平台相关逻辑集中在 `electron/platform/`，不在主流程散落 `process.platform` 判断。

### 命名空间：本项目一律用 `herdr-desktop`，禁用裸 `herdr`

本项目是 **herdr-desktop**，上游是 **herdr**（Rust 终端多 agent 运行时）。两者会在同一台机器上共存
（用户的 `~/.herdr`、上游自己的 hook 脚本与环境变量），因此**本项目对外可见的任何标识符都必须带
`desktop` 后缀**，否则会和上游撞名、互相覆盖或互相误判。

必须用 `herdr-desktop` 前缀的：

| 类别 | 正确 | 禁止 |
|---|---|---|
| 环境变量 | `HERDR_DESKTOP_PANE_ID`、`HERDR_DESKTOP_REPORT_URL`、`HERDR_DESKTOP_AGENT` | `HERDR_PANE_ID`、`HERDR_REPORT_URL` |
| 集成标记 | `HERDR_DESKTOP_INTEGRATION_ID=herdr-desktop`、`HERDR_DESKTOP_INTEGRATION_VERSION` | `HERDR_INTEGRATION_ID`、`HERDR_INTEGRATION_VERSION` |
| 上报来源协议串 | `herdr-desktop:<agent>`（如 `herdr-desktop:claude`） | `herdr:<agent>` |
| IPC 通道 | `herdr-desktop:app-info`、`herdr-desktop:hook-install` | `herdr:app-info` |
| 扩展内部事件 | `herdr-desktop:blocked` | `herdr:blocked` |
| 配置块 / 独占文件 | `herdr-desktop.json`、`herdr-desktop` 块键 | `herdr.json`、`herdr` 块键 |
| 资产文件名 | `herdr-desktop-agent-state.sh` | `herdr-agent-state.sh` |

保留裸 `herdr` 的三种例外，不要"顺手统一下去"：

1. **溯源注释**：`// 对应 herdr src/detect/manifests/claude.toml`、`// 参考 herdr 的 hook 上报通道` —— 这些是移植依据，改成 `herdr-desktop` 会失去可追溯性。
2. **上游专有概念**：文档里描述上游行为时提到的 `HERDR_PANE_ID`、`~/.herdr`。
3. **产品名与包名**：`productName: "Herdr"`、`package.json` 的 `name`/`repository`、`window.herdrDesktop` 桥接名（已含 Desktop，且 JS 标识符不能带连字符）。

### 主进程 / 渲染进程边界

- 两侧共享的类型与 IPC 协议定义在 `shared/`，通过 `@shared/*` 引用。
- 主进程能力经 `electron/ipc/` 暴露，渲染层经 `src/ipc/client.ts` 调用；渲染层不直接引用 Node 能力。
- 运行时状态（session、pty、settings 等）属于主进程 `electron/runtime/`，UI 状态属于渲染层 `src/stores/`。

### 智能体集成

- **一个智能体的知识只写在一个地方**：`shared/agents/descriptors/<agent>.ts`。里面声明它的身份（id/别名/展示名/启动命令）、屏幕检测（`detection`）、集成（`integration`：形态/版本/配置目录/产物路径/额外校验）、会话恢复（`resume`：恢复参数/会话替换白名单/启动参数反解）、状态仲裁（`policy`）。
- 新增智能体 = 新建一个 descriptor（含 `detectionPriority`）+ 在 `shared/agents/descriptors/index.ts` 的 `DESCRIPTORS` 里登记一行。**登记顺序不再有语义** —— 识别优先级由 `detectionPriority` 显式声明（数字小的先匹配，步长 10 便于插入），`registry` 负责排序。这样新增智能体不会因为「插到数组哪个位置」而改变其他智能体的识别结果。`test:agent-policy` 守卫优先级唯一性与升序。
- **不要在业务代码里判断 agent id**。需要「某个智能体才这样」时，加一个 `StatePolicy` / `SessionRebinding` 字段，而不是写 `if (agent === 'xxx')`。`npm run check:agent-boundaries` 会拦住这类分支（CI 必跑）。
- 屏幕规则仍是**声明式数据**（`shared/detect/manifests/<agent>.ts`）：规则要能被表格驱动测试逐条断言，不要写成方法。
- 集成资产的物理位置是 `electron/agents/assets/<agent>/`，由**各智能体自己的安装器文件**通过 Vite `?raw` 导入（对应 herdr 的 `include_str!`）。不再有集中的 `assets.ts` —— 资产随智能体走，不集中查表。
- 新增一个带官方集成的智能体：① 在它自己的文件里写 `createXxxTarget()`；② 在 `electron/agents/installer-factories.ts` 的 `INSTALLER_FACTORIES` 加一行。汇总层 `electron/integration.ts` 不需要改。
- 版本按每个智能体独立管理：修改某个智能体的脚本/插件后，必须同时更新 ① 该 agent 所有资产文件里的 `HERDR_DESKTOP_INTEGRATION_VERSION` 标记（一个 agent 有多个文件时保持一致）；② `descriptors/` 里该 agent 的 `integration.version`。`npm run test:integration-version` 校验两者一致，不一致即 CI 失败。
- 集成状态判定是**通用三步**（产物存在 → 版本比较 → `validate()`），智能体私有的「装好了但已失效」判据挂在实现自己的 `validate` 上，不要写回 `hookStatuses()`。

### 测试

- **提交前跑 `npm run test:all`**（typecheck + 全部守卫 + 全部测试，约 20s）。只跑单个测试不足以说明没有回归。
- 改动核心逻辑时补充/更新对应测试；纯逻辑优先抽离到可独立测试的模块。
- 新增测试脚本 = 写 `scripts/test-<name>.mjs` + 在 `package.json` 加 `test:<name>` + **加进 `scripts/test-all.mjs` 的 `STEPS`**（漏了这一步 CI 不会跑到）。
- 不要删测试来「让 CI 变绿」。这些断言是重构唯一的客观等价性证据；过时的断言应改写而不是删除。

### 提交

- 提交信息采用 `type(scope): 中文描述` 格式，例如：`fix(ui): 分屏分隔条拖动改用 pointer capture，修复 webview 相邻时拖动失效`。
- `type` 用小写（`feat`、`fix`、`refactor`、`docs`、`chore`、`test` 等）；`scope` 用小写标识模块（如 `ui`、`integration`、`agent`、`terminal`）。
- 不加 AI 协作者行；提交前先给出提交信息并征得确认。
