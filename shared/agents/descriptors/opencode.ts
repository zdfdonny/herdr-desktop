/**
 * OpenCode。
 *
 * 会话语义是这里最特别的（重构前 `terminal-state.ts:1522` 与 `:1914` 两处内联 if）：
 * - **未排序 select**：TUI 里用 `select` 切换会话时，上报**不带 seq**。若按常规
 *   水位处理会被当成过期上报丢弃，所以这条路径免水位、也不做 pending 替换记录；
 * - **防串台**：多个 pane 并发跑 opencode 时，别家会话的上报要直接丢弃，
 *   而不是走常规的「记 pending 替换」分支。
 *
 * 集成侧也最复杂：一个插件 + 一个 TUI 插件 + 一个 V2 TUI 入口，落在 4 个安装目标上。
 */

import { opencodeManifest } from '../../detect/manifests/opencode';
import type { AgentDescriptor } from '../descriptor';
import { joinPath } from '../spec/host';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/** V1 插件文件名（由 opencode 从 `plugins/` 自动加载，不写配置文件）。 */
export const OPENCODE_PLUGIN_INSTALL_NAME = 'herdr-desktop-agent-state.js';
/** V1 TUI 插件文件名，以及 `tui.jsonc` / `tui.json` 里登记的 spec。 */
export const OPENCODE_TUI_PLUGIN_INSTALL_NAME = 'herdr-desktop-tui-session.js';
export const OPENCODE_TUI_PLUGIN_SPEC = './herdr-desktop-tui-session.js';
/** V2 TUI 插件目录名，以及 `cli.json` 里登记的 spec。 */
export const OPENCODE_V2_TUI_PLUGIN_DIR = 'herdr-desktop-opencode';
export const OPENCODE_V2_TUI_PLUGIN_SPEC = './herdr-desktop-opencode';

export const opencode: AgentDescriptor = {
  id: 'opencode',
  detectionPriority: 110,
  label: 'OpenCode',
  command: () => 'opencode',

  detection: {
    identity: '\\bopencode\\b',
    aliases: ['opencode2', 'open-code'],
    manifest: opencodeManifest,
  },

  integration: {
    kind: 'plugin',
    version: 4,
    /** 没有环境变量覆盖：opencode 只认 XDG 默认位置。 */
    configDir: (host) => joinPath(host, host.home, '.config', 'opencode'),
    artifactPath: (host) =>
      joinPath(host, host.home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_NAME),
  },

  resume: {

    replacementSources: ['select'],
    tail: spacedTail('--session'),
  },

  policy: statePolicy({
    hookAuthority: 'full-lifecycle',
    sessionRebinding: {
      mode: 'unsequenced-select',
      allowForegroundTakeover: true,
      // 多个 pane 并发跑 opencode 时，别家会话的上报必须丢弃，否则状态会串台。
      rejectsCrossSessionReports: true,
    },
  }),
};
