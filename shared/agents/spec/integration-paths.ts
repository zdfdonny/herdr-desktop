/**
 * 集成资产文件名与路径工具。
 *
 * 重构前 `electron/runtime/integration/index.ts:43` 用模块加载期的
 * `isWindows ? 'x.ps1' : 'x.sh'` 决定文件名，导致：
 * - 无法在测试里对另一平台断言；
 * - descriptor 无法声明产物路径（路径依赖模块级常量）。
 * 现在把平台当参数传进来。
 */

import type { HostEnv } from './host';
import { joinPath } from './host';

/** hook 脚本名（PowerShell / POSIX 各一份）。 */
export function hookScriptName(host: HostEnv): string {
  return host.platform === 'win32'
    ? 'herdr-desktop-agent-state.ps1'
    : 'herdr-desktop-agent-state.sh';
}

/** 会话专用脚本名（qwen / letta 用，对应 herdr 的 `*_HOOK_INSTALL_NAME`）。 */
export function sessionScriptName(host: HostEnv): string {
  return host.platform === 'win32'
    ? 'herdr-desktop-agent-session.ps1'
    : 'herdr-desktop-agent-session.sh';
}

/** `<configDir>/<subdir>/<scriptName>`，subdir 为 null 时直接放在 configDir 下。 */
export function hookArtifactPath(
  host: HostEnv,
  configDir: string | null,
  subdir: string | null,
  scriptName: string,
): string | null {
  if (!configDir) return null;
  return subdir
    ? joinPath(host, configDir, subdir, scriptName)
    : joinPath(host, configDir, scriptName);
}
