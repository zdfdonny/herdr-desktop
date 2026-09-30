/**
 * 集成列表对齐自查截图（开发辅助，不参与打包）。
 *
 * 目的：把「集成智能体列表」单独截出来，核对状态列里按钮/文字的水平对齐。
 * 产出两张图：
 *   docs/tmp-onboarding-list.png        首次引导弹窗里的智能体列表
 *   docs/tmp-sidebar-integrations.png   侧栏集成面板里的同一份列表
 *
 * 隔离 userData 的手法与 scripts/screenshot.js 一致：main.ts 在 whenReady 里
 * 会再调一次 app.setPath('userData', ...)，所以把 setPath 包一层改写掉。
 *
 * 用法：
 *   npx electron-vite build
 *   npx electron scripts/shot-integrations.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_USER_DATA = path.join(os.tmpdir(), 'herdr-shot-integrations');
const originalSetPath = app.setPath.bind(app);
app.setPath = (name, targetPath) => {
  originalSetPath(name, name === 'userData' ? TMP_USER_DATA : targetPath);
};
originalSetPath('userData', TMP_USER_DATA);

const LOG_PATH = path.join(os.tmpdir(), 'herdr-shot-integrations.log');
const DOCS_DIR = path.join(__dirname, '..', 'docs');
/** SHOT_LANG=en 时用英文界面截图，用来核对不同语言下状态列的居中。 */
const LANG = process.env.SHOT_LANG === 'en' ? 'en' : 'zh-CN';
const LANG_SUFFIX = LANG === 'en' ? '-en' : '';
const OUT_ONBOARDING = path.join(DOCS_DIR, `tmp-onboarding-list${LANG_SUFFIX}.png`);
const OUT_SIDEBAR = path.join(DOCS_DIR, `tmp-sidebar-integrations${LANG_SUFFIX}.png`);

const DEMO_SESSION = {
  projects: [],
  panes: [],
  agents: [],
  focusedPaneId: null,
  revision: 1,
};

/** integrationsOnboarded=false：启动即弹引导弹窗，弹窗里就是这份列表。 */
const DEMO_SETTINGS = {
  theme: 'dark',
  language: LANG,
  fontSize: 13,
  proxyUrl: '',
  proxyAgents: {},
  integrationsOnboarded: false,
};

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

async function waitForWindow(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [win] = BrowserWindow.getAllWindows();
    if (win) return win;
    await sleep(200);
  }
  throw new Error('等待窗口超时');
}

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

/** 截取某个选择器对应的元素区域。 */
async function captureElement(win, selector, out) {
  const rect = await exec(
    win,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: r.x, y: r.y, width: r.width, height: r.height };
     })()`,
  );
  if (!rect) throw new Error(`未找到元素：${selector}`);
  log(`${selector} rect=${JSON.stringify(rect)}`);

  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.webContents.setBackgroundThrottling(false);
  await sleep(600);

  let image = null;
  for (let attempt = 1; attempt <= 4 && !image; attempt += 1) {
    try {
      const shot = await win.webContents.capturePage({
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      });
      if (shot.isEmpty()) log(`第 ${attempt} 次拿到空图`);
      else image = shot;
    } catch (error) {
      log(`第 ${attempt} 次失败：${error && error.message ? error.message : String(error)}`);
    }
    if (!image) await sleep(900);
  }
  if (!image) throw new Error(`截图失败：${selector}`);

  fs.writeFileSync(out, image.toPNG());
  const { width, height } = image.getSize();
  log(`已写出 ${path.basename(out)} ${width}x${height} ${fs.statSync(out).size}B`);
  win.setAlwaysOnTop(false);
}

/** 量出状态列里按钮/文字的实际位置，确认中心线是否对齐。 */
async function measureState(win, tag) {
  const rows = await exec(
    win,
    `(() => {
       const rows = Array.from(document.querySelectorAll('.agent-status'));
       return rows.map((row) => {
         const state = row.querySelector('.agent-status__state');
         const child = state ? state.firstElementChild : null;
         const sr = state ? state.getBoundingClientRect() : null;
         const cr = child ? child.getBoundingClientRect() : null;
         const name = row.querySelector('.agent-status__name');
         return {
           name: name ? name.textContent : '',
           kind: child ? child.tagName.toLowerCase() : '',
           stateW: sr ? Math.round(sr.width) : 0,
           childW: cr ? Math.round(cr.width) : 0,
           childCenter: cr ? Math.round(cr.left + cr.width / 2) : 0,
           stateCenter: sr ? Math.round(sr.left + sr.width / 2) : 0,
         };
       });
     })()`,
  );
  log(`${tag} 状态列测量：\n${JSON.stringify(rows, null, 1)}`);
  return rows;
}

/** 从状态文字/按钮往上逐层量右边缘，算清「离右边」到底是多少。 */
async function measureRightEdge(win, tag) {
  const data = await exec(
    win,
    `(() => {
       const text = document.querySelector('.agent-status__state-text');
       const btn = document.querySelector('.agent-status .button--small');
       const probe = text || btn;
       if (!probe) return null;
       const chain = [];
       let el = probe;
       while (el && el !== document.documentElement) {
         const r = el.getBoundingClientRect();
         const cs = getComputedStyle(el);
         chain.push({
           tag: el.tagName.toLowerCase(),
           cls: typeof el.className === 'string' ? el.className : '',
           left: Math.round(r.left * 100) / 100,
           right: Math.round(r.right * 100) / 100,
           width: Math.round(r.width * 100) / 100,
           padLeft: cs.paddingLeft,
           padRight: cs.paddingRight,
           overflowY: cs.overflowY,
           scrollbar: el.offsetWidth - el.clientWidth,
         });
         el = el.parentElement;
       }
       const t = text ? text.getBoundingClientRect() : null;
       const b = btn ? btn.getBoundingClientRect() : null;
       return {
         innerWidth: window.innerWidth,
         textRight: t ? Math.round(t.right * 100) / 100 : null,
         textWidth: t ? Math.round(t.width * 100) / 100 : null,
         btnRight: b ? Math.round(b.right * 100) / 100 : null,
         btnWidth: b ? Math.round(b.width * 100) / 100 : null,
         chain,
       };
     })()`,
  );
  log(`${tag} 右边缘链：\n${JSON.stringify(data, null, 1)}`);
  return data;
}

async function main() {
  fs.rmSync(LOG_PATH, { force: true });
  fs.rmSync(TMP_USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(TMP_USER_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(TMP_USER_DATA, 'session.json'),
    JSON.stringify(DEMO_SESSION, null, 2),
  );
  fs.writeFileSync(
    path.join(TMP_USER_DATA, 'settings.json'),
    JSON.stringify(DEMO_SETTINGS, null, 2),
  );

  require(path.join(__dirname, '..', 'dist-electron', 'main', 'main.js'));
  await app.whenReady();

  const effectiveUserData = app.getPath('userData');
  if (path.resolve(effectiveUserData) !== path.resolve(TMP_USER_DATA)) {
    throw new Error(`userData 未隔离，实际为 ${effectiveUserData}`);
  }
  log(`userData 已隔离：${effectiveUserData}`);

  const win = await waitForWindow();
  await waitForLoad(win);
  log('窗口就绪');

  // 等 getHookStatuses 的 IPC 回来、列表渲染完成
  await sleep(4000);

  /* --- 1. 引导弹窗里的智能体列表 --- */
  await captureElement(win, '.onboarding-dialog', OUT_ONBOARDING);
  await measureState(win, '弹窗');

  /* --- 2. 关掉弹窗，切到侧栏集成面板 --- */
  const closed = await exec(
    win,
    `(() => {
       const btn = document.querySelector('.onboarding-dialog__actions .button');
       if (btn) btn.click();
       return !!btn;
     })()`,
  );
  log(`关闭弹窗=${closed}`);
  await sleep(600);

  const railCount = await exec(
    win,
    `(() => {
       const rail = document.querySelectorAll('.sidebar__rail-button');
       if (rail[1]) rail[1].click();
       return rail.length;
     })()`,
  );
  log(`图标栏按钮数=${railCount}`);
  await sleep(3500);

  await captureElement(win, '.sidebar', OUT_SIDEBAR);
  await measureState(win, '侧栏');
  await measureRightEdge(win, '侧栏');

  log('全部完成');
  app.exit(0);
}

main().catch((error) => {
  log(`失败：${error && error.stack ? error.stack : String(error)}`);
  app.exit(1);
});
