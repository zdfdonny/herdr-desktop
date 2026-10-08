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
  private fallbackObservedAt: number | null;
  private agentNameOwner: AgentNameOwner | null;
  private managedAgent: ManagedAgent | null;
  private codexPromptReady: boolean;
  private managedAgentLaunchSession: PersistedAgentSession | null;
  private hookReportSequences = new Map<string, number>();
  private suppressedFullLifecycleHookReports = new Map<string, SuppressedFullLifecycleHookReport>();
  private staleFullLifecycleHookSessions = new Map<string, StaleFullLifecycleHookSession[]>();
  private recentAgentProcessExit: RecentAgentProcessExit | null;
  private agentProcessAcquisitionPending: boolean;

  constructor(paneId: string) {
    this.paneId = paneId;
    this.detectedAgent = null;
    this.fallbackState = 'unknown';
    this.fallbackVisibleBlocker = false;
    this.fallbackObservedAt = null;
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
    _visibleIdle: boolean,
    _visibleWorking: boolean,
    processExited: boolean,
    now: number,
  ): TerminalStateMutation {
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
    this.fallbackObservedAt = now;
    if (processExited) {
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

    if (!unsequencedSelection && !this.acceptHookReport(source, seq)) {
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
      this.fallbackObservedAt = null;
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
    this.fallbackObservedAt = null;
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
    this.fallbackObservedAt = null;
    this.hookAuthority = null;
    this.persistedAgentSession = null;
    this.suppressedFullLifecycleHookReports.clear();
    this.staleFullLifecycleHookSessions.clear();
    this.state = 'unknown';
    this.lastAgentStateChangeSeq = null;
    this.lastAgentCompletionSeq = null;
    this.recentAgentProcessExit = null;
    this.agentProcessAcquisitionPending = false;
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

  private fallbackNotOlderThanHook(): boolean {
    return (
      this.hookAuthority === null ||
      (this.fallbackObservedAt !== null &&
        this.hookAuthority.reportedAt <= this.fallbackObservedAt)
    );
  }

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
    return (
      this.fallbackVisibleBlocker &&
      this.fallbackNotOlderThanHook() &&
      this.hookAuthority !== null &&
      this.hookAuthority.state !== 'blocked' &&
      parseAgentLabel(this.hookAuthority.agentLabel) === this.detectedAgent
    );
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
    _now: number, // 预留：对齐 herdr 的 now，当前无 presentation 比较故未使用
  ): EffectiveStateChange | null {
    const state = this.visibleBlockerOverridesHook()
      ? 'blocked'
      : this.hookAuthority !== null && this.hookAuthorityIsEffective(this.hookAuthority)
        ? this.hookAuthority.state
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
}
