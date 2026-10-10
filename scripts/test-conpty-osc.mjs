/**
 * conpty-osc.encodeOscForConpty 的验证脚本。
 *
 * 覆盖「Windows ConPTY 下把裸 OSC 改写为 ESC NUL ]」的核心规则：
 * - 裸 OSC（含 xterm 内建的 OSC 4/10/11/12 应答）被改写；
 * - 幂等：已是 ESC NUL ] 的形式不再叠加 NUL；
 * - CSI 序列（997 颜色方案报告、DA1 应答）不受影响；
 * - 非 Windows 原样返回；
 * - 关键性质：去掉 NUL 后必须与原串**逐字节相同**（ConPTY 会丢掉 NUL，
 *   子进程最终收到的就是标准形式的 OSC）。
 *
 * 做法与其它 test:* 脚本一致：esbuild 打包真实实现后 import，
 * 避免测试与实现漂移。用法: npm run test:conpty-osc
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp-conpty-osc.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp-conpty-osc.mjs — run: npm run test:conpty-osc');
  process.exit(2);
}
const { encodeOscForConpty } = await import(pathToFileURL(bundlePath).href);

const ESC = '\u001b';
const NUL = '\u0000';
const BEL = '\u0007';
const ST = `${ESC}\\`;

/** 把不可见字符转成可读形式，便于失败时定位。 */
const show = (s) =>
  s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);

const results = [];
function check(name, actual, expected) {
  const pass = actual === expected;
  results.push({ name, pass });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${show(actual)}, want ${show(expected)}`),
  );
}

/** 去掉 NUL 后应与输入逐字节相同（ConPTY 丢 NUL 后的实际投递内容）。 */
function checkRoundTrip(name, input) {
  const encoded = encodeOscForConpty(input, true);
  check(`${name}：去 NUL 后与原串一致`, encoded.split(NUL).join(''), input);
}

// ---- Windows：裸 OSC 被改写 ----
const osc4 = `${ESC}]4;14;rgb:0606/b6b6/d4d4${BEL}`;
check('Windows：OSC 4 应答插入 NUL', encodeOscForConpty(osc4, true), `${ESC}${NUL}]4;14;rgb:0606/b6b6/d4d4${BEL}`);
checkRoundTrip('Windows：OSC 4 应答', osc4);

const osc4St = `${ESC}]4;0;rgb:1818/1818/1b1b${ST}`;
check('Windows：ST 结尾的 OSC 4 应答同样改写', encodeOscForConpty(osc4St, true), `${ESC}${NUL}]4;0;rgb:1818/1818/1b1b${ST}`);
checkRoundTrip('Windows：ST 结尾的 OSC 4 应答', osc4St);

const osc10 = `${ESC}]10;rgb:ffff/ffff/ffff${BEL}`;
check('Windows：OSC 10 应答插入 NUL', encodeOscForConpty(osc10, true), `${ESC}${NUL}]10;rgb:ffff/ffff/ffff${BEL}`);
checkRoundTrip('Windows：OSC 10 应答', osc10);

const osc12 = `${ESC}]12;rgb:cccc/cccc/cccc${BEL}`;
check('Windows：OSC 12 应答插入 NUL', encodeOscForConpty(osc12, true), `${ESC}${NUL}]12;rgb:cccc/cccc/cccc${BEL}`);
checkRoundTrip('Windows：OSC 12 应答', osc12);

// ---- 幂等：herdr 自己构造的应答已带 NUL ----
const already = `${ESC}${NUL}]11;rgb:0d0d/0d0d/0d0d${BEL}`;
check('幂等：已含 NUL 的 OSC 不变', encodeOscForConpty(already, true), already);

// ---- CSI 不受影响 ----
const report997 = `${ESC}[?997;1n`;
check('CSI：997 颜色方案报告不变', encodeOscForConpty(report997, true), report997);
const da1 = `${ESC}[?1;2c`;
check('CSI：DA1 应答不变', encodeOscForConpty(da1, true), da1);
const keyboard = `${ESC}[>7u`;
check('CSI：键盘协议协商不变', encodeOscForConpty(keyboard, true), keyboard);

// ---- 组合串：997 + OSC 10 + OSC 11（buildThemeResponse 的实际形态）----
const combined = `${report997}${ESC}]10;rgb:ffff/ffff/ffff${BEL}${ESC}]11;rgb:0d0d/0d0d/0d0d${BEL}`;
const combinedOut = encodeOscForConpty(combined, true);
check(
  '组合串：只改 OSC 两处',
  combinedOut,
  `${report997}${ESC}${NUL}]10;rgb:ffff/ffff/ffff${BEL}${ESC}${NUL}]11;rgb:0d0d/0d0d/0d0d${BEL}`,
);
check('组合串：NUL 数量为 2', (combinedOut.match(/\u0000/g) ?? []).length, 2);
checkRoundTrip('组合串', combined);
check('组合串：改写后不再含裸 OSC 起始符', combinedOut.includes(`${ESC}]`), false);

// ---- 16 条批量查询（pi 启动时一次写入的规模）----
const batch = Array.from({ length: 16 }, (_, i) => `${ESC}]4;${i};?${BEL}`).join('');
const batchOut = encodeOscForConpty(batch, true);
check('批量：16 条查询各插入一个 NUL', (batchOut.match(/\u0000/g) ?? []).length, 16);
checkRoundTrip('批量：16 条查询', batch);
check('批量：改写后长度 +16', batchOut.length, batch.length + 16);

// ---- 非 Windows：原样返回 ----
for (const [name, input] of [
  ['OSC 4 应答', osc4],
  ['OSC 10 应答', osc10],
  ['组合串', combined],
  ['批量查询', batch],
]) {
  check(`非 Windows：${name} 原样返回`, encodeOscForConpty(input, false), input);
}

// ---- 普通文本 / 空串 ----
check('普通文本：含 ] 但无 ESC 不变', encodeOscForConpty('a]b[c', true), 'a]b[c');
check('普通文本：粘贴内容不变', encodeOscForConpty('hello 世界\r', true), 'hello 世界\r');
check('空串不变', encodeOscForConpty('', true), '');
check('只有 ESC 无 ] 不变', encodeOscForConpty(`${ESC}[A`, true), `${ESC}[A`);

// ---- 默认参数：取当前进程平台判定，不应抛错（Node 下非 Windows → 原样返回）----
check('默认参数（Node 下非 Windows）：原样返回', encodeOscForConpty(osc4), osc4);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
