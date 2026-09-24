/**
 * App —— 根组件。
 *
 * 挂载时：
 * 1. 订阅 Main → Renderer 消息（结构快照 / 终端数据 / 设置 / 错误）。
 * 2. 监听系统外观变化，用于 system 主题模式。
 * 3. 探测本机 agent 命令可用性。
 */

import { useEffect } from 'react';
import { onMessage, getSettings } from './ipc/client';
import { useSessionStore } from './stores/sessionStore';
import { useTerminalStore, terminalBus } from './stores/terminalStore';
import { useSettingsStore, applyThemeToDom } from './stores/settingsStore';
import { useNotificationStore } from './stores/notificationStore';
import { useAgentsStore } from './stores/agentsStore';
import { useUiStore } from './stores/uiStore';
import { useLayoutStore } from './stores/layoutStore';
import { t } from './i18n';
import { Layout } from './components/Layout';

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
           */
          useLayoutStore
            .getState()
            .reconcile(
              message.payload.panes.filter((p) => p.running !== false),
              message.payload.focusedPaneId,
            );
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
          const titleKey = status === 'blocked' ? 'agent.notifyBlocked' : 'agent.notifyDone';
          const titleVars = { name: label };
          // 应用内 toast
          useNotificationStore.getState().push({
            kind: 'info',
            titleKey,
            titleVars,
          });
          // blocked 且窗口未聚焦时，额外发系统通知（HTML5 Notification 由渲染端本地化）
          if (status === 'blocked' && !document.hasFocus()) {
            try {
              new Notification(t(titleKey, titleVars));
            } catch {
              /* 系统通知不可用时静默忽略 */
            }
          }
          break;
        }
        case 'ui:new-agent': {
          // 新建 agent（菜单 File → New Agent Pane，Cmd/Ctrl+T）
          const state = useSessionStore.getState().state;
          const focusedPane = state.panes.find((p) => p.paneId === state.focusedPaneId);
          const projectId =
            focusedPane?.projectId ?? state.projects[0]?.projectId ?? null;
          if (projectId) {
            // 折叠侧栏时先展开，否则 ProjectGroup 未挂载、无法消费请求
            if (useSettingsStore.getState().settings.sidebarCollapsed) {
              useSettingsStore.getState().setSidebarCollapsed(false);
            }
            useUiStore.getState().requestOpenAgentPicker(projectId);
          }
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [setState, appendTerminal, applySettings]);

  // 首帧先用默认主题渲染，再拉取持久化设置
  useEffect(() => {
    applyThemeToDom(useSettingsStore.getState().settings.theme);
    void getSettings()
      .then(applySettings)
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

  return <Layout />;
}
