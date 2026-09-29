/**
 * 生成 Herdr 应用图标（默认 512x512 PNG）：
 *
 * 不依赖任何图像库：手写最小 PNG 编码（zlib + CRC32）；
 * 形状用有符号距离场（SDF）算覆盖率，边缘抗锯齿不靠额外的库。
 *
 * 产物 `build/icon.png` 已被 electron-builder 的 win/mac/linux 三端 icon 引用，
 * 由 electron-builder 在打包时自动转换成 .ico / .icns / 各尺寸 PNG。
 *
 * 窗口内的品牌标记（src/components/icons.tsx 的 IconLogo）与本文件的几何一一对应，
 * 改这里时要同步改那边，否则顶栏标记会和桌面图标不一致。
 *
 * 用法：
 *   `npm run icon`                              生成 build/icon.png
 *   `node scripts/gen-icon.js --size 64 --out preview.png`   生成预览尺寸
 */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

// ---------- 设计参数（统一用 512 的设计坐标系，导出尺寸可任意缩放） ----------
const DESIGN = 512;
const MARGIN = 8;   // 圆角底四周留白
const RADIUS = 112; // 圆角半径（接近 macOS squircle 的观感）

/** 渐变底：135° 对角，蓝 → 紫 → 品红。三档亮度都远高于纯黑，深色背景下不发闷。 */
const GRADIENT = [
  { at: 0.0, rgb: [0x3b, 0x82, 0xf6] }, // #3b82f6
  { at: 0.5, rgb: [0x8b, 0x5c, 0xf6] }, // #8b5cf6
  { at: 1.0, rgb: [0xec, 0x48, 0x99] }, // #ec4899
];

const INK = [0xff, 0xff, 0xff]; // 前景统一纯白

/**
 * 提示符箭头（三角形）顶点。
 *
 * 圆角是「向外扩」出来的（见 sdRoundPolygon）：外扩 12 后顶点变成半径 12 的圆弧，
 * 实际轮廓比这三个点围出的三角形大一圈。
 * src/components/icons.tsx 的 IconLogo 用 stroke-width=24 + round join 复现同一形状，
 * 改这里要同步改那边。
 */
const ARROW = [
  [136, 170],
  [136, 342],
  [238, 256],
];
/** 箭头外扩半径；对应 SVG 侧的 stroke-width = 2 * 12 = 24 */
const ARROW_RADIUS = 12;

/** 光标下划线（圆角条）x0, y0, x1, y1 */
const BAR = [258, 294, 368, 334];
const BAR_RADIUS = 20;

// ---------- 形状：有符号距离场（<0 在内部） ----------
function sdRoundRect(x, y, x0, y0, x1, y1, r) {
  const dx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const dy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

/**
 * 凸多边形「外扩 r 并倒圆角」的距离场：到边界的最近距离减半径，负值在内部。
 *
 * 语义是**外扩**而非内缩：零等值线是距原多边形边界 r 的那条线 ——
 * 直边平行外移 r，顶点处补出半径 r 的圆弧（即多边形 ⊕ 半径 r 的圆盘）。
 * 这与 sdRoundRect 一致：圆角矩形的外框仍是 x0..x1 / y0..y1，尺寸不变。
 */
function sdRoundPolygon(x, y, verts, r) {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i, i++) {
    const [ax, ay] = verts[j];
    const [bx, by] = verts[i];
    const ex = bx - ax;
    const ey = by - ay;
    const wx = x - ax;
    const wy = y - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(wx - ex * t, wy - ey * t));
    // 射线法判内外
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return (inside ? -best : best) - r;
}

// ---------- 着色 ----------
/** 距离场 -> 覆盖率；h 为一个像素在设计坐标下的边长，决定抗锯齿过渡宽度 */
function cover(d, h) {
  return Math.max(0, Math.min(1, 0.5 - d / h));
}

function gradientAt(x, y) {
  // 沿 135° 方向投影，把 [MARGIN, DESIGN-MARGIN] 映射到 [0, 1]
  const t = Math.max(0, Math.min(1, (x + y - 2 * MARGIN) / (2 * (DESIGN - 2 * MARGIN))));
  for (let i = 1; i < GRADIENT.length; i++) {
    const a = GRADIENT[i - 1];
    const b = GRADIENT[i];
    if (t <= b.at || i === GRADIENT.length - 1) {
      const k = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at);
      const f = Math.max(0, Math.min(1, k));
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return GRADIENT[GRADIENT.length - 1].rgb;
}

/** 前景色按覆盖率叠加到已有的（非预乘）颜色上 */
function over(dst, src, sa) {
  const da = dst[3];
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return [0, 0, 0, 0];
  const w = (da * (1 - sa)) / outA;
  const f = sa / outA;
  return [src[0] * f + dst[0] * w, src[1] * f + dst[1] * w, src[2] * f + dst[2] * w, outA];
}

/** 单点采样，返回非预乘的 [r, g, b, a]（0..255 浮点） */
function shade(x, y, h) {
  let px = [0, 0, 0, 0];

  const bg = cover(sdRoundRect(x, y, MARGIN, MARGIN, DESIGN - MARGIN, DESIGN - MARGIN, RADIUS), h);
  if (bg > 0) {
    const g = gradientAt(x, y);
    px = [g[0], g[1], g[2], bg];
  }

  const arrow = cover(sdRoundPolygon(x, y, ARROW, ARROW_RADIUS), h);
  if (arrow > 0) px = over(px, INK, arrow);

  const bar = cover(sdRoundRect(x, y, BAR[0], BAR[1], BAR[2], BAR[3], BAR_RADIUS), h);
  if (bar > 0) px = over(px, INK, bar);

  return px;
}

// ---------- 逐像素渲染 ----------
function render(size, ss) {
  const raw = Buffer.alloc(size * (size * 4 + 1)); // 每行前一个 filter 字节
  const step = DESIGN / (size * ss); // 子样本在设计坐标下的间距
  const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      // 预乘累加：透明边缘不会渗出黑边
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < ss; sy++) {
        const dy = (y * ss + sy + 0.5) * step;
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x * ss + sx + 0.5) * step, dy, step);
          ar += c[0] * c[3];
          ag += c[1] * c[3];
          ab += c[2] * c[3];
          aa += c[3];
        }
      }
      const o = rowStart + 1 + x * 4;
      if (aa <= 0) {
        raw[o] = 0;
        raw[o + 1] = 0;
        raw[o + 2] = 0;
        raw[o + 3] = 0;
      } else {
        raw[o] = clamp255(ar / aa); // 反预乘回直通 alpha
        raw[o + 1] = clamp255(ag / aa);
        raw[o + 2] = clamp255(ab / aa);
        raw[o + 3] = clamp255((aa / (ss * ss)) * 255);
      }
    }
  }
  return raw;
}

// ---------- 最小 PNG 编码 ----------
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(raw, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression/filter/interlace = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 供预览脚本复用渲染能力（直接 require 时不会执行下面的 CLI）
module.exports = { render, encodePng, DESIGN };

// ---------- CLI ----------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  const size = Number(opt('size', 512));
  const ss = Number(opt('ss', 3)); // 超采样倍数，配合 SDF 覆盖率让边缘更干净
  const out = path.resolve(opt('out', path.join(__dirname, '..', 'build', 'icon.png')));

  if (!Number.isInteger(size) || size < 8 || size > 4096) {
    console.error(`invalid --size: ${opt('size', '')}`);
    process.exit(2);
  }
  if (!Number.isInteger(ss) || ss < 1 || ss > 8) {
    console.error(`invalid --ss: ${opt('ss', '')}`);
    process.exit(2);
  }

  const png = encodePng(render(size, ss), size);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log('saved:', out, `${size}x${size}`, png.length, 'bytes');
}
