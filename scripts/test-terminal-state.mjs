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
const sessionPath = join(process.cwd(), '.tmp-session.mjs');
for (const p of [terminalPath, agentStatusPath, detectManifestPath, agentDetectorPath, sessionPath]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — run: npm run test:terminal-state`);
    process.exit(2);
  }
}
const { TerminalState, AGENT_STARTUP_WINDOW_MS } = await import(pathToFileURL(terminalPath).href);
const { Session } = await import(pathToFileURL(sessionPath).href);
const { paneAgentStatus, isCompletionTransition } = await import(
  pathToFileURL(agentStatusPath).href
);
const { fullLifecycleHookAuthority, sessionIdentityOnlyIntegration, screenCompletionIgnored, screenStartupIgnored, detectStatus, evaluateManifest, MANIFESTS } = await import(
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
  const sessionOnly = ['hermes', 'qwen', 'letta'];
  /*
   * antigravity 刻意**不**在 session-only 名单里（herdr 上游把它列为
   * `herdr:antigravity_cli` / `agy`）：它的集成会用 PreInvocation 上报 working、
   * Stop + fullyIdle 上报 idle，状态权威因此必须被采纳，否则状态上报会被
   * setHookAuthorityAt 首行直接丢弃。它同样不在 full-lifecycle 名单里，
   * 屏幕检测继续作为兜底。
   */
  const custom = ['claude', 'codex', 'copilot', 'devin', 'droid', 'qodercli', 'cursor', 'grok', 'antigravity'];

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
  // antigravity 的 desktop 资产标签与 herdr（herdr:antigravity_cli / agy）不同：它上报状态，
  // 因此不在 session-only 名单里；这一条锁定「上线报状态」这个桌面端独有的决定。
  check('10.6 antigravity 上报状态（不在 session-only）', sessionIdentityOnlyIntegration('herdr:antigravity', 'antigravity'), false);
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

  /*
   * claude 权限确认（bash_permission_prompt：do you want to proceed? + bash command）
   *
   * 真实的权限确认一定渲染编号选项行——herdr 的 bash_permission_prompt 用
   * `all = [yes/no 选项行]` 作为必要条件，避免把正文里出现的 "do you want to proceed?"
   * 误判成阻塞，因此样本必须带选项行。
   */
  const claudeBlocked = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again for: bash",
    '  3. No',
    'bash command',
    'esc to cancel',
  ].join('\n');
  check('12.4 claude 权限确认 → blocked', detectStatus('claude', claudeBlocked), 'blocked');

  // 核心回归：claude 响应正文里的 "working" 不能误判为 working
  const claudeIdleWithWord = ['The tests are working now.', '❯'].join('\n');
  check('12.5 claude 正文里的 working 不误判 → idle', detectStatus('claude', claudeIdleWithWord), 'idle');

  /*
   * / 命令场景回归：命中 skip_state_update 的规则时状态必须保持原样，
   * 不能产生假的 working → idle 完成跳变（否则会误响提示音）。
   */
  const evalClaude = (screen) =>
    evaluateManifest(MANIFESTS.claude, { screen, oscTitle: '', oscProgress: '' });

  const modelPicker = [
    'Select model',
    '❯ Opus 5.5 · API Usage Billing',
    '  Sonnet 4.8',
    'enter to set as default · esc to cancel',
  ].join('\n');
  check('12.6 claude /model 选择器 → skipStateUpdate', evalClaude(modelPicker).skipStateUpdate, true);

  const transcript = ['showing detailed transcript', 'ctrl+o to toggle', 'ctrl+e show all'].join('\n');
  check('12.7 claude 详细记录视图 → skipStateUpdate', evalClaude(transcript).skipStateUpdate, true);

  const btwOverlay = ['/btw 这条消息不进上下文', '', 'esc to close'].join('\n');
  check('12.8 claude /btw 浮层 → working', evalClaude(btwOverlay).state, 'working');

  const dynamicWorkflow = ['run a dynamic workflow?', 'esc to cancel'].join('\n');
  check('12.9 claude 动态 workflow 提示 → blocked', evalClaude(dynamicWorkflow).state, 'blocked');
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

// ---------------------------------------------------------------------------
// 18. 无 manifest 的 agent 回落 idle（对应 herdr fallback_explain：不猜屏幕关键词）
// ---------------------------------------------------------------------------
{
  check('18.1 omp 无 manifest → idle（忽略 working 关键词）', detectStatus('omp', 'Working...', '', ''), 'idle');
  check('18.2 mastracode 无 manifest → idle（忽略 blocked 关键词）', detectStatus('mastracode', 'blocked waiting for confirmation', '', ''), 'idle');
  check('18.3 未知 agent → unknown', detectStatus(null, 'Working...', '', ''), 'unknown');
}

// ---------------------------------------------------------------------------
// 19. claude 上报全生命周期状态后，/clear 仍能重绑会话（回归）
// ---------------------------------------------------------------------------
{
  /*
   * 回归的是两处：
   * 1) 会话上报的脚本普遍不带 seq，而同一 agent 的状态上报由主进程补了 seq——
   *    一旦记下水位，`hookReportIsNewer(src, null)` 恒为 false，SessionStart 被整条丢弃，
   *    用户 /clear、/resume 之后 pane 还钉在旧会话上（实测复现）；
   * 2) 状态上报里没有 source 字段，/clear 后带新 id 的上报会被判成「同 owner 换会话」
   *    而退回旧引用。
   * 这里按 router 的真实调用方式复现：状态上报补 seq，会话上报保持 seq=null。
   */
  const seqFor = (t, reported) =>
    typeof reported === 'number' && reported > 0 ? reported : t.nextHookReportSeq();
  const claudeRef = (id) => ({ kind: 'id', value: id });

  const t = new TerminalState('p1');
  setDetected(t, 'claude', 'idle', 1000);
  t.setAgentSessionRefForSessionStart('herdr:claude', 'claude', claudeRef('sess-orig'), null, 'startup', 2000);
  t.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, claudeRef('sess-orig'), seqFor(t, null), 3000);
  t.setHookAuthorityAt('herdr:claude', 'claude', 'idle', null, claudeRef('sess-orig'), seqFor(t, null), 4000);

  // /clear：SessionStart(clear) 照脚本实际行为，不带 seq
  t.setAgentSessionRefForSessionStart('herdr:claude', 'claude', claudeRef('sess-cleared'), null, 'clear', 5000);
  check('19.1 /clear 后被 hook 权威接管的会话仍是旧的', t.hookAuthority?.sessionRef?.value, 'sess-orig');

  // /clear 之后第一轮状态上报带新 id → 应当允许替换
  t.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, claudeRef('sess-cleared'), seqFor(t, null), 6000);
  check('19.2 状态上报可把会话引用刷新为新 id', t.hookAuthority?.sessionRef?.value, 'sess-cleared');
  check('19.3 投影出去的会话是新 id', t.currentSessionForPersistence()?.value, 'sess-cleared');

  // 不带 seq 的会话上报在有水位之后不能被丢弃（同一条链路的另一半）
  const t2 = new TerminalState('p1');
  setDetected(t2, 'claude', 'idle', 1000);
  t2.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, claudeRef('sess-a'), seqFor(t2, null), 2000);
  t2.setAgentSessionRefForSessionStart('herdr:claude', 'claude', claudeRef('sess-b'), null, 'resume', 3000);
  check('19.4 已有水位后 SessionStart(不带 seq) 仍生效', t2.persistedAgentSession?.sessionRef?.value, 'sess-b');

  // 放行必须只针对「真的在切换会话」：同一会话的重复上报仍受水位约束
  const t4 = new TerminalState('p1');
  setDetected(t4, 'claude', 'idle', 1000);
  t4.setAgentSessionRefForSessionStart('herdr:claude', 'claude', claudeRef('sess-x'), null, 'startup', 2000);
  t4.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, claudeRef('sess-x'), seqFor(t4, null), 3000);
  t4.setAgentSessionRefForSessionStart('herdr:claude', 'claude', claudeRef('sess-x'), null, 'resume', 4000);
  check('19.6 同会话重复上报不放行（仍按水位丢弃）', t4.hookReportIsNewer('herdr:claude', null), false);

  // nextHookReportSeq 必须严格递增（同毫秒内两条上报不能被 seq 比较丢掉）
  const t3 = new TerminalState('p1');
  const s1 = t3.nextHookReportSeq(1_700_000_000_000);
  t3.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, null, s1, 3000);
  const s2 = t3.nextHookReportSeq(1_700_000_000_000);
  check('19.5 同毫秒补出的 seq 严格递增', s2 > s1, true);
}

// ---------------------------------------------------------------------------
// 20. 工具完成心跳不得把已完成的 pane 拉回 working（async 心跳 vs 同步 Stop）
// ---------------------------------------------------------------------------
{
  /*
   * claude 的 PostToolUse（心跳，async）与 Stop（idle，同步）会乱序：模型在本轮末尾
   * 只回一两句时 idle 先落地，迟到的心跳若被采纳就会把状态顶回 working，导致完成通知
   * 在投递前复核时被判成「证据不成立」而丢弃，TTL 过期后又投影一次 done。
   */
  const t = new TerminalState('p1');
  setDetected(t, 'claude', 'idle', 1000);
  t.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, null, 100, 2000);
  t.setHookAuthorityAt('herdr:claude', 'claude', 'idle', null, null, 200, 3000);
  check('20.1 一轮结束 → idle', t.state, 'idle');

  // 迟到的心跳：必须被丢弃
  check('20.2 已完成时心跳被判为过期', t.isStaleHeartbeat('working', true), true);
  // 仍在工作时的心跳：不拦（它只负责刷新 TTL）
  const t2 = new TerminalState('p1');
  setDetected(t2, 'claude', 'idle', 1000);
  t2.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, null, 100, 2000);
  check('20.3 工作中时心跳放行', t2.isStaleHeartbeat('working', true), false);
  // 非心跳的 working（回合起点）不受影响
  check('20.4 回合起点 working 不受影响', t.isStaleHeartbeat('working', false), false);
  check('20.5 缺省 heartbeat 字段视为非心跳', t.isStaleHeartbeat('working', null), false);
  // 只拦 working：idle/blocked 上报不是心跳语义
  check('20.6 idle 上报不被当作心跳拦截', t.isStaleHeartbeat('idle', true), false);
  check('20.7 blocked 不被心跳规则拦截', t.isStaleHeartbeat('blocked', true), false);
}

// ---------------------------------------------------------------------------
// 21. claude --fork-session 能重绑会话（source=fork 的允许表条目）
// ---------------------------------------------------------------------------
{
  /*
   * fork 出来的是新会话，理应接管 pane 的绑定。上游白名单只有 clear/resume/compact，
   * 漏了 fork，表现为 --fork-session 之后 pane 仍钉在旧会话（重启续回原对话）。
   * 注意它和「空 source」那条各管一段：fork 的 SessionStart 自带 source="fork"，
   * 而状态上报没有 source——两条都要在，缺一条就会有一半场景重绑不了。
   */
  const seqFor = (t, reported) =>
    typeof reported === 'number' && reported > 0 ? reported : t.nextHookReportSeq();
  const r = (id) => ({ kind: 'id', value: id });

  // 端到端：startup(s1) → 一轮 → fork(s2) → 新会话的状态上报
  const t = new TerminalState('p1');
  setDetected(t, 'claude', 'idle', 1000);
  t.setAgentSessionRefForSessionStart('herdr:claude', 'claude', r('s1'), null, 'startup', 2000);
  t.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, r('s1'), seqFor(t, null), 3000);
  t.setHookAuthorityAt('herdr:claude', 'claude', 'idle', null, r('s1'), seqFor(t, null), 4000);

  t.setAgentSessionRefForSessionStart('herdr:claude', 'claude', r('s2'), null, 'fork', 5000);
  check('21.1 fork 后落库为新会话', t.persistedAgentSession?.sessionRef?.value, 's2');

  // fork 之后第一轮状态上报带新 id → 权威也应切过去（空 source 条目负责）
  t.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, r('s2'), seqFor(t, null), 6000);
  check('21.2 fork 后权威切到新会话', t.hookAuthority?.sessionRef?.value, 's2');
  check('21.3 投影出去的会话是新 id', t.currentSessionForPersistence()?.value, 's2');

  /*
   * 反向：不在允许表里的 source 仍不得改写会话。
   * 「fork 加进去」不能把整条通道放宽成「任何 source 都能换会话」。
   */
  const t2 = new TerminalState('p1');
  setDetected(t2, 'claude', 'idle', 1000);
  t2.setAgentSessionRefForSessionStart('herdr:claude', 'claude', r('k1'), null, 'startup', 2000);
  t2.setHookAuthorityAt('herdr:claude', 'claude', 'working', null, r('k1'), seqFor(t2, null), 3000);
  t2.setAgentSessionRefForSessionStart('herdr:claude', 'claude', r('k2'), null, 'bogus-source', 4000);
  check('21.4 未识别/未放行的 source 不改写会话', t2.currentSessionForPersistence()?.value, 'k1');
}

// ---------------------------------------------------------------------------
// 22. 完成判定是否交给 hook（screenCompletionIgnored）
// ---------------------------------------------------------------------------
{
  /*
   * claude 纳入「完成只认 hook」：v5 集成用 Stop 上报 idle，屏幕不再参与完成判定。
   * 此前它是误响的主要来源——`/resume`、`/clear` 载入会话时屏幕必然经历一次
   * working → idle（载入态），于是每切一次会话就响一次完成提示音。
   *
   * 前提由 router 的 agentCompletionFromHooks 兜：它额外要求 hookStatuses 为
   * `installed`，所以没装/没更新集成时仍然走屏幕判定，不会静默丢提示音。
   */
  check('22.1 claude 的完成交给 hook', screenCompletionIgnored('claude'), true);
  check('22.2 antigravity 仍交给 hook', screenCompletionIgnored('antigravity'), true);
  check(
    '22.3 其它 agent 不受影响（仍由屏幕判定）',
    ['codex', 'kimi', 'droid', 'opencode', 'pi', 'qwen'].map((a) => screenCompletionIgnored(a)),
    [false, false, false, false, false, false],
  );
  check('22.4 未知 agent 不被抑制', screenCompletionIgnored(null), false);

  /*
   * 启动窗口（初始化不产生状态变化）只对 antigravity 启用：它的初始化是一段纯加载。
   * claude 的输入框首帧就出现，开窗口收益接近零、却会在页脚规则不匹配时压住第一轮。
   */
  check(
    '22.5 启动窗口只对 antigravity 启用',
    ['antigravity', 'claude', 'codex', 'opencode'].map((a) => screenStartupIgnored(a)),
    [true, false, false, false],
  );
  check('22.6 启动窗口不误伤未知 agent', screenStartupIgnored(null), false);
}

// ---------------------------------------------------------------------------
// 23. antigravity 就绪信号（visibleIdle）：启动窗口的关闭依据
// ---------------------------------------------------------------------------
{
  /*
   * 这条 idle 规则的唯一用途是给状态机一个「CLI 已就绪」的可见信号
   * （见 terminal-state 的 agentStartupInProgress）。判 idle 本身不依赖它
   * （无命中时本就会回落 idle），但启动窗口需要它来判定初始化结束。
   */
  const ready = ['> 写一个 hello world', '', '? for shortcuts'].join('\n');
  const readyDetection = evaluateManifest(MANIFESTS.antigravity, {
    screen: ready,
    oscTitle: '',
    oscProgress: '',
  });
  check('23.1 就绪页脚 → idle + visibleIdle', [readyDetection.state, readyDetection.visibleIdle], ['idle', true]);

  // 工作中（spinner 压在页脚上方）visibleIdle 必须为 false，否则启动窗口会在加载中误关
  const working = ['⠋ streaming response', '> 写一个 hello world', '', '? for shortcuts'].join('\n');
  const workingDetection = evaluateManifest(MANIFESTS.antigravity, {
    screen: working,
    oscTitle: '',
    oscProgress: '',
  });
  check('23.2 工作中 visibleIdle=false', [workingDetection.state, workingDetection.visibleIdle], ['working', false]);

  // 空白/半帧（进程刚拉起）：无规则命中 → fallback idle，但不能当成就绪
  const blank = evaluateManifest(MANIFESTS.antigravity, { screen: 'loading…', oscTitle: '', oscProgress: '' });
  check('23.3 半帧屏幕不算就绪', [blank.state, blank.visibleIdle], ['idle', false]);
}

// ---------------------------------------------------------------------------
// 24. CLI 启动窗口：初始化不产生状态变化
// ---------------------------------------------------------------------------
{
  /*
   * 回归：antigravity 初始化期间屏幕有 spinner / `esc to cancel`，hook 也可能在启动期
   * 触发一次 PreInvocation（都是 working）。这段 working 不是一轮工作，若照常写入状态机，
   * 初始化结束时的 working → idle 就会被判成一次「完成」——
   * 后台 pane 投影成 done（侧栏绿点），聚焦 pane 也会写一条 completionSeq。
   *
   * 期望：初始化全程状态不变（unknown），就绪页脚出现时才落到 idle，且不是完成跳变。
   */
  const t = new TerminalState('p1');
  // attachPane：命令 `agy` → 检出 agent 进程，打开启动窗口
  t.setDetectedAgentProcessAt('antigravity', 1000);
  check('24.1 拉起后状态仍是 unknown', t.state, 'unknown');

  // 初始化 spinner（屏幕 working）→ 不改状态
  setDetected(t, 'antigravity', 'working', 1100);
  check('24.2 启动窗口内屏幕 working 不参与状态', t.state, 'unknown');

  // 启动期 hook 的 PreInvocation working → 同样不参与状态
  setHook(t, 'herdr:antigravity', 'antigravity', 'working', 1, 1200);
  check('24.3 启动窗口内 hook working 不参与状态', t.state, 'unknown');

  // 初始化结束：只剩下就绪页脚（visibleIdle）→ 关窗，落到 idle
  t.setDetectedStateWithScreenSignalsAt('antigravity', 'idle', false, true, false, false, 6000);
  check('24.4 就绪后落到 idle', t.state, 'idle');

  // 此后屏幕 working 恢复正常参与状态（真实一轮）
  setDetected(t, 'antigravity', 'working', 7000);
  check('24.5 关窗后 working 恢复正常', t.state, 'working');

  // 初始化完成时的原始跳变是 unknown → idle，不是 completion（不会投影 done）
  const t2 = new TerminalState('p1');
  t2.setDetectedAgentProcessAt('antigravity', 1000);
  setDetected(t2, 'antigravity', 'working', 1100);
  const readyMutation = t2.setDetectedStateWithScreenSignalsAt(
    'antigravity',
    'idle',
    false,
    true,
    false,
    false,
    6000,
  );
  const readyChange = readyMutation.effectiveStateChange;
  check(
    '24.6 初始化完成不是完成跳变',
    readyChange !== null &&
      isCompletionTransition(readyChange.previousState, readyChange.state),
    false,
  );

  // 同一道防线还有 herdr 的 acquisition：进程检出后第一次落到 idle 不算完成（双保险）
  check('24.7 首次 idle 仍被 acquisition 抑制', t2.finishAgentProcessAcquisition(), true);

  // 启动窗口只对 antigravity 生效：其它 agent 的屏幕 working 照常生效
  const t3 = new TerminalState('p1');
  t3.setDetectedAgentProcessAt('claude', 1000);
  setDetected(t3, 'claude', 'working', 1100);
  check('24.8 claude 的启动期 working 照常生效', t3.state, 'working');

  const t3b = new TerminalState('p1');
  t3b.setDetectedAgentProcessAt('codex', 1000);
  setDetected(t3b, 'codex', 'working', 1100);
  check('24.9 codex 的启动期 working 照常生效', t3b.state, 'working');

  // 防御：窗口在上限后自动失效，避免屏幕 working 被永久屏蔽
  const t4 = new TerminalState('p1');
  t4.setDetectedAgentProcessAt('antigravity', 1000);
  setDetected(t4, 'antigravity', 'working', 1000 + AGENT_STARTUP_WINDOW_MS + 1);
  check('24.10 超过窗口上限后 working 生效', t4.state, 'working');

  /*
   * trust 提示（blocked）出现在初始化期间：对话框本身就是「TUI 已画出交互界面」的证据，
   * 必须关窗——否则用户答完之后，紧接着的加载层会一直被压住，状态停在 blocked 上
   * （看起来还需要操作，实际什么都不用做）。
   */
  const t5 = new TerminalState('p1');
  t5.setDetectedAgentProcessAt('antigravity', 1000);
  t5.setDetectedStateWithScreenSignalsAt('antigravity', 'blocked', true, false, false, false, 1500);
  check('24.11 trust 提示照常显示 blocked', t5.state, 'blocked');
  setDetected(t5, 'antigravity', 'working', 2000);
  check('24.12 答完对话框后的加载层照常 working', t5.state, 'working');
}

// ---------------------------------------------------------------------------
// 25. 完成投影：屏幕观测不置 done（后台 pane 的绿点回归）
// ---------------------------------------------------------------------------
{
  /*
   * router.refreshAgent 对「完成判定已交给 hook」的 agent 传入 forceSuppressCompletion，
   * 这里验证 Session 侧的投影：抑制后 seen 不变（不投影 done / 不写 completionSeq），
   * 而 hook 真正的 Stop+fullyIdle 仍然投影 done。
   */
  function backgroundAgy() {
    const session = new Session();
    const project = session.addProject({ path: 'D:\\demo', name: 'demo' });
    const agy = session.createAgent({ projectId: project.projectId, command: 'agy', label: 'antigravity' });
    // 焦点切到另一个 pane：agy 在后台
    session.createAgent({ projectId: project.projectId, command: 'claude', label: 'claude' });
    const terminal = session.getTerminal(agy.paneId);
    terminal.setDetectedAgentProcessAt('antigravity', 1000);
    return { session, terminal, paneId: agy.paneId };
  }
  const projectionOf = (session, paneId) => {
    const agent = session.snapshot().agents.find((a) => a.paneId === paneId);
    return { status: agent.status, completionSeq: agent.completionSeq };
  };

  // 后台 pane：就绪 → 屏幕 working → 屏幕 idle（工具跑完/假完成）
  const s1 = backgroundAgy();
  s1.session.applyStateChange(
    s1.paneId,
    s1.terminal.setDetectedStateWithScreenSignalsAt('antigravity', 'idle', false, true, false, false, 3000),
    true,
  );
  s1.session.applyStateChange(s1.paneId, setDetected(s1.terminal, 'antigravity', 'working', 5000), true);
  const idleMutation = setDetected(s1.terminal, 'antigravity', 'idle', 8000);
  s1.session.applyStateChange(s1.paneId, idleMutation, true);
  check('25.1 抑制完成后不投影 done', projectionOf(s1.session, s1.paneId), { status: 'idle', completionSeq: null });

  // 同样的跳变不抑制 → done（证明抑制确实起了作用，而不是别的路径导致的 idle）
  const s2 = backgroundAgy();
  s2.session.applyStateChange(
    s2.paneId,
    s2.terminal.setDetectedStateWithScreenSignalsAt('antigravity', 'idle', false, true, false, false, 3000),
    false,
  );
  s2.session.applyStateChange(s2.paneId, setDetected(s2.terminal, 'antigravity', 'working', 5000), false);
  s2.session.applyStateChange(s2.paneId, setDetected(s2.terminal, 'antigravity', 'idle', 8000), false);
  check('25.2 不抑制时投影 done', projectionOf(s2.session, s2.paneId).status, 'done');

  // hook 真正的完成不能被误伤
  const s3 = backgroundAgy();
  s3.session.applyStateChange(
    s3.paneId,
    s3.terminal.setDetectedStateWithScreenSignalsAt('antigravity', 'idle', false, true, false, false, 3000),
    false,
  );
  s3.session.applyStateChange(
    s3.paneId,
    setHook(s3.terminal, 'herdr:antigravity', 'antigravity', 'working', 1, 4000),
    false,
  );
  s3.session.applyStateChange(
    s3.paneId,
    setHook(s3.terminal, 'herdr:antigravity', 'antigravity', 'idle', 2, 6000),
    false,
  );
  const hookDone = projectionOf(s3.session, s3.paneId);
  check('25.3 hook 的真正完成仍投影 done', [hookDone.status, hookDone.completionSeq !== null], ['done', true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
