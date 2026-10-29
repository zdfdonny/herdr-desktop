/**
 * 终端状态机的数据类型与纯比较函数。
 *
 * 从 `terminal-state.ts` 抽出。这些类型只描述**状态形状**，不含任何行为，
 * 因此放在一起便于对照阅读；状态机的类本体留在 `terminal-state.ts` 里。
 */

import type { AgentSessionRefKind, DetectedState } from '../../../../shared/state';
import type { AgentSessionRef } from './agent-session-ref';

/** 一次生效状态变化（对应 herdr `EffectiveStateChange`）。 */
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

/** 变更前的状态快照（屏幕观测与会话上报两条入口共用）。 */
export interface StateSnapshot {
  previousAgentLabel: string | null;
  previousKnownAgent: string | null;
  previousState: DetectedState;
  previousDetectedAgent: string | null;
  previousSession: SessionIdentity | null;
}

/** 会话身份（用于判断「这条上报是否换了会话」）。 */
export interface SessionIdentity {
  source: string;
  agent: string;
  kind: AgentSessionRefKind;
  value: string;
}

/** 全生命周期上报的路由结果。 */
export type FullLifecycleHookReportRoute =
  | { accept: true; reanchorSequence: boolean }
  | { accept: false };

/** agent 名归属：这个名字当前归谁、锚在哪个会话上。 */
export interface AgentNameOwner {
  agentLabel: string;
  sessionRef: AgentSessionRef | null;
}

/** 最近一次「该 agent 的进程已退出」，用于抑制上一个进程的残留上报。 */
export interface RecentAgentProcessExit {
  agent: string;
  observedAt: number;
}

/**
 * 托管 agent 的启动阶段。
 *
 * - `pending`：已拉起、等就绪（`readyAfter` 到点后才考虑判就绪，`deadline` 兜底放弃）；
 * - `blocked`：屏幕上出现阻塞/对话框，暂停等待；
 * - `active`：已进入交互态。
 */
export type ManagedAgentPhase =
  | { kind: 'pending'; readyAfter: number | null; deadline: number; observedExpected: boolean }
  | { kind: 'blocked' }
  | { kind: 'active' };

/** 托管 agent（启动阶段机的主体）。 */
export interface ManagedAgent {
  kind: string;
  phase: ManagedAgentPhase;
}

/**
 * 会话身份按值比较。
 *
 * 注意与 `sessionRefEquals` 的区别：前者比「来源 + agent + 引用」三者，
 * 后者只比引用本身。判断「是不是同一个会话」用这个，判断「引用是否相同」用那个。
 */
export function sessionIdentityEqual(
  a: SessionIdentity | null,
  b: SessionIdentity | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.source === b.source && a.agent === b.agent && a.kind === b.kind && a.value === b.value;
}
