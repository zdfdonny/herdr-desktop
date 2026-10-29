/**
 * 声明式智能体的安装器装配 —— 把 descriptor 的 `integration.hooks` 变成安装器实例。
 *
 * 从 `electron/runtime/integration/index.ts` 抽出，让每个智能体的
 * `declarative/<id>.ts` 能直接调用它（避免与汇总层形成循环依赖）。
 */

import type { AgentDescriptor } from '../../../shared/agents/descriptor';
import { hostEnv } from '../../support/host-env';
import type { IntegrationInstaller } from '../installer';
import { JsonHooksInstaller, type HookEvent } from './json-hooks-installer';
import { commandFor, ensureHook, ensureHooksObject, hooksObjectIfPresent, jsonHooksIo, removeHook, scriptInstalled } from './kit';
import { join } from 'node:path';
export function declarativeInstaller(
  descriptor: AgentDescriptor,
  /** 产物内容（由智能体自己的文件提供 —— 资产归属智能体，不再集中查表）。 */
  artifactContent: () => string,
): IntegrationInstaller {
  const integration = descriptor.integration!;
  const layout = integration.hooks!;
  const host = hostEnv();
  const configDir = (): string | null => integration.configDir(host);
  const artifactPath = (): string | null => integration.artifactPath(host);
  const commandOpts = { encodedCommand: layout.encodedCommand };

  const events: HookEvent[] = [[layout.event, 'session'], ...(layout.stateEvents ?? [])];

  return new JsonHooksInstaller(
    {
      configFile: layout.configFile,
      shape: layout.shape,
      event: layout.event,
      events,
      removedEvents: layout.removedEvents,
      matcher: layout.matcher,
      timeout: layout.timeout,
      quiet: layout.quiet,
      withVersion: layout.withVersion,
      encodedCommand: layout.encodedCommand,
      artifactSubdir: layout.artifactSubdir,
    },
    {
      configDir,
      artifactPath,
      version: () => integration.version,
      command: (path, action) => commandFor(commandOpts, path, action),
      artifactIsInstalled: (path) => scriptInstalled(path),
      artifactContent,
      io: jsonHooksIo(),
      ops: { ensureHooksObject, hooksObjectIfPresent, ensureHook, removeHook },
    },
    join,
  );
}

