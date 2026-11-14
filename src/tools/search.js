// Search & navigation tools: glob, grep, ls (tree), think.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'coverage', '.turbo', '.pnpm-store']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.sqlite', '.db', '.class', '.o', '.a', '.bin', '.wasm']);

async function rgAvailable() {
  if (rgAvailable.cache !== undefined) return rgAvailable.cache;
  try {
    await execFileAsync('rg', ['--version'], { timeout: 4000 });
    rgAvailable.cache = true;
  } catch {
    rgAvailable.cache = false;
  }
  return rgAvailable.cache;
}

async function walk(root, { limit = 4000, maxDepth = 12 } = {}) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length && out.length < limit) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= limit) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (depth < maxDepth) stack.push([full, depth + 1]);
        out.push({ path: full, dir: true, depth });
      } else if (ent.isFile()) {
        out.push({ path: full, dir: false, depth });
      }
    }
  }
  return out;
}

/** Convert a glob (**, *, ?, {a,b}) into a RegExp over POSIX-style paths. */
export function globToRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slashNext = p[i + 2] === '/';
        re += slashNext ? '(?:.*/)?' : '.*';
        i += slashNext ? 2 : 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      re += '(?:';
      braceDepth++;
    } else if (c === '}' && braceDepth > 0) {
      re += ')';
      braceDepth--;
    } else if (c === ',' && braceDepth > 0) re += '|';
    else if ('+.^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

function relish(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

async function globSearch({ pattern, cwd, ignore = [], limit = 200, root }) {
  const base = root ? path.resolve(cwd, root) : cwd;
  const rx = globToRegExp(pattern);
  const ignores = ignore.map((g) => globToRegExp(g));
  const files = await walk(base);
  const hits = [];
  for (const f of files) {
    if (f.dir) continue;
    if (BINARY_EXT.has(path.extname(f.path).toLowerCase())) continue;
    const rel = relish(base, f.path);
    if (!rx.test(rel)) continue;
    if (ignores.some((r) => r.test(rel))) continue;
    let size = 0;
    let mtime = 0;
    try {
      const st = await fsp.stat(f.path);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {}
    hits.push({ rel, size, mtime });
    if (hits.length >= limit) break;
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return { base, hits };
}

export const globTool = {
  name: 'glob',
  readOnly: true,
  description: '按 glob 模式查找文件（**/*.js、src/**/*.{ts,tsx} 等）。返回按修改时间排序的相对路径，用于定位文件而不必先猜路径。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，例如 **/*.test.js' },
      path: { type: 'string', description: '搜索根目录，默认当前工作目录' },
      ignore: { type: 'array', items: { type: 'string' }, description: '要排除的 glob 列表' },
      limit: { type: 'integer', description: '最多返回条数（默认 200）' },
    },
    required: ['pattern'],
  },
  async execute({ pattern, path: root, ignore = [], limit = 200 }, ctx) {
    if (!pattern) return { content: '缺少 pattern。', isError: true };
    const { hits, base } = await globSearch({ pattern, cwd: ctx.cwd, root, ignore, limit });
    if (!hits.length) return { content: `没有匹配 ${pattern} 的文件（在 ${base} 下）。` };
    const lines = hits.map((h) => `${h.rel}  (${fmtSize(h.size)})`);
    return {
      content: `${hits.length} 个文件匹配 ${pattern}（根目录 ${base}）：\n${lines.join('\n')}`,
      meta: { count: hits.length, files: hits.map((h) => h.rel) },
    };
  },
};

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export const grepTool = {
  name: 'grep',
  readOnly: true,
  description: '在文件内容中按正则搜索（类似 ripgrep）。返回 文件:行号:内容，可选上下文行。用于定位符号定义、报错文本、配置项。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（JS 语法）' },
      path: { type: 'string', description: '搜索目录或单个文件，默认当前工作目录' },
      glob: { type: 'string', description: '只搜索匹配此 glob 的文件，例如 **/*.js' },
      ignore_case: { type: 'boolean', description: '忽略大小写' },
      context: { type: 'integer', description: '前后各显示多少行上下文（默认 0）' },
      limit: { type: 'integer', description: '最多匹配条数（默认 100）' },
    },
    required: ['pattern'],
  },
  async execute({ pattern, path: root, glob, ignore_case, context = 0, limit = 100 }, ctx) {
    if (!pattern) return { content: '缺少 pattern。', isError: true };
    let rx;
    try {
      rx = new RegExp(pattern, ignore_case ? 'i' : '');
    } catch (e) {
      return { content: `正则无效: ${e.message}`, isError: true };
    }
    const base = root ? path.resolve(ctx.cwd, root) : ctx.cwd;
    const filter = glob ? globToRegExp(glob) : null;

    if (await rgAvailable()) {
      const args = ['--no-heading', '--line-number', '--color', 'never', '--max-count', '1000'];
      if (ignore_case) args.push('-i');
      if (context) args.push('-C', String(context));
      if (filter) args.push('--glob', glob.replace(/^\*\*\//, ''));
      args.push(pattern, base);
      try {
        const { stdout } = await execFileAsync('rg', args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
        const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
        if (!lines.length) return { content: `没有匹配 ${pattern} 的内容。` };
        return { content: lines.map((l) => l.replace(base + path.sep, '').replace(base + '/', '')).join('\n'), meta: { engine: 'rg', count: lines.length } };
      } catch (e) {
        if (e.code === 1) return { content: `没有匹配 ${pattern} 的内容。` };
        /* fall through to JS implementation */
      }
    }

    const files = [];
    let st;
    try {
      st = await fsp.stat(base);
    } catch {
      return { content: `路径不存在: ${base}`, isError: true };
    }
    if (st.isFile()) files.push(base);
    else for (const f of await walk(base, { limit: 20000 })) if (!f.dir) files.push(f.path);

    const out = [];
    for (const file of files) {
      if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
      const rel = relish(base, file);
      if (filter && !filter.test(rel)) continue;
      let text;
      try {
        const buf = await fsp.readFile(file);
        if (buf.includes(0)) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!rx.test(lines[i])) continue;
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        for (let k = from; k <= to; k++) {
          const mark = k === i ? ':' : '-';
          out.push(`${rel}${mark}${k + 1}${mark}${lines[k].slice(0, 400)}`);
        }
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    if (!out.length) return { content: `没有匹配 ${pattern} 的内容（在 ${base} 下）。` };
    return { content: out.slice(0, limit).join('\n'), meta: { engine: 'js', count: out.length } };
  },
};

export const lsTool = {
  name: 'ls',
  readOnly: true,
  description: '列出目录内容（类 tree，默认两层）。用于动手前看一眼现场：项目结构、有哪些文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录，默认当前工作目录' },
      depth: { type: 'integer', description: '递归层数（默认 2，最大 5）' },
      all: { type: 'boolean', description: '包含点文件' },
    },
  },
  async execute({ path: root, depth = 2, all = false }, ctx) {
    const base = root ? path.resolve(ctx.cwd, root) : ctx.cwd;
    const maxDepth = Math.min(Math.max(1, depth), 5);
    const lines = [];
    let count = 0;
    const limit = 400;
    const rec = async (dir, level, prefix) => {
      if (level > maxDepth || count >= limit) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        lines.push(`${prefix}(无法读取: ${e.code})`);
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (count >= limit) return;
        if (!all && ent.name.startsWith('.')) continue;
        if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) {
          lines.push(`${prefix}${ent.name}/  …`);
          continue;
        }
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          lines.push(`${prefix}${ent.name}/`);
          count++;
          await rec(full, level + 1, prefix + '  ');
        } else {
          let size = 0;
          try {
            size = (await fsp.stat(full)).size;
          } catch {}
          lines.push(`${prefix}${ent.name}  ${fmtSize(size)}`);
          count++;
        }
      }
    };
    const st = await fsp.stat(base).catch(() => null);
    if (!st) return { content: `路径不存在: ${base}`, isError: true };
    if (st.isFile()) return { content: `${path.relative(ctx.cwd, base) || base}  ${fmtSize(st.size)}` };
    await rec(base, 1, '');
    return { content: `${base}\n${lines.join('\n')}${count >= limit ? '\n… (已截断)' : ''}` };
  },
};

export const thinkTool = {
  name: 'think',
  readOnly: true,
  description: '把中间推理写下来（不给用户看，仅记录到日志）。做复杂决策前先写清计划和取舍，能显著减少跑偏。',
  parameters: {
    type: 'object',
    properties: {
      thought: { type: 'string', description: '你的推理内容' },
    },
    required: ['thought'],
  },
  async execute({ thought = '' }) {
    return { content: '已记录。继续执行。', meta: { thought: String(thought).slice(0, 200) } };
  },
};
