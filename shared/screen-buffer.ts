/**
 * 最小 VT 屏幕缓冲 —— 对应 herdr 的 ghostty 终端模拟器在检测侧的职责。
 *
 * node-pty 只透传原始字节，桌面端此前用 stripAnsi 粗暴去控制码，导致用光标
 * 原地重绘的 spinner/footer（如 claude 的 "✻ Brewing…"、antigravity 的
 * "esc to cancel"）在 raw buffer 里残留旧文本，状态卡在 working。
 *
 * 这里按顺序重放字节流、维护一个二维字符网格与光标位置，还原「当前可见屏幕」。
 * 只实现检测所需的最小 VT 子集：可打印字符、\n \r \b \t、CSI 光标移动/擦除/清屏，
 * OSC 与 SGR 等直接跳过。
 */

const MAX_ROWS = 500;

export class ScreenBuffer {
  private rows: string[] = [];
  private row = 0;
  private col = 0;

  /** 重放原始字节流，更新屏幕。 */
  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        i = this.feedEscape(data, i);
      } else if (ch === '\n') {
        this.newline();
        i += 1;
      } else if (ch === '\r') {
        this.col = 0;
        i += 1;
      } else if (ch === '\b') {
        if (this.col > 0) this.col -= 1;
        i += 1;
      } else if (ch === '\t') {
        this.col = (Math.floor(this.col / 8) + 1) * 8;
        i += 1;
      } else {
        this.writeChar(ch);
        i += 1;
      }
    }
  }

  /** 返回当前可见屏幕文本（去掉尾部空行）。 */
  text(): string {
    let end = this.rows.length;
    while (end > 0 && this.rows[end - 1].trim() === '') {
      end -= 1;
    }
    return this.rows.slice(0, end).join('\n');
  }

  private newline(): void {
    this.row += 1;
    this.col = 0;
    if (this.row >= MAX_ROWS) {
      // 超出上限时丢弃顶部行（简单滚动）
      this.rows.shift();
      this.row = MAX_ROWS - 1;
    }
  }

  private writeChar(ch: string): void {
    this.ensureRow(this.row);
    let line = this.rows[this.row];
    if (line.length < this.col) {
      line += ' '.repeat(this.col - line.length);
    }
    line = line.slice(0, this.col) + ch + line.slice(this.col + 1);
    this.rows[this.row] = line;
    this.col += 1;
  }

  private ensureRow(row: number): void {
    while (this.rows.length <= row) {
      this.rows.push('');
    }
  }

  private feedEscape(data: string, i: number): number {
    const next = data[i + 1];
    if (next === '[') {
      return this.feedCsi(data, i + 2);
    }
    if (next === ']') {
      return this.skipOsc(data, i + 2);
    }
    // 其它两字节 ESC 序列（如字符集选择 ESC(0）跳过
    return i + 2;
  }

  private feedCsi(data: string, i: number): number {
    let j = i;
    let params = '';
    while (j < data.length) {
      const ch = data[j];
      if (
        (ch >= '0' && ch <= '9') ||
        ch === ';' ||
        ch === '?' ||
        ch === ' ' ||
        ch === '<' ||
        ch === '=' ||
        ch === '>'
      ) {
        params += ch;
        j += 1;
      } else {
        break;
      }
    }
    if (j >= data.length) return j;
    const finalByte = data[j];
    this.applyCsi(params, finalByte);
    return j + 1;
  }

  private skipOsc(data: string, i: number): number {
    while (i < data.length) {
      if (data[i] === '\x07') return i + 1;
      if (data[i] === '\x1b' && data[i + 1] === '\\') return i + 2;
      i += 1;
    }
    return i;
  }

  private applyCsi(params: string, finalByte: string): void {
    const cleaned = params.replace(/[?<=> ]/g, '');
    const parts = cleaned.split(';');
    const n = (idx: number, dflt = 1): number => {
      const s = parts[idx];
      if (s === undefined || s === '') return dflt;
      const v = Number(s);
      return Number.isFinite(v) && v > 0 ? v : dflt;
    };

    switch (finalByte) {
      case 'A':
        this.row = Math.max(0, this.row - n(0));
        break;
      case 'B':
        this.row += n(0);
        break;
      case 'C':
        this.col += n(0);
        break;
      case 'D':
        this.col = Math.max(0, this.col - n(0));
        break;
      case 'H':
      case 'f':
        this.row = Math.max(0, n(0) - 1);
        this.col = Math.max(0, n(1) - 1);
        break;
      case 'G':
        this.col = Math.max(0, n(0) - 1);
        break;
      case 'K':
        this.eraseInLine(n(0, 0));
        break;
      case 'J':
        this.eraseInDisplay(n(0, 0));
        break;
      // SGR (m)、光标显隐等忽略
    }
  }

  private eraseInLine(mode: number): void {
    this.ensureRow(this.row);
    const line = this.rows[this.row];
    if (mode === 0) {
      this.rows[this.row] = line.slice(0, this.col);
    } else if (mode === 1) {
      this.rows[this.row] = ' '.repeat(this.col) + line.slice(this.col);
    } else {
      this.rows[this.row] = '';
    }
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 2) {
      this.rows = [];
      this.row = 0;
      this.col = 0;
    } else if (mode === 0) {
      this.rows = this.rows.slice(0, this.row + 1);
      this.eraseInLine(0);
    }
  }
}
