/**
 * i18n 文案表的 Renderer 侧入口。
 *
 * 文案本身已上移到 `shared/i18n.ts`：菜单（Main 进程）与界面（Renderer）
 * 共用同一份文案，保证语言切换时两边的文案一致。这里只做 re-export，
 * 保持既有导入路径（`../i18n/messages`）不变。
 */

export * from '@shared/i18n';
