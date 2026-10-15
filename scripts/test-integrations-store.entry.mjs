/**
 * test:integrations-store 的打包入口。
 *
 * integrationsStore 的「一键安装」要读 useAgentsStore 的可用性探测结果，
 * 两个 store 必须打进同一个 bundle：分开打包会得到两份 zustand 实例，
 * 测试改的那份不是被测代码读的那份（isAvailable 永远读到空表）。
 */
export { useIntegrationsStore } from '../src/stores/integrationsStore';
export { AGENT_PRESETS, useAgentsStore } from '../src/stores/agentsStore';
export { useNotificationStore } from '../src/stores/notificationStore';
