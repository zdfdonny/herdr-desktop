/*
 * TerminalState 状态机验证脚本（对应 herdr src/terminal/state.rs 的单元测试）。
 *
 * 用 esbuild 把 electron/runtime/terminal-state.ts 打成 ESM 后 import 真实实现
 * （而非复制逻辑），与 test-layout-store.mjs / test-unix-platform.mjs 同一做法。
 * agent-status.ts 单独打包，验证 done/seen 投影与完成跳变判定。
 *
 * 用法: npm run test:terminal-state
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const terminalPath = join(process.cwd(), '.tmp-terminal-state.mjs');
const agentStatusPath = join(process.cwd(), '.tmp-agent-status.mjs');
const detectManifestPath = join(process.cwd(), '.tmp-detect-manifest.mjs');
const agentDetectorPath = join(process.cwd(), '.tmp-agent-detector.mjs');
for (const p of [terminalPath, agentStatusPath, detectManifestPath, agentDetectorPath]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — run: npm run test:terminal-state`);
    process.exit(2);
  }
}
const { TerminalState } = await import(pathToFileURL(terminalPath).href);
const { paneAgentStatus, isCompletionTransition } = await import(
  pathToFileURL(agentStatusPath).href
);
const { fullLifecycleHookAuthority, sessionIdentityOnlyIntegration, detectStatus, evaluateManifest, MANIFESTS } = await import(
  pathToFileURL(detectManifestPath).href
);
const { detectFromSnapshot } = await import(pathToFileURL(agentDetectorPath).href);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}\n      期望 ${e}\n      实际 ${a}`);
  }
}

/** 检测层便捷调用（对应 herdr 测试的 set_detected_state，process_exited=false）。 */
function setDetected(t, agent, state, now) {
  return t.setDetectedStateWithScreenSignalsAt(agent, state, false, false, false, false, now);
}

/** hook 权威便捷调用（session_ref=null，对应 herdr 测试的 set_hook_authority）。 */
function setHook(t, source, agent, state, seq, now) {
  return t.setHookAuthorityAt(source, agent, state, null, null, seq, now);
}

// ---------------------------------------------------------------------------
// 1. hook 权威覆盖同 agent 的 fallback
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  setDetected(t, 'pi', 'idle', 1000);
  t.setPersistedAgentSession({
    source: 'herdr:pi',
    agent: 'pi',
    sessionRef: { kind: 'path', value: '/tmp/root.jsonl' },
  });
  setHook(t, 'herdr:pi', 'pi', 'working', null, 2000);

  check('1.1 hook 权威生效：state=working', t.state, 'working');
  check('1.2 detectedAgent 保留', t.detectedAgent, 'pi');
  check('1.3 fallbackState 仍是 idle', t.fallbackState, 'idle');
  check('1.4 hook 权威已落库', t.hookAuthority !== null && t.hookAuthority.state, 'working');
  check('1.5 persisted 会话被 hook 权威接管后清空', t.persistedAgentSession, null);
}

// ---------------------------------------------------------------------------
// 2. 完整生命周期 hook 权威激活时忽略屏幕检测（steady-state）
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  setDetected(t, 'pi', 'idle', 1000);
  t.setPersistedAgentSession({
    source: 'herdr:pi',
    agent: 'pi',
    sessionRef: { kind: 'path', value: '/tmp/root.jsonl' },
  });
  setHook(t, 'herdr:pi', 'pi', 'working', null, 2000);
  // 屏幕又报 idle（无进程退出），应被 live full-lifecycle 权威忽略
  t.setDetectedStateWithScreenSignalsAt('pi', 'idle', false, false, false, false, 3000);

  check('2.1 hook 权威仍占上风', t.state, 'working');
  check('2.2 full-lifecycle 权威激活标记', t.fullLifecycleHookAuthorityActive(), true);
}

// ---------------------------------------------------------------------------
// 3. 进程退出清理匹配的 hook 权威 + 有效标签置空
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  setDetected(t, 'pi', 'idle', 1000);
  setHook(t, 'herdr:pi', 'pi', 'working', null, 2000);
  t.setDetectedStateWithScreenSignalsAt('pi', 'unknown', false, false, false, true, 3000);

  check('3.1 进程退出后 hook 权威清空', t.hookAuthority, null);
  check('3.2 状态回落 fallback（unknown）', t.state, 'unknown');
  check('3.3 detectedAgent 仍记忆 pi', t.detectedAgent, 'pi');
  check('3.4 有效标签因进程退出置空', t.effectiveAgentLabel(), null);
}

// ---------------------------------------------------------------------------
// 4. seq 单调去重（旧 seq 被拒绝）
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  setDetected(t, 'opencode', 'idle', 1000);
  t.setPersistedAgentSession({
    source: 'herdr:opencode',
    agent: 'opencode',
    sessionRef: { kind: 'id', value: 'sess-1' },
  });
  const m1 = t.setHookAuthorityAt(
    'herdr:opencode',
    'opencode',
    'working',
    null,
    { kind: 'id', value: 'sess-1' },
    5,
    2000,
  );
  const m2 = t.setHookAuthorityAt(
    'herdr:opencode',
    'opencode',
    'blocked',
    null,
    { kind: 'id', value: 'sess-1' },
    3,
    3000,
  );

  check('4.1 新 seq 被接受', m1 !== null, true);
  check('4.2 旧 seq 被拒绝', m2, null);
  check('4.3 状态保持 working', t.state, 'working');
}

// ---------------------------------------------------------------------------
// 5. visible blocker 覆盖非 blocked 的 hook（屏幕上正弹确认框，hook 却报 idle）
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  // visibleBlocker=true：屏幕可见「需要输入」信号
  t.setDetectedStateWithScreenSignalsAt('claude', 'blocked', true, false, false, false, 1000);
  // 非 full-lifecycle 的自定义 hook 报 idle（reportedAt 早于 fallback）
  t.setHookAuthorityAt('custom:claude', 'claude', 'idle', null, null, null, 500);

  check('5.1 hook 状态是 idle', t.hookAuthority !== null && t.hookAuthority.state, 'idle');
  check('5.2 有效状态被可见 blocker 覆盖为 blocked', t.state, 'blocked');
}

// ---------------------------------------------------------------------------
// 6. managed agent 阶段机：readiness 跟随检测状态
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  const now = 1000;
  t.beginManagedAgent('reviewer', 'pi', now, 100, 1000);
  setDetected(t, 'pi', 'unknown', now);

  check('6.1 启动中 pending', t.managedAgentLaunchPending(), true);
  check('6.2 尚未交互就绪', t.managedAgentInteractiveReady(), false);

  check('6.3 settle 后返回 true，仍 pending', t.reconcileManagedAgentAt(now + 100, false), true);
  check('6.4 仍 pending', t.managedAgentLaunchPending(), true);

  setDetected(t, 'pi', 'working', now + 1);
  check('6.5 working 不推进', t.reconcileManagedAgentAt(now + 101, false), false);

  setDetected(t, 'pi', 'blocked', now + 2);
  check('6.6 blocked 进入 Blocked 阶段', t.reconcileManagedAgentAt(now + 102, false), true);
  check('6.7 Blocked 仍算 pending', t.managedAgentLaunchPending(), true);
  check('6.8 Blocked 无 deadline', t.nextManagedAgentDeadline(), null);
  check('6.9 名字保留', t.agentName, 'reviewer');

  check('6.10 Blocked 阶段 idle 前不推进', t.reconcileManagedAgentAt(now + 2000, false), false);
  check('6.11 名字仍保留', t.agentName, 'reviewer');

  setDetected(t, 'pi', 'idle', now + 3);
  check('6.12 idle 进入 Active', t.reconcileManagedAgentAt(now + 2000, false), true);
  check('6.13 不再 pending', t.managedAgentLaunchPending(), false);
  check('6.14 已交互就绪', t.managedAgentInteractiveReady(), true);

  setDetected(t, null, 'unknown', now + 4);
  check('6.15 Active 后检测不到 agent 不释放名字', t.reconcileManagedAgentAt(now + 2000, false), false);
  check('6.16 名字仍保留', t.agentName, 'reviewer');

  check('6.17 进程退出释放名字', t.reconcileManagedAgentAt(now + 2000, true), true);
  check('6.18 名字清空', t.agentName, null);
}

// ---------------------------------------------------------------------------
// 7. codex managed readiness：需要当前 prompt 就绪（无需 idle）
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  const now = 1000;
  t.beginManagedAgent('reviewer', 'codex', now, 100, 1000);
  setDetected(t, 'codex', 'unknown', now);
  t.observeCodexPromptReady(true);
  t.reconcileManagedAgentAt(now, false);
  check('7.1 codex 未知状态+prompt 就绪，尚未交互就绪', t.managedAgentInteractiveReady(), false);

  t.observeCodexPromptReady(false);
  check('7.2 settle 后 prompt 未就绪仍不推进', t.reconcileManagedAgentAt(now + 100, false), true);
  check('7.3 仍未交互就绪', t.managedAgentInteractiveReady(), false);

  t.observeCodexPromptReady(true);
  check('7.4 prompt 就绪后交互就绪', t.reconcileManagedAgentAt(now + 101, false), true);
  check('7.5 已交互就绪', t.managedAgentInteractiveReady(), true);
  check('7.6 状态保持 unknown（codex 特例）', t.state, 'unknown');
}

// ---------------------------------------------------------------------------
// 8. paneAgentStatus / isCompletionTransition 纯函数
// ---------------------------------------------------------------------------
{
  check('8.1 idle+未看→done', paneAgentStatus('idle', false), 'done');
  check('8.2 idle+已看→idle', paneAgentStatus('idle', true), 'idle');
  check('8.3 working 透传', paneAgentStatus('working', false), 'working');
  check('8.4 blocked 透传', paneAgentStatus('blocked', true), 'blocked');
  check('8.5 unknown 透传', paneAgentStatus('unknown', false), 'unknown');

  check('8.6 working→idle 是完成', isCompletionTransition('working', 'idle'), true);
  check('8.7 blocked→idle 是完成', isCompletionTransition('blocked', 'idle'), true);
  check('8.8 unknown→idle 不是完成', isCompletionTransition('unknown', 'idle'), false);
  check('8.9 idle→idle 不是完成', isCompletionTransition('idle', 'idle'), false);
  check('8.10 working→working 不是完成', isCompletionTransition('working', 'working'), false);
}

// ---------------------------------------------------------------------------
// 9. opencode 完整生命周期（回归：命令派生检测 + select 锚定 + working→idle）
// ---------------------------------------------------------------------------
{
  const t = new TerminalState('p1');
  // 模拟 attachPane 的命令派生进程检测（对应 herdr set_detected_agent_process_at）
  t.setDetectedAgentProcessAt('opencode', 1000);
  check('9.1 命令派生 detectedAgent', t.detectedAgent, 'opencode');

  // TUI 选择会话：{sessionId, sessionStartSource:'select'}（无 seq）
  const ref = { kind: 'id', value: 'sess-1' };
  t.setAgentSessionRefForSessionStart('herdr:opencode', 'opencode', ref, null, 'select', 2000);
  check('9.2 select 锚定会话', t.persistedAgentSession?.sessionRef?.value, 'sess-1');

  // TUI 状态上报 working：{sessionId, state:'working', seq:5}
  t.setHookAuthorityAt('herdr:opencode', 'opencode', 'working', null, ref, 5, 3000);
  check('9.3 working 生效', t.state, 'working');

  // 任务完成：{sessionId, state:'idle', seq:6}
  t.setHookAuthorityAt('herdr:opencode', 'opencode', 'idle', null, ref, 6, 4000);
  check('9.4 idle 生效（不再卡 working）', t.state, 'idle');
}

// ---------------------------------------------------------------------------
// 10. 权威白名单（对齐 herdr full_lifecycle_hook_authority /
//     session_identity_only_integration，仅 antigravity 按 desktop 资产标签适配）
// ---------------------------------------------------------------------------
{
  // full-lifecycle：hook 活着时对状态拥有权威，屏幕检测只作回退
  const fullLifecycle = ['pi', 'omp', 'mastracode', 'opencode', 'kilo', 'kimi'];
  // session-identity-only：只上报会话身份，不持有状态权威
  const sessionOnly = ['hermes', 'qwen', 'letta', 'antigravity'];
  // 其余官方来源：自定义 hook（session 或 state），非 full-lifecycle、非 session-only
  const custom = ['claude', 'codex', 'copilot', 'devin', 'droid', 'qodercli', 'cursor', 'grok'];

  for (const agent of fullLifecycle) {
    check(`10.1 ${agent} 是 full-lifecycle`, fullLifecycleHookAuthority(`herdr:${agent}`, agent), true);
    check(`10.2 ${agent} 不是 session-only`, sessionIdentityOnlyIntegration(`herdr:${agent}`, agent), false);
  }
  for (const agent of sessionOnly) {
    check(`10.3 ${agent} 是 session-only`, sessionIdentityOnlyIntegration(`herdr:${agent}`, agent), true);
    check(`10.4 ${agent} 不是 full-lifecycle`, fullLifecycleHookAuthority(`herdr:${agent}`, agent), false);
  }
  for (const agent of custom) {
    check(`10.5 ${agent} 非 full-lifecycle 非 session-only`,
      fullLifecycleHookAuthority(`herdr:${agent}`, agent) ||
        sessionIdentityOnlyIntegration(`herdr:${agent}`, agent),
      false);
  }
  // antigravity 的 desktop 资产标签与 herdr（herdr:antigravity_cli / agy）不同，单独锁定
  check('10.6 antigravity 用 desktop 标签', sessionIdentityOnlyIntegration('herdr:antigravity', 'antigravity'), true);
}

// ---------------------------------------------------------------------------
// 11. antigravity 专属检测（回归：通用关键词不能把 idle 误判为 working）
// ---------------------------------------------------------------------------
{
  const idleScreen = ['> 写一个 hello world', '', '? for shortcuts'].join('\n');
  check('11.1 antigravity idle footer → idle', detectStatus('antigravity', idleScreen), 'idle');

  const workingScreen = ['⠋ thinking about the task', '> 写一个 hello world', '', '───── esc to cancel'].join('\n');
  check('11.2 antigravity esc to cancel → working', detectStatus('antigravity', workingScreen), 'working');

  const spinnerScreen = ['⠋ streaming response', '> 写一个 hello world', '', '? for shortcuts'].join('\n');
  check('11.3 antigravity 盲文 spinner → working', detectStatus('antigravity', spinnerScreen), 'working');

  const blockedScreen = [
    'permission requested',
    '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
    '───── esc to cancel',
  ].join('\n');
  check('11.4 antigravity dialog → blocked', detectStatus('antigravity', blockedScreen), 'blocked');

  // 专属规则不泄漏到通用路径：仅 "esc to cancel"（无 working 关键词）在 agentName=null 时是 unknown
  check('11.5 通用路径不受 antigravity 专属规则影响', detectStatus(null, '───── esc to cancel'), 'unknown');
}

// ---------------------------------------------------------------------------
// 12. claude 专属检测（回归：正文里的 working/thinking 不能误判为 working）
// ---------------------------------------------------------------------------
{
  const claudeIdle = ['> hello', '❯'].join('\n');
  check('12.1 claude ❯ 提示框 → idle', detectStatus('claude', claudeIdle), 'idle');

  const claudeWorking = '⏵ Generating… esc to interrupt';
  check('12.2 claude ⏵ esc to interrupt → working', detectStatus('claude', claudeWorking), 'working');

  const claudeSpinner = '* Thinking… (12s · esc to interrupt)';
  check('12.3 claude spinner+… → working', detectStatus('claude', claudeSpinner), 'working');

  // claude 权限确认（bash_permission_prompt：do you want to proceed? + bash command）
  const claudeBlocked = ['Do you want to proceed?', '> bash command'].join('\n');
  check('12.4 claude 权限确认 → blocked', detectStatus('claude', claudeBlocked), 'blocked');

  // 核心回归：claude 响应正文里的 "working" 不能误判为 working
  const claudeIdleWithWord = ['The tests are working now.', '❯'].join('\n');
  check('12.5 claude 正文里的 working 不误判 → idle', detectStatus('claude', claudeIdleWithWord), 'idle');
}

// ---------------------------------------------------------------------------
// 13. claude 回车覆盖（回归：被 \r 覆盖的 "Brewing…" 不能误判为 working）
// ---------------------------------------------------------------------------
{
  // claude 用 \r 原地把 spinner 行从 "Brewing… (3s · esc to interrupt)"
  // 覆盖为 "Brewed for 3s · done"；raw buffer 里两者共存。
  const raw = '✻ Brewing… (3s · esc to interrupt)\r✻ Brewed for 3s · done 13:40\n❯ hello\n';
  const result = detectFromSnapshot(raw, 'claude');
  check('13.1 \r 覆盖后取最终内容 → idle', result.status, 'idle');

  // 纯 CRLF 换行不应被当作覆盖清空
  const crlf = '❯ hello\r\n✻ Brewing… (3s · esc to interrupt)\r\n';
  const result2 = detectFromSnapshot(crlf, 'claude');
  check('13.2 CRLF 换行不受影响', result2.status, 'working');
}

// ---------------------------------------------------------------------------
// 14. claude OSC 标题/进度检测（对应 herdr osc_title_working / osc_title_idle /
//     osc_progress_idle —— 最可靠的工作/空闲信号）
// ---------------------------------------------------------------------------
{
  // OSC 标题 spinner 是最可靠的工作信号（对应 herdr osc_title_working，priority 1100），
  // 屏幕 idle 也会被覆盖。
  check('14.1 OSC title spinner → working（覆盖屏幕 idle）',
    detectStatus('claude', '❯ hello\n', '\u280b Thinking', ''), 'working');

  check('14.2 OSC title ✳ → idle', detectStatus('claude', '❯ hello\n', '\u2733 ', ''), 'idle');

  // 端到端：raw buffer 含 OSC 标题，detectFromSnapshot 在 stripAnsi 前提取
  const rawWorking = '\x1b]0;\u280b Thinking\x07❯ hello\n';
  check('14.3 detectFromSnapshot 提取 OSC working title → working',
    detectFromSnapshot(rawWorking, 'claude').status, 'working');

  const rawIdle = '\x1b]0;\u2733 \x07❯ hello\n';
  check('14.4 detectFromSnapshot 提取 OSC idle title → idle',
    detectFromSnapshot(rawIdle, 'claude').status, 'idle');
}

// ---------------------------------------------------------------------------
// 15. 光标原地重绘（回归：旧 spinner/footer 残留不能误判 working）
// ---------------------------------------------------------------------------
{
  // claude：\r 回行首 + 擦行 + 重绘 done，覆盖旧的 Brewing…
  const claudeRedraw =
    '✻ Brewing… (3s · esc to interrupt)\r\x1b[2K✻ Brewed for 3s · done 13:40\n❯ hello\n';
  check('15.1 claude 光标重绘后 → idle', detectFromSnapshot(claudeRedraw, 'claude').status, 'idle');

  // antigravity：\r 回行首 + 擦行 + 重绘 idle footer，覆盖旧的 esc to cancel
  const agRedraw = '───── esc to cancel\r\x1b[2K? for shortcuts\n> hi\n';
  check('15.2 antigravity 光标重绘后 → idle', detectFromSnapshot(agRedraw, 'antigravity').status, 'idle');
}

// ---------------------------------------------------------------------------
// 16. per-agent manifest 注册与求值（每 agent 一个文件）
// ---------------------------------------------------------------------------
{
  // 22 个 SCREEN_MANIFEST_AGENTS（omp / mastracode 无屏幕 manifest，走通用兜底）
  check('16.1 注册 22 个 manifest', Object.keys(MANIFESTS).length, 22);

  // 所有 manifest 求值不抛错（覆盖正则编译错误）
  const errored = [];
  for (const [agent, manifest] of Object.entries(MANIFESTS)) {
    try {
      evaluateManifest(manifest, { screen: 'sample\n❯', oscTitle: '', oscProgress: '' });
    } catch {
      errored.push(agent);
    }
  }
  check('16.2 所有 manifest 求值不抛错', errored.join(','), '');

  // 关键规则抽查（OSC / 屏幕信号翻译正确性）
  check('16.3 codex OSC title blocked', detectStatus('codex', '', 'Action Required', ''), 'blocked');
  check('16.4 codex OSC title working', detectStatus('codex', '', '\u280b thinking', ''), 'working');
  check('16.5 opencode esc to interrupt → working', detectStatus('opencode', 'esc to interrupt', '', ''), 'working');
  check('16.6 grok OSC title idle', detectStatus('grok', '', 'grok', ''), 'idle');
  check('16.7 grok OSC title working', detectStatus('grok', '', '\u280b thinking', ''), 'working');
  check('16.8 cursor ctrl+c to stop → working', detectStatus('cursor', 'ctrl+c to stop', '', ''), 'working');
  check('16.9 qwen OSC title working', detectStatus('qwen', '', '\u25d0 thinking', ''), 'working');
  check('16.10 pi braille Working → working', detectStatus('pi', '\u280b Working', '', ''), 'working');
  check('16.11 kilo esc interrupt → working', detectStatus('kilo', 'esc interrupt', '', ''), 'working');
}

// ---------------------------------------------------------------------------
// 17. visible 信号精确性（manifest 命中规则的 visible_* 标志，非状态近似）
// ---------------------------------------------------------------------------
{
  // codex weak_blocker：state=blocked 但无 visibleBlocker（不应覆盖 hook 状态）
  const weak = detectFromSnapshot('[y/n]\n', 'codex');
  check('17.1 codex weak_blocker state=blocked', weak.status, 'blocked');
  check('17.2 codex weak_blocker 无 visibleBlocker', weak.visibleBlocker, false);

  // codex live_strong_blocker：state=blocked 且 visibleBlocker=true（可见阻断）
  const strong = detectFromSnapshot('press enter to confirm or esc to cancel\n', 'codex');
  check('17.3 codex strong_blocker state=blocked', strong.status, 'blocked');
  check('17.4 codex strong_blocker visibleBlocker=true', strong.visibleBlocker, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
