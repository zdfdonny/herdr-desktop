/**
 * test:agent-runtime 的打包入口。
 *
 * 只导出 `electron/agents/registry.ts` 与共享注册表 —— 不引入
 * `integration/index.ts`：后者的资产用 Vite 的 `?raw` 导入，esbuild 无法解析。
 * 「19 个安装器都登记了」这件事由 `test:integration-version` 做静态断言。
 */
export { AGENT_IDS } from '../shared/agents/agent-id';
export {
  agentById,
  allAgents,
  integrableAgents,
} from '../shared/agents/registry';
export {
  agentRuntime,
  installerFor,
  installedRuntimeIds,
  registerInstaller,
} from '../electron/agents/registry';
