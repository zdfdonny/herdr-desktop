/**
 * Windows ConPTY 的 OSC 透传处理。
 *
 * ConPTY 在「父进程 → 子进程」方向会过滤 OSC 序列：裸 `ESC ]` 开头的 OSC 整条不达
 * （实测单条只剩尾部碎片，16 条批量只剩一段），而 xterm 内建的查询应答（如 OSC 4
 * 调色板报告）正是这种裸形式——碎片会被子进程的 TUI 当成键入文本插入输入框。
 * 在 `ESC` 与 `]` 之间插入一个 NUL 字节即可完整透传，ConPTY 会丢掉这个 NUL，
 * 子进程最终收到标准形式的 OSC。
 *
 * 因此：**所有经 writeTerminal 写回 PTY 的数据都经过这里**（终端应答、按键、
 * 粘贴/拖放文本），由 src/ipc/client.ts 在唯一出口处统一调用。
 */

import { isWindows } from '../platform';

/**
 * 把数据里的裸 OSC 起始符 `ESC ]` 改写为 ConPTY 能透传的 `ESC NUL ]`。
 *
 * - 只匹配 `ESC` 紧跟 `]` 的形式，CSI（`ESC [`，如 `ESC[?997;1n`）等其它序列不受影响；
 * - 幂等：已是 `ESC NUL ]` 的输入不含子串 `ESC ]`，重复调用不会叠加 NUL；
 * - 非 Windows（forkpty）没有这个过滤器，原样返回。
 *
 * @param data 待写入 PTY 的数据（查询应答、按键、粘贴内容）
 * @param windows 平台判定，默认取当前渲染进程平台（复用 src/platform.ts 的 isWindows）；
 *   测试可显式传入以固定行为
 */
export function encodeOscForConpty(data: string, windows: boolean = isWindows): string {
  if (!windows || !data.includes('\x1b]')) return data;
  return data.replace(/\x1b]/g, '\x1b\x00]');
}
