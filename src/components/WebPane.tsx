/**
 * WebPane —— DeepSeek Harness Web GUI 的内嵌 pane。
 *
 * 与 TerminalPane 的差异：这里没有终端，而是用 Electron 的 <webview> 加载
 * `dsh web` 服务地址。认证链接（带 token）由 Main 通过 `web:ready` 下发并缓存在
 * webStore，<webview> 作为顶层 guest 直接加载该链接即可完成 Cookie 换发。
 *
 * 每个 pane 使用独立的 session partition（`dsh-<paneId>`）隔离 Cookie，
 * 避免多个 DSH 实例在同一回环主机上的 Cookie 互相覆盖。
 *
 * 注意：不要在这里做「卸载时搬移 webview」之类的 DOM reparent——Electron 对
 * <webview> 的 guest 生命周期绑定在元素连接上，reparent 会触发销毁重建导致重载。
 * 「切换标签不重载」由 Layout 保持所有视图挂载、仅切换 display 来保证（见 Layout）。
 */

import type { PaneState } from '@shared/state';
import { useWebStore } from '../stores/webStore';
import { respawnPane } from '../ipc/client';
import { useT } from '../i18n';
import { IconPlay } from './icons';

interface WebPaneProps {
  pane: PaneState;
}

export function WebPane({ pane }: WebPaneProps) {
  const t = useT();
  const url = useWebStore((s) => s.urls[pane.paneId]);
  // 旧快照可能缺 running 字段，按运行中处理
  const running = pane.running ?? true;

  // 停止态：与 TerminalPane 保持一致的「重新启动」提示
  if (!running) {
    return (
      <div className="terminal-pane">
        <div className="empty-state">
          <div className="empty-state__logo empty-state__logo--icon" aria-hidden="true">
            <IconPlay size={22} />
          </div>
          <h1 className="empty-state__title">{t('pane.stoppedTitle')}</h1>
          <p className="empty-state__hint">{t('pane.stoppedHint')}</p>
          <div className="empty-state__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => respawnPane(pane.paneId)}
            >
              {t('pane.restart')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 运行中但认证链接尚未就绪（dsh web 启动中）
  if (!url) {
    return (
      <div className="web-pane">
        <div className="web-pane__loading">{t('pane.webStarting')}</div>
      </div>
    );
  }

  return (
    <div className="web-pane">
      <webview src={url} partition={`dsh-${pane.paneId}`} className="web-pane__webview" />
    </div>
  );
}
