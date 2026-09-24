# herdr-desktop 架构设计文档

> 参考 [herdr](https://github.com/herdrdev/herdr)（Rust 终端多 agent 运行时）实现的一款
> **多 agent 管理桌面端应用**。本文档记录架构选型与设计决策，是后续开发的唯一权威来源。

---

## 1. 目标与定位

herdr 是"terminal workspace manager for AI coding agents"——它在后台 PTY 中托管 Claude
Code / Codex / Cursor / opencode 等 CLI agent，提供会话持久化、多 pane 分屏、agent 状态
检测、多机（SSH）联邦。

herdr-desktop 的定位与之对齐，但把 herdr 的 **终端字符 UI 升级为原生 GUI**：

- **后台常驻运行时**：自己管理每个 agent 的 PTY 生命周期，关闭窗口不中断 agent。
- **真正的 GUI 面板**：agent 列表、状态徽标（working / blocked / idle / done）、
  workspace/tab 树、分屏布局都是原生组件；只有"单个 agent 的终端画面"用嵌入式终端渲染。
- **多 agent 管理**：一个窗口内并排监控、切换、操作多个 AI coding agent。

### 1.1 为什么不做「把 herdr 塞进终端」

herdr 本身是**纯终端 TUI 程序**，官方不带桌面端。要给 herdr 配图形界面，最直接的做法是
做一个 **纯终端透传壳**：Electron 主进程用 `node-pty` 把 `herdr.exe` 当子进程跑起来，
把整个 TUI 当作普通终端透传给一个 `xterm.js`。这样窗口里显示的仍然是 herdr 的字符画界面，
也没有使用 herdr 的 socket 协议 / 稳定端点协议 / JSON API。

herdr-desktop **不走这条捷径**：它不依赖 herdr 二进制，而是自己实现 Agent 运行时后端，
把 agent 状态、布局、会话管理变成第一等的 GUI 数据，而不是终端里的字符画。

---

## 2. 架构选型总览

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 架构模式 | 自己实现 Agent 运行时后端 | 让 agent 状态/布局成为 GUI 第一等数据 |
| UI 框架 | Electron | 生态成熟，node-pty/xterm 集成最好 |
| 前端 | React + TypeScript + Vite | 类型安全贯穿三端，高频事件流生态好 |
| 状态管理 | Zustand | 轻量，适合终端事件流与增量 patch |
| 终端 | @xterm/xterm + node-pty | Windows ConPTY 支持成熟，与 herdr 一致 |
| 构建 | electron-vite | 主/预加载/渲染三端统一构建 |
| 打包 | electron-builder | 三平台目标统一配置，跨平台成熟 |
| 平台范围 | **Windows / macOS / Linux** | 平台差异收敛到 `electron/platform/`，核心零平台判断 |

---

## 3. 高层架构

继承 herdr 的核心架构 DNA：**Server/Client 分离** + **稳定的 socket 协议** +
**State 与 Runtime 分离** + **纯渲染**。在 Electron 中，这些原则映射为
**Main 进程（Runtime）与 Renderer 进程（GUI）的分离**。

```
┌──────────────────────────────────────────────────────────────────┐
│                    herdr-desktop (Electron)                       │
│                                                                   │
│  ┌────────────────────────┐            ┌────────────────────────┐ │
│  │   Renderer 进程 (GUI)   │            │  Main 进程 (Runtime)    │ │
│  │   React + xterm.js      │            │  Agent 运行时后端       │ │
│  │                         │    IPC     │                         │ │
│  │  - agent 列表/状态面板    │ ◄────────► │  - PTY 生命周期管理      │ │
│  │  - workspace/tab 树     │  版本化协议  │  - agent 状态检测引擎    │ │
│  │  - 分屏/布局原生组件     │            │  - 会话/layout 持久化    │ │
│  │  - 每 pane 嵌入 xterm.js │            │  - 多机(SSH)联邦(预留)   │ │
│  │  - 原生按钮/菜单/弹窗    │            │  - 平台抽象(win/unix)    │ │
│  └────────────────────────┘            └────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1 关键区别（对比 herdr）

| 维度 | herdr | herdr-desktop |
|------|-------|---------------|
| 运行时 | Rust 常驻 server（headless） | Electron **Main 进程**（Node.js） |
| 客户端 | crossterm + ratatui TUI | React GUI |
| 渲染载体 | 终端字符 cell | DOM 组件 + 嵌入式 xterm.js |
| 协议 | 本地 socket（bincode + JSON） | Electron IPC（版本化 JSON） |
| PTY | portable-pty（Rust） | node-pty（Node + ConPTY） |
| 终端仿真 | vendored libghostty-vt | @xterm/xterm（透传为主） |

---

## 4. 分层设计（对应 herdr 模块映射）

| herdr 模块 | 桌面端对应实现 | 技术选型 |
|-----------|--------------|---------|
| `src/pty/` PTY 管理 | Main 进程 `pty-manager` | `node-pty`（Windows ConPTY） |
| `src/terminal/` + `libghostty-vt` | 终端仿真 / scrollback | `@xterm/xterm`（前端） |
| `src/detect/` agent 检测 | `agent-detector` 状态检测引擎 | Main 进程模块：读终端快照 + manifest 正则 |
| `src/api/` socket API | Main 进程 IPC 协议 | Electron IPC + 版本化 JSON schema |
| `src/persist/` 持久化 | 会话/layout 持久化 | 磁盘 JSON（自写 + 原子写） |
| `src/protocol/` 冻结契约 | IPC 消息 schema 版本化 | TypeScript 类型 + JSON Schema 冻结 |
| `src/platform/` 平台隔离 | 平台专属（ConPTY、login env、shell） | `platform/` 分发 win / darwin / linux，核心零平台判断 |
| `src/client/shell/` TUI | React 组件树 | React + Zustand + xterm.js |
| `src/app/state.rs` AppState | 纯状态模型（可序列化） | `shared/` TypeScript 类型 |

---

## 5. 核心架构决策

### 5.1 Runtime 放在 Main 进程（Node.js 侧，不用 Rust）

- 用户已选定 Electron + 仅 Windows，PTY 管理、agent 检测、持久化用 Node.js 即可覆盖，
  避免引入 Rust 交叉编译复杂度。
- PTY 用 `node-pty`，其 `useConpty` 走 Windows ConPTY，与 herdr 的 Windows 支持路径一致。
- **State 与 Runtime 分离**（继承 herdr 原则）：
  - `AgentState` / `SessionState`：纯数据，可 JSON 序列化，可无 PTY 单元测试。
  - `PtyRuntime`：持有 PTY 句柄、数据流，不参与序列化。
  - Renderer 只拿到**状态快照 + 增量 patch**，永远不持有 PTY 句柄。

### 5.2 单向数据流

```
用户操作 ──► Renderer store ──IPC──► Main runtime ──► 状态变更
                                                     │
              Renderer store ◄──IPC(patch)── 纯状态快照/增量 patch ◄─┘
```

- Renderer 的状态是 Main 端状态的**投影**，不存在 Renderer 本地权威状态。
- 高频终端输出走**独立的数据通道**（`pty:data`），低频结构变化走**状态 patch 通道**，
  避免终端字节流淹没结构状态同步。

### 5.3 渲染：GUI 组件 + 嵌入式终端混合

- 布局、agent 列表、状态徽标、tab 栏、菜单、弹窗 → **React 原生组件**。
- 每个 agent pane 的实时终端画面 → **独立 `xterm.js` 实例**。
- **惰性渲染**（继承 herdr "hidden panes still parse, no presentation work" 思想）：
  - 非聚焦 / 非可见 pane 不主动渲染终端帧，只保留终端 buffer 用于 agent 检测；
  - 聚焦 pane 才 attach xterm.js 实时流。

### 5.4 IPC 协议：版本化 + 冻结契约

继承 herdr `src/protocol/` 的设计哲学：

- 所有 IPC 消息走统一 envelope：`{ type, version, payload }`。
- 结构消息类型集中在 `shared/protocol.ts`，作为**冻结契约**，新增字段须向后兼容
  （可选字段 + 默认值），破坏性变更须新增 `type` 或 bump `version`。
- 预留 `EndpointControl` 式的**命名可扩展控制消息**，保证主进程与渲染进程各自升级
  不破坏契约。
- 终端数据流（`pty:data`）与结构协议分离，不进入冻结契约的严格版本约束。

### 5.5 Agent 状态检测引擎

继承 herdr `src/detect/` 的思想，但作为独立模块：

- **声明式 manifest**：每个 agent（claude、codex、cursor、opencode、gemini…）用一份
  manifest 描述如何从终端快照判定状态。
- **状态机**：`idle → working → blocked / done`，带 `state_change_seq` 单调序号，
  用于排序与通知去重。
- **证据驱动**：读取终端 bottom-buffer 快照（而非用户可滚动的 viewport），用
  AND/OR/NOT 规则匹配。

### 5.6 平台抽象

- 平台相关代码全部收敛到 `electron/platform/`，按 `process.platform` 分发，
  核心模块（`pty-manager` / `router` / renderer）**零平台判断**
  （对应 herdr 的 `src/platform/<os>.rs` 隔离原则）。
- 三个实现平级，共用 `Platform` 接口（`types.ts`）：

  | 文件 | 覆盖 | 关键差异 |
  |------|------|----------|
  | `win.ts` | Windows | PATH×PATHEXT 解析、`.cmd`/`.bat` 包装、ConPTY、继承环境 |
  | `unix.ts` | POSIX 公共逻辑 | PATH 顺序查找 + 可执行位（X_OK）、登录 shell 捞环境 |
  | `darwin.ts` / `linux.ts` | macOS / Linux | 复用 `unix.ts`，仅默认 shell 优先级不同 |

- 平台差异清单（对外行为一致，实现不同）：
  1. **命令解析**：Windows 需按 PATHEXT 补齐扩展名；Unix 只按 PATH 找同名文件且要求可执行位。
  2. **启动包装**：Windows 上 `.cmd`/`.bat` 必须 `cmd.exe /d /c` 包装；Unix 无此概念。
  3. **启动环境**：Windows 直接继承；macOS/Linux 从 Finder/`.desktop` 启动时
     拿不到用户 shell 的 PATH，需跑 `shell -l -i -c env` 捞回（否则误判「未安装」）。
  4. **终端后端**：Windows 走 ConPTY（`useConpty: true`）；Unix 走 forkpty。
  5. **快捷键**：macOS 用 ⌘C/⌘V/⌘F；Windows/Linux 用 Ctrl+Shift+C/V、Ctrl+F
     （裸 Ctrl+C 是 SIGINT，不能占用）。

---

## 6. 目录结构

```
herdr-desktop/
├── electron/                      # Main 进程（Agent 运行时后端）
│   ├── main.ts                    # 入口、窗口/菜单管理、标题栏叠加层
│   ├── runtime/                   # Agent 运行时
│   │   ├── pty-manager.ts         #   node-pty 生命周期（spawn/resize/write/kill）
│   │   ├── agent-detector.ts      #   状态检测（底部缓冲 + 关键词）
│   │   ├── session.ts             #   Project → Pane → Agent 拓扑
│   │   ├── settings.ts            #   设置持久化（主题/语言/字号/代理）
│   │   ├── persist.ts             #   会话原子持久化
│   │   └── git.ts                 #   git 分支探测
│   ├── ipc/
│   │   ├── protocol.ts            #   IPC type 常量
│   │   └── router.ts              #   命令路由（对应 herdr server 端）
│   ├── platform/
│   │   ├── index.ts               #   按 process.platform 分发 + isWindows
│   │   ├── types.ts               #   Platform 接口 / PlatformEnv / ResolvedShell
│   │   ├── win.ts                 #   Windows（PATH×PATHEXT、cmd 包装、ConPTY）
│   │   ├── unix.ts                #   POSIX 公共（X_OK 查找、登录 shell 环境）
│   │   ├── darwin.ts              #   macOS（复用 unix）
│   │   └── linux.ts               #   Linux（复用 unix）
│   └── preload.ts                 # contextBridge 安全桥接
├── src/                           # Renderer 进程（GUI）
│   ├── components/                # 扁平组件（TitleBar / Sidebar / ProjectGroup /
│   │                              #   AgentRow / AgentPicker / TerminalPane / Layout /
│   │                              #   SettingsDialog / ConfirmDialog / EmptyState /
│   │                              #   NotificationToasts / ThemeSwitch / icons …）
│   ├── stores/                    # Zustand（session / terminal / settings / agents /
│   │                              #   ui / notification）
│   ├── xterm/terminal.ts          # xterm.js 封装（fit / 主题 / 搜索 / 颜色查询响应）
│   ├── platform.ts                # 渲染端平台判定（同步，供快捷键分支用）
│   ├── ipc/client.ts              # preload 桥接的类型化客户端
│   ├── i18n/                      # 类型安全 i18n（中文基准，缺译即 tsc 报错）
│   └── App.tsx
├── shared/                        # 主/渲染进程共享
│   ├── protocol.ts                # IPC 消息契约（冻结）
│   ├── state.ts                   # Project / Pane / Agent / Session 纯数据模型
│   └── detect-manifest.ts         # 检测规则（关键词）
├── docs/
│   ├── architecture.md            # 本文档
│   └── status.md                  # 功能状态与里程碑盘点
└── package.json
```

---

## 7. 核心数据模型

模型已从 workspace/tab 草案简化为 **Project → Pane → Agent** 三级：项目是 agent 的容器，
pane 即一个 agent 的终端实例，agent 是检测出的身份与状态。

```ts
// shared/state.ts —— 纯数据，可序列化，可无 PTY 单元测试

interface Project {
  projectId: string;
  name: string;
  path: string;
  branch: string | null;           // git 分支（异步探测，失败为 null）
  collapsed: boolean;              // 侧栏分组折叠
  createdAt: number;
}

interface PaneState {
  paneId: string;
  projectId: string;
  label: string;                   // 展示名（label ?? command）
  cwd: string;
  focused: boolean;
  command: string;                 // 启动命令（会话恢复时重放）
  args: string[];
  running: boolean;                // false = 恢复出的停止态
}

interface AgentState {
  paneId: string;
  projectId: string;
  name: string | null;             // 检测到的 agent 名
  label: string | null;
  title: string | null;            // 终端标题（ANSI 剥离 + 噪声过滤）
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  stateChangeSeq: number;          // 单调序号，通知/排序去重
  focused: boolean;
}

interface SessionState {
  projects: Project[];
  panes: PaneState[];
  agents: AgentState[];
  focusedPaneId: string | null;    // 启动恢复后为 null（不自动选中）
  revision: number;
}

interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  language: 'zh-CN' | 'en';
  fontSize: number;                // 9–24
  sidebarCollapsed: boolean;
  proxyUrl: string;                // 启动 agent 时按 proxyAgents 注入
  proxyAgents: Record<string, boolean>;
}

// 运行时侧（不序列化，仅存在于 Main 进程）
interface PtyRuntime {
  paneId: string;
  pty: IPty;                       // node-pty 句柄
  buffer: string;                  // 回放/检测缓冲（200k 上限）
  disposed: boolean;
}
```

---

## 8. IPC 协议

统一 envelope `{ type, version, payload }`。结构状态（低频）与终端数据（高频）分通道。

**Main → Renderer：**

| type | 用途 |
|------|------|
| `state:snapshot` | 结构快照（projects/panes/agents/focusedPaneId） |
| `state:settings` | 应用设置 |
| `pty:data` / `pty:exit` | 终端数据流 / 进程退出（高频，独立于结构协议） |
| `app:info` / `app:error` | 应用信息 / 错误 toast（key 下发，渲染端本地化） |
| `agent:status` | 状态变化通知（blocked / done） |
| `agent:availability` | 命令可用性探测结果 |
| `ui:new-agent` | Ctrl+T 新建 agent 请求 |

**Renderer → Main（`control:*`）：**

| type | 用途 |
|------|------|
| `control:add-project` / `remove-project` / `toggle-project` | 项目管理 |
| `control:spawn-agent` / `attach-pane` / `respawn-pane` | 两阶段 pane 创建 + 恢复 |
| `control:close-pane` / `focus-pane` | pane 操作 |
| `control:set-theme` / `set-language` / `set-font-size` / `set-sidebar` | 设置 |
| `control:set-proxy-url` / `set-agent-proxy` / `set-titlebar-theme` | 代理 / 标题栏 |
| `control:named` | 高频子命令（`pty:write` / `pty:resize`） |

---

## 9. 里程碑建议

1. **M1 — 最小可运行**：Electron + React + xterm.js 骨架；Main 进程用 node-pty spawn
   一个 agent（先跑通一个 shell/agent），Renderer 显示单个终端。✅
2. **M2 — 多 pane 管理**：Project→Agent 拓扑、水平分屏布局、多 xterm 实例。✅（惰性渲染留作优化）
3. **M3 — agent 状态检测**：关键词检测 + 状态徽标 + 状态变化通知。🟡（无逐 agent 声明式 manifest）
4. **M4 — 会话持久化**：结构落盘，重启恢复，选中即自动拉起。✅
5. **M5 — 打包发布**：electron-builder NSIS，Windows 安装包。⬜

---

## 10. 设计原则（继承自 herdr AGENTS.md）

- **State 与 Runtime 分离**：`*State` 纯数据可测试，`PtyRuntime` 不序列化。
- **渲染是纯的**：`computeView()` 算几何，`render()` 只画不改状态。
- **无 God Object**：runtime / ipc / detector / persist 职责单一。
- **平台代码隔离**：OS 特定行为收敛到 `platform/`，核心模块零平台判断。
- **检测与渲染解耦**：detector 读快照，不触碰 viewport/布局状态。
- **冻结契约**：协议类型版本化，破坏性变更走新 type/version，不做静默重定义。
