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
import { useTerminalStore, terminalBus } from '../stores/terminalStore';
import { useSettingsStore, useResolvedTheme } from '../stores/settingsStore';
import { writeTerminal, resizeTerminal, attachPane } from '../ipc/client';
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

interface TerminalPaneProps {
  pane: PaneState;
}

export function TerminalPane({ pane }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const resolvedTheme = useResolvedTheme();
  /*
   * 始终持有最新主题值，供「终端重建」的 effect 读取。
   *
   * 那个 effect 的依赖里不能出现 resolvedTheme（否则切主题会重建终端），
   * 但它又必须在重建后拿到**当前**主题，所以用 ref 传递。
   */
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
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
  };

  // 创建 / 销毁 xterm 实例
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handle = createTerminal(container, {
      fontSize,
      theme: resolvedTheme,
      /*
       * 主题颜色查询（仅 opencode）的响应回写到 PTY。
       *
       * 是否真正启用由 createTerminal 按 command 判定：只有 opencode 走
       * OSC 适配，其余 agent / 普通 shell 走标准路径，避免 OSC 序列被
       * 行编辑器当输入、在提示符后显示成乱码。
       */
      onQueryResponse: (data) => writeTerminal(pane.paneId, data),
      command: pane.command ?? null,
    });
    handleRef.current = handle;

    /*
     * 终端重建后补一次主题应用。
     *
     * 这里必须主动补：重建（换 pane、改字号、respawn）后新实例注册的是全新的
     * OSC handler，而已经跑起来的 opencode **不会**再发一次 `CSI ? 2031 h`，
     * 所以没有任何东西会去触发那次握手，主题就停在旧值上。
     *
     * 用 ref 取最新主题而非把 resolvedTheme 加进依赖：加进去会让切主题重建
     * 整个终端（丢滚动缓冲、重连 PTY），代价远大于收益。
     */
    handle.applyTheme(resolvedThemeRef.current);

    // 搜索匹配计数
    const resultsSub = handle.search.onDidChangeResults((e) => {
      setSearchMatch({ index: e.resultIndex, count: e.resultCount });
    });

    // 终端快捷键（拦截在 xterm 处理之前；随 terminal.dispose 一起销毁）
    handle.terminal.attachCustomKeyEventHandler((event) => {
      /*
       * 平台差异：
       * - macOS：终端复制/粘贴用 Cmd+C / Cmd+V（系统约定），
       *   且 Ctrl+C 必须原样送进 PTY（它是 SIGINT）。
       * - Windows / Linux：用 Ctrl+Shift+C / Ctrl+Shift+V，
       *   因为裸 Ctrl+C 同样是 SIGINT，不能占用。
       *
       * `primary` 即「该平台的命令键」：mac 为 meta，其余为 ctrl。
       */
      const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const plain = primary && !event.altKey;
      // mac 上 Cmd+Shift+C/V 也一并接受，容错用户习惯
      const shiftOk = isMac ? true : event.shiftKey;

      // 复制选中文本
      if (plain && shiftOk && (event.key === 'c' || event.key === 'C')) {
        const selection = handle.terminal.getSelection();
        if (selection) {
          navigator.clipboard?.writeText(selection).catch(() => {});
          event.preventDefault();
          return false;
        }
        // 无选中时放行：mac 上 Cmd+C 无选中应无副作用，Windows 上 Ctrl+Shift+C 亦然
        return true;
      }

      // 粘贴剪贴板
      if (plain && shiftOk && (event.key === 'v' || event.key === 'V')) {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) writeTerminal(pane.paneId, text);
          })
          .catch(() => {});
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

    // 挂载时一次性回放历史缓冲（非响应式读取，之后不再全量重放）
    const history = useTerminalStore.getState().getBuffer(pane.paneId);
    if (history) {
      handle.write(history);
    }

    // 注册到总线：此后 PTY 数据直接写入，不触发 React 渲染
    terminalBus.register(pane.paneId, handle.write);

    const dataSub = handle.terminal.onData((data) => {
      writeTerminal(pane.paneId, data);
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
   * command 后到时补挂 OSC 主题查询 handler。
   *
   * 创建 xterm 的那次 effect 只依赖 [pane.paneId, fontSize, running, restartSeq]，
   * 刻意不含 pane.command —— 把 command 加进去会在快照刷新时重建整个终端
   * （丢滚动缓冲、重连 PTY）。但 createTerminal 需要 command 才能判断是否
   * 启用 OSC 适配，而挂载那一刻 command 未必已经到达：Renderer 按 SessionState
   * 快照投影，布局里先出现 pane、随后快照才带上 command 是可能的，
   * 旧版 session.json 恢复出的 pane 更是直接缺这个字段。
   *
   * 漏判的后果是永久性的：该 pane 不注册 handler、applyTheme 也不再推送 997，
   * 表现为"分屏下有的 opencode 跟得上主题、有的永远停在启动时的配色"。
   *
   * 所以这里单独补一条轻量 effect：command 变化时把它交给 handle，
   * 由 handle 决定是否需要补挂 handler 并补一次主题协商（不重建终端）。
   */
  useEffect(() => {
    handleRef.current?.setCommand(pane.command ?? null);
  }, [pane.command, pane.paneId]);

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
        <div className="terminal-pane__body" ref={containerRef} />
      </div>
    </div>
  );
}
