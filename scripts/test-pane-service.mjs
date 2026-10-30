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
  const calls = { snapshot: 0, error: [], broadcast: [], bindDsh: [], reviveWeb: [], logs: [] };
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
    log: (tag, message) => { calls.logs.push(`${tag}: ${message}`); },
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

/*
 * 重启 / 恢复路径必须保留声明身份，否则代理注入失效。
 *
 * 回归背景：代理开关从「按启动命令」改成「按 agentId」之后，`tryRevive` 与
 * `resumeParamsFor` 重新拼的 SpawnAgentParams 忘了带 agentId，`launchEnvFor(null)`
 * 于是恒不注入 —— 新建 pane 有代理、重启后就没有，表现为「代理功能失效」。
 */
console.log('— 10. 重启路径保留 agentId，代理注入不丢 —');
{
  /** 捕获 pty.spawn 收到的 env，验证代理变量是否注入。 */
  const makeProxyWorld = (proxyAgents) => {
    const world = makeService();
    const spawned = [];
    world.pty.spawn = (_paneId, _params, env) => {
      spawned.push(env);
      return { ok: true };
    };
    world.service.settings = {
      get: () => ({ proxyUrl: 'http://127.0.0.1:10808', proxyAgents }),
    };
    return { ...world, spawned };
  };

  // 新建 pane：pendingSpawns 里存着原始 params（带 agentId），代理应注入
  {
    const { service, panes, spawned } = makeProxyWorld({ claude: true });
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'claude', args: [],
      running: false, agentId: 'claude',
    };
    service.tryRevive('p1');
    service.attach('p1');
    check('重启：开启代理的智能体拿到 HTTP_PROXY',
      spawned[0] && spawned[0].HTTP_PROXY === 'http://127.0.0.1:10808');
  }

  // 未开启代理的智能体不应注入
  {
    const { service, panes, spawned } = makeProxyWorld({ claude: true });
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'codex', args: [],
      running: false, agentId: 'codex',
    };
    service.tryRevive('p1');
    service.attach('p1');
    check('重启：未开启代理的智能体不注入 HTTP_PROXY',
      spawned[0] && spawned[0].HTTP_PROXY === undefined);
  }

  // 旧快照没有 agentId：回退到命令名归一，代理仍应生效
  {
    const { service, panes, spawned } = makeProxyWorld({ claude: true });
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'claude', args: [],
      running: false,
    };
    service.tryRevive('p1');
    service.attach('p1');
    check('重启：缺 agentId 时按命令回退，代理仍注入',
      spawned[0] && spawned[0].HTTP_PROXY === 'http://127.0.0.1:10808');
  }

  // 恢复参数路径（claude --resume）同样要带 agentId
  {
    const { service, panes, spawned, session } = makeProxyWorld({ claude: true });
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'claude', args: [],
      running: false, agentId: 'claude',
    };
    session.getTerminal = () => ({
      currentSessionForPersistence: () => ({
        source: 'herdr-desktop:claude', agent: 'claude', kind: 'id', value: 'sess-1',
      }),
      detectedAgent: null,
    });
    const params = service.resumeParamsFor(panes.p1);
    // 用 pane 自己的声明身份做期望值，避免在测试里写死某个 agent id
    // （check:agent-boundaries 会把它当成业务侧的 agent 特例分支）。
    check('resumeParamsFor 带上 pane 的声明 agentId',
      params !== null && params.agentId === panes.p1.agentId);
    check('resumeParamsFor 生成恢复参数',
      params && params.args.includes('--resume') && params.args.includes('sess-1'));
  }

  /*
   * 普通终端：它不是智能体（`SpawnAgentParams.agentId` 为 null），但设置页照样给它
   * 一个代理开关，键是 `TERMINAL_PRESET_ID`。只按 agentId 查会导致「开了也不生效」，
   * 这正是「代理功能失效」的一部分。
   */
  {
    const { service, panes, spawned } = makeProxyWorld({ terminal: true });
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'powershell.exe', args: [],
      running: false, agentId: null,
    };
    service.tryRevive('p1');
    service.attach('p1');
    check('重启：普通终端按 terminal 键注入代理',
      spawned[0] && spawned[0].HTTP_PROXY === 'http://127.0.0.1:10808');
  }

  // 终端开关关闭时不注入
  {
    const { service, panes, spawned } = makeProxyWorld({ claude: true });
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'powershell.exe', args: [],
      running: false, agentId: null,
    };
    service.tryRevive('p1');
    service.attach('p1');
    check('重启：只开了 claude 时终端不注入代理',
      spawned[0] && spawned[0].HTTP_PROXY === undefined);
  }

  /*
   * 诊断日志：代理只在 spawn 时注入，出问题只能事后查日志。没有这行日志时
   * 「没注入」与「注入了但代理不通」无法区分，所以它是可排障性的一部分。
   * 日志不得包含代理地址（可能含凭据）。
   */
  {
    const { service, panes, calls } = makeProxyWorld({ claude: true });
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'claude', args: [],
      running: false, agentId: 'claude',
    };
    service.tryRevive('p1');
    service.attach('p1');
    const line = calls.logs.find((l) => l.startsWith('proxy:'));
    check('诊断日志：注入成功时记录 pane 与键',
      line !== undefined && line.includes('pane=p1') && line.includes('key=claude') &&
        line.includes('injected=true'));
    check('诊断日志：不含代理地址（避免凭据入日志）',
      line !== undefined && !line.includes('10808'));
  }

  // 未开启时日志要给出原因，便于判断是「没配地址」还是「开关没开」
  {
    const { service, panes, calls } = makeProxyWorld({});
    panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'claude', args: [],
      running: false, agentId: 'claude',
    };
    service.tryRevive('p1');
    service.attach('p1');
    const line = calls.logs.find((l) => l.startsWith('proxy:'));
    check('诊断日志：未开启时记录 reason=agent-off',
      line !== undefined && line.includes('injected=false') && line.includes('reason=agent-off'));
  }

  // 没有配置代理地址时，原因是 no-url
  {
    const world = makeService();
    world.pty.spawn = () => ({ ok: true });
    world.service.settings = { get: () => ({ proxyUrl: '', proxyAgents: { claude: true } }) };
    world.panes.p1 = {
      paneId: 'p1', projectId: 'proj', command: 'claude', args: [],
      running: false, agentId: 'claude',
    };
    world.service.tryRevive('p1');
    world.service.attach('p1');
    const line = world.calls.logs.find((l) => l.startsWith('proxy:'));
    check('诊断日志：未配置地址时记录 reason=no-url',
      line !== undefined && line.includes('reason=no-url'));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);