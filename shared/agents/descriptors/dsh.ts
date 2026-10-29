/**
 * DeepSeek Harness —— 唯一的 **web 型**智能体。
 *
 * 它不是一个终端 TUI：主进程托管 `dsh web` 服务，渲染端用 `<webview>` 内嵌，
 * 所以没有屏幕可供检测（`detection` 缺省）。
 *
 * 两处专属能力（重构前是 `router.ts:729` 的 `source === 'herdr:dsh'` 与
 * `session.ts:32` 的硬编码名）：
 * - **按 sessionId 反查 pane**：同一个会话可以被多个 pane 同时查看，
 *   状态上报要路由到所有绑定该会话的 pane，而不是只回报文自带的 paneId；
 * - **命名统一**：集成表原本用 `'dsh-web'` 作键，而检测/上报/命令一律是 `'dsh'`，
 *   导致 `hookStatuses()['dsh']` 永远查不到（完成判定静默失效）。这里统一成 `dsh`。
 */

import type { AgentDescriptor } from '../descriptor';
import { joinPath } from '../spec/host';
import { statePolicy } from '../spec/policy';

/** 状态插件的文件名（带 `.mjs`，确保按 ESM 加载，与 profile 的 package.json 无关）。 */
export const DSH_STATUS_PLUGIN_NAME = 'herdr-desktop-agent-state.mjs';

/** Harness 全局 home：`$DSH_HOME` → `~/.dsh`。 */
export function dshHome(host: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}): string {
  const env = host.env.DSH_HOME?.trim();
  return env ? env : joinPath(host, host.home, '.dsh');
}

export const dsh: AgentDescriptor = {
  id: 'dsh',
  detectionPriority: 250,
  label: 'DeepSeek Harness',
  command: () => 'dsh',
  // 实际启动的是 `dsh web`；记录完整命令供会话恢复重放。
  launchArgs: ['web'],
  hosting: 'web',

  // 没有屏幕可供检测（web pane）。

  integration: {
    kind: 'web-plugin',
    version: 5,
    configDir: (host) => dshHome(host),
    artifactPath: (host) => joinPath(host, dshHome(host), 'plugins', DSH_STATUS_PLUGIN_NAME),
  },

  // 不支持会话恢复：web pane 的会话由 `dsh web` 自己管理。

  policy: statePolicy({
    hookAuthority: 'state',
    routeBySessionId: true,
  }),
};
