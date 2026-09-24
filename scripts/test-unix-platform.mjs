/**
 * POSIX 平台解析逻辑的验证脚本。
 *
 * `unix.ts` 是给 macOS / Linux 用的实现。本脚本可以在 Windows 上运行，
 * 但**部分断言依赖真正的 POSIX 语义，在 Windows 上无法成立**，因此会跳过：
 *
 *   - 可执行位（X_OK）：Windows 的 access(X_OK) 只看只读属性，
 *     chmodSync 造不出「不可执行」的文件，故「跳过不可执行项」无法验证；
 *   - 路径语义：Windows 的 isAbsolute/join 产出 `C:\...`，
 *     含 `\` 的路径在 POSIX 实现里不走 PATH 分支。
 *
 * 因此本脚本在 Windows 上验证「与平台无关」的部分（扩展名补齐、
 * 目录判定、未命中返回 null、批处理判定），并在 macOS / Linux 上
 * 额外验证完整语义。CI 里应分别在 win32 与 linux 上各跑一次。
 *
 * 做法：先用 esbuild 把 `electron/platform/unix.ts` 打成 ESM，
 * 再直接 import 真实实现（而非复制一份逻辑），避免测试与实现漂移。
 *
 * 用法: npm run test:unix
 */
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp-unix.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp-unix.mjs — run: npm run test:unix');
  process.exit(2);
}
const { resolveExecutable, isWindowsBatchFile } = await import(pathToFileURL(bundlePath).href);

const isPosix = process.platform !== 'win32';

const results = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass, skipped: false });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
  );
}
function skip(name, why) {
  results.push({ name, pass: true, skipped: true });
  console.log(`SKIP  ${name}  (${why})`);
}

// ---- 夹具：两个 PATH 目录 ----
const root = mkdtempSync(join(tmpdir(), 'herdr-unix-test-'));
const dirA = join(root, 'a');
const dirB = join(root, 'b');
mkdirSync(dirA);
mkdirSync(dirB);

// dirA 里放一个**不可执行**的同名文件：POSIX 下必须被跳过
writeFileSync(join(dirA, 'tool'), 'not executable');
// dirB 里放可执行真身：应命中这里
writeFileSync(join(dirB, 'tool'), '#!/bin/sh\n');
chmodSync(join(dirB, 'tool'), 0o755);
// dirA 里放一个同名目录：不是文件，不应被当作可执行文件
mkdirSync(join(dirA, 'adir'));

const originalPath = process.env.PATH;
process.env.PATH = [dirA, dirB].join(delimiter);

try {
  if (isPosix) {
    check('PATH 顺序查找：跳过不可执行项，命中可执行真身', resolveExecutable('tool'), join(dirB, 'tool'));
  } else {
    skip('PATH 顺序查找：跳过不可执行项', 'Windows 无 X_OK 语义');
  }

  check('目录不算可执行文件', resolveExecutable('adir'), null);
  check('未安装的命令返回 null', resolveExecutable('definitely-not-installed-xyz'), null);
  check('空命令返回 null', resolveExecutable(''), null);

  // 绝对路径：仅在 POSIX 上才有意义（Windows 路径含 `\`，不走该分支）
  if (isPosix && isAbsolute(join(dirB, 'tool'))) {
    check('绝对路径命中', resolveExecutable(join(dirB, 'tool')), join(dirB, 'tool'));
  } else {
    skip('绝对路径命中', 'Windows 路径语义不适用 POSIX 分支');
  }

  check('绝对路径不存在返回 null', resolveExecutable(join(dirB, 'nope')), null);

  // 关键差异：Unix 不做 PATHEXT 式扩展名补齐
  check('不做扩展名补齐（tool.cmd 不命中）', resolveExecutable('tool.cmd'), null);
  // 关键差异：Unix 无批处理包装概念
  check('isWindowsBatchFile 在 Unix 恒为 false', isWindowsBatchFile('x.cmd'), false);
} finally {
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
const skipped = results.filter((r) => r.skipped).length;
console.log(
  `\n${results.length - failed.length - skipped}/${results.length - skipped} passed` +
    (skipped ? `, ${skipped} skipped (platform: ${process.platform})` : ''),
);
process.exit(failed.length === 0 ? 0 : 1);
