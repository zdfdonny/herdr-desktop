/**
 * 渲染端平台判定。
 *
 * 快捷键需要在按键回调里**同步**判断平台，不能等 IPC 往返，
 * 因此这里直接从 navigator 派生（Electron 渲染进程里 UA 稳定可靠）。
 * 需要权威平台串（如设置页展示）时仍走 `getAppInfo()`。
 */

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;

/** 当前是否为 macOS。 */
export const isMac = /Mac|iPhone|iPad|iPod/i.test(ua);

/** 当前是否为 Windows。 */
export const isWindows = /Win/i.test(ua);

/**
 * 终端「搜索」快捷键的可读描述，用作搜索框提示。
 * mac 为 `⌘F`，Windows / Linux 为 `Ctrl+F`。
 */
export const searchShortcutLabel = isMac ? '⌘F' : 'Ctrl+F';
