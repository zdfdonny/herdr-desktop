/**
 * 本地复刻 electron-builder FpmTarget.computeFpmMetaInfoOptions 的校验逻辑。
 *
 * 背景：CI 打 deb 时报 "Please specify author 'email'"，但本地打 win 不会触发，
 * 只有真正跑 Linux 打包才会暴露。这个脚本把那段判定搬到本地，
 * 让这类错误在提交前就能发现，不必等 CI 跑完。
 *
 * 逻辑对应 node_modules/app-builder-lib/out/targets/FpmTarget.js。
 */
const pkg = require('../package.json');

const opts = pkg.build?.linux ?? {};
const errors = [];

const projectUrl = pkg.homepage ?? null;
if (projectUrl == null) {
  errors.push('缺少 homepage（deb 需要 projectUrl）');
}

// maintainer 优先；否则回退到 author，且 author 必须有 email
let maintainer = opts.maintainer ?? null;
if (maintainer == null) {
  const a = pkg.author;
  if (a == null || a.email == null) {
    errors.push("Please specify author 'email' in the application package.json");
  } else {
    maintainer = `${a.name} <${a.email}>`;
  }
}

if (errors.length) {
  console.error('❌ deb 元信息校验失败，Linux 打包会中断：');
  for (const e of errors) console.error('   -', e);
  process.exit(1);
}

console.log('✅ deb 元信息可解析');
console.log('   url       :', projectUrl);
console.log('   maintainer:', maintainer);
console.log('   vendor    :', opts.vendor ?? maintainer);
console.log('   synopsis  :', opts.synopsis ?? '(默认取 description)');
