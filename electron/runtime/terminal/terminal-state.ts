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

import type { DetectedState } from '../../../shared/state';
import {
  fullLifecycleHookAuthority,
  normalizedAgentId,
  parseAgentLabel,
  sessionIdentityOnlyIntegration,
} from '../../../shared/detect/facade';
import { agentById } from '../../../shared/agents/registry';
import { type StatePolicy, DEFAULT_STATE_POLICY } from '../../../shared/agents/spec/policy';
import { isSessionStartSource } from '../../../shared/agents/spec/session-start-source';
import { HookReportSequence } from './state/hook-report-sequence';
import { StaleSessionRegistry } from './state/stale-session-registry';
import {
  HookSuppressionLedger,
  type PendingReplacementReport,
  type SuppressionReason,
} from './state/hook-suppression-ledger';
import type { HookAuthority } from './state/hook-authority';
import { sessionRefEquals, type AgentSessionRef } from './state/agent-session-ref';
import {
  agentStartupInProgress,
  hookAuthorityIsEffective,
  liveFullLifecycleAuthority,
  resolveEffectiveState,
  type ArbitrationInput,
} from './state/arbitration';
import {
  canResume,
  isOfficialAgentSource,
  normalizeSessionStartSource,
  sessionReportAllowsSessionReplacement,
  type PersistedAgentSession,
} from '../agent-resume';

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


/*
 * 类型与纯比较函数已抽到 `state/terminal-types.ts`。
 * 先 import 供本文件使用，再 re-export 保持对外 API 不变
 * （router / session / 测试都从 `terminal-state` 取这些类型）。
 */
import {
  sessionIdentityEqual,
  type AgentNameOwner,
  type EffectiveStateChange,
  type FullLifecycleHookReportRoute,
  type ManagedAgent,
  type RecentAgentProcessExit,
  type SessionIdentity,
  type StateSnapshot,
  type TerminalStateMutation,
} from './state/terminal-types';

export type {
  AgentNameOwner,
  EffectiveStateChange,
  FullLifecycleHookReportRoute,
  ManagedAgent,
  ManagedAgentPhase,
  RecentAgentProcessExit,
  SessionIdentity,
  StateSnapshot,
  TerminalStateMutation,
} from './state/terminal-types';
export { sessionIdentityEqual } from './state/terminal-types';

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
  private promptReady: boolean;
  private managedAgentLaunchSession: PersistedAgentSession | null;
  private readonly sequences = new HookReportSequence();
  private readonly suppressions = new HookSuppressionLedger();
  private readonly staleSessions = new StaleSessionRegistry();
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
    this.promptReady = false;
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
      this.promptReady = false;
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

    /*
     * 一次屏幕观测的准备：记下变更前的全部身份/状态，并算出两个与「进程退出」相关的派生量。
     *
     * 这两个派生量在多个早退分支里都要用，所以先算好：
     * - `agentReleased`：退出且确实曾持有名字 → 需要对外报告「agent 没了」；
     * - `newerCustomAuthority`：退出时还有一条**比本次观测更新**的非官方权威 →
     *   它是自定义指令来源，不算释放（避免把用户刚设的状态清掉）。
     */
    const snapshot = this.beginSnapshot();
    const { previousAgentLabel, previousState, previousDetectedAgent } = snapshot;

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

    /*
     * 三个早退闸门：命中任何一个都只重算状态、不改身份与会话。
     *
     * 顺序有意义 —— 全生命周期权威优先于「刚释放过名字」优先于启动窗口。
     */
    if (this.shouldIgnoreDetectedStateUnderFullLifecycleHook(agent, processExited)) {
      if (
        this.hookAuthority !== null &&
        parseAgentLabel(this.hookAuthority.agentLabel) === agent
      ) {
        this.detectedAgent = agent;
      }
      return this.mutationFrom(snapshot, now);
    }

    const replacementProcessDetected =
      !processExited &&
      agent !== null &&
      this.recentAgentProcessExit !== null &&
      this.recentAgentProcessExit.agent === agent &&
      this.recentAgentProcessExit.observedAt < now;
    if (!processExited && this.detectedStateObservedBeforeReleaseSuppression(agent, now)) {
      return this.mutationFrom(snapshot, now);
    }
    /*
     * CLI 启动窗口内的 working 不参与状态（见 agentStartupInProgress）。
     *
     * 屏幕上的 spinner / `esc to cancel` 在启动期只表示「CLI 还在加载」，不是一轮工作；
     * 若照常写入状态机，初始化结束的 working → idle 就会被判成一次「完成」。
     */
    if (!processExited && fallbackState === 'working' && this.agentStartupInProgress(agent, now)) {
      return this.mutationFrom(snapshot, now);
    }

    // —— 以下是「真的要把这次观测写进状态机」的路径 ——
    this.detectedAgent = agent;
    /*
     * prompt 就绪位只对「用 prompt 标记判就绪」的智能体（codex）有意义：
     * 其它智能体每次屏幕观测都清零，避免陈旧的就绪信号影响托管阶段机。
     */
    if (processExited || !this.requiresPromptMarker(agent) || fallbackState === 'blocked') {
      this.promptReady = false;
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
    this.updateStartupWindow(agent, processExited, visibleIdle, visibleBlocker, now);

    if (processExited) {
      this.onProcessExited(agent, now, newerCustomAuthority);
    }

    this.dropConflictingHookAuthority(agent, previousDetectedAgent, now);

    // 进程退出不等于 agent 消失：只有「退出且已检测不到 agent」才释放名字。
    if (agent === null && this.recentAgentProcessExit !== null) {
      this.clearAgentName();
    }

    const effectiveStateChange = this.recomputeEffectiveState(
      previousAgentLabel,
      snapshot.previousKnownAgent,
      previousState,
      now,
    );
    if (fallbackState === 'working' && this.state === 'working') {
      this.agentProcessAcquisitionPending = false;
    }
    return {
      effectiveStateChange,
      sessionRefChanged: !sessionIdentityEqual(
        snapshot.previousSession,
        this.currentSessionIdentityForPersistence(),
      ),
      agentReleased,
    };
  }

  /**
   * 变更前的身份/状态快照（供变更前后对比）。
   *
   * 屏幕观测与会话上报两条入口共用：它们需要的字段是同一组，
   * 只是屏幕观测会额外用到 `previousDetectedAgent`（判定是否换了 agent）。
   */
  private beginSnapshot(): StateSnapshot {
    return {
      previousAgentLabel: this.effectiveAgentLabel(),
      previousKnownAgent: this.effectiveKnownAgent(),
      previousState: this.state,
      previousDetectedAgent: this.detectedAgent,
      previousSession: this.currentSessionIdentityForPersistence(),
    };
  }

  /**
   * 按快照产出变更结果。
   *
   * `agentReleased` 只有进程退出路径会产生非 false 值，其余入口传 false。
   * 三个早退闸门原先各自抄了一段同样的 12 行代码，现在共用本方法。
   */
  private mutationFrom(
    snapshot: StateSnapshot,
    now: number,
    agentReleased = false,
  ): TerminalStateMutation {
    return {
      effectiveStateChange: this.recomputeEffectiveState(
        snapshot.previousAgentLabel,
        snapshot.previousKnownAgent,
        snapshot.previousState,
        now,
      ),
      sessionRefChanged: !sessionIdentityEqual(
        snapshot.previousSession,
        this.currentSessionIdentityForPersistence(),
      ),
      agentReleased,
    };
  }

  /**
   * 维护 CLI 启动窗口的开/关与进程退出记录。
   *
   * 关窗条件：屏幕上出现了 manifest 确认过的**非 working** 画面 —— 就绪页脚
   * （visibleIdle，如 antigravity 的 "? for shortcuts"）或对话框（visibleBlocker）。
   * 不看 fallback 的 idle：进程刚拉起时屏幕往往是空白/半帧，manifest 无规则命中也会
   * 回落 idle，用它关窗会让整段初始化失去保护。
   *
   * 对话框也要关窗：否则用户答完 trust 提示后，后续的加载层会被一直压住，
   * 状态停在 blocked 上（看起来还需要操作，实际上什么都不用做）。
   */
  private updateStartupWindow(
    agent: string | null,
    processExited: boolean,
    visibleIdle: boolean,
    visibleBlocker: boolean,
    now: number,
  ): void {
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
  }

  /**
   * 进程退出清理：重置抑制账本、标记陈旧会话、清 hook 权威与会话。
   *
   * 分三步（顺序不可颠倒）：
   * 1. 结算抑制记录：把「退出时的会话」与「已确认替换到的会话」不同的那些标为陈旧；
   * 2. 重置官方来源的序号水位，并按退出时的会话重新记一条抑制；
   * 3. 清掉与本次退出相关的 hook 权威与持久化会话。
   */
  private onProcessExited(agent: string | null, now: number, newerCustomAuthority: boolean): void {
    const resetSources: string[] = [];
    const staleSessions: Array<{
      source: string;
      agentLabel: string;
      sessionRef: AgentSessionRef;
    }> = [];
    for (const [source, suppressed] of this.suppressions.all()) {
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
      this.staleSessions.remember(s.source, s.agentLabel, s.sessionRef);
    }
    for (const source of resetSources) {
      this.sequences.reset(source);
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
      this.sequences.reset(officialSession.source);
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
      this.sequences.reset(clearedHookSource);
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

  /**
   * 丢弃与本次观测冲突的 hook 权威。
   *
   * 两种冲突：权威属于别的 agent；或权威属于**上一个** detectedAgent 而现在换了人。
   * 要求权威不新于本次观测（更新的权威应当胜出）。冲突时保留其会话引用
   * （`durableSession`），以便后续恢复。
   */
  private dropConflictingHookAuthority(
    agent: string | null,
    previousDetectedAgent: string | null,
    now: number,
  ): void {
    if (
      !this.hookAuthorityNotNewerThan(now) ||
      !(
        this.hookAuthorityConflictsWithDetectedAgent(agent) ||
        (previousDetectedAgent !== null &&
          agent !== previousDetectedAgent &&
          this.hookAuthority !== null &&
          parseAgentLabel(this.hookAuthority.agentLabel) === previousDetectedAgent)
      )
    ) {
      return;
    }
    const durableSession =
      this.hookAuthority !== null && this.hookAuthority.sessionRef !== null
        ? {
            source: this.hookAuthority.source,
            agent: this.hookAuthority.agentLabel,
            sessionRef: this.hookAuthority.sessionRef,
          }
        : null;
    this.suppressCurrentFullLifecycleHookAuthority('hook-clear', now);
    this.hookAuthority = null;
    this.persistedAgentSession = durableSession;
  }

  /** 对应 herdr `set_hook_authority_at`。 */
  /**
   * 对应 herdr `set_hook_authority_at` —— 处理一条 hook **状态**上报。
   *
   * 按阶段组织：
   * 1. `prefilterHookReport()` —— 早期丢弃（身份不符 / 进程已退出 / 路由不收）；
   * 2. `resolveHookReportSession()` —— 七道闸门 + 会话引用解析；
   * 3. `commitHookAuthority()` —— 写入权威并返回变更。
   */
  setHookAuthorityAt(
    source: string,
    agentLabel: string,
    state: DetectedState,
    message: string | null,
    sessionRef: AgentSessionRef | null,
    seq: number | null,
    now: number,
  ): TerminalStateMutation | null {
    const prefiltered = this.prefilterHookReport(
      source,
      agentLabel,
      state,
      message,
      sessionRef,
      seq,
      now,
    );
    if (prefiltered === null) return null;

    const resolved = this.resolveHookReportSession(
      source,
      agentLabel,
      sessionRef,
      prefiltered.reanchorSequence,
      seq,
    );
    if (resolved === null) return null;

    return this.commitHookAuthority(source, agentLabel, state, message, resolved, now);
  }

  /**
   * 阶段 1：早期丢弃 + 全生命周期路由。
   *
   * 三条丢弃理由（顺序即优先级）：
   * 1. 「仅上报会话身份」的集成不持有状态权威 —— 整条状态上报都该忽略；
   * 2. 非全生命周期来源在其进程已退出后仍在报状态 —— 那是上一个进程的残留；
   * 3. 全生命周期路由闸门判定不收（见 `routeFullLifecycleHookReport`）。
   */
  private prefilterHookReport(
    source: string,
    agentLabel: string,
    state: DetectedState,
    message: string | null,
    sessionRef: AgentSessionRef | null,
    seq: number | null,
    now: number,
  ): { reanchorSequence: boolean } | null {
    if (sessionIdentityOnlyIntegration(source, agentLabel)) return null;

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
    return route.accept ? { reanchorSequence: route.reanchorSequence } : null;
  }

  /**
   * 阶段 2：冲突闸门 + 会话引用解析。返回 null 表示这条上报被丢弃。
   *
   * 闸门（任一不通过即丢弃）：
   * 1. 标签与 detectedAgent 冲突；
   * 2. 显式替换型会话重绑（codex）：状态上报不允许偷偷更换已锚定的会话；
   * 3. 会话所有者冲突（含前台接管例外）；
   * 4. 全生命周期 hook 权威锚在别的会话。
   *
   * 解析：若这条上报带来了会话引用，先尝试用「同 owner 冲突」的既有规则纠正它，
   * 再按 seq 水位确认（`reanchorSequence` 为真时先重置水位）。
   */
  private resolveHookReportSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
    reanchorSequence: boolean,
    seq: number | null,
  ): {
    sessionRef: AgentSessionRef | null;
    foregroundTakeoverAllowed: boolean;
    reanchorSequence: boolean;
  } | null {
    if (this.knownAgentLabelConflictsWithDetectedAgent(agentLabel)) return null;

    /*
     * 显式替换型会话重绑（codex）：状态上报不允许偷偷更换已锚定的会话。
     * 其它智能体允许状态上报顺带刷新会话引用。
     */
    const anchored = this.currentSessionIdentityForPersistence();
    if (
      this.policyFor(agentLabel).sessionRebinding.mode === 'explicit-replace' &&
      sessionRef !== null &&
      anchored !== null &&
      (anchored.kind !== sessionRef.kind || anchored.value !== sessionRef.value)
    ) {
      return null;
    }

    const ownerConflicts = this.currentSessionOwnerConflicts(source, agentLabel);
    const foregroundTakeoverAllowed =
      ownerConflicts &&
      this.foregroundAgentConfirmsHookAuthorityTakeover(source, agentLabel, sessionRef);
    if (ownerConflicts && !foregroundTakeoverAllowed) return null;

    let resolvedSessionRef = sessionRef;
    if (resolvedSessionRef !== null) {
      if (
        !this.lifecycleHookReportReplacesPersistedSession(source, agentLabel, resolvedSessionRef)
      ) {
        resolvedSessionRef =
          this.conflictingSameOwnerSessionRef(source, agentLabel, resolvedSessionRef, null) ??
          resolvedSessionRef;
      }
    }
    if (
      this.liveFullLifecycleHookAuthorityConflictsWithSession(
        source,
        agentLabel,
        resolvedSessionRef,
      )
    ) {
      return null;
    }

    if (reanchorSequence) {
      this.sequences.reset(source);
    }
    if (!this.acceptHookReport(source, seq)) return null;

    return { sessionRef: resolvedSessionRef, foregroundTakeoverAllowed, reanchorSequence };
  }

  /** 阶段 3：写入 hook 权威、维护陈旧/抑制账本、关闭启动窗口，返回变更。 */
  private commitHookAuthority(
    source: string,
    agentLabel: string,
    state: DetectedState,
    message: string | null,
    resolved: {
      sessionRef: AgentSessionRef | null;
      foregroundTakeoverAllowed: boolean;
      reanchorSequence: boolean;
    },
    now: number,
  ): TerminalStateMutation {
    const snapshot = this.beginSnapshot();
    const { sessionRef, foregroundTakeoverAllowed, reanchorSequence } = resolved;

    this.reconcileAgentNameOwner(agentLabel, sessionRef);
    if (foregroundTakeoverAllowed) {
      this.suppressCurrentFullLifecycleHookAuthority('hook-clear', now);
    }
    if (sessionRef !== null || reanchorSequence) {
      // 这条上报已经把会话锚定下来（或显式要求重锚），之前的抑制记录到此结账：
      // 被抑制时锚定的旧会话进陈旧列表，记录本身丢弃。
      const suppressed = this.suppressions.get(source);
      if (suppressed !== undefined) {
        this.suppressions.forget(source);
        if (suppressed.sessionRef !== null) {
          this.staleSessions.remember(source, suppressed.agentLabel, suppressed.sessionRef);
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
      sessionRef,
    };

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
    return this.mutationFrom(snapshot, now);
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

  /**
   * 对应 herdr `set_agent_session_ref_for_session_start`。
   *
   * 会话上报要过的关卡很多，按阶段组织（每段一个具名方法）：
   * 1. `sessionReportContext()` —— 收集本次上报的判断依据；
   * 2. `reconcileUnsequencedSelection()` —— opencode 式「未排序 select」的重绑；
   * 3. `reconcileGatedFullLifecycleReport()` —— 被抑制/未锚定的全生命周期上报；
   * 4. `passesSessionGates()` —— 窄口径放行 + 一系列冲突闸门；
   * 5. `commitSessionRef()` —— 真正写入会话引用并返回变更。
   */
  setAgentSessionRefForSessionStart(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
    seq: number | null,
    sessionStartSource: string | null,
    now: number,
  ): TerminalStateMutation | null {
    if (sessionRef === null) return null;

    const ctx = this.sessionReportContext(source, agentLabel, sessionRef, seq, sessionStartSource);

    // 阶段 2：未排序选择的重绑（opencode 的 TUI select 不带 seq）。
    const reconciled = this.reconcileUnsequencedSelection(ctx, sessionRef, now);
    if (reconciled !== NOT_RECONCILED) return reconciled;

    // 阶段 3：全生命周期来源在「进程不在场 / 有抑制 / 未锚定」时的处理。
    const gated = this.reconcileGatedFullLifecycleReport(ctx, sessionRef, now);
    if (gated !== NOT_RECONCILED) return gated;

    // 阶段 4：闸门。任一道不通过即整条丢弃。
    const gates = this.passesSessionGates(ctx, sessionRef);
    if (gates === null) return null;

    // 阶段 5：写入并返回变更。
    return this.commitSessionRef(ctx, gates, now);
  }

  /** 一次会话上报的判断依据（避免各阶段重复计算）。 */
  private sessionReportContext(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
    seq: number | null,
    sessionStartSource: string | null,
  ): {
    source: string;
    agentLabel: string;
    sessionRef: AgentSessionRef;
    seq: number | null;
    normalizedStartSource: string | null;
    knownAgent: string | null;
    processPresent: boolean;
    fullLifecycleSource: boolean;
    generationGated: boolean;
    sessionAnchored: boolean;
    unsequencedSelection: boolean;
    selectionCanReconcile: boolean;
  } {
    const normalizedStartSource = normalizeSessionStartSource(sessionStartSource);
    const knownAgent = parseAgentLabel(agentLabel);
    const processPresent =
      knownAgent !== null &&
      this.detectedAgent === knownAgent &&
      this.recentAgentProcessExit === null;
    const fullLifecycleSource = fullLifecycleHookAuthority(source, agentLabel);
    const suppressed = this.suppressions.get(source);
    const generationGated =
      suppressed !== undefined &&
      suppressed.agentLabel === agentLabel &&
      suppressed.reason !== 'hook-clear';
    const sessionAnchored =
      (this.hookAuthority !== null &&
        this.hookAuthority.source === source &&
        this.hookAuthority.agentLabel === agentLabel &&
        this.hookAuthority.sessionRef !== null) ||
      this.persistedAgentSessionMatches(source, agentLabel);
    const unsequencedSelection = this.isUnsequencedOpencodeSelection(
      agentLabel,
      normalizedStartSource,
      seq,
    );
    return {
      source,
      agentLabel,
      sessionRef,
      seq,
      normalizedStartSource,
      knownAgent,
      processPresent,
      fullLifecycleSource,
      generationGated,
      sessionAnchored,
      unsequencedSelection,
      selectionCanReconcile: unsequencedSelection && processPresent,
    };
  }

  /**
   * 阶段 2：未排序选择的重绑。
   *
   * 进程在场时可以直接认这条选择；不在场就记一条抑制并确认替换，
   * 等进程回来再放行。返回 `NOT_RECONCILED` 表示「这条分支没命中，继续往下走」。
   */
  private reconcileUnsequencedSelection(
    ctx: SessionReportContext,
    sessionRef: AgentSessionRef,
    now: number,
  ): TerminalStateMutation | null | typeof NOT_RECONCILED {
    if (ctx.selectionCanReconcile) {
      this.suppressions.forget(ctx.source);
      return NOT_RECONCILED;
    }
    if (!ctx.fullLifecycleSource || !ctx.unsequencedSelection) return NOT_RECONCILED;

    const previousSessionRef = this.currentSessionRefFor(ctx.source, ctx.agentLabel);
    this.suppressions.suppress(ctx.source, {
      agentLabel: ctx.agentLabel,
      sessionRef: previousSessionRef,
      observedAt: now,
      reason: 'process-exit',
    });
    this.suppressions.confirmReplacement(ctx.source, sessionRef);
    return null;
  }

  /**
   * 阶段 3：全生命周期来源在「进程不在场 / 有抑制 / 未锚定」时的处理。
   *
   * 只接受带**可识别来源**且有 seq 的上报（否则无法判定新旧，宁可丢弃）；
   * seq 必须严格大于已知水位。
   */
  private reconcileGatedFullLifecycleReport(
    ctx: SessionReportContext,
    sessionRef: AgentSessionRef,
    now: number,
  ): TerminalStateMutation | null | typeof NOT_RECONCILED {
    const gated =
      ctx.fullLifecycleSource &&
      !ctx.selectionCanReconcile &&
      (!ctx.processPresent || ctx.generationGated || !ctx.sessionAnchored);
    if (!gated) return NOT_RECONCILED;

    if (!isSessionStartSource(ctx.normalizedStartSource)) return null;
    if (ctx.seq === null) return null;
    const lastSeq = this.sequences.watermark(ctx.source);
    if (lastSeq !== undefined && ctx.seq <= lastSeq) return null;

    const snapshot = this.beginSnapshot();

    this.suppressions.suppress(ctx.source, {
      agentLabel: ctx.agentLabel,
      sessionRef: null,
      observedAt: now,
      reason: 'process-exit',
    });
    this.suppressions.confirmReplacementIfChanged(ctx.source, sessionRef);
    this.sequences.set(ctx.source, ctx.seq);

    if (!ctx.processPresent) return null;
    this.clearFullLifecycleHookSuppressionForDetectedAgent(null, ctx.knownAgent);
    return this.mutationFrom(snapshot, now);
  }

  /**
   * 阶段 4：冲突闸门。返回 null 表示这条上报被丢弃；否则返回后续提交需要的信息。
   *
   * 闸门顺序（全部不通过即丢弃）：
   * 1. seq 水位 / 窄口径放行；
   * 2. 标签与 detectedAgent 冲突；
   * 3. 「仅上报会话身份」的集成在进程不在场时不得替换会话；
   * 4. 会话所有者冲突（含前台接管例外）；
   * 5. 同 owner 的冲突会话引用；
   * 6. 全生命周期 hook 权威锚在别的会话且不允许替换。
   */
  private passesSessionGates(
    ctx: SessionReportContext,
    sessionRef: AgentSessionRef,
  ): SessionGateResult | null {
    /*
     * 窄口径放行：带**可识别 source** 的会话上报，如果它确实在切换会话
     * （和当前生效的引用不同），就不让 seq 水位把它挡掉。
     *
     * 背景：`hook_report_is_newer(source, null)` 在「已有带 seq 的上报记下水位」之后
     * 恒为 false，于是脚本不带 seq 的会话上报会被整条丢弃。会话上报的脚本普遍不写
     * seq（跨平台的毫秒时间戳不好拿），而同一个 agent 的状态上报由主进程补了 seq，
     * 于是只要跑过一轮，之后的 SessionStart 就再也不生效 —— 用户 /clear、/resume、
     * --fork-session 之后 pane 还钉在旧会话上，重启会续回错的对话。
     *
     * 只放行**非全生命周期**来源（claude、codex 这类）：全生命周期集成（mastracode、
     * kimi、opencode、pi、omp、kilo）的会话锚定另有机制（陈旧会话列表、抑制账本），
     * 在这里插入「按内容而非时序」的放行会把新会话推进陈旧列表，反而让它的
     * working/idle 上报被整段丢掉。
     *
     * 这条放行**不推进水位**：否则会给该来源记下一个「现在」量级的大水位，
     * 把它后续那些带小序号（opencode 的 TUI 发 5、6 这种）的状态上报全挡掉。
     */
    const switchesSession =
      ctx.seq === null &&
      !ctx.fullLifecycleSource &&
      isSessionStartSource(ctx.normalizedStartSource) &&
      this.sessionRefDiffersFromCurrent(ctx.source, ctx.agentLabel, sessionRef);
    if (
      !ctx.unsequencedSelection &&
      !switchesSession &&
      !this.acceptHookReport(ctx.source, ctx.seq)
    ) {
      return null;
    }
    if (this.knownAgentLabelConflictsWithDetectedAgent(ctx.agentLabel)) return null;

    const sessionReplacementAllowed = sessionReportAllowsSessionReplacement(
      ctx.source,
      ctx.agentLabel,
      ctx.normalizedStartSource,
    );
    const curSession = this.currentSessionIdentityForPersistence();
    const replacingIdentityOnlySession =
      sessionIdentityOnlyIntegration(ctx.source, ctx.agentLabel) &&
      sessionReplacementAllowed &&
      curSession !== null &&
      curSession.source === ctx.source &&
      curSession.agent === ctx.agentLabel &&
      curSession.kind === 'id' &&
      sessionRef.kind === 'id' &&
      curSession.value !== sessionRef.value;
    if (replacingIdentityOnlySession && !ctx.processPresent) return null;

    const ownerConflicts = this.currentSessionOwnerConflicts(ctx.source, ctx.agentLabel);
    const foregroundTakeoverAllowed =
      ownerConflicts &&
      this.foregroundAgentConfirmsDifferentOwnerTakeover(
        ctx.source,
        ctx.agentLabel,
        sessionRef,
        ctx.normalizedStartSource,
      );
    if (ownerConflicts && !foregroundTakeoverAllowed) return null;
    if (
      this.conflictingSameOwnerSessionRef(
        ctx.source,
        ctx.agentLabel,
        sessionRef,
        ctx.normalizedStartSource,
      ) !== null
    ) {
      return null;
    }
    const replacedHookSession = this.sameOwnerFullLifecycleHookAuthoritySessionRef(
      ctx.source,
      ctx.agentLabel,
      sessionRef,
    );
    if (replacedHookSession !== null && !sessionReplacementAllowed) return null;

    return { sessionReplacementAllowed, foregroundTakeoverAllowed, replacedHookSession };
  }

  /** 阶段 5：写入会话引用、维护权威与陈旧列表，返回变更。 */
  private commitSessionRef(
    ctx: SessionReportContext,
    gates: SessionGateResult,
    now: number,
  ): TerminalStateMutation {
    const snapshot = this.beginSnapshot();
    const { sessionReplacementAllowed, foregroundTakeoverAllowed, replacedHookSession } = gates;

    /*
     * 显式替换型会话重绑（codex）：允许换会话时，若旧 hook 权威锚在别的会话上，
     * 直接丢弃该权威（不写抑制账本）—— 它描述的是上一轮会话，不再适用。
     */
    if (
      this.policyFor(ctx.agentLabel).sessionRebinding.mode === 'explicit-replace' &&
      sessionReplacementAllowed &&
      this.hookAuthority !== null &&
      this.hookAuthority.source === ctx.source &&
      this.hookAuthority.agentLabel === ctx.agentLabel &&
      !sessionRefEquals(this.hookAuthority.sessionRef, ctx.sessionRef)
    ) {
      this.hookAuthority = null;
    }
    if (sessionReplacementAllowed || foregroundTakeoverAllowed) {
      this.staleSessions.forget(ctx.source, ctx.agentLabel, ctx.sessionRef);
    }
    if (replacedHookSession !== null) {
      this.staleSessions.remember(ctx.source, ctx.agentLabel, replacedHookSession);
      this.hookAuthority = null;
    } else if (foregroundTakeoverAllowed) {
      this.suppressCurrentFullLifecycleHookAuthority('hook-clear', now);
      this.hookAuthority = null;
    }
    this.reconcileAgentNameOwner(ctx.agentLabel, ctx.sessionRef);

    const persistedSession: PersistedAgentSession = {
      source: ctx.source,
      agent: ctx.agentLabel,
      sessionRef: ctx.sessionRef,
    };
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
    if (snapshot.previousSession !== null && !sessionIdentityEqual(snapshot.previousSession, currentSession)) {
      this.agentProcessAcquisitionPending = true;
    }
    return this.mutationFrom(snapshot, now);
  }

  /** 该 source/agent 当前生效的会话引用（hook 权威优先，其次持久化）。 */
  private currentSessionRefFor(source: string, agentLabel: string): AgentSessionRef | null {
    return (
      (this.hookAuthority !== null &&
      this.hookAuthority.source === source &&
      this.hookAuthority.agentLabel === agentLabel
        ? this.hookAuthority.sessionRef
        : null) ??
      (this.persistedAgentSession !== null &&
      this.persistedAgentSession.source === source &&
      this.persistedAgentSession.agent === agentLabel
        ? this.persistedAgentSession.sessionRef
        : null)
    );
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

    this.suppressCurrentFullLifecycleHookAuthority('hook-clear', now);
    this.hookAuthority = null;
    this.persistedAgentSession = null;

    return {
      effectiveStateChange: this.recomputeEffectiveState(
        previousAgentLabel,
        previousKnownAgent,
        previousState,
        now,
      ),
      /*
       * 与其余 5 处保持同一写法（按值比较），而不是 `previousSession !== null`。
       *
       * 当前两者等价：上面已把 hookAuthority 与 persistedAgentSession 都置 null，
       * 所以 currentSessionIdentityForPersistence() 必为 null。
       * 但统一写法能防止将来清空逻辑收窄（例如保留某个来源的会话）时，
       * 这里悄悄变成错误答案 —— 那是「语义不一致」类 bug 的典型来源（附录 D #12）。
       */
      sessionRefChanged: !sessionIdentityEqual(
        previousSession,
        this.currentSessionIdentityForPersistence(),
      ),
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

    this.suppressFullLifecycleHookReport(source, agentLabel, 'hook-clear', now);
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
    return this.sequences.isNewer(source, seq);
  }

  /**
   * 给一条上报补一个严格递增的 seq（调用方拿不到可移植时间戳时使用）。
   *
   * 只用于**状态**上报（router 的状态分支）。会话上报分支刻意不补 seq：opencode 的
   * select 依赖 `seq === null` 走「未排序选择」分支；而脚本不带 seq 的会话上报被水位
   * 挡住的问题，由 setAgentSessionRefForSessionStart 的 switchesSession 窄口径放行解决。
   */
  nextHookReportSeq(now: number = Date.now()): number {
    return this.sequences.next(now);
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
    this.promptReady = false;
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

  /**
   * 观测到「当前 prompt 标记就绪」（对应 herdr `observe_codex_prompt_ready`）。
   *
   * 只对用 prompt 标记判就绪的智能体生效（codex），其它智能体恒为 no-op。
   */
  observePromptReady(ready: boolean): TerminalStateMutation | null {
    const managed = this.managedAgent;
    if (
      !this.requiresPromptMarker(this.detectedAgent) ||
      this.recentAgentProcessExit !== null ||
      !(managed !== null && this.requiresPromptMarker(managed.kind) &&
        managed.phase.kind !== 'active') ||
      this.promptReady === ready
    ) {
      return null;
    }
    this.promptReady = ready;
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
      if (knownAgent === managed.kind && this.readinessSatisfied(managed.kind)) {
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
        if (knownAgent === managed.kind && this.readinessSatisfied(managed.kind)) {
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
    this.promptReady = false;
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
    this.suppressions.clear();
    this.staleSessions.clear();
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

  /**
   * 某个 agent 标签对应的状态仲裁策略。
   *
   * 状态机里的所有「某个智能体才这样」的行为都从这里取，而不是内联按 agent id 分支
   * —— 新增/调整智能体时只改它的 descriptor。
   * 未知标签用默认策略（等价于重构前「不在任何白名单里」的语义）。
   */
  private policyFor(agentLabel: string | null): StatePolicy {
    const descriptor = agentById(normalizedAgentId(agentLabel ?? ''));
    return descriptor?.policy ?? DEFAULT_STATE_POLICY;
  }

  /** 该 agent 的就绪判据是否要求屏幕出现 prompt 标记（codex）。 */
  private requiresPromptMarker(agentLabel: string | null): boolean {
    return this.policyFor(agentLabel).readiness.requiresPromptMarker;
  }

  /**
   * managed agent 是否已交互就绪。
   *
   * 两种判据（原先这段表达式在 `reconcileManagedAgentAt` 里逐字重复了两次）：
   * - 默认：检测状态 `idle` 即就绪；
   * - 要求 prompt 标记的智能体（codex）：`unknown` + prompt 已就绪也算就绪
   *   （它的 TUI 在输入框出现后不一定会被屏幕规则判成 idle）。
   */
  private readinessSatisfied(managedKind: string): boolean {
    if (this.state === 'idle') return true;
    const probe = this.policyFor(managedKind).readiness;
    return probe.requiresPromptMarker && this.state === 'unknown' && this.promptReady;
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
    reason: SuppressionReason,
    now: number,
  ): void {
    const authority = this.hookAuthority;
    if (authority !== null && fullLifecycleHookAuthority(authority.source, authority.agentLabel)) {
      this.suppressFullLifecycleHookReportWithSessionRef(
        authority.source,
        authority.agentLabel,
        authority.sessionRef,
        reason,
        now,
      );
    }
  }

  private suppressFullLifecycleHookReport(
    source: string,
    agentLabel: string,
    reason: SuppressionReason,
    now: number,
  ): void {
    if (fullLifecycleHookAuthority(source, agentLabel)) {
      this.suppressFullLifecycleHookReportWithSessionRef(
        source,
        agentLabel,
        this.hookAuthority?.sessionRef ?? null,
        reason,
        now,
      );
    }
  }

  private suppressFullLifecycleHookReportWithSessionRef(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
    reason: SuppressionReason,
    observedAt: number,
  ): void {
    this.suppressions.replace(source, { agentLabel, sessionRef, observedAt, reason });
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
    /*
     * 防串台：拒绝「别家会话」的状态上报。
     *
     * 多个 pane 并发跑同一个智能体时（opencode 最典型），A 窗口的上报会带着
     * B 会话的引用飘过来；这类上报要直接丢弃，且**不**写 pending 替换报告
     * （与常规的「记一笔等下次确认」分支不同）。
     */
    const rejectsCrossSession =
      this.policyFor(agentLabel).sessionRebinding.rejectsCrossSessionReports === true &&
      processPresent &&
      anchoredSessionRef !== null &&
      sessionRef !== null &&
      !sessionRefEquals(anchoredSessionRef, sessionRef);
    if (rejectsCrossSession) {
      return { accept: false };
    }

    const suppressed = this.suppressions.get(source);
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

    if (processPresent && sessionAnchored && !this.suppressions.has(source)) {
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
    const lastSeq = this.sequences.watermark(source);
    if (lastSeq !== undefined && seq <= lastSeq) {
      return { accept: false };
    }

    const previousSessionRef =
      this.persistedAgentSession !== null &&
      this.persistedAgentSession.source === source &&
      this.persistedAgentSession.agent === agentLabel
        ? this.persistedAgentSession.sessionRef
        : null;
    // 记一条待确认的替换上报；seq 单调性由账本保证（迟到的旧上报不会覆盖新的）。
    this.suppressions.rememberPendingReplacement(source, {
      agentLabel,
      sessionRef: previousSessionRef,
      observedAt: reportedAt,
      reason: 'process-exit',
      authority: { source, agentLabel, state, message, reportedAt, sessionRef },
      seq,
    });
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
    return this.staleSessions.has(source, agentLabel, sessionRef);
  }

  private fullLifecycleHookReportHasFreshSessionAfterStaleSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
  ): boolean {
    if (!fullLifecycleHookAuthority(source, agentLabel)) {
      return false;
    }
    return this.staleSessions.isFreshAfterStale(source, agentLabel, sessionRef);
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
      pending: PendingReplacementReport | null;
    }> = [];

    for (const [source, suppressed] of this.suppressions.all()) {
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
          const sessionStartSeq = this.sequences.watermark(source);
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
          this.suppressions.forget(source);
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
      this.suppressions.forget(source);
    }

    for (const s of staleSessions) {
      this.staleSessions.remember(s.source, s.agentLabel, s.sessionRef);
    }

    for (const source of this.sequences.sources()) {
      const validated = validatedReplacementSessions.some((v) => v.source === source);
      if (!validated && fullLifecycleHookAuthority(source, detectedLabel)) {
        this.sequences.reset(source);
      }
    }

    for (const v of validatedReplacementSessions) {
      this.staleSessions.forget(v.source, v.agentLabel, v.sessionRef);
      this.reconcileAgentNameOwner(v.agentLabel, v.sessionRef);
      this.persistedAgentSession = {
        source: v.source,
        agent: v.agentLabel,
        sessionRef: v.sessionRef,
      };
      if (v.pending !== null) {
        this.sequences.set(v.source, v.pending.seq);
        this.hookAuthority = v.pending.authority;
      }
    }
  }

  private detectedStateObservedBeforeReleaseSuppression(
    detectedAgent: string | null,
    observedAt: number,
  ): boolean {
    if (detectedAgent === null) {
      return false;
    }
    for (const suppressed of this.suppressions.values()) {
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

  /**
   * 会话上报是否可以直接覆盖已持久化的会话（即使没有 hook 权威）。
   *
   * 只有 `overwrite-persisted` 语义的智能体（mastracode）允许：
   * 它的集成只报会话身份、不报状态，因此「没有 hook 权威」是常态，
   * 不能像其它智能体那样保守地忽略这种上报。
   */
  private lifecycleHookReportReplacesPersistedSession(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
  ): boolean {
    if (this.policyFor(agentLabel).sessionRebinding.mode !== 'overwrite-persisted') return false;
    const s = this.persistedAgentSession;
    return (
      this.hookAuthority === null &&
      s !== null &&
      s.source === source &&
      s.agent === agentLabel &&
      s.sessionRef.kind === 'id' &&
      sessionRef.kind === 'id' &&
      s.sessionRef.value !== sessionRef.value
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

  /**
   * 未排序的会话选择（opencode 的 TUI `select` 不带 seq）。
   *
   * 免水位：按常规水位处理会被当成过期上报丢弃，从而丢失会话重绑。
   */
  private isUnsequencedOpencodeSelection(
    agentLabel: string,
    sessionStartSource: string | null,
    seq: number | null,
  ): boolean {
    return (
      this.policyFor(agentLabel).sessionRebinding.mode === 'unsequenced-select' &&
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

  /**
   * 前台 agent 是否可以抢占「他人持有」的会话。
   *
   * grok 被排除（`allowForegroundTakeover: false`）：它的会话切换不可靠，
   * 抢占会把别人的会话绑到自己身上。
   */
  private foregroundAgentConfirmsDifferentOwnerTakeover(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef,
    sessionStartSource: string | null,
  ): boolean {
    return (
      this.policyFor(agentLabel).sessionRebinding.allowForegroundTakeover &&
      isSessionStartSource(sessionStartSource) &&
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
    return this.sequences.accept(source, seq);
  }

  private hookAuthorityIsEffective(authority: HookAuthority): boolean {
    return hookAuthorityIsEffective(this.arbitrationInput(), authority);
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
    return liveFullLifecycleAuthority(this.arbitrationInput());
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
    // 合成规则见 state/arbitration.ts 的 resolveEffectiveState（blocker → hook → 屏幕）。
    const state = resolveEffectiveState(this.arbitrationInput(), now);
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
   * 把仲裁所需的字段打包成纯函数输入。
   *
   * 仲裁谓词抽到 `state/arbitration.ts` 后，状态机这边只负责「提供当前事实」，
   * 规则本身不再散落在类里。
   */
  private arbitrationInput(): ArbitrationInput {
    return {
      fallbackState: this.fallbackState,
      fallbackVisibleBlocker: this.fallbackVisibleBlocker,
      hookAuthority: this.hookAuthority,
      detectedAgent: this.detectedAgent,
      recentAgentProcessExit: this.recentAgentProcessExit,
      agentStartupPending: this.agentStartupPending,
      agentStartupSince: this.agentStartupSince,
      screenObserved: this.screenObserved,
      hookWorkingTtlMs: HOOK_WORKING_TTL_MS,
      agentStartupWindowMs: AGENT_STARTUP_WINDOW_MS,
    };
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
    return agentStartupInProgress(this.arbitrationInput(), agent, now);
  }
}

/**
 * 「这条分支没命中」的哨兵值。
 *
 * 会话上报的几个阶段方法可能返回三种结果：变更（命中并已处理）、null（命中但丢弃）、
 * 以及「没命中，继续下一阶段」。用 Symbol 而不是 null 是因为 null 已是合法结果之一。
 */
const NOT_RECONCILED = Symbol('not-reconciled');

/** 会话上报的判断依据（阶段方法共用，避免重复计算）。 */
interface SessionReportContext {
  source: string;
  agentLabel: string;
  sessionRef: AgentSessionRef;
  seq: number | null;
  normalizedStartSource: string | null;
  knownAgent: string | null;
  processPresent: boolean;
  fullLifecycleSource: boolean;
  generationGated: boolean;
  sessionAnchored: boolean;
  unsequencedSelection: boolean;
  selectionCanReconcile: boolean;
}

/** 会话闸门通过后，提交阶段需要的信息。 */
interface SessionGateResult {
  sessionReplacementAllowed: boolean;
  foregroundTakeoverAllowed: boolean;
  replacedHookSession: AgentSessionRef | null;
}

