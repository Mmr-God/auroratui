// Small shared helpers: ANSI handling, display width, wrapping, text utils.

const ESC_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const stripAnsi = (s) => (s.includes('\x1b') ? s.replace(ESC_RE, '') : s);

// ---- display width -------------------------------------------------------
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
const ZERO = /^[\u0300-\u036f\u200b-\u200f\ufe0f\ufe0e]$/;

export function charWidth(ch) {
  if (ZERO.test(ch)) return 0;
  const cp = ch.codePointAt(0);
  if (cp === 0) return 0;
  if (cp < 32) return 0;
  if (isWide(cp)) return 2;
  return 1;
}

export function strWidth(s) {
  const t = stripAnsi(s);
  let w = 0;
  for (const ch of t) w += charWidth(ch);
  return w;
}

export function truncToWidth(s, width, ellipsis = '…') {
  if (width <= 0) return '';
  if (strWidth(s) <= width) return s;
  const ew = strWidth(ellipsis);
  const budget = width - ew;
  let out = '';
  let w = 0;
  const plain = s;
  let i = 0;
  let active = '';
  // walk, keeping ANSI sequences intact
  while (i < plain.length) {
    if (plain[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(plain.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = plain[i];
    const cw = charWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
    i++;
  }
  void active;
  return out + ellipsis + '\x1b[0m';
}

export function padToWidth(s, width, align = 'left', filler = ' ') {
  const w = strWidth(s);
  if (w >= width) return s;
  const gap = width - w;
  if (align === 'right') return filler.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return filler.repeat(l) + s + filler.repeat(gap - l);
  }
  return s + filler.repeat(gap);
}

// ---- wrap (ANSI aware) ---------------------------------------------------
// Splits a styled string into display lines, word-wrapping at spaces when
// possible and hard-breaking otherwise. Each returned line resets styles and
// re-applies the SGR state that was active where the line was cut.
export function wrapAnsi(str, width, opts = {}) {
  const { hang = 0, breakWords = true } = opts;
  width = Math.max(1, Math.floor(width));
  const lines = [];
  let line = '';
  let lineW = 0;
  let i = 0;
  let state = '';
  let lastSpace = -1; // index in `line` (string index) of last breakable space
  let lastSpaceW = 0;
  let firstAllowed = width;

  const pushLine = (opts2 = {}) => {
    lines.push(line.replace(/\s+$/, '') + (state ? '\x1b[0m' : ''));
    line = state ? state : '';
    lineW = 0;
    lastSpace = -1;
    firstAllowed = width - hang;
    if (opts2.carrySpaces) {
      line = (state ? state : '') + opts2.carrySpaces;
      lineW = strWidth(opts2.carrySpaces);
    }
  };

  while (i < str.length) {
    if (str[i] === '\n') {
      lines.push(line + (state ? '\x1b[0m' : ''));
      line = state ? state : '';
      lineW = 0;
      lastSpace = -1;
      firstAllowed = width - hang;
      i++;
      continue;
    }
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(str.slice(i)) || /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(str.slice(i));
      if (m) {
        const seq = m[0];
        if (seq.endsWith('m')) {
          if (seq === '\x1b[0m' || seq === '\x1b[m') state = '';
          else state += seq;
        }
        line += seq;
        i += seq.length;
        continue;
      }
    }
    const ch = str[i];
    const cw = charWidth(ch);
    if (lineW + cw > firstAllowed && lineW > 0) {
      if (ch === ' ') {
        // consume the space at wrap point
        pushLine();
        i++;
        continue;
      }
      if (breakWords) {
        pushLine({ carrySpaces: '' });
      } else {
        pushLine({ carrySpaces: '' });
      }
    }
    line += ch;
    lineW += cw;
    if (ch === ' ' || (ch === '-' && lineW > 2)) {
      lastSpace = line.length;
      lastSpaceW = lineW;
    }
    i++;
  }
  lines.push(line + (state ? '\x1b[0m' : ''));
  // trim trailing empty line only if input ended with newline
  return lines;
}

// Word-wrap that respects explicit newlines but does not split words unless
// they exceed the width. Used for paragraphs / prose.
export function wrapWords(str, width, opts = {}) {
  const { hang = 0, prefix = '', hangPrefix = null } = opts;
  const out = [];
  const paras = str.split('\n');
  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi];
    const pfx = out.length === 0 ? prefix : hangPrefix ?? prefix;
    const avail = Math.max(4, width - strWidth(pfx) - (out.length === 0 ? 0 : hang));
    if (para === '') {
      out.push(pfx.replace(/\s+$/, ''));
      continue;
    }
    // tokenise into ANSI-atoms + words
    const atoms = ansiAtoms(para);
    let cur = '';
    let curW = 0;
    let firstOnLine = true;
    for (const a of atoms) {
      const w = strWidth(a.text);
      if (firstOnLine && w > avail) {
        // hard break long token
        let rest = a;
        while (strWidth(rest.text) > avail) {
          const [head, tail] = cutAnsi(rest.text, avail);
          out.push((firstOnLine ? pfx : pfx + '') + head);
          rest = { ansi: rest.ansi, text: tail };
          firstOnLine = false;
        }
        cur = rest.text;
        curW = strWidth(cur);
        firstOnLine = false;
        continue;
      }
      if (!firstOnLine && curW + w > avail) {
        out.push(pfx + cur.replace(/\s+$/, ''));
        cur = '';
        curW = 0;
        firstOnLine = true;
        if (/^\s+$/.test(a.text)) continue;
      }
      cur += a.text;
      curW += w;
    }
    out.push(pfx + cur.replace(/\s+$/, ''));
  }
  return out;
}

export function ansiAtoms(s) {
  const atoms = [];
  let i = 0;
  let pending = '';
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) {
        pending += m[0];
        i += m[0].length;
        continue;
      }
    }
    let j = i;
    let buf = '';
    while (j < s.length && s[j] !== '\x1b') {
      buf += s[j];
      j++;
    }
    // split buf into words (keep spaces attached to leader)
    const parts = buf.split(/(\s+)/).filter((x) => x !== '');
    for (const p of parts) {
      atoms.push({ ansi: pending, text: pending + p });
      pending = '';
    }
    i = j;
  }
  if (pending) atoms.push({ ansi: '', text: pending });
  return atoms;
}

export function cutAnsi(s, width) {
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cw = charWidth(s[i]);
    if (w + cw > width) break;
    out += s[i];
    w += cw;
    i++;
  }
  return [out, s.slice(i)];
}

// ---- misc ----------------------------------------------------------------
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function timeAgo(ts) {
  const d = Math.max(0, Date.now() - ts);
  if (d < 1000) return `${d}ms`;
  if (d < 60_000) return `${(d / 1000).toFixed(1)}s`;
  if (d < 3_600_000) return `${Math.round(d / 60000)}m`;
  return `${Math.round(d / 3600000)}h`;
}

export function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function fmtMoney(usd) {
  if (!usd) return '$0.0000';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? `${s}s` : ''}`;
}

// Rough token estimate: CJK ~1 token/char, latin ~1 token / 3.8 chars.
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.05 + other / 3.8);
}

export function shortPath(p, cwd = process.cwd()) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  const c = String(cwd).replace(/\\/g, '/');
  if (s.startsWith(c)) s = s.slice(c.length).replace(/^\//, '') || '.';
  return s;
}

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 9);
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function firstLine(s, max = 80) {
  const l = String(s ?? '').split('\n')[0];
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
}
