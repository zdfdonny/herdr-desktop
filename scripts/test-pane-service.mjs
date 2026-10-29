/*
 * PaneLifecycleService 的两阶段状态机测试（R4）。
 *
 * 这个服务原先在 `IpcRouter` 里，与 PTY/会话/渲染推送深度耦合，**没有任何直接测试**。
 * 抽出后可以用极小的假对象验证「中间态」的不变量 —— 而这正是最易出错的部分：
 * 两阶段创建的 pending 集合一旦泄漏或提前清空，表现是「首屏排版错位」
 * 或「attach 空手而归、进程永远不起来」，都很难从症状回溯到原因。
 *
 * 这里只测状态簿记与短路条件，不测真实 spawn 流程（那需要真 PTY）。
 */

import { PaneLifecycleService } from '../.tmp/pane-service.mjs';
import { RevivingPanes } from '../.tmp/pane-service.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 造一个最小可用的服务：只测不依赖真实协作者的路径。 */
function makeService(overrides = {}) {
  const calls = { snapshot: 0, error: [], broadcast: [], bindDsh: [], reviveWeb: [] };
  const panes = {};
  const session = {
    getPane: (id) => panes[id] ?? null,
    snapshot: () => ({ focusedPaneId: null }),
    getTerminal: () => null,
    setPaneRunning: () => {},
    addProject: () => {},
    removeProject: () => [],
    ...overrides.session,
  };
  const pty = { has: () => false, kill: () => {}, spawn: () => ({ ok: true }) };
  const web = { release: () => {} };
  const settings = { get: () => ({ proxyUrl: '', proxyAgents: {} }) };
  const reportServer = { reportUrl: null };
  const reviving = new RevivingPanes();
  const host = {
    pushSnapshot: () => { calls.snapshot += 1; },
    pushError: (key) => { calls.error.push(key); },
    broadcast: (m) => { calls.broadcast.push(m); },
    bindDshSession: (paneId, sid) => { calls.bindDsh.push([paneId, sid]); },
    tryReviveWeb: () => { calls.reviveWeb.push(1); return false; },
    unregisterWorkspace: () => {},
  };
  const service = new PaneLifecycleService(
    session, pty, web, settings, reportServer, reviving, host,
  );
  return { service, calls, panes, reviving, session, pty };
}

console.log('— 1. 两阶段创建的中间态簿记 —');
{
  const { service } = makeService();
  check('初始无 pending spawn', service.hasPendingSpawn('p1') === false);

  service.stashPendingSize('p1', 120, 40);
  check('暂存尺寸不会让 pane 变成 pending spawn', service.hasPendingSpawn('p1') === false);
}

console.log('— 2. attach 在无暂存参数时是 no-op —');
{
  const { service, calls } = makeService();
  service.attach('p1');
  check('无参数时不推快照', calls.snapshot === 0);
  check('无参数时不报错', calls.error.length === 0);
}

console.log('— 3. spawn 缺 projectId 时报错且不创建 —');
{
  const { service, calls } = makeService();
  service.spawn({ projectId: '', command: 'claude', args: [] });
  check('报出 noProject 错误', calls.error.includes('error.noProject'));
  check('不推送快照', calls.snapshot === 0);
}

console.log('— 4. addProject 缺 path 时短路 —');
{
  const { service, calls } = makeService();
  service.addProject({ path: '' });
  check('缺 path 不推快照', calls.snapshot === 0);
}

console.log('— 5. removeProject 推一次快照 —');
{
  const { service, calls } = makeService();
  service.removeProject('proj-1');
  check('removeProject 后推送快照', calls.snapshot === 1);
}

console.log('— 6. tryRevive 的短路条件 —');
{
  const { service, panes, pty, reviving } = makeService();
  check('pane 不存在 → false', service.tryRevive('nope') === false);

  panes.p1 = { paneId: 'p1', projectId: 'proj', command: 'claude', running: true };
  check('已在运行 → false（force=false）', service.tryRevive('p1') === false);

  panes.p2 = { paneId: 'p2', projectId: 'proj', command: 'claude', running: false };
  pty.has = () => true;
  check('pty 已存在 → false', service.tryRevive('p2') === false);

  // 无 command 的旧格式 pane 不恢复
  panes.p3 = { paneId: 'p3', projectId: 'proj', command: '', running: false };
  pty.has = () => false;
  check('无启动命令 → false', service.tryRevive('p3') === false);
  check('未标记 recovering', reviving.size === 0);
}

console.log('— 7. tryRevive 成功时进入 recovering 并置 running —');
{
  const { service, panes, pty, reviving, session } = makeService();
  let runningSet = null;
  session.setPaneRunning = (id, value) => { runningSet = [id, value]; };
  panes.p1 = { paneId: 'p1', projectId: 'proj', command: 'claude', args: [], running: false };
  pty.has = () => false;

  const ok = service.tryRevive('p1');
  check('恢复成功返回 true', ok === true);
  check('标记 recovering', reviving.has('p1') === true);
  check('置 running', runningSet && runningSet[0] === 'p1' && runningSet[1] === true);
  check('进入 pending spawn（等 attach 取走）', service.hasPendingSpawn('p1') === true);
}

console.log('— 8. killForRestart 清理两阶段中间态 —');
{
  /*
   * 必须在**同一个实例**上先 tryRevive 再 killForRestart，才能验证「清理」本身。
   * 早先这里用了两个不同的 makeService()：一个产生中间态、另一个调 killForRestart，
   * 于是「清理后为空」从未被真的断言过 —— 功能退化时测试依然全绿。
   */
  const { service, panes, pty, reviving, calls } = makeService();
  panes.p1 = { paneId: 'p1', projectId: 'proj', command: 'claude', args: [], running: false };
  pty.has = () => false;

  service.tryRevive('p1');
  check('清理前有 pending', service.hasPendingSpawn('p1') === true);
  check('清理前在 recovering', reviving.has('p1') === true);

  service.killForRestart('p1', false);

  check('killForRestart 后 pending 被清空', service.hasPendingSpawn('p1') === false);
  check('killForRestart 后 recovering 被清空', reviving.has('p1') === false);
  check(
    '非 web pane 重启会广播 PTY_RESET',
    calls.broadcast.filter((m) => String(m.type).includes('pty:reset')).length === 1,
  );
}

console.log('— 8b. web pane 的 killForRestart 只解除引用、不杀共享进程 —');
{
  const { service, panes, calls } = makeService();
  panes.p1 = { paneId: 'p1', projectId: 'proj', command: 'dsh web', args: [], running: true };
  service.killForRestart('p1', true);
  // 共享进程只有一个，结束它会把所有 web pane 的服务端一起重启，因此不广播 reset
  check(
    'web pane 不广播 PTY_RESET',
    calls.broadcast.filter((m) => String(m.type).includes('pty:reset')).length === 0,
  );
}

console.log('— 9. RevivingPanes 语义 —');
{
  const r = new RevivingPanes();
  check('初始为空', r.has('p1') === false && r.size === 0);
  r.add('p1');
  check('add 后可查', r.has('p1') === true && r.size === 1);
  r.add('p1');
  check('重复 add 不增大', r.size === 1);
  r.delete('p1');
  check('delete 后清空', r.has('p1') === false && r.size === 0);
  r.delete('p1');
  check('重复 delete 安全', r.size === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
