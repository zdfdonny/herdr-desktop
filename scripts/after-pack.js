// electron-builder afterPack 钩子：为打包产物补齐 node-pty 的 conpty.dll。
//
// 主进程启用 useConptyDll 后，conpty.node 必须在同级 conpty/ 目录下找到 conpty.dll，
// 否则 spawn 直接抛错、每个终端面板都起不来。而打包时 @electron/rebuild 会重建
// node-pty 并清掉它 postinstall 拷进去的那份 dll（详见 scripts/ensure-conpty-dll.js）。
const path = require('path');
const { ensureConptyDll, findConptyModules } = require('./ensure-conpty-dll');

// electron-builder 的 Arch 枚举值 → node-pty third_party 目录用的架构名
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const targetArch = ARCH_NAMES[context.arch] || process.arch;
  const resources = path.join(context.appOutDir, 'resources');

  // asar 默认开启，node-pty 被 asarUnpack 到 app.asar.unpacked 下；若将来关掉 asar
  // 则它在 app 目录里。两处都试，缺的那处自然是空操作。
  const packedRoots = [
    path.join(resources, 'app.asar.unpacked', 'node_modules'),
    path.join(resources, 'app', 'node_modules'),
  ];

  let packedModules = 0;
  for (const root of packedRoots) {
    packedModules += findConptyModules(path.join(root, 'node-pty')).length;
    const patched = ensureConptyDll(root, targetArch);
    if (patched.length > 0) {
      console.log(`  • 补齐 conpty.dll (${targetArch})，共 ${patched.length} 个文件`);
    }
  }
  // 宁可打包失败，也不要产出一个所有面板都起不来的安装包
  if (packedModules === 0) {
    throw new Error(
      `打包产物里找不到 node-pty 的 conpty.node（已查 ${resources}），装上后终端面板会全部启动失败`,
    );
  }

  // 同一次重建也会清掉项目自身的 node_modules，顺手补回，避免打包后本地 npm run dev
  // 起不来面板；它跑在宿主上，所以用宿主架构。被运行中的进程占用时只告警，不影响打包。
  try {
    const patched = ensureConptyDll(path.join(context.packager.projectDir, 'node_modules'), process.arch);
    if (patched.length > 0) {
      console.log(`  • 补齐项目 node_modules 的 conpty.dll (${process.arch})，共 ${patched.length} 个文件`);
    }
  } catch (error) {
    console.warn(`  • 项目 node_modules 的 conpty.dll 未补齐：${error.message}`);
  }
};
