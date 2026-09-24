/**
 * 轻量 git 元数据读取 —— 仅用于侧栏展示项目当前分支。
 *
 * 失败（不是 git 仓库 / git 未安装 / 超时）一律返回 null，
 * 不抛异常、不阻塞项目添加流程。
 */

import { execFile } from 'node:child_process';

const TIMEOUT_MS = 2500;

/** 读取指定目录的当前 git 分支名；无法确定时返回 null。 */
export function detectGitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', cwd, 'branch', '--show-current'],
        { timeout: TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const branch = stdout.trim();
          resolve(branch.length > 0 ? branch : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}
