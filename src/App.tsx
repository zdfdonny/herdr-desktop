/**
 * App —— 根组件。
 *
 * 挂载时：
 * 1. 订阅 Main → Renderer 消息（结构快照 / 终端数据 / 设置 / 错误）。
 * 2. 监听系统外观变化，用于 system 主题模式。
 * 3. 探测本机 agent 命令可用性。
 */

import { useEffect, useRef } from 'react';
import { onMessage, getSettings, pickDirectory, addProject, setIntegrationsOnboarded } from './ipc/client';
import { useSessionStore } from './stores/sessionStore';
import { useTerminalStore, terminalBus } from './stores/terminalStore';
import { useSettingsStore, applyThemeToDom } from './stores/settingsStore';
import { useNotificationStore } from './stores/notificationStore';
import { useAgentsStore } from './stores/agentsStore';
import { useUiStore } from './stores/uiStore';
import { useLayoutStore } from './stores/layoutStore';
import { useWebStore } from './stores/webStore';
import { t } from './i18n';
import { playNotificationSound } from './sound';
import { Layout } from './components/Layout';
import { dispatchShortcut, matchShortcut } from './shortcuts';

export default function App() {
  const setState = useSessionStore((s) => s.setState);
  const appendTerminal = useTerminalStore((s) => s.append);
  const applySettings = useSettingsStore((s) => s.applySettings);
  const setSystemPrefersDark = useSettingsStore((s) => s.setSystemPrefersDark);

  useEffect(() => {
    const unsubscribe = onMessage((message) => {
      switch (message.type) {
        case 'state:snapshot':
          setState(message.payload);
          /*
           * 同步分屏布局树：在 React 重渲染前完成 reconcile，
           * 避免「pane 已加入但树还没建好」的一帧闪烁。
           * 快照在终端每次输出时都会推来，reconcile 内部按 pane 集合签名短路。
           *
           * 传**全部** panes（含停止态）：停止态 pane 的分屏位置也要保留，
           * 否则应用重启后所有 pane 都是停止态，布局会被当成「已消失」剪掉，
           * 用户重启智能体时只能拿到全新单格视图，分屏就丢了。
           */
          useLayoutStore
            .getState()
            .reconcile(message.payload.panes, message.payload.focusedPaneId);
          // 剪除已关闭 pane 的认证链接缓存
          useWebStore
            .getState()
            .prune(message.payload.panes.map((p) => p.paneId));
          break;
        case 'web:ready':
          useWebStore.getState().setUrl(message.payload.paneId, message.payload.url);
          break;
        case 'state:settings':
          applySettings(message.payload);
          break;
        case 'state:patch':
          break;
        case 'pty:data':
          /*
           * 高频路径：先写入活跃终端（terminalBus 直接调用 xterm.write，
           * 不触发 React 渲染），再追加到回放缓冲（非响应式）。
           */
          terminalBus.emit(message.payload.paneId, message.payload.data);
          appendTerminal(message.payload.paneId, message.payload.data);
          break;
        case 'pty:exit':
          useTerminalStore.getState().reset(message.payload.paneId);
          break;
        case 'app:error':
          useNotificationStore.getState().push({
            kind: 'error',
            titleKey: message.payload.titleKey,
            titleVars: message.payload.titleVars,
            detailKey: message.payload.detailKey,
            detailVars: message.payload.detailVars,
          });
          break;
        case 'agent:status': {
          const { status, label } = message.payload;
          const settings = useSettingsStore.getState().settings;
          const titleKey = status === 'blocked' ? 'agent.notifyBlocked' : 'agent.notifyDone';
          const titleVars = { name: label };
          // 声音（受「声音」开关控制）：blocked → request，done → done
          if (settings.soundEnabled) {
            playNotificationSound(status === 'blocked' ? 'request' : 'done');
          }
          // 通知（受「通知」开关控制）：应用内 toast；
          // blocked 且窗口未聚焦时，额外发系统通知（HTML5 Notification 由渲染端本地化）
          if (settings.toastEnabled) {
            useNotificationStore.getState().push({
              kind: 'info',
              titleKey,
              titleVars,
            });
            if (status === 'blocked' && !document.hasFocus()) {
              try {
                new Notification(t(titleKey, titleVars));
              } catch {
                /* 系统通知不可用时静默忽略 */
              }
            }
          }
          break;
        }
        case 'ui:open-settings':
          useUiStore.getState().openSettings();
          break;
        case 'ui:add-project': {
          // 菜单 File → Add Project：与侧栏「添加项目」走同一流程
          void pickDirectory(t('sidebar.addProject')).then((path) => {
            if (path) addProject(path);
          });
          break;
        }
        case 'ui:shortcut':
          dispatchShortcut(message.payload.action, message.payload.index);
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [setState, appendTerminal, applySettings]);

  const onboardedRef = useRef(false);

  // 首帧先用默认主题渲染，再拉取持久化设置
  useEffect(() => {
    applyThemeToDom(useSettingsStore.getState().settings.theme);
    void getSettings()
      .then((settings) => {
        applySettings(settings);
        // 首次启动：只弹出集成引导弹窗（只触发一次）
        if (!onboardedRef.current && settings.integrationsOnboarded !== true) {
          onboardedRef.current = true;
          useUiStore.getState().openIntegrationsOnboarding();
          setIntegrationsOnboarded(true);
        }
      })
      .catch(() => {
        /* 主进程尚未就绪时保持默认 */
      });
  }, [applySettings]);

  // 探测本机可用的 agent 命令
  useEffect(() => {
    void useAgentsStore.getState().refresh();
  }, []);

  // 跟随系统外观（system 模式）
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    setSystemPrefersDark(media.matches);
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [setSystemPrefersDark]);

  /*
   * 全局快捷键兜底：焦点在终端（xterm）里时，应用菜单 accelerator 在部分平台
   * 不触发；这里用 capture 阶段 keydown 拦截并分发，保证标签切换、分屏/聚焦窗格等
   * 都能在终端聚焦时生效。改键捕获期间跳过，避免与 ShortcutSettingRow 的捕获监听
   * 互相干扰。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useUiStore.getState().shortcutCapturing) return;
      const overrides = useSettingsStore.getState().settings.shortcuts;
      const match = matchShortcut(e, overrides);
      if (!match) return;
      e.preventDefault();
      e.stopPropagation();
      dispatchShortcut(match.action, match.index);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return <Layout />;
}
