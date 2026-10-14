// 保证每个 conpty.node 旁边都有配套的 conpty.dll。
//
// 背景：主进程启用 node-pty 的 useConptyDll（见 electron/runtime/pty-manager.ts）后，
// conpty.node 会在自己所在目录下找 `conpty/conpty.dll`
// （node-pty 的 src/win/conpty.cc -> LoadConptyDll），找不到直接抛错，没有静默回退。
//
// 而 electron-builder 打包时默认执行的 @electron/rebuild 会重建 node-pty，并清掉它
// postinstall 拷进 build/Release/conpty/ 的那份 dll —— 打包产物因此缺 dll，装出来的
// 应用每个面板都起不来（本地 npm run dev 同样会被这次重建波及）。
//
// 本脚本把 node-pty third_party 里的 dll 补回每个 conpty.node 旁边，幂等，可重复执行。
// 由 electron-builder 的 afterPack 钩子调用（scripts/after-pack.js），也可手动执行：
//   node scripts/ensure-conpty-dll.js [node_modules 目录] [默认 arch]
const fs = require('fs');
const path = require('path');

const DLL_NAME = 'conpty.dll';
const CONSOLE_NAME = 'OpenConsole.exe';

// 从 conpty.node 的路径推断架构：prebuilds 目录自带 win32-<arch>，其余（build/Release、
// build/Debug）是构建时针对目标架构编译的，只能用调用方给的默认值。
function archForModule(modulePath, fallbackArch) {
  const match = /prebuilds[\\/]win32-([a-z0-9_]+)[\\/]/i.exec(modulePath);
  return match ? match[1] : fallbackArch;
}

// 找出 node-pty 里所有 conpty.node：构建产物 + 各架构的 prebuilds。
function findConptyModules(nodePtyDir) {
  const found = [];
  for (const rel of ['build/Release', 'build/Debug']) {
    const candidate = path.join(nodePtyDir, rel, 'conpty.node');
    if (fs.existsSync(candidate)) found.push(candidate);
  }
  const prebuildsDir = path.join(nodePtyDir, 'prebuilds');
  if (fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir)) {
      const candidate = path.join(prebuildsDir, entry, 'conpty.node');
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

// 找 third_party/conpty/<版本>/win10-<arch>。版本目录名由 node-pty 决定（如
// 1.23.251008001），不写死；万一并存多个版本，取版本号最大的那个（numeric 比较，
// 否则 1.9 会排到 1.23 之后）。
function resolveSourceDir(nodePtyDir, arch) {
  const root = path.join(nodePtyDir, 'third_party', 'conpty');
  if (!fs.existsSync(root)) return null;
  const versions = fs
    .readdirSync(root)
    .filter((name) => fs.statSync(path.join(root, name)).isDirectory())
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const dir = path.join(root, version, `win10-${arch}`);
    if (fs.existsSync(path.join(dir, DLL_NAME))) return dir;
  }
  return null;
}

/**
 * 为 rootDir（node_modules）里的 node-pty 补齐 conpty.dll。
 * 返回补齐/覆盖的文件路径列表；没装 node-pty、或没有 conpty.node（非 Windows）时返回空列表。
 */
function ensureConptyDll(rootDir, fallbackArch = process.arch) {
  const nodePtyDir = path.join(rootDir, 'node-pty');
  if (!fs.existsSync(nodePtyDir)) return [];

  const patched = [];
  for (const modulePath of findConptyModules(nodePtyDir)) {
    const arch = archForModule(modulePath, fallbackArch);
    const sourceDir = resolveSourceDir(nodePtyDir, arch);
    if (!sourceDir) {
      throw new Error(`缺少 node-pty 自带的 conpty.dll（${arch}），无法为 ${modulePath} 补齐`);
    }
    // 目标目录固定是 conpty.node 同级的 conpty/
    const targetDir = path.join(path.dirname(modulePath), 'conpty');
    fs.mkdirSync(targetDir, { recursive: true });
    // 两个文件都是运行必需的（conpty.dll 由 LoadConptyDll 加载，OpenConsole.exe 是它拉起的
    // 控制台宿主），与 node-pty 自己的 postinstall 一致：不做存在性兜底，缺了就直接报错。
    for (const name of [DLL_NAME, CONSOLE_NAME]) {
      const source = path.join(sourceDir, name);
      const target = path.join(targetDir, name);
      // 内容完全一致就跳过：正常情况下（dll 已在位）打包日志保持安静，也不会白改 mtime
      if (fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(source))) continue;
      fs.copyFileSync(source, target);
      patched.push(target);
    }
  }
  return patched;
}

module.exports = { ensureConptyDll, findConptyModules, archForModule, resolveSourceDir };

if (require.main === module) {
  const rootDir = process.argv[2] || path.join(__dirname, '..', 'node_modules');
  const arch = process.argv[3] || process.arch;
  const patched = ensureConptyDll(rootDir, arch);
  console.log(patched.length === 0 ? 'conpty.dll 已就绪，无需补齐' : `已补齐:\n${patched.join('\n')}`);
}
