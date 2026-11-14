// 轻量语法高亮：零依赖、按行扫描的状态机。
// 只做"够好看"的着色，不做完整语法解析；未知语言原样返回。
import { T, fg256 } from './theme.js';

// ---------------------------------------------------------------- 配色
const c = {
  key: (s) => `\x1b[1m\x1b[38;5;141m${s}\x1b[0m`, // 关键字：紫（加粗）
  str: fg256(114), // 字符串：绿
  num: fg256(180), // 数字：橙
  com: (s) => `\x1b[3m\x1b[38;5;240m${s}\x1b[0m`, // 注释：灰斜体
  typ: fg256(111), // 类型 / 内建：蓝
  fn: fg256(117), // 函数名：亮蓝
  prop: fg256(150), // 属性 / 键：青绿
  op: fg256(245), // 运算符 / 标点：淡灰
  tag: fg256(204), // html 标签：粉
  add: fg256(114), // diff +：绿
  del: fg256(203), // diff -：红
  hunk: (s) => `\x1b[1m${fg256(117)(s)}`, // diff @@ 头：亮蓝
};

const KEYWORDS_COMMON = new Set(
  ('true false null undefined nil this self super new delete typeof instanceof in of as is not and or ' +
    'if else elif then fi for while do done switch case default break continue return yield await async ' +
    'function func fn def class struct enum interface trait impl extends implements import export from ' +
    'package module using namespace public private protected internal static final abstract const let var ' +
    'val mut pub use crate mod match try catch except finally throw raise with lambda pass global ' +
    'void int long short float double char bool boolean string byte u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 ' +
    'go defer chan select map range where select insert update delete create alter drop table join left ' +
    'right inner outer on group by order having limit offset union all distinct into values set').split(
    ' ',
  ),
);

const BUILTINS = new Set(
  ('console window document process require module exports global JSON Math Object Array String Number ' +
    'Boolean Symbol Promise Map Set WeakMap Date RegExp Error TypeError parseInt parseFloat isNaN ' +
    'print len range str int float dict list set tuple type isinstance super eval open file ' +
    'echo cd ls cat grep sed awk curl git node npm echo read write append close puts each do puts ' +
    'println printf fmt len cap append make copy panic recover error')
    .split(' ')
    .filter(Boolean),
);

const ALIASES = new Map(
  Object.entries({
    js: ['js', 'javascript', 'jsx', 'mjs', 'cjs', 'es6', 'node'],
    ts: ['ts', 'typescript', 'tsx'],
    json: ['json', 'jsonc', 'json5'],
    python: ['py', 'python', 'python3'],
    bash: ['sh', 'bash', 'shell', 'zsh', 'console', 'shellsession', 'cmd', 'bat', 'powershell', 'ps1', 'pwsh'],
    c: ['c', 'h'],
    cpp: ['cpp', 'c++', 'cc', 'cxx', 'hpp', 'hxx'],
    java: ['java'],
    go: ['go', 'golang'],
    rust: ['rs', 'rust'],
    cs: ['cs', 'csharp', 'c#'],
    kotlin: ['kt', 'kotlin', 'kts'],
    swift: ['swift'],
    dart: ['dart'],
    ruby: ['rb', 'ruby'],
    php: ['php'],
    lua: ['lua'],
    sql: ['sql', 'mysql', 'postgres', 'pgsql', 'sqlite'],
    yaml: ['yaml', 'yml'],
    toml: ['toml', 'ini', 'cfg', 'conf', 'env', 'properties'],
    html: ['html', 'xml', 'svg', 'vue', 'svelte', 'xhtml', 'htm'],
    css: ['css', 'scss', 'sass', 'less'],
    diff: ['diff', 'patch', 'udiff'],
  })
    .flatMap(([id, names]) => names.map((n) => [n, id])),
);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_BODY = /[A-Za-z0-9_$]/;
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)(?:[a-zA-Z]{1,3})?/;

// ---------------------------------------------------------------- 语言定义
function quotes(...list) {
  return list.map((q) => (typeof q === 'string' ? { o: q, c: q, esc: true, multi: q === '`' } : q));
}

const SPECS = {
  js: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: quotes('"', "'", { o: '`', c: '`', esc: true, multi: true }),
  },
  ts: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: quotes('"', "'", { o: '`', c: '`', esc: true, multi: true }),
  },
  json: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  python: {
    line: ['#'],
    block: [],
    quotes: quotes(
      { o: '"""', c: '"""', esc: false, multi: true },
      { o: "'''", c: "'''", esc: false, multi: true },
      { o: '"', c: '"', esc: true },
      { o: "'", c: "'", esc: true },
    ),
    deco: true,
  },
  bash: {
    line: ['#'],
    block: [],
    quotes: quotes('"', { o: "'", c: "'", esc: false }, { o: '`', c: '`', esc: true, multi: true }),
  },
  c: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  cpp: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  java: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  go: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', '`') },
  rust: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: quotes('"', { o: '`', c: '`', esc: true, multi: true }),
  },
  cs: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  kotlin: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  swift: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  dart: { line: ['//'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  ruby: { line: ['#'], block: [['=begin', '=end']], quotes: quotes('"', "'") },
  php: { line: ['//', '#'], block: [['/*', '*/']], quotes: quotes('"', "'") },
  lua: { line: ['--'], block: [['--[[', ']]']], quotes: quotes('"', "'") },
  sql: { line: ['--'], block: [['/*', '*/']], quotes: quotes({ o: "'", c: "'", esc: false }) },
  yaml: { line: ['#'], block: [], quotes: quotes('"', "'"), yaml: true },
  toml: { line: ['#', ';'], block: [], quotes: quotes('"', "'"), ini: true },
  css: { line: [], block: [['/*', '*/']], quotes: quotes('"', "'"), css: true },
};

/** 'JS' → 'js'；'python3' → 'python'；不认识的返回 ''。 */
export function normalizeLang(lang) {
  const raw = String(lang ?? '')
    .trim()
    .toLowerCase()
    .replace(/^language-/, '')
    .replace(/[^a-z0-9+#._-]/g, '');
  if (!raw) return '';
  return ALIASES.get(raw) || (SPECS[raw] ? raw : '');
}

/** 支持高亮的语言 id 列表。 */
export function supportedLangs() {
  return [...new Set(ALIASES.values())].sort();
}

function paintIdent(tok, nextChar, prevChar, spec) {
  const lower = tok.toLowerCase();
  if (KEYWORDS_COMMON.has(tok) || KEYWORDS_COMMON.has(lower)) return c.key(tok);
  if (BUILTINS.has(tok) || BUILTINS.has(lower)) return c.typ(tok);
  if (tok[0] === tok[0].toUpperCase() && tok[0] !== tok[0].toLowerCase() && tok.length > 1)
    return c.typ(tok); // 类名
  if (nextChar === '(') return c.fn(tok);
  if (prevChar === '.') return c.prop(tok);
  return tok;
}

// 单行扫描：state 跨行保存（块注释 / 多行字符串）
function scanLine(line, spec, state) {
  let out = '';
  let i = 0;
  const n = line.length;

  while (i < n) {
    // 1) 延续上一行的块注释
    if (state.block) {
      const end = line.indexOf(state.block.end, i);
      if (end === -1) {
        out += c.com(line.slice(i));
        return out;
      }
      out += c.com(line.slice(i, end + state.block.end.length));
      i = end + state.block.end.length;
      state.block = null;
      continue;
    }
    // 2) 延续上一行的多行字符串
    if (state.quote) {
      const q = state.quote;
      let j = i;
      let closed = false;
      while (j < n) {
        if (q.esc && line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line.startsWith(q.c, j)) {
          j += q.c.length;
          closed = true;
          break;
        }
        j++;
      }
      out += c.str(line.slice(i, Math.min(j, n)));
      if (closed) state.quote = null;
      i = j;
      continue;
    }

    const ch = line[i];

    // 3) 行注释
    const lc = spec.line.find((m) => line.startsWith(m, i));
    if (lc) {
      out += c.com(line.slice(i));
      return out;
    }
    // 4) 块注释开始
    const bc = (spec.block || []).find(([s]) => line.startsWith(s, i));
    if (bc) {
      const [startTok, endTok] = bc;
      const end = line.indexOf(endTok, i + startTok.length);
      if (end === -1) {
        state.block = { end: endTok };
        out += c.com(line.slice(i));
        return out;
      }
      out += c.com(line.slice(i, end + endTok.length));
      i = end + endTok.length;
      continue;
    }
    // 5) 字符串
    const q = (spec.quotes || []).find((qq) => line.startsWith(qq.o, i));
    if (q) {
      let j = i + q.o.length;
      let closed = false;
      while (j < n) {
        if (q.esc && line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line.startsWith(q.c, j)) {
          j += q.c.length;
          closed = true;
          break;
        }
        j++;
      }
      out += c.str(line.slice(i, Math.min(j, n)));
      if (!closed && q.multi) state.quote = q;
      i = j;
      continue;
    }
    // 6) python 装饰器
    if (spec.deco && ch === '@' && IDENT_START.test(line[i + 1] || '')) {
      let j = i + 1;
      while (j < n && (IDENT_BODY.test(line[j]) || line[j] === '.')) j++;
      out += c.typ(line.slice(i, j));
      i = j;
      continue;
    }
    // 7) 数字
    if (/[0-9]/.test(ch)) {
      const m = NUMBER.exec(line.slice(i));
      if (m) {
        const prev = line[i - 1] || '';
        if (!IDENT_BODY.test(prev)) {
          out += c.num(m[0]);
          i += m[0].length;
          continue;
        }
      }
    }
    // 8) 标识符 / 关键字
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_BODY.test(line[j])) j++;
      const tok = line.slice(i, j);
      // yaml / ini / css 的键：后面紧跟 : 或 =
      const rest = line.slice(j);
      if (spec.yaml && /^\s*:/.test(rest) && /^\s*/.test(line.slice(0, i))) {
        out += c.prop(tok);
        i = j;
        continue;
      }
      if (spec.ini && /^\s*=/.test(rest) && /^\s*/.test(line.slice(0, i))) {
        out += c.prop(tok);
        i = j;
        continue;
      }
      if (spec.css && /^\s*:/.test(rest)) {
        out += c.prop(tok);
        i = j;
        continue;
      }
      let k = j;
      while (k < n && line[k] === ' ') k++;
      out += paintIdent(tok, line[k], line[i - 1], spec);
      i = j;
      continue;
    }
    // 9) 其它：空白原样，符号淡灰
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    out += c.op(ch);
    i++;
  }
  return out;
}

function highlightMarkup(lines) {
  const out = [];
  let inComment = false;
  for (const raw of lines) {
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) {
        out.push(c.com(line));
        continue;
      }
      out.push(c.com(line.slice(0, end + 3)) + highlightMarkupLine(line.slice(end + 3)));
      inComment = false;
      continue;
    }
    const cStart = line.indexOf('<!--');
    if (cStart !== -1 && line.indexOf('-->', cStart) === -1) {
      inComment = true;
      out.push(highlightMarkupLine(line.slice(0, cStart)) + c.com(line.slice(cStart)));
      continue;
    }
    out.push(highlightMarkupLine(line));
  }
  return out;
}

function highlightMarkupLine(line) {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i);
      const stop = end === -1 ? n : end + 3;
      out += c.com(line.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = line[i];
    if (ch === '<' || (ch === '/' && line[i + 1] === '>')) {
      const m = /^<\/?([A-Za-z][\w:.-]*)?/.exec(line.slice(i));
      const tok = m ? m[0] : ch;
      out += c.op('<') + (m && m[1] ? c.tag(m[1]) : '');
      i += tok.length;
      continue;
    }
    if (ch === '>' ) {
      out += c.op('>');
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && line[j] !== ch) j++;
      j = Math.min(n, j + 1);
      out += c.str(line.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_:]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w:.-]/.test(line[j])) j++;
      const tok = line.slice(i, j);
      const rest = line.slice(j);
      out += /^\s*=/.test(rest) ? c.prop(tok) : tok;
      i = j;
      continue;
    }
    out += /\s/.test(ch) ? ch : c.op(ch);
    i++;
  }
  return out;
}

function highlightDiff(lines) {
  return lines.map((line) => {
    if (/^(\+\+\+|---)/.test(line)) return T.bold(c.op(line));
    if (/^@@/.test(line)) return c.hunk(line);
    if (/^(diff|index|new file|deleted file|similarity)/.test(line)) return c.op(line);
    if (line.startsWith('+')) return c.add(line);
    if (line.startsWith('-')) return c.del(line);
    return line;
  });
}

/**
 * 高亮一组代码行，返回等长的 ANSI 字符串数组。
 * 未知语言 / 空语言 → 原样返回（不加任何转义）。
 */
export function highlightLines(lines, lang) {
  const src = Array.isArray(lines) ? lines.map((l) => String(l ?? '')) : [];
  const id = normalizeLang(lang);
  if (!id) return src;
  if (id === 'diff') return highlightDiff(src);
  if (id === 'html') return highlightMarkup(src);
  const spec = SPECS[id];
  if (!spec) return src;
  const state = { block: null, quote: null };
  return src.map((line) => scanLine(line, spec, state));
}

/** 便捷入口：整段文本高亮后拼回去。 */
export function highlightToAnsi(code, lang) {
  return highlightLines(String(code ?? '').split('\n'), lang).join('\n');
}

/** 该语言是否有高亮支持。 */
export function isSupported(lang) {
  return !!normalizeLang(lang);
}
