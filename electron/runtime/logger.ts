/**
 * 主进程日志 —— 把渲染进程 console 与进程级异常落到文件，供 release 包事后排查。
 *
 * 打包后的应用既没有 DevTools 入口（自定义菜单里没有 toggleDevTools，
 * `Ctrl+Shift+I` 因此不生效），也看不到 stderr，现场问题只能靠日志复现。
 *
 * 设计取舍：
 * - **每天一个文件**：`logs/main-YYYY-MM-DD.log`，按本地日期切分（跨天自动切到新
 *   文件，不需要重启）。排查时「哪天出的问题就看哪天」，也避免单个文件无限增长。
 * - **只追加、绝不覆盖**：始终以追加方式写入，不做轮转改名、不截断历史。
 * - **保留 30 天**：启动时（以及长驻进程跨天时）清掉 30 天前的日志文件，
 *   避免长期使用后目录无限膨胀。只处理本模块生成的 `main-日期.log` 命名，
 *   目录里的其它文件不动。
 * - **异步批量写入**：日志不能阻塞主进程——一次 GPU 上下文丢失会带来 N 条渲染
 *   进程告警，逐条同步写盘会把主线程钉住；这里攒 200ms 批量 flush。
 * - **缓冲有上限**：渲染进程刷屏时只保留最近 `MAX_PENDING_LINES` 行，丢掉的条数
 *   会写成一条 `[logs] dropped=N` 提示行，不留无声的空缺。
 * - **永不抛错**：任何日志失败都必须静默吞掉，不能反过来影响主流程。
 */

import { app } from 'electron';
import { promises as fs, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 批量落盘的间隔。 */
const FLUSH_INTERVAL_MS = 200;
/** 单条消息的最大长度（渲染进程可能打印超长对象）。 */
const MAX_MESSAGE_CHARS = 4000;
/** 单次 flush 周期内最多缓冲的行数；超出时丢最旧的，避免刷屏把主进程内存吃满。 */
const MAX_PENDING_LINES = 2000;
/** 日志保留天数：含今天在内共保留这么多天。 */
const RETENTION_DAYS = 30;
/** 本模块生成的文件名；也用于把清理范围限制在自己写过的文件上。 */
const FILE_PATTERN = /^main-(\d{4}-\d{2}-\d{2})\.log$/;

let logDirPath: string | null = null;
let dirResolved = false;
/** 最近一次写入所对应的日期键，用于「跨天时触发一次清理」。 */
let lastDateKey: string | null = null;

let pending: string[] = [];
/** 因超出缓冲上限而被丢掉的行数，下次落盘时写一条提示行告知。 */
let droppedLines = 0;
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

/** 取（并在首次调用时创建）日志目录。 */
function ensureDir(): string | null {
  if (dirResolved) return logDirPath;
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    logDirPath = dir;
  } catch {
    // 目录不可建（权限等）：整个日志系统静默失效
    logDirPath = null;
  }
  dirResolved = true;
  return logDirPath;
}

/** 本地日期键，与文件名共用同一套格式。 */
function dateKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 删掉超出保留期的日志文件。
 *
 * 按**文件名里的日期**判断，而不是 mtime：文件被复制/备份/同步过之后 mtime 会变，
 * 但文件名不会。日期是零填充的 `YYYY-MM-DD`，可直接字符串比较。
 *
 * 只处理 `main-日期.log` 这种本模块生成的命名，目录里如果有别的东西一律不碰。
 */
async function pruneOldLogs(dir: string, now: Date): Promise<void> {
  try {
    // 含今天在内保留 RETENTION_DAYS 天，所以截止日是今天往前推 RETENTION_DAYS-1
    const cutoffKey = dateKey(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - (RETENTION_DAYS - 1)),
    );
    let removed = 0;
    for (const name of await fs.readdir(dir)) {
      const matched = FILE_PATTERN.exec(name);
      if (!matched) continue;
      if (matched[1] >= cutoffKey) continue;
      await fs.rm(join(dir, name), { force: true });
      removed += 1;
    }
    if (removed > 0) {
      logLine('logs-cleanup', `removed=${removed} cutoff=${cutoffKey}`);
    }
  } catch {
    // 清理失败不影响写日志
  }
}

/**
 * 当天日志文件路径。
 *
 * 每次写入都重新算，跨过零点后自动落到新的一天，不需要重启进程。
 * 文件名用本地日期，行内时间戳也用本地时间，两者才对得上。
 * 日期变化（含进程首次写入）时顺带触发一次过期清理，长驻进程也不会无限留日志。
 */
function fileFor(now: Date): string | null {
  const dir = ensureDir();
  if (!dir) return null;
  const key = dateKey(now);
  if (lastDateKey !== key) {
    lastDateKey = key;
    void pruneOldLogs(dir, now);
  }
  return join(dir, `main-${key}.log`);
}

/** 本地时间戳：`YYYY-MM-DD HH:mm:ss.SSS`（可按字典序排序，也便于和文件名对照）。 */
function formatLocal(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${dateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * 取出待写批次并清空缓冲。
 *
 * 若上一周期有日志因超出上限被丢，先在批次最前面补一条提示行——
 * 丢日志本身也要留痕，否则事后看到一段空缺会误以为是程序没干活。
 * 这条提示不走 logLine（避免在落盘路径里再次入队、递归调度）。
 */
function takeBatch(): string {
  const batch = pending.join('');
  const dropped = droppedLines;
  pending = [];
  droppedLines = 0;
  if (dropped === 0) return batch;
  const notice = `${formatLocal(new Date())} [logs] dropped=${dropped} lines (buffer limit ${MAX_PENDING_LINES})\n`;
  return notice + batch;
}

async function flush(): Promise<void> {
  if (flushing || (pending.length === 0 && droppedLines === 0)) return;
  const batch = takeBatch();
  flushing = true;
  try {
    const file = fileFor(new Date());
    if (file) {
      // appendFile 默认 flag 'a'：纯追加，不截断已有内容
      await fs.appendFile(file, batch, 'utf8');
    }
  } catch {
    // 日志失败不能影响主流程
  } finally {
    flushing = false;
    if (pending.length > 0) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
  // 只有日志任务时不该拖住进程退出
  flushTimer.unref?.();
}

/**
 * 记一条日志。
 *
 * @param tag 分类标签，如 `renderer:warning`、`child-process-gone`
 */
export function logLine(tag: string, message: string): void {
  const text =
    message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
  // 压成单行：渲染进程常打印带换行的对象，单行才方便 grep
  const oneLine = text.replace(/\r?\n/g, ' ⏎ ');
  pending.push(`${formatLocal(new Date())} [${tag}] ${oneLine}\n`);
  /*
   * 渲染进程刷屏（比如 console.error 死循环）时缓冲会无限增长。
   * 超过上限就丢最旧的，并记下丢弃条数——保留最近的行，才有诊断价值。
   */
  if (pending.length > MAX_PENDING_LINES) {
    const overflow = pending.length - MAX_PENDING_LINES;
    pending.splice(0, overflow);
    droppedLines += overflow;
  }
  scheduleFlush();
}

/** 退出前把剩余缓冲同步写完（before-quit 调用）。 */
export function flushLogSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0 && droppedLines === 0) return;
  const batch = takeBatch();
  try {
    const file = fileFor(new Date());
    if (file) {
      appendFileSync(file, batch, 'utf8');
    }
  } catch {
    // 忽略
  }
}
