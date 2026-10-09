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
  /** 丢弃某 pane 的回放缓冲（强制重启时用，不带退出语义）。 */
  PTY_RESET: 'pty:reset',
  // 应用信息
  APP_INFO: 'app:info',
  APP_ERROR: 'app:error',
  /** agent 状态变化通知（blocked / done）。 */
  AGENT_STATUS: 'agent:status',
  AGENT_AVAILABILITY: 'agent:availability',
  /** 菜单请求打开设置弹窗。 */
  UI_OPEN_SETTINGS: 'ui:open-settings',
  /** 菜单请求添加项目（打开系统目录选择器）。 */
  UI_ADD_PROJECT: 'ui:add-project',
  /** 菜单触发的快捷键动作（action 见 shared/shortcuts.ts）。 */
  UI_SHORTCUT: 'ui:shortcut',
  /** DeepSeek Harness Web pane 就绪（带认证链接）。 */
  WEB_READY: 'web:ready',
  // 控制命令（Renderer → Main）
  ADD_PROJECT: 'control:add-project',
  REMOVE_PROJECT: 'control:remove-project',
  TOGGLE_PROJECT: 'control:toggle-project',
  SPAWN_AGENT: 'control:spawn-agent',
  /** 创建内嵌 DeepSeek Harness Web GUI 的 agent。 */
  SPAWN_WEB_AGENT: 'control:spawn-web-agent',
  ATTACH_PANE: 'control:attach-pane',
  /**
   * 重启 pane：走与 spawn 相同的两阶段流程。
   *
   * `force` 为 true 时用于**运行中**的 pane——先杀掉现有进程再拉起，
   * 会丢失该 agent 的当前会话与滚动缓冲，所以渲染端必须先弹确认框。
   * 为 false/缺省时只恢复停止态的 pane（运行中则 no-op）。
   */
  RESPAWN_PANE: 'control:respawn-pane',
  CLOSE_PANE: 'control:close-pane',
  FOCUS_PANE: 'control:focus-pane',
  SET_THEME: 'control:set-theme',
  /** 同步原生标题栏叠加层配色（Windows titleBarOverlay 无法用 CSS 控制）。 */
  SET_TITLEBAR_THEME: 'control:set-titlebar-theme',
  SET_LANGUAGE: 'control:set-language',
  SET_FONT_SIZE: 'control:set-font-size',
  /** 设置代理地址（启动 agent 时注入）。 */
  SET_PROXY_URL: 'control:set-proxy-url',
  /** 按启动命令开启/关闭代理注入。 */
  SET_AGENT_PROXY: 'control:set-agent-proxy',
  /** 标记集成引导已完成（首次启动引导弹窗关闭后置 true）。 */
  SET_INTEGRATIONS_ONBOARDED: 'control:set-integrations-onboarded',
  /** 声音开关。 */
  SET_SOUND_ENABLED: 'control:set-sound-enabled',
  /** 通知开关。 */
  SET_TOAST_ENABLED: 'control:set-toast-enabled',
  NAMED: 'control:named',
  /** 设置单个快捷键覆盖；accelerator 为 null 表示恢复默认。 */
  SET_SHORTCUT: 'control:set-shortcut',
  /** 清空所有快捷键覆盖。 */
  RESET_SHORTCUTS: 'control:reset-shortcuts',
  /** 进入改键捕获：主进程忽略菜单快捷键，让 keydown 到达渲染层。 */
  BEGIN_SHORTCUT_CAPTURE: 'control:begin-shortcut-capture',
  /** 结束改键捕获：恢复菜单快捷键并重建菜单。 */
  END_SHORTCUT_CAPTURE: 'control:end-shortcut-capture',
} as const;

export type IpcType = (typeof IPC)[keyof typeof IPC];
