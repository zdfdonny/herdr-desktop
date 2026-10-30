/**
 * test:json-hooks-installer 的打包入口。
 *
 * 这个类不 import 任何 fs / 平台模块（IO 全部注入），所以能直接打包，
 * 不需要 Vite 的 `?raw` 插件。
 */
export { JsonHooksInstaller } from '../electron/agents/installers/json-hooks-installer';
export { GrokInstaller } from '../electron/agents/installers/grok-installer';
export { AntigravityInstaller } from '../electron/agents/installers/antigravity-installer';
export {
  DshInstaller,
  dshPatchBlock,
  dshPatchBlockIsValid,
  upsertDshPatch,
  removeDshPatchBlock,
  removeDshPatchBlockFrom,
} from '../electron/agents/installers/dsh-installer';
export { KimiInstaller } from '../electron/agents/installers/kimi-installer';
export { HermesInstaller } from '../electron/agents/installers/hermes-installer';
export {
  ensureHooksObject,
  hooksObjectIfPresent,
  ensureHook,
  removeHook,
} from '../electron/agents/installers/kit';
