/**
 * 状态仲裁谓词 —— 决定「屏幕上看到的状态」与「hook 上报的状态」谁说了算。
 *
 * 这批判断原本是 `TerminalState` 的私有方法，读 `this` 上的 6 个字段。
 * 它们**全部只读、无副作用**，因此抽成纯函数：输入用显式对象表达，
 * 既可以脱离状态机单测，也把「为什么这样判」的规则从类内部暴露出来。
 *
 * 优先级（`resolveEffectiveState` 即完整语义）：
 * 1. 屏幕可见 blocker 恒胜（对话框必须提醒用户，见 `visibleBlockerOverridesHook`）；
 * 2. 生效中的 hook 状态；
 * 3. 屏幕 fallback 状态。
 */

import { fullLifecycleHookAuthority, parseAgentLabel, screenStartupIgnored } from '../../../../shared/detect/facade';
import type { DetectedState } from '../../../../shared/state';
import type { AgentSessionRef } from './agent-session-ref';

/** hook 权威载体（与 TerminalState.HookAuthority 同构）。 */
export interface HookAuthorityState {
  source: string;
  agentLabel: string;
  state: DetectedState;
  message: string | null;
  reportedAt: number;
  sessionRef: AgentSessionRef | null;
}

/** 仲裁所需的全部输入（显式列出，避免谓词偷偷依赖别的字段）。 */
export interface ArbitrationInput {
  /** 屏幕 fallback 状态。 */
  fallbackState: DetectedState;
  /** 屏幕本帧是否看到 blocker（权限/信任对话框）。 */
  fallbackVisibleBlocker: boolean;
  /** 当前 hook 权威。 */
  hookAuthority: HookAuthorityState | null;
  /** 进程检测到的 agent（进程名等价物）。 */
  detectedAgent: string | null;
  /** 最近一次该 agent 的进程退出（用于判定权威是否已失效）。 */
  recentAgentProcessExit: { agent: string; observedAt: number } | null;
  /** 是否处在本 pane 的 CLI 启动窗口内。 */
  agentStartupPending: boolean;
  agentStartupSince: number;
  /** 本 pane 的屏幕是否被真实观测过（web pane 恒 false）。 */
  screenObserved: boolean;
  /** 非全生命周期来源的 working 上报有效期。 */
  hookWorkingTtlMs: number;
  /** CLI 启动窗口上限。 */
  agentStartupWindowMs: number;
}

/**
 * hook 权威是否生效。
 *
 * 全生命周期来源要求「进程在场且确实是这个 agent」——否则一条来自上一个进程的
 * 权威会把新起的进程状态压住。
 */
export function hookAuthorityIsEffective(
  input: ArbitrationInput,
  authority: HookAuthorityState,
): boolean {
  if (!fullLifecycleHookAuthority(authority.source, authority.agentLabel)) {
    return true;
  }
  const agent = parseAgentLabel(authority.agentLabel);
  return agent === null || (input.detectedAgent === agent && input.recentAgentProcessExit === null);
}

/** 全生命周期 hook 是否活跃且生效中。 */
export function liveFullLifecycleAuthority(input: ArbitrationInput): boolean {
  const authority = input.hookAuthority;
  return (
    authority !== null &&
    fullLifecycleHookAuthority(authority.source, authority.agentLabel) &&
    hookAuthorityIsEffective(input, authority)
  );
}

/**
 * 屏幕可见 blocker 是否压过 hook 状态。
 *
 * 刻意**不**要求「屏幕观测新于 hook 上报」（上游 herdr 有此判据）：
 * 我们的 antigravity 会上报状态且上报稀疏，一旦 hook 时间戳更新就会赢，
 * 而权限提示弹出后 TUI 通常不再刷新 —— 没有新的屏幕观测，状态就被钉死在
 * working，blocked 永远出不来（实测：阻塞时完全没有提示音）。
 *
 * 因此让 blocker 恒胜：它是每帧重算的具体信号，提示消失后自然变 false。
 */
export function visibleBlockerOverridesHook(input: ArbitrationInput): boolean {
  if (liveFullLifecycleAuthority(input)) return false;
  return (
    input.fallbackVisibleBlocker &&
    input.hookAuthority !== null &&
    input.hookAuthority.state !== 'blocked' &&
    parseAgentLabel(input.hookAuthority.agentLabel) === input.detectedAgent
  );
}

/**
 * 是否处在「CLI 启动窗口」内。
 *
 * 窗口内的 `working` 不是一轮工作，而是 CLI 自身的启动加载：屏幕的 spinner /
 * `esc to cancel`、以及 hook 的 PreInvocation 都会这样报。照常写入状态机的话，
 * 初始化结束时的 working → idle 会被判成一次「完成」（误响提示音 + 侧栏绿点）。
 *
 * 只对 `screenStartupIgnored` 的智能体（目前 antigravity）生效：它的初始化是纯加载，
 * 屏幕的 working 没有信息量；其它智能体的输入区首帧就出现，开窗口反而会压住第一轮。
 */
export function agentStartupInProgress(
  input: ArbitrationInput,
  agent: string | null,
  now: number,
): boolean {
  if (!input.agentStartupPending || input.recentAgentProcessExit !== null) return false;
  if (now - input.agentStartupSince > input.agentStartupWindowMs) return false;
  const known = agent === null ? null : (parseAgentLabel(agent) ?? agent);
  return known !== null && screenStartupIgnored(known);
}

/**
 * 生效中的 hook 状态（null = 交给屏幕兜底）。
 *
 * 两种失效情形：
 * - 启动窗口内的 working（见 `agentStartupInProgress`）；
 * - **非全生命周期来源**的 working 超过 TTL 未刷新。antigravity 在用户按 Esc 取消时
 *   不会回调 `Stop`（CLI 直接中断执行循环），最后一条 working 会把状态永久钉住。
 *   真实工作时屏幕一直有 spinner，状态仍是 working（无跳变）；取消后屏幕回到
 *   idle 页脚，状态随之回落。
 *
 * TTL 只对「屏幕真的观测过」的 pane 生效：web pane 没有屏幕、fallbackState 恒 idle，
 * 否则它上报的 working 会在间隔超过 TTL 时被错误回落到 idle。
 */
export function effectiveHookState(
  input: ArbitrationInput,
  now: number,
): DetectedState | null {
  const authority = input.hookAuthority;
  if (authority === null || !hookAuthorityIsEffective(input, authority)) return null;
  if (authority.state === 'working' && agentStartupInProgress(input, authority.agentLabel, now)) {
    return null;
  }
  const staleWorking =
    input.screenObserved &&
    authority.state === 'working' &&
    !fullLifecycleHookAuthority(authority.source, authority.agentLabel) &&
    now - authority.reportedAt > input.hookWorkingTtlMs;
  return staleWorking ? null : authority.state;
}

/** 合成生效状态：blocker 恒胜 → hook 状态 → 屏幕 fallback。 */
export function resolveEffectiveState(input: ArbitrationInput, now: number): DetectedState {
  if (visibleBlockerOverridesHook(input)) return 'blocked';
  const hookState = effectiveHookState(input, now);
  return hookState ?? input.fallbackState;
}
