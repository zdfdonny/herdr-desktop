/*
 * hook 上报抑制账本测试。
 *
 * 这块逻辑原本是 `TerminalState` 里一张裸 Map + 7 个「就地改写」写点，
 * 其中「pending 的 seq 必须单调」这条不变式只能靠每个写点自觉维护。
 * 抽成账本后，这里逐条锁住那些不变式：
 *
 * - `suppress()` 保留已有 pending/replacement（同一次抑制被反复触发时不该丢状态）；
 * - `replace()` 整条覆盖（调用方语义是「重置为刚观察到的事实」）；
 * - `rememberPendingReplacement()` 只接受更大的 seq（迟到旧上报不得覆盖新的）；
 * - `confirmReplacementIfChanged()` 只有会话真的变了才动 pending，
 *   且 pending 指向别的会话时才丢弃。
 */

import { HookSuppressionLedger } from '../.tmp/suppression-ledger.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SRC = 'herdr-desktop:opencode';
const A = { kind: 'id', value: 'sess-a' };
const B = { kind: 'id', value: 'sess-b' };

function authority(sessionRef, state = 'working') {
  return { source: SRC, agentLabel: 'opencode', state, message: null, reportedAt: 1000, sessionRef };
}

console.log('— 1. 基本读写 —');
{
  const ledger = new HookSuppressionLedger();
  check('空账本：has 为 false', ledger.has(SRC) === false);
  check('空账本：get 为 undefined', ledger.get(SRC) === undefined);
  check('空账本：isAnchoredTo 为 false', ledger.isAnchoredTo(SRC, A) === false);

  ledger.suppress(SRC, { agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'hook-clear' });
  check('写入后可读', ledger.has(SRC) === true);
  check('锚定会话正确', ledger.isAnchoredTo(SRC, A) === true);
  check('锚定其它会话为 false', ledger.isAnchoredTo(SRC, B) === false);
  check('初始无 replacement', ledger.get(SRC).replacementSessionRef === null);
  check('初始无 pending', ledger.get(SRC).pendingReplacementReport === null);
}

console.log('— 2. suppress：保留式更新 —');
{
  const ledger = new HookSuppressionLedger();
  ledger.suppress(SRC, { agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit' });
  ledger.rememberPendingReplacement(SRC, {
    agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit',
    authority: authority(B), seq: 5,
  });
  // 再次触发同一条抑制：pending 必须保留
  ledger.suppress(SRC, { agentLabel: 'opencode', sessionRef: B, observedAt: 200, reason: 'hook-clear' });
  check('suppress 保留 pending', ledger.get(SRC).pendingReplacementReport !== null);
  check('suppress 更新 reason', ledger.get(SRC).reason === 'hook-clear');
  check('suppress 更新 observedAt', ledger.get(SRC).observedAt === 200);
}

console.log('— 3. replace：整条覆盖 —');
{
  const ledger = new HookSuppressionLedger();
  ledger.suppress(SRC, { agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit' });
  ledger.rememberPendingReplacement(SRC, {
    agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit',
    authority: authority(B), seq: 5,
  });
  ledger.confirmReplacement(SRC, B);
  ledger.replace(SRC, { agentLabel: 'opencode', sessionRef: A, observedAt: 300, reason: 'hook-clear' });
  check('replace 清掉 pending', ledger.get(SRC).pendingReplacementReport === null);
  check('replace 清掉 replacement', ledger.get(SRC).replacementSessionRef === null);
  check('replace 写入新锚点', ledger.isAnchoredTo(SRC, A) === true);
}

console.log('— 4. pending 的 seq 单调不变式 —');
{
  const ledger = new HookSuppressionLedger();
  const base = {
    agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit',
  };
  ledger.rememberPendingReplacement(SRC, { ...base, authority: authority(B), seq: 10 });
  check('首次写入生效', ledger.get(SRC).pendingReplacementReport.seq === 10);

  ledger.rememberPendingReplacement(SRC, { ...base, authority: authority(A), seq: 5 });
  check('更小的 seq 被拒绝（迟到旧上报不覆盖）', ledger.get(SRC).pendingReplacementReport.seq === 10);
  check('被拒绝时内容也不变', ledger.get(SRC).pendingReplacementReport.authority.sessionRef.value === 'sess-b');

  ledger.rememberPendingReplacement(SRC, { ...base, authority: authority(A), seq: 11 });
  check('更大的 seq 生效', ledger.get(SRC).pendingReplacementReport.seq === 11);
  check('内容随之更新', ledger.get(SRC).pendingReplacementReport.authority.sessionRef.value === 'sess-a');

  ledger.rememberPendingReplacement(SRC, { ...base, authority: authority(B), seq: 11 });
  check('相同 seq 被拒绝（严格大于）', ledger.get(SRC).pendingReplacementReport.authority.sessionRef.value === 'sess-a');
}

console.log('— 5. confirmReplacement vs confirmReplacementIfChanged —');
{
  const ledger = new HookSuppressionLedger();
  ledger.suppress(SRC, { agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit' });
  ledger.rememberPendingReplacement(SRC, {
    agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit',
    authority: authority(B), seq: 5,
  });
  ledger.confirmReplacement(SRC, B);
  check('confirmReplacement 写下 replacement', ledger.get(SRC).replacementSessionRef.value === 'sess-b');
  check('confirmReplacement 清掉 pending', ledger.get(SRC).pendingReplacementReport === null);

  // IfChanged：同一会话 → 完全不动
  ledger.rememberPendingReplacement(SRC, {
    agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit',
    authority: authority(A), seq: 9,
  });
  ledger.confirmReplacementIfChanged(SRC, B);
  check('IfChanged：会话相同时不动 pending', ledger.get(SRC).pendingReplacementReport !== null);

  // IfChanged：换成新会话 → 更新锚点
  ledger.confirmReplacementIfChanged(SRC, A);
  check('IfChanged：会话变化时更新 replacement', ledger.get(SRC).replacementSessionRef.value === 'sess-a');
  check('IfChanged：pending 指向同一会话时保留', ledger.get(SRC).pendingReplacementReport !== null);

  // 让 pending 指向「另一个」会话，再确认替换到 A → 该 pending 应被丢弃
  const l3 = new HookSuppressionLedger();
  l3.suppress(SRC, { agentLabel: 'opencode', sessionRef: B, observedAt: 100, reason: 'process-exit' });
  l3.rememberPendingReplacement(SRC, {
    agentLabel: 'opencode', sessionRef: B, observedAt: 100, reason: 'process-exit',
    authority: authority(A), seq: 7,
  });
  l3.confirmReplacementIfChanged(SRC, B);
  check('IfChanged：pending 指向别的会话时被丢弃', l3.get(SRC).pendingReplacementReport === null);
  check('IfChanged：锚点已更新到 B', l3.get(SRC).replacementSessionRef.value === 'sess-b');

  // pending 指向同一会话 → 保留
  const l2 = new HookSuppressionLedger();
  l2.suppress(SRC, { agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit' });
  l2.rememberPendingReplacement(SRC, {
    agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit',
    authority: authority(B), seq: 5,
  });
  l2.confirmReplacementIfChanged(SRC, B);
  check('IfChanged：pending 与目标同会话时保留', l2.get(SRC).pendingReplacementReport !== null);
}

console.log('— 6. forget / clear / 遍历 —');
{
  const ledger = new HookSuppressionLedger();
  ledger.suppress(SRC, { agentLabel: 'opencode', sessionRef: A, observedAt: 100, reason: 'process-exit' });
  ledger.suppress('herdr-desktop:kimi', {
    agentLabel: 'kimi', sessionRef: null, observedAt: 100, reason: 'hook-clear',
  });
  check('all() 条数正确', ledger.all().length === 2);
  check('values() 条数正确', ledger.values().length === 2);

  ledger.forget(SRC);
  check('forget 后 has 为 false', ledger.has(SRC) === false);
  check('forget 只删指定来源', ledger.has('herdr-desktop:kimi') === true);

  ledger.clear();
  check('clear 后为空', ledger.all().length === 0);
}

console.log('— 7. 对不存在的来源操作是安全的 —');
{
  const ledger = new HookSuppressionLedger();
  let threw = false;
  try {
    ledger.confirmReplacement('nope', A);
    ledger.confirmReplacementIfChanged('nope', A);
    ledger.forget('nope');
  } catch {
    threw = true;
  }
  check('未登记来源上调用不抛错', threw === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
