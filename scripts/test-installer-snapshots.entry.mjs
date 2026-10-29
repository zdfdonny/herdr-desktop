/**
 * test:installer-snapshots 的打包入口。
 *
 * 只导出**纯配置改写函数**（不碰 fs、不依赖 `?raw` 资产）：
 * 这些是安装器里最容易写坏、也最难人工验证的部分 —— 它们直接改写用户
 * 的 settings.json / config.toml / config.yaml。
 *
 * 重构后这些工具已迁到 `electron/agents/installers/kit.ts`，
 * 各自智能体的格式函数（codex TOML / kimi 块 / grok 配置 / hermes YAML）
 * 随智能体迁移；这里按新位置导出。
 */
export {
  ensureHooksObject,
  hooksObjectIfPresent,
  hookMatches,
  ensureNestedHook,
  ensureFlatHook,
  ensureDirectHook,
  ensureSimpleHook,
  ensureHook,
  removeHook,
  hookCommand,
  commandFor,
} from '../electron/agents/installers/kit';
export { updateHermesEnabled } from '../electron/agents/installers/hermes-installer';
export { grokHookConfig } from '../electron/agents/installers/grok-installer';
export { codexConfigWithHook } from '../electron/agents/installers/codex-installer';
export { kimiConfigWithHook, removeKimiBlock, tomlString } from '../electron/agents/installers/kimi-installer';
