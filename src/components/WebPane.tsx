/**
 * WebPane —— DeepSeek Harness Web GUI 的内嵌 pane。
 *
 * 与 TerminalPane 的差异：这里没有终端，而是用 Electron 的 <webview> 加载
 * `dsh web` 服务地址。认证链接（带 token）由 Main 通过 `web:ready` 下发并缓存在
 * webStore，<webview> 作为顶层 guest 直接加载该链接即可完成 Cookie 换发。
 *
 * 每个 pane 使用独立的 session partition（`persist:dsh-<paneId>`）隔离 Cookie
 * 与 localStorage。新建 pane（partition 为空）时这里把 Main 下发的落地会话 id
 * 写进 localStorage，让 GUI 打开该会话；恢复/重启 pane 时 partition 已有用户
 * 之前的选择，则不覆盖，GUI 恢复该 pane 上次使用的会话。
 *
 * 注意：不要在这里做「卸载时搬移 webview」之类的 DOM reparent——Electron 对
 * <webview> 的 guest 生命周期绑定在元素连接上，reparent 会触发销毁重建导致重载。
 * 「切换标签不重载」由 Layout 保持所有视图挂载、仅切换 display 来保证（见 Layout）。
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PaneState } from '@shared/state';
import { useWebStore } from '../stores/webStore';
import { useT } from '../i18n';
import { bindDshSession } from '../ipc/client';

interface WebPaneProps {
  pane: PaneState;
}

/** DSH 前端持久化「当前会话」的 localStorage 键。 */
const SESSION_KEY = 'dsh.sessions.current';

/** Electron <webview> guest 宿主暴露的方法（DOM 类型里没有，运行时才有）。 */
type WebviewHost = HTMLWebViewElement & {
  executeJavaScript(code: string): Promise<unknown>;
  reload(): void;
};

/**
 * 安全地读 webview 里的 localStorage 当前会话。
 *
 * webview 未 attach / dom-ready 未触发时，`executeJavaScript` 会**同步抛异常**，
 * 必须在这里兜住，否则异常从 useEffect 里抛出会导致 React 树崩溃白屏。
 */
function readCurrentSession(webview: WebviewHost): Promise<string | null> {
  try {
    return webview
      .executeJavaScript(`localStorage.getItem(${JSON.stringify(SESSION_KEY)})`)
      .then((raw: unknown) => {
        if (typeof raw !== 'string') return null;
        try {
          const parsed = JSON.parse(raw) as { sessionId?: unknown };
          return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export function WebPane({ pane }: WebPaneProps) {
  const t = useT();
  const url = useWebStore((s) => s.urls[pane.paneId]);
  // 该 pane 应恢复的 DSH 会话 id（由 Main 从 dsh 插件路由解析后随 web:ready 下发）。
  const sessionId = useWebStore((s) => s.sessionIds[pane.paneId]);
  // 旧快照可能缺 running 字段，按运行中处理
  const running = pane.running ?? true;
  const webviewKey = `${pane.paneId}:${pane.restartSeq ?? 0}`;
  const webviewRef = useRef<HTMLWebViewElement | null>(null);
  /** webview 是否已触发 dom-ready（在此之前 executeJavaScript 不可用）。 */
  const domReadyRef = useRef(false);
  /** 上次上报的会话 id，用于去重。 */
  const lastReportedSessionRef = useRef<string | null>(null);

  /*
   * dom-ready 时把「本项目应落地的会话」写进该 pane partition 的 localStorage，
   * 让 dsh GUI 的 restoreSelection 恢复本项目，而不是落到全局「最近项目」。
   *
   * 只在 partition 为空（全新 pane）时才注入：一旦 partition 里已有选择（用户
   * 之前打开过某个会话），就绝不覆盖——这既避免 reload 循环，也避免运行中
   * 强制重启时，旧的 sessionId 在下一个 web:ready 到来前覆盖用户当前会话。
   */
  const handleDomReady = useCallback(() => {
    domReadyRef.current = true;
    const webview = webviewRef.current as WebviewHost | null;
    if (!webview || !sessionId) return;
    const expected = JSON.stringify({ sessionId });
    // dom-ready 后 executeJavaScript 通常安全，但 reload 等边界下仍可能同步抛，
    // 兜住以免从事件处理器外泄。
    let getPromise: Promise<unknown>;
    try {
      getPromise = webview.executeJavaScript(
        `localStorage.getItem(${JSON.stringify(SESSION_KEY)})`,
      );
    } catch {
      return;
    }
    void getPromise
      .then(async (current: unknown) => {
        // 已有选择（任意字符串）→ 保留用户自己的会话，不注入。
        if (typeof current === 'string') return;
        // 必须 await setItem 完成后再 reload，否则 reload 可能吞掉仍在途中的写入。
        await webview.executeJavaScript(
          `localStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(expected)});`,
        );
        webview.reload();
      })
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    webview.addEventListener('dom-ready', handleDomReady);
    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
      domReadyRef.current = false;
    };
  }, [handleDomReady, url, webviewKey]);

  /*
   * 会话绑定：轮询 webview 的「当前会话」，变化时上报 Main，用于把插件的
   * per-session 状态报告精确路由到该 pane（而不是按项目广播）。
   *
   * DSH 前端把当前会话存在 localStorage["dsh.sessions.current"]，切换会话时会更新；
   * 同文档内 localStorage 写不会触发 storage 事件，所以用轮询观察。
   * 只在 dom-ready 之后才读，避免未 attach 时 executeJavaScript 同步抛异常。
   */
  useEffect(() => {
    if (!url) return;
    const poll = () => {
      if (!domReadyRef.current) return;
      const el = webviewRef.current as WebviewHost | null;
      if (!el) return;
      void readCurrentSession(el).then((currentSessionId) => {
        if (currentSessionId !== lastReportedSessionRef.current) {
          lastReportedSessionRef.current = currentSessionId;
          bindDshSession(pane.paneId, currentSessionId);
        }
      });
    };

    const timer = setInterval(poll, 1500);
    return () => {
      clearInterval(timer);
      if (lastReportedSessionRef.current !== null) {
        lastReportedSessionRef.current = null;
        bindDshSession(pane.paneId, null);
      }
    };
  }, [url, webviewKey, pane.paneId]);

  /*
   * 停止态（恢复出的 pane，进程未运行）不再显示「智能体已停止」整页提示，
   * 重启入口移到侧栏该 agent 行的按钮上（与 TerminalPane 保持一致）。
   *
   * 这里同样不自动拉起进程——重启哪些 agent 应由用户决定。
   */
  if (!running) {
    return <div className="web-pane" />;
  }

  // 运行中但认证链接尚未就绪（dsh web 启动中）
  if (!url) {
    return (
      <div className="web-pane">
        <div className="web-pane__loading">{t('pane.webStarting')}</div>
      </div>
    );
  }

  /*
   * key 里带上 restartSeq：运行中「重新启动」时 running 全程为 true，认证链接
   * 也不会变——`dsh web` 是全 app 共享的单进程，重启单个 pane 不会重启服务端，
   * Main 下发的 URL 与之前完全一致。src 既然没有差异，React 就不会触发导航，
   * 点重启便会毫无反应。递增 restartSeq 强制重建 <webview>，新 guest 用同一个
   * （仍然有效的）认证链接重新加载页面——这就是 web pane 的「重启」语义。
   *
   * 与文件头「不要 reparent」的区别：这里是刻意的卸载重建（换一个全新 guest），
   * 不是把已连接的 webview 搬到别处。partition 是持久化的，登录态与 localStorage
   * 都会保留，GUI 仍会打开该 pane 最近使用的会话。
   */
  return (
    <div className="web-pane">
      <webview
        key={webviewKey}
        ref={webviewRef}
        src={url}
        partition={`persist:dsh-${pane.paneId}`}
        className="web-pane__webview"
      />
    </div>
  );
}
