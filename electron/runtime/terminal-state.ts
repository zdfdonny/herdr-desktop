/**
 * 终端/agent 状态机 —— 对应 herdr `src/terminal/state.rs`。
 *
 * 这是 herdr-desktop 智能体状态仲裁的权威位置：把 herdr 的
 * `TerminalState`（纯数据状态机）忠实移植过来，与 PTY/进程句柄完全解耦，
 * 因此可以无 Electron / node-pty 单元测试。
 *
 * 与 herdr 的差异（有意为之）：
 * - 时间用 `number`（毫秒单调时钟）传入，对应 herdr 的 `Instant`；
 * - agent 身份用 canonical 字符串（`string`），对应 herdr 的 `Agent` 枚举；
 * - 省略 presentation（title/display_agent/state_labels）与 metadata/tokens 子系统，
 *   因此 `recomputeEffectiveState` 只比较 agent 身份 + 状态，不比较 presentation；
 * - 省略 `reported_resume`（desktop 由 pane.agentSession 重建恢复命令）、
 *   `terminal_title`（desktop 的标题来自检测层）、`launch_argv`/`respawn_shell_on_exit`、
 *   `pending_agent_resume_plan`/`restore_error`。
 */

import type { AgentSessionRefKind, DetectedState } from '../../shared/state';
import {
  fullLifecycleHookAuthority,
  parseAgentLabel,
  screenStartupIgnored,
  sessionIdentityOnlyIntegration,
} from '../../shared/detect-manifest';
import {
  canResume,
  isOfficialAgentSource,
  normalizeSessionStartSource,
  sessionReportAllowsSessionReplacement,
  type AgentSessionRef,
  type PersistedAgentSession,
} from './agent-resume';

/**
 * 非全生命周期来源的 `working` 上报有效期。
 *
 * antigravity 在用户按 Esc 取消时不会回调 `Stop`（CLI 直接中断执行循环，
 * 只有正在跑的 PreInvocation 进程被杀掉），最后一条 `working` 会把状态永久钉住。
 * 超过这个时长仍未被刷新，就把状态交还屏幕判定。
 *
 * 取 1.5 秒：真实工作时屏幕一直有 spinner / `esc to cancel`，状态不会因此抖动；
 * 即使屏幕偶发误判 idle，通知队列还有 1 秒证据校验兜底，不会误响。
 *
 * 只对「有屏幕观测」的 pane 生效（见 effectiveHookState）：web pane 没有屏幕检测，
 * 其 fallbackState 恒为 idle，若也套用 TTL，dsh 的 working 上报间隔一长就会被
 * 错误地拉回 idle。
 */
export const HOOK_WORKING_TTL_MS = 1_500;

/**
 * CLI 启动窗口的上限（毫秒），见 `TerminalState.agentStartupInProgress`。
 *
 * 窗口正常由「屏幕画出 agent 的就绪画面」（manifest 的 idle 规则命中 → visibleIdle）、
 * 对话框、或 hook 的非 working 上报关闭，这个上限只是防御：页脚改版不再命中规则时，
 * 别让屏幕的 working 被永久屏蔽。
 *
 * 取 20 秒的取舍：上限太长（如一分钟）会把用户「启动完立刻提问」的第一轮也一起吞掉——
 * 窗口内 working 被屏蔽，那一轮结束时就没有 working → idle 的跳变，完成提示音会丢；
 * 上限太短则慢启动的尾段会照常闪出 working。正常的冷启动远小于 20 秒，
 * 而用户从看到输入框到发出第一条消息通常也大于这个时间。
 */
export const AGENT_STARTUP_WINDOW_MS = 20_000;

/** hook 上报的权威状态（对应 herdr `HookAuthority`）。 */
export interface HookAuthority {
  source: string;
  agentLabel: string;
  state: DetectedState;
  message: string | null;
  /** 单调时钟毫秒（对应 herdr `Instant`）。 */
  reportedAt: number;
  sessionRef: AgentSessionRef | null;
}

/** 有效状态变化（对应 herdr `EffectiveStateChange`，省略 presentation）。 */
export interface EffectiveStateChange {
  previousAgentLabel: string | null;
  previousKnownAgent: string | null;
  previousState: DetectedState;
  agentLabel: string | null;
  knownAgent: string | null;
  state: DetectedState;
}

/** 状态机一次变更的副作用汇总（对应 herdr `TerminalStateMutation`）。 */
export interface TerminalStateMutation {
  effectiveStateChange: EffectiveStateChange | null;
  sessionRefChanged: boolean;
  agentReleased: boolean;
}

type FullLifecycleHookSuppressionReason = 'hook-clear' | 'process-exit';

type FullLifecycleHookReportRoute =
  | { accept: true; reanchorSequence: boolean }
  | { accept: false };

interface SuppressedFullLifecycleHookReport {
  agentLabel: string;
  sessionRef: AgentSessionRef | null;
  observedAt: number;
  reason: FullLifecycleHookSuppressionReason;
  replacementSessionRef: AgentSessionRef | null;
  pendingReplacementReport: PendingFullLifecycleHookReport | null;
}

interface PendingFullLifecycleHookReport {
  authority: HookAuthority;
  seq: number;
}

interface StaleFullLifecycleHookSession {
  agentLabel: string;
  sessionRef: AgentSessionRef;
}

interface AgentNameOwner {
  agentLabel: string;
  sessionRef: AgentSessionRef | null;
}

interface RecentAgentProcessExit {
  agent: string;
  observedAt: number;
}

type ManagedAgentPhase =
  | { kind: 'pending'; readyAfter: number | null; deadline: number; observedExpected: boolean }
  | { kind: 'blocked' }
  | { kind: 'active' };

interface ManagedAgent {
  kind: string;
  phase: ManagedAgentPhase;
}

interface SessionIdentity {
  source: string;
  agent: string;
  kind: AgentSessionRefKind;
  value: string;
}

function sessionIdentityEqual(a: SessionIdentity | null, b: SessionIdentity | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.source === b.source && a.agent === b.agent && a.kind === b.kind && a.value === b.value;
}

/** AgentSessionRef 按值比较（对应 herdr `AgentSessionRef` 的 PartialEq）。 */
function sessionRefEquals(a: AgentSessionRef | null, b: AgentSessionRef | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.value === b.value;
}

export class TerminalState {
  /** paneId（对应 herdr `TerminalId`，desktop 的终端与 pane 一一对应）。 */
  readonly paneId: string;

  /** 进程检测到的 agent（canonical 字符串，对应 herdr `detected_agent: Option<Agent>`）。 */
  detectedAgent: string | null;

  /** 屏幕检测回退状态（对应 herdr `fallback_state`）。 */
  fallbackState: DetectedState;

  /** hook 上报的权威（对应 herdr `hook_authority`）。 */
  hookAuthority: HookAuthority | null;

  /** 持久化的会话引用（对应 herdr `persisted_agent_session`）。 */
  persistedAgentSession: PersistedAgentSession | null;

  /** 用户/托管启动给 agent 起的名字（对应 herdr `agent_name`）。 */
  agentName: string | null;

  /** 当前有效状态（对应 herdr `state`）。 */
  state: DetectedState;

  /** 最近一次状态跳变的序号（对应 herdr `last_agent_state_change_seq`）。 */
  lastAgentStateChangeSeq: number | null;

  /** 最近一次完成跳变的序号（对应 herdr `last_agent_completion_seq`）。 */
  lastAgentCompletionSeq: number | null;

  private fallbackVisibleBlocker: boolean;
  /**
   * 是否收到过真实的屏幕观测（对应「这个 pane 有终端输出」）。
   *
   * web pane 永远没有屏幕观测，`fallbackState` 恒为 idle；hook working 的 TTL
   * 只对有过屏幕观测的 pane 生效，避免把 dsh 的 working 误落到 idle。
   */
  private screenObserved = false;
  private agentNameOwner: AgentNameOwner | null;
  private managedAgent: ManagedAgent | null;
  private codexPromptReady: boolean;
  private managedAgentLaunchSession: PersistedAgentSession | null;
  private hookReportSequences = new Map<string, number>();
  private suppressedFullLifecycleHookReports = new Map<string, SuppressedFullLifecycleHookReport>();
  private staleFullLifecycleHookSessions = new Map<string, StaleFullLifecycleHookSession[]>();
  private recentAgentProcessExit: RecentAgentProcessExit | null;
  private agentProcessAcquisitionPending: boolean;
  /** CLI 启动窗口是否打开（见 agentStartupInProgress）。 */
  private agentStartupPending: boolean;
  /** 启动窗口的打开时间（单调毫秒），用于窗口上限。 */
  private agentStartupSince: number;

  constructor(paneId: string) {
    this.paneId = paneId;
    this.detectedAgent = null;
    this.fallbackState = 'unknown';
    this.fallbackVisibleBlocker = false;
    this.hookAuthority = null;
    this.persistedAgentSession = null;
    this.agentName = null;
    this.agentNameOwner = null;
    this.managedAgent = null;
    this.codexPromptReady = false;
    this.managedAgentLaunchSession = null;
    this.state = 'unknown';
    this.lastAgentStateChangeSeq = null;
    this.lastAgentCompletionSeq = null;
    this.recentAgentProcessExit = null;
    this.agentProcessAcquisitionPending = false;
    this.agentStartupPending = false;
    this.agentStartupSince = 0;
  }

  /** 对应 herdr `set_detected_agent_process_at`。 */
  setDetectedAgentProcessAt(agent: string, now: number): TerminalStateMutation {
    const startsAcquisition =
      !this.shouldIgnoreDetectedStateUnderFullLifecycleHook(agent, false) &&
      !this.detectedStateObservedBeforeReleaseSuppression(agent, now);
    const mutation = this.setDetectedStateWithScreenSignalsAt(
      agent,
      'unknown',
      false,
      false,
      false,
      false,
      now,
    );
    if (startsAcquisition) {
      this.codexPromptReady = false;
      this.agentProcessAcquisitionPending = true;
      // 进程刚被拉起：打开 CLI 启动窗口（见 agentStartupInProgress）。
      this.agentStartupPending = true;
      this.agentStartupSince = now;
    }
    return mutation;
  }

  /** 对应 herdr `finish_agent_process_acquisition`。 */
  finishAgentProcessAcquisition(): boolean {
    const reachedIdle = this.agentProcessAcquisitionPending && this.state === 'idle';
    const suppressCompletion = reachedIdle && this.recentAgentProcessExit === null;
    if (reachedIdle) {
      this.agentProcessAcquisitionPending = false;
    }
    return suppressCompletion;
  }

  /** 对应 herdr `set_detected_state_with_screen_signals_at`。 */
  setDetectedStateWithScreenSignalsAt(
    agent: string | null,
    fallbackState: DetectedState,
    visibleBlocker: boolean,
    visibleIdle: boolean,
    _visibleWorking: boolean,
    processExited: boolean,
    now: number,
  ): TerminalStateMutation {
    // 标记「这个 pane 有屏幕观测」——hook working 的 TTL 只在此时才允许生效
    this.screenObserved = true;
    const previousAgentLabel = this.effectiveAgentLabel();
    const previousKnownAgent = this.effectiveKnownAgent();
    const previousState = this.state;
    const previousDetectedAgent = this.detectedAgent;
    const previousSession = this.currentSessionIdentityForPersistence();

    const newerCustomAuthority =
      processExited &&
      this.hookAuthority !== null &&
      parseAgentLabel(this.hookAuthority.agentLabel) === agent &&
      !isOfficialAgentSource(this.hookAuthority.source, this.hookAuthority.agentLabel) &&
      this.hookAuthority.reportedAt > now;
    const agentReleased =
      processExited &&
      !newerCustomAuthority &&
      (previousAgentLabel !== null || this.agentName !== null);

    if (this.shouldIgnoreDetectedStateUnderFullLifecycleHook(agent, processExited)) {
      if (
        this.hookAuthority !== null &&
        parseAgentLabel(this.hookAuthority.agentLabel) === agent
      ) {
        this.detectedAgent = agent;
      }
      return {
        effectiveStateChange: this.recomputeEffectiveState(
          previousAgentLabel,
          previousKnownAgent,
          previousState,
          now,
        ),
        sessionRefChanged: !sessionIdentityEqual(
          previousSession,
          this.currentSessionIdentityForPersistence(),
        ),
        agentReleased: false,
      };
    }

    const replacementProcessDetected =
      !processExited &&
      agent !== null &&
      this.recentAgentProcessExit !== null &&
      this.recentAgentProcessExit.agent === agent &&
      this.recentAgentProcessExit.observedAt < now;
    if (!processExited && this.detectedStateObservedBeforeReleaseSuppression(agent, now)) {
      return {
        effectiveStateChange: this.recomputeEffectiveState(
          previousAgentLabel,
          previousKnownAgent,
          previousState,
          now,
        ),
        sessionRefChanged: !sessionIdentityEqual(
          previousSession,
          this.currentSessionIdentityForPersistence(),
        ),
        agentReleased: false,
      };
    }

    /*
     * CLI 启动窗口内的 working 不参与状态（见 agentStartupInProgress）。
     *
     * 屏幕上的 spinner / `esc to cancel` 在启动期只表示「CLI 还在加载」，不是一轮工作；
     * 若照常写入状态机，初始化结束的 working → idle 就会被判成一次「完成」。
     */
    if (!processExited && fallbackState === 'working' && this.agentStartupInProgress(agent, now)) {
      return {
        effectiveStateChange: this.recomputeEffectiveState(
          previousAgentLabel,
          previousKnownAgent,
          previousState,
          now,
        ),
        sessionRefChanged: !sessionIdentityEqual(
          previousSession,
          this.currentSessionIdentityForPersistence(),
        ),
        agentReleased: false,
      };
    }

    this.detectedAgent = agent;
    if (processExited || agent !== 'codex' || fallbackState === 'blocked') {
      this.codexPromptReady = false;
    }
    if (agent !== null) {
      this.reconcileAgentNameOwner(agent, null);
    }
    if (!processExited) {
      this.clearFullLifecycleHookSuppressionForDetectedAgent(
        replacementProcessDetected ? null : previousDetectedAgent,
        agent,
      );
    }
    this.fallbackState = fallbackState;
    this.fallbackVisibleBlocker = visibleBlocker && fallbackState === 'blocked';
    /*
     * 启动窗口关闭：屏幕上出现了 agent manifest 确认过的**非 working** 画面——
     * 就绪页脚（visibleIdle，如 antigravity 的 "? for shortcuts"）或对话框
     * （visibleBlocker，如 trust / permission 提示）。此时 TUI 已经画出交互界面，
     * 初始化结束。
     *
     * 不看 fallback 的 idle：进程刚拉起时屏幕往往是空白/半帧，manifest 无规则命中
     * 也会回落 idle，用它关窗会让整段初始化失去保护。
     *
     * 对话框也要关窗：否则用户答完 trust 提示后，后续的加载层会被一直压住，
     * 状态停在 blocked 上（看起来还需要操作，实际上什么都不用做）。
     */
    if (!processExited && (visibleIdle || visibleBlocker)) {
      this.agentStartupPending = false;
    }
    if (processExited) {
      this.agentStartupPending = false;
      if (agent !== null) {
        this.recentAgentProcessExit = { agent, observedAt: now };
      }
    } else if (agent !== null) {
      this.recentAgentProcessExit = null;
    }

    if (processExited) {
      // 进程退出清理：重置 suppressed 报告、标记 stale 会话、清 hook 权威与会话。
      const resetSources: string[] = [];
      const staleSessions: Array<{
        source: string;
        agentLabel: string;
        sessionRef: AgentSessionRef;
      }> = [];
      for (const [source, suppressed] of this.suppressedFullLifecycleHookReports) {
        if (
          parseAgentLabel(suppressed.agentLabel) !== agent ||
          suppressed.reason === 'hook-clear'
        ) {
          continue;
        }
        const exitedSessionRef =
          suppressed.replacementSessionRef ??
          suppressed.pendingReplacementReport?.authority.sessionRef ??
          suppressed.sessionRef;
        if (
          suppressed.sessionRef !== null &&
          exitedSessionRef !== null &&
          !sessionRefEquals(suppressed.sessionRef, exitedSessionRef)
        ) {
          staleSessions.push({
            source,
            agentLabel: suppressed.agentLabel,
            sessionRef: suppressed.sessionRef,
          });
        }
        suppressed.replacementSessionRef = null;
        suppressed.sessionRef = exitedSessionRef;
        suppressed.pendingReplacementReport = null;
        suppressed.observedAt = now;
        resetSources.push(source);
      }
      for (const s of staleSessions) {
        this.rememberStaleFullLifecycleHookSession(s.source, s.agentLabel, s.sessionRef);
      }
      for (const source of resetSources) {
        this.hookReportSequences.delete(source);
      }

      const hookOfficialSession =
        this.hookAuthority !== null &&
        isOfficialAgentSource(this.hookAuthority.source, this.hookAuthority.agentLabel) &&
        parseAgentLabel(this.hookAuthority.agentLabel) === agent
          ? {
              source: this.hookAuthority.source,
              agentLabel: this.hookAuthority.agentLabel,
              sessionRef: this.hookAuthority.sessionRef,
            }
          : null;
      const persistedOfficialSession =
        this.persistedAgentSession !== null &&
        isOfficialAgentSource(this.persistedAgentSession.source, this.persistedAgentSession.agent) &&
        parseAgentLabel(this.persistedAgentSession.agent) === agent
          ? {
              source: this.persistedAgentSession.source,
              agentLabel: this.persistedAgentSession.agent,
              sessionRef: this.persistedAgentSession.sessionRef,
            }
          : null;
      const officialSession = hookOfficialSession ?? persistedOfficialSession;
      if (officialSession !== null) {
        this.hookReportSequences.delete(officialSession.source);
        this.suppressFullLifecycleHookReportWithSessionRef(
          officialSession.source,
          officialSession.agentLabel,
          officialSession.sessionRef,
          'process-exit',
          now,
        );
      }

      const clearedHookSource =
        this.hookAuthority !== null &&
        parseAgentLabel(this.hookAuthority.agentLabel) === agent &&
        !newerCustomAuthority
          ? this.hookAuthority.source
          : null;
      if (clearedHookSource !== null) {
        this.hookReportSequences.delete(clearedHookSource);
        this.hookAuthority = null;
      }
      if (
        !newerCustomAuthority &&
        this.persistedAgentSession !== null &&
        parseAgentLabel(this.persistedAgentSession.agent) === agent
      ) {
        this.persistedAgentSession = null;
      }
    }

    if (
      this.hookAuthorityNotNewerThan(now) &&
      (this.hookAuthorityConflictsWithDetectedAgent(agent) ||
        (previousDetectedAgent !== null &&
          agent !== previousDetectedAgent &&
          this.hookAuthority !== null &&
          parseAgentLabel(this.hookAuthority.agentLabel) === previousDetectedAgent))
    ) {
      const durableSession =
        this.hookAuthority !== null && this.hookAuthority.sessionRef !== null
          ? {
              source: this.hookAuthority.source,
              agent: this.hookAuthority.agentLabel,
              sessionRef: this.hookAuthority.sessionRef,
            }
          : null;
      this.suppressCurrentFullLifecycleHookAuthority('hook-clear');
      this.hookAuthority = null;
      this.persistedAgentSession = durableSession;
    }

    // 进程退出不等于 agent 消失：只有「退出且已检测不到 agent」才释放名字。
    if (agent === null && this.recentAgentProcessExit !== null) {
      this.clearAgentName();
    }

    const effectiveStateChange = this.recomputeEffectiveState(
      previousAgentLabel,
      previousKnownAgent,
      previousState,
      now,
    );
    if (fallbackState === 'working' && this.state === 'working') {
      this.agentProcessAcquisitionPending = false;
    }
    return {
      effectiveStateChange,
      sessionRefChanged: !sessionIdentityEqual(
        previousSession,
        this.currentSessionIdentityForPersistence(),
      ),
      agentReleased,
    };
  }

  /** 对应 herdr `set_hook_authority_at`。 */
  setHookAuthorityAt(
    source: string,
    agentLabel: string,
    state: DetectedState,
    message: string | null,
    sessionRef: AgentSessionRef | null,
    seq: number | null,
    now: number,
  ): TerminalStateMutation | null {
    if (sessionIdentityOnlyIntegration(source, agentLabel)) {
      return null;
    }
    if (
      !fullLifecycleHookAuthority(source, agentLabel) &&
      this.recentAgentProcessExit !== null &&
      parseAgentLabel(agentLabel) === this.recentAgentProcessExit.agent
    ) {
      return null;
    }
    const route = this.routeFullLifecycleHookReport(
      source,
      agentLabel,
      state,
      message,
      sessionRef,
      seq,
      now,
    );
    if (!route.accept) {
      return null;
    }
    const reanchorSequence = route.reanchorSequence;

    if (this.knownAgentLabelConflictsWithDetectedAgent(agentLabel)) {
      return null;
    }
    if (
      source === 'herdr:codex' &&
      agentLabel === 'codex' &&
      sessionRef !== null &&
      this.currentSessionIdentityForPersistence() !== null &&
      (this.currentSessionIdentityForPersistence()!.kind !== sessionRef.kind ||
        this.currentSessionIdentityForPersistence()!.value !== sessionRef.value)
    ) {
      return null;
    }

    const ownerConflicts = this.currentSessionOwnerConflicts(source, agentLabel);
    const foregroundTakeoverAllowed =
      ownerConflicts &&
      this.foregroundAgentConfirmsHookAuthorityTakeover(source, agentLabel, sessionRef);
    if (ownerConflicts && !foregroundTakeoverAllowed) {
      return null;
    }

    let resolvedSessionRef = sessionRef;
    if (resolvedSessionRef !== null) {
      if (!this.lifecycleHookReportReplacesPersistedSession(source, agentLabel, resolvedSessionRef)) {
        resolvedSessionRef =
          this.conflictingSameOwnerSessionRef(source, agentLabel, resolvedSessionRef, null) ??
          resolvedSessionRef;
      }
    }
    if (this.liveFullLifecycleHookAuthorityConflictsWithSession(source, agentLabel, resolvedSessionRef)) {
      return null;
    }
    if (reanchorSequence) {
      this.hookReportSequences.delete(source);
    }
    if (!this.acceptHookReport(source, seq)) {
      return null;
    }

    const previousAgentLabel = this.effectiveAgentLabel();
    const previousKnownAgent = this.effectiveKnownAgent();
    const previousState = this.state;
    const previousSession = this.currentSessionIdentityForPersistence();

    this.reconcileAgentNameOwner(agentLabel, resolvedSessionRef);
    if (foregroundTakeoverAllowed) {
      this.suppressCurrentFullLifecycleHookAuthority('hook-clear');
    }
    if (resolvedSessionRef !== null || reanchorSequence) {
      const suppressed = this.suppressedFullLifecycleHookReports.get(source);
      if (suppressed !== undefined) {
        this.suppressedFullLifecycleHookReports.delete(source);
        if (suppressed.sessionRef !== null) {
          this.rememberStaleFullLifecycleHookSession(source, suppressed.agentLabel, suppressed.sessionRef);
        }
      }
    }
    this.persistedAgentSession = null;
    this.hookAuthority = {
      source,
      agentLabel,
      state,
      message,
      reportedAt: now,
      sessionRef: resolvedSessionRef,
    };

    const currentSession = this.currentSessionIdentityForPersistence();
    const effectiveStateChange = this.recomputeEffectiveState(
      previousAgentLabel,
      previousKnownAgent,
      previousState,
      now,
    );
    if (state === 'working' && this.state === 'working') {
      this.agentProcessAcquisitionPending = false;
    }
    /*
     * hook 报来非 working → 这条上报本身就是「CLI 已经在真实交互」的证据
     * （antigravity 的 Stop + fullyIdle 只在一轮真正结束后发出），关闭启动窗口。
     *
     * working 不关窗：启动期的 PreInvocation 也会报 working（初始化调用），
     * 见 agentStartupInProgress。
     */
    if (state !== 'working') {
      this.agentStartupPending = false;
    }
    return {
      effectiveStateChange,
      sessionRefChanged: !sessionIdentityEqual(previousSession, currentSession),
      agentReleased: false,
    };
  }

  /** 对应 herdr `set_persisted_agent_session`。 */
  setPersistedAgentSession(session: PersistedAgentSession): void {
    this.persistedAgentSession = session;
  }

  /** 对应 herdr `set_managed_agent_launch_session`。 */
  setManagedAgentLaunchSession(session: PersistedAgentSession): void {
    this.persistedAgentSession = session;
    this.managedAgentLaunchSession = session;
  }

  /** 对应 herdr `set_agent_session_ref`。 */
  setAgentSessionRef(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
    seq: number | null,
    now: number,
  ): TerminalStateMutation | null {
    return this.setAgentSessionRefForSessionStart(source, agentLabel, sessionRef, seq, null, now);
  }

  /** 对应 herdr `set_agent_session_ref_for_session_start`。 */
  setAgentSessionRefForSessionStart(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
    seq: number | null,
    sessionStartSource: string | null,
    now: number,
  ): TerminalStateMutation | null {
    if (sessionRef === null) {
      return null;
    }
    const normalizedStartSource = normalizeSessionStartSource(sessionStartSource);
    const knownAgent = parseAgentLabel(agentLabel);
    const processPresent =
      knownAgent !== null &&
      this.detectedAgent === knownAgent &&
      this.recentAgentProcessExit === null;
    const fullLifecycleSource = fullLifecycleHookAuthority(source, agentLabel);
    const generationGated = (() => {
      const suppressed = this.suppressedFullLifecycleHookReports.get(source);
      return (
        suppressed !== undefined &&
        suppressed.agentLabel === agentLabel &&
        suppressed.reason !== 'hook-clear'
      );
    })();
    const sessionAnchored =
      (this.hookAuthority !== null &&
        this.hookAuthority.source === source &&
        this.hookAuthority.agentLabel === agentLabel &&
        this.hookAuthority.sessionRef !== null) ||
      this.persistedAgentSessionMatches(source, agentLabel);
    const unsequencedSelection = TerminalState.isUnsequencedOpencodeSelection(
      source,
      agentLabel,
      normalizedStartSource,
      seq,
    );
    const selectionCanReconcile = unsequencedSelection && processPresent;

    if (selectionCanReconcile) {
      this.suppressedFullLifecycleHookReports.delete(source);
    } else if (fullLifecycleSource && unsequencedSelection) {
      const previousSessionRef =
        (this.hookAuthority !== null &&
        this.hookAuthority.source === source &&
        this.hookAuthority.agentLabel === agentLabel
          ? this.hookAuthority.sessionRef
          : null) ??
        (this.persistedAgentSession !== null &&
        this.persistedAgentSession.source === source &&
        this.persistedAgentSession.agent === agentLabel
          ? this.persistedAgentSession.sessionRef
          : null);
      let suppressed = this.suppressedFullLifecycleHookReports.get(source);
      if (suppressed === undefined) {
        suppressed = {
          agentLabel,
          sessionRef: previousSessionRef,
          observedAt: now,
          reason: 'process-exit',
          replacementSessionRef: null,
          pendingReplacementReport: null,
        };
        this.suppressedFullLifecycleHookReports.set(source, suppressed);
      }
      suppressed.replacementSessionRef = sessionRef;
      suppressed.pendingReplacementReport = null;
      return null;
    }

    if (
      fullLifecycleSource &&
      !selectionCanReconcile &&
      (!processPresent || generationGated || !sessionAnchored)
    ) {
      if (!TerminalState.sessionStartSourceIsRecognized(normalizedStartSource)) {
        return null;
      }
      if (seq === null) {
        return null;
      }
      const lastSeq = this.hookReportSequences.get(source);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return null;
      }

      const previousAgentLabel = this.effectiveAgentLabel();
      const previousKnownAgent = this.effectiveKnownAgent();
      const previousState = this.state;
      const previousSession = this.currentSessionIdentityForPersistence();

      let suppressed = this.suppressedFullLifecycleHookReports.get(source);
      if (suppressed === undefined) {
        suppressed = {
          agentLabel,
          sessionRef: null,
          observedAt: now,
          reason: 'process-exit',
          replacementSessionRef: null,
          pendingReplacementReport: null,
        };
        this.suppressedFullLifecycleHookReports.set(source, suppressed);
      }
      if (!sessionRefEquals(suppressed.replacementSessionRef, sessionRef)) {
        if (
          suppressed.pendingReplacementReport !== null &&
          !sessionRefEquals(
            suppressed.pendingReplacementReport.authority.sessionRef,
            sessionRef,
          )
        ) {
          suppressed.pendingReplacementReport = null;
        }
        suppressed.replacementSessionRef = sessionRef;
      }
      this.hookReportSequences.set(source, seq);

      if (processPresent) {
        this.clearFullLifecycleHookSuppressionForDetectedAgent(null, knownAgent);
        const currentSession = this.currentSessionIdentityForPersistence();
        return {
          effectiveStateChange: this.recomputeEffectiveState(
            previousAgentLabel,
            previousKnownAgent,
            previousState,
            now,
          ),
          sessionRefChanged: !sessionIdentityEqual(previousSession, currentSession),
          agentReleased: false,
        };
      }
      return null;
    }

    /*
     * 窄口径放行：带**可识别 source** 的会话上报，如果它确实在切换会话
     * （和当前生效的引用不同），就不让 seq 水位把它挡掉。
     *
     * 背景：`hook_report_is_newer(source, null)` 在「已有带 seq 的上报记下水位」之后
     * 恒为 false，于是脚本不带 seq 的会话上报会被整条丢弃。会话上报的脚本普遍不写
     * seq（跨平台的毫秒时间戳不好拿），而同一个 agent 的状态上报由主进程补了 seq，
     * 于是只要跑过一轮，之后的 SessionStart 就再也不生效——用户 /clear、/resume、
     * --fork-session 之后 pane 还钉在旧会话上，重启会续回错的对话。
     *
     * 只对「明确的会话切换」放行：source 必须是 startup/clear/resume/compact/new/
     * fork/select 之一，且新引用确实不同。普通的重复上报仍受水位约束。
     *
     * 只放行**非全生命周期**来源（claude、codex 这类）：全生命周期集成（mastracode、
     * kimi、opencode、pi、omp、kilo）的会话锚定另有机制（stale 会话列表、抑制表），
     * 在这里插入「按内容而非时序」的放行会把新会话推进 stale 列表，反而让它的
     * working/idle 上报被整段丢掉，风险大于收益。
     * 注意 opencode 的 select 走上面 unsequencedSelection 那条专门分支，不受影响。
     *
     * 这条放行**不推进水位**（与 unsequencedSelection 一致）：水位只由真正带 seq 的
     * 上报推进。否则会给该来源记下一个「现在」量级的大水位，把它后续那些带小序号
     * （opencode 的 TUI 发 5、6 这种）的状态上报全挡掉（实测：working/idle 全丢）。
     */
    const switchesSession =
      seq === null &&
      !fullLifecycleHookAuthority(source, agentLabel) &&
      TerminalState.sessionStartSourceIsRecognized(normalizedStartSource) &&
      this.sessionRefDiffersFromCurrent(source, agentLabel, sessionRef);
    if (!unsequencedSelection && !switchesSession && !this.acceptHookReport(source, seq)) {
      return null;
    }
    if (this.knownAgentLabelConflictsWithDetectedAgent(agentLabel)) {
      return null;
    }

    const sessionReplacementAllowed = sessionReportAllowsSessionReplacement(
      source,
      agentLabel,
      normalizedStartSource,
    );
    const curSession = this.currentSessionIdentityForPersistence();
    const replacingIdentityOnlySession =
      sessionIdentityOnlyIntegration(source, agentLabel) &&
      sessionReplacementAllowed &&
      curSession !== null &&
      curSession.source === source &&
      curSession.agent === agentLabel &&
      curSession.kind === 'id' &&
      sessionRef.kind === 'id' &&
      curSession.value !== sessionRef.value;
    if (replacingIdentityOnlySession && !processPresent) {
      return null;
    }

    const ownerConflicts = this.currentSessionOwnerConflicts(source, agentLabel);
    const foregroundTakeoverAllowed =
      ownerConflicts &&
      this.foregroundAgentConfirmsDifferentOwnerTakeover(
        source,
        agentLabel,
        sessionRef,
        normalizedStartSource,
      );
    if (ownerConflicts && !foregroundTakeoverAllowed) {
      return null;
    }
    if (this.conflictingSameOwnerSessionRef(source, agentLabel, sessionRef, normalizedStartSource) !== null) {
      return null;
    }
    const replacedHookSession = this.sameOwnerFullLifecycleHookAuthoritySessionRef(
      source,
      agentLabel,
      sessionRef,
    );
    if (replacedHookSession !== null && !sessionReplacementAllowed) {
      return null;
    }

    const previousAgentLabel = this.effectiveAgentLabel();
    const previousKnownAgent = this.effectiveKnownAgent();
    const previousState = this.state;
    const previousSession = this.currentSessionIdentityForPersistence();

    if (
      source === 'herdr:codex' &&
      agentLabel === 'codex' &&
      sessionReplacementAllowed &&
      this.hookAuthority !== null &&
      this.hookAuthority.source === source &&
      this.hookAuthority.agentLabel === agentLabel &&
      !sessionRefEquals(this.hookAuthority.sessionRef, sessionRef)
    ) {
      this.hookAuthority = null;
    }
    if (sessionReplacementAllowed || foregroundTakeoverAllowed) {
      this.forgetStaleFullLifecycleHookSession(source, agentLabel, sessionRef);
    }
    if (replacedHookSession !== null) {
      this.rememberStaleFullLifecycleHookSession(source, agentLabel, replacedHookSession);
      this.hookAuthority = null;
    } else if (foregroundTakeoverAllowed) {
      this.suppressCurrentFullLifecycleHookAuthority('hook-clear');
      this.hookAuthority = null;
    }
    this.reconcileAgentNameOwner(agentLabel, sessionRef);

    const persistedSession: PersistedAgentSession = { source, agent: agentLabel, sessionRef };
    if (
      this.managedAgentLaunchSession !== null &&
      this.managedAgentLaunchSession.source === persistedSession.source &&
      this.managedAgentLaunchSession.agent === persistedSession.agent &&
      this.managedAgentLaunchSession.sessionRef.kind === persistedSession.sessionRef.kind &&
      this.managedAgentLaunchSession.sessionRef.value === persistedSession.sessionRef.value
    ) {
      this.managedAgentLaunchSession = null;
    }
    this.persistedAgentSession = persistedSession;

    const currentSession = this.currentSessionIdentityForPersistence();
    if (previousSession !== null && !sessionIdentityEqual(previousSession, currentSession)) {
      this.agentProcessAcquisitionPending = true;
    }
    return {
      effectiveStateChange: this.recomputeEffectiveState(
        previousAgentLabel,
        previousKnownAgent,
        previousState,
        now,
      ),
      sessionRefChanged: !sessionIdentityEqual(previousSession, currentSession),
      agentReleased: false,
    };
  }

  /** 对应 herdr `clear_hook_authority_with_mutation`。 */
  clearHookAuthorityWithMutation(
    source: string | null,
    seq: number | null,
    now: number,
  ): TerminalStateMutation | null {
    const sequenceSource = source ?? this.hookAuthority?.source ?? null;
    const shouldClear =
      this.hookAuthority !== null &&
      (source === null || this.hookAuthority.source === source);
    if (!shouldClear) {
      return null;
    }
    if (sequenceSource !== null && !this.acceptHookReport(sequenceSource, seq)) {
      return null;
    }

    const previousAgentLabel = this.effectiveAgentLabel();
    const previousKnownAgent = this.effectiveKnownAgent();
    const previousState = this.state;
    const previousSession = this.currentSessionIdentityForPersistence();

    this.suppressCurrentFullLifecycleHookAuthority('hook-clear');
    this.hookAuthority = null;
    this.persistedAgentSession = null;

    return {
      effectiveStateChange: this.recomputeEffectiveState(
        previousAgentLabel,
        previousKnownAgent,
        previousState,
        now,
      ),
      sessionRefChanged: previousSession !== null,
      agentReleased: false,
    };
  }

  /** 对应 herdr `release_agent_with_mutation`。 */
  releaseAgentWithMutation(
    source: string,
    agentLabel: string,
    seq: number | null,
    now: number,
  ): TerminalStateMutation | null {
    if (
      this.hookAuthority !== null &&
      (this.hookAuthority.agentLabel !== agentLabel || this.hookAuthority.source !== source)
    ) {
      return null;
    }
    const matchesCurrentAgent = this.effectiveAgentLabel() === agentLabel;
    const matchesPersistedSession = this.persistedAgentSessionMatches(source, agentLabel);
    if (!matchesCurrentAgent && !matchesPersistedSession) {
      return null;
    }
    if (!this.acceptHookReport(source, seq)) {
      return null;
    }

    const preserveForeignPersistedSession =
      this.persistedAgentSession !== null &&
      (this.persistedAgentSession.source !== source ||
        this.persistedAgentSession.agent !== agentLabel);
    const processOwnsAgent = (() => {
      const agent = parseAgentLabel(agentLabel);
      return (
        agent !== null &&
        this.detectedAgent === agent &&
        this.recentAgentProcessExit === null
      );
    })();

    const previousAgentLabel = this.effectiveAgentLabel();
    const previousKnownAgent = this.effectiveKnownAgent();
    const previousState = this.state;
    const previousSession = this.currentSessionIdentityForPersistence();

    this.suppressFullLifecycleHookReport(source, agentLabel, 'hook-clear');
    if (!processOwnsAgent) {
      this.detectedAgent = null;
      this.fallbackState = 'unknown';
      this.fallbackVisibleBlocker = false;
      this.clearAgentName();
    }
    this.hookAuthority = null;
    if (!preserveForeignPersistedSession) {
      this.persistedAgentSession = null;
    }

    const currentSession = this.currentSessionIdentityForPersistence();
    return {
      effectiveStateChange: this.recomputeEffectiveState(
        previousAgentLabel,
        previousKnownAgent,
        previousState,
        now,
      ),
      sessionRefChanged: !sessionIdentityEqual(previousSession, currentSession),
      agentReleased: !processOwnsAgent,
    };
  }

  /** 对应 herdr `self_reported_agent_active`。 */
  selfReportedAgentActive(): boolean {
    return this.hookAuthority !== null && parseAgentLabel(this.hookAuthority.agentLabel) === null;
  }

  /** 对应 herdr `clear_self_reported_agent`。 */
  clearSelfReportedAgent(observedAt: number, now: number): TerminalStateMutation | null {
    if (!this.selfReportedAgentActive() || !this.hookAuthorityNotNewerThan(observedAt)) {
      return null;
    }
    const previousAgentLabel = this.effectiveAgentLabel();
    const previousKnownAgent = this.effectiveKnownAgent();
    const previousState = this.state;
    const previousSession = this.currentSessionIdentityForPersistence();

    this.hookAuthority = null;
    this.detectedAgent = null;
    this.fallbackState = 'unknown';
    this.fallbackVisibleBlocker = false;
    this.clearAgentName();

    const currentSession = this.currentSessionIdentityForPersistence();
    return {
      effectiveStateChange: this.recomputeEffectiveState(
        previousAgentLabel,
        previousKnownAgent,
        previousState,
        now,
      ),
      sessionRefChanged: !sessionIdentityEqual(previousSession, currentSession),
      agentReleased: true,
    };
  }

  /** 对应 herdr `session_ref_is_current`。 */
  sessionRefIsCurrent(sessionRef: AgentSessionRef): boolean {
    const cur = this.currentSessionIdentityForPersistence();
    return cur !== null && cur.kind === sessionRef.kind && cur.value === sessionRef.value;
  }

  /**
   * 当前用于持久化的会话引用（公开对应 herdr `current_session_identity_for_persistence`）。
   *
   * 投影层据此生成 pane.agentSession（hook 权威的 sessionRef 优先，否则取 persisted）。
   */
  currentSessionForPersistence(): SessionIdentity | null {
    return this.currentSessionIdentityForPersistence();
  }

  /** 对应 herdr `hook_report_is_newer`。 */
  hookReportIsNewer(source: string, seq: number | null): boolean {
    const last = this.hookReportSequences.get(source);
    if (seq !== null) {
      return last === undefined || seq > last;
    }
    return last === undefined;
  }

  /**
   * 给一条上报补一个严格递增的 seq（调用方拿不到可移植时间戳时使用）。
   *
   * 不能用裸 `Date.now()`：同一毫秒内的两条上报会取到相同值，后一条被
   * `hook_report_is_newer` 丢掉——若丢的是 Stop 的 idle，完成提示音就再也不会响。
   *
   * 因此取 `max(now, 本 pane 水位最大值 + 1)`：严格单调，且不落后于墙上时间。
   * 水位是 per-pane、跨来源的单调计数器，所以这里扫的是该 pane 内所有来源的水位。
   * 本方法只读水位、不写入——真正写水位仍在 acceptHookReport 里。
   *
   * 只用于**状态**上报（router 的状态分支）。会话上报分支刻意不补 seq：opencode 的
   * select 依赖 `seq === null` 走「未排序选择」分支；而脚本不带 seq 的会话上报被水位
   * 挡住的问题，由 setAgentSessionRefForSessionStart 的 switchesSession 窄口径放行解决。
   */
  nextHookReportSeq(now: number = Date.now()): number {
    let max = now;
    for (const last of this.hookReportSequences.values()) {
      if (last >= max) max = last + 1;
    }
    return max;
  }

  /** 对应 herdr `effective_agent_label`。 */
  effectiveAgentLabel(): string | null {
    if (this.hookAuthority !== null && this.hookAuthorityIsEffective(this.hookAuthority)) {
      return this.hookAuthority.agentLabel;
    }
    if (this.recentAgentProcessExit === null) {
      return this.detectedAgent;
    }
    return null;
  }

  /** 对应 herdr `effective_known_agent`。 */
  effectiveKnownAgent(): string | null {
    const label = this.effectiveAgentLabel();
    return label !== null ? parseAgentLabel(label) : null;
  }

  /** 对应 herdr `unchanged_effective_state_change_at`（省略 presentation）。 */
  unchangedEffectiveStateChangeAt(_now: number): EffectiveStateChange {
    const agentLabel = this.effectiveAgentLabel();
    const knownAgent = this.effectiveKnownAgent();
    const state = this.state;
    return {
      previousAgentLabel: agentLabel,
      previousKnownAgent: knownAgent,
      previousState: state,
      agentLabel,
      knownAgent,
      state,
    };
  }

  /** 对应 herdr `full_lifecycle_hook_authority_active`。 */
  fullLifecycleHookAuthorityActive(): boolean {
    return this.liveFullLifecycleHookAuthority();
  }

  /**
   * 该 pane 是否有生效中的 hook 状态权威（不要求是全生命周期集成）。
   *
   * 目前用于：一旦某个 agent 会通过 hook 上报状态，就不再让**屏幕**决定「完成」。
   * 否则「初始化完成 / 工具跑完」这类 working→idle 会各自响一次完成提示音
   * （屏幕分不清它们和真正的会话结束）。完成只由 hook 的 idle 上报驱动。
   */
  hookStateAuthorityActive(): boolean {
    return this.hookAuthority !== null && this.hookAuthorityIsEffective(this.hookAuthority);
  }

  /** 对应 herdr `set_agent_name`。 */
  setAgentName(name: string): void {
    this.agentName = name.length > 0 ? name : null;
    if (this.agentName === null) {
      this.agentNameOwner = null;
      return;
    }
    const effectiveLabel = this.effectiveAgentLabel();
    this.agentNameOwner =
      (this.hookAuthority !== null
        ? { agentLabel: this.hookAuthority.agentLabel, sessionRef: this.hookAuthority.sessionRef }
        : null) ??
      (this.persistedAgentSession !== null
        ? {
            agentLabel: this.persistedAgentSession.agent,
            sessionRef: this.persistedAgentSession.sessionRef,
          }
        : null) ??
      (effectiveLabel !== null ? { agentLabel: effectiveLabel, sessionRef: null } : null);
  }

  /** 对应 herdr `begin_managed_agent`。 */
  beginManagedAgent(
    name: string,
    kind: string,
    now: number,
    settleDelay: number,
    timeout: number,
  ): void {
    this.codexPromptReady = false;
    this.setAgentName(name);
    this.agentProcessAcquisitionPending = true;
    this.agentNameOwner = { agentLabel: kind, sessionRef: null };
    this.managedAgent = {
      kind,
      phase: {
        kind: 'pending',
        readyAfter: now + settleDelay,
        deadline: now + timeout,
        observedExpected: false,
      },
    };
  }

  /** 对应 herdr `managed_agent_launch_pending`。 */
  managedAgentLaunchPending(): boolean {
    return (
      this.managedAgent !== null &&
      (this.managedAgent.phase.kind === 'pending' || this.managedAgent.phase.kind === 'blocked')
    );
  }

  /** 对应 herdr `managed_agent_interactive_ready`。 */
  managedAgentInteractiveReady(): boolean {
    return this.managedAgent !== null && this.managedAgent.phase.kind === 'active';
  }

  /** 对应 herdr `observe_codex_prompt_ready`。 */
  observeCodexPromptReady(ready: boolean): TerminalStateMutation | null {
    const managed = this.managedAgent;
    if (
      this.detectedAgent !== 'codex' ||
      this.recentAgentProcessExit !== null ||
      !(managed !== null && managed.kind === 'codex' && managed.phase.kind !== 'active') ||
      this.codexPromptReady === ready
    ) {
      return null;
    }
    this.codexPromptReady = ready;
    return { effectiveStateChange: null, sessionRefChanged: false, agentReleased: false };
  }

  /** 对应 herdr `managed_agent_kind`。 */
  managedAgentKind(): string | null {
    return this.managedAgent?.kind ?? null;
  }

  /** 对应 herdr `next_managed_agent_deadline`。 */
  nextManagedAgentDeadline(): number | null {
    const managed = this.managedAgent;
    if (managed === null || managed.phase.kind !== 'pending') {
      return null;
    }
    const { readyAfter, deadline } = managed.phase;
    return Math.min(readyAfter ?? deadline, deadline);
  }

  /** 对应 herdr `reconcile_managed_agent_at`。 */
  reconcileManagedAgentAt(now: number, processExited: boolean): boolean {
    const managed = this.managedAgent;
    if (managed === null) {
      return false;
    }
    const knownAgent = this.effectiveKnownAgent();
    const observedExpected =
      managed.phase.kind === 'pending'
        ? managed.phase.observedExpected || knownAgent === managed.kind
        : false;

    const clear =
      processExited ||
      (knownAgent !== null && knownAgent !== managed.kind) ||
      (managed.phase.kind === 'pending' && observedExpected && knownAgent === null);
    if (clear) {
      this.clearAgentName();
      return true;
    }

    if (managed.phase.kind === 'blocked') {
      if (
        knownAgent === managed.kind &&
        (this.state === 'idle' ||
          (managed.kind === 'codex' && this.state === 'unknown' && this.codexPromptReady))
      ) {
        this.managedAgent = { kind: managed.kind, phase: { kind: 'active' } };
        this.managedAgentLaunchSession = null;
        return true;
      }
      return false;
    }

    if (managed.phase.kind === 'pending') {
      const { readyAfter, deadline, observedExpected: previousObservedExpected } = managed.phase;
      if (knownAgent === managed.kind && this.state === 'blocked') {
        this.managedAgent = { kind: managed.kind, phase: { kind: 'blocked' } };
        return true;
      }
      if (now >= deadline) {
        this.clearAgentName();
        return true;
      }
      if (readyAfter === null || now >= readyAfter) {
        if (
          knownAgent === managed.kind &&
          (this.state === 'idle' ||
            (managed.kind === 'codex' && this.state === 'unknown' && this.codexPromptReady))
        ) {
          this.managedAgent = { kind: managed.kind, phase: { kind: 'active' } };
          this.managedAgentLaunchSession = null;
          return true;
        }
        if (readyAfter !== null) {
          this.managedAgent = {
            kind: managed.kind,
            phase: { kind: 'pending', readyAfter: null, deadline, observedExpected },
          };
          return true;
        }
      }
      if (observedExpected !== previousObservedExpected) {
        this.managedAgent = {
          kind: managed.kind,
          phase: { kind: 'pending', readyAfter, deadline, observedExpected },
        };
        return true;
      }
    }
    return false;
  }

  /** 对应 herdr `restore_managed_agent`。 */
  restoreManagedAgent(name: string, kind: string): void {
    this.setAgentName(name);
    this.agentNameOwner = { agentLabel: kind, sessionRef: null };
    this.managedAgent = { kind, phase: { kind: 'active' } };
  }

  /** 对应 herdr `clear_agent_name`。 */
  clearAgentName(): void {
    this.codexPromptReady = false;
    const launchSession = this.managedAgentLaunchSession;
    this.managedAgentLaunchSession = null;
    if (
      launchSession !== null &&
      this.persistedAgentSession !== null &&
      this.persistedAgentSession.source === launchSession.source &&
      this.persistedAgentSession.agent === launchSession.agent &&
      this.persistedAgentSession.sessionRef.kind === launchSession.sessionRef.kind &&
      this.persistedAgentSession.sessionRef.value === launchSession.sessionRef.value
    ) {
      this.persistedAgentSession = null;
    }
    this.agentName = null;
    this.agentNameOwner = null;
    this.managedAgent = null;
  }

  /** 对应 herdr `clear_agent_runtime_identity_after_respawn`。 */
  clearAgentRuntimeIdentityAfterRespawn(): void {
    this.detectedAgent = null;
    this.fallbackState = 'unknown';
    this.fallbackVisibleBlocker = false;
    this.hookAuthority = null;
    this.persistedAgentSession = null;
    this.suppressedFullLifecycleHookReports.clear();
    this.staleFullLifecycleHookSessions.clear();
    this.state = 'unknown';
    this.lastAgentStateChangeSeq = null;
    this.lastAgentCompletionSeq = null;
    this.recentAgentProcessExit = null;
    this.agentProcessAcquisitionPending = false;
    this.agentStartupPending = false;
    this.agentStartupSince = 0;
    this.clearAgentName();
  }

  /** 对应 herdr `is_agent_terminal`。 */
  isAgentTerminal(): boolean {
    return this.agentName !== null || this.effectiveAgentLabel() !== null;
  }

  // -------------------------------------------------------------------------
  // 私有仲裁辅助（全部对应 herdr terminal/state.rs 同名私有方法）
  // -------------------------------------------------------------------------

  private hookAuthorityNotNewerThan(observedAt: number): boolean {
    return this.hookAuthority === null || this.hookAuthority.reportedAt <= observedAt;
  }

  /*
   * 注：herdr 还有 fallback_not_older_than_hook() + fallback_observed_at（要求屏幕观测
   * 新于 hook 上报才允许 blocker 覆盖）。我们刻意没有实现——herdr 的 antigravity 是
   * session-identity-only 集成、从不报状态，那条判据在它那里不会被行使；而我们的
   * antigravity 会稀疏上报状态，一旦 hook 比屏幕新就把状态钉死在 working，权限提示
   * 弹出后 TUI 不再刷新，blocked 永远出不来（实测：阻塞时完全没有提示音）。
   * 详见 visibleBlockerOverridesHook()。
   */

  private hookAuthorityConflictsWithDetectedAgent(detectedAgent: string | null): boolean {
    if (detectedAgent === null || this.hookAuthority === null) {
      return false;
    }
    const hookAgent = parseAgentLabel(this.hookAuthority.agentLabel);
    return hookAgent !== null && hookAgent !== detectedAgent;
  }

  private shouldIgnoreDetectedStateUnderFullLifecycleHook(
    detectedAgent: string | null,
    processExited: boolean,
  ): boolean {
    return (
      this.liveFullLifecycleHookAuthority() &&
      !processExited &&
      !this.hookAuthorityConflictsWithDetectedAgent(detectedAgent)
    );
  }

  private persistedAgentSessionMatches(source: string, agent: string): boolean {
    const s = this.persistedAgentSession;
    return s !== null && s.source === source && s.agent === agent;
  }

  private suppressCurrentFullLifecycleHookAuthority(
    reason: FullLifecycleHookSuppressionReason,
  ): void {
    const authority = this.hookAuthority;
    if (authority !== null && fullLifecycleHookAuthority(authority.source, authority.agentLabel)) {
      this.suppressFullLifecycleHookReportWithSessionRef(
        authority.source,
        authority.agentLabel,
        authority.sessionRef,
        reason,
        Date.now(),
      );
    }
  }

  private suppressFullLifecycleHookReport(
    source: string,
    agentLabel: string,
    reason: FullLifecycleHookSuppressionReason,
  ): void {
    if (fullLifecycleHookAuthority(source, agentLabel)) {
      this.suppressFullLifecycleHookReportWithSessionRef(
        source,
        agentLabel,
        this.hookAuthority?.sessionRef ?? null,
        reason,
        Date.now(),
      );
    }
  }

  private suppressFullLifecycleHookReportWithSessionRef(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
    reason: FullLifecycleHookSuppressionReason,
    observedAt: number,
  ): void {
    this.suppressedFullLifecycleHookReports.set(source, {
      agentLabel,
      sessionRef,
      observedAt,
      reason,
      replacementSessionRef: null,
      pendingReplacementReport: null,
    });
  }

  private routeFullLifecycleHookReport(
    source: string,
    agentLabel: string,
    state: DetectedState,
    message: string | null,
    sessionRef: AgentSessionRef | null,
    seq: number | null,
    reportedAt: number,
  ): FullLifecycleHookReportRoute {
    if (!fullLifecycleHookAuthority(source, agentLabel)) {
      return { accept: true, reanchorSequence: false };
    }
    if (this.fullLifecycleHookReportMatchesStaleSession(source, agentLabel, sessionRef)) {
      return { accept: false };
    }

    const knownAgent = parseAgentLabel(agentLabel);
    const processPresent =
      knownAgent !== null &&
      this.detectedAgent === knownAgent &&
      this.recentAgentProcessExit === null;
    const anchoredSessionRef =
      (this.hookAuthority !== null &&
      this.hookAuthority.source === source &&
      this.hookAuthority.agentLabel === agentLabel
        ? this.hookAuthority.sessionRef
        : null) ??
      (this.persistedAgentSession !== null &&
      this.persistedAgentSession.source === source &&
      this.persistedAgentSession.agent === agentLabel
        ? this.persistedAgentSession.sessionRef
        : null);
    const sessionAnchored =
      anchoredSessionRef !== null &&
      (sessionRef === null || sessionRefEquals(sessionRef, anchoredSessionRef));
    const opencodeCrossTalk =
      source === 'herdr:opencode' &&
      agentLabel === 'opencode' &&
      processPresent &&
      anchoredSessionRef !== null &&
      sessionRef !== null &&
      !sessionRefEquals(anchoredSessionRef, sessionRef);
    if (opencodeCrossTalk) {
      return { accept: false };
    }

    const suppressed = this.suppressedFullLifecycleHookReports.get(source);
    if (suppressed !== undefined) {
      if (suppressed.agentLabel !== agentLabel) {
        return { accept: false };
      }
      if (suppressed.reason === 'hook-clear') {
        const reanchorSequence =
          suppressed.sessionRef !== null &&
          sessionRef !== null &&
          !sessionRefEquals(suppressed.sessionRef, sessionRef);
        return reanchorSequence
          ? { accept: true, reanchorSequence: true }
          : { accept: false };
      }
    }

    if (processPresent && sessionAnchored && !this.suppressedFullLifecycleHookReports.has(source)) {
      return {
        accept: true,
        reanchorSequence: this.fullLifecycleHookReportHasFreshSessionAfterStaleSession(
          source,
          agentLabel,
          sessionRef,
        ),
      };
    }

    if (sessionRef === null) {
      return { accept: false };
    }
    if (seq === null) {
      return { accept: false };
    }
    const lastSeq = this.hookReportSequences.get(source);
    if (lastSeq !== undefined && seq <= lastSeq) {
      return { accept: false };
    }

    const previousSessionRef =
      this.persistedAgentSession !== null &&
      this.persistedAgentSession.source === source &&
      this.persistedAgentSession.agent === agentLabel
        ? this.persistedAgentSession.sessionRef
        : null;
    let suppressedEntry = this.suppressedFullLifecycleHookReports.get(source);
    if (suppressedEntry === undefined) {
      suppressedEntry = {
        agentLabel,
        sessionRef: previousSessionRef,
        observedAt: reportedAt,
        reason: 'process-exit',
        replacementSessionRef: null,
        pendingReplacementReport: null,
      };
      this.suppressedFullLifecycleHookReports.set(source, suppressedEntry);
    }
    const replacePending =
      suppressedEntry.pendingReplacementReport === null ||
      seq > suppressedEntry.pendingReplacementReport.seq;
    if (replacePending) {
      suppressedEntry.pendingReplacementReport = {
        authority: { source, agentLabel, state, message, reportedAt, sessionRef },
        seq,
      };
    }
    return { accept: false };
  }

  private fullLifecycleHookReportMatchesStaleSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
  ): boolean {
    if (!fullLifecycleHookAuthority(source, agentLabel)) {
      return false;
    }
    const list = this.staleFullLifecycleHookSessions.get(source);
    if (list === undefined || sessionRef === null) {
      return false;
    }
    return list.some(
      (stale) => stale.agentLabel === agentLabel && sessionRefEquals(sessionRef, stale.sessionRef),
    );
  }

  private fullLifecycleHookReportHasFreshSessionAfterStaleSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
  ): boolean {
    if (!fullLifecycleHookAuthority(source, agentLabel)) {
      return false;
    }
    const list = this.staleFullLifecycleHookSessions.get(source);
    if (list === undefined || sessionRef === null) {
      return false;
    }
    return (
      list.some((stale) => stale.agentLabel === agentLabel) &&
      list.every(
        (stale) => stale.agentLabel !== agentLabel || !sessionRefEquals(sessionRef, stale.sessionRef),
      )
    );
  }

  private liveFullLifecycleHookAuthorityConflictsWithSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
  ): boolean {
    const authority = this.hookAuthority;
    if (authority === null) {
      return false;
    }
    if (!fullLifecycleHookAuthority(authority.source, authority.agentLabel)) {
      return false;
    }
    if (authority.source !== source || authority.agentLabel !== agentLabel) {
      return false;
    }
    return (
      authority.sessionRef !== null &&
      sessionRef !== null &&
      !sessionRefEquals(authority.sessionRef, sessionRef)
    );
  }

  private sameOwnerFullLifecycleHookAuthoritySessionRef(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
  ): AgentSessionRef | null {
    const authority = this.hookAuthority;
    if (authority === null) {
      return null;
    }
    if (
      !fullLifecycleHookAuthority(authority.source, authority.agentLabel) ||
      authority.source !== source ||
      authority.agentLabel !== agentLabel
    ) {
      return null;
    }
    return authority.sessionRef !== null && !sessionRefEquals(authority.sessionRef, sessionRef)
      ? authority.sessionRef
      : null;
  }

  private clearFullLifecycleHookSuppressionForDetectedAgent(
    previousDetectedAgent: string | null,
    detectedAgent: string | null,
  ): void {
    if (detectedAgent === null || previousDetectedAgent === detectedAgent) {
      return;
    }
    const detectedLabel = detectedAgent;
    const staleSessions: Array<{
      source: string;
      agentLabel: string;
      sessionRef: AgentSessionRef;
    }> = [];
    const validatedReplacementSessions: Array<{
      source: string;
      agentLabel: string;
      sessionRef: AgentSessionRef;
      pending: PendingFullLifecycleHookReport | null;
    }> = [];

    for (const [source, suppressed] of [...this.suppressedFullLifecycleHookReports]) {
      if (parseAgentLabel(suppressed.agentLabel) !== detectedAgent) {
        continue;
      }
      if (suppressed.reason === 'process-exit') {
        if (suppressed.replacementSessionRef !== null) {
          const sessionRef = suppressed.replacementSessionRef;
          suppressed.replacementSessionRef = null;
          if (suppressed.sessionRef !== null && !sessionRefEquals(suppressed.sessionRef, sessionRef)) {
            staleSessions.push({
              source,
              agentLabel: suppressed.agentLabel,
              sessionRef: suppressed.sessionRef,
            });
          }
          const sessionStartSeq = this.hookReportSequences.get(source);
          const pendingReport = suppressed.pendingReplacementReport;
          const pending =
            pendingReport !== null &&
            sessionRefEquals(pendingReport.authority.sessionRef, sessionRef) &&
            (sessionStartSeq === undefined || pendingReport.seq > sessionStartSeq)
              ? pendingReport
              : null;
          suppressed.pendingReplacementReport = null;
          validatedReplacementSessions.push({
            source,
            agentLabel: suppressed.agentLabel,
            sessionRef,
            pending,
          });
          this.suppressedFullLifecycleHookReports.delete(source);
        }
        continue;
      }
      // reason === 'hook-clear'
      if (suppressed.sessionRef !== null) {
        staleSessions.push({
          source,
          agentLabel: suppressed.agentLabel,
          sessionRef: suppressed.sessionRef,
        });
      }
      this.suppressedFullLifecycleHookReports.delete(source);
    }

    for (const s of staleSessions) {
      this.rememberStaleFullLifecycleHookSession(s.source, s.agentLabel, s.sessionRef);
    }

    for (const [source] of [...this.hookReportSequences]) {
      const validated = validatedReplacementSessions.some((v) => v.source === source);
      if (!validated && fullLifecycleHookAuthority(source, detectedLabel)) {
        this.hookReportSequences.delete(source);
      }
    }

    for (const v of validatedReplacementSessions) {
      this.forgetStaleFullLifecycleHookSession(v.source, v.agentLabel, v.sessionRef);
      this.reconcileAgentNameOwner(v.agentLabel, v.sessionRef);
      this.persistedAgentSession = {
        source: v.source,
        agent: v.agentLabel,
        sessionRef: v.sessionRef,
      };
      if (v.pending !== null) {
        this.hookReportSequences.set(v.source, v.pending.seq);
        this.hookAuthority = v.pending.authority;
      }
    }
  }

  private rememberStaleFullLifecycleHookSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
  ): void {
    let list = this.staleFullLifecycleHookSessions.get(source);
    if (list === undefined) {
      list = [];
      this.staleFullLifecycleHookSessions.set(source, list);
    }
    if (
      !list.some((e) => e.agentLabel === agentLabel && sessionRefEquals(e.sessionRef, sessionRef))
    ) {
      list.push({ agentLabel, sessionRef });
    }
  }

  private forgetStaleFullLifecycleHookSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
  ): void {
    const list = this.staleFullLifecycleHookSessions.get(source);
    if (list === undefined) {
      return;
    }
    const kept = list.filter(
      (e) => !(e.agentLabel === agentLabel && sessionRefEquals(e.sessionRef, sessionRef)),
    );
    if (kept.length === 0) {
      this.staleFullLifecycleHookSessions.delete(source);
    } else {
      this.staleFullLifecycleHookSessions.set(source, kept);
    }
  }

  private detectedStateObservedBeforeReleaseSuppression(
    detectedAgent: string | null,
    observedAt: number,
  ): boolean {
    if (detectedAgent === null) {
      return false;
    }
    for (const suppressed of this.suppressedFullLifecycleHookReports.values()) {
      if (
        parseAgentLabel(suppressed.agentLabel) === detectedAgent &&
        observedAt <= suppressed.observedAt
      ) {
        return true;
      }
    }
    return false;
  }

  private currentSessionIdentityForPersistence(): SessionIdentity | null {
    if (this.hookAuthority !== null && this.hookAuthority.sessionRef !== null) {
      return {
        source: this.hookAuthority.source,
        agent: this.hookAuthority.agentLabel,
        kind: this.hookAuthority.sessionRef.kind,
        value: this.hookAuthority.sessionRef.value,
      };
    }
    const s = this.persistedAgentSession;
    return s !== null
      ? { source: s.source, agent: s.agent, kind: s.sessionRef.kind, value: s.sessionRef.value }
      : null;
  }

  private currentSessionOwnerConflicts(source: string, agentLabel: string): boolean {
    const cur = this.currentSessionIdentityForPersistence();
    return cur !== null && (cur.source !== source || cur.agent !== agentLabel);
  }

  private conflictingSameOwnerSessionRef(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
    sessionStartSource: string | null,
  ): AgentSessionRef | null {
    const cur = this.currentSessionIdentityForPersistence();
    if (cur === null) {
      return null;
    }
    const conflict =
      cur.source === source &&
      cur.agent === agentLabel &&
      cur.kind === 'id' &&
      sessionRef.kind === 'id' &&
      cur.value !== sessionRef.value &&
      !sessionReportAllowsSessionReplacement(source, agentLabel, sessionStartSource);
    return conflict ? { kind: cur.kind, value: cur.value } : null;
  }

  private lifecycleHookReportReplacesPersistedSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
  ): boolean {
    const s = this.persistedAgentSession;
    return (
      this.hookAuthority === null &&
      source === 'herdr:mastracode' &&
      agentLabel === 'mastracode' &&
      s !== null &&
      s.source === source &&
      s.agent === agentLabel &&
      s.sessionRef.kind === 'id' &&
      sessionRef.kind === 'id' &&
      s.sessionRef.value !== sessionRef.value
    );
  }

  private static sessionStartSourceIsRecognized(sessionStartSource: string | null): boolean {
    return (
      sessionStartSource === 'startup' ||
      sessionStartSource === 'clear' ||
      sessionStartSource === 'resume' ||
      sessionStartSource === 'compact' ||
      sessionStartSource === 'new' ||
      sessionStartSource === 'fork' ||
      sessionStartSource === 'select'
    );
  }

  /**
   * 这条会话上报是否真的在切换会话（和当前生效的引用不同）。
   *
   * 用于区分「用户 /clear、/resume 之后的权威会话切换」和「同一条上报重复投递」：
   * 前者即使不带 seq 也必须放行，后者仍要受水位约束。
   */
  private sessionRefDiffersFromCurrent(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
  ): boolean {
    const cur = this.currentSessionIdentityForPersistence();
    if (cur === null) return true;
    if (cur.source !== source || cur.agent !== agentLabel) return true;
    return cur.kind !== sessionRef.kind || cur.value !== sessionRef.value;
  }

  private static isUnsequencedOpencodeSelection(
    source: string,
    agentLabel: string,
    sessionStartSource: string | null,
    seq: number | null,
  ): boolean {
    return (
      source === 'herdr:opencode' &&
      agentLabel === 'opencode' &&
      sessionStartSource === 'select' &&
      seq === null
    );
  }

  private knownAgentLabelConflictsWithDetectedAgent(agentLabel: string): boolean {
    if (this.detectedAgent === null) {
      return false;
    }
    const hookAgent = parseAgentLabel(agentLabel);
    return hookAgent !== null && hookAgent !== this.detectedAgent;
  }

  private foregroundAgentConfirmsDifferentOwnerTakeover(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
    sessionStartSource: string | null,
  ): boolean {
    return (
      !(source === 'herdr:grok' && agentLabel === 'grok') &&
      TerminalState.sessionStartSourceIsRecognized(sessionStartSource) &&
      this.foregroundAgentConfirmsSessionOwner(source, agentLabel, sessionRef)
    );
  }

  private foregroundAgentConfirmsHookAuthorityTakeover(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
  ): boolean {
    return (
      sessionRef !== null &&
      this.foregroundAgentConfirmsSessionOwner(source, agentLabel, sessionRef)
    );
  }

  private foregroundAgentConfirmsSessionOwner(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
  ): boolean {
    if (this.detectedAgent === null) {
      return false;
    }
    return (
      parseAgentLabel(agentLabel) === this.detectedAgent &&
      canResume(source, agentLabel, sessionRef)
    );
  }

  private acceptHookReport(source: string, seq: number | null): boolean {
    if (!this.hookReportIsNewer(source, seq)) {
      return false;
    }
    if (seq !== null) {
      this.hookReportSequences.set(source, seq);
    }
    return true;
  }

  private hookAuthorityIsEffective(authority: HookAuthority): boolean {
    if (!fullLifecycleHookAuthority(authority.source, authority.agentLabel)) {
      return true;
    }
    const agent = parseAgentLabel(authority.agentLabel);
    return (
      agent === null ||
      (this.detectedAgent === agent && this.recentAgentProcessExit === null)
    );
  }

  private visibleBlockerOverridesHook(): boolean {
    if (this.liveFullLifecycleHookAuthority()) {
      return false;
    }
    /*
     * 偏离上游：这里**不**要求「屏幕观测新于 hook 上报」（herdr 有此判据）。
     *
     * 原因：herdr 把 antigravity 当作 session-identity-only 集成，它永远不报状态，
     * 所以源侧那条判据在 herdr 里根本不会被行使。我们的 antigravity 会上报状态，
     * 而它的上报是稀疏的（PreInvocation / Stop），一旦 hook 的时间戳比屏幕新就会赢，
     * 且权限提示弹出后 TUI 通常不再刷新——没有新的屏幕观测，状态就被**钉死在
     * working**，blocked 永远出不来（实测：阻塞时完全没有提示音）。
     *
     * 因此让 blocker 恒胜：它是每帧重算的具体信号（对话框按键提示、trust 文案），
     * 提示消失后 fallbackVisibleBlocker 自然变 false，hook 状态随之恢复。
     */
    return (
      this.fallbackVisibleBlocker &&
      this.hookAuthority !== null &&
      this.hookAuthority.state !== 'blocked' &&
      parseAgentLabel(this.hookAuthority.agentLabel) === this.detectedAgent
    );
  }

  /**
   * 屏幕当前是否看到「需要人工输入」的 blocker（对应 fallback_visible_blocker）。
   *
   * 供上报边界使用：hook 报 working 时若屏幕上正显示权限/信任对话框，
   * 这条 working 会把 blocked 顶掉，制造 blocked ↔ working 横跳。
   */
  screenVisibleBlocker(): boolean {
    return this.fallbackVisibleBlocker;
  }

  /**
   * 这条上报是不是「工具完成心跳」，而当前已经完成，因此应当丢弃。
   *
   * 背景：claude 的 PostToolUse（每完成一个工具报一次 working）走 async，而 Stop（idle）
   * 是同步的。模型在本轮末尾只回一两句话时，Stop 的 idle 会先落地，随后迟到的心跳
   * 带着更大的 seq 又把状态顶回 working，于是一轮结束之后 pane 又「工作」了 1.6 秒；
   * 更糟的是完成通知要按投递时的状态复核（router 的 tickNotifies），
   * 这段时间正好把提示音判成「证据不成立」丢掉。
   *
   * 心跳的语义只是「还在干活，别让 working 过期」，它没有资格把已完成的 pane
   * 重新拉起来；把 idle → working 的跃迁留给真正的回合起点（UserPromptSubmit）。
   *
   * 注意只在 idle 时拦：working 时心跳照常刷新 TTL，blocked 时也不拦（心跳说明工具
   * 已经跑完，权限框早就点掉了；屏幕上仍有可见 blocker 的情况由 screenVisibleBlocker
   * 那条边界处理）。
   */
  isStaleHeartbeat(state: DetectedState, heartbeat: boolean | null | undefined): boolean {
    return heartbeat === true && state === 'working' && this.state === 'idle';
  }

  private liveFullLifecycleHookAuthority(): boolean {
    return (
      this.hookAuthority !== null &&
      this.hookAuthorityIsEffective(this.hookAuthority) &&
      fullLifecycleHookAuthority(this.hookAuthority.source, this.hookAuthority.agentLabel)
    );
  }

  private reconcileAgentNameOwner(agentLabel: string, sessionRef: AgentSessionRef | null): void {
    if (this.agentName === null) {
      return;
    }
    if (this.managedAgent !== null && parseAgentLabel(agentLabel) === this.managedAgent.kind) {
      return;
    }
    const owner = this.agentNameOwner;
    if (owner !== null) {
      const conflict =
        owner.agentLabel !== agentLabel ||
        (owner.sessionRef !== null &&
          sessionRef !== null &&
          !sessionRefEquals(owner.sessionRef, sessionRef));
      if (conflict) {
        this.agentName = null;
        this.agentNameOwner = null;
        return;
      }
      if (owner.sessionRef === null && sessionRef !== null) {
        owner.sessionRef = sessionRef;
      }
      return;
    }
    this.agentNameOwner = { agentLabel, sessionRef };
  }

  private recomputeEffectiveState(
    previousAgentLabel: string | null,
    previousKnownAgent: string | null,
    previousState: DetectedState,
    now: number,
  ): EffectiveStateChange | null {
    const hookState = this.effectiveHookState(now);
    const state = this.visibleBlockerOverridesHook()
      ? 'blocked'
      : hookState !== null
        ? hookState
        : this.fallbackState;
    const agentLabel = this.effectiveAgentLabel();
    const knownAgent = this.effectiveKnownAgent();

    if (previousAgentLabel === agentLabel && previousState === state) {
      return null;
    }
    this.state = state;
    return {
      previousAgentLabel,
      previousKnownAgent,
      previousState,
      agentLabel,
      knownAgent,
      state,
    };
  }

  /**
   * 生效中的 hook 状态（无则返回 null，由屏幕兜底）。
   *
   * 除 herdr 原有的「生效性」判断外，额外给**非全生命周期来源**的 `working` 加了过期：
   * antigravity 在用户按 Esc 取消时不会回调 `Stop`（CLI 直接中断执行循环，只有正在跑的
   * PreInvocation 进程被杀掉），于是最后一条 `working` 会把状态永久钉住、屏幕再也拿不回。
   * 超过 `HOOK_WORKING_TTL_MS` 未被刷新就视为失效，交还屏幕判定——
   * 真实工作时屏幕一直有 spinner / `esc to cancel`，状态仍是 working（无跳变）；
   * 取消后屏幕回到 idle 页脚，状态随之回落。
   */
  private effectiveHookState(now: number): DetectedState | null {
    const authority = this.hookAuthority;
    if (authority === null || !this.hookAuthorityIsEffective(authority)) return null;
    // 启动窗口内的 working 不参与状态（见 agentStartupInProgress）
    if (authority.state === 'working' && this.agentStartupInProgress(authority.agentLabel, now)) {
      return null;
    }
    /*
     * 只对「屏幕真的观测过」的 pane 套用 TTL。
     *
     * web pane（dsh）没有终端屏幕，fallbackState 恒为 idle；若不设这个前提，
     * 它上报的 working 在间隔超过 TTL 时会被错误地回落到 idle。
     */
    const staleWorking =
      this.screenObserved &&
      authority.state === 'working' &&
      !fullLifecycleHookAuthority(authority.source, authority.agentLabel) &&
      now - authority.reportedAt > HOOK_WORKING_TTL_MS;
    return staleWorking ? null : authority.state;
  }

  /**
   * 是否处在「CLI 启动窗口」内：进程刚被拉起，屏幕还没画出 agent 的就绪画面。
   *
   * 这段窗口里的 `working` 不是一轮工作，而是 CLI 自身的启动加载（读配置、拉模型、
   * 渲染首屏）：屏幕上的 spinner / `esc to cancel`、以及 hook 的 PreInvocation 都会这样报。
   * 若照常写入状态机，初始化结束时的 working → idle 就会被判成一次「完成」——
   * 未聚焦的 pane 因此投影成 done（侧栏绿点），聚焦的 pane 也会写一条 completionSeq。
   * 所以窗口内**只有非 working 的观测**才允许改状态（blocked 照常放行：它必须提醒用户）。
   *
   * 只对 `screenStartupIgnored` 的 agent 生效（目前是 antigravity）：它的初始化是一段纯
   * 加载，屏幕的 working 完全没有信息量；其它 agent 的输入区在首帧就出现，给它们开窗口
   * 只会压住第一轮的显示与提示音。
   *
   * 关闭条件（见调用点）：
   * - 屏幕出现 manifest 确认过的非 working 画面（visibleIdle 就绪页脚 / visibleBlocker 对话框）；
   * - hook 报来非 working 状态；
   * - 进程退出 / 重启重置；
   * - 超过 AGENT_STARTUP_WINDOW_MS（防御，见常量注释）。
   */
  private agentStartupInProgress(agent: string | null, now: number): boolean {
    if (!this.agentStartupPending || this.recentAgentProcessExit !== null) return false;
    if (now - this.agentStartupSince > AGENT_STARTUP_WINDOW_MS) return false;
    const known = agent === null ? null : (parseAgentLabel(agent) ?? agent);
    return known !== null && screenStartupIgnored(known);
  }
}
