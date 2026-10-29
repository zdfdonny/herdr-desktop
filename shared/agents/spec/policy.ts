/**
 * 状态仲裁策略 —— 把散落的 agent 特例变成声明式数据。
 *
 * 重构前，这些判据分散在 4 个扁平谓词函数（`shared/detect-manifest.ts:126~192`）
 * 和 10 处内联 `if (agent === 'xxx')`（`electron/runtime/terminal-state.ts`）里，
 * 靠注释维持。现在每个智能体在自己的 descriptor 里声明一次。
 */

/**
 * hook 的状态权威等级（对应 herdr 的 hook 权威三态）。
 *
 * - `'none'`           ：只上报会话身份，状态一律由屏幕决定（hermes / qwen / letta）
 * - `'state'`          ：hook 报状态，屏幕仍参与仲裁（claude / codex / antigravity …）
 * - `'full-lifecycle'` ：hook 活着时屏幕状态被忽略（pi / omp / mastracode / opencode / kilo / kimi）
 */
export type HookAuthority = 'none' | 'state' | 'full-lifecycle';

/**
 * 会话重绑语义。
 *
 * - `'default'`            ：常规语义，允许前台 pane 抢占他人会话；
 * - `'explicit-replace'`   ：codex —— 状态上报不允许更换已锚定会话，换会话要显式替换；
 * - `'unsequenced-select'` ：opencode —— TUI 的 `select` 不带 seq，免水位且不做 pending 记录；
 * - `'overwrite-persisted'`：mastracode —— 无 hook 权威时，会话上报可直接覆盖持久化会话。
 */
export type SessionRebindingMode =
  | 'default'
  | 'explicit-replace'
  | 'unsequenced-select'
  | 'overwrite-persisted';

export interface SessionRebinding {
  readonly mode: SessionRebindingMode;
  /** 是否允许前台 pane 抢占他人会话（grok 为 false）。 */
  readonly allowForegroundTakeover: boolean;
  /**
   * 是否拒绝「别家会话」的状态上报。
   *
   * opencode 为 true：多个 pane 并发跑 opencode 时，A 窗口的上报会带着 B 会话的
   * 引用飘过来，这类上报要直接丢弃（而不是走常规的「记 pending 替换」分支），
   * 否则状态会串到别的 pane 上。
   */
  readonly rejectsCrossSessionReports?: boolean;
}

/** managed agent 从 pending 进 active 的就绪判据。 */
export interface ReadinessProbe {
  /** 检测到 idle 即就绪（绝大多数 agent）。 */
  readonly acceptsIdle: boolean;
  /** 还需要屏幕出现「当前 prompt 标记」（codex 的 `›`）。 */
  readonly requiresPromptMarker: boolean;
}

export interface StatePolicy {
  readonly hookAuthority: HookAuthority;
  /** 屏幕的 working/blocked → idle 是否算「完成」。false = 完成只认 hook。 */
  readonly screenOwnsCompletion: boolean;
  /** 启动窗口内屏幕 working 是否忽略（初始化不产生状态变化）。 */
  readonly ignoreStartupWorking: boolean;
  /** 是否接受 heartbeat 语义的 working 上报（claude 的 PostToolUse tick）。 */
  readonly acceptsHeartbeat: boolean;
  /** 会话重绑语义。 */
  readonly sessionRebinding: SessionRebinding;
  /** hook 上报是否按 sessionId 反查 pane（dsh：多个 pane 看同一会话）。 */
  readonly routeBySessionId: boolean;
  /** managed agent 的就绪判据。 */
  readonly readiness: ReadinessProbe;
  /**
   * 「完成判定交给 hook」是否额外要求集成已安装。
   *
   * 屏幕不判完成的 agent（claude / antigravity）如果用户没装集成，hook 永远不会
   * 上报 idle —— 此时必须退回屏幕判定，否则该 agent 再也不会响完成提示音。
   */
  readonly completionRequiresIntegration: boolean;
}

/** 绝大多数智能体的默认策略。 */
export const DEFAULT_STATE_POLICY: StatePolicy = {
  hookAuthority: 'state',
  screenOwnsCompletion: true,
  ignoreStartupWorking: false,
  acceptsHeartbeat: false,
  sessionRebinding: { mode: 'default', allowForegroundTakeover: true },
  routeBySessionId: false,
  readiness: { acceptsIdle: true, requiresPromptMarker: false },
  completionRequiresIntegration: false,
};

/** 按需覆盖默认策略的小工具，避免每个 descriptor 写全字段。 */
export function statePolicy(overrides: Partial<StatePolicy>): StatePolicy {
  return { ...DEFAULT_STATE_POLICY, ...overrides };
}

/** 按需覆盖默认会话重绑策略的小工具。 */
export function sessionRebinding(overrides: Partial<SessionRebinding>): SessionRebinding {
  return { ...DEFAULT_STATE_POLICY.sessionRebinding, ...overrides };
}
