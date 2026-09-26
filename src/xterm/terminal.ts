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

/**
 * 渲染进程里判断平台：ConPTY 的 OSC 过滤器只在 Windows 上存在。
 * 这里不引入 Electron 的 platform 模块，避免渲染进程额外依赖。
 */
const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

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

/**
 * 把 `#RRGGBB` 转成 OSC 颜色报告的 `rgb:RRRR/GGGG/BBBB` 格式。
 *
 * 8 位分量按 `cc * 0x101` 扩展到 16 位（即重复两次）
 */
function hexToRgbColon(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 'rgb:0000/0000/0000';
  const expand = (c: string) => c.toLowerCase() + c.toLowerCase();
  return `rgb:${expand(m[1])}/${expand(m[2])}/${expand(m[3])}`;
}

/** 根据背景色亮度判断是否为深色（用于颜色方案报告 997 的取值）。 */
function isDarkBackground(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return true;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 128;
}

/**
 * 向 PTY 写入一条 OSC 序列，并绕开 Windows ConPTY 的 OSC 过滤器。
 *
 * ConPTY 会把 `ESC ]` 开头的 OSC 序列整条丢弃（实测 `OSC 10/11/12` 均被吞，
 * `CSI` 与纯文本正常透传）。这不是「写入次数」的问题：把 `ESC ]` 与载荷
 * 拆成两次 `write` 看似可行，但 ConPTY 会按缓冲区合并后再过滤，
 * 只要两次写入落在同一个 read 里就依然被吞，结果不可靠。
 *
 * 可靠做法是在 `ESC` 与 `]` 之间插入一个 NUL 字节：
 * - ConPTY 的匹配器找的是字面量两字节前缀 `ESC ]`，中间多一个 NUL 后不再命中，
 *   整条序列原样透传；
 * - xterm.js / opentui 的 VT 解析器会忽略游离的 NUL，仍按 `ESC ]` 解析，
 *   因此子进程拿到的语义与标准 OSC 完全一致。
 *
 * 实测连续 8 次 OSC 10/11 往返全部命中。非 Windows（forkpty）无此过滤器，
 * 直接写标准形式。
 */
function writeOscToPty(write: (data: string) => void, body: string): void {
  if (isWindows) {
    write(`\x1b\x00]${body}`);
    return;
  }
  write(`\x1b]${body}`);
}

/**
 * 判断该命令是否需要 OSC 主题色适配。
 *
 * 判定取**命令的第一个 token**（可执行名），而不是在整条命令里做词边界搜索：
 * - 后者会把 `echo opencode`、`vim ~/notes/opencode.md`、`less opencode.log`
 *   这类「参数里恰好含 opencode」的命令误判为真，从而给普通 shell 挂上
 *   OSC 代答，重新引入命令行乱码；
 * - 也需要处理路径与 Windows 垫片：`/usr/local/bin/opencode`、`opencode.cmd`。
 *
 * 大小写不敏感，因为 Windows 上命令名不区分大小写。
 */
function isOscThemeCommand(command: string | null | undefined): boolean {
  if (!command) return false;
  const token = command.trim().split(/\s+/)[0] ?? '';
  const base = token.replace(/^.*[\\/]/, '').replace(/\.(cmd|bat|exe|ps1)$/i, '');
  return base.toLowerCase() === 'opencode';
}

/**
 * 注册主题颜色查询的响应处理。
 *
 * 1. opencode/opentui 发送 `CSI ? 2031 h`（启用颜色方案报告）；
 *    终端收到后主动回 `CSI ? 997 ; 1 n`（深色）或 `CSI ? 997 ; 2 n`（浅色）。
 * 2. TUI 收到 997 后调用原生 `queryThemeColors()`，写出 `OSC 10;?`（前景）
 *    与 `OSC 11;?`（背景）查询；终端回 `rgb:RRRR/GGGG/BBBB` 格式的实际颜色。
 * 3. TUI 必须**同时**拿到 10 和 11 两条响应才会重算 light/dark
 *    （opentui `RendererThemeMode.handleSequence` 要求两个字段都非空）。
 *
 * `onQueryResponse` 负责把序列写回 PTY；OSC 序列一律经 `writeOscToPty`
 * 以兼容 ConPTY。
 */
function registerThemeQueries(terminal: Terminal, onQueryResponse: (data: string) => void): void {
  // OSC 10：前景色查询
  terminal.parser.registerOscHandler(10, (data) => {
    if (data === '?' || data === '') {
      const fg = terminal.options.theme?.foreground ?? FALLBACK_FG.dark;
      writeOscToPty(onQueryResponse, `10;${hexToRgbColon(fg)}\x07`);
      return true;
    }
    return false;
  });

  // OSC 11：背景色查询
  terminal.parser.registerOscHandler(11, (data) => {
    if (data === '?' || data === '') {
      const bg = terminal.options.theme?.background ?? FALLBACK_BG.dark;
      writeOscToPty(onQueryResponse, `11;${hexToRgbColon(bg)}\x07`);
      return true;
    }
    return false;
  });

  // CSI ? 2031 h：启用颜色方案报告 → 主动上报 997
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.length === 1 && params[0] === 2031) {
      const bg = terminal.options.theme?.background ?? FALLBACK_BG.dark;
      const scheme = isDarkBackground(bg) ? 1 : 2;
      onQueryResponse(`\x1b[?997;${scheme}n`);
      return true;
    }
    return false;
  });
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
    /**
     * 终端需要回写字节给 PTY 时调用（主题颜色查询响应）。
     * 由 TerminalPane 注入为 writeTerminal(paneId, data)。
     */
    onQueryResponse?: (data: string) => void;
    /**
     * 该 pane 启动的命令，用于判定是否启用 OSC 主题查询适配。
     *
     * 只有 opencode（opentui）会发 `CSI ? 2031 h` 并期待终端代答 OSC 10/11。
     * 其余 agent 与普通 shell 收到这些序列时，行编辑器会把它们当成用户输入
     * 直接回显，在提示符后显示成一串乱码（历史 bug）。
     */
    command?: string | null;
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
   * 是否启用 OSC 主题色适配。按 command 门控：只有 opencode 走这套协商。
   *
   * 其余 agent 与普通 shell 并不理解 `OSC 10;?` / `CSI ? 2031 h`，收到代答
   * 序列后行编辑器会把它当用户输入回显，在提示符后留下一串乱码。
   * 门控放在注册处而非处理器内部，非 opencode 的 pane 干脆不挂这些 handler。
   */
  const respond = options?.onQueryResponse;
  const oscTheme = !!respond && isOscThemeCommand(options?.command);
  if (respond && oscTheme) {
    registerThemeQueries(terminal, respond);
  }

  // 记录上次上报给 TUI 的颜色方案（997 报告）。初值取创建时的主题，
  // 这样首次挂载时 applyTheme 不会向尚未就绪的 PTY 写入噪声序列。
  let lastScheme: 1 | 2 = (options?.theme ?? 'dark') === 'dark' ? 1 : 2;

  try {
    fit.fit();
  } catch {
    // 容器尺寸未就绪
  }

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
    applyTheme: (theme: ResolvedTheme) => {
      terminal.options.theme = terminalTheme(theme);

      /*
       * 主题切换时主动把颜色方案变更推送给 PTY 里的 TUI。
       *
       * opencode/opentui 在启动时发送 `CSI ? 2031 h` 开启颜色方案报告，
       * 之后依赖终端推送的 `CSI ? 997 ; 1 n`（深色）/ `CSI ? 997 ; 2 n`（浅色）
       * 触发配色重探。若只改 xterm 自身配色而不推送 997，TUI 会沿用旧主题色。
       *
       * 注意：997 只让 opentui 去重探，真正决定 light/dark 的是随后
       * OSC 10/11 的响应颜色，所以推送后必须补上响应（见下）。
       *
       * 整段只在 oscTheme 为真时执行——非 opencode 的 pane 收到 997 会把它
       * 当用户输入回显，在提示符后显示为乱码。
       */
      if (oscTheme) {
        const bg = terminal.options.theme?.background ?? FALLBACK_BG[theme];
        const scheme: 1 | 2 = isDarkBackground(bg) ? 1 : 2;
        if (scheme !== lastScheme) {
          lastScheme = scheme;
          respond(`\x1b[?997;${scheme}n`);
        }

        /*
         * Windows 上必须由宿主代答 OSC 10/11。
         *
         * opentui 的原生核心（`lib.queryThemeColors`）把 `OSC 10;?` / `OSC 11;?`
         * 写到 stdout，但 ConPTY 会把 OSC 序列整条丢弃 —— 实测子进程输出的
         * `\x1b]10;?\x07` 与 `\x1b]11;?\x07` 都不会出现在 PTY 的 onData 里
         * （`CSI ? 2031 h`、`CSI ? 997;N n` 等 CSI 序列则正常透传）。
         *
         * 于是 registerOscHandler(10/11) 永远不会被触发，opentui 的
         * `themeOscForeground` / `themeOscBackground` 始终为 null，
         * `handleSequence` 因「两者必须都有值」而不改变 themeMode，
         * `theme_mode` 事件永不触发 —— opencode 的主题就此定格在启动时的值。
         *
         * 因此这里主动把 OSC 查询喂给本地 parser（经 `terminal.write`，
         * 它只做解析，不产生可见输出），让已注册的 10/11 handler 触发，
         * 再经 `writeOscToPty` 把真实颜色拆写回 PTY。
         */
        terminal.write('\x1b]10;?\x07\x1b]11;?\x07');
      }

      /*
       * WebGL 渲染器会在首次渲染时缓存清屏色，仅改 options.theme + clearTextureAtlas
       * 不会让它用新背景重绘（表现为浅色主题下终端仍是黑底）。
       *
       * 可靠做法是重建 WebGL 上下文：dispose 后重新 loadAddon，
       * 新实例会以当前 theme 重新初始化。失败时退化为 DOM 渲染器。
       */
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
    },
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
