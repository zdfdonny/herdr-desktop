/**
 * WebPane —— DeepSeek Harness Web GUI 的内嵌 pane。
 *
 * 与 TerminalPane 的差异：这里没有终端，而是用 Electron 的 <webview> 加载
 * `dsh web` 服务地址。认证链接（带 token）由 Main 通过 `web:ready` 下发并缓存在
 * webStore，<webview> 作为顶层 guest 直接加载该链接即可完成 Cookie 换发。
 *
 * 每个 pane 使用独立的 session partition（`persist:dsh-<paneId>`）隔离 Cookie
 * 与 localStorage。localStorage 持久化让 dsh GUI 在 pane 启动/恢复时能打开该
 * pane 最近打开过的会话；没有历史会话时 GUI 会在对应工作区新建。
 *
 * 注意：不要在这里做「卸载时搬移 webview」之类的 DOM reparent——Electron 对
 * <webview> 的 guest 生命周期绑定在元素连接上，reparent 会触发销毁重建导致重载。
 * 「切换标签不重载」由 Layout 保持所有视图挂载、仅切换 display 来保证（见 Layout）。
 */

import type { PaneState } from '@shared/state';
import { useWebStore } from '../stores/webStore';
import { useT } from '../i18n';

interface WebPaneProps {
  pane: PaneState;
}

export function WebPane({ pane }: WebPaneProps) {
  const t = useT();
  const url = useWebStore((s) => s.urls[pane.paneId]);
  // 旧快照可能缺 running 字段，按运行中处理
  const running = pane.running ?? true;

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
  const webviewKey = `${pane.paneId}:${pane.restartSeq ?? 0}`;

  return (
    <div className="web-pane">
      <webview
        key={webviewKey}
        src={url}
        partition={`persist:dsh-${pane.paneId}`}
        className="web-pane__webview"
      />
    </div>
  );
}
