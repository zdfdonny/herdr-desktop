/**
 * 快捷键捕获与校验 —— 纯函数，便于单元测试。
 *
 * - eventToAccelerator：把 DOM KeyboardEvent 转成 Electron accelerator 字符串；
 * - isUnsafeAccelerator：无修饰键的可打印单键会拦截正常输入，判为不安全；
 * - validateShortcut：基于共享事实源做「不安全 / 冲突」校验。
 */

import type { ShortcutActionId, ShortcutOverrides } from '@shared/shortcuts';
import { SHORTCUTS, effectiveAccelerator, indexedAccelerator } from '@shared/shortcuts';
import { isMac } from '../platform';

export type ShortcutValidation =
  | { ok: true }
  | { ok: false; reason: 'unsafe' }
  | { ok: false; reason: 'conflict'; conflictAction: ShortcutActionId };

export interface ShortcutMatch {
  action: ShortcutActionId;
  /** switch-tab（1..9）命中时的序号；其余动作没有。 */
  index?: number;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** 把 KeyboardEvent 转成 Electron accelerator；无法映射（如纯修饰键）返回 null。 */
export function eventToAccelerator(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = keyToken(e.key);
  if (!key) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(isMac ? 'Cmd' : 'Super');
  mods.push(key);
  return mods.join('+');
}

/** 键名 → Electron accelerator 键名。 */
function keyToken(key: string): string | null {
  switch (key) {
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case ' ':
      return 'Space';
    default:
      break;
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) return key; // F1..F12
  if (/^(Tab|Enter|Escape|Backspace|Delete|Home|End|PageUp|PageDown)$/.test(key)) return key;
  if (key.length === 1) {
    return /[a-z]/.test(key) ? key.toUpperCase() : key;
  }
  return null;
}

/** 无修饰键也安全的特殊键（F 键 / 方向 / 导航键等）。 */
const SAFE_BARE_KEYS =
  /^(F([1-9]|1[0-2])|Left|Right|Up|Down|Tab|Enter|Escape|Backspace|Delete|Home|End|PageUp|PageDown)$/;

/** 无修饰键的可打印单键（字母/数字/符号/空格）会拦截正常输入，判为不安全。 */
export function isUnsafeAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const hasModifier = modifiers.some((m) =>
    ['Ctrl', 'Alt', 'Shift', 'Cmd', 'Super', 'CmdOrCtrl'].includes(m),
  );
  return !hasModifier && !SAFE_BARE_KEYS.test(key);
}

/**
 * 校验一个新键位：不安全（裸可打印单键）或与其它动作（含默认键位）冲突时返回失败。
 */
export function validateShortcut(
  action: ShortcutActionId,
  accelerator: string,
  overrides?: ShortcutOverrides,
): ShortcutValidation {
  if (isUnsafeAccelerator(accelerator)) {
    return { ok: false, reason: 'unsafe' };
  }
  const normalized = normalizeAccelerator(accelerator);
  for (const def of SHORTCUTS) {
    if (def.action === action) continue;
    if (normalizeAccelerator(effectiveAccelerator(def, overrides)) === normalized) {
      return { ok: false, reason: 'conflict', conflictAction: def.action };
    }
  }
  return { ok: true };
}

/**
 * 把 KeyboardEvent 匹配到某个可分发快捷键；不匹配返回 null。
 *
 * 应用菜单 accelerator 在部分平台 / 终端聚焦场景下不稳定，这里用全局 keydown 兜底，
 * 保证焦点在终端里时标签切换（含 switch-tab 1..9）、新建/关闭标签、拆分/聚焦窗格等
 * 都能触发。
 *
 * 只匹配「可分发」动作（remappable !== false）：settings / add-project / 终端 C/V/F
 * 走各自通道，不能被这里拦截，否则会破坏设置菜单、添加项目与终端复制粘贴。
 */
export function matchShortcut(
  e: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  },
  overrides?: ShortcutOverrides,
): ShortcutMatch | null {
  const captured = eventToAccelerator(e);
  if (!captured) return null;
  const normalized = normalizeAccelerator(captured);

  for (const def of SHORTCUTS) {
    if (def.remappable === false) continue;

    if (def.indexed) {
      const base = effectiveAccelerator(def, overrides);
      for (let index = 1; index <= 9; index += 1) {
        if (normalizeAccelerator(indexedAccelerator(base, index)) === normalized) {
          return { action: def.action, index };
        }
      }
    } else if (normalizeAccelerator(effectiveAccelerator(def, overrides)) === normalized) {
      return { action: def.action };
    }
  }

  return null;
}

/** 归一化 accelerator：解析 CmdOrCtrl，修饰键按 Ctrl/Alt/Shift/Cmd(Super) 顺序。 */
function normalizeAccelerator(acc: string): string {
  const tokens = acc.replace('CmdOrCtrl', isMac ? 'Cmd' : 'Ctrl').split('+');
  const key = tokens[tokens.length - 1];
  const mods = tokens.slice(0, -1);
  const order = ['Ctrl', 'Alt', 'Shift', isMac ? 'Cmd' : 'Super'];
  const sorted: string[] = [];
  for (const mod of order) {
    if (mods.includes(mod)) sorted.push(mod);
  }
  for (const mod of mods) {
    if (!order.includes(mod)) sorted.push(mod);
  }
  sorted.push(key);
  return sorted.join('+');
}
