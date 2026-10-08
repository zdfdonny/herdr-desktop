/**
 * shortcuts/capture.ts 的验证脚本。
 *
 * 覆盖：
 * - KeyboardEvent → Electron accelerator 的映射（修饰键顺序、字母大写、特殊键）；
 * - 不安全键位判定（裸可打印单键）；
 * - 基于共享事实源的冲突检测（含用户覆盖生效后）。
 *
 * 用法: npm run test:shortcuts
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp-shortcuts.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp-shortcuts.mjs — run: npm run test:shortcuts');
  process.exit(2);
}
const { eventToAccelerator, isUnsafeAccelerator, validateShortcut, matchShortcut } =
  await import(pathToFileURL(bundlePath).href);

const results = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
  );
}

// ---- eventToAccelerator ----
const ev = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

check('Ctrl+Shift+X', eventToAccelerator(ev('X', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+X');
check('Ctrl+V（小写字母转大写）', eventToAccelerator(ev('v', { ctrlKey: true })), 'Ctrl+V');
check('Ctrl+Alt+Left', eventToAccelerator(ev('ArrowLeft', { ctrlKey: true, altKey: true })), 'Ctrl+Alt+Left');
check('F2 无修饰', eventToAccelerator(ev('F2')), 'F2');
check('纯修饰键 Control → null', eventToAccelerator(ev('Control', { ctrlKey: true })), null);
check('纯修饰键 Meta → null', eventToAccelerator(ev('Meta', { metaKey: true })), null);
// Node 环境 isMac=false，meta → Super
check('meta → Super（非 mac）', eventToAccelerator(ev('v', { metaKey: true })), 'Super+V');

// ---- isUnsafeAccelerator ----
check('裸字母 X 不安全', isUnsafeAccelerator('X'), true);
check('Ctrl+X 安全', isUnsafeAccelerator('Ctrl+X'), false);
check('F2 安全', isUnsafeAccelerator('F2'), false);
check('Left 安全', isUnsafeAccelerator('Left'), false);
check('裸 Space 不安全', isUnsafeAccelerator('Space'), true);
check('Ctrl+Space 安全', isUnsafeAccelerator('Ctrl+Space'), false);

// ---- validateShortcut ----
check('与 split-vertical 默认键位冲突', validateShortcut('focus-pane-left', 'CmdOrCtrl+Alt+V'), {
  ok: false,
  reason: 'conflict',
  conflictAction: 'split-vertical',
});
check('与 focus-pane-right 默认键位冲突', validateShortcut('focus-pane-left', 'CmdOrCtrl+Alt+Right'), {
  ok: false,
  reason: 'conflict',
  conflictAction: 'focus-pane-right',
});
check('裸字母不安全', validateShortcut('close-tab', 'X'), { ok: false, reason: 'unsafe' });
check('无冲突通过', validateShortcut('close-tab', 'Ctrl+Alt+K'), { ok: true });

// 用户覆盖生效后：split-vertical 被改成 Ctrl+Alt+V，仍按生效键位判冲突
check(
  '覆盖生效后仍判冲突',
  validateShortcut('focus-pane-left', 'Ctrl+Alt+V', { 'split-vertical': 'Ctrl+Alt+V' }),
  { ok: false, reason: 'conflict', conflictAction: 'split-vertical' },
);
// 覆盖后原默认键位 CmdOrCtrl+Alt+V 不再被 split-vertical 占用，改判为通过
//（注意：Node 环境 isMac=false，CmdOrCtrl 归一化为 Ctrl）
check(
  '覆盖后默认键位释放，不再冲突',
  validateShortcut('focus-pane-left', 'CmdOrCtrl+Alt+V', { 'split-vertical': 'Ctrl+Alt+K' }),
  { ok: true },
);
// 归一化后 CmdOrCtrl 形式与默认键位仍判冲突（Node 下 CmdOrCtrl → Ctrl）
check(
  'CmdOrCtrl 形式与默认键位归一化后判冲突',
  validateShortcut('focus-pane-left', 'CmdOrCtrl+Alt+V'),
  { ok: false, reason: 'conflict', conflictAction: 'split-vertical' },
);

// ---- matchShortcut（Node 环境 isMac=false） ----
check('Ctrl+Alt+Left → focus-pane-left', matchShortcut(ev('ArrowLeft', { ctrlKey: true, altKey: true })), { action: 'focus-pane-left' });
check('Ctrl+Alt+Down → focus-pane-down', matchShortcut(ev('ArrowDown', { ctrlKey: true, altKey: true })), { action: 'focus-pane-down' });
check('Ctrl+Alt+Up → focus-pane-up', matchShortcut(ev('ArrowUp', { ctrlKey: true, altKey: true })), { action: 'focus-pane-up' });
check('Ctrl+Alt+Right → focus-pane-right', matchShortcut(ev('ArrowRight', { ctrlKey: true, altKey: true })), { action: 'focus-pane-right' });
check('Ctrl+Alt+V → split-vertical', matchShortcut(ev('v', { ctrlKey: true, altKey: true })), { action: 'split-vertical' });
check('Ctrl+Alt+H → split-horizontal', matchShortcut(ev('h', { ctrlKey: true, altKey: true })), { action: 'split-horizontal' });
check('Ctrl+Alt+X → close-pane', matchShortcut(ev('x', { ctrlKey: true, altKey: true })), { action: 'close-pane' });
check('Ctrl+1 → switch-tab 1', matchShortcut(ev('1', { ctrlKey: true })), { action: 'switch-tab', index: 1 });
check('Ctrl+9 → switch-tab 9', matchShortcut(ev('9', { ctrlKey: true })), { action: 'switch-tab', index: 9 });
check('Ctrl+Shift+C → new-tab', matchShortcut(ev('C', { ctrlKey: true, shiftKey: true })), { action: 'new-tab' });
check('Ctrl+Shift+N → next-tab', matchShortcut(ev('N', { ctrlKey: true, shiftKey: true })), { action: 'next-tab' });
check('Ctrl+Shift+P → previous-tab', matchShortcut(ev('P', { ctrlKey: true, shiftKey: true })), { action: 'previous-tab' });
check('Ctrl+Tab 不是任何可分发快捷键', matchShortcut(ev('Tab', { ctrlKey: true })), null);
check('Ctrl+C 不被拦截（终端复制）', matchShortcut(ev('c', { ctrlKey: true })), null);
check('Ctrl+V 不被拦截（终端粘贴）', matchShortcut(ev('v', { ctrlKey: true })), null);
check('Ctrl+F 不被拦截（终端搜索）', matchShortcut(ev('f', { ctrlKey: true })), null);
check('纯修饰键不匹配', matchShortcut(ev('Control', { ctrlKey: true })), null);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
