/**
 * 把应用图标 build/icon.png 同步到渲染层可打包的位置 src/assets/app-icon.png。
 *
 * 为什么需要这一步：渲染层的 Vite root 是 src/，图片 import 必须落在 root 内
 * 才会被处理成打包资源；而 build/icon.png 在 root 之外（electron-builder 的
 * buildResources 目录），渲染层直接 import 拿不到。于是构建前复制一份。
 *
 * build/icon.png 是唯一真源，由设计稿直接产出，仓库里没有可复现它的源文件
 * （早期的 scripts/gen-icon.js 需要一张 build/icon-source.jpg 才能跑，而那张
 * 源图从未入库，脚本已删除）。换图标的流程就是：替换 build/icon.png，
 * 然后跑 npm run icon 同步给渲染层。
 *
 * electron-builder 打包时同样读 build/icon.png，自行转换成 .ico / .icns。
 *
 * 同步时机：electron.vite.config.ts 在渲染层构建前直接调用本模块的 syncIcon()，
 * 因此 dev / build / dist:* 全都会自动同步 —— 比挂在 npm 的 pre 脚本上可靠：
 * dist:* 系列内部是裸的 `electron-vite build`，不会触发 prebuild。
 *
 * src/assets/app-icon.png 是生成物，不要手工编辑；它已随仓库提交，
 * 这样 clone 后不跑同步也能直接构建。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon.png');
const DEST = path.join(ROOT, 'src', 'assets', 'app-icon.png');

/**
 * 复制图标；内容一致时跳过写入（避免无谓刷新 mtime 触发 dev 下的 HMR）。
 * @returns {{ status: 'up-to-date' | 'synced', dest: string }}
 */
function syncIcon() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`源图标不存在：${SRC}（build/icon.png 是图标真源，需先放入该文件）`);
  }

  const next = fs.readFileSync(SRC);

  if (fs.existsSync(DEST) && fs.readFileSync(DEST).equals(next)) {
    return { status: 'up-to-date', dest: DEST };
  }

  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, next);
  return { status: 'synced', dest: DEST };
}

module.exports = { syncIcon, SRC, DEST };

// 作为 CLI 直接运行时（npm run icon）打印结果；被 require 时不打印。
if (require.main === module) {
  try {
    const { status, dest } = syncIcon();
    const rel = path.relative(ROOT, dest);
    console.log(status === 'synced' ? `synced: build/icon.png -> ${rel}` : `icon up to date: ${rel}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
