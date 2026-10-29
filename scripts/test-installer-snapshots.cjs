/*
 * 安装器配置改写快照测试。
 *
 * `integration/index.ts` 里最容易写坏、也最难人工验证的部分就是这些函数 ——
 * 它们直接改写用户机器上的 settings.json / config.toml / config.yaml。
 * 重构前这块**完全没有测试**，任何改动只能靠手装一遍看效果。
 *
 * 这里锁的是**输出内容的精确形状**（不是「大致对」）：
 * 事件名、command 串、timeout 位置、去重行为、清理行为。
 * 任何一处漂移都会改变用户配置，必须显式确认。
 */

const {
  commandFor,
  ensureDirectHook,
  ensureFlatHook,
  ensureHook,
  ensureHooksObject,
  ensureNestedHook,
  ensureSimpleHook,
  hookCommand,
  hookMatches,
  hooksObjectIfPresent,
  removeHook,
  tomlString,
  removeKimiBlock,
  kimiConfigWithHook,
  codexConfigWithHook,
  grokHookConfig,
  updateHermesEnabled,
} = require('../.tmp/installer-snapshots.cjs');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
/** 深比较（输出是纯 JSON 结构，用序列化即可）。 */
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `\n    实际: ${a}\n    期望: ${e}`);
}

const SCRIPT = '/home/u/.claude/hooks/herdr-desktop-agent-state.sh';

console.log('— 1. hookCommand：平台命令串 —');
{
  /*
   * 注意：hookCommand 内部用模块加载期的 `isWindows` 决定形态，
   * 所以只断言「与当前平台一致」而不写死 bash —— 否则在 Windows 上跑会假失败。
   */
  const cmd = hookCommand(SCRIPT, 'working');
  const isWin = process.platform === 'win32';
  check('命令串包含脚本路径', cmd.includes(SCRIPT));
  check('命令串包含 action', cmd.includes('working'));
  check(isWin ? 'Windows 用 powershell' : 'POSIX 用 bash',
    isWin ? cmd.startsWith('powershell') : cmd.startsWith('bash'));
}

console.log('— 2. commandFor：encodedCommand 分支 —');
{
  const plain = commandFor({}, SCRIPT, 'session');
  check('默认形态直接用 hookCommand', plain === hookCommand(SCRIPT, 'session'));
  const encoded = commandFor({ encodedCommand: true }, SCRIPT, 'session');
  check('encodedCommand 形态不同于默认', encoded !== plain);
}

console.log('— 3. ensureHooksObject / hooksObjectIfPresent —');
{
  const root = {};
  const hooks = ensureHooksObject(root);
  check('空对象上建出 hooks', typeof hooks === 'object' && hooks !== null);
  check('hooks 被挂到 root 上', root.hooks === hooks);
  eq('hooksObjectIfPresent 取到已有对象', hooksObjectIfPresent(root), {});
  eq('hooksObjectIfPresent 对缺失返回 null', hooksObjectIfPresent({}), null);
  eq('hooksObjectIfPresent 对非对象返回 null', hooksObjectIfPresent({ hooks: 42 }), null);
}

console.log('— 4. ensureNestedHook：nested 形状 —');
{
  const hooks = {};
  ensureNestedHook(hooks, 'Stop', 'cmd-stop', { timeout: 10 });
  eq('单条 nested hook 结构', hooks.Stop, [
    { hooks: [{ type: 'command', command: 'cmd-stop', timeout: 10 }] },
  ]);

  ensureNestedHook(hooks, 'Stop', 'cmd-stop', { timeout: 10 });
  check('重复添加不产生第二条（幂等）', hooks.Stop.length === 1);
  check('重复添加不改 timeout', hooks.Stop[0].hooks[0].timeout === 10);

  ensureNestedHook(hooks, 'Stop', 'cmd-stop', { timeout: 999 });
  check('重复添加也不改已有 timeout', hooks.Stop[0].hooks[0].timeout === 10);

  ensureNestedHook(hooks, 'SessionStart', 'cmd-sess', { matcher: '^startup$', timeout: 10 });
  check('matcher 写在条目上而非内层', hooks.SessionStart[0].matcher === '^startup$');
  check('matcher 不污染内层', hooks.SessionStart[0].hooks[0].matcher === undefined);
}

console.log('— 5. ensureNestedHook：async（claude 心跳） —');
{
  const hooks = {};
  ensureNestedHook(hooks, 'PostToolUse', 'cmd-tick', { timeout: 10, background: true });
  check('background: true 写入 async: true', hooks.PostToolUse[0].hooks[0].async === true);

  const sync = {};
  ensureNestedHook(sync, 'Stop', 'cmd-stop', { timeout: 10, background: false });
  check('background: false 不写 async 字段', sync.Stop[0].hooks[0].async === undefined);

  const omitted = {};
  ensureNestedHook(omitted, 'Stop', 'cmd-stop', { timeout: 10 });
  check('未指定 background 时不写 async', omitted.Stop[0].hooks[0].async === undefined);
}

console.log('— 6. ensureFlatHook（mastracode） —');
{
  const hooks = {};
  ensureFlatHook(hooks, 'AgentStart', 'cmd-a', 10);
  const entry = hooks.AgentStart[0];
  check('flat 无内层 hooks 数组', entry.hooks === undefined);
  check('flat 带 type: command', entry.type === 'command');
  check('flat 带 timeout', entry.timeout === 10);
  check('flat 带 description 文案', typeof entry.description === 'string' && entry.description.length > 0);

  ensureFlatHook(hooks, 'AgentStart', 'cmd-a', 10);
  check('flat 幂等', hooks.AgentStart.length === 1);
}

console.log('— 7. ensureDirectHook（copilot） —');
{
  const hooks = {};
  ensureDirectHook(hooks, 'SessionStart', 'cmd-x', 10);
  const entry = hooks.SessionStart[0];
  check('direct 用 timeoutSec（秒）而非 timeout', entry.timeoutSec === 10 && entry.timeout === undefined);
  check('direct 带 type: command', entry.type === 'command');
  const platformField = entry.powershell ?? entry.bash;
  check('direct 平台字段名是 powershell 或 bash', platformField === 'cmd-x');

  ensureDirectHook(hooks, 'SessionStart', 'cmd-x', 10);
  check('direct 幂等', hooks.SessionStart.length === 1);
}

console.log('— 8. ensureSimpleHook（cursor） —');
{
  const hooks = {};
  ensureSimpleHook(hooks, 'sessionStart', 'cmd-s');
  eq('simple 结构最简：只有 command', hooks.sessionStart, [{ command: 'cmd-s' }]);

  ensureSimpleHook(hooks, 'sessionStart', 'cmd-s');
  check('simple 幂等', hooks.sessionStart.length === 1);
}

console.log('— 9. ensureHook 按 shape 分发 —');
{
  const nested = {};
  ensureHook(nested, 'nested', 'Stop', 'c', { timeout: 10 });
  check('nested 分发正确', nested.Stop[0].hooks !== undefined);
  const flat = {};
  ensureHook(flat, 'flat', 'Stop', 'c', { timeout: 10 });
  check('flat 分发正确', flat.Stop[0].hooks === undefined && flat.Stop[0].description !== undefined);
  const direct = {};
  ensureHook(direct, 'direct', 'Stop', 'c', { timeout: 10 });
  check('direct 分发正确', direct.Stop[0].timeoutSec === 10);
  const simple = {};
  ensureHook(simple, 'simple', 'Stop', 'c', {});
  eq('simple 分发正确', simple.Stop, [{ command: 'c' }]);
}

console.log('— 10. removeHook：四种形状都能删 —');
{
  const hooks = {};
  ensureNestedHook(hooks, 'Stop', 'c1', { timeout: 10 });
  ensureFlatHook(hooks, 'Stop', 'c2', 10);
  check('移除 nested', removeHook(hooks, 'Stop', 'c1') === true);
  check('nested 移除后该事件只剩 flat 条目',
    hooks.Stop.length === 1 && hooks.Stop[0].command === 'c2');
  check('移除 flat', removeHook(hooks, 'Stop', 'c2') === true);
  check('全部移除后事件被清空', hooks.Stop === undefined || hooks.Stop.length === 0);

  const empty = {};
  check('移除不存在的条目返回 false', removeHook(empty, 'Nope', 'c') === false);

  const direct = {};
  ensureDirectHook(direct, 'X', 'dc', 10);
  check('能移除 direct（平台字段）', removeHook(direct, 'X', 'dc') === true);

  const simple = {};
  ensureSimpleHook(simple, 'Y', 'sc');
  check('能移除 simple', removeHook(simple, 'Y', 'sc') === true);
}

console.log('— 11. hookMatches —');
{
  check('匹配 command 字段', hookMatches({ command: 'c' }, 'c') === true);
  check('不匹配别的 command', hookMatches({ command: 'd' }, 'c') === false);
  check('匹配 bash 字段', hookMatches({ bash: 'c' }, 'c') === true);
  check('匹配 powershell 字段', hookMatches({ powershell: 'c' }, 'c') === true);
  // 注意：实现是 `hook && ...`，对 null 返回 null 而非 false（短路结果），真假值等价。
  check('null 视为不匹配（falsy）', !hookMatches(null, 'c'));
}

console.log('— 12. tomlString 转义 —');
{
  check('普通字符串加引号', tomlString('abc') === '"abc"');
  check('双引号转义', tomlString('a"b') === '"a\\"b"');
  check('反斜杠转义', tomlString('a\\b') === '"a\\\\b"');
  check('换行转义', tomlString('a\nb') === '"a\\nb"');
  check('制表符转义', tomlString('a\tb') === '"a\\tb"');
  check('控制字符用 \\u 形式', tomlString('\u0001').includes('\\u0001'));
}

console.log('— 13. kimi 块改写（TOML 块标记） —');
{
  const block = kimiConfigWithHook('', '/p/h.sh', [['SessionStart', null, 'session']]);
  check('生成块起始标记', block.includes('# >>> herdr kimi integration'));
  check('生成块结束标记', block.includes('# <<< herdr kimi integration'));
  check('生成 [[hooks]] 段', block.includes('[[hooks]]'));
  check('写入 event', block.includes('event = "SessionStart"'));

  const withMatcher = kimiConfigWithHook('', '/p/h.sh', [['PreToolUse', '^X$', 'working']]);
  check('有 matcher 时写入 matcher 行', withMatcher.includes('matcher = "^X$"'));

  // 重装幂等：同一个块不该出现两次
  const twice = kimiConfigWithHook(block, '/p/h.sh', [['SessionStart', null, 'session']]);
  check('重装不产生第二个块',
    twice.split('# >>> herdr kimi integration').length - 1 === 1);

  check('保留用户已有内容', kimiConfigWithHook('user = 1\n', '/p/h.sh', [['Stop', null, 'idle']]).startsWith('user = 1'));

  // 注意：移除块后仍可能留下空白行（实现只把连续空行折叠成两个换行），故按 trim 判空。
  check('移除块后无内容残留', removeKimiBlock(block).trim() === '');
  check('移除块后保留其它内容', removeKimiBlock('a = 1\n' + block).includes('a = 1'));
  check('无块时移除是 no-op', removeKimiBlock('x = 2') === 'x = 2');
}

console.log('— 14. codexConfigWithHook（[features] hooks） —');
{
  const fromEmpty = codexConfigWithHook('');
  check('空配置生成 hooks = true', /hooks\s*=\s*true/.test(fromEmpty));
  check('生成 [features] 段', fromEmpty.includes('[features]'));

  const idempotent = codexConfigWithHook(fromEmpty);
  check('重复调用不重复写入',
    (idempotent.match(/hooks\s*=\s*true/g) ?? []).length === 1);

  const withUser = codexConfigWithHook('[model]\nname = "x"\n');
  check('保留用户已有段', withUser.includes('[model]') && withUser.includes('name = "x"'));
}

console.log('— 15. grokHookConfig（独占文件） —');
{
  const cfg = grokHookConfig('/p/h.sh');
  check('有顶层 hooks', typeof cfg.hooks === 'object');
  check('注册 SessionStart 单事件', Array.isArray(cfg.hooks.SessionStart));
  const inner = cfg.hooks.SessionStart[0].hooks[0];
  check('内层是 command 类型', inner.type === 'command');
  check('内层带 timeout', inner.timeout === 10);
  check('内层命令引用了脚本路径', String(inner.command).includes('/p/h.sh'));
}

console.log('— 16. updateHermesEnabled（YAML 启用/禁用） —');
{
  const enabled = updateHermesEnabled('', true);
  check('空 YAML 上启用会写出 plugins', enabled.includes('plugins'));
  check('启用后包含插件名', enabled.includes('herdr-desktop-agent-state'));

  const disabled = updateHermesEnabled(enabled, false);
  check('禁用后不再包含插件条目', !disabled.includes('- herdr-desktop-agent-state'));

  const roundTrip = updateHermesEnabled(disabled, true);
  check('禁用再启用可以恢复', roundTrip.includes('herdr-desktop-agent-state'));

  const userContent = updateHermesEnabled('model: x\n', true);
  check('保留用户其它键', userContent.includes('model: x'));

  // 幂等：重复启用不重复加条目
  const twice = updateHermesEnabled(enabled, true);
  check('重复启用不重复添加',
    (twice.match(/- herdr-desktop-agent-state/g) ?? []).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
