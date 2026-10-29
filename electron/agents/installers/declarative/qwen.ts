/**
 * qwen 的集成安装器装配。
 *
 * 这个智能体是**纯声明式**的：集成形态全部写在 descriptor 的 integration.hooks 里，
 * 这里只负责两件属于「实现层」的事：
 * 1. 把它的 hook 脚本资产（?raw 内联）交出去；
 * 2. 用通用装配函数构造安装器。
 *
 * 资产放在智能体自己的目录下（electron/agents/assets/qwen/），
 * 不再有一个集中的 assets.ts 需要按 id 查表。
 */

import { qwen } from '../../../../shared/agents/descriptors/qwen';
import { isWindows } from '../../../platform';
import type { IntegrationInstaller } from '../../installer';
import { declarativeInstaller } from '../declarative';
import sh from '../../assets/qwen/herdr-desktop-agent-session.sh?raw';
import ps1 from '../../assets/qwen/herdr-desktop-agent-session.ps1?raw';

/** 创建 qwen 的集成安装器。 */
export function createQwenTarget(): IntegrationInstaller {
  return declarativeInstaller(qwen, () => (isWindows ? ps1 : sh));
}
