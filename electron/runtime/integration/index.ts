/**
 * 官方集成安装器 —— 参考 herdr `src/integration/`。
 *
 * 覆盖两类集成：
 * - hook（脚本 + agent 配置注册）：claude、codex、kimi、copilot、devin、droid、
 *   qodercli、qwen、letta、cursor、mastracode、antigravity-cli、grok；
 * - 非 hook（extension/plugin）：pi、omp（扩展）、opencode、kilo（JS 插件）、
 *   hermes（Python 插件）。
 *
 * 每个智能体的脚本单独存放在 `assets/<agent>/` 文件夹里（见 `assets.ts`），
 * 对应 herdr `src/integration/assets/`。上报通道统一走本地 HTTP 上报端点
 * （`HERDR_DESKTOP_REPORT_URL`）。hook/资产都带 `HERDR_INTEGRATION_ID=herdr-desktop`
 * 标记，用于区分 herdr 官方集成与 herdr-desktop 集成。会话 id 与状态
 * （working/blocked/idle/done）都可上报，状态上报后该 pane 进入 hook 权威模式
 * （终端检测不再覆盖 status）。
 */

import { promises as fs, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { isWindows } from '../../platform';
import type { HookStatus } from '../../../shared/protocol';
import {
  PI_ASSET,
  OMP_ASSET,
  OPENCODE_ASSET,
  OPENCODE_TUI_SESSION_ASSET,
  OPENCODE_TUI_ASSET,
  KILO_ASSET,
  HERMES_PLUGIN_YAML,
  HERMES_PLUGIN_INIT,
  DSH_STATUS_PLUGIN,
  DSH_STATUS_PLUGIN_NAME,
  hookScriptContent,
  INTEGRATION_VERSIONS,
  type HookScriptAgent,
} from './assets';

const INTEGRATION_ID = 'herdr-desktop';
const HOOK_SCRIPT_NAME = isWindows ? 'herdr-desktop-agent-state.ps1' : 'herdr-desktop-agent-state.sh';
/** qwen / letta 用会话专用脚本名（对应 herdr 的 `*_HOOK_INSTALL_NAME`）。 */
const SESSION_SCRIPT_NAME = isWindows ? 'herdr-desktop-agent-session.ps1' : 'herdr-desktop-agent-session.sh';

/** 全生命周期状态事件（对应 herdr 的多事件 state 上报）。 */
const LIFECYCLE_STATE_EVENTS: Array<[event: string, action: string]> = [
  ['UserPromptSubmit', 'working'],
  ['PreToolUse', 'working'],
  ['PermissionRequest', 'blocked'],
  ['Stop', 'idle'],
];

/** devin 的额外事件（对应 herdr DEVIN_HOOK_EVENTS）：每个事件都带会话引用。 */
const DEVIN_STATE_EVENTS: Array<[string, string]> = [
  ['UserPromptSubmit', 'session'],
  ['PreToolUse', 'session'],
  ['PostToolUse', 'session'],
  ['PermissionRequest', 'session'],
  ['Stop', 'session'],
];

/** mastracode 的额外事件（对应 herdr MASTRACODE_HOOK_EVENTS，除去 SessionStart）。 */
const MASTRACODE_STATE_EVENTS: Array<[string, string]> = [
  ['UserPromptSubmit', 'working'],
  ['AgentStart', 'working'],
  ['PreToolUse', 'working'],
  ['PermissionRequest', 'blocked'],
  ['PermissionResult', 'working'],
  ['SubagentStart', 'working'],
  ['SubagentEnd', 'working'],
  ['Interrupt', 'idle'],
  ['AgentEnd', 'idle'],
  ['Stop', 'idle'],
];

/** kimi 的事件集（对应 herdr KIMI_HOOK_EVENTS）：matcher 区分 AskUserQuestion。 */
const KIMI_ASK_USER_QUESTION_MATCHER = '^AskUserQuestion$';
const KIMI_OTHER_TOOL_MATCHER = '^(?!AskUserQuestion$).*$';
const KIMI_HOOK_EVENTS: Array<[event: string, matcher: string | null, action: string]> = [
  ['SessionStart', null, 'session'],
  ['UserPromptSubmit', null, 'working'],
  ['PreToolUse', KIMI_OTHER_TOOL_MATCHER, 'working'],
  ['PreToolUse', KIMI_ASK_USER_QUESTION_MATCHER, 'blocked'],
  ['PostToolUse', KIMI_ASK_USER_QUESTION_MATCHER, 'working'],
  ['PostToolUseFailure', KIMI_ASK_USER_QUESTION_MATCHER, 'working'],
  ['SubagentStart', null, 'working'],
  ['PreCompact', null, 'working'],
  ['PermissionRequest', null, 'blocked'],
  ['PermissionResult', null, 'working'],
  ['Stop', null, 'idle'],
  ['Interrupt', null, 'idle'],
];

const HOOK_TARGETS: Record<string, HookTarget> = {
  claude: claudeTarget(),
  codex: codexTarget(),
  kimi: kimiTarget(),
  copilot: jsonHooksTarget({
    agent: 'copilot',
    configDir: () => envOrHome('COPILOT_HOME', ['.copilot']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'direct',
    timeoutSec: 10,
  }),
  devin: jsonHooksTarget({
    agent: 'devin',
    configDir: () => devinDir(),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: null,
    configFile: 'config.json',
    event: 'SessionStart',
    shape: 'nested',
    timeoutSec: 10,
    stateEvents: DEVIN_STATE_EVENTS,
    removedEvents: LIFECYCLE_STATE_EVENTS,
  }),
  droid: jsonHooksTarget({
    agent: 'droid',
    configDir: () => homeJoin('.factory'),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    timeoutSec: 10,
  }),
  qodercli: jsonHooksTarget({
    agent: 'qodercli',
    configDir: () => envOrHome('QODER_CONFIG_DIR', ['.qoder']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    matcher: '*',
    timeoutSec: 10,
  }),
  qwen: jsonHooksTarget({
    agent: 'qwen',
    configDir: () => envOrHome('QWEN_HOME', ['.qwen']),
    scriptName: SESSION_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    matcher: '*',
    timeoutSec: 10,
  }),
  letta: jsonHooksTarget({
    agent: 'letta',
    configDir: () => homeJoin('.letta'),
    scriptName: SESSION_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    timeoutSec: 10,
    quiet: true,
  }),
  cursor: jsonHooksTarget({
    agent: 'cursor',
    configDir: () => envOrHome('CURSOR_CONFIG_DIR', ['.cursor']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: null,
    configFile: 'hooks.json',
    event: 'sessionStart',
    shape: 'simple',
    withVersion: true,
  }),
  mastracode: jsonHooksTarget({
    agent: 'mastracode',
    configDir: () => homeJoin('.mastracode'),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'hooks.json',
    event: 'SessionStart',
    shape: 'flat',
    timeoutSec: 10,
    stateEvents: MASTRACODE_STATE_EVENTS,
    removedEvents: LIFECYCLE_STATE_EVENTS,
    encodedCommand: true,
  }),
  antigravity: antigravityTarget(),
  grok: grokTarget(),
  // 非 hook 集成（extension / plugin）
  pi: piTarget(),
  omp: ompTarget(),
  opencode: opencodeTarget(),
  kilo: kiloTarget(),
  hermes: hermesTarget(),
  'dsh-web': dshWebTarget(),
};

export function hookStatuses(): Record<string, HookStatus> {
  const result: Record<string, HookStatus> = {};
  for (const [id, target] of Object.entries(HOOK_TARGETS)) {
    if (!target.isInstalled()) {
      result[id] = 'not-installed';
      continue;
    }
    const version = readInstalledVersion(target.hookPath());
    const expected = INTEGRATION_VERSIONS[id];
    result[id] = version !== null && expected !== undefined && version < expected ? 'outdated' : 'installed';
  }
  return result;
}

/** 读取已安装资产里的版本标记；读不到时返回 null。 */
function readInstalledVersion(path: string | null): number | null {
  if (!path) return null;
  try {
    const content = readFileSync(path, 'utf8');
    const match = content.match(/HERDR_INTEGRATION_VERSION=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function installHook(agentId: string, reportUrl: string): Promise<HookStatus> {
  const target = HOOK_TARGETS[agentId];
  if (!target) return 'unsupported';
  await target.install(reportUrl);
  return target.isInstalled() ? 'installed' : 'not-installed';
}

export async function uninstallHook(agentId: string): Promise<HookStatus> {
  const target = HOOK_TARGETS[agentId];
  if (!target) return 'unsupported';
  await target.uninstall();
  return target.isInstalled() ? 'installed' : 'not-installed';
}

// ---------------------------------------------------------------------------
// 类型与通用工具
// ---------------------------------------------------------------------------

interface HookTarget {
  configDir(): string | null;
  hookPath(): string | null;
  isInstalled(): boolean;
  install(reportUrl: string): Promise<void>;
  uninstall(): Promise<void>;
}

type JsonShape = 'nested' | 'flat' | 'direct' | 'simple';

interface JsonHooksTargetOptions {
  agent: HookScriptAgent;
  configDir: () => string | null;
  scriptName: string;
  scriptSubdir: string | null;
  configFile: string;
  event: string;
  shape: JsonShape;
  matcher?: string;
  timeoutSec?: number;
  quiet?: boolean;
  withVersion?: boolean;
  stateEvents?: Array<[string, string]>;
  /** 旧版事件（安装/卸载时一并移除，对应 herdr *_REMOVED_*_EVENTS）。 */
  removedEvents?: Array<[string, string]>;
  encodedCommand?: boolean;
}

function homeJoin(...segments: string[]): string {
  return join(homedir(), ...segments);
}

function envOrHome(envVar: string, fallbackSegments: string[]): string {
  const env = process.env[envVar];
  if (env && env.trim()) return expandTilde(env.trim());
  return homeJoin(...fallbackSegments);
}

function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

function devinDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return expandTilde(join(xdg.trim(), 'devin'));
  if (isWindows) {
    const appdata = process.env.APPDATA;
    if (appdata && appdata.trim()) return join(appdata.trim(), 'devin');
  }
  return homeJoin('.config', 'devin');
}

function hookCommand(path: string, action: string): string {
  return isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${path}" ${action}`
    : `bash '${path.replace(/'/g, `'\\''`)}' ${action}`;
}

function powershellEncodedCommand(path: string, action: string): string {
  const script = `& '${path.replace(/'/g, "''")}' ${action}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function grokHookCommand(path: string): string {
  return isWindows
    ? hookCommand(path, 'session')
    : `sh '${path.replace(/'/g, `'\\''`)}' session`;
}

function commandFor(opts: { encodedCommand?: boolean }, path: string, action: string): string {
  return opts.encodedCommand && isWindows
    ? powershellEncodedCommand(path, action)
    : hookCommand(path, action);
}

/** 读取 JSON（用 jsonc-parser 容忍 JSONC 注释与尾逗号）。 */
async function readJson(path: string): Promise<Record<string, any>> {
  const text = await readText(path);
  if (!text) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeConfigFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 用户配置写入前的安全预检：目标存在且非普通文件时抛错（对应 herdr check_config_target）。 */
function checkConfigTarget(path: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!st.isFile()) {
    throw new Error(`cannot update ${path}: not a regular file`);
  }
}

/** 原子写用户配置（临时文件 + rename，对应 herdr write_config）。 */
async function writeConfigFile(path: string, contents: string): Promise<void> {
  checkConfigTarget(path);
  const tmp = join(dirname(path), `.herdr-desktop-config-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tmp, contents, 'utf8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 在 JSONC 文件的某数组键里增删一项，用 modify 保留键外注释（对应 herdr jsonc 保真）。 */
async function writeJsoncArrayItem(path: string, key: string, item: unknown, add: boolean): Promise<void> {
  const text = await readText(path);
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as Record<string, any> | null;
  const arr = value && Array.isArray(value[key]) ? value[key] : [];
  const idx = arr.findIndex((p: unknown) => p === item);
  let next: unknown[];
  if (add && idx < 0) next = [...arr, item];
  else if (!add && idx >= 0) next = arr.filter((_: unknown, i: number) => i !== idx);
  else return;
  const edits = modify(text, [key], next, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const updated = applyEdits(text, edits);
  await writeConfigFile(path, updated);
}

/** 用 modify 仅改写 JSONC 文件的一个顶层键，保留其余键与其注释；value 为 undefined 时删除该键。 */
async function writeJsonKey(path: string, key: string, value: unknown): Promise<void> {
  const text = await readText(path);
  if (!text.trim()) {
    await writeConfigFile(path, `${JSON.stringify({ [key]: value }, null, 2)}\n`);
    return;
  }
  const edits = modify(text, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  await writeConfigFile(path, applyEdits(text, edits));
}

async function readText(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function scriptInstalled(path: string | null): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(`HERDR_INTEGRATION_ID=${INTEGRATION_ID}`);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 通用 JSON hooks 结构（对应 herdr config_edit.rs）
// ---------------------------------------------------------------------------

function ensureHooksObject(root: Record<string, any>): Record<string, any> {
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    root.hooks = {};
  }
  return root.hooks;
}

function hookMatches(hook: any, command: string): boolean {
  return (
    hook &&
    typeof hook === 'object' &&
    (hook.command === command || hook.bash === command || hook.powershell === command)
  );
}

function ensureNestedHook(
  hooks: Record<string, any>,
  event: string,
  command: string,
  opts: { matcher?: string; timeoutSec?: number; quiet?: boolean },
): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => Array.isArray(e.hooks) && e.hooks.some((h: any) => hookMatches(h, command)))) {
    return;
  }
  const invocation: Record<string, any> = { type: 'command', command };
  if (opts.timeoutSec !== undefined) invocation.timeout = opts.timeoutSec;
  if (opts.quiet) invocation.quiet = true;
  const entry: Record<string, any> = { hooks: [invocation] };
  if (opts.matcher !== undefined) entry.matcher = opts.matcher;
  entries.push(entry);
}

function ensureFlatHook(hooks: Record<string, any>, event: string, command: string, timeoutSec: number): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => hookMatches(e, command))) return;
  entries.push({ type: 'command', command, timeout: timeoutSec, description: 'Report agent state to Herdr' });
}

function ensureDirectHook(hooks: Record<string, any>, event: string, command: string, timeoutSec: number): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  const field = isWindows ? 'powershell' : 'bash';
  if (entries.some((e: any) => hookMatches(e, command))) return;
  entries.push({ type: 'command', [field]: command, timeoutSec });
}

function ensureSimpleHook(hooks: Record<string, any>, event: string, command: string): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => e && e.command === command)) return;
  entries.push({ command });
}

function ensureHook(
  hooks: Record<string, any>,
  shape: JsonShape,
  event: string,
  command: string,
  opts: { matcher?: string; timeoutSec?: number; quiet?: boolean },
): void {
  if (shape === 'nested') ensureNestedHook(hooks, event, command, opts);
  else if (shape === 'flat') ensureFlatHook(hooks, event, command, opts.timeoutSec ?? 10);
  else if (shape === 'direct') ensureDirectHook(hooks, event, command, opts.timeoutSec ?? 10);
  else ensureSimpleHook(hooks, event, command);
}

function removeHook(hooks: Record<string, any>, event: string, command: string): boolean {
  const entries = hooks[event];
  if (!Array.isArray(entries)) return false;
  let removed = false;
  const next: any[] = [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && Array.isArray(entry.hooks)) {
      const kept = entry.hooks.filter((h: any) => !hookMatches(h, command));
      if (kept.length !== entry.hooks.length) removed = true;
      if (kept.length > 0) next.push({ ...entry, hooks: kept });
    } else if (hookMatches(entry, command) || (entry && entry.command === command)) {
      removed = true;
    } else {
      next.push(entry);
    }
  }
  if (next.length === 0) delete hooks[event];
  else hooks[event] = next;
  return removed;
}

// ---------------------------------------------------------------------------
// 通用 settings.json / config.json / hooks.json 型 target
// ---------------------------------------------------------------------------

function jsonHooksTarget(opts: JsonHooksTargetOptions): HookTarget {
  const events: Array<[string, string]> = [[opts.event, 'session'], ...(opts.stateEvents ?? [])];
  return {
    configDir: opts.configDir,
    hookPath() {
      const dir = this.configDir();
      if (!dir) return null;
      return opts.scriptSubdir ? join(dir, opts.scriptSubdir, opts.scriptName) : join(dir, opts.scriptName);
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      const scriptDir = opts.scriptSubdir ? join(dir, opts.scriptSubdir) : dir;
      await fs.mkdir(scriptDir, { recursive: true });
      await fs.writeFile(path, hookScriptContent(opts.agent, isWindows), 'utf8');

      const configPath = join(dir, opts.configFile);
      const root = await readJson(configPath);
      if (opts.withVersion && root.version === undefined) root.version = 1;
      const hooks = ensureHooksObject(root);
      // 先移除旧版事件，再写入新事件（对应 herdr *_REMOVED_*_EVENTS）。
      for (const [event, action] of opts.removedEvents ?? []) {
        removeHook(hooks, event, commandFor(opts, path, action));
      }
      for (const [event, action] of events) {
        const command = commandFor(opts, path, action);
        ensureHook(hooks, opts.shape, event, command, {
          matcher: opts.matcher,
          timeoutSec: opts.timeoutSec,
          quiet: opts.quiet,
        });
      }
      await writeJsonKey(configPath, 'hooks', root.hooks);
      if (opts.withVersion && root.version !== undefined) {
        await writeJsonKey(configPath, 'version', root.version);
      }
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const configPath = join(dir, opts.configFile);
      const root = await readJson(configPath);
      const hooks = ensureHooksObject(root);
      for (const [event, action] of events) {
        removeHook(hooks, event, commandFor(opts, path ?? '', action));
      }
      for (const [event, action] of opts.removedEvents ?? []) {
        removeHook(hooks, event, commandFor(opts, path ?? '', action));
      }
      await writeJsonKey(configPath, 'hooks', root.hooks);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// claude —— ~/.claude/settings.json（SessionStart + 状态事件，matcher）
// ---------------------------------------------------------------------------

function claudeTarget(): HookTarget {
  return {
    configDir: () => envOrHome('CLAUDE_CONFIG_DIR', ['.claude']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('claude', isWindows), 'utf8');

      const settingsPath = join(dir, 'settings.json');
      const settings = await readJson(settingsPath);
      const hooks = ensureHooksObject(settings);
      for (const matcher of ['startup', 'resume']) {
        ensureNestedHook(hooks, 'SessionStart', hookCommand(path, 'session'), { matcher, timeoutSec: 10 });
      }
      for (const [event, action] of LIFECYCLE_STATE_EVENTS) {
        ensureNestedHook(hooks, event, hookCommand(path, action), { matcher: '*', timeoutSec: 10 });
      }
      await writeJsonKey(settingsPath, 'hooks', settings.hooks);
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const settingsPath = join(dir, 'settings.json');
      const settings = await readJson(settingsPath);
      const hooks = ensureHooksObject(settings);
      removeHook(hooks, 'SessionStart', hookCommand(path ?? '', 'session'));
      for (const [event, action] of LIFECYCLE_STATE_EVENTS) {
        removeHook(hooks, event, hookCommand(path ?? '', action));
      }
      await writeJsonKey(settingsPath, 'hooks', settings.hooks);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// codex —— ~/.codex/hooks.json + config.toml
// ---------------------------------------------------------------------------

function codexTarget(): HookTarget {
  return {
    configDir: () => envOrHome('CODEX_HOME', ['.codex']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, hookScriptContent('codex', isWindows), 'utf8');

      const hooksPath = join(dir, 'hooks.json');
      const hooksRoot = await readJson(hooksPath);
      const hooks = ensureHooksObject(hooksRoot);
      ensureNestedHook(hooks, 'SessionStart', hookCommand(path, 'session'), { timeoutSec: 10 });
      for (const [event, action] of LIFECYCLE_STATE_EVENTS) {
        ensureNestedHook(hooks, event, hookCommand(path, action), { timeoutSec: 10 });
      }
      await writeJsonKey(hooksPath, 'hooks', hooksRoot.hooks);

      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await writeConfigFile(configPath, codexConfigWithHook(content));
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const hooksPath = join(dir, 'hooks.json');
      const hooksRoot = await readJson(hooksPath);
      const hooks = ensureHooksObject(hooksRoot);
      removeHook(hooks, 'SessionStart', hookCommand(path ?? '', 'session'));
      for (const [event, action] of LIFECYCLE_STATE_EVENTS) {
        removeHook(hooks, event, hookCommand(path ?? '', action));
      }
      await writeJsonKey(hooksPath, 'hooks', hooksRoot.hooks);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

function codexConfigWithHook(content: string): string {
  let result = content.replace(/\r?\n$/, '');
  if (!/^\s*\[features\]/m.test(result)) result += '\n\n[features]';
  if (!/^\s*hooks\s*=\s*true/m.test(result)) {
    const lines = result.split('\n');
    const idx = lines.findIndex((line) => /^\s*\[features\]/.test(line));
    if (idx >= 0) lines.splice(idx + 1, 0, 'hooks = true');
    else lines.push('hooks = true');
    result = lines.join('\n');
  }
  return `${result}\n`;
}

// ---------------------------------------------------------------------------
// kimi —— ~/.kimi-code/config.toml 的 [[hooks]] 块
// ---------------------------------------------------------------------------

function kimiTarget(): HookTarget {
  const events = KIMI_HOOK_EVENTS;
  return {
    configDir: () => envOrHome('KIMI_CODE_HOME', ['.kimi-code']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      await checkKimiVersion();
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('kimi', isWindows), 'utf8');

      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await writeConfigFile(configPath, kimiConfigWithHook(content, path, events));
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await fs.writeFile(configPath, removeKimiBlock(content), 'utf8');
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

const KIMI_BLOCK_BEGIN = '# >>> herdr kimi integration';
const KIMI_BLOCK_END = '# <<< herdr kimi integration';

const execFileAsync = promisify(execFile);
const KIMI_MIN_VERSION = '0.14.0';

function extractVersionTriple(text: string): [number, number, number] | null {
  for (const token of text.split(/\s+/)) {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(token);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  }
  return null;
}

function compareTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * kimi 最低版本检查（对应 herdr enforce_agent_version）。
 * 无法探测或无法解析时放行（warning 分支）；太旧则抛错阻断安装。
 */
async function checkKimiVersion(): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync('kimi', ['--version'], { timeout: 5000 });
    stdout = result.stdout;
  } catch {
    return;
  }
  const found = extractVersionTriple(stdout);
  const required = extractVersionTriple(KIMI_MIN_VERSION);
  if (found && required && compareTriples(found, required) < 0) {
    throw new Error(
      `kimi ${found.join('.')} is too old: hooks require kimi ${KIMI_MIN_VERSION} or newer`,
    );
  }
}

function kimiConfigWithHook(
  content: string,
  hookPath: string,
  events: Array<[event: string, matcher: string | null, action: string]>,
): string {
  if (content.includes(KIMI_BLOCK_BEGIN)) return content;
  const rows = [KIMI_BLOCK_BEGIN];
  for (const [event, matcher, action] of events) {
    rows.push('[[hooks]]', `event = "${event}"`);
    if (matcher) rows.push(`matcher = ${tomlString(matcher)}`);
    rows.push(`command = ${tomlString(hookCommand(hookPath, action))}`, 'timeout = 10');
  }
  rows.push(KIMI_BLOCK_END);
  const trimmed = content.replace(/\r?\n$/, '');
  return `${trimmed}\n\n${rows.join('\n')}\n`;
}

function removeKimiBlock(content: string): string {
  const begin = content.indexOf(KIMI_BLOCK_BEGIN);
  const end = content.indexOf(KIMI_BLOCK_END);
  if (begin < 0) return content;
  const after = end >= 0 ? end + KIMI_BLOCK_END.length : content.length;
  return (content.slice(0, begin) + content.slice(after)).replace(/\n{3,}/g, '\n\n');
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

// ---------------------------------------------------------------------------
// antigravity-cli（agy）—— ~/.gemini/config/hooks.json 的 "herdr" 块
// ---------------------------------------------------------------------------

function antigravityTarget(): HookTarget {
  return {
    configDir: () => envOrHome('ANTIGRAVITY_CLI_CONFIG_DIR', ['.gemini', 'config']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('antigravity', isWindows), 'utf8');

      const hooksPath = join(dir, 'hooks.json');
      const root = await readJson(hooksPath);
      const command = commandFor({ encodedCommand: true }, path, 'session');
      root['herdr-desktop'] = { PreInvocation: [{ type: 'command', command, timeout: 10 }] };
      await writeJson(hooksPath, root);
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const hooksPath = join(dir, 'hooks.json');
      const root = await readJson(hooksPath);
      delete root['herdr-desktop'];
      await writeJson(hooksPath, root);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// grok —— ~/.grok/hooks/ 脚本 + herdr-desktop.json
// ---------------------------------------------------------------------------

function grokTarget(): HookTarget {
  return {
    configDir: () => envOrHome('GROK_HOME', ['.grok']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      const dir = this.configDir();
      return (
        scriptInstalled(this.hookPath()) &&
        (dir ? existsSync(join(dir, 'hooks', 'herdr-desktop.json')) : false)
      );
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('grok', isWindows), 'utf8');

      const config = {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: grokHookCommand(path), timeout: 10 }] }],
        },
      };
      await writeJson(join(dir, 'hooks', 'herdr-desktop.json'), config);
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      await fs.rm(join(dir, 'hooks', 'herdr-desktop.json'), { force: true }).catch(() => undefined);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// 非 hook 集成（extension / plugin）
// ---------------------------------------------------------------------------

function extensionTarget(opts: {
  configDir: () => string | null;
  asset: string;
  fileName: string;
}): HookTarget {
  return {
    configDir: opts.configDir,
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, opts.fileName) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, opts.asset, 'utf8');
    },
    async uninstall() {
      await fs.rm(this.hookPath() ?? '', { force: true }).catch(() => undefined);
    },
  };
}

function piTarget(): HookTarget {
  return extensionTarget({
    configDir: () => piExtensionDir(),
    asset: PI_ASSET,
    fileName: 'herdr-desktop-agent-state.ts',
  });
}

function ompTarget(): HookTarget {
  return extensionTarget({
    configDir: () => ompExtensionDir(),
    asset: OMP_ASSET,
    fileName: 'herdr-desktop-omp-agent-state.ts',
  });
}

function piExtensionDir(): string | null {
  return join(envOrHome('PI_CODING_AGENT_DIR', ['.pi', 'agent']), 'extensions');
}

function ompExtensionDir(): string | null {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  const base = env ? expandTilde(env) : expandTilde(process.env.PI_CONFIG_DIR?.trim() || homeJoin('.omp'));
  return join(base, 'agent', 'extensions');
}

function opencodeTarget(): HookTarget {
  const dir = () => homeJoin('.config', 'opencode');
  const pluginPath = () => join(dir(), 'plugins', 'herdr-desktop-agent-state.js');
  const tuiPluginPath = () => join(dir(), 'herdr-tui-session.js');
  const v2Dir = () => join(dir(), 'herdr-opencode');
  const SPEC = './plugins/herdr-desktop-agent-state.js';
  const TUI_SPEC = './herdr-tui-session.js';
  const V2_SPEC = './herdr-opencode';
  const stateDir = () => {
    const xdg = process.env.XDG_STATE_HOME?.trim();
    return xdg ? join(xdg, 'opencode') : homeJoin('.local', 'state', 'opencode');
  };
  // 当 tui.json 或 state/kv.json 存在时，OpenCode 会在首次 V2 启动时把 V1 配置迁移
  // 到 cli.json（仅在 cli.json 缺失时）；此时暂不写 cli.json（对应 herdr cli_migration_pending）。
  const migrationPending = () =>
    existsSync(join(dir(), 'tui.json')) || existsSync(join(stateDir(), 'kv.json'));
  return {
    configDir: dir,
    hookPath: pluginPath,
    isInstalled() {
      return (
        scriptInstalled(pluginPath()) &&
        existsSync(tuiPluginPath()) &&
        existsSync(join(v2Dir(), 'tui.js'))
      );
    },
    async install(_reportUrl: string) {
      const d = dir();
      await fs.mkdir(join(d, 'plugins'), { recursive: true });
      await fs.writeFile(pluginPath(), OPENCODE_ASSET, 'utf8');
      // TUI session 插件（对应 herdr herdr-tui-session.js + herdr-opencode/tui.js）。
      await fs.writeFile(tuiPluginPath(), OPENCODE_TUI_SESSION_ASSET, 'utf8');
      await fs.mkdir(v2Dir(), { recursive: true });
      await fs.writeFile(join(v2Dir(), 'tui.js'), OPENCODE_TUI_ASSET, 'utf8');

      // 注册主插件 + V2 TUI 到 cli.json（对应 herdr add_cli_plugin）。
      // 迁移未完成时先跳过，避免用 cli.json 抢占 OpenCode 的 V1→V2 迁移。
      if (!migrationPending()) {
        const cliPath = join(d, 'cli.json');
        const root = await readJson(cliPath);
        const plugins = Array.isArray(root.plugins) ? root.plugins : (root.plugins = []);
        for (const spec of [SPEC, V2_SPEC]) {
          if (!plugins.some((p: unknown) => p === spec || (p && typeof p === 'object' && (p as any).package === spec))) {
            plugins.push(spec);
          }
        }
        await writeJsonKey(cliPath, 'plugins', root.plugins);
      }

      // 注册 TUI 插件到 tui.jsonc（对应 herdr add_tui_plugin，保留注释）。
      await writeJsoncArrayItem(join(d, 'tui.jsonc'), 'plugin', TUI_SPEC, true);
    },
    async uninstall() {
      const d = dir();
      const cliPath = join(d, 'cli.json');
      const root = await readJson(cliPath);
      if (Array.isArray(root.plugins)) {
        root.plugins = root.plugins.filter(
          (p: unknown) => !(p === SPEC || p === V2_SPEC || (p && typeof p === 'object' && ((p as any).package === SPEC || (p as any).package === V2_SPEC))),
        );
        if (root.plugins.length === 0) delete root.plugins;
        await writeJsonKey(cliPath, 'plugins', root.plugins);
      }
      await writeJsoncArrayItem(join(d, 'tui.jsonc'), 'plugin', TUI_SPEC, false);
      await fs.rm(pluginPath(), { force: true }).catch(() => undefined);
      await fs.rm(tuiPluginPath(), { force: true }).catch(() => undefined);
      await fs.rm(v2Dir(), { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function kiloTarget(): HookTarget {
  return extensionTarget({
    configDir: () => homeJoin('.config', 'kilo'),
    asset: KILO_ASSET,
    fileName: join('plugin', 'herdr-desktop-agent-state.js'),
  });
}

const HERMES_PLUGIN_NAME = 'herdr-agent-state';

/**
 * 在 hermes config.yaml 里启用/禁用插件（对应 herdr ensure_hermes_plugin_enabled）。
 * 简化处理三种形态：内联列表 `plugins: [...]`、`enabled:` 子列表、扁平列表。
 */
function updateHermesEnabled(content: string, enabled: boolean): string {
  const lines = content.split('\n');
  const pluginsIdx = lines.findIndex((l) => /^plugins\s*:/.test(l));

  if (pluginsIdx < 0) {
    if (!enabled) return content;
    const base = content.replace(/\n+$/, '');
    return `${base}${base ? '\n' : ''}plugins:\n  enabled:\n    - ${HERMES_PLUGIN_NAME}\n`;
  }

  // 内联列表：plugins: [a, b]
  const inline = lines[pluginsIdx].match(/^plugins\s*:\s*\[([^\]]*)\]/);
  if (inline) {
    const items = inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const idx = items.indexOf(HERMES_PLUGIN_NAME);
    if (enabled && idx < 0) items.push(HERMES_PLUGIN_NAME);
    if (!enabled && idx >= 0) items.splice(idx, 1);
    lines[pluginsIdx] = items.length
      ? `plugins: [${items.map((s) => `'${s}'`).join(', ')}]`
      : 'plugins: []';
    return lines.join('\n');
  }

  // 块形态：找 enabled 子键或扁平列表项
  const nextTop = lines.findIndex((l, i) => i > pluginsIdx && /^[A-Za-z_][\w-]*\s*:/.test(l));
  const end = nextTop < 0 ? lines.length : nextTop;
  const sub = lines.slice(pluginsIdx + 1, end);
  const enabledIdx = sub.findIndex((l) => /^\s{2}enabled\s*:/.test(l));

  if (enabledIdx >= 0) {
    const listStart = pluginsIdx + 1 + enabledIdx + 1;
    let listEnd = listStart;
    while (listEnd < end && /^\s{2,}-\s/.test(lines[listEnd])) listEnd += 1;
    const itemIdx =
      lines.slice(listStart, listEnd).findIndex((l) => l.trim() === `- ${HERMES_PLUGIN_NAME}`) + listStart;
    if (enabled && itemIdx < listStart) lines.splice(listStart, 0, `    - ${HERMES_PLUGIN_NAME}`);
    else if (!enabled && itemIdx >= listStart) lines.splice(itemIdx, 1);
    return lines.join('\n');
  }

  // 扁平列表形态：plugins:\n  - x
  const flatIdx = sub.findIndex((l) => /^\s{2}-\s/.test(l));
  if (flatIdx >= 0) {
    const listStart = pluginsIdx + 1 + flatIdx;
    const itemIdx =
      lines.slice(listStart, end).findIndex((l) => l.trim() === `- ${HERMES_PLUGIN_NAME}`) + listStart;
    if (enabled && itemIdx < listStart) lines.splice(listStart, 0, `  - ${HERMES_PLUGIN_NAME}`);
    else if (!enabled && itemIdx >= listStart) lines.splice(itemIdx, 1);
    return lines.join('\n');
  }

  // 有 plugins 键但没有 enabled/列表：追加 enabled 子键
  if (enabled) {
    lines.splice(pluginsIdx + 1, 0, '  enabled:', `    - ${HERMES_PLUGIN_NAME}`);
    return lines.join('\n');
  }

  return content;
}

function hermesTarget(): HookTarget {
  const dir = () => homeJoin('.hermes');
  const pluginDir = () => join(dir(), 'plugins', 'herdr-desktop-agent-state');
  const configPath = () => join(dir(), 'config.yaml');
  return {
    configDir: dir,
    hookPath: () => join(pluginDir(), '__init__.py'),
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      await fs.mkdir(pluginDir(), { recursive: true });
      await fs.writeFile(join(pluginDir(), 'plugin.yaml'), HERMES_PLUGIN_YAML, 'utf8');
      await fs.writeFile(join(pluginDir(), '__init__.py'), HERMES_PLUGIN_INIT, 'utf8');

      // 在 config.yaml 启用插件（对应 herdr ensure_hermes_plugin_enabled）。
      const content = await readText(configPath());
      const updated = updateHermesEnabled(content, true);
      if (updated !== content) await writeConfigFile(configPath(), updated);
    },
    async uninstall() {
      const content = await readText(configPath());
      const updated = updateHermesEnabled(content, false);
      if (updated !== content) await writeConfigFile(configPath(), updated);
      await fs.rm(pluginDir(), { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// DeepSeek Harness（dsh web）—— 非 hook 集成（Cordis 插件）
// ---------------------------------------------------------------------------

/**
 * 安装位置用 Harness 全局 home（`$DSH_HOME`，默认 `~/.dsh`），而非某个 profile：
 * - 插件是自包含、无依赖的单文件，且未设置 `HERDR_DESKTOP_REPORT_URL` 时是 no-op，
 *   挂到 home 层不会影响任何非 Herdr 启动的 dsh 进程；
 * - home 层 `cordis.patch.yml` 不属于 profile 自动初始化写入的文件，避免 Herdr 先
 *   安装、随后 `dsh web` 首次启动自动初始化 profile 时把条目冲掉。
 */
function dshWebTarget(): HookTarget {
  const homeDir = () => {
    const home = process.env.DSH_HOME?.trim();
    return home ? home : join(homedir(), '.dsh');
  };
  const pluginPath = () => join(homeDir(), 'plugins', DSH_STATUS_PLUGIN_NAME);
  const patchPath = () => join(homeDir(), 'cordis.patch.yml');

  return {
    configDir: homeDir,
    hookPath: pluginPath,
    isInstalled() {
      const path = pluginPath();
      if (!path || !existsSync(path)) return false;
      try {
        return readFileSync(path, 'utf8').includes(`HERDR_INTEGRATION_ID=${INTEGRATION_ID}`);
      } catch {
        return false;
      }
    },
    async install(_reportUrl: string) {
      await fs.mkdir(join(homeDir(), 'plugins'), { recursive: true });
      await fs.writeFile(pluginPath(), DSH_STATUS_PLUGIN, 'utf8');
      await upsertDshPatch(patchPath());
    },
    async uninstall() {
      await removeDshPatchBlock(patchPath());
      await fs.rm(pluginPath(), { force: true }).catch(() => undefined);
    },
  };
}

const DSH_PATCH_BEGIN = '# >>> herdr dsh integration';
const DSH_PATCH_END = '# <<< herdr dsh integration';

/** 生成需要追加进 home 层 cordis.patch.yml 的插件注册块。 */
function dshPatchBlock(): string {
  return [
    '',
    DSH_PATCH_BEGIN,
    '- insert:',
    '    - id: herdr-desktop-agent-state',
    `      name: ./plugins/${DSH_STATUS_PLUGIN_NAME}`,
    DSH_PATCH_END,
    '',
  ].join('\n');
}

/** 幂等地把插件注册块追加进 home 层 cordis.patch.yml（已存在则不动）。 */
async function upsertDshPatch(patchPath: string): Promise<void> {
  const content = await readText(patchPath);
  if (content.includes(DSH_PATCH_BEGIN)) return;
  const trimmed = content.replace(/\r?\n$/, '');
  const next =
    trimmed.length === 0
      ? dshPatchBlock().trim() + '\n'
      : `${trimmed}\n${dshPatchBlock()}`;
  await writeConfigFile(patchPath, next);
}

/** 移除 home 层 cordis.patch.yml 中的插件注册块（不存在则不动）。 */
async function removeDshPatchBlock(patchPath: string): Promise<void> {
  const content = await readText(patchPath);
  const begin = content.indexOf(DSH_PATCH_BEGIN);
  if (begin < 0) return;
  const end = content.indexOf(DSH_PATCH_END);
  const after = end >= 0 ? end + DSH_PATCH_END.length : content.length;
  const cleaned = (content.slice(0, begin) + content.slice(after))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  if (cleaned.length === 0) {
    await fs.rm(patchPath, { force: true }).catch(() => undefined);
    return;
  }
  await writeConfigFile(patchPath, `${cleaned}\n`);
}
