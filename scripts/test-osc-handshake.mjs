/*
 * 验证 opencode 主题握手：终端在收到 `CSI ? 2031 h` 时，
 * 必须回 997 **并且**补推 OSC 10/11 两条颜色应答。
 *
 * 背景：Windows 上 ConPTY 会吞掉 opencode 自己发出的 `OSC 10;?` / `OSC 11;?`
 * 重查询，所以「只回 997、等 TUI 自己来问」这条路是死的——TUI 永远拿不到颜色，
 * opentui 的 themeOscForeground/themeOscBackground 保持 null，主题定格。
 *
 * 本测试用真实 xterm parser 跑一遍，断言三条序列都发出了。
 */
import xtermPkg from '@xterm/xterm';

const { Terminal } = xtermPkg;

const ESC = '\x1b';
const BEL = '\x07';

function hexToRgbColon(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 'rgb:0000/0000/0000';
  return `rgb:${m[1].repeat(2)}/${m[2].repeat(2)}/${m[3].repeat(2)}`;
}

function isDarkBackground(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return true;
  const [r, g, b] = [m[1], m[2], m[3]].map((c) => parseInt(c, 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.5;
}

/** 与 src/xterm/terminal.ts 的 registerThemeQueries 等价的注册逻辑。 */
function registerThemeQueries(terminal, respond, state) {
  terminal.parser.registerOscHandler(10, (data) => {
    if (data === '?' || data === '') {
      respond(`10;${hexToRgbColon(terminal.options.theme.foreground)}\x07`);
      return true;
    }
    return false;
  });
  terminal.parser.registerOscHandler(11, (data) => {
    if (data === '?' || data === '') {
      respond(`11;${hexToRgbColon(terminal.options.theme.background)}\x07`);
      return true;
    }
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.length === 1 && params[0] === 2031) {
      const bg = terminal.options.theme.background;
      const scheme = isDarkBackground(bg) ? 1 : 2;
      // 与实现一致：997 要记账，避免 applyTheme 重复推送
      if (scheme !== state.lastScheme) {
        state.lastScheme = scheme;
        respond(`${ESC}[?997;${scheme}n`);
      }
      terminal.write(`${ESC}]10;?${BEL}${ESC}]11;?${BEL}`);
      return true;
    }
    return false;
  });
}

async function run(label, fg, bg) {
  const term = new Terminal({ cols: 80, rows: 24 });
  const sent = [];
  const state = { lastScheme: isDarkBackground(bg) ? 1 : 2 };
  term.options.theme = { foreground: fg, background: bg };
  registerThemeQueries(term, (d) => sent.push(d), state);

  // TUI 启动时发 `CSI ? 2031 h`；write 是异步缓冲的，必须等解析真正跑完
  await new Promise((resolve) => term.write(`${ESC}[?2031h`, resolve));

  const joined = sent.join('');
  const expectedScheme = isDarkBackground(bg) ? 1 : 2;
  const startupSent = [...sent];
  const checks = [
    ['推 OSC 10 前景', /10;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}/.test(joined)],
    ['推 OSC 11 背景', /11;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}/.test(joined)],
    ['前景色正确', joined.includes(hexToRgbColon(fg))],
    ['背景色正确', joined.includes(hexToRgbColon(bg))],
  ];
  /*
   * 997 的推送是「方案变了才推」。lastScheme 初值即当前主题，因此
   * 启动握手时方案未变 → 不推 997，只补颜色应答。这正是记账生效的证据。
   */
  checks.push(['启动时方案未变则不推 997', !/997;/.test(joined)]);
  checks.push(['共 2 条序列（仅颜色）', sent.length === 2]);
  checks.push(['lastScheme 保持', state.lastScheme === expectedScheme]);

  // 主题翻转后再来一次握手：这次方案变了，必须推 997 + 颜色
  const flippedFg = bg;
  const flippedBg = fg;
  term.options.theme = { foreground: flippedFg, background: flippedBg };
  sent.length = 0;
  await new Promise((resolve) => term.write(`${ESC}[?2031h`, resolve));
  const joined2 = sent.join('');
  const flippedScheme = isDarkBackground(flippedBg) ? 1 : 2;
  checks.push([`翻转后推 997;${flippedScheme}`, joined2.includes(`997;${flippedScheme}n`)]);
  checks.push(['翻转后补前景', joined2.includes(hexToRgbColon(flippedFg))]);
  checks.push(['翻转后补背景', joined2.includes(hexToRgbColon(flippedBg))]);
  checks.push(['翻转后共 3 条序列', sent.length === 3]);

  let ok = true;
  for (const [label, pass] of checks) {
    if (!pass) ok = false;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  }
  console.log(`  → 启动握手: ${JSON.stringify(startupSent)}`);
  console.log(`  → 翻转握手: ${JSON.stringify(sent)}`);
  term.dispose();
  return ok;
}

let allOk = true;
console.log('深色主题 (#0d0d0d / #cccccc):');
allOk = (await run('dark', '#cccccc', '#0d0d0d')) && allOk;
console.log('浅色主题 (#ffffff / #18181b):');
allOk = (await run('light', '#18181b', '#ffffff')) && allOk;

console.log(allOk ? '\n全部通过' : '\n存在失败');
process.exit(allOk ? 0 : 1);
