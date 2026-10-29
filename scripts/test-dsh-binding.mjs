/*
 * dsh 会话 → pane 绑定表测试（R3）。
 *
 * 这张表决定「一条会话状态上报该路由给哪个 pane」。路由错了的表现是
 * 「A 面板的状态跳到 B 面板」，属于最难靠肉眼发现的一类 bug，因此值得逐条锁定。
 */

import { DshSessionBinding } from '../.tmp/dsh-binding.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('— 1. 基本绑定 —');
{
  const b = new DshSessionBinding();
  check('未绑定时查不到 pane', b.panesFor('s1').length === 0);

  check('首次绑定需要重放', b.bind('p1', 's1') === true);
  check('绑定后可反查', b.panesFor('s1').join(',') === 'p1');
  check('一个会话一个条目', b.sessionCount === 1);
}

console.log('— 2. 一个会话可被多个 pane 同时查看 —');
{
  const b = new DshSessionBinding();
  b.bind('p1', 's1');
  b.bind('p2', 's1');
  const panes = b.panesFor('s1').sort();
  check('两个 pane 都绑定在同一会话上', panes.join(',') === 'p1,p2');
  check('仍只有一个会话条目', b.sessionCount === 1);
}

console.log('— 3. 一个 pane 只能绑一个会话（换绑要摘掉旧的）—');
{
  const b = new DshSessionBinding();
  b.bind('p1', 's1');
  b.bind('p1', 's2');
  check('旧会话下已无该 pane', b.panesFor('s1').length === 0);
  check('新会话下有该 pane', b.panesFor('s2').join(',') === 'p1');
}

console.log('— 4. 换绑时的空集合会被清理（防 Map 无界增长）—');
{
  const b = new DshSessionBinding();
  b.bind('p1', 's1');
  b.bind('p1', 's2');
  check('旧会话条目被清掉', b.sessionCount === 1);
  b.bind('p1', 's3');
  check('连续换绑不累积条目', b.sessionCount === 1);
}

console.log('— 5. null 表示解绑，且不需要重放 —');
{
  const b = new DshSessionBinding();
  b.bind('p1', 's1');
  check('解绑不请求重放', b.bind('p1', null) === false);
  check('解绑后查不到', b.panesFor('s1').length === 0);
  check('解绑后条目被清理', b.sessionCount === 0);
}

console.log('— 6. 同一会话重复绑同一个 pane 是幂等的 —');
{
  const b = new DshSessionBinding();
  b.bind('p1', 's1');
  b.bind('p1', 's1');
  check('不会重复记录', b.panesFor('s1').length === 1);
}

console.log('— 7. pane 关闭：从所有会话摘除 —');
{
  const b = new DshSessionBinding();
  b.bind('p1', 's1');
  b.bind('p1', 's2'); // p1 换绑到 s2
  b.bind('p2', 's2');
  b.unbindPane('p1');
  check('p1 不再出现在 s2', b.panesFor('s2').join(',') === 'p2');
  check('其它 pane 不受影响', b.panesFor('s2').includes('p2'));
}

console.log('— 8. 无界增长防护：大量 pane 关闭后条目数回落 —');
{
  const b = new DshSessionBinding();
  for (let i = 0; i < 50; i++) b.bind(`p${i}`, `s${i}`);
  check('50 个会话条目', b.sessionCount === 50);
  for (let i = 0; i < 50; i++) b.unbindPane(`p${i}`);
  check('全部解绑后无残留条目', b.sessionCount === 0);
}

console.log('— 9. panesFor 返回副本，外部改动不污染内部 —');
{
  const b = new DshSessionBinding();
  b.bind('p1', 's1');
  const copy = b.panesFor('s1');
  copy.push('bogus');
  copy.length = 0;
  check('内部绑定未被外部改动影响', b.panesFor('s1').join(',') === 'p1');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
