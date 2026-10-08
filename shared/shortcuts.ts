/**
 * 快捷键单一事实源 —— Main 与 Renderer 共用。
 *
 * - Main 用它构建应用菜单 accelerator（electron/main.ts buildMenu）；
 * - Renderer 用它展示「快捷键帮助」弹窗与设置页的「快捷键」分区。
 *
 * accelerator 使用 Electron 菜单 accelerator 语法：`CmdOrCtrl` 在 macOS
 * 解析为 Cmd、其余平台解析为 Ctrl。indexed 动作（1..9）的 accelerator 以
 * `1` 结尾，展开时把末尾的 `1` 替换为具体序号。
 *
 * 用户自定义键位通过 `ShortcutOverrides`（action id → accelerator）覆盖默认值，
 * 持久化在 AppSettings.shortcuts，由 Main 在构建菜单时读取。
 * `remappable: false` 的条目（既有系统/终端快捷键）只做展示与冲突保护，不提供改键。
 */

import type { MessageKey } from './i18n';

export type ShortcutActionId =
  | 'help'
  | 'settings'
  | 'add-project'
  | 'new-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'switch-tab'
  | 'close-tab'
  | 'rename-tab'
  | 'split-vertical'
  | 'split-horizontal'
  | 'close-pane'
  | 'focus-pane-left'
  | 'focus-pane-down'
  | 'focus-pane-up'
  | 'focus-pane-right'
  | 'terminal-copy'
  | 'terminal-paste'
  | 'terminal-search';

export type ShortcutGroup = 'global' | 'project' | 'tab' | 'pane' | 'terminal';

/** 用户自定义键位覆盖：action id → Electron accelerator。 */
export type ShortcutOverrides = Record<string, string>;

export interface ShortcutDefinition {
  action: ShortcutActionId;
  /** Electron accelerator；`CmdOrCtrl` 按平台解析。 */
  accelerator: string;
  group: ShortcutGroup;
  /** 动作文案 key（帮助面板 / 设置页 / 菜单 label 共用）。 */
  labelKey: MessageKey;
  /** indexed 动作（1..9）：accelerator 末尾的 `1` 为占位序号。 */
  indexed?: boolean;
  /** 是否允许改键；false 表示既有系统/终端快捷键，只展示不可改。 */
  remappable?: boolean;
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { action: 'help', accelerator: 'CmdOrCtrl+/', group: 'global', labelKey: 'shortcuts.help' },
  {
    action: 'settings',
    accelerator: 'CmdOrCtrl+,',
    group: 'global',
    labelKey: 'shortcuts.settings',
    remappable: false,
  },
  {
    action: 'add-project',
    accelerator: 'CmdOrCtrl+Shift+O',
    group: 'project',
    labelKey: 'shortcuts.addProject',
    remappable: false,
  },
  {
    action: 'new-tab',
    accelerator: 'CmdOrCtrl+Shift+C',
    group: 'tab',
    labelKey: 'shortcuts.newTab',
  },
  { action: 'next-tab', accelerator: 'CmdOrCtrl+Shift+N', group: 'tab', labelKey: 'shortcuts.nextTab' },
  {
    action: 'previous-tab',
    accelerator: 'CmdOrCtrl+Shift+P',
    group: 'tab',
    labelKey: 'shortcuts.previousTab',
  },
  {
    action: 'switch-tab',
    accelerator: 'CmdOrCtrl+1',
    group: 'tab',
    labelKey: 'shortcuts.switchTab',
    indexed: true,
  },
  {
    action: 'close-tab',
    accelerator: 'CmdOrCtrl+Shift+X',
    group: 'tab',
    labelKey: 'shortcuts.closeTab',
  },
  { action: 'rename-tab', accelerator: 'F2', group: 'tab', labelKey: 'shortcuts.renameTab' },
  {
    action: 'split-vertical',
    accelerator: 'CmdOrCtrl+Alt+V',
    group: 'pane',
    labelKey: 'shortcuts.splitVertical',
  },
  {
    action: 'split-horizontal',
    accelerator: 'CmdOrCtrl+Alt+H',
    group: 'pane',
    labelKey: 'shortcuts.splitHorizontal',
  },
  {
    action: 'close-pane',
    accelerator: 'CmdOrCtrl+Alt+X',
    group: 'pane',
    labelKey: 'shortcuts.closePane',
  },
  {
    action: 'focus-pane-left',
    accelerator: 'CmdOrCtrl+Alt+Left',
    group: 'pane',
    labelKey: 'shortcuts.focusPaneLeft',
  },
  {
    action: 'focus-pane-down',
    accelerator: 'CmdOrCtrl+Alt+Down',
    group: 'pane',
    labelKey: 'shortcuts.focusPaneDown',
  },
  {
    action: 'focus-pane-up',
    accelerator: 'CmdOrCtrl+Alt+Up',
    group: 'pane',
    labelKey: 'shortcuts.focusPaneUp',
  },
  {
    action: 'focus-pane-right',
    accelerator: 'CmdOrCtrl+Alt+Right',
    group: 'pane',
    labelKey: 'shortcuts.focusPaneRight',
  },
  {
    action: 'terminal-copy',
    accelerator: 'CmdOrCtrl+C',
    group: 'terminal',
    labelKey: 'shortcuts.terminalCopy',
    remappable: false,
  },
  {
    action: 'terminal-paste',
    accelerator: 'CmdOrCtrl+V',
    group: 'terminal',
    labelKey: 'shortcuts.terminalPaste',
    remappable: false,
  },
  {
    action: 'terminal-search',
    accelerator: 'CmdOrCtrl+F',
    group: 'terminal',
    labelKey: 'shortcuts.terminalSearch',
    remappable: false,
  },
];

/** 帮助面板 / 设置页的分组展示顺序。 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'global',
  'project',
  'tab',
  'pane',
  'terminal',
];

export const SHORTCUT_GROUP_LABEL_KEYS: Record<ShortcutGroup, MessageKey> = {
  global: 'shortcuts.global',
  project: 'shortcuts.project',
  tab: 'shortcuts.tab',
  pane: 'shortcuts.pane',
  terminal: 'shortcuts.terminal',
};

/** 按分组取出快捷方式（保持 SHORTCUTS 内的声明顺序）。 */
export function shortcutsByGroup(group: ShortcutGroup): ShortcutDefinition[] {
  return SHORTCUTS.filter((s) => s.group === group);
}

/** 某动作实际生效的 accelerator：优先用户覆盖，回退默认。 */
export function effectiveAccelerator(
  def: ShortcutDefinition,
  overrides?: ShortcutOverrides,
): string {
  return overrides?.[def.action] ?? def.accelerator;
}

/** 是否允许改键。 */
export function isRemappable(def: ShortcutDefinition): boolean {
  return def.remappable !== false && !def.indexed;
}

/** indexed 动作展开为第 index（1..9）个 accelerator。 */
export function indexedAccelerator(base: string, index: number): string {
  return base.replace(/1$/, String(index));
}

/** 把 Electron accelerator 转成给用户看的键位文案。 */
export function displayAccelerator(
  def: ShortcutDefinition,
  isMac: boolean,
  overrides?: ShortcutOverrides,
): string {
  const base = effectiveAccelerator(def, overrides);
  const acc = def.indexed ? base.replace(/1$/, '1-9') : base;
  return prettifyAccelerator(acc.replace('CmdOrCtrl', isMac ? 'Cmd' : 'Ctrl'), isMac);
}

/** 把一条 Electron accelerator 字符串转成给用户看的键位文案。 */
export function prettifyAccelerator(acc: string, isMac: boolean): string {
  return acc
    .split('+')
    .map((token) => prettyToken(token, isMac))
    .join('+');
}

function prettyToken(token: string, isMac: boolean): string {
  switch (token) {
    case 'Cmd':
      return '⌘';
    case 'Ctrl':
      return isMac ? '⌃' : 'Ctrl';
    case 'Alt':
      return isMac ? '⌥' : 'Alt';
    case 'Shift':
      return isMac ? '⇧' : 'Shift';
    case 'Super':
      return isMac ? '⌘' : 'Win';
    case 'Left':
      return '←';
    case 'Right':
      return '→';
    case 'Up':
      return '↑';
    case 'Down':
      return '↓';
    default:
      return token;
  }
}
