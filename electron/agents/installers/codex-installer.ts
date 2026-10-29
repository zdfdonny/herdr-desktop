/**
 * Codex 的集成安装器 —— `JsonHooksInstaller` 的第二个子类。
 *
 * 与声明式智能体的唯一差异：除了 `hooks.json`，还要在 `config.toml` 里
 * 打开 `[features] hooks = true`（codex 的事件总开关）。
 *
 * 因此只需覆写 `registerExtra`（安装后写 TOML），卸载时**不需**回滚 TOML ——
 * 这与原实现一致：`hooks = true` 是幂等的特性开关，关掉它反而可能影响
 * 用户其它依赖 hooks 的配置。
 */

import { JsonHooksInstaller } from './json-hooks-installer';
import type { JsonHooksInstallerDeps, JsonHooksLayout, JoinPath } from './json-hooks-installer';
import type { IntegrationInstaller } from '../installer';
import { join } from 'node:path';
import {
  HOOK_SCRIPT_NAME,
  checkConfigTarget,
  declaredVersion,
  ensureHook,
  ensureHooksObject,
  envOrHome,
  hookCommand,
  hooksObjectIfPresent,
  jsonHooksIo,
  readText,
  removeHook,
  scriptInstalled,
  writeConfigFile,
} from './kit';
import codexSh from '../assets/codex/herdr-desktop-agent-state.sh?raw';
import codexPs1 from '../assets/codex/herdr-desktop-agent-state.ps1?raw';
import { isWindows } from '../../platform';

/** codex 需要的额外 IO：TOML 的整文件读改写。 */
export interface CodexInstallerIo {
  /** 预检 config.toml 可写。 */
  checkTomlTarget(dir: string): void;
  /** 读文本配置（不存在返回空串）。 */
  readText(path: string): Promise<string>;
  /** 原子写配置文件。 */
  writeConfigFile(path: string, content: string): Promise<void>;
  /** 在已有 TOML 内容上打开 hooks 开关，返回新内容。 */
  configWithHook(content: string): string;
}

export class CodexInstaller extends JsonHooksInstaller {
  constructor(
    layout: JsonHooksLayout,
    deps: JsonHooksInstallerDeps,
    join: JoinPath,
    private readonly codex: CodexInstallerIo,
  ) {
    super(layout, deps, join);
  }

  /** 在通用 hooks.json 写完后，额外把 config.toml 的 hooks 开关打开。 */
  protected override async registerExtra(
    dir: string,
    _artifactPath: string,
    _configPath: string,
  ): Promise<void> {
    const configPath = this.join(dir, 'config.toml');
    // 预检放在写之前：TOML 不可写就不要留下「hooks.json 已改、config.toml 没改」的半安装。
    this.codex.checkTomlTarget(dir);
    const content = await this.codex.readText(configPath);
    await this.codex.writeConfigFile(configPath, this.codex.configWithHook(content));
  }
}

/**
 * 创建 codex 的集成安装器。
 *
 * 放在智能体自己的文件里：它的配置协议（hooks.json + config.toml）与
 * 事件集只属于 codex，不该躺在安装流程的汇总文件里。
 */
export function createCodexTarget(): IntegrationInstaller {
  return new CodexInstaller(
    {
      configFile: 'hooks.json',
      shape: 'nested',
      event: 'SessionStart',
      events: [['SessionStart', 'session'], ...CODEX_STATE_EVENTS],
      removedEvents: CODEX_REMOVED_STATE_EVENTS,
      artifactSubdir: null,
    },
    codexDeps(),
    join,
    {
      // config.toml 也要预检（用户可能把它设成只读或多硬链接）
      checkTomlTarget: (dir) => checkConfigTarget(join(dir, 'config.toml')),
      readText: (path) => readText(path),
      writeConfigFile: (path, content) => writeConfigFile(path, content),
      configWithHook: (content) => codexConfigWithHook(content),
    },
  );
}

/** codex 安装器的依赖注入。 */
function codexDeps(): JsonHooksInstallerDeps {
  const configDir = (): string | null => envOrHome('CODEX_HOME', ['.codex']);
  return {
    configDir,
    artifactPath: () => {
      const dir = configDir();
      return dir ? join(dir, HOOK_SCRIPT_NAME) : null;
    },
    version: () => declaredVersion('codex'),
    command: (path, action) => hookCommand(path, action),
    artifactIsInstalled: (path) => scriptInstalled(path),
      artifactContent: () => (isWindows ? codexPs1 : codexSh),
    io: jsonHooksIo(),
    ops: { ensureHooksObject, hooksObjectIfPresent, ensureHook, removeHook },
  };
}

/** 解析 TOML 表头（如 [features]、[[hooks]]）；非表头行返回 null（对应 herdr toml_table_header）。 */
function tomlTableHeader(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[')) return null;
  const isArrayTable = trimmed.startsWith('[[');
  const close = trimmed.indexOf(isArrayTable ? ']]' : ']');
  if (close < 0) return null;
  const headerEnd = close + (isArrayTable ? 2 : 1);
  const header = trimmed.slice(0, headerEnd);
  const rest = trimmed.slice(headerEnd).trimStart();
  if (rest && !rest.startsWith('#')) return null;
  return header;
}

/** 判断 TOML 行是否是 `key = ...`（对应 herdr is_toml_key）。 */
function isTomlKey(line: string, key: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('#') || !trimmed.startsWith(key)) return false;
  return trimmed.slice(key.length).trimStart().startsWith('=');
}

export function codexConfigWithHook(content: string): string {
  // 对应 herdr build_codex_config_with_hooks：删除废弃的 codex_hooks，并在 [features] 段内设置 hooks = true。
  const trailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let inFeatures = false;
  let featuresHeaderIndex = -1;
  let hooksIndex = -1;
  const deprecated: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = tomlTableHeader(lines[i]);
    if (header !== null) {
      inFeatures = header === '[features]';
      if (inFeatures && featuresHeaderIndex < 0) featuresHeaderIndex = i;
      continue;
    }
    if (!inFeatures) continue;
    if (isTomlKey(lines[i], 'codex_hooks')) deprecated.push(i);
    else if (isTomlKey(lines[i], 'hooks')) hooksIndex = i;
  }

  if (hooksIndex >= 0) lines[hooksIndex] = 'hooks = true';
  for (let i = deprecated.length - 1; i >= 0; i -= 1) lines.splice(deprecated[i], 1);

  if (hooksIndex < 0) {
    if (featuresHeaderIndex >= 0) {
      lines.splice(featuresHeaderIndex + 1, 0, 'hooks = true');
    } else {
      let result = content.replace(/\r?\n$/, '');
      if (result) result += '\n\n';
      result += '[features]\nhooks = true';
      return `${result}\n`;
    }
  }

  const result = lines.join('\n');
  return trailingNewline || result === '' ? `${result}\n` : result;
}

// ---------------------------------------------------------------------------
// kimi —— ~/.kimi-code/config.toml 的 [[hooks]] 块
// ---------------------------------------------------------------------------

/**
 * kimi —— TOML `[[hooks]]` 块 + 安装前版本闸门。
 * 骨架复用 `KimiInstaller`（无 JSON hooks、有异步前置校验）。
 */

/** codex 状态事件（对应 herdr install_codex：UserPromptSubmit/Stop/Interrupt）。 */
const CODEX_STATE_EVENTS: Array<[string, string]> = [
  ['UserPromptSubmit', 'working'],
  ['Stop', 'idle'],
  ['Interrupt', 'idle'],
];

/** codex 旧版曾安装、现已移除的事件（对应 herdr install_codex 的移除列表）。 */
const CODEX_REMOVED_STATE_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'idle'],
  ['PreToolUse', 'working'],
  ['PermissionRequest', 'blocked'],
];
