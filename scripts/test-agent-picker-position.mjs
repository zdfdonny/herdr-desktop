/**
 * AgentPicker 浮窗定位（computePickerAnchor）验证脚本。
 *
 * 覆盖的核心场景是「侧栏项目过多时浮窗显示不全」：
 * - 按钮在中部 → 向下弹出，高度夹在下方可用空间内；
 * - 按钮贴近窗口底部、下方放不下列表 → 向上翻转（bottom 锚定）；
 * - 两侧都放不下 → 选择空间更大的一侧，超出部分由浮窗滚动呈现；
 * - 首帧尚未实测内容高度时按假定高度兜底；
 * - 水平方向居中于侧栏内容页，并夹在窗口内；内容页缺失时按按钮右缘居中。
 *
 * 做法与其它 test:* 一致：先用 esbuild 把被测模块打成 ESM，再 import 真实实现
 * （而非复制逻辑），避免测试与实现漂移。
 *
 * 用法: npm run test:picker
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp/agent-picker-position.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp/agent-picker-position.mjs — run: npm run test:picker');
  process.exit(2);
}
const {
  computePickerAnchor,
  PICKER_ASSUMED_HEIGHT,
  PICKER_GAP,
  PICKER_MARGIN,
  PICKER_MIN_HEIGHT,
  PICKER_WIDTH,
} = await import(pathToFileURL(bundlePath).href);

const results = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
  );
}

/** 侧栏内容页：左侧 48px 图标栏 + 316px 内容页 → 浮窗 left 恒为 90。 */
const PANEL = { left: 48, width: 316 };
const PANEL_LEFT = 48 + 316 / 2 - PICKER_WIDTH / 2;

/** 组装一次调用，只写关心的字段。 */
function anchor({ top, bottom, right = 300, contentHeight, viewportWidth = 1280, viewportHeight = 900, panel = PANEL }) {
  return computePickerAnchor({
    button: { top, bottom, right },
    panel,
    viewportWidth,
    viewportHeight,
    contentHeight,
  });
}

/** 下方可用空间。 */
const below = (bottom, viewportHeight = 900) => viewportHeight - bottom - PICKER_GAP - PICKER_MARGIN;
/** 上方可用空间。 */
const above = (top) => top - PICKER_GAP - PICKER_MARGIN;

// ---- 向下弹出 ----

check(
  '按钮在窗口中上部 → 向下弹出，高度为下方可用空间',
  anchor({ top: 100, bottom: 124, contentHeight: 280 }),
  { left: PANEL_LEFT, top: 124 + PICKER_GAP, maxHeight: below(124) },
);

// ---- 核心回归：按钮贴近窗口底部 ----

/*
 * 项目多时「+」按钮贴近窗口底部：下方只剩 44px，实测内容 280px。
 * 旧实现固定向下弹出 → 浮窗下半部分落到窗口外，表现为「显示不全」。
 */
check(
  '按钮贴近窗口底部 → 向上翻转，高度为上方可用空间',
  anchor({ top: 820, bottom: 844, contentHeight: 280 }),
  { left: PANEL_LEFT, bottom: 900 - 820 + PICKER_GAP, maxHeight: above(820) },
);

/*
 * 更贴近实际的边界：下方 214px 容得下旧阈值（180px），却容不下实测的 273px 列表。
 * 必须按实测高度翻转，否则用户仍要滚动才能看到最后一个条目。
 */
check(
  '下方放不下实测高度但超过旧阈值 → 仍向上翻转',
  anchor({ top: 650, bottom: 674, contentHeight: 273 }),
  { left: PANEL_LEFT, bottom: 900 - 650 + PICKER_GAP, maxHeight: above(650) },
);

/** 两侧都放不下：选择空间更大的一侧（此处下方 434 > 上方 418），其余滚动。 */
check(
  '两侧都放不下 → 留在空间更大的一侧并允许滚动',
  anchor({ top: 430, bottom: 454, contentHeight: 500 }),
  { left: PANEL_LEFT, top: 454 + PICKER_GAP, maxHeight: below(454) },
);

// ---- 首帧兜底：内容高度未知 ----

check(
  '首帧未知内容高度、下方不足假定高度 → 向上翻转',
  anchor({ top: 637, bottom: 661 }),
  { left: PANEL_LEFT, bottom: 900 - 637 + PICKER_GAP, maxHeight: above(637) },
);

check(
  '首帧未知内容高度、下方超过假定高度 → 向下弹出',
  anchor({ top: 564, bottom: 588 }),
  { left: PANEL_LEFT, top: 588 + PICKER_GAP, maxHeight: below(588) },
);

/** 矮窗口：上下都不足，且上方并不更宽裕 → 不翻转，落到兜底最小高度。 */
check(
  '矮窗口且上方不宽裕 → 保持向下并应用兜底最小高度',
  anchor({ top: 40, bottom: 64, viewportHeight: 120 }),
  { left: PANEL_LEFT, top: 64 + PICKER_GAP, maxHeight: PICKER_MIN_HEIGHT },
);

// ---- 水平方向 ----

/** 窗口比浮窗还窄：left 夹到最小留白，不能出现负值。 */
check(
  '窗口比浮窗窄 → left 夹到最小留白',
  anchor({ top: 100, bottom: 124, right: 200, panel: { left: 0, width: 200 }, viewportWidth: 220 }),
  { left: PICKER_MARGIN, top: 124 + PICKER_GAP, maxHeight: below(124) },
);

/** 找不到侧栏内容页时，退化为按按钮右缘居中。 */
check(
  '缺少内容页矩形 → 按按钮右缘居中',
  anchor({ top: 100, bottom: 124, panel: null }),
  { left: 300 - PICKER_WIDTH / 2, top: 124 + PICKER_GAP, maxHeight: below(124) },
);

// ---- 不变式 ----

const down = anchor({ top: 100, bottom: 124, contentHeight: 280 });
const up = anchor({ top: 820, bottom: 844, contentHeight: 280 });

check('向下弹出时不带 bottom', down.bottom, undefined);
check('向上弹出时不带 top', up.top, undefined);
/** 向上弹出时底边贴住按钮，不会盖住按钮本身。 */
check('向上弹出的底边在按钮上方', 900 - up.bottom <= 820 - PICKER_GAP, true);
/** 向下弹出时浮窗底边不越出窗口。 */
check('向下弹出不越出窗口下边缘', down.top + down.maxHeight <= 900 - PICKER_MARGIN, true);
/** 兜底假定高度存在且合理（约 8 个条目）。 */
check('假定高度用于首帧兜底', PICKER_ASSUMED_HEIGHT > PICKER_MIN_HEIGHT, true);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error(`failed: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
