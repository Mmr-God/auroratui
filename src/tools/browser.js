// Browser automation (light): drive a real browser in headless mode to render
// JavaScript pages, then convert the DOM to Markdown. No npm dependencies — we
// reuse the Edge/Chrome that is already installed and its --dump-dom /
// --screenshot switches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { htmlToMarkdown } from './web.js';

const CANDIDATES = [
  process.env.AGENT_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

let cached = null;
export function findBrowser() {
  if (cached !== null) return cached;
  for (const p of CANDIDATES) {
    if (p && fs.existsSync(p)) {
      cached = p;
      return cached;
    }
  }
  for (const name of ['chrome', 'chromium', 'msedge', 'microsoft-edge', 'google-chrome']) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const exe = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
      if (fs.existsSync(exe)) {
        cached = exe;
        return cached;
      }
    }
  }
  cached = '';
  return cached;
}

function runBrowser(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, out, err: e.message });
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, out, err: `超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (out.length > 6 * 1024 * 1024) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    });
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, out, err });
    });
  });
}

function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^[a-z]+:\/\//i.test(u) || u.startsWith('data:') || u.startsWith('file:')) return u;
  return 'https://' + u.replace(/^\/+/, '');
}

export const browserTool = {
  name: 'browser',
  readOnly: true,
  description:
    '用无头浏览器打开网页（能执行 JS，适合 SPA / 需要渲染的页面）：action=open 返回页面正文 Markdown，action=screenshot 存一张截图并返回路径。静态页面用 web_fetch 更快。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'screenshot'], description: 'open=取正文，screenshot=截图' },
      url: { type: 'string', description: '网址（可省略 https://）' },
      wait_ms: { type: 'integer', description: '额外等待渲染的毫秒数，默认 3000，最大 15000' },
      max_chars: { type: 'integer', description: 'open 时正文最大字符数，默认 20000' },
      out: { type: 'string', description: 'screenshot 保存路径（默认临时目录）' },
      size: { type: 'string', description: 'screenshot 视口，格式 1280x900' },
    },
    required: ['action', 'url'],
  },
  async execute(input) {
    const exe = findBrowser();
    if (!exe) {
      return {
        isError: true,
        content:
          '没有找到可用的浏览器（Edge / Chrome）。装一个再试，或用 web_fetch 抓静态页面。可用 AGENT_BROWSER 环境变量指定浏览器路径。',
      };
    }
    const url = normalizeUrl(input.url);
    if (!url) return { isError: true, content: '缺少 url' };
    const action = String(input.action || 'open').toLowerCase();
    const wait = Math.min(15000, Math.max(0, Number(input.wait_ms) || 3000));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
    const base = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--mute-audio',
      `--user-data-dir=${profile}`,
    ];
    try {
      if (action === 'screenshot') {
        const size = /^\d{2,5}x\d{2,5}$/i.test(String(input.size || '')) ? String(input.size) : '1280x900';
        const out = path.resolve(input.out || path.join(os.tmpdir(), `agent-shot-${Date.now()}.png`));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const r = await runBrowser(exe, [...base, `--window-size=${size}`, `--screenshot=${out}`, `--virtual-time-budget=${wait}`, url], 45000);
        if (!fs.existsSync(out)) {
          return { isError: true, content: `截图失败：${(r.err || '').split('\n').filter(Boolean).slice(-2).join(' ') || '浏览器没有产出文件'}` };
        }
        const bytes = fs.statSync(out).size;
        return {
          content: `已截图 ${url}\n文件: ${out}\n大小: ${Math.round(bytes / 1024)} KB（${size}）`,
          meta: { file: out, bytes, url, size, summary: `${url} · ${size}` },
        };
      }
      const r = await runBrowser(exe, [...base, `--virtual-time-budget=${wait}`, '--dump-dom', url], 45000);
      const html = r.out;
      if (!html || html.length < 40) {
        return { isError: true, content: `浏览器没有返回内容：${(r.err || '').split('\n').filter(Boolean).slice(-2).join(' ') || '空响应'}` };
      }
      const { title, markdown } = htmlToMarkdown(html, url);
      const maxChars = Math.min(60000, Math.max(500, Number(input.max_chars) || 20000));
      const body = markdown.length > maxChars ? markdown.slice(0, maxChars) + `\n\n…（共 ${markdown.length} 字，已截断）` : markdown;
      if (!body.trim()) {
        return {
          content: `页面 ${url} 渲染后没有可读正文（可能需要登录或页面纯 canvas）。可以试 action=screenshot 看画面。`,
          meta: { chars: 0, url, summary: `${url} · 无可读正文` },
        };
      }
      return {
        content: `# ${title || url}\n来源: ${url}（无头浏览器渲染）\n\n${body}`,
        meta: { chars: markdown.length, truncated: markdown.length > maxChars, url, title, summary: title || url },
      };
    } finally {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {}
    }
  },
};
