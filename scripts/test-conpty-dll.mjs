/**
 * conpty.dll 补齐脚本（scripts/ensure-conpty-dll.js）的验证脚本。
 *
 * 覆盖打包钩子依赖的三块逻辑：
 * - archForModule：从 conpty.node 路径推断架构（prebuilds 目录自带架构，其余用调用方默认值）；
 * - resolveSourceDir：在 third_party/conpty 下挑版本目录，并存多个版本时取版本号最大者；
 * - findConptyModules / ensureConptyDll：找出所有 conpty.node，把 dll 补到同级 conpty/ 下。
 *
 * 该实现是 CJS，直接 require 真实文件即可（无需 esbuild 打包，天然不会与实现漂移）；
 * 目录结构在临时目录里现搭。用法: npm run test:conpty-dll
 */

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { archForModule, resolveSourceDir, findConptyModules, ensureConptyDll } = require('./ensure-conpty-dll.js');

const results = [];
function check(name, actual, expected) {
  const pass = actual === expected;
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${actual}, want ${expected}`));
}

// ---- archForModule：架构推断 ----
check(
  'prebuilds（反斜杠）→ 取目录名里的架构',
  archForModule(join('x', 'prebuilds', 'win32-arm64', 'conpty.node'), 'x64'),
  'arm64',
);
check('prebuilds（正斜杠）→ 取目录名里的架构', archForModule('x/prebuilds/win32-x64/conpty.node', 'arm64'), 'x64');
check('build/Release 无架构信息 → 用默认值', archForModule(join('x', 'build', 'Release', 'conpty.node'), 'arm64'), 'arm64');
check('build/Debug 无架构信息 → 用默认值', archForModule(join('x', 'build', 'Debug', 'conpty.node'), 'x64'), 'x64');

// ---- 临时 node-pty 目录 ----
// ensureConptyDll 收的是 node_modules 目录（内部再拼 node-pty），
// resolveSourceDir / findConptyModules 收的是 node-pty 目录本身。
const root = mkdtempSync(join(tmpdir(), 'herdr-conpty-'));
const nodeModules = join(root, 'node_modules');
const nodePty = join(nodeModules, 'node-pty');
const newDll = Buffer.from('conpty-dll-1.23');
const newConsole = Buffer.from('openconsole-1.23');
const oldDll = Buffer.from('conpty-dll-1.9');

function writeFile(relPath, bytes) {
  mkdirSync(join(nodePty, relPath, '..'), { recursive: true });
  writeFileSync(join(nodePty, relPath), bytes);
}

// 四个待补齐的 conpty.node：构建产物两份（架构靠默认值）+ 两种架构的 prebuilds
writeFile(join('build', 'Release', 'conpty.node'), Buffer.from('x'));
writeFile(join('build', 'Debug', 'conpty.node'), Buffer.from('x'));
writeFile(join('prebuilds', 'win32-x64', 'conpty.node'), Buffer.from('x'));
writeFile(join('prebuilds', 'win32-arm64', 'conpty.node'), Buffer.from('x'));
// 非 conpty 的 node 文件不应被认成待补齐目标
writeFile(join('prebuilds', 'win32-ia32', 'winpty.node'), Buffer.from('x'));
// 版本目录：并存 1.9 与 1.23，且 1.9 的 dll 内容不同 —— 取错版本会被内容断言抓住
writeFile(join('third_party', 'conpty', '1.9.20240101', 'win10-x64', 'conpty.dll'), oldDll);
writeFile(join('third_party', 'conpty', '1.23.251008001', 'win10-x64', 'conpty.dll'), newDll);
writeFile(join('third_party', 'conpty', '1.23.251008001', 'win10-x64', 'OpenConsole.exe'), newConsole);
writeFile(join('third_party', 'conpty', '1.23.251008001', 'win10-arm64', 'conpty.dll'), newDll);
writeFile(join('third_party', 'conpty', '1.23.251008001', 'win10-arm64', 'OpenConsole.exe'), newConsole);

// ---- resolveSourceDir：版本挑选 ----
check('多个版本并存 → 取版本号最大者', resolveSourceDir(nodePty, 'x64'), join(nodePty, 'third_party', 'conpty', '1.23.251008001', 'win10-x64'));
check('没有该架构的目录 → null', resolveSourceDir(nodePty, 'ia32'), null);
check('third_party/conpty 不存在 → null', resolveSourceDir(join(root, 'nope'), 'x64'), null);

// ---- findConptyModules：目标发现 ----
check('只认 conpty.node（4 个）', findConptyModules(nodePty).length, 4);
check('node-pty 不存在 → 空列表', findConptyModules(join(root, 'nope')).length, 0);

// ---- ensureConptyDll：补齐 ----
const patched = ensureConptyDll(nodeModules, 'x64');
check('四个 conpty.node 各补 2 个文件', patched.length, 8);
check(
  '补进去的是版本号最大的那份 dll',
  readFileSync(join(nodePty, 'build', 'Release', 'conpty', 'conpty.dll')).toString(),
  newDll.toString(),
);
check(
  'prebuilds/win32-arm64 用 arm64 目录的 dll',
  readFileSync(join(nodePty, 'prebuilds', 'win32-arm64', 'conpty', 'conpty.dll')).toString(),
  newDll.toString(),
);
check('幂等：再跑一次无需补齐', ensureConptyDll(nodeModules, 'x64').length, 0);
check('没装 node-pty → 空列表且不抛错', ensureConptyDll(join(root, 'nope'), 'x64').length, 0);

// ---- 缺 dll 时抛错（宁可打包失败，也不要产出面板全挂的包）----
rmSync(join(nodePty, 'third_party', 'conpty', '1.23.251008001', 'win10-arm64'), { recursive: true, force: true });
let threw = false;
try {
  ensureConptyDll(nodeModules, 'x64');
} catch {
  threw = true;
}
check('arm64 缺 dll → 抛错', threw, true);

rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
