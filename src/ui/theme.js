// Terminal theme: 256-colour safe styling helpers.
const c = (code) => (s) => (s === undefined || s === '' ? '' : `\x1b[${code}m${s}\x1b[0m`);

export const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  reverse: '\x1b[7m',
};

export function fg256(n) {
  return (s) => (s === undefined || s === '' ? '' : `\x1b[38;5;${n}m${s}\x1b[0m`);
}
export function bg256(n) {
  return (s) => (s === undefined || s === '' ? '' : `\x1b[48;5;${n}m${s}\x1b[0m`);
}

const t = {
  accent: fg256(111),
  accent2: fg256(141),
  accent3: fg256(180),
  text: fg256(252),
  white: fg256(255),
  dim: fg256(244),
  dimmer: fg256(240),
  ok: fg256(114),
  warn: fg256(179),
  err: fg256(203),
  user: fg256(117),
  code: fg256(150),
  think: fg256(246),
  bold: c(1),
  italic: c(3),
  underline: c(4),
  strike: c(9),
  hdrBg: bg256(236),
  barBg: bg256(236),
  boxBg: bg256(234),
  userBg: bg256(237),
  toolBg: bg256(236),
};

t.accentBold = (s) => t.bold(t.accent(s));
t.headerLine = (s) => `\x1b[48;5;236m\x1b[38;5;117m${s}\x1b[0m`;
t.statusLine = (s) => `\x1b[48;5;235m${s}\x1b[0m`;
t.chip = (s) => `\x1b[48;5;238m\x1b[38;5;252m ${s} \x1b[0m`;
t.badge = (s, bg = 131, fg = 255) => `\x1b[48;5;${bg}m\x1b[38;5;${fg}m ${s} \x1b[0m`;
t.plain = (s) => `\x1b[38;5;252m${s}\x1b[0m`;

// 团队成员的标识色（和主代理的蓝 111 明显区分开）。
// 按成员序号轮转，一眼就能分清「这是谁在调工具」。
const MEMBER_COLORS = [141, 179, 114, 210, 152, 217, 184, 109, 216, 150];
/** 第 n 个成员的颜色函数（0-based；TUI 里和主代理的 accent 蓝区分）。 */
t.member = (n) => fg256(MEMBER_COLORS[Math.abs(Number(n) || 0) % MEMBER_COLORS.length]);
/** 成员颜色代码（有些地方要拿裸色号拼背景）。 */
export const memberColorCode = (n) => MEMBER_COLORS[Math.abs(Number(n) || 0) % MEMBER_COLORS.length];

export const T = t;

export const glyphs = {
  bullet: '●',
  circle: '○',
  dot: '·',
  arrow: '→',
  check: '√',
  cross: '×',
  ellipsis: '…',
  prompt: '>',
  bar: '│',
  vbar: '│',
  spark: '*',
  fold: '~',
  warn: '!',
  info: 'i',
  spinner: ['|', '/', '-', '\\'],
  arrowUp: '↑',
  arrowDown: '↓',
  thumb: '║',
  track: '│',
  spinnerFrame(i) {
    return this.spinner[i % this.spinner.length];
  },
};

export function spinnerFrame(i) {
  return glyphs.spinner[i % glyphs.spinner.length];
}
