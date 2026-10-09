/**
 * TerminalPane —— 单个 agent pane 的终端区域。
 *
 * 性能关键：PTY 数据通过 terminalBus **直接写入** xterm 实例，
 * 不经过 React state / zustand 订阅，因此高频输出不会触发任何重渲染。
 *
 * 早期实现把累积缓冲接到 effect 上，每块数据都 `reset()` + 全量重放，
 * 造成屏幕反复清空重建（闪烁）。现在挂载时只回放一次历史，之后只做增量写入。
 *
 * 停止态：应用重启后恢复出的 pane 没有 PTY（进程不可能跨重启存活），
 * 此时显示一个空终端，重启入口在侧栏该 agent 行的按钮上。
 */

import { useEffect, useRef, useState } from 'react';
import type { PaneState } from '@shared/state';
import type { ClipboardPayload } from '@shared/protocol';
import { useTerminalStore, terminalBus } from '../stores/terminalStore';
import { useSettingsStore, useResolvedTheme } from '../stores/settingsStore';
import {
  writeTerminal,
  resizeTerminal,
  attachPane,
  focusPane,
  readClipboard,
  getPathForFile,
} from '../ipc/client';
import { createTerminal, type TerminalHandle } from '../xterm/terminal';
import { useT } from '../i18n';
import { isMac, searchShortcutLabel } from '../platform';
import { IconSearch, IconChevronDown, IconChevronUp, IconClose } from './icons';

/** 搜索高亮配色（深浅主题通用）。 */
const SEARCH_DECORATIONS = {
  matchBackground: '#3b82f6',
  matchBorder: '#60a5fa',
  matchOverviewRuler: '#3b82f6',
  activeMatchBackground: '#eab308',
  activeMatchBorder: '#fde047',
  activeMatchColorOverviewRuler: '#eab308',
};

/**
 * 把一组磁盘绝对路径格式化为写入终端的文本。
 *
 * 刻意不做 shell 转义 / 加引号：这些 pane 绝大多数跑的是 CLI coding agent
 * （Claude Code / Codex / opencode 等），它们的输入是纯文本提示词而非 shell，
 * 加引号会把引号本身带进路径、导致 agent 读不到文件。多个文件用空格分隔，
 * 并在末尾补一个空格作为结束分隔，与 macOS 终端拖放文件的行为一致。
 */
function formatInsertPaths(paths: string[]): string {
  return `${paths.join(' ')} `;
}

/**
 * 读取系统剪贴板并按「文件 / 图片 → 路径、文本 → 原文」写入指定 pane 的 PTY。
 *
 * 图片没有文本表示：由 Main 先把它落盘为临时文件，再插入临时文件路径，
 * 让终端里的 CLI agent 能按普通文件路径读取它。
 */
async function pasteIntoTerminal(paneId: string): Promise<void> {
  let payload: ClipboardPayload;
  try {
    payload = await readClipboard();
  } catch {
    return;
  }
  switch (payload.kind) {
    case 'files':
      writeTerminal(paneId, formatInsertPaths(payload.files));
      break;
    case 'image':
      writeTerminal(paneId, formatInsertPaths([payload.imagePath]));
      break;
    case 'text':
      writeTerminal(paneId, payload.text);
      break;
    case 'empty':
      break;
  }
}

interface TerminalPaneProps {
  pane: PaneState;
}

export function TerminalPane({ pane }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const resolvedTheme = useResolvedTheme();
  const fontSize = useSettingsStore((s) => s.settings.fontSize);
  const t = useT();
  // 旧快照可能缺 running 字段，按运行中处理
  const running = pane.running ?? true;

  // scrollback 搜索
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatch, setSearchMatch] = useState({ index: 0, count: 0 });

  const runSearch = (dir: 'next' | 'prev', query: string) => {
    const handle = handleRef.current;
    if (!handle) return;
    if (!query) {
      handle.search.clearDecorations();
      setSearchMatch({ index: 0, count: 0 });
      return;
    }
    const options = { decorations: SEARCH_DECORATIONS };
    if (dir === 'next') {
      handle.search.findNext(query, options);
    } else {
      handle.search.findPrevious(query, options);
    }
  };

  const closeSearch = () => {
    handleRef.current?.search.clearDecorations();
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatch({ index: 0, count: 0 });
    /*
     * 关闭搜索框后把键盘焦点还给终端：搜索输入框带着 autoFocus，
     * 卸载后焦点会丢失，xterm 的 textarea 不会自动拿回焦点。
     */
    handleRef.current?.terminal.focus();
  };

  // 创建 / 销毁 xterm 实例
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /*
     * 原生粘贴（右键菜单 / 鼠标中键 / macOS 上经菜单 ⌘V 触发的 paste）。
     *
     * 图片与文件没有文本表示，走 readClipboard → 路径插入；纯文本不拦截，
     * 仍交给 xterm 自带的 textarea 处理（保留其 bracketed paste 语义）。
     * 监听挂在 capture 阶段，保证在 xterm 的 textarea 处理前截住非文本内容。
     */
    const onNativePaste = (event: ClipboardEvent) => {
      const dt = event.clipboardData;
      if (!dt) return;

      const items = Array.from(dt.items);
      const fileList = Array.from(dt.files);
      const hasImage = items.some((item) => item.type.startsWith('image/'));
      /*
       * 文件在 paste 事件里可能以多种形式暴露，因平台而异：
       * - files（Windows 上由 CF_HDROP 映射）；
       * - text/uri-list 或 file-kind item（部分平台）；
       * - DataTransfer.types 里的 "Files"。
       * 任一命中就拦截，拿不到具体路径时兜底走主进程 readClipboard
       * （含 text/uri-list + Windows HDROP 双兜底）。
       */
      const hasFileMarker =
        fileList.length > 0 ||
        items.some((item) => item.type === 'text/uri-list' || item.kind === 'file') ||
        dt.types.includes('Files');

      if (!hasImage && !hasFileMarker) return; // 纯文本交给 xterm

      event.preventDefault();
      event.stopPropagation();

      /*
       * 优先用事件自带 File 的磁盘路径：这比让 Main 重新解析 text/uri-list
       * 更可靠（部分平台不暴露该格式）。截图等合成 File 拿不到路径时，
       * 退回 readClipboard（Main 落盘为临时文件）。
       */
      const paths: string[] = [];
      let hasSyntheticImage = false;
      for (const file of fileList) {
        let path = '';
        try {
          path = getPathForFile(file);
        } catch {
          path = '';
        }
        if (path) {
          paths.push(path);
        } else if (file.type.startsWith('image/')) {
          hasSyntheticImage = true;
        }
      }
      if (paths.length > 0 && !hasSyntheticImage) {
        writeTerminal(pane.paneId, formatInsertPaths(paths));
        return;
      }
      void pasteIntoTerminal(pane.paneId);
    };

    // 拖文件到终端：插入文件绝对路径。
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };

    const onDrop = (event: DragEvent) => {
      const fileList = event.dataTransfer?.files;
      if (!fileList || fileList.length === 0) return;
      event.preventDefault();
      const paths: string[] = [];
      for (let i = 0; i < fileList.length; i += 1) {
        try {
          const path = getPathForFile(fileList[i]);
          if (path) paths.push(path);
        } catch {
          // 前端构造、非磁盘文件的 File 拿不到路径，跳过
        }
      }
      if (paths.length > 0) {
        writeTerminal(pane.paneId, formatInsertPaths(paths));
      }
    };

    container.addEventListener('paste', onNativePaste, true);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('drop', onDrop);

    /*
     * 终端 → PTY 的唯一出口（用户输入与查询应答都走这里）。
     *
     * `replaying` 期间闭住：历史缓冲回放会让新终端实例重新应答上一个会话
     * 发出的终端能力查询——xterm 内建的 DA1/DECRPM 走 onData，herdr 自己的
     * OSC 10/11 处理器走 onQueryResponse，两条通路都汇到这里。此时 PTY 刚
     * 重建、子进程尚未切到 raw 模式，而 node-pty 建的 pty 带
     * ICANON|ECHO|ECHOCTL（见 node-pty/src/unix/pty.cc），这些应答会被内核
     * 原样回显，表现为 `^[[?1;2c^[[?2026;2$y...` 乱码。
     *
     * 回放总是排在实时数据之前（terminalBus 的积压数据在 register 时才补发），
     * 所以这个闭窗只覆盖回放本身，不会吞掉实时查询的应答。
     */
    let replaying = false;
    const toPty = (data: string): void => {
      if (replaying) return;
      writeTerminal(pane.paneId, data);
    };

    const handle = createTerminal(container, {
      fontSize,
      theme: resolvedTheme,
      // 主题颜色查询（OSC 10/11、CSI ? 2031 h）的响应回写到 PTY
      onQueryResponse: toPty,
    });
    handleRef.current = handle;

    /*
     * 聚焦的 pane 自动获取键盘焦点：新建、恢复（running 翻转重建终端）、
     * 强制重启（restartSeq 递增重建终端）后，终端 panel 直接可输入。
     */
    if (pane.focused) handle.terminal.focus();

    // 搜索匹配计数
    const resultsSub = handle.search.onDidChangeResults((e) => {
      setSearchMatch({ index: e.resultIndex, count: e.resultCount });
    });

    // 终端快捷键（拦截在 xterm 处理之前；随 terminal.dispose 一起销毁）
    handle.terminal.attachCustomKeyEventHandler((event) => {
      /*
       * xterm 会在 keydown / keypress / keyup 三个事件里都调用本回调。
       * 这里只处理 keydown，其余事件放行——否则一次按键会触发两次处理，
       * 典型症状就是 Ctrl+V 粘贴两次。
       */
      if (event.type !== 'keydown') return true;

      /*
       * 平台差异：
       * - macOS：复制/粘贴用 Cmd+C / Cmd+V（系统约定），
       *   且 Ctrl+C 必须原样送进 PTY（它是 SIGINT）。
       * - Windows / Linux：复制/粘贴都用 Ctrl+C / Ctrl+V：
       *   Ctrl+C 有选中时复制并清除选中，无选中时放行为 SIGINT。
       *
       * `primary` 即「该平台的命令键」：mac 为 meta，其余为 ctrl。
       */
      const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const plain = primary && !event.altKey;

      // 复制选中文本（Ctrl+C / Cmd+C：有选中复制，无选中放行为 SIGINT）
      if (plain && !event.shiftKey && (event.key === 'c' || event.key === 'C')) {
        const selection = handle.terminal.getSelection();
        if (selection) {
          navigator.clipboard?.writeText(selection).catch(() => {});
          // 复制后清除选中：下一次 Ctrl+C 即为 SIGINT（退出）
          handle.terminal.clearSelection();
          event.preventDefault();
          return false;
        }
        // 无选中：Ctrl+C 是 SIGINT，放行给 xterm 送进 PTY
        return true;
      }

      // 粘贴剪贴板（文本 / 图片 / 文件）：Ctrl+V / Cmd+V
      if (plain && !event.shiftKey && (event.key === 'v' || event.key === 'V')) {
        void pasteIntoTerminal(pane.paneId);
        event.preventDefault();
        return false;
      }

      // Ctrl+Shift+V 不再作为粘贴：显式拦截，避免 xterm 默认仍把它当粘贴
      if (plain && event.shiftKey && (event.key === 'v' || event.key === 'V')) {
        event.preventDefault();
        return false;
      }

      // 打开搜索：mac 为 Cmd+F，其余为 Ctrl+F
      if (plain && !event.shiftKey && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        setSearchOpen(true);
        return false;
      }

      return true;
    });

    /*
     * 挂载时一次性回放历史缓冲（非响应式读取，之后不再全量重放）。
     *
     * 回放期间闭住 toPty：缓冲里含有旧会话发出的终端能力查询，新终端实例
     * 会逐条重新作答，若放行就会写进刚创建、还没进 raw 模式的 PTY 并被
     * 行规程回显成乱码（详见 toPty 注释）。
     *
     * 不能用同步标志界定这个窗口——xterm 的解析是分片异步的，必须等
     * write 的解析完成回调。
     */
    const history = useTerminalStore.getState().getBuffer(pane.paneId);
    if (history) {
      replaying = true;
      handle.write(history, () => {
        replaying = false;
      });
    }

    // 注册到总线：此后 PTY 数据直接写入，不触发 React 渲染
    terminalBus.register(pane.paneId, handle.write);

    const dataSub = handle.terminal.onData((data) => {
      toPty(data);
    });

    /*
     * 尺寸同步。
     *
     * 首次 fit 必须**主动上报**：TUI（opencode/claude 等）按 PTY 尺寸排版，
     * 若 PTY 停留在 spawn 默认值，内容会画到可视区外。
     * onResize 只覆盖后续变化，首帧由 fitAndSync 保证。
     */
    // 记录上次尺寸，避免 resize 抖动时重复发送相同值
    let lastSize: { cols: number; rows: number } | null = null;
    let lateRaf = 0;
    let spawnRequested = false;

    const syncSize = () => {
      handle.fitAndSync((cols, rows) => {
        if (lastSize && lastSize.cols === cols && lastSize.rows === rows) return;
        lastSize = { cols, rows };
        resizeTerminal(pane.paneId, cols, rows);
        /*
         * 首次拿到精确尺寸后，才真正启动 PTY。
         *
         * 这样 TUI（opencode/claude 等）从一开始就按正确尺寸排版，
         * 不会出现「先按错误尺寸绘制、再被 resize 打断」的错位。
         * 只触发一次，后续尺寸变化走普通 resize。
         */
        if (!spawnRequested) {
          spawnRequested = true;
          attachPane(pane.paneId);
        }
      });
    };

    // 先在下一帧同步一次，确保容器已完成布局
    const initialRaf = requestAnimationFrame(() => {
      syncSize();
      // 布局稳定后再补一次，覆盖 WebGL 初始化导致的尺寸微调
      lateRaf = requestAnimationFrame(syncSize);
    });

    const resizeSub = handle.terminal.onResize(({ cols, rows }) => {
      if (lastSize && lastSize.cols === cols && lastSize.rows === rows) return;
      lastSize = { cols, rows };
      resizeTerminal(pane.paneId, cols, rows);
    });

    // 尺寸变化用 rAF 节流，避免 ResizeObserver 高频回调导致反复 fit
    let rafId = 0;
    const observer = new ResizeObserver(() => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncSize();
      });
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(initialRaf);
      if (lateRaf) cancelAnimationFrame(lateRaf);
      if (rafId) cancelAnimationFrame(rafId);
      container.removeEventListener('paste', onNativePaste, true);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('drop', onDrop);
      observer.disconnect();
      terminalBus.unregister(pane.paneId);
      dataSub.dispose();
      resizeSub.dispose();
      resultsSub.dispose();
      handle.dispose();
      handleRef.current = null;
    };
    /*
     * 仅在切换 pane、字号变化、运行状态翻转或强制重启时重建终端；
     * 主题通过下面的 effect 单独更新。
     *
     * restartSeq 必须在这里：运行中重启时 running 全程为 true，
     * 不加这一项 effect 不会重跑，attachPane 就永远等不到触发。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.paneId, fontSize, running, pane.restartSeq]);

  /*
   * 仅焦点变化（终端未重建）时，把键盘焦点交给对应终端。
   *
   * 新建/恢复/重启的终端重建场景由上面的创建 effect 里的 focus 处理；
   * 这里覆盖「侧栏点选已运行 agent」这类终端不重建、只有 focusedPaneId
   * 变化的情况。
   */
  useEffect(() => {
    if (pane.focused) handleRef.current?.terminal.focus();
  }, [pane.focused]);

  /*
   * 主题切换时同步终端配色。
   *
   * 必须等 <html data-theme> 更新、CSS 变量重算之后再读取变量值，
   * 否则会读到上一个主题的颜色。requestAnimationFrame 保证在样式重算后执行。
   *
   * 注意 applyTheme 内部会清空 WebGL 纹理图集——只改 options.theme
   * 不足以让 WebGL 渲染器换色（图集缓存了旧背景）。
   */
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const apply = () => handle.applyTheme(resolvedTheme);
    apply();

    const rafId = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(rafId);
  }, [resolvedTheme]);

  /*
   * 停止态（恢复出的 pane，进程未运行）不再显示「智能体已停止」整页提示：
   * 主区域直接呈现一个空终端，重启入口移到侧栏该 agent 行的按钮上。
   *
   * 这里**不能**改成自动拉起进程——重启哪些 agent 应由用户决定，
   * 否则每次打开应用都会同时启动 N 个 CLI agent。
   *
   * 之所以去掉整页提示后仍安全：恢复出的 pane 不在 Main 的 pendingSpawns 里，
   * 挂载时触发的 attachPane 会直接返回、不启动任何进程（见 router.attachPane）。
   * 真正的启动只发生在用户点「重新启动」后，那条路径会先把参数放回 pendingSpawns。
   */

  return (
    <div className="terminal-pane">
      {searchOpen && (
        <div className="terminal-search">
          <span className="terminal-search__icon" aria-hidden="true">
            <IconSearch size={14} />
          </span>
          <input
            className="terminal-search__input"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              runSearch('next', e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(e.shiftKey ? 'prev' : 'next', searchQuery);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder={t('pane.searchPlaceholder')}
            title={searchShortcutLabel}
            autoFocus
          />
          <span className="terminal-search__count">
            {searchMatch.count > 0 ? `${searchMatch.index + 1}/${searchMatch.count}` : '0/0'}
          </span>
          <button
            type="button"
            className="terminal-search__btn"
            onClick={() => runSearch('prev', searchQuery)}
            title={t('pane.searchPrev')}
            aria-label={t('pane.searchPrev')}
          >
            <IconChevronUp size={14} />
          </button>
          <button
            type="button"
            className="terminal-search__btn"
            onClick={() => runSearch('next', searchQuery)}
            title={t('pane.searchNext')}
            aria-label={t('pane.searchNext')}
          >
            <IconChevronDown size={14} />
          </button>
          <button
            type="button"
            className="terminal-search__btn"
            onClick={closeSearch}
            title={t('pane.searchClose')}
            aria-label={t('pane.searchClose')}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
      <div className="terminal-pane__padding">
        <div
          className="terminal-pane__body"
          ref={containerRef}
          /*
           * 点击终端正文即聚焦该 pane：分屏里用户往往直接点终端打字，
           * 不点标题栏，若不在这里补 focusPane，focusedPaneId 会停在旧 pane，
           * 侧栏选中态与 done/seen 判定都会错。
           */
          onClick={() => {
            if (!pane.focused) focusPane(pane.paneId);
          }}
        />
      </div>
    </div>
  );
}
