/**
 * xterm.js 封装 —— 每个 agent pane 一个终端实例。
 *
 * - 终端背景不是写死的，而是从当前主题的 CSS 变量实时读取（--terminal-bg），
 *   因此永远与主区域背景保持一致，切换主题时同步更新，不会出现配色错位。
 * - 语义色（ANSI 16 色）按 light/dark 两套给出，保证对比度。
 */

import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import type { ResolvedTheme } from '@shared/state';

export interface TerminalHandle {
  terminal: Terminal;
  fit: FitAddon;
  /**
   * 写入终端。`onParsed` 在该段数据**全部解析完成**后回调。
   *
   * xterm 的解析是分片异步的（无近期用户输入时先经 `setTimeout` 起头），
   * 调用方无法用同步标志界定「这段内容何时解析完」，只能依赖这个回调
   * ——例如回放历史缓冲时，需要在此期间闭住「应答回写 PTY」的通路。
   */
  write: (data: string, onParsed?: () => void) => void;
  /** 计算适配尺寸并主动上报，不依赖 onResize（首次 fit 的事件会丢失）。 */
  fitAndSync: (onSize: (cols: number, rows: number) => void) => void;
  /**
   * 应用新的主题配色。
   *
   * 仅设置 options.theme 不足以让 WebGL 渲染器换色：它的字形/背景纹理图集
   * 是缓存的，仍保留旧主题的背景色。必须同时清空图集并强制重绘，
   * 否则浅色主题下终端仍显示深色背景。
   */
  applyTheme: (theme: ResolvedTheme) => void;
  /** scrollback 搜索。 */
  search: SearchAddon;
  dispose: () => void;
}

/** ANSI 语义色 —— 按主题区分，保证可读性。 */
const DARK_ANSI: Omit<ITheme, 'background' | 'foreground' | 'cursor' | 'cursorAccent'> = {
  selectionBackground: 'rgba(255, 255, 255, 0.18)',
  black: '#1f1f1f',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#eab308',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d4',
  brightBlack: '#737373',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

const LIGHT_ANSI: Omit<ITheme, 'background' | 'foreground' | 'cursor' | 'cursorAccent'> = {
  selectionBackground: 'rgba(0, 0, 0, 0.14)',
  black: '#18181b',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e4e4e7',
  brightBlack: '#71717a',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#fafafa',
};

/** 兜底配色：仅在读不到 CSS 变量时使用，需与 global.css 的主题令牌保持一致。 */
const FALLBACK_BG: Record<ResolvedTheme, string> = {
  dark: '#0d0d0d',
  light: '#ffffff',
};

const FALLBACK_FG: Record<ResolvedTheme, string> = {
  dark: '#cccccc',
  light: '#3b3b3b',
};

/** 读取当前主题下的一个 CSS 变量值。 */
function readCssVar(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : null;
}

/**
 * 把 `#RRGGBB` 转成 OSC 颜色报告的 `rgb:RRRR/GGGG/BBBB` 格式。
 * 8 位分量按 `cc * 0x101` 扩展到 16 位（即重复两次）。
 */
function hexToRgbColon(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 'rgb:0000/0000/0000';
  const expand = (c: string) => c.toLowerCase() + c.toLowerCase();
  return `rgb:${expand(m[1])}/${expand(m[2])}/${expand(m[3])}`;
}

/**
 * 根据背景色亮度判断是否为深色（用于颜色方案报告 997 的取值）。
 * 与 opentui 的 inferThemeModeFromBackgroundColor 保持一致：阈值 128。
 */
function isDarkBackground(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return true;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return (r * 299 + g * 587 + b * 114) / 1000 <= 128;
}

/**
 * 向 PTY 写入一条 OSC 序列。
 *
 * 直接写裸 `ESC ]` 形式即可：Windows 上 node-pty 用的是自带 conpty.dll
 * （见 electron/runtime/pty-manager.ts 的 useConptyDll），出站 OSC 与其它平台
 * 一样逐字节透传，无需再为系统内置 ConPTY 插入 NUL。
 */
function writeOscToPty(write: (data: string) => void, body: string): void {
  write(`\x1b]${body}`);
}

/**
 * 构造一条「997 颜色方案报告 + OSC 10 前景 + OSC 11 背景」的完整应答。
 *
 * 三者必须拼成**一个**字节串、一次性写回 PTY：opentui 收到 997 后 queueMicrotask
 * 重查调色板，若颜色应答分属不同 PTY 写，微任务会在颜色到达前先跑完。
 */
function buildThemeResponse(scheme: 1 | 2, foreground: string, background: string): string {
  return (
    `\x1b[?997;${scheme}n` +
    `\x1b]10;${hexToRgbColon(foreground)}\x07` +
    `\x1b]11;${hexToRgbColon(background)}\x07`
  );
}

/**
 * 构造 xterm 主题。
 *
 * 背景/前景从 CSS 变量读取，使终端与外壳共享同一份主题令牌；
 * `fallback` 用于变量尚未就绪（首帧）时兜底。
 */
export function terminalTheme(theme: ResolvedTheme): ITheme {
  const background =
    readCssVar('--terminal-bg') ?? readCssVar('--bg-app') ?? FALLBACK_BG[theme];
  const foreground = readCssVar('--terminal-fg') ?? FALLBACK_FG[theme];

  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    ...(theme === 'light' ? LIGHT_ANSI : DARK_ANSI),
  };
}

export function createTerminal(
  container: HTMLElement,
  options?: {
    fontSize?: number;
    fontFamily?: string;
    theme?: ResolvedTheme;
    /** 主题颜色查询的响应需要回写 PTY 时调用，由 TerminalPane 注入为 writeTerminal(paneId, data)。 */
    onQueryResponse?: (data: string) => void;
  },
): TerminalHandle {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: options?.fontSize ?? 13,
    fontFamily:
      options?.fontFamily ??
      '"Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    theme: terminalTheme(options?.theme ?? 'dark'),
    allowProposedApi: true,
    scrollback: 10000,
    // 让 xterm 的背景与容器背景一致，避免出现一圈异色边框
    allowTransparency: false,
  });

  const fit = new FitAddon();
  const unicode11 = new Unicode11Addon();
  const search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(unicode11);
  terminal.loadAddon(search);
  terminal.unicode.activeVersion = '11';
  terminal.open(container);

  /*
   * 渲染器生命周期：加载 WebGL 渲染器，并处理它挂掉之后的回退与重建。
   *
   * 默认的 DOM 渲染器为每个字符单元格创建一个 <div> 并逐个改动，
   * 在高频输出时产生大量 DOM 变动，肉眼可见闪烁。
   * WebGL 渲染器改为绘制到位图，DOM 保持稳定。
   *
   * 失败时（无 GPU / 上下文丢失）自动回退到 DOM 渲染器，不影响可用性。
   */
  let webgl: WebglAddon | null = null;
  /** 终端是否已销毁：延迟回调都要检查，避免操作已释放的 terminal。 */
  let disposed = false;
  /** 连续自动重建次数，用于给「GPU 持续不可用」封顶，避免无限空转。 */
  let autoRebuilds = 0;
  /** 自动重建次数上限；触顶后留在 DOM 渲染器，用户切主题仍可手动恢复 WebGL。 */
  const MAX_AUTO_REBUILDS = 3;
  /** 新上下文活过这个时长才视为已恢复稳定，清零重建计数。 */
  const REBUILD_STABLE_MS = 60_000;
  /** 重建前的延迟：不在 contextlost 回调里同步创建新上下文（部分驱动会立刻失败）。 */
  const REBUILD_DELAY_MS = 300;

  /** 整屏重绘（终端已销毁时静默跳过）。 */
  const refreshAll = (): void => {
    try {
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    } catch {
      // 终端已销毁
    }
  };

  /**
   * 重建渲染器并整屏重绘。
   *
   * 抽成一条路径是因为两处都需要「换掉 WebGL 实例 + 重绘」：
   * 主题切换（WebGL 的字形/背景图集缓存了旧配色）与上下文丢失后的恢复。
   */
  const rebuildRenderer = (): void => {
    if (webgl) {
      try {
        webgl.dispose();
      } catch {
        // 已释放
      }
      webgl = null;
    }
    let created: WebglAddon | null = null;
    try {
      created = new WebglAddon();
      const addon = created;
      addon.onContextLoss(() => handleContextLoss(addon));
      terminal.loadAddon(addon);
      webgl = addon;
    } catch {
      /*
       * 拿不到 WebGL 上下文（无 GPU / 上下文配额耗尽）：留在 DOM 渲染器，刷新后照样可读。
       * 刚创建但没装上的实例必须显式释放，否则每失败一次就泄漏一个 WebGL 上下文配额，
       * 反过来让后续重建更容易失败——这正是我们要修的那类症状的成因之一。
       */
      try {
        created?.dispose();
      } catch {
        // 已释放
      }
      webgl = null;
    }
    refreshAll();
  };

  /**
   * WebGL 上下文丢失（GPU 进程崩溃 / 显存压力 / 驱动重置）。
   *
   * Chromium 只有一个 GPU 进程，一次丢失会同时打掉**所有** pane 的上下文——
   * 表现就是所有终端在同一瞬间一起花屏。
   *
   * 丢失后 xterm 会把渲染器换回 DOM，但新渲染器的节点不会自动补齐缓冲区内容：
   * 不重绘的话屏幕就停在错乱状态，只有再触发一次重绘（切主题、拉窗口）才恢复。
   * 所以这里必须**先整屏重绘**保证立刻可读，再尝试把 WebGL 建回来。
   */
  const handleContextLoss = (lost: WebglAddon): void => {
    console.warn('[terminal] webgl context lost, falling back to DOM renderer');
    if (webgl === lost) webgl = null;
    try {
      lost.dispose();
    } catch {
      // 已释放
    }
    refreshAll();

    if (disposed || autoRebuilds >= MAX_AUTO_REBUILDS) return;
    autoRebuilds += 1;
    setTimeout(() => {
      // 期间已由别的路径（切主题）重建出可用上下文，就不必再插手
      if (disposed || webgl) return;
      rebuildRenderer();
      if (!webgl) return; // 重建失败：计数保留，累计到上限后停止尝试
      // 新上下文活过一段时间才清零，秒挂的话计数会持续累加直到触顶
      setTimeout(() => {
        autoRebuilds = 0;
      }, REBUILD_STABLE_MS);
    }, REBUILD_DELAY_MS);
  };

  rebuildRenderer();

  /*
   * 应答 TUI 启动时发来的主题颜色查询。
   *
   * opencode（opentui）启动时发送 `CSI ? 2031 h` 启用颜色方案报告，并自己发
   * `OSC 10;?` / `OSC 11;?` 查询前景/背景色；codex 同样会在启动时探测一次配色。
   * 宿主需：
   * - 收到 2031 h 时回「997 颜色方案报告 + OSC 10/11 颜色」；
   * - 收到 OSC 10/11 查询时直接回颜色。
   *
   * Windows 上这条链路依赖 node-pty 自带的 conpty.dll（见
   * electron/runtime/pty-manager.ts 的 useConptyDll）：系统内置的 ConPTY 会把子进程
   * 发出的 OSC 查询整条吞掉，宿主收不到查询也就无从应答，codex 便退回自己的深色配色。
   */
  const respond = options?.onQueryResponse;

  const pushTheme = (scheme: 1 | 2): void => {
    if (!respond) return;
    const fg = terminal.options.theme?.foreground ?? FALLBACK_FG.dark;
    const bg = terminal.options.theme?.background ?? FALLBACK_BG.dark;
    respond(buildThemeResponse(scheme, fg, bg));
  };

  if (respond) {
    // OSC 10：前景色查询
    terminal.parser.registerOscHandler(10, (data) => {
      if (data === '?' || data === '') {
        const fg = terminal.options.theme?.foreground ?? FALLBACK_FG.dark;
        writeOscToPty(respond, `10;${hexToRgbColon(fg)}\x07`);
        return true;
      }
      return false;
    });

    // OSC 11：背景色查询
    terminal.parser.registerOscHandler(11, (data) => {
      if (data === '?' || data === '') {
        const bg = terminal.options.theme?.background ?? FALLBACK_BG.dark;
        writeOscToPty(respond, `11;${hexToRgbColon(bg)}\x07`);
        return true;
      }
      return false;
    });

    // CSI ? 2031 h：opencode 启用颜色方案报告
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.length === 1 && params[0] === 2031) {
        const bg = terminal.options.theme?.background ?? FALLBACK_BG.dark;
        pushTheme(isDarkBackground(bg) ? 1 : 2);
        return true;
      }
      return false;
    });
  }

  try {
    fit.fit();
  } catch {
    // 容器尺寸未就绪
  }

  /**
   * 应用主题配色。
   *
   * 仅设置 options.theme 不足以让 WebGL 渲染器换色：它的字形/背景纹理图集
   * 是缓存的，仍保留旧主题的背景色。必须重建渲染器并整屏重绘
   * （见 rebuildRenderer 注释）。
   */
  const applyTheme = (theme: ResolvedTheme): void => {
    terminal.options.theme = terminalTheme(theme);
    rebuildRenderer();
  };

  return {
    terminal,
    fit,
    write: (data: string, onParsed?: () => void) => terminal.write(data, onParsed),
    /*
     * 计算适配尺寸并**主动上报**给 PTY。
     *
     * 不能依赖 terminal.onResize：xterm 只在 cols/rows 发生变化时才发事件，
     * 而首次 fit.fit() 发生在渲染侧订阅之前，这一次最关键的变化会被丢掉，
     * 导致 PTY 永远停留在 spawn 时的默认尺寸（120x40），
     * TUI（如 opencode）按错误尺寸排版，内容会画到可视区之外。
     */
    fitAndSync: (onSize: (cols: number, rows: number) => void) => {
      let dims: { cols: number; rows: number } | null = null;
      try {
        dims = fit.proposeDimensions() ?? null;
        if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
          terminal.resize(dims.cols, dims.rows);
        } else {
          fit.fit();
          dims = { cols: terminal.cols, rows: terminal.rows };
        }
      } catch {
        dims = { cols: terminal.cols, rows: terminal.rows };
      }
      if (dims && dims.cols > 0 && dims.rows > 0) {
        onSize(dims.cols, dims.rows);
      }
    },
    search,
    applyTheme,
    dispose: () => {
      // 先置位：上下文丢失的延迟重建回调据此跳过已销毁的终端
      disposed = true;
      try {
        webgl?.dispose();
      } catch {
        // 已释放
      }
      terminal.dispose();
    },
  };
}
