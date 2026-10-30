/*
 * JsonHooksInstaller 模板方法测试。
 *
 * 这块骨架原先内联在 `jsonHooksTarget` 的闭包里（约 65 行 install/uninstall），
 * 被 11 个智能体共用但无法单独测试 —— 因为它直接调 fs 与 `?raw` 资产内容。
 *
 * 抽成类并把 IO 注入后，这里用**内存文件系统**验证整条骨架：
 * - 安装顺序：预检 → 写产物+可执行位 → 改配置；
 * - 卸载顺序：摘登记 → 删产物；
 * - 幂等；旧事件清理；`version: 1` 维护；配置里没有 hooks 时不去凭空创建。
 */

const {
  JsonHooksInstaller,
  GrokInstaller,
  AntigravityInstaller,
  DshInstaller,
  KimiInstaller,
  HermesInstaller,
  dshPatchBlock,
  dshPatchBlockIsValid,
  upsertDshPatch,
  removeDshPatchBlock,
  removeDshPatchBlockFrom,
} = require('../.tmp/json-hooks-installer.cjs');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 内存文件系统 + 调用记录（顺序也要断言）。 */
function makeIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  return {
    files,
    calls,
    io: {
      checkConfigTarget(path) {
        calls.push(['checkConfigTarget', path]);
        if (files.get(path) === 'DIRECTORY') throw new Error('config target is a directory');
      },
      async ensureDir(dir) {
        calls.push(['ensureDir', dir]);
      },
      async writeArtifact(path, content) {
        calls.push(['writeArtifact', path]);
        files.set(path, content);
      },
      async makeExecutable(path) {
        calls.push(['makeExecutable', path]);
      },
      async removeArtifact(path) {
        calls.push(['removeArtifact', path]);
        files.delete(path);
      },
      async removeDirectory(path) {
        calls.push(['removeDirectory', path]);
        // 内存实现：删掉该目录前缀下的所有文件
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
      },
      async readJson(path) {
        calls.push(['readJson', path]);
        const raw = files.get(path);
        if (!raw || raw === 'DIRECTORY') return {};
        return JSON.parse(raw);
      },
      async writeJsonKey(path, key, value) {
        calls.push(['writeJsonKey', path, key]);
        const raw = files.get(path);
        const obj = raw && raw !== 'DIRECTORY' ? JSON.parse(raw) : {};
        obj[key] = value;
        files.set(path, JSON.stringify(obj));
      },
    },
  };
}

/** 形状操作：直接复用生产实现（保证测的是真实规则）。 */
const ops = {
  ensureHooksObject(root) {
    if (!root.hooks || typeof root.hooks !== 'object') root.hooks = {};
    return root.hooks;
  },
  hooksObjectIfPresent(root) {
    return root.hooks && typeof root.hooks === 'object' ? root.hooks : null;
  },
  ensureHook(hooks, shape, event, command, opts) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (list.some((h) => (h.hooks?.[0]?.command ?? h.command) === command)) {
      hooks[event] = list;
      return;
    }
    if (shape === 'simple') list.push({ command });
    else list.push({ hooks: [{ type: 'command', command, timeout: opts.timeout }] });
    hooks[event] = list;
  },
  removeHook(hooks, event, command) {
    const list = hooks[event];
    if (!Array.isArray(list)) return false;
    const kept = list.filter((h) => (h.hooks?.[0]?.command ?? h.command) !== command);
    if (kept.length === list.length) return false;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
    return true;
  },
};

const join = (...parts) => parts.join('/');

const LAYOUT = {
  configFile: 'settings.json',
  shape: 'nested',
  event: 'SessionStart',
  events: [
    ['SessionStart', 'session'],
    ['Stop', 'idle'],
  ],
  artifactSubdir: 'hooks',
};

/**
 * 造一个安装器。
 * @param ioWrap `{ io }`（内存 IO）或 `{ io: wrapped }` 直接给一个 IO 实现
 * @param overrides `{ layout?, ...depsOverrides }` —— layout 单独拎出来，其余覆盖 deps
 */
function makeInstaller(ioWrap, overrides = {}) {
  const { layout, ...depsOverrides } = overrides;
  const deps = {
    configDir: () => '/home/u/.claude',
    artifactPath: () => '/home/u/.claude/hooks/state.sh',
    version: () => 5,
    command: (path, action) => `bash '${path}' ${action}`,
    artifactIsInstalled: () => false,
    artifactContent: () => '#!/bin/bash\n# HERDR_DESKTOP_INTEGRATION_ID=herdr-desktop\n',
    io: ioWrap,
    ops,
    ...depsOverrides,
  };
  return new JsonHooksInstaller({ ...LAYOUT, ...(layout ?? {}) }, deps, join);
}

async function main() {
console.log('— 1. 访问器 —');
{
  const { io } = makeIo();
  const inst = makeInstaller(io);
  check('configDir 透传', inst.configDir() === '/home/u/.claude');
  check('artifactPath 透传', inst.artifactPath() === '/home/u/.claude/hooks/state.sh');
  check('version 透传', inst.version() === 5);
  check('未装时 isInstalled 为 false', inst.isInstalled() === false);
}

console.log('— 2. install 顺序与产物 —');
{
  const { io, calls, files } = makeIo();
  const inst = makeInstaller(io);
  await inst.install();
  const order = calls.map((c) => c[0]);
  check('先预检配置目标', order.indexOf('checkConfigTarget') === 0);
  check('预检早于写产物', order.indexOf('checkConfigTarget') < order.indexOf('writeArtifact'));
  check('写产物后加可执行位',
    order.indexOf('writeArtifact') < order.indexOf('makeExecutable'));
  check('改了配置', order.includes('writeJsonKey'));
  check('产物内容已写入', files.get('/home/u/.claude/hooks/state.sh').includes('INTEGRATION_ID'));
  check('产物目录被创建', calls.some((c) => c[0] === 'ensureDir' && c[1] === '/home/u/.claude/hooks'));
}

console.log('— 3. 写入配置的形状 —');
{
  const { io, files } = makeIo();
  await makeInstaller(io).install();
  const cfg = JSON.parse(files.get('/home/u/.claude/settings.json'));
  check('生成了 hooks 容器', typeof cfg.hooks === 'object');
  check('注册了 SessionStart', Array.isArray(cfg.hooks.SessionStart));
  check('注册了 Stop', Array.isArray(cfg.hooks.Stop));
  check('命令串包含 action', JSON.stringify(cfg.hooks.Stop).includes('idle'));
}

console.log('— 4. 幂等 —');
{
  const { io, files } = makeIo();
  const inst = makeInstaller(io);
  await inst.install();
  const first = files.get('/home/u/.claude/settings.json');
  await inst.install();
  check('重复安装不产生重复事件', files.get('/home/u/.claude/settings.json') === first);
}

console.log('— 5. 旧事件清理（removedEvents） —');
{
  const { io, files } = makeIo({
    '/home/u/.claude/settings.json': JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: "bash '/home/u/.claude/hooks/state.sh' working" }] }],
        // 用户自己的 hook，必须保留
        Notification: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }],
      },
    }),
  });
  const inst = makeInstaller(io, {
    layout: { removedEvents: [['PreToolUse', 'working']] },
  });
  await inst.install();
  const cfg = JSON.parse(files.get('/home/u/.claude/settings.json'));
  check('旧事件被移除', cfg.hooks.PreToolUse === undefined);
  check('用户的 hook 被保留', JSON.stringify(cfg.hooks.Notification).includes('my-own-hook'));
  check('新事件已写入', cfg.hooks.Stop !== undefined);
}

console.log('— 6. version 维护（withVersion，cursor） —');
{
  const { io, files } = makeIo();
  const inst = makeInstaller(io, {
    layout: { withVersion: true, shape: 'simple', artifactSubdir: null, configFile: 'hooks.json' },
  });
  await inst.install();
  const cfg = JSON.parse(files.get('/home/u/.claude/hooks.json'));
  check('写入 version: 1', cfg.version === 1);

  // 再次安装不应把 version 改掉
  await inst.install();
  check('重复安装不改 version', JSON.parse(files.get('/home/u/.claude/hooks.json')).version === 1);
}

console.log('— 7. uninstall —');
{
  const { io, files, calls } = makeIo();
  const inst = makeInstaller(io);
  await inst.install();
  calls.length = 0;
  await inst.uninstall();
  const order = calls.map((c) => c[0]);
  check('先读配置', order.indexOf('readJson') === 0);
  check('摘登记早于删产物', order.indexOf('writeJsonKey') < order.indexOf('removeArtifact'));
  check('产物已删除', !files.has('/home/u/.claude/hooks/state.sh'));
  const cfg = JSON.parse(files.get('/home/u/.claude/settings.json'));
  check('事件已摘除', cfg.hooks === undefined || Object.keys(cfg.hooks).length === 0);
}

console.log('— 8. 卸载时配置里没有 hooks：不去凭空创建 —');
{
  const { io, files, calls } = makeIo({
    '/home/u/.claude/settings.json': JSON.stringify({ version: 1, model: 'x' }),
  });
  await makeInstaller(io).uninstall();
  const cfg = JSON.parse(files.get('/home/u/.claude/settings.json'));
  check('不写回配置', !calls.some((c) => c[0] === 'writeJsonKey'));
  check('用户配置保持不变', cfg.model === 'x' && cfg.hooks === undefined);
}

console.log('— 9. 环境不适用时安全退出 —');
{
  const { io, calls } = makeIo();
  await makeInstaller(io, { configDir: () => null, artifactPath: () => null }).install();
  check('configDir 为 null 时不做任何操作', calls.length === 0);

  const io2 = makeIo().io;
  const calls2 = [];
  const wrapped = new Proxy(io2, {
    get: (t, k) => { calls2.push(String(k)); return t[k]; },
  });
  await makeInstaller(wrapped, { configDir: () => null }).uninstall();
  check('uninstall 同样安全退出', calls2.length === 0);
}

console.log('— 10. 预检失败时不留半安装 —');
{
  const { io, files, calls } = makeIo({
    '/home/u/.claude/settings.json': 'DIRECTORY',
  });
  let threw = false;
  try {
    await makeInstaller(io).install();
  } catch {
    threw = true;
  }
  check('预检抛错会向上传播', threw === true);
  check('没有写入产物（不留半安装）', !files.has('/home/u/.claude/hooks/state.sh'));
  check('没有改动配置', !calls.some((c) => c[0] === 'writeJsonKey'));
}

console.log('— 11. GrokInstaller：独占配置文件 + 目录预检 —');
{
  const makeGrok = (mem, exists = true) => {
    const layout = {
      configFile: 'herdr-desktop.json',
      shape: 'nested',
      event: 'SessionStart',
      events: [['SessionStart', 'session']],
      artifactSubdir: 'hooks',
    };
    const deps = {
      configDir: () => '/home/u/.grok',
      artifactPath: () => '/home/u/.grok/hooks/state.sh',
      version: () => 4,
      command: (p) => `bash '${p}' session`,
      artifactIsInstalled: () => false,
      artifactContent: () => '#!/bin/bash\n',
      io: mem.io,
      ops,
    };
    const grok = {
      isDirectory: () => exists,
      writeJson: async (path, value) => { mem.files.set(path, JSON.stringify(value)); mem.calls.push(['writeJson', path]); },
      removeFile: async (path) => { mem.files.delete(path); mem.calls.push(['removeFile', path]); },
      hookConfig: (p) => ({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: p }] }] } }),
      configIsValid: () => true,
    };
    return new GrokInstaller(layout, deps, join, grok);
  };

  // 目录不存在 → 抛错且不写任何东西
  {
    const mem = makeIo();
    let threw = false;
    try { await makeGrok(mem, false).install(); } catch { threw = true; }
    check('目录不存在时抛错', threw === true);
    check('目录不存在时不写产物', mem.calls.length === 0);
  }

  // 正常安装：只写独占 json，不碰共享配置
  {
    const mem = makeIo();
    await makeGrok(mem).install();
    check('写了独占配置 herdr-desktop.json',
      mem.files.has('/home/u/.grok/hooks/herdr-desktop.json'));
    check('没有读写共享配置文件（managesHooksConfig=false）',
      !mem.calls.some((c) => c[0] === 'writeJsonKey'));
    check('产物已写入', mem.files.has('/home/u/.grok/hooks/state.sh'));
    check('配置内容含命令',
      mem.files.get('/home/u/.grok/hooks/herdr-desktop.json').includes('/home/u/.grok/hooks/state.sh'));
  }

  // 卸载：删独占配置 + 删产物
  {
    const mem = makeIo();
    const inst = makeGrok(mem);
    await inst.install();
    mem.calls.length = 0;
    await inst.uninstall();
    check('卸载删掉独占配置', !mem.files.has('/home/u/.grok/hooks/herdr-desktop.json'));
    check('卸载删掉产物', !mem.files.has('/home/u/.grok/hooks/state.sh'));
    check('卸载不碰共享配置', !mem.calls.some((c) => c[0] === 'writeJsonKey'));
  }

  // validate 透传
  check('validate 透传配置校验', makeGrok(makeIo()).validate() === true);
}
console.log('— 12. 逐事件选项（per-event matcher / background） —');
{
  /*
   * claude 的关键行为：UserPromptSubmit / PostToolUse 走 async（否则每次工具调用
   * 都要等一次进程启动），只有 SessionStart 带 matcher。
   * 这些现在由 layout 的逐事件选项表达 —— 迁移时最容易静默丢掉的就是它。
   */
  const mem = makeIo();
  const layout = {
    configFile: 'settings.json',
    shape: 'nested',
    event: 'SessionStart',
    events: [
      ['SessionStart', 'session', { matcher: '^(startup|resume)$' }],
      ['UserPromptSubmit', 'working', { background: true }],
      ['Stop', 'idle'],
    ],
    artifactSubdir: 'hooks',
  };
  const deps = {
    configDir: () => '/home/u/.claude',
    artifactPath: () => '/home/u/.claude/hooks/state.sh',
    version: () => 5,
    command: (p, a) => `bash '${p}' ${a}`,
    artifactIsInstalled: () => false,
    artifactContent: () => '#!/bin/bash\n',
    io: mem.io,
    ops: {
      ...ops,
      // 用真实的 ensureNestedHook 语义：把 background 写进内层 async
      ensureHook(hooks, shape, event, command, opts) {
        const list = Array.isArray(hooks[event]) ? hooks[event] : [];
        if (list.some((h) => h.hooks?.[0]?.command === command)) { hooks[event] = list; return; }
        const inner = { type: 'command', command, timeout: opts.timeout };
        if (opts.background !== undefined) inner.async = opts.background;
        const entry = { hooks: [inner] };
        if (opts.matcher !== undefined) entry.matcher = opts.matcher;
        list.push(entry);
        hooks[event] = list;
      },
    },
  };
  const inst = new JsonHooksInstaller(layout, deps, join);
  await inst.install();
  const cfg = JSON.parse(mem.files.get('/home/u/.claude/settings.json'));

  check('SessionStart 带上 matcher', cfg.hooks.SessionStart[0].matcher === '^(startup|resume)$');
  check('只给 SessionStart 加 matcher（其它事件没有）',
    cfg.hooks.UserPromptSubmit[0].matcher === undefined && cfg.hooks.Stop[0].matcher === undefined);
  check('UserPromptSubmit 标记为 async（不拖慢每次工具调用）',
    cfg.hooks.UserPromptSubmit[0].hooks[0].async === true);
  check('无 background 的事件不写 async 字段',
    cfg.hooks.Stop[0].hooks[0].async === undefined);
}
console.log('— 13. AntigravityInstaller：独立块 + 目录预检 —');
{
  const makeAnti = (mem, exists = true) => {
    const layout = {
      configFile: 'hooks.json', shape: 'nested', event: 'PreInvocation',
      events: [['PreInvocation', 'session'], ['Stop', 'stop']], artifactSubdir: 'hooks',
    };
    const deps = {
      configDir: () => '/home/u/.gemini/config',
      artifactPath: () => '/home/u/.gemini/config/hooks/state.sh',
      version: () => 6,
      command: (p, a) => `powershell -EncodedCommand ${a}@${p}`,
      artifactIsInstalled: () => false,
      artifactContent: () => '#!/bin/bash\n',
      io: mem.io, ops,
    };
    const anti = {
      isDirectory: () => exists,
      readJson: async (path) => {
        const raw = mem.files.get(path);
        return raw ? JSON.parse(raw) : {};
      },
      command: (p, a) => `powershell -EncodedCommand ${a}@${p}`,
      writeJsonKey: async (path, key, value) => {
        // 模拟 modify 的「只改一个键」语义：保留其它键，且保留原文注释行。
        const raw = mem.files.get(path) ?? "";
        const withoutBlock = raw.replace(/^\s*\/\/ 用户注释.*$/m, "");
        let parsed = {};
        try { parsed = JSON.parse(withoutBlock || "{}"); } catch { parsed = {}; }
        const comments = raw.split("\n").filter((l) => l.trim().startsWith("//")).join("\n");
        parsed[key] = value;
        const body = JSON.stringify(parsed, null, 2);
        mem.files.set(path, comments ? `${comments}\n${body}` : body);
        mem.calls.push(["writeJsonKey", path, key]);
      },
      removeJsonKey: async (path, key) => {
        const raw = mem.files.get(path) ?? "{}";
        const comments = raw.split("\n").filter((l) => l.trim().startsWith("//")).join("\n");
        const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "") || "{}");
        delete parsed[key];
        const body = JSON.stringify(parsed, null, 2);
        mem.files.set(path, comments ? `${comments}\n${body}` : body);
        mem.calls.push(["removeJsonKey", path, key]);
      },
    };
    return new AntigravityInstaller(layout, deps, join, anti);
  };

  // 目录不存在 → 抛错、不写任何东西
  {
    const mem = makeIo();
    let threw = false;
    try { await makeAnti(mem, false).install(); } catch { threw = true; }
    check('antigravity：目录不存在时抛错', threw === true);
    check('antigravity：目录不存在时不写产物', mem.calls.length === 0);
  }

  // 安装：写独立块，保留用户其它块
  {
    const mem = makeIo({
      '/home/u/.gemini/config/hooks.json': JSON.stringify({ userBlock: { Keep: [] } }),
    });
    await makeAnti(mem).install();
    const cfg = JSON.parse(mem.files.get('/home/u/.gemini/config/hooks.json'));
    check('antigravity：写入 herdr-desktop 独立块', typeof cfg['herdr-desktop'] === 'object');
    check('antigravity：块里有 PreInvocation', Array.isArray(cfg['herdr-desktop'].PreInvocation));
    check('antigravity：块里有 Stop', Array.isArray(cfg['herdr-desktop'].Stop));
    check('antigravity：保留用户的其它块', cfg.userBlock !== undefined);
    check('antigravity：不写共享 hooks 数组（managesHooksConfig=false）',
      !mem.calls.some((c) => c[0] === 'ensureHook' || c[0] === 'removeHook'));
    /*
     * antigravity 用独立块（hooks.json 的 `herdr-desktop` 键），不参与共享 hooks 数组。
     * 因此判据是「不调用 ensureHook/removeHook」，而不是「不写配置」——
     * 它确实要写配置，只是写在独立键里（见 #7 修复：改用 writeJsonKey 精确改键）。
     */
  }

  /*
   * 回归 #7：antigravity 原先用 readJson + writeJson 整文件重写，
   * 会把用户自己写进 hooks.json 的注释、键顺序、缩进全部重排。
   * 现在改用 writeJsonKey（modify + applyEdits），只动 `herdr-desktop` 这一个键。
   */
  {
    const withComments = [
      '{',
      '  // 用户注释：不要动我',
      '  "userBlock": { "Keep": [] }',
      '}',
    ].join('\n');
    const mem = makeIo({ '/home/u/.gemini/config/hooks.json': withComments });
    await makeAnti(mem).install();
    const after = mem.files.get('/home/u/.gemini/config/hooks.json');
    check('antigravity：安装后保留用户注释', after.includes('// 用户注释：不要动我'));
    check('antigravity：安装后仍保留用户的其它块', after.includes('userBlock'));
  }

  // 卸载：删块 + 保留用户内容
  {
    const mem = makeIo({
      '/home/u/.gemini/config/hooks.json': JSON.stringify({
        userBlock: { Keep: [] },
        'herdr-desktop': { PreInvocation: [] },
      }),
    });
    await makeAnti(mem).uninstall();
    const cfg = JSON.parse(mem.files.get('/home/u/.gemini/config/hooks.json'));
    check('antigravity：卸载删掉自己的块', cfg['herdr-desktop'] === undefined);
    check('antigravity：卸载保留用户块', cfg.userBlock !== undefined);
  }

  // 无自己的块时不写回（避免重排用户配置）
  {
    const mem = makeIo({
      '/home/u/.gemini/config/hooks.json': JSON.stringify({ userBlock: {} }),
    });
    const before = mem.files.get('/home/u/.gemini/config/hooks.json');
    await makeAnti(mem).uninstall();
    check('antigravity：没有自己的块时不写回配置',
      mem.files.get('/home/u/.gemini/config/hooks.json') === before);
  }
}

console.log('— 14. DshInstaller：插件不需要可执行位 —');
{
  const mem = makeIo();
  const layout = {
    configFile: 'cordis.patch.yml', shape: 'nested', event: 'SessionStart',
    events: [], artifactSubdir: 'plugins',
  };
  let patched = 0;
  let removedPatch = 0;
  const deps = {
    configDir: () => '/home/u/.dsh',
    artifactPath: () => '/home/u/.dsh/plugins/state.mjs',
    version: () => 5,
    command: () => '',
    artifactIsInstalled: () => false,
    artifactContent: () => 'export default {}\n',
    io: mem.io, ops,
  };
  const dsh = {
    upsertPatch: async () => { patched += 1; },
    removePatchBlock: async () => { removedPatch += 1; },
    writePlugin: async () => {},
  };
  const inst = new DshInstaller(layout, deps, join, dsh);

  await inst.install();
  check('dsh：写了插件文件', mem.files.has('/home/u/.dsh/plugins/state.mjs'));
  check('dsh：插件不需要可执行位', !mem.calls.some((c) => c[0] === 'makeExecutable'));
  check('dsh：upsert 了 YAML 块', patched === 1);
  check('dsh：不写共享 hooks（managesHooksConfig=false）',
    !mem.calls.some((c) => c[0] === 'writeJsonKey'));

  await inst.uninstall();
  check('dsh：卸载移除 YAML 块', removedPatch === 1);
  check('dsh：卸载删掉插件', !mem.files.has('/home/u/.dsh/plugins/state.mjs'));
}

/*
 * dsh 的 `cordis.patch.yml` 块必须是 dsh 解析器能吃的形态。
 *
 * 这里锁死的是**外部契约**（`dsh-app-boot` 的 `parsePatchList` +
 * `anchorInsertedPluginNames`）：顶层是 PatchOptions 数组，每项自带 `insert`，
 * insert 条目是带 `name` 的映射且用 `./` 相对路径。
 *
 * 上一个版本把它写成了 `- patch:` + 裸字符串，整块被 dsh 静默忽略 ——
 * 插件根本没加载，dsh 状态上报与 register-workspace 路由一起消失，
 * 而当时没有任何测试覆盖这块内容（只有「调用了几次 upsert」的计数桩）。
 */
console.log('— 14b. DshInstaller：cordis.patch.yml 块符合 dsh schema —');
{
  const block = dshPatchBlock();
  check('dsh 块：顶层是 insert 数组项，不是 patch 包裹',
    block.includes('- insert:') && !block.includes('- patch:'));
  check('dsh 块：insert 条目是带 id 的映射',
    /- id: herdr-desktop-agent-state/.test(block));
  check('dsh 块：name 用 ./ 相对路径（解析器只认 ./ ../ 绝对路径）',
    /name: \.\/plugins\/herdr-desktop-agent-state\.mjs/.test(block));
  check('dsh 块：没有裸字符串条目', !/- plugins\//.test(block));

  // 用真实文件做一次 upsert / remove 往返
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-'));
  const patchPath = path.join(dir, 'cordis.patch.yml');
  try {
    fs.writeFileSync(patchPath, '- id: user-row\n  disabled: true\n', 'utf8');
    await upsertDshPatch(patchPath);
    const after = fs.readFileSync(patchPath, 'utf8');
    check('dsh 块：upsert 保留用户条目', after.includes('user-row'));
    check('dsh 块：upsert 写入 insert 形态', after.includes('- insert:'));
    check('dsh 块：upsert 只写一个块',
      after.split('# >>> herdr dsh integration').length === 2);

    // 幂等：再 upsert 一次不应重复
    await upsertDshPatch(patchPath);
    const twice = fs.readFileSync(patchPath, 'utf8');
    check('dsh 块：重复 upsert 不重复追加',
      twice.split('# >>> herdr dsh integration').length === 2);

    await removeDshPatchBlock(patchPath);
    const removed = fs.readFileSync(patchPath, 'utf8');
    check('dsh 块：移除后不留标记', !removed.includes('herdr dsh integration'));
    check('dsh 块：移除后保留用户条目', removed.includes('user-row'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 纯函数：不存在的块 → 原样返回
  check('dsh 块：无标记时 remove 不改内容',
    removeDshPatchBlockFrom('- id: x\n') === '- id: x\n');

  // validate：块写坏时必须判失效，否则 hookStatuses 会误报 installed 而无法触发修复
  check('dsh 校验：正确的块判有效', dshPatchBlockIsValid(dshPatchBlock()) === true);
  check('dsh 校验：缺少块判失效',
    dshPatchBlockIsValid('- id: user-row\n') === false);
  check('dsh 校验：patch 包裹的旧坏格式判失效',
    dshPatchBlockIsValid(
      '# >>> herdr dsh integration\n- patch:\n    - insert:\n        - plugins/x.mjs\n# <<< herdr dsh integration',
    ) === false);
  check('dsh 校验：缺 name 的条目判失效',
    dshPatchBlockIsValid(
      '# >>> herdr dsh integration\n- insert:\n    - id: x\n# <<< herdr dsh integration',
    ) === false);
  check('dsh 校验：name 少了 ./ 前缀判失效',
    dshPatchBlockIsValid(
      '# >>> herdr dsh integration\n- insert:\n    - id: x\n      name: plugins/x.mjs\n# <<< herdr dsh integration',
    ) === false);
}

/*
 * DshInstaller.validate()：真实文件路径下的三种情形。
 *
 * 关键是「产物在、但 patch 文件没了/写坏了」必须判失效 —— 否则 hookStatuses()
 * 一直报 installed，用户在集成页看不到更新入口，只能手动改文件才能恢复。
 */
console.log('— 14c. DshInstaller.validate()：产物在但注册块不可用时判失效 —');
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-validate-'));
  const patchPath = path.join(dir, 'cordis.patch.yml');

  const makeValidator = () => {
    const mem = makeIo();
    const layout = {
      configFile: 'cordis.patch.yml', shape: 'nested', event: 'SessionStart',
      events: [], artifactSubdir: 'plugins',
    };
    const deps = {
      configDir: () => dir,
      artifactPath: () => path.join(dir, 'plugins', 'state.mjs'),
      version: () => 5,
      command: () => '',
      artifactIsInstalled: () => true,
      artifactContent: () => 'export default {}\n',
      io: mem.io, ops,
    };
    return new DshInstaller(layout, deps, path.join, {
      upsertPatch: async (p) => { await upsertDshPatch(p); },
      removePatchBlock: async (p) => { await removeDshPatchBlock(p); },
    });
  };

  try {
    check('dsh validate：patch 文件不存在判失效', makeValidator().validate() === false);

    fs.writeFileSync(patchPath, '- id: user-row\n', 'utf8');
    check('dsh validate：文件在但没有我们的块判失效',
      makeValidator().validate() === false);

    fs.writeFileSync(patchPath, dshPatchBlock() + '\n', 'utf8');
    check('dsh validate：正确块判有效', makeValidator().validate() === true);

    fs.writeFileSync(patchPath, '- id: user-row\n\n' + dshPatchBlock() + '\n', 'utf8');
    check('dsh validate：与用户条目共存时判有效',
      makeValidator().validate() === true);

    fs.writeFileSync(
      patchPath,
      '# >>> herdr dsh integration\n- patch:\n    - insert:\n        - plugins/x.mjs\n# <<< herdr dsh integration\n',
      'utf8',
    );
    check('dsh validate：旧坏格式判失效', makeValidator().validate() === false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('— 15. KimiInstaller：版本闸门 + TOML 块 —');
{
  const makeKimi = (mem, versionOk = true) => {
    const layout = {
      configFile: 'config.toml', shape: 'nested', event: 'SessionStart',
      events: [['SessionStart', 'session']], artifactSubdir: 'hooks',
    };
    const deps = {
      configDir: () => '/home/u/.kimi-code',
      artifactPath: () => '/home/u/.kimi-code/hooks/state.sh',
      version: () => 4, command: (p, a) => `bash '${p}' ${a}`,
      artifactIsInstalled: () => false, artifactContent: () => '#!/bin/bash\n',
      io: mem.io, ops,
    };
    const kimi = {
      enforceMinVersion: async () => { if (!versionOk) throw new Error('kimi too old'); },
      checkTomlTarget: () => {},
      readText: async (path) => mem.files.get(path) ?? '',
      writeConfigFile: async (path, content) => { mem.files.set(path, content); mem.calls.push(['writeConfigFile', path]); },
      configWithHook: (content, artifactPath) => `${content}# >>> herdr kimi integration\n[[hooks]]\ncommand = "${artifactPath}"\n# <<< herdr kimi integration`,
      removeBlock: (content) => content.replace(/# >>> herdr kimi integration[\s\S]*?# <<< herdr kimi integration\n?/, ''),
    };
    return new KimiInstaller(layout, deps, join, kimi);
  };

  // 版本太旧 → 抛错且不写任何东西
  {
    const mem = makeIo();
    let threw = false;
    try { await makeKimi(mem, false).install(); } catch { threw = true; }
    check('kimi：版本闸门不通过时抛错', threw === true);
    check('kimi：版本闸门不通过时不写产物', mem.calls.length === 0);
  }

  // 正常安装 → TOML 块
  {
    const mem = makeIo({ '/home/u/.kimi-code/config.toml': 'model = "x"\n' });
    await makeKimi(mem, true).install();
    const toml = mem.files.get('/home/u/.kimi-code/config.toml');
    check('kimi：写入块标记', toml.includes('# >>> herdr kimi integration'));
    check('kimi：保留用户已有内容', toml.startsWith('model = "x"'));
    check('kimi：不写 JSON hooks（managesHooksConfig=false）',
      !mem.calls.some((c) => c[0] === 'writeJsonKey'));
    check('kimi：产物已写入', mem.files.has('/home/u/.kimi-code/hooks/state.sh'));
  }

  // 卸载 → 移除块
  {
    const mem = makeIo();
    const inst = makeKimi(mem, true);
    await inst.install();
    await inst.uninstall();
    check('kimi：卸载移除块', !mem.files.get('/home/u/.kimi-code/config.toml').includes('herdr kimi integration'));
  }
}

console.log('— 16. HermesInstaller：插件目录 + YAML 启用 —');
{
  const makeHermes = (mem) => {
    const layout = {
      configFile: 'config.yaml', shape: 'nested', event: 'SessionStart',
      events: [], artifactSubdir: 'plugins/herdr-desktop-agent-state',
    };
    const deps = {
      configDir: () => '/home/u/.hermes',
      artifactPath: () => '/home/u/.hermes/plugins/herdr-desktop-agent-state/__init__.py',
      version: () => 3, command: () => '',
      artifactIsInstalled: () => false, artifactContent: () => '"""plugin"""\n',
      io: mem.io, ops,
    };
    const hermes = {
      pluginDir: (dir) => `${dir}/plugins/herdr-desktop-agent-state`,
      manifestContent: () => 'name: herdr\n',
      writeFile: async (path, content) => { mem.files.set(path, content); mem.calls.push(['writeFile', path]); },
      readText: async (path) => mem.files.get(path) ?? '',
      writeConfigFile: async (path, content) => { mem.files.set(path, content); mem.calls.push(['writeConfigFile', path]); },
      setEnabled: (content, enabled) => enabled
        ? `${content}plugins:\n  enabled:\n    - herdr-desktop-agent-state\n`
        : content.replace(/plugins:[\s\S]*$/, ''),
    };
    return new HermesInstaller(layout, deps, join, hermes);
  };

  const mem = makeIo({ '/home/u/.hermes/config.yaml': 'model: x\n' });
  const inst = makeHermes(mem);
  await inst.install();

  check('hermes：写了入口文件', mem.files.has('/home/u/.hermes/plugins/herdr-desktop-agent-state/__init__.py'));
  check('hermes：写了清单 plugin.yaml', mem.files.has('/home/u/.hermes/plugins/herdr-desktop-agent-state/plugin.yaml'));
  check('hermes：不需要可执行位', !mem.calls.some((c) => c[0] === 'makeExecutable'));
  check('hermes：在 config.yaml 启用插件',
    mem.files.get('/home/u/.hermes/config.yaml').includes('herdr-desktop-agent-state'));
  check('hermes：保留用户已有配置', mem.files.get('/home/u/.hermes/config.yaml').startsWith('model: x'));

  mem.calls.length = 0;
  await inst.uninstall();
  check('hermes：卸载时递归删除插件目录',
    mem.calls.some((c) => c[0] === 'removeDirectory'));
  check('hermes：卸载后 config.yaml 不再启用',
    !(mem.files.get('/home/u/.hermes/config.yaml') ?? '').includes('- herdr-desktop-agent-state'));
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
