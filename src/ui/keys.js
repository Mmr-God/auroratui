// Raw-mode key decoding (ANSI sequences, mouse wheel, bracketed paste).
const SEQ = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1bOH': 'home',
  '\x1bOF': 'end',
  '\x1b[1~': 'home',
  '\x1b[2~': 'insert',
  '\x1b[3~': 'delete',
  '\x1b[4~': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  // 带修饰键的 Home/End（Ctrl+Home / Ctrl+End / Shift+…）
  '\x1b[1;5H': 'ctrl+home',
  '\x1b[1;5F': 'ctrl+end',
  '\x1b[1;2H': 'shift+home',
  '\x1b[1;2F': 'shift+end',
  '\x1b[Z': 'shift-tab',
  '\x1b[200~': 'paste-start',
  '\x1b[201~': 'paste-end',
};

const CTRL = {
  '\x00': 'ctrl+space',
  '\x01': 'ctrl+a',
  '\x02': 'ctrl+b',
  '\x03': 'ctrl+c',
  '\x04': 'ctrl+d',
  '\x05': 'ctrl+e',
  '\x06': 'ctrl+f',
  '\x07': 'ctrl+g',
  '\x08': 'backspace',
  '\x09': 'tab',
  '\x0a': 'ctrl+j',
  '\x0b': 'ctrl+k',
  '\x0c': 'ctrl+l',
  '\x0d': 'enter',
  '\x0e': 'ctrl+n',
  '\x0f': 'ctrl+o',
  '\x10': 'ctrl+p',
  '\x11': 'ctrl+q',
  '\x12': 'ctrl+r',
  '\x13': 'ctrl+s',
  '\x14': 'ctrl+t',
  '\x15': 'ctrl+u',
  '\x16': 'ctrl+v',
  '\x17': 'ctrl+w',
  '\x18': 'ctrl+x',
  '\x19': 'ctrl+y',
  '\x1a': 'ctrl+z',
  '\x1b': 'esc',
  '\x7f': 'backspace',
};

export class KeyParser {
  constructor() {
    this.buf = '';
    this.bufTs = 0;
    this.pasting = false;
    this.paste = '';
    this.pasteTs = 0;
    this.pendingEsc = false;
    this.pendingEscAt = 0;
  }

  _keep(s) {
    this.buf = s;
    this.bufTs = Date.now();
  }

  /** Feed a raw chunk; returns a list of key events. */
  push(chunk) {
    if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf8');
    this.buf += chunk.toString('utf8');
    this.bufTs = Date.now();
    this.pendingEsc = false;
    const events = [];
    while (this.buf.length) {
      const s = this.buf;

      if (this.pasting) {
        const end = s.indexOf('\x1b[201~');
        if (end < 0) {
          this.paste += s;
          this.buf = '';
          this.pasteTs = Date.now();
          break;
        }
        this.paste += s.slice(0, end);
        this._keep(s.slice(end + 6));
        this.pasting = false;
        this.pasteTs = 0;
        events.push({ key: 'paste', text: this.paste.replace(/\r\n?/g, '\n') });
        this.paste = '';
        continue;
      }

      // mouse (SGR 1006): btn bits — low 2 bits = button, 4 = shift, 8 = alt,
      // 16 = ctrl, 32 = motion, 64 = wheel; final 'm' means release.
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (mouse) {
        this._keep(s.slice(mouse[0].length));
        const btn = Number(mouse[1]);
        const x = Number(mouse[2]);
        const y = Number(mouse[3]);
        let key;
        if (btn & 64) key = btn & 1 ? 'wheel-down' : 'wheel-up';
        else if (mouse[4] === 'm') key = 'mouse-up';
        else if (btn & 32) key = btn & 3 ? 'mouse-move' : 'mouse-drag';
        else key = 'mouse-down';
        events.push({ key, x, y, button: btn & 3, shift: !!(btn & 4), ctrl: !!(btn & 16), raw: btn });
        continue;
      }

      // incomplete escape: wait for more bytes (unless it's obviously complete ESC)
      if (s[0] === '\x1b') {
        if (s.length === 1) {
          // 单个 ESC：可能是用户按的 Esc，也可能是被截断的转义序列前半截。
          // 先按住不放，看 25ms 内有没有后续字节（tick() 超时后才当 esc 抛出去），
          // 否则方向键被拆包时会变成 "esc + [A 文本"。
          this.pendingEsc = true;
          this.pendingEscAt = Date.now();
          this.buf = '\x1b';
          break;
        }
        const rest = s.slice(1);
        // alt+key
        const altMatch = /^([a-zA-Z0-9])$/.exec(rest[0] || '');
        if (altMatch && rest.length === 1) {
          this._keep('');
          events.push({ key: `alt+${rest[0].toLowerCase()}`, text: rest[0] });
          continue;
        }
        // find known sequence (longest match)
        let matched = null;
        for (const seq of Object.keys(SEQ)) {
          if (s.startsWith(seq) && (!matched || seq.length > matched.length)) matched = seq;
        }
        if (matched) {
          this._keep(s.slice(matched.length));
          const key = SEQ[matched];
          if (key === 'paste-start') {
            this.pasting = true;
            this.paste = '';
            this.pasteTs = Date.now();
          } else if (key !== 'paste-end') {
            events.push({ key });
          }
          continue;
        }
        // unknown CSI: consume it
        const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s);
        if (csi) {
          this._keep(s.slice(csi[0].length));
          continue;
        }
        if (/^\x1b\[[0-9;?<]*$/.test(s)) {
          // incomplete: keep buffering
          this.bufTs = Date.now();
          return events;
        }
        this._keep(s.slice(1));
        events.push({ key: 'esc' });
        continue;
      }

      const ch = s[0];
      if (CTRL[ch]) {
        this._keep(s.slice(1));
        events.push({ key: CTRL[ch] });
        continue;
      }
      // printable run
      const m = /^[^\x00-\x1f\x7f]+/.exec(s);
      if (m) {
        this._keep(s.slice(m[0].length));
        events.push({ key: 'text', text: m[0] });
        continue;
      }
      this._keep(s.slice(1));
    }
    return events;
  }

  /**
   * 周期性调用（宿主每帧跑一次），处理“卡住的半截输入”：
   *  - 单个 ESC 超过 25ms 没有后续字节 → 当成 esc 抛出去
   *  - bracketed paste 开始后 600ms 没等到结束标记 → 直接把已收到的内容当粘贴结果
   *  - 半截转义序列超过 400ms 没补齐 → 丢掉，避免它把后面正常输入吃掉
   * 任何一条都曾经能让输入彻底失灵，所以必须有超时兜底。
   */
  tick(now = Date.now()) {
    const events = [];
    if (this.pendingEsc && now - this.pendingEscAt >= 25) {
      this.pendingEsc = false;
      this.buf = '';
      events.push({ key: 'esc' });
    }
    if (this.pasting && this.pasteTs && now - this.pasteTs >= 600) {
      const text = this.paste;
      this.pasting = false;
      this.paste = '';
      this.pasteTs = 0;
      this.buf = '';
      if (text) events.push({ key: 'paste', text: text.replace(/\r\n?/g, '\n') });
    }
    if (this.buf && this.bufTs && now - this.bufTs >= 400) {
      this.buf = ''; // 半截转义序列：丢掉，别让它污染后面的按键
    }
    return events;
  }
}
