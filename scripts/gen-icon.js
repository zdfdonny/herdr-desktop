/**
 * 生成 Herdr 应用图标（512x512 PNG）：
 * 深色圆角底 + 绿色提示符箭头 + 白色光标下划线。
 *
 * 不依赖任何图像库：手写最小 PNG 编码（zlib + CRC32）。
 * 产物 `build/icon.png` 已被 electron-builder 的 win/mac/linux 三端 icon 引用，
 * 由 electron-builder 在打包时自动转换成 .ico / .icns / 各尺寸 PNG。
 *
 * 用法：`npm run icon`
 */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;
const MARGIN = 8;
const RADIUS = 96;

// ---------- 形状 ----------
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// 提示符箭头（窄尖角，绿色）
const A = [170, 196];
const B = [170, 316];
const C = [238, 256];
// 光标下划线（白色）
const U = [268, 300, 104, 36];

// ---------- 逐像素绘制 ----------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1)); // 每行前一个 filter 字节
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const o = rowStart + 1 + x * 4;
    let r = 0, g = 0, b = 0, a = 0;
    if (insideRoundedRect(x, y, MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN, RADIUS)) {
      r = 0x17; g = 0x17; b = 0x17; a = 255;
    }
    if (insideTriangle(x, y, A, B, C)) {
      r = 0x4a; g = 0xde; b = 0x80; a = 255; // #4ade80
    }
    if (x >= U[0] && x <= U[0] + U[2] && y >= U[1] && y <= U[1] + U[3]) {
      r = 0xe4; g = 0xe4; b = 0xe7; a = 255; // #e4e4e7
    }
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
// compression/filter/interlace = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('saved:', out, png.length, 'bytes');
