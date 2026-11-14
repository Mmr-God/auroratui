// Read-only git tools (status / log / diff / show / blame) and a generic HTTP client.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 20000;

async function git(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { ok: true, out: (stdout || '').trim(), err: (stderr || '').trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || e.message || '').trim() };
  }
}

const clip = (s, n = 12000) => (s.length > n ? `${s.slice(0, n)}\n…(已截断，共 ${s.length} 字符)` : s);

export const gitTool = {
  name: 'git',
  readOnly: true,
  description: '只读 git 操作：status / log / diff / show / blame / branches。用于了解「改了什么、谁改的、为什么」。不会执行提交、推送、reset 等写操作。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'log', 'diff', 'show', 'blame', 'branches'], description: '要执行的只读操作' },
      path: { type: 'string', description: 'blame / show 时的文件路径，或仓库目录（默认当前目录）' },
      ref: { type: 'string', description: 'commit / branch，默认 HEAD' },
      lines: { type: 'integer', description: 'log 条数（默认 15）' },
      staged: { type: 'boolean', description: 'diff 是否只看已暂存' },
    },
    required: ['action'],
  },
  async execute({ action = 'status', path: target, ref = 'HEAD', lines = 15, staged }, ctx) {
    const cwd = target && !/\.\w+$/.test(target) ? ctx.cwd : ctx.cwd;
    const name = action.toLowerCase();
    if (name === 'status') {
      const r = await git(['status', '--short', '--branch'], cwd);
      if (!r.ok) return { content: `git 失败: ${r.err || r.out}`, isError: true };
      return { content: r.out || '(工作区干净)' };
    }
    if (name === 'log') {
      const r = await git(['log', `-n${Math.min(Math.max(1, lines), 100)}`, '--pretty=format:%h %ad %an: %s', '--date=short', ref === 'HEAD' ? '' : ref].filter(Boolean), cwd);
      if (!r.ok) return { content: `git 失败: ${r.err || r.out}`, isError: true };
      return { content: r.out || '(没有提交)' };
    }
    if (name === 'diff') {
      const args = ['diff', '--stat'];
      if (staged) args.push('--cached');
      const stat = await git(args, cwd);
      const full = await git([...args.filter((a) => a !== '--stat'), '--unified=3'], cwd);
      if (!stat.ok && !full.ok) return { content: `git 失败: ${stat.err || full.err}`, isError: true };
      return { content: clip(`${stat.out ? stat.out + '\n\n' : ''}${full.out || '(无改动)'}`) };
    }
    if (name === 'show') {
      const r = await git(['show', '--stat', '--patch', ref], cwd);
      if (!r.ok) return { content: `git 失败: ${r.err || r.out}`, isError: true };
      return { content: clip(r.out) };
    }
    if (name === 'blame') {
      if (!target) return { content: 'blame 需要 path。', isError: true };
      const r = await git(['blame', '--date=short', target], cwd);
      if (!r.ok) return { content: `git 失败: ${r.err || r.out}`, isError: true };
      return { content: clip(r.out) };
    }
    if (name === 'branches') {
      const r = await git(['branch', '-vv', '--all'], cwd);
      if (!r.ok) return { content: `git 失败: ${r.err || r.out}`, isError: true };
      return { content: r.out || '(没有分支)' };
    }
    return { content: `未知 action: ${action}`, isError: true };
  },
};

export const httpTool = {
  name: 'http_request',
  readOnly: true,
  description: '发起一次 HTTP 请求（GET/POST/PUT/PATCH/DELETE），返回状态码、响应头和响应体（JSON 自动美化）。用于调用外部 API；读网页请用 web_fetch。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
      method: { type: 'string', description: 'GET / POST / PUT / PATCH / DELETE，默认 GET' },
      headers: { type: 'object', description: '请求头对象' },
      body: { type: 'string', description: '请求体字符串（JSON 请自行序列化）' },
      timeout_ms: { type: 'integer', description: '超时毫秒，默认 20000' },
    },
    required: ['url'],
  },
  async execute({ url, method = 'GET', headers = {}, body, timeout_ms: timeout = 20000 }) {
    if (!/^https?:\/\//i.test(url || '')) return { content: 'url 必须以 http:// 或 https:// 开头。', isError: true };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(Math.max(1000, timeout), 120000));
    try {
      const res = await fetch(url, { method: method.toUpperCase(), headers, body: method.toUpperCase() === 'GET' ? undefined : body, signal: ac.signal, redirect: 'follow' });
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      let shown = text;
      if (ct.includes('json')) {
        try {
          shown = JSON.stringify(JSON.parse(text), null, 2);
        } catch {}
      }
      const head = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
      const content = `${res.status} ${res.statusText}\n${head}\n\n${clip(shown, 16000)}`;
      return { content, isError: !res.ok, meta: { status: res.status, bytes: text.length } };
    } catch (e) {
      return { content: `请求失败: ${e.name === 'AbortError' ? '超时' : e.message}`, isError: true };
    } finally {
      clearTimeout(timer);
    }
  },
};
