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
  write: (data: string) => void;
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

/** 渲染进程判断平台：仅用于绕开 Windows ConPTY 的 OSC 过滤。 */
const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

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
 * Windows 上 ConPTY 会把 `ESC ]` 开头的 OSC 整条吞掉，需在 ESC 与 ] 之间插入
 * NUL 字节绕过其过滤器；非 Windows（forkpty）直接写标准形式。
 */
function writeOscToPty(write: (data: string) => void, body: string): void {
  if (isWindows) {
    write(`\x1b\x00]${body}`);
    return;
  }
  write(`\x1b]${body}`);
}

/**
 * 构造一条「997 颜色方案报告 + OSC 10 前景 + OSC 11 背景」的完整应答。
 *
 * 三者必须拼成**一个**字节串、一次性写回 PTY：opentui 收到 997 后 queueMicrotask
 * 重查调色板，若颜色应答分属不同 PTY 写，微任务会在颜色到达前先跑完。
 */
function buildThemeResponse(scheme: 1 | 2, foreground: string, background: string): string {
  const osc = isWindows ? '\x1b\x00]' : '\x1b]';
  return (
    `\x1b[?997;${scheme}n` +
    `${osc}10;${hexToRgbColon(foreground)}\x07` +
    `${osc}11;${hexToRgbColon(background)}\x07`
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
   * 加载 WebGL 渲染器。
   *
   * 默认的 DOM 渲染器为每个字符单元格创建一个 <div> 并逐个改动，
   * 在高频输出时产生大量 DOM 变动，肉眼可见闪烁。
   * WebGL 渲染器改为绘制到位图，DOM 保持稳定。
   *
   * 失败时（无 GPU / 上下文丢失）自动回退到 DOM 渲染器，不影响可用性。
   */
  let webgl: WebglAddon | null = null;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      // 上下文丢失后必须释放，xterm 会自动回退到 DOM 渲染器
      webgl?.dispose();
      webgl = null;
    });
    terminal.loadAddon(webgl);
  } catch {
    webgl = null;
  }

  /*
   * 应答 opencode 在启动时发来的主题颜色查询。
   *
   * opencode（opentui）启动时发送 `CSI ? 2031 h` 启用颜色方案报告，并（非 Windows）
   * 自己发 `OSC 10;?` / `OSC 11;?` 查询前景/背景色。宿主需：
   * - 收到 2031 h 时回「997 颜色方案报告 + OSC 10/11 颜色」；
   * - 收到 OSC 10/11 查询时直接回颜色。
   *
   * Windows 上 ConPTY 会吞掉 opencode 自己发出的 OSC 查询，因此 2031 h 触发的
   * 主动推送是主要路径，且必须用 `ESC NUL ]` 绕过 ConPTY 的 OSC 过滤器。
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
   * 是缓存的，仍保留旧主题的背景色。必须重建 WebGL 上下文（dispose 后重新
   * loadAddon），新实例会以当前 theme 重新初始化。失败时退化为 DOM 渲染器。
   */
  const applyTheme = (theme: ResolvedTheme): void => {
    terminal.options.theme = terminalTheme(theme);

    if (webgl) {
      try {
        webgl.dispose();
      } catch {
        // 已释放
      }
      webgl = null;
    }
    try {
      const next = new WebglAddon();
      next.onContextLoss(() => {
        next.dispose();
        if (webgl === next) webgl = null;
      });
      terminal.loadAddon(next);
      webgl = next;
    } catch {
      webgl = null;
    }
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  };

  return {
    terminal,
    fit,
    write: (data: string) => terminal.write(data),
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
      try {
        webgl?.dispose();
      } catch {
        // 已释放
      }
      terminal.dispose();
    },
  };
}
