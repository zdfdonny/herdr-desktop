/**
 * 纯数据模型 —— 可 JSON 序列化，可无 PTY 单元测试。
 *
 * 继承 herdr 的 "State 与 Runtime 分离" 原则：
 * 这些类型只描述状态（数据），不持有任何 PTY/进程句柄。
 * 运行时侧（PtyRuntime）仅存在于 Main 进程，不进入本文件。
 */

/**
 * 三层状态模型（对齐 herdr 的 detect::AgentState / api::PaneAgentState / api::AgentStatus）：
 *
 * - DetectedState：检测层（屏幕/OSC）与 hook 上报产出的原始状态，4 值。
 * - PaneAgentState：pane 级协议状态，与检测层语义一致（4 值）。
 * - AgentStatus：最终对外状态；`done` 只由 `paneAgentStatus(state, seen)` 派生，
 *   禁止检测层 / hook 层直接写入。
 */
export type DetectedState = 'idle' | 'working' | 'blocked' | 'unknown';
export type PaneAgentState = DetectedState;
export type AgentStatus = DetectedState | 'done';

import type { AgentId } from './agents/agent-id';

/** pane 类型：终端进程（默认）或内嵌 Web GUI。 */
export type PaneKind = 'pty' | 'web';

/** agent 会话引用的种类：id（如 claude 会话 uuid）或 path（如 pi/omp 的 session 文件）。 */
export type AgentSessionRefKind = 'id' | 'path';

/**
 * 持久化的 agent 会话引用（对应 herdr 的 PaneAgentSessionSnapshot）。
 *
 * 恢复 pane 时据此重建该 agent 的恢复命令（如 `claude --resume <value>`）。
 * source 约定为 `herdr-desktop:<agent>`，恢复侧只接受官方来源。
 * 旧版本快照里可能是 `herdr:<agent>`，读取时会归一化（见 normalizeAgentSource）。
 */
export interface PaneAgentSession {
  /** 上报来源，形如 "herdr-desktop:claude"。 */
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

/** 单个 agent 的运行时状态（对齐 herdr 的 AgentInfo）。 */
export interface AgentInfo {
  paneId: string;
  /** 所属项目。agent 必须归属到一个项目。 */
  projectId: string;
  /** 检测到的 agent 名（claude / codex / cursor / opencode / gemini / ...）。 */
  name: string | null;
  /** 用户在创建时指定的标签。 */
  label: string | null;
  /** 终端标题（去掉 ANSI 后）。 */
  title: string | null;
  /** 最终状态（done 只由 paneAgentStatus 派生，见 shared/agent-status.ts）。 */
  status: AgentStatus;
  /** 单调序号，用于状态排序与通知去重（对齐 herdr state_change_seq）。 */
  stateChangeSeq: number;
  /**
   * 最近一次完成跳变（working/blocked → idle）的序号（对齐 herdr completion_seq）。
   * 旧版本快照中缺失，读取方按 null 处理。
   */
  completionSeq?: number | null;
  focused: boolean;
  /** 创建时间戳（ms），用于项目内按创建顺序稳定排序。 */
  createdAt: number;
  /** managed agent 仍在启动/阻塞中（对齐 herdr launch_pending）。旧版本快照缺失按 false 处理。 */
  launchPending?: boolean;
  /** managed agent 已交互就绪（对齐 herdr interactive_ready）。旧版本快照缺失按 false 处理。 */
  interactiveReady?: boolean;
  /**
   * 完整生命周期 hook 权威激活中，屏幕检测被跳过（对齐 herdr screen_detection_skipped）。
   * 旧版本快照缺失按 false 处理。
   */
  screenDetectionSkipped?: boolean;
}

export interface PaneState {
  paneId: string;
  projectId: string;
  label: string | null;
  cwd: string | null;
  focused: boolean;
  /**
   * 创建时声明的智能体 id。
   *
   * 与 `AgentInfo.name`（运行期**观测**到的智能体）分工不同：
   * - 本字段是**声明身份**，创建时就确定，是策略查询的权威来源；
   * - `name` 是观测结果，用于证明「实际跑起来的确实是它」，也用于
   *   纯终端 pane 里用户自己敲 `claude` 的场景。
   *
   * 旧版本 session.json 缺失时按 null 处理，回退到命令解析。
   */
  agentId?: AgentId | null;
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
   * 渲染端把它作为「重建运行时视图」的依赖，两种 pane 都需要：
   * - 终端 pane 据此重建终端。运行中重启时 `running` 全程为 true，光靠 running
   *   无法让 effect 重跑，旧 xterm 实例会继续挂在已死的 PTY 上，且 attachPane
   *   永远不会被调用（两阶段启动的第二步没人触发）。递增这个值强制重建终端，
   *   从而走完 attach 流程。
   * - web pane 据此重建 `<webview>`。`dsh web` 是全 app 共享的单进程，重启单个
   *   pane 不会重启服务端，认证链接（src）不变，没有差异可供 React 触发重载。
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
   * Web pane 当前共享进程的监听端口（informational）。
   *
   * 共享单进程模型下，所有 web pane 共用同一个 dsh web 进程，端口也相同；
   * 这里仅作记录展示，不再参与启动决策（端口由 WebAgentManager 统一持有）。
   * 旧版本快照中缺失，按未分配处理。
   */
  port?: number | null;
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
  agents: AgentInfo[];
  focusedPaneId: string | null;
  /** 每次结构变更递增，用于 Renderer 判断是否需要整体刷新。 */
  revision: number;
}

/** 结构状态的增量 patch（低频）。 */
export interface SessionStatePatch {
  revision: number;
  upsertProjects?: Project[];
  upsertPanes?: PaneState[];
  upsertAgents?: AgentInfo[];
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
  /**
   * 用户选择的智能体 id（`terminal` 或任意用户自定命令时为 null）。
   *
   * 这是**声明身份**：创建时记录一次，之后策略查询（状态仲裁、集成状态、
   * 恢复命令、UI 展示）都以此为准，不再靠命令名/屏幕内容反推。
   * 旧版渲染端不传该字段，主进程回退到命令解析（行为与重构前一致）。
   */
  agentId?: AgentId | null;
  /** agent 命令，如 "claude"、"codex"、"opencode" 或任意 shell 命令。 */
  command: string;
  /** 附加参数。 */
  args?: string[];
  /** 工作目录，缺省为项目路径。 */
  cwd?: string;
  /** 可选 agent 标签。 */
  label?: string;
}

/** 创建 Web 型智能体（内嵌 Web GUI）的参数。 */
export interface SpawnWebAgentParams {
  /** agent 归属的项目。 */
  projectId: string;
  /**
   * 要创建的 **web 型智能体** id。
   *
   * web 只是宿主形态，不是某个具体智能体 —— 目前只有 dsh（DeepSeek Harness）
   * 是 web 型，但未来会有别的。缺省时取注册表里唯一的 web 型智能体，
   * 保证旧渲染端不传该字段也能工作。
   */
  agentId?: AgentId | null;
  /** 可选展示标签，缺省取该智能体的展示名。 */
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
  /**
   * 代理地址（如 http://127.0.0.1:7890），空串表示未配置。
   *
   * 仅在启动 agent 进程时按 proxyAgents 的开关注入环境变量，
   * 不影响应用自身的网络请求。
   */
  proxyUrl: string;
  /**
   * 按**智能体**开启代理注入（agentId → 是否注入）。
   *
   * 键必须用 agentId 而不是启动命令：命令含平台分支（cursor 在 Windows 上是
   * `cursor-agent.cmd`、macOS 上是 `cursor-agent`），用命令作键会让同一智能体
   * 在两个平台互不承认，且用户一旦改启动命令就会静默丢掉开关。
   *
   * 主进程在 spawn 时按此决定是否注入代理环境变量。
   */
  proxyAgents: Record<string, boolean>;
  /**
   * 集成引导是否已完成。
   *
   * 首次启动时若为 false，渲染端会弹出集成引导弹窗（告诉用户集成是什么、
   * 下次在哪找到），并立即把它置为 true，保证只引导一次。
   */
  integrationsOnboarded: boolean;
  /**
   * 声音：agent 在后台完成（done）或等待输入（blocked）时播放提示音。
   *
   * 默认关闭。对应 herdr 的 `ui.sound.enabled`；这里简化为单一开关，
   * 不提供自定义 mp3 路径与按 agent 覆盖。旧版本 settings.json 缺失时按 false 处理。
   */
  soundEnabled: boolean;
  /**
   * 通知：agent 在后台完成（done）或等待输入（blocked）时弹出应用内
   * toast（blocked 且窗口未聚焦时附加系统通知）。
   *
   * 默认关闭。对应 herdr 的 `ui.toast`；这里简化为单一开关。
   * 旧版本 settings.json 缺失时按 false 处理。
   */
  toastEnabled: boolean;
  /**
   * 快捷键覆盖：ShortcutActionId → Electron accelerator。
   *
   * 只存被用户改过的动作；未覆盖的动作使用 shared/shortcuts.ts 的默认键位。
   * 值为 null/空串的条目会被归一化丢弃。旧版本 settings.json 缺失时按空处理。
   */
  shortcuts?: Record<string, string>;
}
