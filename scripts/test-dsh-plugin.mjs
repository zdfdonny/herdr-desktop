/*
 * dsh 状态插件的行为测试（对应 herdr-desktop 的 web pane 状态来源）。
 *
 * 直接 import 真实资产 `electron/agents/assets/dsh/herdr-desktop-agent-state.mjs`，
 * 用假 ctx 驱动它的事件处理器，断言它向 Main 上报了什么。
 *
 * 为什么必须有这个测试：dsh 的状态**只来自这个插件**（web pane 没有屏幕可检测），
 * 而它的输入是 dsh 内部的 agent/session 事件 —— 差别只在「哪些会话算数」。
 * 曾经的真实故障：子会话（subagent）与父会话并发运行，子会话结束时也报 idle，
 * 而主进程按 sessionId 反查不到绑定就回退到报文 paneId，于是父会话还在跑就把
 * pane 标成完成（绿色 done）。
 *
 * 用法: npm run test:dsh-plugin
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// 插件在模块顶层读取这三个环境变量，必须在 import 之前设置。
process.env.HERDR_DESKTOP_REPORT_URL = 'http://127.0.0.1:1/report?token=test';
process.env.HERDR_DESKTOP_CWD = 'C:/proj';
process.env.HERDR_DESKTOP_PANE_ID = 'pane-1';

const PLUGIN_PATH = join(
  process.cwd(),
  'electron/agents/assets/dsh/herdr-desktop-agent-state.mjs',
);
const plugin = await import(pathToFileURL(PLUGIN_PATH).href);

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL  ${name}\n      期望 ${e}\n      实际 ${a}`);
  }
}

/** 捕获插件发出的上报（POST 到 REPORT_URL 的 body）。 */
const reports = [];
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.includes('register-workspace')) {
    return { json: async () => ({ ok: true, sessionId: null }) };
  }
  try {
    reports.push(JSON.parse(init.body));
  } catch {
    /* 非上报请求忽略 */
  }
  return { json: async () => ({}) };
};

const handlers = new Map();
const ctx = {
  on: (name, fn) => handlers.set(name, fn),
  inject: () => {},
};
const emit = (name, ...args) => {
  const fn = handlers.get(name);
  if (fn) fn(...args);
};

/** 最后一条上报（无上报返回 null）。 */
const last = () => (reports.length === 0 ? null : reports[reports.length - 1]);
/** 清空捕获，便于断言「这一步产生了哪些上报」。 */
const reset = () => {
  reports.length = 0;
};
/** 断言某次上报：状态 + 承载的 sessionId。 */
const report = () => {
  const r = last();
  return r === null ? null : `${r.state}/${r.sessionId}`;
};

const ROOT = { id: 'root-1', header: { cwd: 'C:/proj' } };
const CHILD = {
  id: 'child-1',
  header: { cwd: 'C:/proj', origin: 'subagent', parentSession: 'root-1' },
};
const CHILD_2 = {
  id: 'child-2',
  header: { cwd: 'C:/proj', origin: 'subagent', parentSession: 'root-1' },
};

plugin.apply(ctx);
emit('session/created', ROOT);
emit('session/created', CHILD);
emit('session/created', CHILD_2);

console.log('— 1. 根会话自身状态 —');
{
  reset();
  emit('api-session/status', 'root-1', true);
  check('根会话 running → working，sessionId 是根', report(), 'working/root-1');

  reset();
  emit('api-session/status', 'root-1', false);
  check('根会话 idle → idle，sessionId 是根', report(), 'idle/root-1');
}

console.log('— 2. 子会话不得单独驱动 pane（回归：父会话还在跑就报完成）—');
{
  // 父会话开始工作
  reset();
  emit('api-session/status', 'root-1', true);
  // 子会话起来
  emit('api-session/status', 'child-1', true);
  reset();
  // 子会话结束 —— 这里曾经把 pane 判成完成
  emit('api-session/status', 'child-1', false);
  check('父会话仍在跑、子会话结束 → 仍是 working，且挂在根上', report(), 'working/root-1');

  // 另一个子会话也结束
  reset();
  emit('api-session/status', 'child-2', false);
  check('第二个子会话结束 → 仍是 working', report(), 'working/root-1');

  // 子会话还在跑时，根自己报 idle 也不算完全空闲（子会话仍在工作）
  reset();
  emit('api-session/status', 'child-2', true);
  emit('api-session/status', 'root-1', false);
  check('根 idle 但仍有子会话在跑 → working', report(), 'working/root-1');

  // 子会话都结束后，根 idle 才是真的 idle
  reset();
  emit('api-session/status', 'child-2', false);
  check('子会话全部结束、根 idle → idle', report(), 'idle/root-1');
}

console.log('— 3. 子会话的阻塞要以根身份上报 —');
{
  reset();
  emit('session/event', CHILD, { type: 'approval/asked', data: { reason: 'perm' } });
  check('子会话 approval/asked → blocked，sessionId 是根', report(), 'blocked/root-1');

  /*
   * 解除阻塞后回到「根的聚合态」。此时根自己没在跑（前面第 2 段把它置成 idle 了），
   * 所以正确结果是 idle —— 关键是它必须挂在根上，而不是子会话 id。
   */
  reset();
  emit('session/event', CHILD, { type: 'approval/decided', data: {} });
  check('子会话 approval/decided → 回到根的聚合态（根此时 idle）', report(), 'idle/root-1');
}

console.log('— 4. ask_user_question 的阻塞 —');
{
  reset();
  emit('session/event', ROOT, {
    type: 'tool/call',
    data: { name: 'ask_user_question', callId: 'call-1' },
  });
  check('根会话提问待答 → blocked', report(), 'blocked/root-1');

  reset();
  emit('session/event', ROOT, {
    type: 'tool/result',
    data: { message: { toolCallId: 'call-1' } },
  });
  check('收到同一 callId 的 tool/result → 解除 blocked', report(), 'idle/root-1');

  // 根会话正在跑时，提问解除后应回到 working
  reset();
  emit('api-session/status', 'root-1', true);
  emit('session/event', ROOT, {
    type: 'tool/call',
    data: { name: 'ask_user_question', callId: 'call-2' },
  });
  reset();
  emit('session/event', ROOT, {
    type: 'tool/result',
    data: { message: { toolCallId: 'call-2' } },
  });
  check('根会话 running 时解除提问 → working', report(), 'working/root-1');
}

console.log('— 5. 子会话 disposed 重报根的聚合态，不清零根 —');
{
  reset();
  emit('api-session/status', 'root-1', true);
  emit('api-session/status', 'child-1', true);
  reset();
  emit('session/disposed', CHILD);
  check('子会话 disposed → 重报根的聚合态', report(), 'working/root-1');

  // 根被 disposed 时才显式报 idle（让 pane 回落到 idle）
  reset();
  emit('session/disposed', ROOT);
  check('根会话 disposed → 显式 idle', report(), 'idle/root-1');
}

console.log('— 6. turn 结束原因只在 idle 上报里携带 —');{
  reset();
  emit('session/event', ROOT, { type: 'turn/start', data: {} });
  emit('session/event', ROOT, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  emit('api-session/status', 'root-1', false);
  check('正常完成 → idle + completion=completed',
    [last()?.state, last()?.completion], ['idle', 'completed']);

  reset();
  emit('session/event', ROOT, { type: 'turn/start', data: {} });
  emit('session/event', ROOT, {
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
  });
  emit('api-session/status', 'root-1', true);
  emit('api-session/status', 'root-1', false);
  check('手动停止 → idle + completion=aborted',
    [last()?.state, last()?.completion], ['idle', 'aborted']);

  reset();
  emit('api-session/status', 'root-1', true);
  check('working 上报不携带 completion 字段', last()?.completion === undefined, true);
}

/*
 * 第 7 段用独立的世界重放插件（handlers/state 都是 apply() 内的闭包，
 * 混用前面的 ROOT/CHILD 会把两套会话叠在一起），覆盖两个健壮性场景：
 * - 孙会话（delegationDepth 2）：中间父会话先被销毁，仍要解析到最外层根；
 * - 子会话的头先于父会话到达：父链接一旦记下就一直可用。
 */
function freshWorld() {
  const captured = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('register-workspace')) {
      return { json: async () => ({ ok: true, sessionId: null }) };
    }
    try {
      captured.push(JSON.parse(init.body));
    } catch {
      /* ignore */
    }
    return { json: async () => ({}) };
  };
  const map = new Map();
  plugin.apply({ on: (name, fn) => map.set(name, fn), inject: () => {} });
  const fire = (name, ...args) => {
    const fn = map.get(name);
    if (fn) fn(...args);
  };
  const peek = () => {
    const r = captured.length === 0 ? null : captured[captured.length - 1];
    return r === null ? null : `${r.state}/${r.sessionId}`;
  };
  return { fire, peek, clear: () => (captured.length = 0), restore: () => (globalThis.fetch = saved) };
}

console.log('— 7. 孙会话与乱序到达 —');
{
  const world = freshWorld();
  const root = { id: 'R', header: { cwd: 'C:/proj' } };
  const mid = { id: 'M', header: { cwd: 'C:/proj', origin: 'subagent', parentSession: 'R' } };
  const leaf = { id: 'L', header: { cwd: 'C:/proj', origin: 'subagent', parentSession: 'M' } };

  // 子会话头先到、父会话后到
  world.fire('session/event', leaf, { type: 'approval/asked', data: { reason: 'leaf-perm' } });
  world.fire('session/created', root);
  world.clear();
  world.fire('api-session/status', 'R', true);
  check('孙会话的父先于根到达后，根仍能上报', world.peek(), 'working/R');

  // 中间父会话被销毁后，孙会话仍要解析到最外层根
  world.fire('session/created', mid);
  world.fire('session/created', leaf);
  // 先把最早那条 leaf 的 blocked 解除，避免它干扰后续聚合断言
  world.fire('session/event', leaf, { type: 'approval/decided', data: {} });
  world.fire('api-session/status', 'M', true);
  world.clear();
  world.fire('session/disposed', mid);
  check('中间父会话销毁 → 重报根而非中间层', world.peek(), 'working/R');

  world.clear();
  world.fire('session/event', leaf, { type: 'approval/asked', data: { reason: 'leaf-perm' } });
  check('孙会话 blocked 仍以最外层根上报', world.peek(), 'blocked/R');

  world.restore();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);