/**
 * 官方集成 hook 安装器 —— 参考 herdr `src/integration/`。
 *
 * 把一个小型 hook 脚本写进各 agent 的配置目录，并把它注册到该 agent 的
 * SessionStart 事件上：会话启动时 hook 读取 agent 传入的 JSON 载荷，把
 * 会话 id 报回 Main（经 ReportServer），Main 持久化后即可在重启 pane 时
 * 用 `--resume`/`--session` 恢复。
 *
 * 与 herdr 的对齐点：
 * - 按 agent 配置目录定位（尊重对应环境变量）；
 * - hook 命令跨平台：Windows 用 PowerShell，Unix 用 bash；
 * - 只上报会话引用，agent 状态（working/blocked/done）仍由终端检测负责；
 * - 各 agent 的 hooks 结构差异用 shape 区分（nested / direct / simple / toml）。
 *
 * 已覆盖：claude、codex、kimi、copilot、devin、droid、qodercli、qwen、
 * letta、cursor。pi/omp 是扩展、opencode/kilo/hermes 是插件、mastracode/
 * grok/antigravity 各有特殊 config，后续按同样结构继续扩展 registry。
 */

import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isWindows } from '../platform';
import type { HookStatus } from '../../shared/protocol';

const HOOK_SCRIPT_NAME = isWindows ? 'herdr-agent-state.ps1' : 'herdr-agent-state.sh';
/** qwen / letta 用会话专用脚本名（对应 herdr 的 `*_HOOK_INSTALL_NAME`）。 */
const SESSION_SCRIPT_NAME = isWindows ? 'herdr-agent-session.ps1' : 'herdr-agent-session.sh';

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
};

export function hookStatuses(): Record<string, HookStatus> {
  const result: Record<string, HookStatus> = {};
  for (const [id, target] of Object.entries(HOOK_TARGETS)) {
    result[id] = target.isInstalled() ? 'installed' : 'not-installed';
  }
  return result;
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

type JsonShape = 'nested' | 'direct' | 'simple';

interface JsonHooksTargetOptions {
  configDir: () => string | null;
  scriptName: string;
  /** 脚本相对 configDir 的子目录；null 表示直接放 configDir 下。 */
  scriptSubdir: string | null;
  configFile: string;
  event: string;
  shape: JsonShape;
  matcher?: string;
  timeoutSec?: number;
  quiet?: boolean;
  /** cursor 的 hooks.json 需要顶层 version 字段。 */
  withVersion?: boolean;
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
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** devin：XDG_CONFIG_HOME/devin，Windows 用 APPDATA/devin，否则 ~/.config/devin。 */
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

/** nested：{ matcher?, hooks: [{ type:"command", command, timeout?, quiet? }] } */
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

/** direct：{ type:"command", bash|powershell: command, timeoutSec }（copilot） */
function ensureDirectHook(hooks: Record<string, any>, event: string, command: string, timeoutSec: number): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  const field = isWindows ? 'powershell' : 'bash';
  if (entries.some((e: any) => hookMatches(e, command))) return;
  entries.push({ type: 'command', [field]: command, timeoutSec });
}

/** simple：{ command }（cursor） */
function ensureSimpleHook(hooks: Record<string, any>, event: string, command: string): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => e && e.command === command)) return;
  entries.push({ command });
}

function removeHook(hooks: Record<string, any>, event: string, command: string): boolean {
  const entries = hooks[event];
  if (!Array.isArray(entries)) return false;
  let removed = false;
  const next: any[] = [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && Array.isArray(entry.hooks)) {
      // nested
      const kept = entry.hooks.filter((h: any) => !hookMatches(h, command));
      if (kept.length !== entry.hooks.length) removed = true;
      if (kept.length > 0) next.push({ ...entry, hooks: kept });
    } else if (hookMatches(entry, command) || (entry && entry.command === command)) {
      // direct / simple
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
  return {
    configDir: opts.configDir,
    hookPath() {
      const dir = this.configDir();
      if (!dir) return null;
      return opts.scriptSubdir ? join(dir, opts.scriptSubdir, opts.scriptName) : join(dir, opts.scriptName);
    },
    isInstalled() {
      const path = this.hookPath();
      return path ? existsSync(path) : false;
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
      const command = hookCommand(path, 'session');
      if (opts.shape === 'nested') {
        ensureNestedHook(hooks, opts.event, command, {
          matcher: opts.matcher,
          timeoutSec: opts.timeoutSec,
          quiet: opts.quiet,
        });
      } else if (opts.shape === 'direct') {
        ensureDirectHook(hooks, opts.event, command, opts.timeoutSec ?? 10);
      } else {
        ensureSimpleHook(hooks, opts.event, command);
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
      const command = hookCommand(path ?? '', 'session');
      removeHook(hooks, opts.event, command);
      await writeJson(configPath, root);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// claude —— ~/.claude/settings.json 的 SessionStart hook（startup + resume 两个 matcher）
// ---------------------------------------------------------------------------

function claudeTarget(): HookTarget {
  return {
    configDir: () => envOrHome('CLAUDE_CONFIG_DIR', ['.claude']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      const path = this.hookPath();
      return path ? existsSync(path) : false;
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
      const command = hookCommand(path, 'session');
      for (const matcher of ['startup', 'resume']) {
        ensureNestedHook(hooks, 'SessionStart', command, { matcher, timeoutSec: 10 });
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
      await writeJson(settingsPath, settings);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// codex —— ~/.codex/hooks.json（SessionStart）+ ~/.codex/config.toml（hooks=true）
// ---------------------------------------------------------------------------

function codexTarget(): HookTarget {
  return {
    configDir: () => envOrHome('CODEX_HOME', ['.codex']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      const path = this.hookPath();
      return path ? existsSync(path) : false;
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

      // hooks.json：嵌套 SessionStart（对应 herdr ensure_command_hook，无 matcher）
      const hooksPath = join(dir, 'hooks.json');
      const hooksRoot = await readJson(hooksPath);
      const hooks = ensureHooksObject(hooksRoot);
      ensureNestedHook(hooks, 'SessionStart', hookCommand(path, 'session'), { timeoutSec: 10 });
      await writeJson(hooksPath, hooksRoot);

      // config.toml：启用 codex hooks（对应 herdr build_codex_config_with_hooks）
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
      await writeJson(hooksPath, hooksRoot);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

/**
 * 给 codex 的 config.toml 追加 `[features] hooks = true`（保留原有内容）。
 * 对应 herdr `build_codex_config_with_hooks`。
 */
function codexConfigWithHook(content: string): string {
  let result = content.replace(/\r?\n$/, '');
  if (!/^\s*\[features\]/m.test(result)) {
    result += '\n\n[features]';
  }
  if (!/^\s*hooks\s*=\s*true/m.test(result)) {
    const lines = result.split('\n');
    const idx = lines.findIndex((line) => /^\s*\[features\]/.test(line));
    if (idx >= 0) {
      lines.splice(idx + 1, 0, 'hooks = true');
      result = lines.join('\n');
    } else {
      result += '\nhooks = true';
    }
  }
  return `${result}\n`;
}

// ---------------------------------------------------------------------------
// kimi —— ~/.kimi-code/config.toml 的 [[hooks]] 块
// ---------------------------------------------------------------------------

function kimiTarget(): HookTarget {
  return {
    configDir: () => envOrHome('KIMI_CODE_HOME', ['.kimi-code']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      const path = this.hookPath();
      return path ? existsSync(path) : false;
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent(isWindows), 'utf8');

      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await fs.writeFile(configPath, kimiConfigWithHook(content, path), 'utf8');
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

/** 追加一个 herdr 标记的 `[[hooks]]` 块（对应 herdr build_kimi_config_with_hooks）。 */
function kimiConfigWithHook(content: string, hookPath: string): string {
  if (content.includes(KIMI_BLOCK_BEGIN)) return content;
  const command = tomlString(hookCommand(hookPath, 'session'));
  const block = [
    KIMI_BLOCK_BEGIN,
    '[[hooks]]',
    'event = "SessionStart"',
    `command = ${command}`,
    'timeout = 10',
    KIMI_BLOCK_END,
  ].join('\n');
  const trimmed = content.replace(/\r?\n$/, '');
  return `${trimmed}\n\n${block}\n`;
}

function removeKimiBlock(content: string): string {
  const begin = content.indexOf(KIMI_BLOCK_BEGIN);
  const end = content.indexOf(KIMI_BLOCK_END);
  if (begin < 0) return content;
  const after = end >= 0 ? end + KIMI_BLOCK_END.length : content.length;
  return (content.slice(0, begin) + content.slice(after)).replace(/\n{3,}/g, '\n\n');
}

/** TOML basic string 转义（用于命令串）。 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\u0000-\u001f/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

// ---------------------------------------------------------------------------
// hook 脚本资产（bash / PowerShell）
// ---------------------------------------------------------------------------

function hookScriptContent(windows: boolean): string {
  return windows ? WINDOWS_HOOK_SCRIPT : UNIX_HOOK_SCRIPT;
}

/**
 * hook 脚本：从 stdin 的 JSON 载荷里提取 session_id/sessionId，POST 回 Main。
 * agent 通过环境变量注入 HERDR_PANE_ID / HERDR_AGENT / HERDR_REPORT_URL，
 * 脚本据此构造上报体；提取不到会话 id 时静默退出（0），不影响 agent。
 */
const UNIX_HOOK_SCRIPT = `#!/usr/bin/env bash
# herdr-desktop agent hook: report the session id back to Herdr on SessionStart.
set -u
payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)"
[ -z "$session_id" ] && session_id="$(printf '%s' "$payload" | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)"
[ -z "$session_id" ] && exit 0
[ -z "$HERDR_REPORT_URL" ] && exit 0
[ -z "$HERDR_PANE_ID" ] && exit 0
agent="$HERDR_AGENT"
[ -z "$agent" ] && agent="unknown"
curl -s -X POST "$HERDR_REPORT_URL" -H 'Content-Type: application/json' \\
  --data "{\\"paneId\\":\\"$HERDR_PANE_ID\\",\\"source\\":\\"herdr:$agent\\",\\"agent\\":\\"$agent\\",\\"sessionId\\":\\"$session_id\\"}" \\
  >/dev/null 2>&1 || true
`;

const WINDOWS_HOOK_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$payload = [Console]::In.ReadToEnd()
$sessionId = $null
if ($payload -match '"session_id"\\s*:\\s*"([^"]+)"') { $sessionId = $Matches[1] }
elseif ($payload -match '"sessionId"\\s*:\\s*"([^"]+)"') { $sessionId = $Matches[1] }
if (-not $sessionId) { exit 0 }
if (-not $env:HERDR_REPORT_URL -or -not $env:HERDR_PANE_ID) { exit 0 }
$agent = if ($env:HERDR_AGENT) { $env:HERDR_AGENT } else { 'unknown' }
$body = @{ paneId = $env:HERDR_PANE_ID; source = "herdr:$agent"; agent = $agent; sessionId = $sessionId } | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_REPORT_URL -ContentType 'application/json' -Body $body | Out-Null } catch { }
`;
