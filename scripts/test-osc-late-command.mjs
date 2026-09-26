/*
 * 验证 OSC 主题适配的门控状态机、命令判定，以及「997 + OSC 10/11」完整应答的
 * 字节格式。全部直接跑 src/xterm/terminal.ts 里的真实实现，而非另抄一份判定。
 *
 * 背景 bug：分屏下切换主题，有的 opencode pane 跟得上、有的永远停在启动时的
 * 配色。根因有两个，这里各测一处：
 *  1. 门控在创建时被固化成常量 —— createOscGate 保证判定每次现算；
 *  2. 997 与两条颜色应答分属不同 PTY 写 —— buildThemeResponse 保证拼成一条。
 */
import {
  createOscGate,
  isOscThemeCommand,
  buildThemeResponse,
  OSC_COLOR_PUSH_RETRY_DELAYS,
} from '../.tmp-terminal.mjs';

let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}`);
  }
}

console.log('isOscThemeCommand 判定（取第一个 token，不走词边界搜索）:');
check('opencode → true', isOscThemeCommand('opencode') === true);
check('路径形式 → true', isOscThemeCommand('/usr/local/bin/opencode') === true);
check('Windows 垫片 → true', isOscThemeCommand('opencode.cmd') === true);
check('带参数 → true', isOscThemeCommand('opencode --model x') === true);
check('大小写不敏感 → true', isOscThemeCommand('OpenCode') === true);
check('null → false', isOscThemeCommand(null) === false);
check('undefined → false', isOscThemeCommand(undefined) === false);
check('claude → false', isOscThemeCommand('claude') === false);
check('echo opencode（参数含）→ false', isOscThemeCommand('echo opencode') === false);
check('vim ~/opencode.md → false', isOscThemeCommand('vim ~/opencode.md') === false);
check('less opencode.log → false', isOscThemeCommand('less opencode.log') === false);

console.log('\ncreateOscGate 门控（判定必须每次现算）:');
{
  const gate = createOscGate(null);
  check('创建时缺 command → 未启用', gate.enabled() === false);
  check('初始未挂载', gate.registered() === false);
  const { gained } = gate.setCommand('opencode');
  check('command 后到 → 跃迁', gained === true);
  check('此后已启用', gate.enabled() === true);
  check('markRegistered 首次 true', gate.markRegistered() === true);
  check('markRegistered 幂等', gate.markRegistered() === false);
  const again = gate.setCommand('opencode');
  check('重复 setCommand 不跃迁', again.gained === false);
}

{
  const gate = createOscGate('opencode');
  check('创建时即启用', gate.enabled() === true);
  check('markRegistered 首次 true', gate.markRegistered() === true);
}

{
  const gate = createOscGate(null);
  check('后到 claude 不跃迁', gate.setCommand('claude').gained === false);
  check('claude 未启用', gate.enabled() === false);
  const up = gate.setCommand('opencode');
  check('随后升级为 opencode 能跃迁', up.gained === true);
}

{
  const gate = createOscGate('opencode');
  gate.markRegistered();
  check('已挂载后变 claude 不再跃迁', gate.setCommand('claude').gained === false);
  check('handler 保持挂载', gate.registered() === true);
}

{
  const gate = createOscGate(undefined);
  check('undefined 不启用', gate.enabled() === false);
  check('快照补上 command 后跃迁', gate.setCommand('opencode').gained === true);
}

console.log('\nbuildThemeResponse（997 + OSC 10/11 必须拼成一条）:');
{
  const dark = buildThemeResponse(1, '#cccccc', '#0d0d0d', false);
  check(
    '非 Windows 深色：997;1n + OSC10 + OSC11 顺序正确',
    dark ===
      '\x1b[?997;1n' +
        '\x1b]10;rgb:cccc/cccc/cccc\x07' +
        '\x1b]11;rgb:0d0d/0d0d/0d0d\x07',
  );

  const light = buildThemeResponse(2, '#3b3b3b', '#ffffff', true);
  check(
    'Windows 浅色：OSC 用 ESC NUL ] 绕过 ConPTY',
    light ===
      '\x1b[?997;2n' +
        '\x1b\x00]10;rgb:3b3b/3b3b/3b3b\x07' +
        '\x1b\x00]11;rgb:ffff/ffff/ffff\x07',
  );
  check('Windows 应答不含裸 ESC ]（避免被 ConPTY 吞掉）', !light.includes('\x1b]'));

  check('997 在最前', light.startsWith('\x1b[?997;2n'));
  check('一条应答内同时含 10 与 11', light.includes('10;rgb:') && light.includes('11;rgb:'));
}

console.log('\n颜色应答重试调度:');
check('至少两档延迟', OSC_COLOR_PUSH_RETRY_DELAYS.length >= 2);
check('延迟递增（后档更晚）', OSC_COLOR_PUSH_RETRY_DELAYS[1] > OSC_COLOR_PUSH_RETRY_DELAYS[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
