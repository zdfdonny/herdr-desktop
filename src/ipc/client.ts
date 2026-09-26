/**
 * IPC 客户端 —— Renderer 侧对 preload 暴露 API 的类型化封装。
 */

import type {
  ControlMessage,
  MainToRendererMessage,
  HerdrDesktopApi,
  AppSettings,
  ProxyTestResult,
} from '@shared/protocol';
import type { ThemePreference, Language } from '@shared/state';

function api(): HerdrDesktopApi {
  const bridge = window.herdrDesktop;
  if (!bridge) {
    throw new Error('herdrDesktop preload API not available');
  }
  return bridge;
}

/** 发起控制命令。 */
export function sendControl(message: ControlMessage): void {
  api().sendControl(message);
}

/** 订阅 Main → Renderer 消息。 */
export function onMessage(callback: (message: MainToRendererMessage) => void): () => void {
  return api().onMessage(callback);
}

/** 打开系统目录选择对话框。 */
export function pickDirectory(title?: string): Promise<string | null> {
  return api().pickDirectory({ title });
}

/** 获取应用信息。 */
export function getAppInfo(): Promise<{ version: string; platform: string }> {
  return api().getAppInfo();
}

/** 获取当前设置。 */
export function getSettings(): Promise<AppSettings> {
  return api().getSettings();
}

/** 探测 agent 命令可用性。 */
export function getAgentAvailability(commands: string[]): Promise<Record<string, boolean>> {
  return api().getAgentAvailability(commands);
}

/** 检测代理地址是否可用。 */
export function testProxy(url: string): Promise<ProxyTestResult> {
  return api().testProxy(url);
}

/** 添加项目。 */
export function addProject(path: string, name?: string): void {
  sendControl({ type: 'control:add-project', version: 1, payload: { path, name } });
}

/** 移除项目（连带其下所有 agent）。 */
export function removeProject(projectId: string): void {
  sendControl({ type: 'control:remove-project', version: 1, payload: { projectId } });
}

/** 折叠/展开项目分组。 */
export function toggleProject(projectId: string, collapsed: boolean): void {
  sendControl({ type: 'control:toggle-project', version: 1, payload: { projectId, collapsed } });
}

/**
 * 在项目内创建 agent（两阶段创建的第一阶段）。
 *
 * 只创建 pane，不启动进程；终端挂载后会调用 attachPane 并用精确尺寸启动 PTY。
 * 这样避免了「先按估算尺寸启动、TUI 已绘制、再被 resize 打断」的首屏错位。
 */
export function spawnAgent(
  projectId: string,
  command: string,
  opts?: { args?: string[]; cwd?: string; label?: string },
): void {
  sendControl({
    type: 'control:spawn-agent',
    version: 1,
    payload: {
      projectId,
      command,
      args: opts?.args,
      cwd: opts?.cwd,
      label: opts?.label,
    },
  });
}

/** 在项目内创建 DeepSeek Harness Web agent（内嵌 Web GUI）。 */
export function spawnWebAgent(
  projectId: string,
  opts?: { label?: string },
): void {
  sendControl({
    type: 'control:spawn-web-agent',
    version: 1,
    payload: {
      projectId,
      label: opts?.label,
    },
  });
}

/** 关闭 pane。 */
export function closePane(paneId: string): void {
  sendControl({ type: 'control:close-pane', version: 1, payload: { paneId } });
}

/**
 * 通知主进程：pane 的终端已就绪，可以启动 PTY。
 *
 * 两阶段创建的第二阶段——此时终端已经量出精确尺寸并写入过 resize，
 * 主进程据此启动进程，保证 TUI 首帧排版正确。
 */
export function attachPane(paneId: string): void {
  sendControl({ type: 'control:attach-pane', version: 1, payload: { paneId } });
}

/**
 * 重启一个 pane。
 *
 * 主进程把 pane 记录的命令放回两阶段队列并标记 running，
 * 渲染端挂载终端后走与新建 agent 完全相同的 attach 流程。
 *
 * `force` 为 true 时用于**运行中**的 pane：主进程会先杀掉现有进程再拉起，
 * 该 agent 的当前会话与滚动缓冲会丢失——调用方必须先向用户确认。
 * 缺省时只恢复停止态的 pane（运行中则 no-op）。
 */
export function respawnPane(paneId: string, force = false): void {
  sendControl({ type: 'control:respawn-pane', version: 1, payload: { paneId, force } });
}

/** 聚焦 pane。 */
export function focusPane(paneId: string): void {
  sendControl({ type: 'control:focus-pane', version: 1, payload: { paneId } });
}

/** 设置主题偏好。 */
export function setTheme(theme: ThemePreference): void {
  sendControl({ type: 'control:set-theme', version: 1, payload: { theme } });
}

/** 设置界面语言。 */
export function setLanguage(language: Language): void {
  sendControl({ type: 'control:set-language', version: 1, payload: { language } });
}

/**
 * 同步原生标题栏配色。
 *
 * Windows 的 titleBarOverlay 颜色由主进程持有，CSS 无法控制，
 * 主题切换时需显式通知。
 */
export function setTitleBarTheme(color: string, symbolColor: string): void {
  sendControl({
    type: 'control:set-titlebar-theme',
    version: 1,
    payload: { color, symbolColor },
  });
}

/** 设置字号。 */
export function setFontSize(fontSize: number): void {
  sendControl({ type: 'control:set-font-size', version: 1, payload: { fontSize } });
}

/** 设置左侧栏折叠状态。 */
export function setSidebarCollapsed(collapsed: boolean): void {
  sendControl({ type: 'control:set-sidebar', version: 1, payload: { collapsed } });
}

/** 设置代理地址（启动 agent 时注入）。 */
export function setProxyUrl(url: string): void {
  sendControl({ type: 'control:set-proxy-url', version: 1, payload: { url } });
}

/** 按启动命令开启/关闭代理注入。 */
export function setAgentProxy(command: string, enabled: boolean): void {
  sendControl({ type: 'control:set-agent-proxy', version: 1, payload: { command, enabled } });
}

// store 内使用的别名，避免与同名 action 混淆
export {
  setTheme as sendSetTheme,
  setLanguage as sendSetLanguage,
  setFontSize as sendSetFontSize,
  setSidebarCollapsed as sendSetSidebar,
  setProxyUrl as sendSetProxyUrl,
  setAgentProxy as sendSetAgentProxy,
};

/** 写入终端。 */
export function writeTerminal(paneId: string, data: string): void {
  sendControl({
    type: 'control:named',
    version: 1,
    payload: { kind: 'pty:write', data: JSON.stringify({ paneId, data }) },
  });
}

/** 调整终端尺寸。 */
export function resizeTerminal(paneId: string, cols: number, rows: number): void {
  sendControl({
    type: 'control:named',
    version: 1,
    payload: { kind: 'pty:resize', data: JSON.stringify({ paneId, cols, rows }) },
  });
}
