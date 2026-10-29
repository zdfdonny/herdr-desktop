/*
 * 状态仲裁判定规则测试（R2）。
 *
 * 这两条规则原先内联在 `IpcRouter.arbitrateState` / `notifyIfNeeded` 里，
 * 是整个「完成提示音」链路中最容易出错、也最难验证的部分：
 * 它们决定「屏幕看到的完成，是否该被 hook 的完成压掉」。
 *
 * 抽成纯函数后可以逐条断言，不必起 Electron、不必造 PTY。
 */

import {
  screenReportsCompletion,
  shouldNotifyOnScreenTransition,
  shouldSuppressScreenCompletion,
} from '../.tmp/state-arbiter.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 造一个 EffectiveStateChange（只填判定用到的两个字段）。 */
const change = (previousState, state) => ({
  previousAgentLabel: null,
  previousKnownAgent: null,
  previousState,
  agentLabel: null,
  knownAgent: null,
  state,
});

console.log('— 1. screenReportsCompletion：哪些跳变算「完成」 —');
{
  check('working → idle 算完成', screenReportsCompletion(change('working', 'idle')));
  check('blocked → idle 算完成', screenReportsCompletion(change('blocked', 'idle')));
  check('idle → working 不算完成', !screenReportsCompletion(change('idle', 'working')));
  check('working → blocked 不算完成', !screenReportsCompletion(change('working', 'blocked')));
  check('idle → idle 不算完成', !screenReportsCompletion(change('idle', 'idle')));
  check('无变化（null）不算完成', !screenReportsCompletion(null));
  check('working → unknown 不算完成', !screenReportsCompletion(change('working', 'unknown')));
}

console.log('— 2. shouldSuppressScreenCompletion：hook 权威时压掉屏幕完成 —');
{
  const doneTransition = { from: 'working', to: 'idle' };
  check('hook 权威 + 完成跳变 → 抑制', shouldSuppressScreenCompletion(doneTransition, true));
  check('非 hook 权威 → 不抑制', !shouldSuppressScreenCompletion(doneTransition, false));
  check('无跳变 → 不抑制', !shouldSuppressScreenCompletion(null, true));
  check('working 开始的跳变到 working → 不抑制',
    !shouldSuppressScreenCompletion({ from: 'idle', to: 'working' }, true));
  check('blocked → idle 也算完成，应抑制',
    shouldSuppressScreenCompletion({ from: 'blocked', to: 'idle' }, true));
}

console.log('— 3. 投影成 done 的后台 pane 也必须被抑制 —');
{
  /*
   * 关键回归点：`paneAgentStatus` 会把「未聚焦 pane 的完成」投影成 done，
   * 若抑制规则只匹配 idle，后台 pane 就会漏过抑制、照旧乱响完成提示音。
   */
  check('working → done（后台 pane）应抑制',
    shouldSuppressScreenCompletion({ from: 'working', to: 'done' }, true));
  check('blocked → done（后台 pane）应抑制',
    shouldSuppressScreenCompletion({ from: 'blocked', to: 'done' }, true));
}

console.log('— 4. shouldNotifyOnScreenTransition：与抑制互为反义 —');
{
  const doneTransition = { from: 'working', to: 'idle' };
  check('抑制时不通知', !shouldNotifyOnScreenTransition(doneTransition, true));
  check('不抑制时通知', shouldNotifyOnScreenTransition(doneTransition, false));
  check('无跳变时仍通知（交给下游判断）', shouldNotifyOnScreenTransition(null, false));

  // 全组合一致性：通知 = !抑制
  const transitions = [
    null,
    { from: 'working', to: 'idle' },
    { from: 'working', to: 'done' },
    { from: 'blocked', to: 'idle' },
    { from: 'idle', to: 'working' },
    { from: 'working', to: 'blocked' },
  ];
  let consistent = true;
  for (const t of transitions) {
    for (const hookOwns of [true, false]) {
      const suppress = shouldSuppressScreenCompletion(t, hookOwns);
      const notify = shouldNotifyOnScreenTransition(t, hookOwns);
      if (notify === suppress) consistent = false;
    }
  }
  check('所有组合下「通知」与「抑制」互补', consistent);
}

console.log('— 5. 真实场景：claude 装了集成 vs 没装 —');
{
  /*
   * claude 的 policy 是 screenOwnsCompletion=false（完成交给 hook）。
   * - 装了集成：屏幕的 completion 被压掉，等 hook 上报 idle 才响；
   * - 没装集成：hook 永远不会报 idle，必须放行屏幕判定，否则它再也不会响。
   */
  const screenSawDone = { from: 'working', to: 'idle' };
  check('装了集成：屏幕完成被抑制', shouldSuppressScreenCompletion(screenSawDone, true));
  check('没装集成：屏幕完成放行', !shouldSuppressScreenCompletion(screenSawDone, false));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
