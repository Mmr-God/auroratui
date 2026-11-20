// Basic tools: read / write / edit — pi-style precise editing.
import fs from 'node:fs';
import path from 'node:path';
import { fmtBytes, fmtNum } from '../util.js';

const NL = "\n";
const MAX_READ_BYTES = 60 * 1024;
const MAX_LINES = 2000;

function resolve(ctx, p) {
  if (!p) throw new Error('缺少 path 参数');
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

/** 供其他工具（patch）复用同一套路径解析。 */
export function resolvePath(ctx, p) {
  return resolve(ctx, p);
}

/** True when `file` lives inside the workspace directory `cwd`. */
function insideCwd(ctx, file) {
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const abs = path.resolve(file);
  const rel = path.relative(cwd, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Workspace guard: writing outside the workspace requires the user to have turned
 * on 全权模式 (/trust) — otherwise we refuse and tell the model what to say.
 */
export function guardWrite(ctx, file, what) {
  // 团队成员的「文件范围」：只允许改自己负责的文件。
  // 靠提示词约束不够（实测成员会顺手去改同事的文件、或替同事打补丁），这里是真的拦。
  const scope = Array.isArray(ctx?.writeScope) && ctx.writeScope.length ? ctx.writeScope : null;
  if (scope) {
    const cwd = path.resolve(ctx.cwd || process.cwd());
    const abs = path.resolve(file);
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    const ok = scope.some((raw) => {
      const s = String(raw || '').trim().replace(/\\/g, '/');
      if (!s) return false;
      // 以 / 结尾，或者名字里没有扩展名 → 当目录前缀匹配；否则当精确文件
      const isDir = s.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(s);
      const pat = s.replace(/^\.\//, '').replace(/\/+$/, '');
      if (!pat) return false;
      return isDir ? rel === pat || rel.startsWith(pat + '/') : rel === pat;
    });
    // 越出工作区的交给下面的全权模式检查（这里只管团队内部文件划分）
    if (!ok && insideCwd(ctx, abs)) {
      return {
        isError: true,
        content:
          `${what}被拒绝：${rel} 不在你负责的文件范围内。\n` +
          `你负责的是：${scope.join(', ')}\n` +
          '团队里每个人只写自己那份，不要改同事的文件（他们正在改，会互相覆盖）。\n' +
          '如果确实必须改，就在最终交代里说明理由，让队长来统一处理。',
      };
    }
  }
  if (!ctx || ctx.allowOutside) return null;
  if (insideCwd(ctx, file)) return null;
  return {
    isError: true,
    content:
      `${what}被拒绝：${file} 在工作区 ${path.resolve(ctx.cwd)} 之外。
` +
      '当前是「工作区模式」。需要修改工作区之外的文件时，请让用户先执行 /trust 打开全权模式（再执行 /trust 可关闭）。',
  };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------- 图片读取
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** 从文件头猜图片尺寸（PNG / JPEG / GIF / BMP / WebP），失败返回 null。 */
export function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

export const readTool = {
  name: 'read',
  label: 'Read',
  readOnly: true,
  description:
    '读取文件内容（带行号）。默认最多 2000 行 / 60KB。用 offset/limit 读取大文件的片段。路径可以是目录（返回目录列表）；也可以是图片（png/jpg/jpeg/gif/webp/bmp）——会直接把图片交给你看，用于看截图、设计稿、报错截图。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对或绝对）' },
      offset: { type: 'number', description: '起始行号（1-based，可选）' },
      limit: { type: 'number', description: '最多读取行数（可选）' },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    const file = resolve(ctx, input.path);
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch (e) {
      if (e.code === 'ENOENT') {
        const base = path.dirname(file);
        let hint = '';
        try {
          const sibs = await fs.promises.readdir(base);
          const near = sibs
            .filter((s) => s.toLowerCase().includes(path.basename(file).toLowerCase().slice(0, 4)))
            .slice(0, 8);
          if (near.length) hint = `\n相似文件: ${near.join(', ')}`;
        } catch {}
        return { isError: true, content: `文件不存在: ${file}${hint}`, meta: { kind: 'read', path: file } };
      }
      return { isError: true, content: `读取失败: ${e.message}`, meta: { kind: 'read', path: file } };
    }
    if (st.isDirectory()) {
      const entries = await fs.promises.readdir(file, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, 400)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return {
        content: `目录 ${file} (${entries.length} 项):\n${lines.join('\n')}${entries.length > 400 ? '\n…' : ''}`,
        meta: { kind: 'read', path: file, dir: true, lines: lines.length },
      };
    }
    if (st.size > 12 * 1024 * 1024) {
      return { isError: true, content: `文件过大 (${fmtBytes(st.size)})，请用 shell 的 head/sed 分段读取`, meta: { kind: 'read', path: file } };
    }
    const buf = await fs.promises.readFile(file);
    // 图片：不返回文本，而是把图片本身交给模型（需要模型支持识图）
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
    if (mime) {
      if (buf.length > MAX_IMAGE_BYTES) {
        return {
          isError: true,
          content: `图片过大 (${fmtBytes(buf.length)})，单张上限 ${fmtBytes(MAX_IMAGE_BYTES)}。先用 shell 缩小：\n  ffmpeg -i "${file}" -vf scale=1280:-1 out.png\n或直接传给模型看更小的一张。`,
          meta: { kind: 'read', path: file },
        };
      }
      const size = imageSize(buf);
      const dim = size ? ` ${size.width}x${size.height}` : '';
      return {
        content: `[图片] ${path.basename(file)}${dim} · ${mime} · ${fmtBytes(buf.length)}\n（图片已直接附在对话里，你可以看到它）`,
        meta: {
          kind: 'image',
          path: file,
          bytes: buf.length,
          images: [{ mime, base64: buf.toString('base64'), width: size?.width, height: size?.height, path: file }],
        },
      };
    }
    if (looksBinary(buf)) {
      return { isError: true, content: `二进制文件 (${fmtBytes(st.size)})，无法以文本读取`, meta: { kind: 'read', path: file } };
    }
    const text = buf.toString('utf8');
    const all = text.split('\n');
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.max(1, Math.min(MAX_LINES, Number(input.limit) || MAX_LINES));
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}\u2192${l}`).join('\n');
    let out = numbered;
    let truncated = false;
    if (offset - 1 + slice.length < all.length) {
      out += `\n\n…(${fmtNum(all.length - (offset - 1 + slice.length))} 行未显示，用 offset=${offset + slice.length} 继续)`;
      truncated = true;
    }
    if (Buffer.byteLength(out) > MAX_READ_BYTES) {
      out = out.slice(0, MAX_READ_BYTES) + '\n…(内容过大已截断)';
      truncated = true;
    }
    return {
      content: out || '(空文件)',
      meta: { kind: 'read', path: file, lines: slice.length, total: all.length, bytes: st.size, truncated },
    };
  },
};

export const writeTool = {
  name: 'write',
  label: 'Write',
  description:
    '把完整内容写入文件（会覆盖已有文件，自动创建父目录）。新建文件首选；修改已有文件的局部内容请用 edit。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  async execute(input, ctx) {
    const file = resolve(ctx, input.path);
    if (typeof input.content !== 'string') return { isError: true, content: '缺少 content 参数' };
    const denied = guardWrite(ctx, file, '写入');
    if (denied) return denied;
    let existed = false;
    let prev = '';
    try {
      prev = await fs.promises.readFile(file, 'utf8');
      existed = true;
    } catch {}
    try {
      ctx?.checkpoints?.save(file, 'write');
    } catch {}
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, input.content, 'utf8');
    const lines = input.content.split('\n').length;
    const bytes = Buffer.byteLength(input.content);
    const diff = existed ? unidiff(prev, input.content, file) : null;
    return {
      content: `${existed ? '已覆盖' : '已创建'} ${file} — ${lines} 行 / ${fmtBytes(bytes)}`,
      meta: { kind: 'write', path: file, lines, bytes, existed, diff, added: lines, removed: existed ? prev.split('\n').length : 0 },
    };
  },
};

export const editTool = {
  name: 'edit',
  label: 'Edit',
  description:
    '精确替换文件中的文本片段（比 write 更高效）。old_string 必须在文件中唯一出现；批量修改用 edits 数组（一次读改写，高效）。' +
    '优先提供足够上下文以保证唯一性，或用 replace_all。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原文（需唯一匹配）' },
      new_string: { type: 'string', description: '替换后的文本；空字符串表示删除' },
      replace_all: { type: 'boolean', description: '替换所有出现位置' },
      edits: {
        type: 'array',
        description: '一次执行多处修改，按顺序应用',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    const file = resolve(ctx, input.path);
    const denied = guardWrite(ctx, file, '修改');
    if (denied) return denied;
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (e) {
      return { isError: true, content: `无法读取 ${file}: ${e.message}` };
    }
    const ops = Array.isArray(input.edits) && input.edits.length
      ? input.edits
      : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
    if (!ops.length || typeof ops[0].old_string !== 'string') {
      return { isError: true, content: '缺少 old_string（或 edits 数组）' };
    }
    let cur = text;
    const failures = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const oldS = op.old_string;
      const newS = op.new_string ?? '';
      if (oldS === '') {
        failures.push(`edit#${i + 1}: old_string 不能为空`);
        continue;
      }
      const r = applyOne(cur, oldS, newS, !!op.replace_all);
      if (r.error) {
        failures.push(`edit#${i + 1}: ${r.error}`);
        continue;
      }
      cur = r.text;
    }
    if (failures.length) {
      const head = `编辑失败（${failures.length}/${ops.length}）：\n${failures.join('\n')}`;
      const howTo = '\n提示：先 read 文件确认原文（注意缩进/空格/换行），或缩小 old_string 范围。';
      return { isError: true, content: head + howTo, meta: { kind: 'edit', path: file, failed: true } };
    }
    if (cur === text) return { content: `内容无变化: ${file}`, meta: { kind: 'edit', path: file, added: 0, removed: 0 } };
    try {
      ctx?.checkpoints?.save(file, 'edit');
    } catch {}
    await fs.promises.writeFile(file, cur, 'utf8');
    const diff = unidiff(text, cur, file);
    const ops2 = diffLines(text, cur);
    const added = ops2.filter((o) => o.type === 'add').length;
    const removed = ops2.filter((o) => o.type === 'del').length;
    const summary = `已编辑 ${file}：+${added} / -${removed} 行`;
    return {
      content: `${summary}\n${diff.slice(0, 3000)}`,
      meta: { kind: 'edit', path: file, added, removed, diff, ok: true },
    };
  },
};

// --- matching -------------------------------------------------------------
function applyOne(text, oldS, newS, replaceAll) {
  // 1. exact match (fast path)
  const idxs = findAll(text, oldS);
  if (idxs.length === 1) {
    return { text: text.slice(0, idxs[0]) + newS + text.slice(idxs[0] + oldS.length) };
  }
  if (replaceAll && idxs.length) return { text: text.split(oldS).join(newS) };
  if (idxs.length > 1) {
    return { error: `old_string 出现 ${idxs.length} 次，不唯一。请增加上下文，或用 replace_all` };
  }
  // 2. indent/whitespace tolerant line match (unique hit only)
  const fm = flexibleMatch(text, oldS);
  if (fm) return { text: text.slice(0, fm.start) + newS + text.slice(fm.end), fuzzy: true };
  return { error: 'old_string 未在文件中找到（注意缩进、空格与换行需一致）' };
}

function findAll(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    out.push(i);
    i += Math.max(1, needle.length);
  }
  return out;
}

function nthLineOffset(s, n) {
  let pos = 0;
  for (let i = 1; i < n; i++) {
    const nx = s.indexOf(NL, pos);
    if (nx === -1) return s.length;
    pos = nx + 1;
  }
  return pos;
}

function flexibleMatch(text, oldS) {
  const oldLines = oldS.replace(/\r\n/g, '\n').split('\n');
  const textLines = text.replace(/\r\n/g, '\n').split('\n');
  const key = (l) => l.replace(/^\s+/, '').replace(/\s+$/, '');
  const hits = [];
  for (let i = 0; i + oldLines.length <= textLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (key(textLines[i + j]) !== key(oldLines[j])) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return null;
  const startLine = hits[0];
  const start = nthLineOffset(text, startLine + 1);
  const end = startLine + oldLines.length >= textLines.length ? text.length : nthLineOffset(text, startLine + oldLines.length + 1) - 1;
  return { start, end };
}

// --- diff -----------------------------------------------------------------
// Small LCS line diff, used for display + edit summaries.
export function unidiff(a, b, file = 'file') {
  const A = a.split('\n');
  const B = b.split('\n');
  const ops = diffLines(A, B);
  const out = [`--- ${file}`, `+++ ${file}`];
  let ctx = 0;
  for (const op of ops) {
    if (op.type === 'eq') {
      ctx++;
      if (ctx <= 2) out.push('  ' + op.line);
    } else {
      ctx = 0;
      const sign = op.type === 'add' ? '+' : '-';
      out.push(sign + ' ' + op.line);
    }
  }
  return out.join('\n');
}

function diffLines(A, B) {
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) {
    // fallback for huge files: naive prefix/suffix trim
    return naiveDiff(A, B);
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ type: 'eq', line: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: A[i++] });
    } else {
      ops.push({ type: 'add', line: B[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', line: A[i++] });
  while (j < m) ops.push({ type: 'add', line: B[j++] });
  return ops;
}

function naiveDiff(A, B) {
  const ops = [];
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) ops.push({ type: 'eq', line: A[i] ?? '' });
    else {
      if (A[i] !== undefined) ops.push({ type: 'del', line: A[i] });
      if (B[i] !== undefined) ops.push({ type: 'add', line: B[i] });
    }
  }
  return ops;
}

export { unidiff as makeUnifiedDiff };
