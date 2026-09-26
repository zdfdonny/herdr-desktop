/**
 * 纯数据模型 —— 可 JSON 序列化，可无 PTY 单元测试。
 *
 * 继承 herdr 的 "State 与 Runtime 分离" 原则：
 * 这些类型只描述状态（数据），不持有任何 PTY/进程句柄。
 * 运行时侧（PtyRuntime）仅存在于 Main 进程，不进入本文件。
 */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** pane 类型：终端进程（默认）或内嵌 Web GUI。 */
export type PaneKind = 'pty' | 'web';

/** agent 会话引用的种类：id（如 claude 会话 uuid）或 path（如 pi/omp 的 session 文件）。 */
export type AgentSessionRefKind = 'id' | 'path';

/**
 * 持久化的 agent 会话引用（对应 herdr 的 PaneAgentSessionSnapshot）。
 *
 * 恢复 pane 时据此重建该 agent 的恢复命令（如 `claude --resume <value>`）。
 * source 约定为 `herdr:<agent>`，恢复侧只接受官方来源。
 */
export interface PaneAgentSession {
  /** 上报来源，形如 "herdr:claude"。 */
  source: string;
  /** agent 识别名（与启动命令对应，如 claude / codex / opencode）。 */
  agent: string;
  kind: AgentSessionRefKind;
  value: string;
}

/**
 * 项目 —— agent 的归属单位。
 *
 * "Choose project" 模型：用户先添加项目（一个本地代码目录），
 * 再在项目内创建 agent。agent 的工作目录默认继承项目路径。
 */
export interface Project {
  projectId: string;
  /** 项目显示名（默认取目录名）。 */
  name: string;
  /** 项目根目录绝对路径。 */
  path: string;
  /** 是否参与 git（用于后续显示分支等）。 */
  branch: string | null;
  /** 用户手动折叠了该项目的 agent 分组。 */
  collapsed: boolean;
  /** 创建时间戳（ms），用于稳定排序。 */
  createdAt: number;
}

/** 单个 agent 的运行时状态。 */
export interface AgentState {
  paneId: string;
  /** 所属项目。agent 必须归属到一个项目。 */
  projectId: string;
  /** 检测到的 agent 名（claude / codex / cursor / opencode / gemini / ...）。 */
  name: string | null;
  /** 用户在创建时指定的标签。 */
  label: string | null;
  /** 终端标题（去掉 ANSI 后）。 */
  title: string | null;
  status: AgentStatus;
  /** 单调序号，用于状态排序与通知去重。 */
  stateChangeSeq: number;
  focused: boolean;
}

export interface PaneState {
  paneId: string;
  projectId: string;
  label: string | null;
  cwd: string | null;
  focused: boolean;
  /**
   * 该 pane 启动的命令（如 "opencode"）。
   *
   * 会话恢复用：重启后进程已死，但记录的命令允许用户一键重启。
   * 旧版本 session.json 中可能缺失（按 null 处理）。
   */
  command?: string | null;
  /** 命令附加参数（与 command 一同持久化）。 */
  args?: string[] | null;
  /**
   * PTY 进程是否存活。
   *
   * 恢复出的 pane 一律为 false（进程不可能跨重启存活），
   * 用户点击「重新启动」后变回 true。
   * 旧版本快照中可能缺失，读取方按 true 处理（向后兼容）。
   */
  running?: boolean;
  /**
   * 重启计数：每次「运行中强制重启」递增。
   *
   * 渲染端把它作为终端挂载 effect 的依赖。运行中重启时 `running` 全程为 true，
   * 光靠 running 无法让 effect 重跑，旧 xterm 实例会继续挂在已死的 PTY 上，
   * 且 attachPane 永远不会被调用（两阶段启动的第二步没人触发）。
   * 递增这个值强制重建终端，从而走完 attach 流程。
   *
   * 旧版本快照中缺失，读取方按 0 处理。
   */
  restartSeq?: number;
  /**
   * pane 类型：终端进程（默认）或内嵌 Web GUI。
   * 旧版本快照中缺失，读取方按 'pty' 处理。
   */
  kind?: PaneKind;
  /**
   * Web pane 的干净地址（不含 token 查询参数）。
   *
   * 仅用于持久化/恢复与展示；带 token 的认证链接是进程内敏感信息，
   * 由 Main 运行时通过 `web:ready` 下发给渲染端，绝不落盘。
   */
  webUrl?: string | null;
  /**
   * agent 自身的会话引用（持久化，重启/恢复时据此重建 --resume/--session 参数）。
   *
   * 对应 herdr `PaneSnapshot.agent_session`。由官方集成上报（`agent:report-session`）
   * 或从启动参数反推（如 `codex resume <id>`）写入；旧版本快照中缺失按 null 处理。
   */
  agentSession?: PaneAgentSession | null;
}

/** 完整会话状态（Renderer 端投影的权威结构）。 */
export interface SessionState {
  projects: Project[];
  panes: PaneState[];
  agents: AgentState[];
  focusedPaneId: string | null;
  /** 每次结构变更递增，用于 Renderer 判断是否需要整体刷新。 */
  revision: number;
}

/** 结构状态的增量 patch（低频）。 */
export interface SessionStatePatch {
  revision: number;
  upsertProjects?: Project[];
  upsertPanes?: PaneState[];
  upsertAgents?: AgentState[];
  removeProjectIds?: string[];
  removePaneIds?: string[];
  focusedPaneId?: string | null;
}

/** 添加项目的参数。 */
export interface AddProjectParams {
  /** 项目根目录绝对路径。 */
  path: string;
  /** 可选显示名，缺省取目录名。 */
  name?: string;
}

/** 创建 agent 的参数。 */
export interface SpawnAgentParams {
  /** agent 归属的项目。 */
  projectId: string;
  /** agent 命令，如 "claude"、"codex"、"opencode" 或任意 shell 命令。 */
  command: string;
  /** 附加参数。 */
  args?: string[];
  /** 工作目录，缺省为项目路径。 */
  cwd?: string;
  /** 可选 agent 标签。 */
  label?: string;
}

/** 创建 DeepSeek Harness Web agent 的参数。 */
export interface SpawnWebAgentParams {
  /** agent 归属的项目。 */
  projectId: string;
  /** 可选展示标签，缺省为「DeepSeek Harness」。 */
  label?: string;
}

/** 主题偏好：跟随系统 / 强制浅色 / 强制深色。 */
export type ThemePreference = 'system' | 'light' | 'dark';

/** 解析后的实际主题（system 已被解析为具体值）。 */
export type ResolvedTheme = 'light' | 'dark';

/** 界面语言：仅支持简体中文与英文，默认中文。 */
export type Language = 'zh-CN' | 'en';

/** 应用设置。 */
export interface AppSettings {
  theme: ThemePreference;
  /** 界面语言。 */
  language: Language;
  /** 终端字号。 */
  fontSize: number;
  /** 左侧栏是否折叠为窄图标条。 */
  sidebarCollapsed: boolean;
  /**
   * 代理地址（如 http://127.0.0.1:7890），空串表示未配置。
   *
   * 仅在启动 agent 进程时按 proxyAgents 的开关注入环境变量，
   * 不影响应用自身的网络请求。
   */
  proxyUrl: string;
  /**
   * 按启动命令开启代理注入（command → 是否注入）。
   *
   * 键是 agent 的启动命令（如 "claude"），与 SpawnAgentParams.command 对应，
   * 主进程据此在 spawn 时决定是否注入代理环境变量。
   */
  proxyAgents: Record<string, boolean>;
}

/** agent 检测 manifest（继承 herdr 的声明式检测思想）。 */
export interface AgentDetectManifest {
  /** agent 名（与 AgentState.name 对应）。 */
  agent: string;
  /** 用于在终端快照中识别该 agent 的规则。 */
  rules: AgentDetectRule[];
}

export interface AgentDetectRule {
  /** 匹配模式，正则字符串。 */
  pattern: string;
  /** 命中该 pattern 时应判定的状态。 */
  status: AgentStatus;
}
