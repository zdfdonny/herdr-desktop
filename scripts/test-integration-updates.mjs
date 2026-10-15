/**
 * 集成待更新数量判据（countIntegrationUpdates / installableAgentIds）验证脚本。
 *
 * 覆盖的核心场景是「有集成更新时侧栏显示待更新数量，直到所有更新完成才消失」：
 * - 只有「本机可用且 outdated」算更新；not-installed（首次安装）、unsupported、
 *   installed 都不计数；
 * - 数量就是「可用且 outdated」的个数，更新完一个就减一；
 * - 全部更新完成后数量归零（更新失败的智能体仍是 outdated → 数量不减）；
 * - 本机不可用的 outdated 不计数：它在集成页里只显示「未找到」、没有任何按钮，
 *   算进来会让徽标永远清不掉；
 * - 一键安装只针对本机可用（已安装）的智能体，未安装的不碰。
 *
 * 做法与其它 test:* 一致：先用 esbuild 把被测模块打成 ESM，再 import 真实实现
 * （而非复制逻辑），避免测试与实现漂移。
 *
 * 用法: npm run test:integrations
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp-integration-updates.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp-integration-updates.mjs — run: npm run test:integrations');
  process.exit(2);
}
const { countIntegrationUpdates, installableAgentIds } = await import(pathToFileURL(bundlePath).href);

/** 本机全部可用（等价于「可用性探测未完成」时 isAvailable 的行为）。 */
const allAvailable = () => true;

const results = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
  );
}

// ---- 数量判据：哪些状态算「有更新」 ----

check('尚未拉取到状态（空表）数量为 0', countIntegrationUpdates({}, allAvailable), 0);
check(
  '全部已集成数量为 0',
  countIntegrationUpdates({ claude: 'installed', codex: 'installed' }, allAvailable),
  0,
);
check(
  '未安装（首次安装）不计数',
  countIntegrationUpdates({ claude: 'not-installed', codex: 'not-installed' }, allAvailable),
  0,
);
check(
  '官方不支持不计数',
  countIntegrationUpdates({ claude: 'unsupported', codex: 'unsupported' }, allAvailable),
  0,
);
check(
  '单个 outdated 计数为 1',
  countIntegrationUpdates({ claude: 'installed', codex: 'outdated' }, allAvailable),
  1,
);
check(
  '已集成 + 未安装 + 不支持混合，无 outdated 时为 0',
  countIntegrationUpdates(
    {
      claude: 'installed',
      codex: 'not-installed',
      gemini: 'unsupported',
    },
    allAvailable,
  ),
  0,
);

// ---- 数量随更新进度递减 / 归零 ----

/** 真实形态：多数已集成，claude 与 opencode 版本旧。 */
const withUpdates = {
  claude: 'outdated',
  codex: 'installed',
  opencode: 'outdated',
  gemini: 'not-installed',
  maki: 'unsupported',
};
check('多个 outdated 按个数计数', countIntegrationUpdates(withUpdates, allAvailable), 2);

/** 只更新完其中一个（另一个失败）→ 数字必须减一且仍大于 0。 */
check(
  '部分更新完成后数量递减',
  countIntegrationUpdates({ ...withUpdates, claude: 'installed' }, allAvailable),
  1,
);

/** 所有 outdated 都装完 → 数量归零，徽标消失（用户要求的「直到所有更新完成」）。 */
check(
  '所有更新完成后数量归零',
  countIntegrationUpdates(
    { ...withUpdates, claude: 'installed', opencode: 'installed' },
    allAvailable,
  ),
  0,
);

/** 更新后仍未达标（主进程复核仍是旧版本）→ 数量不减。 */
check('更新未生效（仍是 outdated）数量不减', countIntegrationUpdates({ claude: 'outdated' }, allAvailable), 1);

// ---- 可用性判据：徽标数字必须等于集成页里能点的「更新」按钮个数 ----

/**
 * 装过集成、但该智能体已从本机消失（卸载 CLI / PATH 变化）：
 * Main 仍会报 outdated（只看 hook 文件里的版本标记），集成页那一行却只有
 * 「未找到」。这种条目必须不计数，否则徽标永远清不掉。
 */
check(
  '本机不可用的 outdated 不计数（否则徽标永远清不掉）',
  countIntegrationUpdates({ claude: 'outdated' }, () => false),
  0,
);
check(
  '多个 outdated 只统计本机可用的',
  countIntegrationUpdates({ claude: 'outdated', codex: 'outdated', opencode: 'outdated' }, (id) => id !== 'codex'),
  2,
);
check(
  '可用性判据对 installed / not-installed 无影响',
  countIntegrationUpdates({ claude: 'installed', codex: 'not-installed' }, () => false),
  0,
);
/** 未探测完成时谓词全为 true（isAvailable 未探测返回 true）→ 计数不延迟出现。 */
check(
  '可用性尚未探测时按可用计数，不延迟显示',
  countIntegrationUpdates({ claude: 'outdated', codex: 'outdated' }, allAvailable),
  2,
);
/** 徽标数字 == 集成页里「更新」按钮的个数（两者用同一判据）。 */
check(
  '徽标数字等于可更新的可用智能体数',
  countIntegrationUpdates(
    { claude: 'outdated', codex: 'installed', opencode: 'outdated', maki: 'unsupported' },
    (id) => id !== 'opencode',
  ),
  1,
);

// ---- 一键安装目标：只碰本机已安装的智能体 ----

const statuses = { claude: 'outdated', codex: 'not-installed', maki: 'unsupported' };
check(
  '只挑本机可用的智能体',
  installableAgentIds(statuses, (agentId) => agentId !== 'codex'),
  ['claude', 'maki'],
);
check('全部不可用时为空', installableAgentIds(statuses, () => false), []);
check('全部可用时保持状态表顺序', installableAgentIds(statuses, () => true), [
  'claude',
  'codex',
  'maki',
]);
check('空状态表返回空', installableAgentIds({}, () => true), []);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error(`failed: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
