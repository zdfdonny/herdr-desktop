/**
 * 官方集成安装器 —— 参考 herdr `src/integration/`。
 *
 * 覆盖两类集成：
 * - hook（脚本 + agent 配置注册）：claude、codex、kimi、copilot、devin、droid、
 *   qodercli、qwen、letta、cursor、mastracode、antigravity-cli、grok；
 * - 非 hook（extension/plugin）：pi、omp（扩展）、opencode、kilo（JS 插件）、
 *   hermes（Python 插件）。
 *
 * 上报通道统一走本地 HTTP 上报端点（`HERDR_DESKTOP_REPORT_URL`）。hook/资产都带
 * `HERDR_INTEGRATION_ID=herdr-desktop` 标记，用于区分 herdr 官方集成与
 * herdr-desktop 集成。会话 id 与状态（working/blocked/idle/done）都可上报，
 * 状态上报后该 pane 进入 hook 权威模式（终端检测不再覆盖 status）。
 */

import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isWindows } from '../platform';
import type { HookStatus } from '../../shared/protocol';
import {
  PI_ASSET,
  OMP_ASSET,
  OPENCODE_ASSET,
  KILO_ASSET,
  HERMES_PLUGIN_YAML,
  HERMES_PLUGIN_INIT,
  DSH_STATUS_PLUGIN,
  DSH_STATUS_PLUGIN_NAME,
} from './integration-assets';

const INTEGRATION_ID = 'herdr-desktop';
/**
 * 当前集成资产版本。所有 hook/插件资产模板里的 `HERDR_INTEGRATION_VERSION`
 * 统一用它；升级资产时同步 bump 这里，设置页据此把「已安装但版本旧」的
 * agent 标记为「更新」。
 */
const INTEGRATION_VERSION = 1;
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

const HOOK_TARGETS: Record<string, HookTarget> = {
  claude: claudeTarget(),
  codex: codexTarget(),
  kimi: kimiTarget(),
  copilot: jsonHooksTarget({
    configDir: () => envOrHome('COPILOT_HOME', ['.copilot']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'direct',
    timeoutSec: 10,
  }),
  devin: jsonHooksTarget({
    configDir: () => devinDir(),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: null,
    configFile: 'config.json',
    event: 'SessionStart',
    shape: 'nested',
    timeoutSec: 10,
    stateEvents: LIFECYCLE_STATE_EVENTS,
  }),
  droid: jsonHooksTarget({
    configDir: () => homeJoin('.factory'),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    timeoutSec: 10,
  }),
  qodercli: jsonHooksTarget({
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
    configDir: () => envOrHome('CURSOR_CONFIG_DIR', ['.cursor']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: null,
    configFile: 'hooks.json',
    event: 'sessionStart',
    shape: 'simple',
    withVersion: true,
  }),
  mastracode: jsonHooksTarget({
    configDir: () => homeJoin('.mastracode'),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'hooks.json',
    event: 'SessionStart',
    shape: 'flat',
    timeoutSec: 10,
    stateEvents: LIFECYCLE_STATE_EVENTS,
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
    result[id] = version !== null && version < INTEGRATION_VERSION ? 'outdated' : 'installed';
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

async function readJson(path: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

      const configPath = join(dir, opts.configFile);
      const root = await readJson(configPath);
      if (opts.withVersion && root.version === undefined) root.version = 1;
      const hooks = ensureHooksObject(root);
      for (const [event, action] of events) {
        const command = commandFor(opts, path, action);
        ensureHook(hooks, opts.shape, event, command, {
          matcher: opts.matcher,
          timeoutSec: opts.timeoutSec,
          quiet: opts.quiet,
        });
      }
      await writeJson(configPath, root);
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
      await writeJson(configPath, root);
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
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

      const settingsPath = join(dir, 'settings.json');
      const settings = await readJson(settingsPath);
      const hooks = ensureHooksObject(settings);
      for (const matcher of ['startup', 'resume']) {
        ensureNestedHook(hooks, 'SessionStart', hookCommand(path, 'session'), { matcher, timeoutSec: 10 });
      }
      for (const [event, action] of LIFECYCLE_STATE_EVENTS) {
        ensureNestedHook(hooks, event, hookCommand(path, action), { matcher: '*', timeoutSec: 10 });
      }
      await writeJson(settingsPath, settings);
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
      await writeJson(settingsPath, settings);
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
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

      const hooksPath = join(dir, 'hooks.json');
      const hooksRoot = await readJson(hooksPath);
      const hooks = ensureHooksObject(hooksRoot);
      ensureNestedHook(hooks, 'SessionStart', hookCommand(path, 'session'), { timeoutSec: 10 });
      for (const [event, action] of LIFECYCLE_STATE_EVENTS) {
        ensureNestedHook(hooks, event, hookCommand(path, action), { timeoutSec: 10 });
      }
      await writeJson(hooksPath, hooksRoot);

      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await fs.writeFile(configPath, codexConfigWithHook(content), 'utf8');
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
      await writeJson(hooksPath, hooksRoot);
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
  const events: Array<[string, string]> = [['SessionStart', 'session'], ...LIFECYCLE_STATE_EVENTS];
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
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await fs.writeFile(configPath, kimiConfigWithHook(content, path, events), 'utf8');
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

function kimiConfigWithHook(content: string, hookPath: string, events: Array<[string, string]>): string {
  if (content.includes(KIMI_BLOCK_BEGIN)) return content;
  const rows = [KIMI_BLOCK_BEGIN];
  for (const [event, action] of events) {
    rows.push('[[hooks]]', `event = "${event}"`, `command = ${tomlString(hookCommand(hookPath, action))}`, 'timeout = 10');
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
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

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
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

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
  const SPEC = './plugins/herdr-desktop-agent-state.js';
  return {
    configDir: dir,
    hookPath: pluginPath,
    isInstalled() {
      return scriptInstalled(pluginPath());
    },
    async install(_reportUrl: string) {
      const d = dir();
      await fs.mkdir(join(d, 'plugins'), { recursive: true });
      await fs.writeFile(pluginPath(), OPENCODE_ASSET, 'utf8');

      // 注册到 cli.json（对应 herdr add_cli_plugin）：opencode 只加载 plugins 数组里声明的插件。
      const cliPath = join(d, 'cli.json');
      const root = await readJson(cliPath);
      const plugins = Array.isArray(root.plugins) ? root.plugins : (root.plugins = []);
      if (!plugins.some((p: unknown) => p === SPEC || (p && typeof p === 'object' && (p as any).package === SPEC))) {
        plugins.push(SPEC);
      }
      await writeJson(cliPath, root);
    },
    async uninstall() {
      const d = dir();
      const cliPath = join(d, 'cli.json');
      const root = await readJson(cliPath);
      if (Array.isArray(root.plugins)) {
        root.plugins = root.plugins.filter(
          (p: unknown) => !(p === SPEC || (p && typeof p === 'object' && (p as any).package === SPEC)),
        );
        if (root.plugins.length === 0) delete root.plugins;
        await writeJson(cliPath, root);
      }
      await fs.rm(pluginPath(), { force: true }).catch(() => undefined);
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

function hermesTarget(): HookTarget {
  const pluginDir = () => homeJoin('.hermes', 'plugins', 'herdr-desktop-agent-state');
  return {
    configDir: pluginDir,
    hookPath: () => join(pluginDir(), '__init__.py'),
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = pluginDir();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'plugin.yaml'), HERMES_PLUGIN_YAML, 'utf8');
      await fs.writeFile(join(dir, '__init__.py'), HERMES_PLUGIN_INIT, 'utf8');
    },
    async uninstall() {
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
  await fs.writeFile(patchPath, next, 'utf8');
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
  await fs.writeFile(patchPath, `${cleaned}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// hook 脚本资产（bash / PowerShell，带标记 + 状态上报）
// ---------------------------------------------------------------------------

function hookScriptContent(windows: boolean): string {
  return windows ? WINDOWS_HOOK_SCRIPT : UNIX_HOOK_SCRIPT;
}

/**
 * hook 脚本：读取 action 参数（session/working/blocked/idle/done），从 stdin
 * JSON 提取 session_id/sessionId，把会话引用与状态 POST 回 Main。
 */
const UNIX_HOOK_SCRIPT = `#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=1
set -u
action="\${1:-session}"
payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)"
[ -z "$session_id" ] && session_id="$(printf '%s' "$payload" | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)"
[ -z "$HERDR_DESKTOP_REPORT_URL" ] && exit 0
[ -z "$HERDR_DESKTOP_PANE_ID" ] && exit 0
agent="\${HERDR_DESKTOP_AGENT:-unknown}"
body="{\\"paneId\\":\\"$HERDR_DESKTOP_PANE_ID\\",\\"source\\":\\"herdr:$agent\\",\\"agent\\":\\"$agent\\""
[ -n "$session_id" ] && body="$body,\\"sessionId\\":\\"$session_id\\""
case "$action" in working|blocked|idle|done) body="$body,\\"state\\":\\"$action\\"";; esac
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
`;

const WINDOWS_HOOK_SCRIPT = `# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=1
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
$payload = [Console]::In.ReadToEnd()
$sessionId = $null
if ($payload -match '"session_id"\\s*:\\s*"([^"]+)"') { $sessionId = $Matches[1] }
elseif ($payload -match '"sessionId"\\s*:\\s*"([^"]+)"') { $sessionId = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
$agent = if ($env:HERDR_DESKTOP_AGENT) { $env:HERDR_DESKTOP_AGENT } else { 'unknown' }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = "herdr:$agent"; agent = $agent }
if ($sessionId) { $body.sessionId = $sessionId }
if ($action -in @('working','blocked','idle','done')) { $body.state = $action }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
`;
