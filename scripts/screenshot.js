/**
 * 截图脚本（开发辅助，不参与打包）。
 *
 * 用真实 Electron 渲染进程截图，供 README 使用。
 *
 * 为什么不是「塞一份 session.json 就完事」：
 * session.ts 的 restore() 会把所有 pane 的 running 强制置为 false
 * （PTY 进程不可能跨重启存活），而 Layout 只渲染 running !== false 的 pane。
 * 所以纯靠伪造快照只能截到空状态。
 *
 * 正确做法：只伪造「项目」，然后通过渲染进程真实调用 spawnAgent，
 * 让 PTY 真正跑起来、xterm 真正挂载，截到的才是真界面。
 *
 * 界面已经演进到「标签页 + 视图内分屏 + 内嵌 DSH Web」，一张图塞不下，
 * 这里产出三张：
 *   docs/screenshot.png        深色主界面：标签栏 + 视图内三格分屏 + 状态 toast
 *   docs/screenshot-web.png    内嵌 DeepSeek Harness Web GUI 的 pane
 *   docs/screenshot-light.png  浅色主题下的主界面
 *
 * 两个关键技巧：
 *
 * 1. 布局靠 localStorage + reload。
 *    标签名与「视图内分屏」结构无法用 control 消息构造（control:spawn-agent
 *    只会让每个 pane 各开一个新标签），所以：先真实 spawn 拿到**真实 paneId**，
 *    再把布局写进 localStorage['herdr.layout.v2']，然后 reload 渲染进程。
 *    PTY 归主进程所有，reload 不会杀掉进程；渲染进程重新挂载 xterm 后照样能
 *    收到 pty:data，而 loadLayout() 会把我们写的布局读回来（reconcile 只负责
 *    填空位/开新视图，不会动已经放好的 pane）。
 *
 * 2. 状态切换靠「信号文件」，而不是 sleep 猜时间。
 *    每个演示 pane 先循环打印「工作中」帧，直到脚本创建对应信号文件，才切到
 *    最终帧。这样状态迁移时机完全由脚本决定，不受 dsh web 启动耗时影响；
 *    toast 也保证在截图瞬间还没消失（NotificationToasts 自动消失是 8s）。
 *
 * 注意：内嵌 web pane 必须在 reload **之后**再 spawn —— 认证链接只经
 * `web:ready` 下发并缓存在渲染进程的 webStore 里（刻意不持久化），reload 后
 * 拿不到链接就只会显示「正在启动」。
 *
 * 用法：
 *   npx electron-vite build
 *   npx electron scripts/screenshot.js
 *
 * 日志写在 %TEMP%\herdr-shot.log：Windows 上 electron.exe 是 GUI 子系统程序，
 * 主进程的 console.log 未必能回到当前终端。
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * 独立 userData，绝不污染开发者自己的 session.json / settings.json。
 *
 * 只在本文件里 setPath 是不够的：main.ts 在 app.whenReady() 内部还会再调一次
 * `app.setPath('userData', <appData>/herdr-desktop)`（为了打包后与真实 herdr
 * 区分数据目录）。那次调用晚于这里，会把路径改回开发者本人的真实目录 ——
 * 于是脚本读到的是真实的 session.json，预置的项目 ID 全都不存在，spawn 直接
 * 报「项目不存在」，截出来的也是别人的项目列表。
 *
 * 所以把 setPath 包一层：凡是指向 userData 的调用一律改写进临时目录。
 */
const TMP_USER_DATA = path.join(os.tmpdir(), 'herdr-shot-profile');
const originalSetPath = app.setPath.bind(app);
app.setPath = (name, targetPath) => {
  originalSetPath(name, name === 'userData' ? TMP_USER_DATA : targetPath);
};
originalSetPath('userData', TMP_USER_DATA);

/** 演示 pane 用来接收「切到最终帧」信号的目录。 */
const SIGNAL_DIR = path.join(TMP_USER_DATA, 'signals');

const LOG_PATH = path.join(os.tmpdir(), 'herdr-shot.log');
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const OUT_MAIN = path.join(DOCS_DIR, 'screenshot.png');
const OUT_WEB = path.join(DOCS_DIR, 'screenshot-web.png');
const OUT_LIGHT = path.join(DOCS_DIR, 'screenshot-light.png');

/** 布局持久化的 key，需与 src/stores/layoutStore.ts 的 STORAGE_KEY 一致。 */
const LAYOUT_KEY = 'herdr.layout.v2';

const now = Date.now();

/**
 * 只预置项目；agent 一律走真实 spawn。
 *
 * 路径必须是**真实存在**的目录：spawn 时 cwd 不存在会直接失败
 * （Windows 上表现为 error code 267），截图里就会挂出错误 toast。
 * 这里复用本机真实的仓库目录，截出来的状态才是真的。
 */
const DEMO_SESSION = {
  projects: [
    {
      projectId: 'p1',
      name: 'herdr-desktop',
      path: 'D:\\VSProject\\herdr-desktop',
      branch: 'master',
      collapsed: false,
      createdAt: now - 90000,
    },
    {
      projectId: 'p2',
      name: 'herdr',
      path: 'D:\\VSProject\\herdr',
      branch: 'main',
      collapsed: false,
      createdAt: now - 60000,
    },
  ],
  panes: [],
  agents: [],
  focusedPaneId: null,
  revision: 1,
};

const DEMO_SETTINGS = {
  theme: 'dark',
  language: 'zh-CN',
  fontSize: 13,
  sidebarCollapsed: false,
  proxyUrl: '',
  proxyAgents: {},
  integrationsOnboarded: true,
};

/* ===== 演示帧 ===== */

/** 第一阶段的「工作中」帧：只为让检测层记下 working，最终会被清屏覆盖。 */
const THINKING = ['', ' \u001b[2m✻ Thinking…\u001b[0m'];

/**
 * 每个 pane 的演示内容。
 *
 * 这里刻意不用真实的 claude/codex —— 本机未必装了，装了也可能联网/登录失败。
 * 改为用 shell 打印一段**形似 agent 工作过程**的输出，既能体现终端渲染、
 * 又不依赖外部环境，可重复产出同一张图。
 *
 * working 为第一阶段循环帧，final 为信号到达后的最终帧：
 * - Claude Code：两阶段都是「工作中」→ 状态停在 working；
 * - Codex：working → final 不含工作关键词 → 未聚焦回落到 idle → done；
 * - OpenCode：working → final 命中 blocked 关键词 → blocked（并弹 toast）；
 * - Gemini CLI：两阶段都是空闲帧 → 状态一直是 idle。
 */
const DEMO_PANES = [
  {
    key: 'claude',
    projectId: 'p1',
    label: 'Claude Code',
    working: THINKING,
    final: [
      '',
      ' \u001b[38;5;114m✻ Welcome to Claude Code\u001b[0m',
      '',
      ' \u001b[2m/help for help, /status for setup\u001b[0m',
      '',
      ' \u001b[38;5;114m>\u001b[0m Refactor pane creation into two phases',
      '',
      ' \u001b[38;5;114m●\u001b[0m Read(pty-manager.ts)',
      ' \u001b[38;5;114m●\u001b[0m Read(router.ts)',
      ' \u001b[38;5;114m●\u001b[0m Grep(pendingSpawns)',
      '',
      ' \u001b[38;5;114m●\u001b[0m Update(router.ts)',
      '   \u001b[32m+18\u001b[0m \u001b[31m-6\u001b[0m',
      '',
      ' \u001b[2m✻ Thinking…\u001b[0m',
    ],
  },
  {
    key: 'codex',
    projectId: 'p1',
    label: 'Codex',
    working: THINKING,
    final: [
      '',
      ' \u001b[1mOpenAI Codex\u001b[0m \u001b[2mv0.9.1\u001b[0m',
      '',
      ' \u001b[2mmodel: gpt-5-codex\u001b[0m',
      ' \u001b[2msandbox: workspace-write\u001b[0m',
      '',
      ' \u001b[36m›\u001b[0m add a SHA256SUMS check',
      '',
      ' \u001b[32m✓\u001b[0m .github/workflows/release.yml',
      ' \u001b[32m✓\u001b[0m verified 3 artifacts',
      '',
      ' \u001b[2mTokens used: 12,480 · 3 files changed\u001b[0m',
      '',
      ' \u001b[36m›\u001b[0m \u001b[7m \u001b[0m',
    ],
  },
  {
    key: 'opencode',
    projectId: 'p2',
    label: 'OpenCode',
    working: THINKING,
    final: [
      '',
      ' \u001b[1mopencode\u001b[0m \u001b[2mv0.6.4\u001b[0m',
      '',
      ' \u001b[33m!\u001b[0m Waiting for approval to run:',
      '   \u001b[2mcargo test --workspace\u001b[0m',
      '',
      ' \u001b[2m[y] approve   [n] reject\u001b[0m',
    ],
  },
  {
    key: 'gemini',
    projectId: 'p1',
    label: 'Gemini CLI',
    // 与 final 相同：全程不出现工作/等待关键词，状态稳定停在 idle
    working: null,
    final: [
      '',
      ' \u001b[38;5;39mGemini CLI\u001b[0m \u001b[2mv0.11.3\u001b[0m',
      '',
      ' \u001b[2mReady. Type your request, or /help.\u001b[0m',
      '',
      ' \u001b[38;5;39m>\u001b[0m ',
    ],
  },
];

/* ===== 工具函数 ===== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  const line = `[shot ${new Date().toISOString().slice(11, 23)}] ${message}`;
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    /* 日志失败不影响截图 */
  }
  console.log(line);
}

/** 在渲染进程里执行一段表达式并取回结果。 */
function exec(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

/**
 * 生成演示命令。
 *
 * 全程只用单引号，避免 node-pty 在 Windows 上拼命令行时的双引号转义问题。
 * 清屏用显式 CSI 序列（ESC[2J ESC[H）而不是 Clear-Host：xterm 一定会处理，
 * 且不依赖宿主实现。
 */
function demoCommand(pane, signalPath) {
  const arr = (lines) => `@(${lines.map((line) => `'${line}'`).join(', ')})`;
  const working = pane.working ?? pane.final;
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$e = [char]27',
    "$clr = $e + '[2J' + $e + '[H'",
    `$w = ${arr(working)}`,
    `$d = ${arr(pane.final)}`,
    'function S($a) { Write-Host $clr -NoNewline; foreach ($x in $a) { Write-Host $x } }',
    // 第一阶段：循环打印「工作中」帧，直到脚本创建信号文件
    `while (-not (Test-Path '${signalPath}')) { S $w; Start-Sleep -Milliseconds 900 }`,
    /*
     * 第二阶段：重复打印最终帧。重复是为了把第一阶段的文字挤出检测窗口
     * （detect-manifest 只看缓冲区底部 40 行），否则「已完成」会被旧的
     * working 关键词按回 working。
     */
    'for ($i = 0; $i -lt 8; $i++) { S $d; Start-Sleep -Milliseconds 250 }',
    'while ($true) { Start-Sleep -Seconds 3600 }',
  ].join('; ');
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', ps] };
}

/**
 * 构造布局。
 *
 * 形状必须满足 layoutStore 的 isValidTree：split 需要 id/orientation/ratio/两个
 * 子节点，pane 叶子需要 id/paneId，空位需要 id/projectId。
 *
 * 第三个视图刻意留一个空位：reconcile 会用「尚未放置的运行态 pane」填它，
 * 而稍后才 spawn 的 DSH Web pane 正是唯一未放置的 pane —— 于是它落在名为
 * 「DSH Web」的标签里，而不需要 reload（reload 会丢掉 webview 的认证链接）。
 */
function buildLayout(paneIds) {
  const pane = (paneId, id) => ({ id, type: 'pane', paneId });
  return {
    views: [
      {
        id: 'v-shot-1',
        name: 'PTY 重构',
        tree: {
          id: 'n-shot-1',
          type: 'split',
          orientation: 'row',
          ratio: 33.34,
          children: [
            pane(paneIds.claude, 'n-shot-2'),
            {
              id: 'n-shot-3',
              type: 'split',
              orientation: 'row',
              ratio: 50,
              children: [pane(paneIds.codex, 'n-shot-4'), pane(paneIds.opencode, 'n-shot-5')],
            },
          ],
        },
      },
      { id: 'v-shot-2', name: '代码审查', tree: pane(paneIds.gemini, 'n-shot-6') },
      { id: 'v-shot-3', name: 'DSH Web', tree: { id: 'n-shot-7', type: 'empty', projectId: 'p1' } },
    ],
    activeViewId: 'v-shot-1',
  };
}

/** 等待窗口出现。 */
async function waitForWindow(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [win] = BrowserWindow.getAllWindows();
    if (win) return win;
    await sleep(200);
  }
  throw new Error('等待窗口超时');
}

/** 等待首屏加载完成。 */
function waitForLoad(win, timeoutMs = 30000) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待首屏加载超时')), timeoutMs);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** reload 渲染进程并等它重新加载完成。 */
async function reloadRenderer(win) {
  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload();
  await loaded;
  // 留出 React 首帧 + reconcile 的时间
  await sleep(1500);
}

/** 轮询渲染进程里的布尔表达式，直到为真或超时。 */
async function pollUntil(win, expression, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await exec(win, expression)) return true;
    } catch {
      /* 页面正在切换时可能抛错，继续轮询 */
    }
    await sleep(intervalMs);
  }
  return false;
}

/** 截图并落盘。 */
async function capture(win, out) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(out, image.toPNG());
  const { width, height } = image.getSize();
  log(`已写出 ${path.basename(out)} ${width}x${height} ${fs.statSync(out).size}B`);
}

/** 读取标签栏现状，用于确认布局真的生效。 */
async function readTabs(win) {
  return exec(
    win,
    `Array.from(document.querySelectorAll('.view-tab')).map((el) => ({
       name: el.querySelector('.view-tab__text')?.textContent ?? '',
       count: el.querySelector('.view-tab__count')?.textContent ?? '',
       active: el.classList.contains('is-active'),
     }))`,
  );
}

/* ===== 主流程 ===== */

async function main() {
  fs.rmSync(LOG_PATH, { force: true });
  fs.rmSync(TMP_USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(SIGNAL_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TMP_USER_DATA, 'session.json'),
    JSON.stringify(DEMO_SESSION, null, 2),
  );
  fs.writeFileSync(
    path.join(TMP_USER_DATA, 'settings.json'),
    JSON.stringify(DEMO_SETTINGS, null, 2),
  );
  log(`userData=${TMP_USER_DATA}`);

  // 拉起真实的 main 进程（必须在 app ready 之前 require）
  require(path.join(__dirname, '..', 'dist-electron', 'main', 'main.js'));
  await app.whenReady();

  /*
   * main.ts 在 whenReady 里改写过 userData，这里必须确认改写生效：
   * 一旦隔离失败就会去读写开发者真实的会话，比截图失败严重得多。
   */
  const effectiveUserData = app.getPath('userData');
  if (path.resolve(effectiveUserData) !== path.resolve(TMP_USER_DATA)) {
    throw new Error(`userData 未隔离，实际为 ${effectiveUserData}`);
  }
  log(`userData 已隔离：${effectiveUserData}`);

  const win = await waitForWindow();
  await waitForLoad(win);
  log('窗口就绪');

  /* --- 1. 真实 spawn 四个终端 pane（每个各开一个新标签） --- */
  const spawnSpecs = DEMO_PANES.map((pane) => {
    const { command, args } = demoCommand(pane, path.join(SIGNAL_DIR, `${pane.key}.sig`));
    return { projectId: pane.projectId, label: pane.label, command, args };
  });

  await exec(
    win,
    `(async () => {
       const api = window.herdrDesktop;
       const specs = ${JSON.stringify(spawnSpecs)};
       for (const spec of specs) {
         api.sendControl({
           type: 'control:spawn-agent',
           version: 1,
           payload: {
             projectId: spec.projectId,
             command: spec.command,
             args: spec.args,
             label: spec.label,
           },
         });
         await new Promise((r) => setTimeout(r, 700));
       }
       return 'spawned';
     })()`,
  );

  // 等 PTY 起来并进入第一阶段（两阶段创建：渲染侧挂载后 attach-pane 才启动进程）
  await sleep(3500);
  log('四个终端 pane 已启动');

  /* --- 2. 从真实快照里取回 paneId --- */
  const panes = await exec(
    win,
    `new Promise((resolve) => {
       const api = window.herdrDesktop;
       const timer = setTimeout(() => resolve(null), 20000);
       const off = api.onMessage((message) => {
         if (message.type !== 'state:snapshot') return;
         clearTimeout(timer);
         off();
         resolve(message.payload.panes.map((p) => ({
           paneId: p.paneId,
           label: p.label ?? '',
           kind: p.kind,
           running: p.running,
         })));
       });
     })`,
  );
  if (!panes) throw new Error('未能取得会话快照');

  const terminals = panes.filter((p) => p.kind !== 'web');
  const paneIds = {};
  for (const [index, spec] of DEMO_PANES.entries()) {
    const hit = terminals.find((p) => p.label === spec.label) ?? terminals[index];
    if (!hit) throw new Error(`未能匹配 pane：${spec.label}`);
    paneIds[spec.key] = hit.paneId;
  }
  log(`paneId: ${JSON.stringify(paneIds)}`);

  /* --- 3. 写入布局 + 聚焦，然后 reload 让布局生效 --- */
  const layout = buildLayout(paneIds);
  const layoutJson = JSON.stringify(layout);

  // 聚焦 view-1 里的 pane：reconcile 的「焦点跟随」会把该视图带到前台
  await exec(
    win,
    `window.herdrDesktop.sendControl({
       type: 'control:focus-pane',
       version: 1,
       payload: { paneId: ${JSON.stringify(paneIds.claude)} },
     })`,
  );

  let tabs = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    /*
     * 写入后立刻 reload：页面卸载前的 reconcile 有可能用旧状态覆盖 localStorage，
     * 所以这里在 reload 之后回读标签栏校验，不对就再写一次。
     */
    await exec(win, `localStorage.setItem(${JSON.stringify(LAYOUT_KEY)}, ${JSON.stringify(layoutJson)})`);
    await reloadRenderer(win);
    tabs = await readTabs(win);
    log(`标签栏（第 ${attempt} 次）：${JSON.stringify(tabs)}`);
    if (tabs.length === 3 && tabs[0].name === 'PTY 重构' && tabs[2].name === 'DSH Web') break;
  }

  /* --- 4. 发信号：所有 pane 切到最终帧 --- */
  for (const spec of DEMO_PANES) {
    fs.writeFileSync(path.join(SIGNAL_DIR, `${spec.key}.sig`), 'go');
  }
  // 等最终帧打完、状态迁移完成，且 toast 仍在 8s 生命周期内
  await sleep(3200);
  log('最终帧已输出');

  /* --- 5. 主界面截图 --- */
  await capture(win, OUT_MAIN);

  /* --- 6. DSH Web pane：必须放在 reload 之后 --- */
  const webPaneId = await exec(
    win,
    `new Promise((resolve) => {
       const api = window.herdrDesktop;
       const timer = setTimeout(() => resolve(null), 90000);
       const off = api.onMessage((message) => {
         if (message.type !== 'web:ready') return;
         clearTimeout(timer);
         off();
         resolve(message.payload.paneId);
       });
       api.sendControl({
         type: 'control:spawn-web-agent',
         version: 1,
         payload: { projectId: 'p1', label: 'DeepSeek Harness' },
       });
     })`,
  );
  if (!webPaneId) throw new Error('dsh web 未在 90s 内就绪');
  log(`web pane 就绪：${webPaneId}`);

  // 等 <webview> 把 DSH Web GUI 真正渲染出来
  const loaded = await pollUntil(
    win,
    `(() => {
       const view = document.querySelector('webview');
       if (!view) return false;
       try { return view.isLoading() === false; } catch { return false; }
     })()`,
    60000,
  );
  log(`webview 加载完成=${loaded}`);
  await sleep(4000);
  log(`web 标签栏：${JSON.stringify(await readTabs(win))}`);
  await capture(win, OUT_WEB);

  /* --- 7. 浅色主题下的终端视图 --- */
  await exec(
    win,
    `window.herdrDesktop.sendControl({
       type: 'control:set-theme',
       version: 1,
       payload: { theme: 'light' },
     })`,
  );
  /*
   * 切回第一个标签：直接点标签，而不是只发 focus-pane。
   * 焦点跟随只保证 focusedPaneId 落到该视图，视图激活并不总会跟着走
   * （第一次截图里画面就停在 DSH Web 上），点标签是确定有效的用户动作。
   */
  const switched = await exec(
    win,
    `(() => {
       const tab = document.querySelectorAll('.view-tab__label')[0];
       if (tab) tab.click();
       return !!tab;
     })()`,
  );
  log(`切回终端标签=${switched}`);
  // 再聚焦 Claude，让侧栏高亮与当前视图一致
  await exec(
    win,
    `window.herdrDesktop.sendControl({
       type: 'control:focus-pane',
       version: 1,
       payload: { paneId: ${JSON.stringify(paneIds.claude)} },
     })`,
  );
  await sleep(2500);
  await capture(win, OUT_LIGHT);

  /*
   * 收尾：主动关掉所有 pane。
   * app.exit() 不会走 before-quit，PTY 与 dsh web 子进程不会被自动回收，
   * 会留下若干孤儿 powershell / node 进程（还会占住 stdout 句柄让调用方
   * 迟迟等不到 EOF）。走正常关 pane 路径让运行时结束整棵进程树。
   */
  const allPaneIds = [...Object.values(paneIds), webPaneId];
  await exec(
    win,
    `(() => {
       const api = window.herdrDesktop;
       const ids = ${JSON.stringify(allPaneIds)};
       for (const paneId of ids) {
         api.sendControl({ type: 'control:close-pane', version: 1, payload: { paneId } });
       }
       return ids.length;
     })()`,
  );
  await sleep(1800);
  log('已关闭全部 pane');

  log('全部完成');
  app.exit(0);
}

main().catch((error) => {
  log(`失败：${error && error.stack ? error.stack : String(error)}`);
  app.exit(1);
});
