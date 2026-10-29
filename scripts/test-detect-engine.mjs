/*
 * 检测引擎的 region 校验与空 gate 语义（附录 D #21 / #23 回归测试）。
 *
 * 这两条都是「出错时不报错」类缺陷：
 * - #21 写错 region 名 → 规则静默永不命中，用户只看到「状态一直不对」
 * - #23 忘写 matcher → 规则命中一切，状态被永久钉死
 *
 * 修复后：region 名在启动期校验并抛错；空 gate 一律不匹配。
 * 本测试同时锁住「codex 的私有 region 必须被正确识别」——它是 #21 修复时
 * 差点误伤的真实案例（校验要能拿到 descriptor 的 extraRegions）。
 */

import {
  evaluateManifest,
  isKnownRegion,
  validateManifestRegions,
  validateManifestRegionsAtStartup,
} from '../.tmp/detect-engine.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const input = (screen, oscTitle = '', oscProgress = '') => ({ screen, oscTitle, oscProgress });

console.log('— 1. isKnownRegion：内置名 —');
{
  for (const name of [
    'osc_title',
    'osc_progress',
    'whole_recent',
    'after_last_horizontal_rule',
    'prompt_box_body',
    'last_non_empty_above_prompt_box',
  ]) {
    check(`内置 region 被识别：${name}`, isKnownRegion(name) === true);
  }
  check('带参数形态被识别：bottom_non_empty_lines(3)',
    isKnownRegion('bottom_non_empty_lines(3)') === true);
  check('带参数形态被识别：top_non_empty_lines(2)',
    isKnownRegion('top_non_empty_lines(2)') === true);
  check('参数不是数字时不识别', isKnownRegion('bottom_non_empty_lines(x)') === false);
  check('拼错的名字不被识别', isKnownRegion('whole_recnet') === false);
  check('空串不被识别', isKnownRegion('') === false);
  check('前后空白会被 trim', isKnownRegion('  whole_recent  ') === true);
}

console.log('— 2. isKnownRegion：私有 region 需显式提供 —');
{
  const extra = { after_last_prompt_marker: () => '' };
  check('提供后识别私有 region',
    isKnownRegion('after_last_prompt_marker', extra) === true);
  check('未提供时不识别（避免静默通过）',
    isKnownRegion('after_last_prompt_marker') === false);
}

console.log('— 3. validateManifestRegions：写错 region 要抛错（#21）—');
{
  const ok = {
    id: 'demo',
    rules: [{ id: 'r1', state: 'idle', priority: 1, region: 'whole_recent', contains: ['x'] }],
  };
  let threw = false;
  try {
    validateManifestRegions(ok);
  } catch {
    threw = true;
  }
  check('合法 manifest 不抛错', threw === false);

  const bad = {
    id: 'demo',
    rules: [{ id: 'typo_rule', state: 'idle', priority: 1, region: 'whole_recnet', contains: ['x'] }],
  };
  let message = '';
  try {
    validateManifestRegions(bad);
  } catch (error) {
    message = error.message;
  }
  check('拼错 region 时抛错', message !== '');
  check('错误信息包含规则 id', message.includes('typo_rule'));
  check('错误信息包含错写的 region 名', message.includes('whole_recnet'));
  check('错误信息列出已知内置 region', message.includes('whole_recent'));

  // 私有 region 声明后应通过
  let okWithExtra = true;
  try {
    validateManifestRegions(
      {
        id: 'codex-like',
        rules: [
          { id: 'r', state: 'idle', priority: 1, region: 'after_last_prompt_marker', contains: ['x'] },
        ],
      },
      { after_last_prompt_marker: () => '' },
    );
  } catch {
    okWithExtra = false;
  }
  check('私有 region 声明后校验通过', okWithExtra === true);
}

console.log('— 4. 全部真实 manifest 校验通过（含 codex 私有 region）—');
{
  let threw = null;
  try {
    validateManifestRegionsAtStartup();
  } catch (error) {
    threw = error.message;
  }
  check(
    '启动期校验对全部 manifest 通过',
    threw === null,
    threw ? threw.split('\n')[0] : '',
  );
}

console.log('— 5. 空 gate 一律不匹配（#23）—');
{
  const manifest = (contains) => ({
    id: 'demo',
    rules: [
      contains === undefined
        ? { id: 'no_conditions', state: 'working', priority: 10, region: 'whole_recent' }
        : { id: 'with_conditions', state: 'working', priority: 10, region: 'whole_recent', contains },
    ],
  });

  // 忘写任何条件：原先会命中一切，现在应不匹配
  const empty = evaluateManifest(manifest(undefined), input('随便什么内容'), {});
  check(
    '无 matcher 的规则不命中任何屏幕',
    empty.state !== 'working' || empty.visibleWorking === false,
    `state=${empty.state}`,
  );

  // 有条件的规则正常命中
  const hit = evaluateManifest(manifest(['需要出现']), input('这里 需要出现 一下'), {});
  check('有 matcher 且命中时生效', hit.state === 'working');

  // 有条件的规则不命中时回落到 idle
  const miss = evaluateManifest(manifest(['需要出现']), input('完全无关'), {});
  check('有 matcher 未命中时不误判', miss.state !== 'working');
}

console.log('— 6. 空 all/any 数组也视为无条件 —');
{
  const manifest = {
    id: 'demo',
    rules: [
      { id: 'empty_all', state: 'blocked', priority: 5, region: 'whole_recent', all: [] },
    ],
  };
  const result = evaluateManifest(manifest, input('任意内容'), {});
  check('all: [] 不匹配', result.state !== 'blocked', `state=${result.state}`);
}

console.log('— 7. 正则缓存不改变语义（#22）—');
{
  /*
   * 缓存的正则会被反复复用。若编译器把 g/y 标志带进来，lastIndex 残留会让
   * 同一个正则第二次 test 时给出不同答案 —— 那才是「加了缓存反而不对」。
   * 这里用同一 manifest 连续求值，锁住结果稳定。
   */
  const manifest = {
    id: 'cache-demo',
    rules: [
      { id: 'r', state: 'working', priority: 1, region: 'whole_recent', regex: ['(?i)busy|working'] },
    ],
  };
  const repeated = [];
  for (let i = 0; i < 5; i += 1) {
    repeated.push(evaluateManifest(manifest, input('busy now'), {}).state);
  }
  check('同一正则反复求值结果稳定', repeated.every((s) => s === 'working'), repeated.join(','));

  // 不命中时也必须稳定
  const misses = [];
  for (let i = 0; i < 5; i += 1) {
    misses.push(evaluateManifest(manifest, input('idle here'), {}).state);
  }
  check('不命中时结果同样稳定', misses.every((s) => s !== 'working'), misses.join(','));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

