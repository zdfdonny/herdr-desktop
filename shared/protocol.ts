/**
 * IPC 消息契约 —— 冻结。
 *
 * 继承 herdr `src/protocol/` 的设计哲学：
 * - 所有结构消息走统一 envelope `{ type, version, payload }`。
 * - 结构消息类型作为冻结契约，新增字段须向后兼容（可选字段 + 默认值）。
 * - 破坏性变更须新增 `type` 或 bump `version`，不做静默重定义。
 * - 终端数据流（pty:data）与结构协议分离，不进入严格版本约束。
 */

import type {
  SessionState,
  SessionStatePatch,
  SpawnAgentParams,
  SpawnWebAgentParams,
  AddProjectParams,
  AppSettings,
  ThemePreference,
  Language,
} from './state';
import type { ShortcutActionId } from './shortcuts';

/** 统一 IPC envelope。 */
export interface IpcEnvelope<T = unknown> {
  type: string;
  version: number;
  payload: T;
}

/** 结构状态通道（低频，强版本约束）。 */
export type StateMessage =
  | (IpcEnvelope<SessionState> & { type: 'state:snapshot'; version: 1 })
  | (IpcEnvelope<SessionStatePatch> & { type: 'state:patch'; version: 1 })
  | (IpcEnvelope<AppSettings> & { type: 'state:settings'; version: 1 });

/** 终端数据通道（高频，独立于结构协议）。 */
export type TerminalMessage =
  | { type: 'pty:data'; payload: { paneId: string; data: string } }
  | { type: 'pty:exit'; payload: { paneId: string; exitCode: number; signal: number | null } }
  /*
   * 丢弃某个 pane 的回放缓冲。
   *
   * 强制重启时进程被 kill，但 `PtyManager.kill` 会先置 disposed 从而吞掉
   * onExit 回调，渲染端收不到 `pty:exit`、缓冲不会被清。若不清，重启后
   * 终端重建会把旧会话输出重放进新 xterm，其中的终端能力查询（CSI c、
   * DECRPM、OSC 11;? 等）会被重新作答并写进刚创建、仍处于 canonical+echo
   * 的 PTY，被行规程原样回显成 `^[[?1;2c...` 之类的乱码。
   *
   * 与 `pty:exit` 分开是为了不触发退出语义（主进程的 onExit 回调还会
   * closePane / 转移焦点），这里只表示「缓冲作废」。
   */
  | { type: 'pty:reset'; payload: { paneId: string } };

/** 控制命令（可扩展，对应 herdr 的 EndpointControl）。 */
export type ControlMessage =
  | (IpcEnvelope<AddProjectParams> & { type: 'control:add-project'; version: 1 })
  | (IpcEnvelope<{ projectId: string }> & { type: 'control:remove-project'; version: 1 })
  | (IpcEnvelope<{ projectId: string; collapsed: boolean }> & {
      type: 'control:toggle-project';
      version: 1;
    })
  | (IpcEnvelope<SpawnAgentParams> & { type: 'control:spawn-agent'; version: 1 })
  | (IpcEnvelope<SpawnWebAgentParams> & { type: 'control:spawn-web-agent'; version: 1 })
  | (IpcEnvelope<{ paneId: string }> & { type: 'control:attach-pane'; version: 1 })
  /*
   * force：运行中强制重启（先杀进程再拉起）。
   * 缺省/undefined 表示只恢复停止态的 pane，运行中则 no-op。
   */
  | (IpcEnvelope<{ paneId: string; force?: boolean }> & {
      type: 'control:respawn-pane';
      version: 1;
    })
  | (IpcEnvelope<{ paneId: string }> & { type: 'control:close-pane'; version: 1 })
  | (IpcEnvelope<{ paneId: string }> & { type: 'control:focus-pane'; version: 1 })
  | (IpcEnvelope<{ theme: ThemePreference }> & { type: 'control:set-theme'; version: 1 })
  | (IpcEnvelope<{ color: string; symbolColor: string }> & {
      type: 'control:set-titlebar-theme';
      version: 1;
    })
  | (IpcEnvelope<{ language: Language }> & { type: 'control:set-language'; version: 1 })
  | (IpcEnvelope<{ fontSize: number }> & { type: 'control:set-font-size'; version: 1 })
  | (IpcEnvelope<{ url: string }> & { type: 'control:set-proxy-url'; version: 1 })
  | (IpcEnvelope<{ command: string; enabled: boolean }> & {
      type: 'control:set-agent-proxy';
      version: 1;
    })
  | (IpcEnvelope<{ onboarded: boolean }> & {
      type: 'control:set-integrations-onboarded';
      version: 1;
    })
  | (IpcEnvelope<{ enabled: boolean }> & { type: 'control:set-sound-enabled'; version: 1 })
  | (IpcEnvelope<{ enabled: boolean }> & { type: 'control:set-toast-enabled'; version: 1 })
  | (IpcEnvelope<{ kind: string; data: string }> & { type: 'control:named'; version: 1 })
  /*
   * 改键：设置单个动作的自定义 accelerator；accelerator 为 null 表示恢复默认。
   */
  | (IpcEnvelope<{ action: string; accelerator: string | null }> & {
      type: 'control:set-shortcut';
      version: 1;
    })
  | (IpcEnvelope<Record<string, never>> & { type: 'control:reset-shortcuts'; version: 1 })
  /*
   * 改键捕获期间：begin 让主进程忽略菜单快捷键（setIgnoreMenuShortcuts(true)），
   * 否则当前已注册的菜单 accelerator 会先于渲染层 keydown 被消费、无法捕获。
   * end 恢复菜单快捷键并重建菜单。
   */
  | (IpcEnvelope<Record<string, never>> & { type: 'control:begin-shortcut-capture'; version: 1 })
  | (IpcEnvelope<Record<string, never>> & { type: 'control:end-shortcut-capture'; version: 1 });

/** Main → Renderer 的全部消息联合。 */
export type MainToRendererMessage =
  | StateMessage
  | TerminalMessage
  | { type: 'app:info'; payload: { version: string; platform: string } }
  | { type: 'app:error'; payload: AppErrorPayload }
  | { type: 'agent:status'; payload: AgentStatusPayload }
  | { type: 'agent:availability'; payload: AgentAvailabilityPayload }
  | { type: 'ui:open-settings'; payload: Record<string, never> }
  | { type: 'ui:add-project'; payload: Record<string, never> }
  | { type: 'ui:shortcut'; payload: { action: ShortcutActionId; index?: number } }
  | {
      type: 'web:ready';
      payload: { paneId: string; url: string };
    };

/**
 * 用户可见的错误（spawn 失败等），不崩溃主进程。
 *
 * 注意：Main 进程不产出本地化文案，只给出**文案 key** 与插值变量，
 * 由 Renderer 按当前语言渲染，避免语言切换后历史消息语言不一致。
 */
export interface AppErrorPayload {
  /** 标题文案 key，对应 i18n messages，如 'error.commandNotFound'。 */
  titleKey: string;
  /** 标题插值变量。 */
  titleVars?: Record<string, string | number>;
  /** 详情文案 key（可选）。 */
  detailKey?: string;
  /** 详情插值变量。 */
  detailVars?: Record<string, string | number>;
  /** 关联的 pane（若适用）。 */
  paneId?: string;
  /** 关联的项目（若适用）。 */
  projectId?: string;
}

/** 各 agent 命令在本机的可用性探测结果。 */
export interface AgentAvailabilityPayload {
  /** 命令名 → 是否可解析到。 */
  available: Record<string, boolean>;
}

/**
 * 代理连通性检测结果。
 *
 * 只返回结构化信息，文案由 Renderer 按当前语言渲染，
 * 与 `AppErrorPayload` 的「Main 不产出本地化文案」原则一致。
 */
export interface ProxyTestResult {
  /** 是否连通（成功经由代理拿到响应）。 */
  ok: boolean;
  /** 失败原因分类，成功时为 undefined。 */
  reason?: 'invalid' | 'connect' | 'timeout';
  /** 失败细节（如底层错误消息），供界面提示使用。 */
  detail?: string;
  /** 握手耗时（毫秒），成功时提供。 */
  latencyMs?: number;
}

/**
 * agent 状态变化通知（转到 blocked / done 时由 Main 推送）。
 *
 * 只带结构化信息，文案由 Renderer 按当前语言渲染，
 * 与 `AppErrorPayload` 的「Main 不产出本地化文案」原则一致。
 */
export interface AgentStatusPayload {
  /** 触发通知的 pane。 */
  paneId: string;
  /** 所属项目。 */
  projectId: string;
  /** 展示名（label 回退到启动命令）。 */
  label: string;
  /** 触发通知的新状态。 */
  status: 'blocked' | 'done';
  /** blocked 详情（如工具名），可选。 */
  message?: string;
}

/** 官方集成 hook 的安装状态。 */
export type HookStatus = 'installed' | 'not-installed' | 'unsupported' | 'outdated';

/**
 * 系统剪贴板内容（供终端「智能粘贴」读取）。
 *
 * Main 按「文件 → 图片 → 文本」的优先级从系统剪贴板解析，返回其中一种：
 * - files：从文件管理器复制来的文件（`text/uri-list` / 原生 HDROP 解析为绝对路径）；
 * - image：剪贴板里的位图（如截图），已由 Main 落盘为临时文件，返回其绝对路径；
 * - text：普通文本；
 * - empty：剪贴板为空或无法解析。
 */
export type ClipboardPayload =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'image'; imagePath: string }
  | { kind: 'files'; files: string[] };

/** Renderer → Main 的全部消息联合。 */
export type RendererToMainMessage = ControlMessage;

/** Renderer 通过 preload 暴露的调用接口。 */
export interface HerdrDesktopApi {
  /** 发起一次控制命令。 */
  sendControl(message: ControlMessage): void;
  /** 订阅 Main → Renderer 消息。返回取消订阅函数。 */
  onMessage(callback: (message: MainToRendererMessage) => void): () => void;
  /** 获取应用信息。 */
  getAppInfo(): Promise<{ version: string; platform: string }>;
  /** 打开系统目录选择对话框，返回选中的绝对路径（取消返回 null）。 */
  pickDirectory(options?: { title?: string }): Promise<string | null>;
  /** 获取当前设置。 */
  getSettings(): Promise<AppSettings>;
  /** 探测 agent 命令的可用性。 */
  getAgentAvailability(commands: string[]): Promise<Record<string, boolean>>;
  /** 检测代理地址是否可用（经该代理发起一次真实请求）。 */
  testProxy(url: string): Promise<ProxyTestResult>;
  /** 获取各 agent 的官方集成 hook 安装状态。 */
  getHookStatuses(): Promise<Record<string, HookStatus>>;
  /** 安装某 agent 的官方集成 hook。 */
  installHook(agentId: string): Promise<HookStatus>;
  /** 卸载某 agent 的官方集成 hook。 */
  uninstallHook(agentId: string): Promise<HookStatus>;
  /** 标记集成引导已完成（首次启动引导弹窗关闭后调用）。 */
  setIntegrationsOnboarded(onboarded: boolean): void;
  /** 读取系统剪贴板（文本 / 图片 / 文件），供终端智能粘贴。 */
  readClipboard(): Promise<ClipboardPayload>;
  /** 取拖拽 / 粘贴 File 对应的磁盘绝对路径（非磁盘文件返回空串）。 */
  getPathForFile(file: File): string;
}

export type {
  SessionState,
  SessionStatePatch,
  SpawnAgentParams,
  SpawnWebAgentParams,
  AddProjectParams,
  AppSettings,
  ThemePreference,
  Language,
};
