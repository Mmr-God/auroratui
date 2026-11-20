// 团队成员的「文件范围」守卫（shell 版）。
//
// 背景：fs / patch 工具的写入已经由 guardWrite 拦住了，但 shell 是个后门 ——
// 成员 B 一句 `echo x > src/a.js` 就能改掉成员 A 正在写的文件，
// 「按文件拆开、互不覆盖」这个团队协作的前提就漏了。
//
// 这里的做法是**静态看命令**，把「会落盘到哪个路径」抽出来，再和 writeScope 比。
// 不是沙箱（真要有心绕过总有办法），但足以拦住模型无意识的顺手越界 ——
// 实测成员越界几乎都是 cp / mv / sed -i / 重定向这几种。
//
// 只对**有 writeScope 的上下文**（团队成员）生效；主代理 / 单发子代理照旧。

import path from 'node:path';

/** 会写文件、且第一个非选项参数就是目标路径的命令。 */
const TARGET_FIRST = new Set([
  'tee', 'touch', 'mkdir', 'rmdir', 'rm', 'unlink', 'shred', 'chmod', 'chown', 'truncate',
]);

/** 源在前、目标在后；且**源也会被改**（删掉源 = 也是对源目录的写）。 */
const TARGET_LAST = new Set(['cp', 'mv', 'ln', 'install', 'rsync', 'scp']);
/** 这些的源会消失（移动 / 上传后删除），所以源也必须在自己范围内。 */
const SRC_MUTATED = new Set(['mv', 'rsync', 'scp']);

/** 危险到直接拒的整条命令（这些能重写/撤销任意文件，静态判断不可靠）。 */
const DANGEROUS = [
  { re: /\bgit\s+(checkout|restore)\b/, why: 'git checkout/restore 会覆盖工作区文件' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'git reset --hard 会丢弃所有改动' },
  { re: /\bgit\s+(clean)\b/, why: 'git clean 会删除未跟踪文件' },
  { re: /\bgit\s+(apply|am|stash\s+pop|stash\s+apply)\b/, why: '这些命令会成批改写工作区文件' },
  { re: /\bfind\b[^|;]*\s-delete\b/, why: 'find -delete 会批量删文件' },
];

/** 把命令切成「一条条独立命令」的分段（按 ; | & && || 换行）。 */
function segments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  const src = String(command || '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      // 吃掉 && / || 的第二个字符
      if ((ch === '&' || ch === '|') && (src[i + 1] === ch)) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 粗略分词：保留引号内容，去掉引号本身。 */
function words(seg) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** 是不是一个「看起来像路径」的 token（排除 -flag、纯数字、URL）。 */
function asPath(tok) {
  const t = String(tok || '');
  if (!t || t === '-' || t.startsWith('-')) return null;
  if (/^(https?|ftp):\/\//i.test(t)) return null;
  if (t === '/dev/null') return null;
  return t;
}

/**
 * 从一条命令里抽出所有「会被写到」的路径（相对基准目录解析后的相对路径）。
 * 抽不准的（比如 xargs、脚本文件）宁可漏，也不要误伤正常命令。
 */
export function writeTargets(command, cwd = process.cwd()) {
  const targets = [];
  // 逐段维护基准目录：`cd src && echo x > a.js` 里的 a.js 是相对 src 的
  let base = '.';
  const push = (p) => {
    if (!p) return;
    const raw = String(p).replace(/\\/g, '/');
    // 绝对路径不能被 base 拼接（posix.join('.', '/tmp/x') 会把前导斜杠吃掉）
    if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
      targets.push(path.posix.normalize(raw));
      return;
    }
    targets.push(path.posix.normalize(path.posix.join(base.replace(/\\/g, '/'), raw)));
  };
  for (const seg of segments(command)) {
    const ws = words(seg);
    if (!ws.length) continue;
    // 重定向：> file / >> file / 2> file / &> file（不要求前后无空格）
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      const m = /^(?:\d?|&)?>{1,2}\|?$/.exec(w);
      if (m && ws[i + 1]) {
        const p = asPath(ws[i + 1]);
        if (p) push(p);
        continue;
      }
      // 粘在一起的写法：>out.txt
      const inline = /^(?:\d?|&)?>{1,2}\|?(.+)$/.exec(w);
      if (inline && !m) {
        const p = asPath(inline[1]);
        if (p) push(p);
      }
    }
    // 跳过 VAR=x 前缀和 sudo/env 之类的包装
    let k = 0;
    while (k < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k]) || /^(sudo|command|env|time|nice|xargs)$/.test(ws[k]))) k++;
    const name = (ws[k] || '').toLowerCase().replace(/\\/g, '/').split('/').pop();
    const args = ws.slice(k + 1);
    const plain = args.filter((a) => asPath(a));

    // cd：只影响后续段的相对路径基准，本身不写盘
    if (name === 'cd') {
      const to = plain[0];
      if (to) base = path.posix.normalize(path.posix.join(base.replace(/\\/g, '/'), to.replace(/\\/g, '/')));
      continue;
    }
    if (TARGET_FIRST.has(name)) {
      if (plain[0]) push(plain[0]);
    } else if (TARGET_LAST.has(name)) {
      const last = plain[plain.length - 1];
      if (last) push(last);
      if (SRC_MUTATED.has(name)) {
        for (const src of plain.slice(0, -1)) push(src);
      }
    } else if (name === 'dd') {
      for (const a of args) {
        const m = /^of=(.+)$/.exec(a);
        if (m) push(m[1]);
      }
    } else if (name === 'sed' || name === 'perl') {
      // 只有带 -i 才算写；没 -e 时第一个非选项参数是脚本本身，不能当路径
      const hasI = args.some((a) => a === '-i' || /^-[a-zA-Z]*i/.test(a));
      if (hasI) {
        const hasE = args.some((a) => a === '-e' || /^-[a-zA-Z]*e/.test(a));
        const files = hasE ? plain : plain.slice(1);
        for (const f of files) push(f);
      }
    } else if (name === 'git') {
      // git checkout/restore 后面跟的具体路径（整条命令的危险性由 DANGEROUS 兜）
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'checkout' || sub === 'restore') {
        for (const a of plain) push(a);
      }
    }
  }
  return [...new Set(targets)];
}

/** 这个相对/绝对路径是否落在 writeScope 里（和 fs.js 的 guardWrite 同一套判定）。 */
export function inScope(scope, cwd, file) {
  const list = Array.isArray(scope) ? scope : [];
  if (!list.length) return true;
  const abs = path.resolve(cwd || process.cwd(), file);
  const rel = path.relative(path.resolve(cwd || process.cwd()), abs).split(path.sep).join('/');
  // 越出工作区的交给全权模式那套，这里只管团队内部划分
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  return list.some((raw) => {
    const s = String(raw || '').trim().replace(/\\/g, '/');
    if (!s) return false;
    const isDir = s.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(s);
    const pat = s.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pat) return false;
    return isDir ? rel === pat || rel.startsWith(pat + '/') : rel === pat;
  });
}

/**
 * 检查一条 shell 命令会不会越界写文件。
 * @returns {null | {isError:true, content:string}} null = 放行
 */
export function guardShellScope(command, ctx) {
  const scope = Array.isArray(ctx?.writeScope) && ctx.writeScope.length ? ctx.writeScope : null;
  if (!scope) return null;
  const cmd = String(command || '');
  if (!cmd.trim()) return null;

  const deny = (why, hit) =>
    ({
      isError: true,
      content:
        `命令被拒绝执行：${why}${hit ? `（${hit}）` : ''}。\n` +
        `你负责的文件范围是：${scope.join(', ')}\n` +
        '团队里每个人只写自己那份文件，不要动同事正在改的东西（会互相覆盖）。\n' +
        '如果确实必须改范围外的文件：在最终交代里写清「需要改 X，因为…」，交给队长统一处理；\n' +
        '或者换一种只读的写法（用 cat / grep 查看，而不是改动）。',
    });

  for (const d of DANGEROUS) {
    if (d.re.test(cmd)) return deny(d.why);
  }

  const targets = writeTargets(cmd, ctx?.cwd);
  const outside = targets.filter((t) => !inScope(scope, ctx?.cwd, t));
  if (outside.length) {
    return deny('它会写到你的文件范围之外', outside.join('、'));
  }
  return null;
}
