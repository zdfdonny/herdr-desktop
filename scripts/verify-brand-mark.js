/**
 * 验证顶栏品牌标记（左上角图标）确实渲染成了 build/icon.png。
 *
 * 只做一件事：加载已构建的渲染层，检查 .topbar__brand-mark img 的
 * naturalWidth/src，并截取该元素区域。
 *
 * 用法：
 *   npx electron-vite build
 *   npx electron scripts/verify-brand-mark.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP_USER_DATA = path.join(os.tmpdir(), 'herdr-brand-check');

// 隔离 userData，避免碰到开发者真实会话
const originalSetPath = app.setPath.bind(app);
app.setPath = (name, target) => originalSetPath(name, name === 'userData' ? TMP_USER_DATA : target);
originalSetPath('userData', TMP_USER_DATA);
fs.mkdirSync(TMP_USER_DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  require(path.join(ROOT, 'dist-electron', 'main', 'main.js'));

  let win = null;
  for (let i = 0; i < 150 && !win; i += 1) {
    [win] = BrowserWindow.getAllWindows();
    if (!win) await sleep(200);
  }
  if (!win) throw new Error('未等到窗口');

  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }
  await sleep(1500);

  const info = await win.webContents.executeJavaScript(
    `(() => {
       const img = document.querySelector('.topbar__brand-mark img');
       if (!img) {
         const mark = document.querySelector('.topbar__brand-mark');
         return { found: false, markHtml: mark ? mark.innerHTML.slice(0, 200) : null };
       }
       const rect = img.getBoundingClientRect();
       return {
         found: true,
         src: img.getAttribute('src'),
         naturalWidth: img.naturalWidth,
         naturalHeight: img.naturalHeight,
         complete: img.complete,
         cssWidth: Math.round(rect.width),
         cssHeight: Math.round(rect.height),
       };
     })()`,
    true,
  );
  console.log('BRAND:', JSON.stringify(info, null, 2));

  // 截取品牌标记所在区域（含少量留白），确认像素真的画出来了
  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: 220, height: 60 });
  const out = path.join(os.tmpdir(), 'brand-mark.png');
  fs.writeFileSync(out, shot.toPNG());
  console.log('SHOT:', out, fs.statSync(out).size, 'bytes');

  // 同样看一眼深色主题：图标自带蓝色底，不应再像旧版那样「隐形」
  await win.webContents.executeJavaScript(
    `window.herdrDesktop.sendControl({
       type: 'control:set-theme', version: 1, payload: { theme: 'dark' },
     })`,
    true,
  );
  await sleep(1200);
  const darkShot = await win.webContents.capturePage({ x: 0, y: 0, width: 220, height: 60 });
  const darkOut = path.join(os.tmpdir(), 'brand-mark-dark.png');
  fs.writeFileSync(darkOut, darkShot.toPNG());
  console.log('SHOT(dark):', darkOut, fs.statSync(darkOut).size, 'bytes');

  // 校验：位图必须与 build/icon.png 一致（同一份文件）
  const buildIcon = fs.readFileSync(path.join(ROOT, 'build', 'icon.png'));
  const srcFile = path.join(ROOT, 'dist', 'assets', path.basename(info.src ?? ''));
  const shipped = fs.existsSync(srcFile) ? fs.readFileSync(srcFile) : null;
  console.log(
    'ICON IDENTICAL TO build/icon.png:',
    shipped ? shipped.equals(buildIcon) : `(未找到 ${srcFile})`,
  );

  app.exit(info.found && info.naturalWidth === 512 ? 0 : 1);
});
