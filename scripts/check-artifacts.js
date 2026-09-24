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
  ['mac', 'x64', 'zip'], ['mac', 'arm64', 'zip'],
  ['win', 'x64', 'zip'], ['win', 'arm64', 'zip'],
];

const out = combos.map(([os, arch, ext]) => expand(tpl, os, arch, ext));
out.push(expand(nsisTpl, 'win', 'x64', 'exe'));
out.push(expand(nsisTpl, 'win', 'arm64', 'exe'));

const uniq = new Set(out);
console.log('模板:', tpl);
console.log('NSIS 模板:', nsisTpl);
console.log('生成文件数:', out.length, '去重后:', uniq.size);
console.log(uniq.size === out.length ? '✅ 无文件名冲突' : '❌ 存在文件名冲突');
out.sort().forEach((f) => console.log('   ', f));
