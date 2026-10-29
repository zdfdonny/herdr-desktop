/**
 * 系统剪贴板读取 —— 终端「智能粘贴」的数据来源。
 *
 * Renderer 侧 xterm 只认识文本；图片与文件没有文本表示，直接走
 * `navigator.clipboard.readText()` 会得到空串或残缺结果。这里改用主进程的
 * Electron `clipboard` 模块直接读系统剪贴板的原始 MIME 类型：
 * - 文件（从文件管理器复制）→ `text/uri-list` 的 file:// URI，Windows 上还
 *   额外兜底读原生 HDROP（`FileName` / `FileNameW` 格式）；
 * - 图片（截图 / 网页复制）→ `image/*`，落盘为临时文件后返回路径；
 * - 文本 → `text/plain`。
 *
 * 之所以放在主进程而不是 Renderer：Chromium 的 `navigator.clipboard.read()`
 * 只暴露 text/html/text/plain/image，不暴露 `text/uri-list`，读不到复制来的
 * 文件路径；Electron 主进程的 `clipboard` 能读系统剪贴板的全部格式。
 */

import { clipboard } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ClipboardPayload } from '../../shared/protocol';

const URI_LIST = 'text/uri-list';

/** Windows 原生 HDROP 暴露成 osclipboard 自定义格式的名字。 */
const OS_FILE_NAME = 'electron application/osclipboard;format="FileName"';
const OS_FILE_NAME_W = 'electron application/osclipboard;format="FileNameW"';

/** 从一堆 MIME 类型里挑出第一个图片类型。 */
function pickImageType(types: readonly string[]): string | null {
  return types.find((type) => type.startsWith('image/')) ?? null;
}

/** 图片 MIME → 临时文件扩展名。 */
function imageExtension(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/bmp') return '.bmp';
  if (mime === 'image/svg+xml') return '.svg';
  return '.png';
}

/**
 * 把 file:// URI 转成本地绝对路径。
 *
 * `fileURLToPath` 只吃标准 `file:///C:/a/b` 形式；部分应用会写出 `file://C:/a/b`
 * 或带反斜杠、未编码的变体，这里做一层兜底，避免一个坏 URI 拖垮整批文件。
 */
function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    // fall through
  }
  let rest = uri.replace(/^file:\/\//i, '');
  // Windows：/C:/foo -> C:/foo，C:\foo 保持不变
  rest = rest.replace(/^\/([A-Za-z]:)/, '$1');
  rest = rest.replace(/\\/g, '/');
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // 保持原样
  }
  if (process.platform === 'win32') {
    rest = rest.replace(/\//g, '\\');
  }
  return rest.length > 0 ? rest : null;
}

/** 解析 `text/uri-list` 里的 file:// URI 为绝对路径。 */
async function parseFileUris(blob: Blob): Promise<string[]> {
  const text = await blob.text();
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!/^file:/i.test(trimmed)) continue;
    const path = uriToPath(trimmed);
    if (path) paths.push(path);
  }
  return paths;
}

/** 解码 UTF-16LE（Windows FileNameW 格式）。 */
function decodeUtf16Le(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const codes: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    codes.push(bytes[i] | (bytes[i + 1] << 8));
  }
  let text = '';
  // 分块拼接，避免超长参数列表
  const CHUNK = 0x8000;
  for (let i = 0; i < codes.length; i += CHUNK) {
    text += String.fromCharCode(...codes.slice(i, i + CHUNK));
  }
  return text;
}

/** 解析 Windows 原生 HDROP（FileName 为 ANSI，FileNameW 为 UTF-16LE）。 */
async function parseHdrop(blob: Blob, wide: boolean): Promise<string[]> {
  const text = wide ? decodeUtf16Le(await blob.arrayBuffer()) : await blob.text();
  return text
    .split('\0')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** 从剪贴板条目里提取文件路径（多格式兜底，去重）。 */
async function readFilesFromItems(items: Electron.ClipboardItem[]): Promise<string[]> {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };

  // 1) text/uri-list（跨平台标准）
  for (const item of items) {
    if (!item.types.includes(URI_LIST)) continue;
    try {
      const blob = (await item.getType(URI_LIST)) as Blob;
      for (const p of await parseFileUris(blob)) add(p);
    } catch {
      // 该条目读不出来，继续尝试其它条目
    }
  }
  if (paths.length > 0) return paths;

  // 2) Windows 原生 HDROP
  for (const format of [OS_FILE_NAME, OS_FILE_NAME_W]) {
    for (const item of items) {
      if (!item.types.includes(format)) continue;
      try {
        const blob = (await item.getType(format)) as Blob;
        for (const p of await parseHdrop(blob, format === OS_FILE_NAME_W)) add(p);
      } catch {
        // 继续尝试
      }
    }
    if (paths.length > 0) return paths;
  }

  return paths;
}

/** 把图片字节落盘到临时目录，返回绝对路径。 */
async function saveImageBuffer(buf: Buffer, mime: string): Promise<string> {
  const dir = join(tmpdir(), 'herdr-desktop', 'clipboard');
  await fs.mkdir(dir, { recursive: true });
  const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${imageExtension(mime)}`;
  const path = join(dir, name);
  await fs.writeFile(path, buf);
  return path;
}

/**
 * 读取系统剪贴板，按「文件 → 图片 → 文本」的优先级返回一种结果。
 *
 * 优先级解释：复制一个图片文件时，剪贴板可能同时带 `text/uri-list`（原文件路径）
 * 与 `image/png`（位图副本），此时应优先用原路径而不是另存一份临时拷贝。
 */
export async function readClipboard(): Promise<ClipboardPayload> {
  let items: Electron.ClipboardItem[];
  try {
    items = await clipboard.read();
  } catch {
    return { kind: 'empty' };
  }

  // 1) 文件
  const files = await readFilesFromItems(items);
  if (files.length > 0) return { kind: 'files', files };

  // 2) 图片（截图 / 网页复制）
  for (const item of items) {
    const mime = pickImageType(item.types);
    if (!mime) continue;
    try {
      const blob = (await item.getType(mime)) as Blob;
      const buf = Buffer.from(await blob.arrayBuffer());
      const imagePath = await saveImageBuffer(buf, mime);
      return { kind: 'image', imagePath };
    } catch {
      // 该图片条目读不出来，继续尝试其它条目
    }
  }

  // 3) 文本
  try {
    const text = await clipboard.readText();
    if (text) return { kind: 'text', text };
  } catch {
    // 忽略，落到 empty
  }

  return { kind: 'empty' };
}
