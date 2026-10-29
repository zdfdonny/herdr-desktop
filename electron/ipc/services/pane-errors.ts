/**
 * 服务层向渲染端报错的窄接口。
 *
 * `pushError` 的实现留在 router（它要 `broadcast`），但各服务都要能报错，
 * 所以只声明形状、由 router 注入 —— 服务不必认识 `IpcRouter` 整体。
 */
export interface PaneErrorSink {
  /**
   * 推一条错误到渲染端。
   *
   * @param titleKey 标题文案的 i18n key
   * @param titleVars 标题里的占位变量
   * @param extra 详情文案 key 与关联的 pane / project
   */
  pushError(
    titleKey: string,
    titleVars?: Record<string, string | number>,
    extra?: { messageKey?: string; paneId?: string; projectId?: string },
  ): void;
}
