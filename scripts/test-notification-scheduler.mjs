/*
 * 通知调度器测试。
 *
 * 这块逻辑原先内联在 `IpcRouter` 里（6 个方法 + 3 个常量 + 一个 interval），
 * 无法单独测试 —— 要验证「延迟投递 + 证据复核」得真跑一个 Electron 应用。
 *
 * 抽出后可以注入假时钟与假状态源，逐条验证三个不变量：
 * 1. **冷却去重**：同一 pane 的连续跳变只保留最后一条；
 * 2. **证据复核**：投递时状态不符则不投递；
 * 3. **宽限期**：状态在宽限期内落定则重试，超过则丢弃（防抖动无限重试）。
 */

import { NotificationScheduler } from '../.tmp/notification-scheduler.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 造一个可控时钟 + 状态源。 */
function makeHarness(states = {}) {
  const delivered = [];
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;

  const scheduler = new NotificationScheduler({
    deliveryDelayMs: 1000,
    evidenceGraceMs: 1000,
    tickMs: 50,
    currentState: (paneId) => (paneId in states ? states[paneId] : null),
    deliver: (item) => delivered.push({ ...item }),
  });

  return {
    scheduler,
    delivered,
    states,
    advance(ms) {
      now += ms;
    },
    restore() {
      Date.now = realNow;
      scheduler.dispose();
    },
  };
}

console.log('— 1. 冷却去重 —');
{
  const h = makeHarness({ p1: 'blocked' });
  h.scheduler.enqueue('p1', 'blocked');
  h.scheduler.enqueue('p1', 'done');
  h.scheduler.enqueue('p1', 'blocked');
  check('同一 pane 只保留一条待投递', h.scheduler.size === 1);
  h.restore();
}

console.log('— 5. dispose 清理 —');
{
  const h = makeHarness({ p1: 'blocked' });
  h.scheduler.enqueue('p1', 'blocked');
  check('dispose 前有队列', h.scheduler.size === 1);
  h.scheduler.dispose();
  check('dispose 后队列清空', h.scheduler.size === 0);
  h.restore();
}

console.log('— 6. 真实定时器路径：状态就绪后投递 —');
{
  // 这一段用真实定时器（缩短参数），验证 tick 循环本身。
  const delivered = [];
  const states = { p1: 'idle' };
  const scheduler = new NotificationScheduler({
    deliveryDelayMs: 5,
    evidenceGraceMs: 200,
    tickMs: 5,
    currentState: (paneId) => states[paneId] ?? null,
    deliver: (item) => delivered.push(item),
  });
  scheduler.enqueue('p1', 'done');
  await new Promise((r) => setTimeout(r, 60));
  check('状态就绪后确实投递了', delivered.length === 1);
  check('投递的状态正确', delivered[0]?.status === 'done');
  check('队列已清空', scheduler.size === 0);
  scheduler.dispose();
}

console.log('— 7. 真实定时器路径：状态抖动则丢弃 —');
{
  const delivered = [];
  const states = { p1: 'working' }; // 一直不符
  const scheduler = new NotificationScheduler({
    deliveryDelayMs: 5,
    evidenceGraceMs: 30,
    tickMs: 5,
    currentState: (paneId) => states[paneId] ?? null,
    deliver: (item) => delivered.push(item),
  });
  scheduler.enqueue('p1', 'done');
  await new Promise((r) => setTimeout(r, 120));
  check('状态始终不符时不投递', delivered.length === 0);
  check('超过宽限期后队列被清空', scheduler.size === 0);
  scheduler.dispose();
}

console.log('— 8. 真实定时器路径：pane 关闭则丢弃 —');
{
  const delivered = [];
  const scheduler = new NotificationScheduler({
    deliveryDelayMs: 5,
    evidenceGraceMs: 100,
    tickMs: 5,
    currentState: () => null, // pane 已关闭
    deliver: (item) => delivered.push(item),
  });
  scheduler.enqueue('p1', 'blocked');
  await new Promise((r) => setTimeout(r, 50));
  check('pane 关闭时不投递', delivered.length === 0);
  check('pane 关闭时队列被清空', scheduler.size === 0);
  scheduler.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
