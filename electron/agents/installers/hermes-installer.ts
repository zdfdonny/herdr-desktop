/**
 * Hermes Agent 的集成安装器。
 *
 * `JsonHooksInstaller` 的子类。唯一的 Python 插件集成：
 * - 集成产物是**插件目录**（`plugin.yaml` 清单 + `__init__.py` 入口），
 *   主产物是入口文件，清单是必须一起写的附加文件；
 * - 卸载要删**整个插件目录**，只删文件会留下空壳；
 * - 启用靠 `config.yaml` 的 `plugins.enabled` 列表（手写 YAML 行编辑），
 *   不走 JSON hooks。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { IntegrationInstaller } from '../installer';
import {
  JsonHooksInstaller,
  type JsonHooksInstallerDeps,
  type JsonHooksLayout,
  type JoinPath,
} from './json-hooks-installer';
import {
  declaredVersion,
  ensureHook,
  ensureHooksObject,
  expandTilde,
  homeJoin,
  hooksObjectIfPresent,
  jsonHooksIo,
  readText,
  removeHook,
  scriptInstalled,
  writeConfigFile,
} from './kit';
import hermesPlugin from '../assets/hermes/__init__.py?raw';
import hermesManifest from '../assets/hermes/plugin.yaml?raw';

/** 插件目录名（同时是 `config.yaml` 里 enabled 列表的条目）。 */
const HERMES_PLUGIN_NAME = 'herdr-desktop-agent-state';

/** hermes 需要的额外 IO。 */
export interface HermesInstallerIo {
  /** 插件目录（含清单与入口）。 */
  pluginDir(dir: string): string;
  /** 插件清单内容（`plugin.yaml`）。 */
  manifestContent(): string;
  /** 写普通文件（插件清单不需要可执行位）。 */
  writeFile(path: string, content: string): Promise<void>;
  /** 读 `config.yaml`。 */
  readText(path: string): Promise<string>;
  /** 原子写配置文件。 */
  writeConfigFile(path: string, content: string): Promise<void>;
  /** 在 YAML 里启用/禁用插件。 */
  setEnabled(content: string, enabled: boolean): string;
}

export class HermesInstaller extends JsonHooksInstaller {
  constructor(
    layout: JsonHooksLayout,
    deps: JsonHooksInstallerDeps,
    join: JoinPath,
    private readonly hermes: HermesInstallerIo,
  ) {
    super(layout, deps, join);
  }

  /** 启用靠 YAML 列表，不走 JSON hooks 流程。 */
  protected override managesHooksConfig(): boolean {
    return false;
  }

  /** Python 插件由宿主加载，不需要可执行位。 */
  protected override needsExecutableBit(): boolean {
    return false;
  }

  /** 卸载删整个插件目录（含清单）。 */
  protected override removesArtifactDirectory(): boolean {
    return true;
  }

  /** 写清单 + 启用插件。主产物（`__init__.py`）由基类写入。 */
  protected override async registerExtra(
    dir: string,
    _artifactPath: string,
    _configPath: string,
  ): Promise<void> {
    const pluginDir = this.hermes.pluginDir(dir);
    await this.hermes.writeFile(this.join(pluginDir, 'plugin.yaml'), this.hermes.manifestContent());

    // 在 config.yaml 里启用插件（对应 herdr ensure_hermes_plugin_enabled）。
    const configPath = this.join(dir, 'config.yaml');
    const content = await this.hermes.readText(configPath);
    const updated = this.hermes.setEnabled(content, true);
    // 无变化就不写回，避免无谓的文件改动与 mtime 抖动。
    if (updated !== content) await this.hermes.writeConfigFile(configPath, updated);
  }

  /** 从 config.yaml 里禁用插件（插件目录由基类删）。 */
  protected override async unregisterExtra(
    dir: string,
    _artifactPath: string | null,
    _configPath: string,
  ): Promise<void> {
    const configPath = this.join(dir, 'config.yaml');
    const content = await this.hermes.readText(configPath);
    const updated = this.hermes.setEnabled(content, false);
    if (updated !== content) await this.hermes.writeConfigFile(configPath, updated);
  }
}

/** hermes 的配置目录（`$HERMES_HOME` 或 `~/.hermes`）。 */
function hermesDir(): string {
  const env = process.env.HERMES_HOME?.trim();
  return env ? expandTilde(env) : homeJoin('.hermes');
}

/**
 * 在 `config.yaml` 里启用/禁用插件（对应 herdr `ensure_hermes_plugin_enabled`）。
 *
 * 手写 YAML 行编辑而不是引入 YAML 库：只需要维护一个 `plugins.enabled` 字符串列表，
 * 而库会把用户的注释与格式全部重排 —— 对用户配置做无声重排是不可接受的。
 */
export function updateHermesEnabled(content: string, enabled: boolean): string {
  const lines = content.split('\n');
  const pluginsIdx = lines.findIndex((l) => /^plugins\s*:/.test(l));

  if (pluginsIdx < 0) {
    if (!enabled) return content;
    // 没有 plugins 段：追加一个。
    return `${content.replace(/\n+$/, '')}\nplugins:\n  enabled:\n    - ${HERMES_PLUGIN_NAME}\n`;
  }

  // 找 enabled 段（plugins 之后、同缩进的第一个键）
  let enabledIdx = -1;
  for (let i = pluginsIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim().length > 0) break;
    if (/^\s+enabled\s*:/.test(lines[i])) {
      enabledIdx = i;
      break;
    }
  }

  if (enabledIdx < 0) {
    if (!enabled) return content;
    // plugins 段存在但没有 enabled：插在 plugins 之后
    lines.splice(pluginsIdx + 1, 0, '  enabled:', `    - ${HERMES_PLUGIN_NAME}`);
    return lines.join('\n');
  }

  // 收集 enabled 列表项的行号区间
  const itemIndent = '    ';
  let itemEnd = enabledIdx + 1;
  while (itemEnd < lines.length && /^\s+-\s/.test(lines[itemEnd])) itemEnd++;

  const items = lines.slice(enabledIdx + 1, itemEnd);
  const has = items.some((l) => l.replace(/^\s+-\s*/, '').trim() === HERMES_PLUGIN_NAME);

  if (enabled && !has) {
    lines.splice(itemEnd, 0, `${itemIndent}- ${HERMES_PLUGIN_NAME}`);
    return lines.join('\n');
  }
  if (!enabled && has) {
    const kept = items.filter((l) => l.replace(/^\s+-\s*/, '').trim() !== HERMES_PLUGIN_NAME);
    lines.splice(enabledIdx + 1, items.length, ...kept);
    return lines.join('\n');
  }
  return content;
}

/** 创建 hermes 的集成安装器。 */
export function createHermesTarget(): IntegrationInstaller {
  const configDir = (): string | null => hermesDir();
  const pluginDir = (dir: string): string => join(dir, 'plugins', HERMES_PLUGIN_NAME);

  return new HermesInstaller(
    {
      configFile: 'config.yaml',
      shape: 'nested',
      event: 'SessionStart',
      // 启用靠 YAML 列表；这里保留声明以便与其它智能体同构。
      events: [],
      artifactSubdir: `plugins/${HERMES_PLUGIN_NAME}`,
    },
    {
      configDir,
      artifactPath: () => {
        const dir = configDir();
        return dir ? join(pluginDir(dir), '__init__.py') : null;
      },
      version: () => declaredVersion('hermes'),
      // hermes 不走命令 hook，占位即可。
      command: () => '',
      artifactIsInstalled: (path) => scriptInstalled(path),
      artifactContent: () => hermesPlugin,
      io: jsonHooksIo(),
      ops: { ensureHooksObject, hooksObjectIfPresent, ensureHook, removeHook },
    },
    join,
    {
      pluginDir,
      manifestContent: () => hermesManifest,
      writeFile: (path, content) => fs.writeFile(path, content, 'utf8'),
      readText: (path) => readText(path),
      writeConfigFile: (path, content) => writeConfigFile(path, content),
      setEnabled: (content, enabled) => updateHermesEnabled(content, enabled),
    },
  );
}
