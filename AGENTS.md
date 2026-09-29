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
npm run typecheck   # tsc --noEmit -p tsconfig.json
npm run test:sort   # 排序相关测试（其余 test:* 同理）
```

## 目录结构

- `electron/` —— 主进程：`main.ts`、`preload.ts`、`ipc/`、`runtime/`、`platform/`
- `src/` —— 渲染进程（React）：`components/`、`stores/`、`styles/`、`i18n/`、`xterm/`
- `shared/` —— 主/渲染进程共享的类型与协议（`protocol.ts`、`state.ts`）
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
- 命名：文件/目录用 kebab-case（如 `agent-detector.ts`），React 组件用 PascalCase（如 `AgentPicker.tsx`），变量/函数用 camelCase。
- 平台相关逻辑集中在 `electron/platform/`，不在主流程散落 `process.platform` 判断。

### 主进程 / 渲染进程边界

- 两侧共享的类型与 IPC 协议定义在 `shared/`，通过 `@shared/*` 引用。
- 主进程能力经 `electron/ipc/` 暴露，渲染层经 `src/ipc/client.ts` 调用；渲染层不直接引用 Node 能力。
- 运行时状态（session、pty、settings 等）属于主进程 `electron/runtime/`，UI 状态属于渲染层 `src/stores/`。

### 智能体集成

- 参考 herdr `src/integration/`：每个智能体的脚本单独存放在 `electron/runtime/integration/assets/<agent>/`，由 `assets.ts` 通过 Vite `?raw` 在构建期内联（对应 herdr 的 `include_str!`），`index.ts` 负责安装/卸载。新增或修改智能体集成时先看这里。

### 测试

- 改动核心逻辑时运行相关 `npm run test:*` 脚本，必要时补充/更新测试。
- 纯逻辑优先抽离到可独立测试的模块。

### 提交

- 提交信息采用 `type(scope): 中文描述` 格式，例如：`fix(ui): 分屏分隔条拖动改用 pointer capture，修复 webview 相邻时拖动失效`。
- `type` 用小写（`feat`、`fix`、`refactor`、`docs`、`chore`、`test` 等）；`scope` 用小写标识模块（如 `ui`、`integration`、`agent`、`terminal`）。
- 不加 AI 协作者行；提交前先给出提交信息并征得确认。
