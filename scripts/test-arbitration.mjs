/*
 * 状态仲裁纯函数测试。
 *
 * 这批规则原本是 `TerminalState` 的私有方法（读 `this`），只能通过状态机的
 * 25 组端到端用例间接覆盖。抽成纯函数后可以逐条断言规则本身：
 * - 优先级次序（blocker → hook → 屏幕）；
 * - 全生命周期权威的「进程在场」前提；
 * - 启动窗口的边界；
 * - TTL 只对「屏幕观测过」的 pane 生效（web pane 例外）。
 *
 * 端到端行为仍由 test:terminal-state 的 163 条断言锁定；这里补的是规则层面的白盒覆盖。
 */

import {
  agentStartupInProgress,
  effectiveHookState,
  hookAuthorityIsEffective,
  liveFullLifecycleAuthority,
  resolveEffectiveState,
  visibleBlockerOverridesHook,
} from '../.tmp/arbitration.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const NOW = 10_000;
const TTL = 1500;
const WINDOW = 20_000;

/** 造一份默认输入（全部「无特殊」状态）。 */
function input(overrides = {}) {
  return {
    fallbackState: 'idle',
    fallbackVisibleBlocker: false,
    hookAuthority: null,
    detectedAgent: null,
    recentAgentProcessExit: null,
    agentStartupPending: false,
    agentStartupSince: 0,
    screenObserved: true,
    hookWorkingTtlMs: TTL,
    agentStartupWindowMs: WINDOW,
    ...overrides,
  };
}

/** 造一条 hook 权威。 */
function authority(overrides = {}) {
  return {
    source: 'herdr-desktop:claude',
    agentLabel: 'claude',
    state: 'working',
    message: null,
    reportedAt: NOW,
    sessionRef: null,
    ...overrides,
  };
}

console.log('— 1. 优先级：blocker → hook → 屏幕 —');
check('无任何信号 → 屏幕 fallback',
  resolveEffectiveState(input({ fallbackState: 'idle' }), NOW) === 'idle');
check('hook 有效 → 用 hook 状态',
  resolveEffectiveState(input({ hookAuthority: authority({ state: 'working' }) }), NOW) === 'working');
check('屏幕 blocker 压过 hook',
  resolveEffectiveState(
    input({
      fallbackState: 'idle',
      fallbackVisibleBlocker: true,
      detectedAgent: 'claude',
      hookAuthority: authority({ state: 'idle' }),
    }),
    NOW,
  ) === 'blocked');
check('屏幕 blocker 不压 blocked 的 hook（本就是 blocked）',
  resolveEffectiveState(
    input({
      fallbackVisibleBlocker: true,
      detectedAgent: 'claude',
      hookAuthority: authority({ state: 'blocked' }),
    }),
    NOW,
  ) === 'blocked');
check('blocker 但 agent 不匹配 → 不用 blocker',
  visibleBlockerOverridesHook(
    input({
      fallbackVisibleBlocker: true,
      detectedAgent: 'codex',
      hookAuthority: authority({ agentLabel: 'claude', state: 'idle' }),
    }),
  ) === false);

console.log('— 2. 全生命周期权威的「进程在场」前提 —');
const fullLifecycle = authority({ source: 'herdr-desktop:opencode', agentLabel: 'opencode' });
check('全生命周期 + 进程在场 → 生效',
  liveFullLifecycleAuthority(
    input({ detectedAgent: 'opencode', hookAuthority: fullLifecycle }),
  ) === true);
check('全生命周期 + 进程不在场 → 不生效',
  liveFullLifecycleAuthority(
    input({ detectedAgent: null, hookAuthority: fullLifecycle }),
  ) === false);
check('全生命周期 + 进程已退出 → 不生效',
  liveFullLifecycleAuthority(
    input({
      detectedAgent: 'opencode',
      hookAuthority: fullLifecycle,
      recentAgentProcessExit: { agent: 'opencode', observedAt: NOW - 100 },
    }),
  ) === false);
check('非全生命周期来源不做进程在场检查',
  hookAuthorityIsEffective(input({ detectedAgent: 'other' }), authority()) === true);

console.log('— 3. 启动窗口 —');
check('窗口内 antigravity 的 working 不参与状态',
  effectiveHookState(
    input({
      detectedAgent: 'antigravity',
      agentStartupPending: true,
      agentStartupSince: NOW - 1000,
      hookAuthority: authority({
        source: 'herdr-desktop:antigravity',
        agentLabel: 'antigravity',
        state: 'working',
      }),
    }),
    NOW,
  ) === null);
check('窗口内非 working 照常放行',
  effectiveHookState(
    input({
      detectedAgent: 'antigravity',
      agentStartupPending: true,
      agentStartupSince: NOW - 1000,
      hookAuthority: authority({
        source: 'herdr-desktop:antigravity',
        agentLabel: 'antigravity',
        state: 'blocked',
      }),
    }),
    NOW,
  ) === 'blocked');
check('启动窗口只对 antigravity 生效（claude 不受影响）',
  agentStartupInProgress(
    input({ agentStartupPending: true, agentStartupSince: NOW - 1000 }),
    'claude',
    NOW,
  ) === false);
check('超过窗口上限后失效',
  agentStartupInProgress(
    input({ agentStartupPending: true, agentStartupSince: NOW - WINDOW - 1 }),
    'antigravity',
    NOW,
  ) === false);
check('进程已退出时窗口不算数',
  agentStartupInProgress(
    input({
      agentStartupPending: true,
      agentStartupSince: NOW - 1000,
      recentAgentProcessExit: { agent: 'antigravity', observedAt: NOW - 500 },
    }),
    'antigravity',
    NOW,
  ) === false);

console.log('— 4. working 的 TTL —');
const stale = authority({ state: 'working', reportedAt: NOW - TTL - 1 });
check('非全生命周期 working 超过 TTL → 交还屏幕',
  effectiveHookState(input({ detectedAgent: 'antigravity', hookAuthority: stale }), NOW) === null);
check('TTL 内仍生效',
  effectiveHookState(
    input({ detectedAgent: 'antigravity', hookAuthority: authority({ reportedAt: NOW - 100 }) }),
    NOW,
  ) === 'working');
check('全生命周期来源不受 TTL 影响',
  effectiveHookState(
    input({
      detectedAgent: 'opencode',
      hookAuthority: authority({
        source: 'herdr-desktop:opencode',
        agentLabel: 'opencode',
        reportedAt: NOW - TTL - 1,
      }),
    }),
    NOW,
  ) === 'working');
check('未观测过屏幕的 pane 不套 TTL（web pane）',
  effectiveHookState(
    input({
      screenObserved: false,
      detectedAgent: 'dsh',
      hookAuthority: authority({ source: 'herdr-desktop:dsh', agentLabel: 'dsh', reportedAt: NOW - TTL - 1 }),
    }),
    NOW,
  ) === 'working');
check('idle 不受 TTL 影响',
  effectiveHookState(input({ hookAuthority: authority({ state: 'idle', reportedAt: NOW - 99_999 }) }), NOW) ===
    'idle');

console.log('— 5. 权威失效时回落到屏幕 —');
check('权威不生效 → null（由屏幕兜底）',
  effectiveHookState(
    input({
      detectedAgent: null,
      hookAuthority: authority({ source: 'herdr-desktop:opencode', agentLabel: 'opencode' }),
    }),
    NOW,
  ) === null);
check('无权威 → null',
  effectiveHookState(input({ hookAuthority: null }), NOW) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
