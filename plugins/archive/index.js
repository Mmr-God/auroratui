// archive 插件：不解压直接查看/读取/搜索压缩包内容（zip / rar / 7z / tar.gz|bz2|xz）
// 重活交给同目录 worker.py（Python 3 + zipfile/tarfile/py7zr/rarfile），本文件只做工具壳与结果格式化。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(DIR, 'worker.py');
// 优先用绝对路径（避免 PATH 里的 WindowsApps stub 弹应用商店），失败再退回 PATH 里的名字
const PY_CANDIDATES = [
  'C:\\Users\\Administrator\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe',
  'python',
  'python3',
  'py',
];

let PY = null;
let PY_ERR = null;

function runPy(exe, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: (stderr || '') + (err && !stderr ? err.message : '') });
    });
  });
}

/** 找到一个能跑 worker.py 的 python（需要 zipfile/tarfile；rar/7z 见 skill 文档） */
async function findPython() {
  if (PY) return PY;
  const tried = [];
  for (const exe of PY_CANDIDATES) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) { tried.push(exe + ':不存在'); continue; }
    const r = await runPy(exe, ['-c', 'import sys,zipfile,tarfile;print(sys.version_info[0])']);
    if (r.ok && r.stdout.trim().startsWith('3')) return (PY = exe);
    tried.push(exe + ':' + (r.stderr || '版本非3').trim().split('\n')[0].slice(0, 80));
  }
  PY_ERR = '找不到可用的 Python 3（需要 zipfile/tarfile）。尝试过: ' + tried.join(' | ');
  throw new Error(PY_ERR);
}

async function callWorker(req, timeout = 300000) {
  const py = await findPython();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(req);
    const child = execFile(
      py,
      [WORKER],
      {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || err.message || '').trim().slice(0, 2000)));
        const line = (stdout || '').trim();
        if (!line) return reject(new Error('worker 无输出' + (stderr ? ': ' + stderr.slice(0, 500) : '')));
        let res;
        try {
          res = JSON.parse(line.slice(line.indexOf('{')));
        } catch (e) {
          return reject(new Error('worker 返回非 JSON: ' + line.slice(0, 500)));
        }
        if (!res.ok) return reject(new Error(res.error || '未知错误'));
        resolve(res);
      }
    );
    child.stdin.on('error', () => {});
    child.stdin.write(payload);
    child.stdin.end();
  });
}

function humanSize(n) {
  if (n == null) return '-';
  if (n < 1024) return n + 'B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + u[i];
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function fmtList(res, header) {
  const lines = [header];
  for (const e of res.entries) {
    lines.push(`${lpad(humanSize(e.size), 8)}  ${e.mtime || ''.padEnd(19)}  ${e.name}`);
  }
  if (res.truncated) lines.push(`… 仅显示前 ${res.shown} / ${res.total} 条（用 filter 收窄）`);
  else lines.push(`(共 ${res.total} 个条目)`);
  return lines.join('\n');
}

const fmtHits = (res) => {
  const out = [];
  for (const h of res.hits) {
    out.push(`${h.file}:${h.line}: ${h.text}`);
    if (h.context?.length) {
      for (const c of h.context) out.push(`    ${lpad(c.n, 5)}│ ${c.text}`);
    }
  }
  if (!res.hits.length) out.push('（无匹配）');
  if (res.truncated) out.push(`… 命中数已达上限，仅显示前 ${res.hits.length} 条`);
  out.push(`—— 扫描 ${res.scanned} 个文件` + (res.skipped.length ? `，跳过 ${res.skipped.length} 个（${res.skipped.slice(0, 5).map((s) => s.name + ':' + s.reason).join(', ')}）` : ''));
  return out.join('\n');
};

export default {
  name: 'archive',
  description: '压缩包免解压读取：zip/rar/7z/tar.gz 里 list、read 单个文件、grep 内容、按需解压',
  tools: [
    {
      name: 'archive_info',
      description: '查看压缩包概要：格式、条目数、总大小、压缩比、顶层目录。压缩包里有什么先看这个',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          archive: { type: 'string', description: '压缩包路径' },
          password: { type: 'string', description: '可选，加密包密码' },
        },
        required: ['archive'],
      },
      async execute({ archive, password }) {
        const r = await callWorker({ cmd: 'info', archive, password });
        return [
          `格式: ${r.kind}   大小: ${humanSize(r.archiveSize)}`,
          `条目: ${r.entries}（文件 ${r.files} / 目录 ${r.dirs}）  解压后总计: ${humanSize(r.totalSize)}  压缩比: ${r.ratio ?? '-'}`,
          `顶层: ${r.topLevel.join(', ') || '(空)'}`,
        ].join('\n');
      },
    },
    {
      name: 'archive_list',
      description: '列出压缩包内文件（不解压）。支持 filter 按 glob/子串过滤路径',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          archive: { type: 'string', description: '压缩包路径' },
          filter: { type: 'string', description: '可选，路径过滤：glob（*.cs）或子串（Unity），多个用逗号分隔' },
          showDirs: { type: 'boolean', description: '是否列出目录条目，默认 false' },
          limit: { type: 'number', description: '最多返回条数，默认 2000' },
          password: { type: 'string', description: '可选密码' },
        },
        required: ['archive'],
      },
      async execute({ archive, filter, showDirs = false, limit = 2000, password }) {
        const r = await callWorker({ cmd: 'list', archive, filter, showDirs, limit, password });
        return fmtList(r, `# ${path.basename(archive)}  [${r.kind}]` + (filter ? `  过滤=${filter}` : ''));
      },
    },
    {
      name: 'archive_read',
      description: '直接读取压缩包内某个文件的文本内容（不解压到磁盘）。entry 可写完整路径，也支持唯一的后缀匹配',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          archive: { type: 'string', description: '压缩包路径' },
          entry: { type: 'string', description: '包内文件路径，如 src/main.js；也接受唯一后缀如 main.js' },
          maxBytes: { type: 'number', description: '最多读取字节数，默认 2MB' },
          offset: { type: 'number', description: '可选，从第几字节开始读（大文件分段读）' },
          encoding: { type: 'string', description: '可选，text 编码，默认 auto（utf-8→gbk→utf-16 依次尝试）' },
          password: { type: 'string', description: '可选密码' },
        },
        required: ['archive', 'entry'],
      },
      async execute({ archive, entry, maxBytes = 2 * 1024 * 1024, offset = 0, encoding = 'auto', password }) {
        const r = await callWorker({ cmd: 'read', archive, entry, maxBytes, offset, encoding, password });
        if (r.binary) {
          return `# ${r.entry}  (${humanSize(r.size)}) 二进制文件\nhex: ${r.preview}`;
        }
        const tail = r.truncated ? `\n… [截断] 只读了 ${humanSize(r.bytesRead)} / ${humanSize(r.size)}，可继续用 offset=${offset + r.bytesRead}` : '';
        return `# ${r.entry}  (${humanSize(r.size)}, ${r.encoding})\n${r.content}${tail}`;
      },
    },
    {
      name: 'archive_grep',
      description: '在压缩包内的所有文本文件里正则搜索（不解压）。找配置项、类名、报错文本很方便',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          archive: { type: 'string', description: '压缩包路径' },
          pattern: { type: 'string', description: '正则表达式（JS/Python 风格）' },
          filter: { type: 'string', description: '可选，只搜匹配此 glob/子串的文件' },
          ignoreCase: { type: 'boolean', description: '忽略大小写，默认 false' },
          context: { type: 'number', description: '每处命中附带的上下文行数，默认 0' },
          maxHits: { type: 'number', description: '最多命中数，默认 100' },
          maxFileSize: { type: 'number', description: '单文件超过多少字节跳过，默认 5MB' },
          password: { type: 'string', description: '可选密码' },
        },
        required: ['archive', 'pattern'],
      },
      async execute(input) {
        const r = await callWorker({ cmd: 'grep', maxHits: 100, ...input });
        return fmtHits(r);
      },
    },
    {
      name: 'archive_extract',
      description: '把整个包或指定文件解压到目标目录（需要落地文件时才用；只看内容用 list/read/grep 更快）',
      parameters: {
        type: 'object',
        properties: {
          archive: { type: 'string', description: '压缩包路径' },
          dest: { type: 'string', description: '目标目录' },
          entries: { type: 'array', items: { type: 'string' }, description: '可选，只解压这些条目；省略=全部' },
          password: { type: 'string', description: '可选密码' },
        },
        required: ['archive', 'dest'],
      },
      async execute({ archive, dest, entries, password }) {
        const r = await callWorker({ cmd: 'extract', archive, dest, entries, password });
        return `已解压 ${r.count} 个文件 → ${r.dest}\n` + r.files.slice(0, 50).join('\n') +
          (r.files.length > 50 ? `\n… 还有 ${r.count - 50} 个` : '');
      },
    },
  ],
};
