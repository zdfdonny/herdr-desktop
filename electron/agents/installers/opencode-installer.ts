/**
 * OpenCode 的集成安装器装配。
 *
 * 最复杂的一个：4 个安装目标（V1 插件、V1 TUI 插件、V2 TUI 入口、以及
 * `tui.jsonc`/`tui.json`/`cli.json` 三处注册），加上迁移检测与漂移校验。
 * 因此它独立成型，不走 `JsonHooksInstaller` 的钩子模型。
 */

import { promises as fs, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import type { IntegrationInstaller } from '../installer';
import { checkConfigTarget, declaredVersion, expandTilde, homeJoin, readText, scriptInstalled, writeConfigFile } from './kit';
import opencodePlugin from '../assets/opencode/herdr-desktop-agent-state.js?raw';
import opencodeTuiSession from '../assets/opencode/herdr-desktop-tui-session.js?raw';
import opencodeTuiEntry from '../assets/opencode/tui.js?raw';

/** V1 server 插件（由 V1 从 plugins/ 目录自动加载，不写进任何配置文件）。 */
const OPENCODE_PLUGIN_INSTALL_NAME = 'herdr-desktop-agent-state.js';
/** V1 TUI 插件文件名与 tui.jsonc/tui.json 的注册 spec。 */
const OPENCODE_TUI_PLUGIN_INSTALL_NAME = 'herdr-desktop-tui-session.js';
const OPENCODE_TUI_PLUGIN_SPEC = './herdr-desktop-tui-session.js';
/** V2 TUI 插件目录与 cli.json 的注册 spec。 */
const OPENCODE_V2_TUI_PLUGIN_DIR = 'herdr-desktop-opencode';
const OPENCODE_V2_TUI_PLUGIN_SPEC = './herdr-desktop-opencode';

/**
 * 读资产里的版本标记。
 *
 * 与汇总层同逻辑，但 opencode 要读**两个**产物（V1 TUI 插件与 V2 入口）的版本，
 * 所以需要本地版本而不是只由 hookStatuses 读主产物。
 */
function readInstalledVersion(assetPath: string | null): number | null {
  if (!assetPath) return null;
  try {
    const content = readFileSync(assetPath, 'utf8');
    const match = content.match(/HERDR_DESKTOP_INTEGRATION_VERSION=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function opencodeConfigDir(): string {
  return homeJoin('.config', 'opencode');
}

function opencodePluginPath(): string {
  return join(opencodeConfigDir(), 'plugins', OPENCODE_PLUGIN_INSTALL_NAME);
}

function opencodeTuiPluginPath(): string {
  return join(opencodeConfigDir(), OPENCODE_TUI_PLUGIN_INSTALL_NAME);
}

function opencodeV2Dir(): string {
  return join(opencodeConfigDir(), OPENCODE_V2_TUI_PLUGIN_DIR);
}

function opencodeStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return xdg ? join(expandTilde(xdg), 'opencode') : homeJoin('.local', 'state', 'opencode');
}

/** opencode 插件数组项匹配：支持字符串、{package} 对象、[spec, opts] 元组（对应 herdr plugin_entry_matches）。 */
function pluginEntryMatches(entry: unknown, spec: string): boolean {
  if (typeof entry === 'string') return entry === spec;
  if (Array.isArray(entry)) return typeof entry[0] === 'string' && entry[0] === spec;
  if (entry && typeof entry === 'object') {
    return (entry as Record<string, any>).package === spec;
  }
  return false;
}

/** 同步解析 JSONC 文件为对象；文件缺失/解析失败/根非对象时返回 null。 */
function parseJsoncObject(path: string): Record<string, any> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) return null;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

/** 某个 JSONC 文件的数组键里是否已注册指定插件。 */
function pluginIsConfigured(path: string, key: string, spec: string): boolean {
  const root = parseJsoncObject(path);
  if (!root) return false;
  const list = root[key];
  return Array.isArray(list) && list.some((entry) => pluginEntryMatches(entry, spec));
}

/** tui.jsonc 或 tui.json 任一文件已注册 V1 TUI 插件。 */
function tuiPluginIsConfigured(dir: string, spec: string): boolean {
  return (
    pluginIsConfigured(join(dir, 'tui.jsonc'), 'plugin', spec) ||
    pluginIsConfigured(join(dir, 'tui.json'), 'plugin', spec)
  );
}

/** 安装/卸载前预检 plugin/plugins 列表必须为数组（对应 herdr validate_tui_plugin_config）。 */
function validateOpencodeConfig(dir: string): void {
  for (const [name, key] of [
    ['tui.jsonc', 'plugin'],
    ['tui.json', 'plugin'],
    ['cli.json', 'plugins'],
  ] as const) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
    if (errors.length > 0) {
      throw new Error(`failed to parse OpenCode config at ${path}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`OpenCode config at ${path} must be a JSON object`);
    }
    const list = (value as Record<string, any>)[key];
    if (list !== undefined && !Array.isArray(list)) {
      throw new Error(`OpenCode config plugin list at ${path} must be an array`);
    }
  }
}

/** 在 JSONC 文件数组键里增删插件项，保留注释；清空后删除该键（对应 herdr add_plugin/remove_plugin）。 */
async function editPluginList(path: string, key: string, spec: string, add: boolean): Promise<boolean> {
  checkConfigTarget(path);
  const text = await readText(path);
  if (!text.trim()) {
    if (!add) return false;
    await writeConfigFile(path, `${JSON.stringify({ [key]: [spec] }, null, 2)}\n`);
    return true;
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    throw new Error(`failed to parse OpenCode config at ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenCode config at ${path} must be a JSON object`);
  }
  const root = value as Record<string, any>;
  if (root[key] !== undefined && !Array.isArray(root[key])) {
    throw new Error(`OpenCode config plugin list at ${path} must be an array`);
  }
  const list = Array.isArray(root[key]) ? root[key] : [];
  const present = list.some((entry) => pluginEntryMatches(entry, spec));
  if (add === present) return false;
  const next = add ? [...list, spec] : list.filter((entry) => !pluginEntryMatches(entry, spec));
  const edits = modify(text, [key], next.length > 0 ? next : undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  await writeConfigFile(path, applyEdits(text, edits));
  return true;
}

/** 注册 V1 TUI 插件；tui.json 已注册则复用，否则写入 tui.jsonc（对应 herdr add_tui_plugin）。 */
async function addTuiPlugin(dir: string, spec: string): Promise<string> {
  for (const name of ['tui.jsonc', 'tui.json']) {
    const path = join(dir, name);
    if (pluginIsConfigured(path, 'plugin', spec)) return path;
  }
  const path = join(dir, 'tui.jsonc');
  await editPluginList(path, 'plugin', spec, true);
  return path;
}

/** 从 tui.jsonc 与 tui.json 移除 V1 TUI 插件注册（对应 herdr remove_tui_plugin）。 */
async function removeTuiPlugin(dir: string, spec: string): Promise<string[]> {
  const updated: string[] = [];
  const errors: string[] = [];
  for (const name of ['tui.jsonc', 'tui.json']) {
    try {
      if (await editPluginList(join(dir, name), 'plugin', spec, false)) {
        updated.push(join(dir, name));
      }
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return updated;
}

/** OpenCode 首次 V2 启动会把 V1 配置迁移进 cli.json（仅在 cli.json 缺失时）。 */
function cliMigrationPending(dir: string): boolean {
  return existsSync(join(dir, 'tui.json')) || existsSync(join(opencodeStateDir(), 'kv.json'));
}

/** 注册 V2 TUI 插件到 cli.json；迁移未完成时返回 null（对应 herdr add_cli_plugin）。 */
async function addCliPlugin(dir: string, spec: string): Promise<string | null> {
  const path = join(dir, 'cli.json');
  checkConfigTarget(path);
  if (!existsSync(path) && cliMigrationPending(dir)) return null;
  await editPluginList(path, 'plugins', spec, true);
  return path;
}

/** 校验 opencode TUI 插件与 V2 注册是否完整（对应 herdr opencode_tui_integration_is_valid）。 */
function opencodeTuiIntegrationIsValid(): boolean {
  const dir = opencodeConfigDir();
  // 版本要求来自 descriptor；取不到说明注册表漏登记，按「无要求」处理。
  const expected = declaredVersion('opencode') ?? 0;
  const tuiVersion = readInstalledVersion(opencodeTuiPluginPath());
  if (tuiVersion === null || tuiVersion < expected) return false;
  if (!tuiPluginIsConfigured(dir, OPENCODE_TUI_PLUGIN_SPEC)) return false;
  if (!existsSync(join(dir, 'cli.json'))) return true;
  if (!pluginIsConfigured(join(dir, 'cli.json'), 'plugins', OPENCODE_V2_TUI_PLUGIN_SPEC)) return false;
  const v2Version = readInstalledVersion(join(opencodeV2Dir(), 'tui.js'));
  return v2Version !== null && v2Version >= expected;
}

/**
 * 创建 opencode 的集成安装器。
 *
 * 这是唯一一个**不沿用** `JsonHooksInstaller` 骨架的集成：它有 4 个安装目标，
 * 且注册协议是 JSONC 数组编辑（保留注释），与 hook 容器模型不同构。
 * 强行套骨架需要 5~6 个 opencode 专用钩子，会把只服务其它 18 个智能体的骨架污染。
 */
export function createOpencodeTarget(): IntegrationInstaller {
  const dir = opencodeConfigDir;
  const pluginPath = opencodePluginPath;
  return {
    configDir: dir,
    artifactPath: pluginPath,
    version: () => declaredVersion('opencode'),
    isInstalled() {
      // 以 V1 server 插件文件是否存在判定 not-installed；
      // TUI/V2 注册失效时由本对象的 validate 降级为 outdated。
      return scriptInstalled(pluginPath());
    },
    /** TUI / V2 注册失效（用户在 tui.jsonc / cli.json 里删掉了我们的条目）→ outdated。 */
    validate: () => opencodeTuiIntegrationIsValid(),
    async install() {
      const d = dir();
      checkConfigTarget(join(d, 'tui.jsonc'));
      checkConfigTarget(join(d, 'tui.json'));
      checkConfigTarget(join(d, 'cli.json'));
      let isDir = false;
      try {
        isDir = statSync(d).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        throw new Error(`opencode config directory not found at ${d}. install opencode first`);
      }
      validateOpencodeConfig(d);

      await fs.mkdir(join(d, 'plugins'), { recursive: true });
      // V1 server 插件（由 V1 从 plugins/ 自动加载）。
      await fs.writeFile(pluginPath(), opencodePlugin, 'utf8');
      // V1 TUI 插件（tui.js 仅作 V2 目录入口，转发到该文件）。
      await fs.writeFile(opencodeTuiPluginPath(), opencodeTuiSession, 'utf8');

      await addTuiPlugin(d, OPENCODE_TUI_PLUGIN_SPEC);

      // V2 TUI 目录入口（tui.js 转发到 V1 TUI 文件）。
      await fs.mkdir(opencodeV2Dir(), { recursive: true });
      await fs.writeFile(join(opencodeV2Dir(), 'tui.js'), opencodeTuiEntry, 'utf8');

      await addCliPlugin(d, OPENCODE_V2_TUI_PLUGIN_SPEC);
    },
    async uninstall() {
      const d = dir();
      checkConfigTarget(join(d, 'tui.jsonc'));
      checkConfigTarget(join(d, 'tui.json'));
      checkConfigTarget(join(d, 'cli.json'));
      const errors: string[] = [];
      try {
        await editPluginList(join(d, 'cli.json'), 'plugins', OPENCODE_V2_TUI_PLUGIN_SPEC, false);
      } catch (error) {
        errors.push((error as Error).message);
      }
      await fs.rm(opencodeV2Dir(), { recursive: true, force: true }).catch((error) => {
        errors.push(`failed to remove ${opencodeV2Dir()}: ${(error as Error).message}`);
      });
      try {
        await removeTuiPlugin(d, OPENCODE_TUI_PLUGIN_SPEC);
      } catch (error) {
        errors.push((error as Error).message);
      }
      await fs.rm(pluginPath(), { force: true }).catch(() => undefined);
      await fs.rm(opencodeTuiPluginPath(), { force: true }).catch(() => undefined);
      if (errors.length > 0) throw new Error(errors.join('; '));
    },
  };
}

