/**
 * IPC 协议常量 —— 与 shared/protocol.ts 对应。
 * 集中定义消息 type 字符串，避免魔法字符串散布。
 */

export const IPC = {
  // 结构状态（Main → Renderer）
  STATE_SNAPSHOT: 'state:snapshot',
  STATE_PATCH: 'state:patch',
  STATE_SETTINGS: 'state:settings',
  // 终端数据（Main → Renderer）
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  // 应用信息
  APP_INFO: 'app:info',
  APP_ERROR: 'app:error',
  /** agent 状态变化通知（blocked / done）。 */
  AGENT_STATUS: 'agent:status',
  AGENT_AVAILABILITY: 'agent:availability',
  /** 菜单/快捷键请求新建 agent（Ctrl+T）。 */
  NEW_AGENT: 'ui:new-agent',
  // 控制命令（Renderer → Main）
  ADD_PROJECT: 'control:add-project',
  REMOVE_PROJECT: 'control:remove-project',
  TOGGLE_PROJECT: 'control:toggle-project',
  SPAWN_AGENT: 'control:spawn-agent',
  ATTACH_PANE: 'control:attach-pane',
  /** 重启一个恢复出的（已停止的）pane：走与 spawn 相同的两阶段流程。 */
  RESPAWN_PANE: 'control:respawn-pane',
  CLOSE_PANE: 'control:close-pane',
  FOCUS_PANE: 'control:focus-pane',
  SET_THEME: 'control:set-theme',
  /** 同步原生标题栏叠加层配色（Windows titleBarOverlay 无法用 CSS 控制）。 */
  SET_TITLEBAR_THEME: 'control:set-titlebar-theme',
  SET_LANGUAGE: 'control:set-language',
  SET_FONT_SIZE: 'control:set-font-size',
  SET_SIDEBAR: 'control:set-sidebar',
  /** 设置代理地址（启动 agent 时注入）。 */
  SET_PROXY_URL: 'control:set-proxy-url',
  /** 按启动命令开启/关闭代理注入。 */
  SET_AGENT_PROXY: 'control:set-agent-proxy',
  NAMED: 'control:named',
} as const;

export type IpcType = (typeof IPC)[keyof typeof IPC];
