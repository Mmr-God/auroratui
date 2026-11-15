// Minimal but pretty Markdown → ANSI lines renderer.
import { wrapWords, strWidth, padToWidth, stripAnsi } from '../util.js';
import { T } from './theme.js';
import { highlightLines, normalizeLang } from './highlight.js';

const SENT = '\u0000';

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, code) => {
    codes.push(code);
    return `${SENT}${codes.length - 1}${SENT}`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => T.dimmer(`[图片${alt ? `: ${alt}` : ''}]`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const label = T.underline(T.accent(text));
    const clean = url.replace(/^https?:\/\//, '');
    return clean === text ? label : `${label} ${T.dimmer('(' + clean.slice(0, 60) + ')')}`;
  });
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (m, x) => T.bold(T.italic(x)));
  s = s.replace(/\*\*([^*]+)\*\*/g, (m, x) => T.bold(T.white(x)));
  s = s.replace(/(^|[\s(（])\*([^*\n]+)\*/g, (m, pre, x) => `${pre}${T.italic(x)}`);
  s = s.replace(/(^|[\s(（])_([^_\n]+)_(?=[\s)）,.;:!?]|$)/g, (m, pre, x) => `${pre}${T.italic(x)}`);
  s = s.replace(/~~([^~]+)~~/g, (m, x) => `\x1b[9m${x}\x1b[0m`);
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s)）]+)/g, (m, pre, url) => `${pre}${T.underline(T.dim(url))}`);
  s = s.replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (m, i) => T.code(codes[Number(i)]));
  return s;
}

function linkifyCode(line) {
  return line;
}

function renderCodeBlock(lang, body, width, opts = {}) {
  const out = [];
  const avail = Math.max(20, width - 2);
  const inner = Math.max(8, avail - 4);
  const id = normalizeLang(lang);
  const label = id || String(lang || '').trim().toLowerCase() || 'text';
  const total = body.length;
  const maxLines = opts.maxLines ?? 40;
  // 流式输出时保留最后几行（正在写的那段），否则新代码会被挡在折叠线外；
  // 写完后再从头展示。超长代码块始终折叠，避免一屏全是代码。
  const rows = total > maxLines ? (opts.streaming ? body.slice(-maxLines) : body.slice(0, maxLines)) : body;
  const hidden = total - rows.length;

  const headPrefix = `  ${T.dimmer('╭─')} ${T.accent2(label)} ${T.dimmer('·')} ${T.dimmer(`${total} 行`)} `;
  const headW = strWidth(stripAnsi(headPrefix));
  out.push(headPrefix + T.dimmer('─'.repeat(Math.max(2, avail - headW)) + '╮'));

  // 制表符先展开，保证高亮后的列与显示列一致
  const plain = (rows.length ? rows : ['']).map((l) => String(l ?? '').replace(/\t/g, '  '));
  const colored = highlightLines(plain, id || lang);
  for (let i = 0; i < plain.length; i++) {
    const styled = colored[i] ?? plain[i];
    const wrapped = wrapWords(styled === '' ? plain[i] : styled, inner, { prefix: '' });
    if (!wrapped.length) wrapped.push('');
    for (const line of wrapped) out.push(`  ${T.dimmer('│')} ${line}`);
  }
  if (hidden > 0) {
    const where = opts.streaming ? `前面还有 ${hidden} 行（写完后展开）` : `还有 ${hidden} 行 · 点开完整查看`;
    out.push(`  ${T.dimmer('│')} ${T.dimmer(`… ${where}`)}`);
  }
  out.push('  ' + T.dimmer('╰' + '─'.repeat(Math.max(4, avail - 2)) + '╯'));
  return out;
}

/** Render markdown into styled lines (each line ≤ width display cells). */
export function renderMarkdown(text, width, opts = {}) {
  const lines = [];
  const w = Math.max(12, width);
  const src = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let inFence = false;
  let fenceLang = '';
  let fenceBody = [];

  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(' ');
    const styled = inline(joined);
    const wrapped = wrapWords(styled, w - 2, { prefix: '' });
    for (const ln of wrapped) lines.push('  ' + ln);
    lines.push('');
    para.length = 0;
  };

  while (i < src.length) {
    const line = src[i];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      if (!inFence) {
        flushPara();
        inFence = true;
        fenceLang = fence[2] || '';
        fenceBody = [];
      } else {
        lines.push(...renderCodeBlock(fenceLang, fenceBody, w, opts));
        lines.push('');
        inFence = false;
        fenceBody = [];
      }
      i++;
      continue;
    }
    if (inFence) {
      fenceBody.push(line);
      i++;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      const txt = h[2].replace(/\s*#+\s*$/, '');
      if (level === 1) lines.push(`${T.accentBold('│ ' + txt)}`);
      else if (level === 2) lines.push(`${T.accentBold('│ ' + txt)}`);
      else lines.push(`${T.bold(T.accent2('│ ' + txt))}`);
      lines.push('');
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushPara();
      lines.push(T.dimmer('  ' + '─'.repeat(Math.max(0, w - 4))));
      lines.push('');
      i++;
      continue;
    }

    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) {
      flushPara();
      const styled = inline(bq[1]);
      for (const ln of wrapWords(styled, w - 6, { prefix: '' })) {
        lines.push(`  ${T.accent2('│')} ${T.italic(T.dim(ln))}`);
      }
      i++;
      continue;
    }

    const li = /^(\s*)([-*+]|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = Math.min(6, Math.floor(li[1].length / 2) * 2);
      const marker = li[3] ? `${li[3]}.` : '•';
      const markerStyled = li[3] ? T.dim(marker.padStart(3) + ' ') : `${T.accent(marker)} `;
      const pad = ' '.repeat(indent);
      const body = inline(li[4]);
      const hangPrefix = pad + '    ';
      const wrapped = wrapWords(body, w - 4 - indent, { prefix: '', hang: 0 });
      wrapped.forEach((ln, idx) => {
        if (idx === 0) lines.push(`  ${pad}${markerStyled}${ln}`);
        else lines.push(`  ${hangPrefix}${ln}`);
      });
      i++;
      continue;
    }

    // table detection: header + separator
    if (/\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(src[i + 1] || '')) {
      flushPara();
      const rows = [line, src[i + 1]];
      i += 2;
      while (i < src.length && /\|/.test(src[i]) && src[i].trim()) {
        rows.push(src[i]);
        i++;
      }
      const cells = rows
        .filter((r, idx) => idx !== 1)
        .map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const ncol = Math.max(...cells.map((r) => r.length));
      const colW = new Array(ncol).fill(4);
      for (const r of cells) r.forEach((c, ci) => (colW[ci] = Math.max(colW[ci], Math.min(28, strWidth(c)))));
      cells.forEach((r, ri) => {
        const parts = [];
        for (let ci = 0; ci < ncol; ci++) {
          const cell = r[ci] ?? '';
          const styled = ri === 0 ? T.bold(T.white(cell)) : T.plain(cell);
          parts.push(padToWidth(styled, colW[ci]));
        }
        lines.push('  ' + parts.join(T.dimmer(' │ ')));
        if (ri === 0) lines.push('  ' + colW.map((cw) => T.dimmer('─'.repeat(cw))).join(T.dimmer('─┼─')));
      });
      lines.push('');
      continue;
    }

    para.push(line.trim());
    i++;
  }
  if (inFence && fenceBody.length) {
    lines.push(...renderCodeBlock(fenceLang, fenceBody, w, opts));
  }
  flushPara();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Dim single-line preview of arbitrary text (for tool output). */
export function previewLines(text, width, max = 8) {
  const out = [];
  const src = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (const raw of src) {
    if (out.length >= max) break;
    if (!raw.trim() && out.length && out[out.length - 1] === '') continue;
    for (const ln of wrapWords(raw.replace(/\t/g, '  '), Math.max(8, width - 4), { prefix: '' })) {
      if (out.length >= max) break;
      out.push(ln);
    }
  }
  if (src.length > max) out.push(T.dimmer('…'));
  return out;
}
