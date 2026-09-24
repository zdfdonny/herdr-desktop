// 一次性校验：确认 artifactName 模板能为 6 个平台×架构组合生成互不冲突的文件名。
// 直接读 package.json 里的真实模板，避免文档与配置脱节。
const path = require('path');
const pkg = require(path.join(__dirname, '..', 'package.json'));

const tpl = pkg.build.artifactName;
const nsisTpl = pkg.build.nsis.artifactName;
const version = pkg.version;

function expand(t, os, arch, ext) {
  return t
    .replace(/\$\{productName\}/g, pkg.build.productName)
    .replace(/\$\{version\}/g, version)
    .replace(/\$\{os\}/g, os)
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{ext\}/g, ext);
}

const combos = [
  ['linux', 'x64', 'AppImage'], ['linux', 'x64', 'deb'],
  ['linux', 'arm64', 'AppImage'], ['linux', 'arm64', 'deb'],
  ['mac', 'x64', 'dmg'], ['mac', 'arm64', 'dmg'],
];

// Windows 走 NSIS，用独立的模板
const out = combos.map(([os, arch, ext]) => expand(tpl, os, arch, ext));
out.push(expand(nsisTpl, 'win', 'x64', 'exe'));
out.push(expand(nsisTpl, 'win', 'arm64', 'exe'));

const uniq = new Set(out);

// electron-builder 只认它内置的宏，自定义宏（如 ${artifactPrefix}）不会报配置
// 错误，而是等到真正打包时才抛 "macro xxx is not defined"。
// 这里提前拦一道，避免这种错误拖到 CI 才暴露。
const BUILTIN = new Set(['productName', 'version', 'os', 'arch', 'ext', 'name', 'channel']);
const used = [...`${tpl}${nsisTpl}`.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
const unknown = [...new Set(used)].filter((m) => !BUILTIN.has(m));

console.log('模板:', tpl);
console.log('NSIS 模板:', nsisTpl);
if (unknown.length) {
  console.error(`❌ 使用了 electron-builder 不支持的宏: ${unknown.join(', ')}`);
  process.exit(1);
}
console.log('宏校验: ✅ 全部为内置宏');
console.log('生成文件数:', out.length, '去重后:', uniq.size);
console.log(uniq.size === out.length ? '✅ 无文件名冲突' : '❌ 存在文件名冲突');
out.sort().forEach((f) => console.log('   ', f));
