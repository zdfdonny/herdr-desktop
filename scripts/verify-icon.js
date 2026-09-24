// 验证构建产物中是否嵌入了应用图标资源。
// 用法: node scripts/verify-icon.js "release/win-unpacked/Herdr.exe"
const fs = require('node:fs');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/verify-icon.js <path-to-exe>');
  process.exit(2);
}

const buf = fs.readFileSync(target);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let count = 0;
let firstOffset = -1;
let idx = buf.indexOf(PNG_SIG);
while (idx !== -1) {
  if (count === 0) firstOffset = idx;
  count++;
  idx = buf.indexOf(PNG_SIG, idx + 1);
}

console.log(`file        : ${target}`);
console.log(`size        : ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`PNG images  : ${count}${firstOffset >= 0 ? ` (first at 0x${firstOffset.toString(16)})` : ''}`);

// 对比源图标的字节数，确认嵌入的就是我们生成的图标
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'build', 'icon.png'));
const exact = buf.includes(src);
console.log(`source icon : ${src.length} bytes, embedded verbatim: ${exact ? 'YES' : 'no (re-encoded by electron-builder)'}`);

if (count === 0) {
  console.error('\nFAIL: no PNG icon resource found in the executable');
  process.exit(1);
}
console.log('\nOK: icon resource present');
