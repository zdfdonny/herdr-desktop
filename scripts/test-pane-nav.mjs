/**
 * paneNavigation.findAdjacentPaneId 的验证脚本。
 *
 * 覆盖「按方向找相邻 pane」的核心规则：
 * - 左右/上下分屏的相邻查找；
 * - 方向上无候选时返回 null；
 * - 2×2 网格里重叠优先于主轴距离；
 * - 无正交重叠时退化为取主轴最近者。
 *
 * 做法与其它 test:* 脚本一致：esbuild 打包真实实现后 import，
 * 避免测试与实现漂移。用法: npm run test:pane-nav
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp-pane-nav.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp-pane-nav.mjs — run: npm run test:pane-nav');
  process.exit(2);
}
const { findAdjacentPaneId } = await import(pathToFileURL(bundlePath).href);

const results = [];
function check(name, actual, expected) {
  const pass = actual === expected;
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${actual}, want ${expected}`));
}

// ---- 左右分屏 ----
const sideA = { paneId: 'A', x: 0, y: 0, w: 0.5, h: 1 };
const sideB = { paneId: 'B', x: 0.5, y: 0, w: 0.5, h: 1 };
check('左右分屏：A 向右到 B', findAdjacentPaneId('A', 'right', [sideA, sideB]), 'B');
check('左右分屏：B 向左到 A', findAdjacentPaneId('B', 'left', [sideA, sideB]), 'A');
check('左右分屏：A 向左无候选', findAdjacentPaneId('A', 'left', [sideA, sideB]), null);
check('左右分屏：B 向右无候选', findAdjacentPaneId('B', 'right', [sideA, sideB]), null);

// ---- 上下分屏 ----
const top = { paneId: 'top', x: 0, y: 0, w: 1, h: 0.5 };
const bottom = { paneId: 'bottom', x: 0, y: 0.5, w: 1, h: 0.5 };
check('上下分屏：top 向下到 bottom', findAdjacentPaneId('top', 'down', [top, bottom]), 'bottom');
check('上下分屏：bottom 向上到 top', findAdjacentPaneId('bottom', 'up', [top, bottom]), 'top');
check('上下分屏：top 向上无候选', findAdjacentPaneId('top', 'up', [top, bottom]), null);

// ---- 2×2 网格 ----
const tl = { paneId: 'tl', x: 0, y: 0, w: 0.5, h: 0.5 };
const tr = { paneId: 'tr', x: 0.5, y: 0, w: 0.5, h: 0.5 };
const bl = { paneId: 'bl', x: 0, y: 0.5, w: 0.5, h: 0.5 };
const br = { paneId: 'br', x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
const grid = [tl, tr, bl, br];
check('2×2：tl 向右到 tr（重叠优先）', findAdjacentPaneId('tl', 'right', grid), 'tr');
check('2×2：tl 向下到 bl（重叠优先）', findAdjacentPaneId('tl', 'down', grid), 'bl');
check('2×2：tr 向左到 tl', findAdjacentPaneId('tr', 'left', grid), 'tl');
check('2×2：br 向上到 tr', findAdjacentPaneId('br', 'up', grid), 'tr');
check('2×2：br 向左到 bl', findAdjacentPaneId('br', 'left', grid), 'bl');

// ---- 正交重叠优先于主轴距离 ----
const focus = { paneId: 'focus', x: 0, y: 0, w: 0.4, h: 0.4 };
const overlapping = { paneId: 'overlap', x: 0.5, y: 0, w: 0.5, h: 0.4 };
const farBelow = { paneId: 'far', x: 0.5, y: 0.7, w: 0.5, h: 0.3 };
check(
  '右侧有重叠候选与远处候选：取重叠者',
  findAdjacentPaneId('focus', 'right', [focus, overlapping, farBelow]),
  'overlap',
);

// ---- 无正交重叠时取主轴最近 ----
const farOverlap = { paneId: 'far-overlap', x: 0.5, y: 0.8, w: 0.5, h: 0.2 };
check(
  '右侧无重叠候选：取主轴最近者',
  findAdjacentPaneId('focus', 'right', [focus, farOverlap]),
  'far-overlap',
);

// ---- 聚焦 pane 不在集合中 → null ----
check('聚焦 pane 不在集合中 → null', findAdjacentPaneId('missing', 'right', grid), null);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
