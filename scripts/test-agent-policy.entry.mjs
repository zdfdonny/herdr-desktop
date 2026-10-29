/**
 * test:agent-policy 的打包入口。
 *
 * 把共享层的智能体注册表与检测谓词打成一个 bundle，供
 * `scripts/test-agent-policy.mjs` 通过 `.tmp/agent-policy.mjs` 引用。
 */
export { AGENT_IDS, isAgentId } from '../shared/agents/agent-id';
export {
  agentById,
  agentIdForAlias,
  allAgents,
  detectableAgents,
  integrableAgents,
  resolveWebAgent,
  resumableAgents,
  resolveAgentId,
  webAgents,
} from '../shared/agents/registry';
export {
  detectAgentName,
  fullLifecycleHookAuthority,
  parseAgentLabel,
  screenCompletionIgnored,
  screenStartupIgnored,
  sessionIdentityOnlyIntegration,
} from '../shared/detect/facade';
