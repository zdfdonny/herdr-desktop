/**
 * 主进程的宿主环境。
 *
 * descriptor 里的路径/命令解析都接收 `HostEnv` 而不是直接读 `process.env`，
 * 这样跨平台规则可以在测试里用任意环境断言。主进程只有这一处把真实进程环境
 * 注入进去。
 */

import { homedir } from 'node:os';
import type { HostEnv } from '../../shared/agents/spec/host';

/** 构造当前进程的宿主环境。 */
export function hostEnv(): HostEnv {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
  };
}
