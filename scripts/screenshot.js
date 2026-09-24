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
 * 用法：
 *   npx electron-vite build
 *   npx electron scripts/screenshot.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 独立 userData，绝不污染开发者自己的 session.json / settings.json
const TMP_USER_DATA = path.join(os.tmpdir(), 'herdr-shot-profile');
app.setPath('userData', TMP_USER_DATA);

const OUT = path.join(__dirname, '..', 'docs', 'screenshot.png');

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
};

/**
 * 每个 pane 要跑的演示命令。
 *
 * 这里刻意不用真实的 claude/codex —— 本机未必装了，装了也可能联网/登录失败。
 * 改为用 shell 打印一段**形似 agent 工作过程**的输出，既能体现终端渲染、
 * 又不依赖外部环境，可重复产出同一张图。
 */
function demoCommand(lines) {
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
    ...lines.map((l) => `Write-Host "${l.replace(/"/g, '`"')}"`),
    'while ($true) { Start-Sleep -Seconds 3600 }',
  ].join('; ');
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', ps] };
}

const PANES = [
  {
    projectId: 'p1',
    label: 'Claude Code',
    lines: [
      '',
      ' \u001b[38;5;114m✻ Welcome to Claude Code\u001b[0m',
      '',
      '   \u001b[2m/help for help, /status for your current setup\u001b[0m',
      '',
      ' \u001b[38;5;114m>\u001b[0m Refactor the PTY manager to support two-phase pane creation',
      '',
      ' \u001b[38;5;114m●\u001b[0m Reading electron/runtime/pty-manager.ts…',
      ' \u001b[38;5;114m●\u001b[0m Reading electron/runtime/session.ts…',
      ' \u001b[38;5;114m●\u001b[0m Searching for spawnOptions…',
      '',
      ' \u001b[38;5;114m●\u001b[0m Update(electron/runtime/pty-manager.ts)',
      '   \u001b[32m+\u001b[0m 12 \u001b[31m-\u001b[0m 4',
      '',
      ' \u001b[2m✻ Thinking…\u001b[0m',
    ],
  },
  {
    projectId: 'p1',
    label: 'Codex',
    lines: [
      '',
      ' \u001b[1mOpenAI Codex\u001b[0m  \u001b[2mv0.9.1\u001b[0m',
      '',
      ' \u001b[2mmodel: gpt-5-codex   sandbox: workspace-write\u001b[0m',
      '',
      ' \u001b[36m›\u001b[0m add a SHA256SUMS check to the release job',
      '',
      ' \u001b[2mthinking…\u001b[0m',
      ' \u001b[32m✓\u001b[0m .github/workflows/release.yml',
      '',
      ' \u001b[2mTokens used: 12,480 · 3 files changed\u001b[0m',
      '',
      ' \u001b[36m›\u001b[0m \u001b[7m \u001b[0m',
    ],
  },
  {
    projectId: 'p1',
    label: 'Gemini CLI',
    lines: [
      '',
      ' \u001b[38;5;39mGemini CLI\u001b[0m',
      '',
      ' \u001b[2mReady. Type your request.\u001b[0m',
      '',
      ' \u001b[38;5;39m>\u001b[0m ',
    ],
  },
  {
    projectId: 'p2',
    label: 'OpenCode',
    lines: [
      '',
      ' \u001b[1mopencode\u001b[0m',
      '',
      ' \u001b[33m!\u001b[0m Waiting for approval to run:',
      '   \u001b[2mcargo test --workspace\u001b[0m',
      '',
      ' \u001b[2m[y] approve  [n] reject\u001b[0m',
    ],
  },
  {
    projectId: 'p2',
    label: 'Cursor Agent',
    lines: [
      '',
      ' \u001b[38;5;213mCursor Agent\u001b[0m  \u001b[2mready\u001b[0m',
      '',
      ' \u001b[38;5;213m>\u001b[0m ',
    ],
  },
];

async function main() {
  fs.rmSync(TMP_USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(TMP_USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(TMP_USER_DATA, 'session.json'), JSON.stringify(DEMO_SESSION, null, 2));
  fs.writeFileSync(path.join(TMP_USER_DATA, 'settings.json'), JSON.stringify(DEMO_SETTINGS, null, 2));

  // 复用真实 main 入口，保证截到的是真应用
  require(path.join(__dirname, '..', 'dist-electron', 'main', 'main.js'));

  await app.whenReady();
  await new Promise((r) => setTimeout(r, 1800));

  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) {
    console.error('没有找到窗口');
    app.exit(1);
    return;
  }
  const win = wins[0];

  // 通过渲染进程真实调用 spawnAgent（走完整 IPC → PtyRuntime 链路）
  const spawned = await win.webContents.executeJavaScript(`
    (async () => {
      const api = window.herdrDesktop;
      if (!api || !api.sendControl) return 'NO_API';
      const panes = ${JSON.stringify(PANES.map((p) => ({
        projectId: p.projectId,
        label: p.label,
        ...demoCommand(p.lines),
      })))};
      for (const p of panes) {
        api.sendControl({
          type: 'control:spawn-agent',
          version: 1,
          payload: {
            projectId: p.projectId,
            command: p.command,
            args: p.args,
            label: p.label,
          },
        });
        await new Promise((r) => setTimeout(r, 900));
      }
      return 'OK:' + panes.length;
    })()
  `);
  console.log('spawn 结果:', spawned);

  // 等所有 PTY 起来 + xterm 首帧渲染
  await new Promise((r) => setTimeout(r, 5000));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());

  const size = image.getSize();
  console.log(`已保存: ${OUT}`);
  console.log(`尺寸: ${size.width}x${size.height}`);

  // 演示用的 shell 是常驻循环，必须显式收掉，否则 electron 不退出
  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
