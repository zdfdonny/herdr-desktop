/*
 * 编码守卫：检测（并可选修复）文件编码问题。
 *
 * 三类判据，都对应本仓库真实踩过的坑：
 *
 * 1. **UTF-8 BOM** —— Vite 读 `package.json` 找 PostCSS 配置时用 JSON.parse，
 *    BOM 会让整个 CSS 链路挂掉。已复发两次（一次 54 个文件、一次 package.json）。
 *
 * 2. **C0/C1 控制字符** —— PowerShell heredoc 里反引号是转义前缀，
 *    `` `a `` 会写成 BEL(0x07)、`` `0 `` 写成 NUL。落在注释里肉眼不可见，
 *    却会进 git（本仓库发生过：9 个 declarative 安装器的注释被写成 `\x07ssets.ts`）。
 *
 * 3. **U+FFFD 替换字符 / 非法 UTF-8** —— 解码失败的痕迹。
 *
 * 为什么必须机器检查：TypeScript 与 esbuild 都能容忍 1 和 2，
 * `typecheck` 与全部 `test:*` 依然全绿，只有 `npm run dev` 才暴露。
 *
 * 用法：
 *   node scripts/check-encoding.mjs          # 只检查，有问题退出码 1（CI 用）
 *   node scripts/check-encoding.mjs --fix    # 就地修复（仅 BOM 可自动修）
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const TARGET_EXTS = [
  '.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.md', '.css', '.html', '.yml', '.yaml',
];
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'release', '.tmp', 'build',
  // 构建产物（含 electron-vite 的 dist-electron 与 electron-builder 的 dist）
  'dist-electron',
]);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** C0/C1 控制字符，放行 \t \n \r。 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(full, out);
    } else if (TARGET_EXTS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(ROOT);
const bomFiles = [];
const charIssues = [];

for (const file of files) {
  const buf = readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) bomFiles.push(file);

  // 非法 UTF-8：解码再编码应能逐字节还原（BOM 另行处理，先剥掉再比）
  const body = hasBom ? buf.subarray(BOM.length) : buf;
  const text = body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(body)) {
    charIssues.push({ file, line: 0, kind: '非法 UTF-8 字节序列', sample: '' });
    continue;
  }

  text.split('\n').forEach((line, idx) => {
    if (line.includes('\uFFFD')) {
      charIssues.push({ file, line: idx + 1, kind: 'U+FFFD', sample: line.trim().slice(0, 90) });
    } else if (CONTROL.test(line)) {
      const codes = [...new Set(
        [...line].filter((c) => CONTROL.test(c)).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`),
      )];
      charIssues.push({ file, line: idx + 1, kind: `控制字符 ${codes.join(',')}`, sample: line.trim().slice(0, 90) });
    }
  });
}

const fix = process.argv.includes('--fix');

if (bomFiles.length === 0 && charIssues.length === 0) {
  console.log(`check:encoding — ${files.length} 个文件，编码干净 ✓`);
  process.exit(0);
}

// BOM 可自动修复
if (fix && bomFiles.length > 0) {
  for (const file of bomFiles) writeFileSync(file, readFileSync(file).subarray(BOM.length));
  console.log(`check:encoding — 已修复 ${bomFiles.length} 个文件的 BOM`);
}

let failed = false;
if (bomFiles.length > 0 && !fix) {
  failed = true;
  console.error(`发现 ${bomFiles.length} 个文件带 UTF-8 BOM：`);
  for (const file of bomFiles) console.error(`  ${relative(ROOT, file)}`);
  console.error('  这会让 Vite 无法解析 package.json / PostCSS 配置（JSON.parse 失败）。');
}

if (charIssues.length > 0) {
  failed = true;
  // 控制字符无法自动修复：需要人判断原意（谁也不知道 0x07 本该是 a 还是 b）
  console.error(`发现 ${charIssues.length} 处非法字符 / 控制字符（需手工修）：`);
  for (const issue of charIssues) {
    console.error(`  ${relative(ROOT, issue.file)}:${issue.line}  [${issue.kind}]`);
    if (issue.sample) console.error(`      ${issue.sample}`);
  }
}

if (failed) {
  console.error('\n修复：BOM 可跑 `node scripts/check-encoding.mjs --fix`；控制字符需手工改。');
  process.exit(1);
}
console.log('check:encoding — BOM 已修复，无其它编码问题 ✓');
