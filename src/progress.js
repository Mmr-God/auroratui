// 团队面板：一个绑在 127.0.0.1 上的极小 HTTP 服务，把「子代理 / 团队成员」
// 的干活过程渲染成**对话式**网页 —— 玩家在左边点一个成员，右边就看他那一整段
// 对话：任务、思考、说了什么、调了哪些工具（带语法高亮）、最后交代了什么。
//
// 零依赖：node:http + SSE。页面本身是内嵌的 HTML/CSS/JS（无外部资源）。
// 只在玩家开了 settings.progress（默认开）且真的用到子代理/团队时才会启动。
import http from 'node:http';
import { spawn } from 'node:child_process';

const LOG_MAX = 300;
const FLUSH_MS = 180;

// 每位成员保留多少「对话条」+ 总字符预算（面板要一直往浏览器推，不能无限长）
const EV_MAX = 160;
const EV_BUDGET = 22000;
const CLIP_TEXT = 4000;
const CLIP_TOOL = 2500;

export const clip = (s, n) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}\n…（后面还有 ${v.length - n} 字符，已省略）` : v;
};
const oneLine = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 从工具入参里挑一个能代表这次调用的短文本（成员列表里显示用）。 */
export function hintOf(input) {
  const v = input?.path || input?.url || input?.pattern || input?.query || input?.command || input?.name || '';
  return typeof v === 'string' ? oneLine(v, 90) : '';
}

function argsText(input) {
  if (input == null) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const entryWeight = (e) => (e?.text?.length || 0) + (e?.result?.length || 0) + (e?.input?.length || 0);

/**
 * 一位成员的「对话记录」：和 TUI 里的对话视图一样，按条追加。
 * 事件（Agent 的原生事件）→ 对话条：task / text / think / tool / note / result / error。
 * 条数 + 字符都有上限，超了从第二条开始丢最老的（第一条钉住 = 任务说明）。
 */
export class Transcript {
  constructor({ max = EV_MAX, budget = EV_BUDGET } = {}) {
    this.max = max;
    this.budget = budget;
    this.seq = 0;
    this.list = [];
  }

  get length() {
    return this.list.length;
  }

  _add(e) {
    e.n = ++this.seq;
    e.ts = e.ts || Date.now();
    this.list.push(e);
    this._trim();
    return e;
  }

  _tail(kind) {
    const l = this.list[this.list.length - 1];
    return l && l.k === kind ? l : null;
  }

  _trim() {
    while (this.list.length > this.max) this.list.splice(1, 1);
    let total = this.list.reduce((n, e) => n + entryWeight(e), 0);
    while (total > this.budget && this.list.length > 3) {
      const [drop] = this.list.splice(1, 1);
      total -= entryWeight(drop);
    }
  }

  /** 队长派下来的任务。 */
  task(text) {
    return this._add({ k: 'task', text: clip(text, CLIP_TEXT) });
  }

  /** 玩家从面板里插的一句话。 */
  say(text) {
    return this._add({ k: 'note', tone: 'say', text: clip(text, CLIP_TEXT) });
  }

  note(text) {
    return this._add({ k: 'note', text: clip(text, 500) });
  }

  text(delta) {
    const d = String(delta ?? '');
    if (!d) return null;
    const last = this._tail('text');
    if (last && !last.closed) {
      last.text = clip(last.text + d, CLIP_TEXT);
      return last;
    }
    return this._add({ k: 'text', text: clip(d, CLIP_TEXT) });
  }

  think(delta) {
    const d = String(delta ?? '');
    if (!d) return null;
    const last = this._tail('think');
    if (last && !last.closed) {
      last.text = clip(last.text + d, CLIP_TEXT);
      return last;
    }
    return this._add({ k: 'think', text: clip(d, CLIP_TEXT) });
  }

  toolStart({ id, name, input }) {
    return this._add({
      k: 'tool',
      id: String(id || ''),
      name: String(name || 'tool'),
      hint: hintOf(input),
      input: clip(argsText(input), CLIP_TOOL),
      status: 'run',
    });
  }

  toolEnd({ id, name, isError, content, dur }) {
    let e = null;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const x = this.list[i];
      if (x.k === 'tool' && x.status === 'run' && (id ? x.id === id : x.name === name)) {
        e = x;
        break;
      }
    }
    if (!e) e = this._add({ k: 'tool', id: String(id || ''), name: String(name || 'tool'), hint: '', input: '', status: 'run' });
    e.status = isError ? 'err' : 'ok';
    e.dur = Number(dur) || Math.max(0, Date.now() - (e.ts || Date.now()));
    e.result = clip(content, CLIP_TOOL);
    return e;
  }

  /** 最终交给队长的交代。 */
  result(text) {
    return this._add({ k: 'result', text: clip(text, CLIP_TEXT) });
  }

  error(text) {
    return this._add({ k: 'error', text: clip(text, 1200) });
  }

  /** 一轮说完（下一段文字另起一个气泡）。 */
  done() {
    const l = this.list[this.list.length - 1];
    if (l && (l.k === 'text' || l.k === 'think')) l.closed = true;
  }

  /** 把 Agent 的原生事件直接喂进来（团队 / 子代理共用）。 */
  feed(ev) {
    if (!ev) return;
    switch (ev.type) {
      case 'text':
        return this.text(ev.delta);
      case 'reasoning':
        return this.think(ev.delta);
      case 'tool_start':
        return this.toolStart({ id: ev.id, name: ev.name, input: ev.input });
      case 'tool_end':
        return this.toolEnd({ id: ev.id, name: ev.name, isError: ev.isError, content: ev.content, dur: ev.dur });
      case 'assistant_done':
        return this.done();
      case 'compact_start':
        return this.note(`上下文压缩中（${ev.nodes ?? 0} 块 / ${ev.tokens ?? 0} tok）`);
      case 'compact_end':
        return this.note(`上下文已压缩${ev.topic ? `：${oneLine(ev.topic, 60)}` : ''}`);
      case 'retry':
        return this.note(`接口重试（第 ${ev.attempt} 次，${Math.round((ev.wait || 0) / 100) / 10}s 后）`);
      case 'truncated':
        return this.note('输出撞到单次上限，自动续写');
      case 'error':
        return this.error(ev.message);
      case 'steering':
        return this.say(ev.text);
      default:
        return null;
    }
  }

  entries() {
    return this.list;
  }
}

export class ProgressHub {
  constructor({ port = 7870, host = '127.0.0.1' } = {}) {
    this.host = host;
    this.port = Number(port) || 7870;
    this.server = null;
    this.url = null;
    this.clients = new Set();
    this.dirty = false;
    this.flushTimer = null;
    /** 玩家在面板里给成员传话：由 Team.attachHub 挂上来。 */
    this.onSay = null;
    this.state = {
      title: 'AuroraTui · 团队面板',
      team: null,
      solo: [],
      totals: { members: 0, done: 0, running: 0, tokens: 0, cost: 0 },
      log: [],
      updated: Date.now(),
    };
  }

  get running() {
    return !!this.server;
  }

  /** 启动服务（端口被占用时自动往后找，最多 +10）。 */
  async ensure() {
    if (this.server) return this.url;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      for (let i = 0; i < 10; i++) {
        const port = this.port + i;
        try {
          const server = await listen(this, port);
          this.server = server;
          this.port = port;
          this.url = `http://${this.host}:${port}/`;
          return this.url;
        } catch (e) {
          if (e?.code !== 'EADDRINUSE') throw e;
        }
      }
      throw new Error('团队面板端口被占用（7870-7879 都试过了）');
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  stop() {
    for (const c of this.clients) {
      try {
        c.end();
      } catch {}
    }
    this.clients.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.server?.close();
    } catch {}
    this.server = null;
  }

  /** 合并一份状态（团队快照 / 单人子代理进度）。 */
  update(patch = {}) {
    this.state = { ...this.state, ...patch, updated: Date.now() };
    this._markDirty();
    return this.state;
  }

  /** 追加一条进度日志（会同时触发一次推送）。 */
  log(entry = {}) {
    const item = {
      ts: entry.ts || Date.now(),
      kind: entry.kind || 'info',
      who: entry.who || '',
      text: String(entry.text ?? ''),
    };
    this.state.log = [...this.state.log.slice(-(LOG_MAX - 1)), item];
    this.state.updated = Date.now();
    this._markDirty();
    return item;
  }

  snapshot() {
    return this.state;
  }

  _markDirty() {
    this.dirty = true;
    if (this.flushTimer || !this.clients.size) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this._broadcast();
    }, FLUSH_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  _broadcast() {
    const payload = `event: state\ndata: ${JSON.stringify(this.state)}\n\n`;
    for (const res of [...this.clients]) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

function listen(hub, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handle(hub, req, res));
    server.on('error', (e) => {
      server.close();
      reject(e);
    });
    server.listen(port, hub.host, () => {
      server.unref?.();
      resolve(server);
    });
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        body = body.slice(0, limit);
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}

function handle(hub, req, res) {
  const url = new URL(req.url || '/', `http://${hub.host}`);
  const path = url.pathname;
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  if (path === '/' || path === '/index.html') {
    const html = dashboardHtml();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }
  if (path === '/health') return json(200, { ok: true, url: hub.url });
  if (path === '/api/state') return json(200, hub.snapshot());
  // 玩家在面板里给某个成员传话
  if (path === '/api/say' && req.method === 'POST') {
    return readBody(req).then((raw) => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(400, { ok: false, content: '请求体不是 JSON。' });
      }
      const member = String(body.member || '').trim();
      const text = String(body.text || '').trim();
      if (!text) return json(400, { ok: false, content: '消息不能为空。' });
      if (typeof hub.onSay !== 'function') return json(409, { ok: false, content: '现在没有团队在跑，传话没人接。' });
      let out;
      try {
        out = hub.onSay(member, text);
      } catch (e) {
        out = { ok: false, content: `传话失败：${e?.message || e}` };
      }
      return json(out?.ok ? 200 : 409, { ok: !!out?.ok, content: String(out?.content || '') });
    });
  }
  if (path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(hub.snapshot())}\n\n`);
    hub.clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {}
    }, 15000);
    if (ping.unref) ping.unref();
    const bye = () => {
      clearInterval(ping);
      hub.clients.delete(res);
    };
    req.on('close', bye);
    req.on('error', bye);
    return;
  }
  json(404, { error: 'not found' });
}

// --------------------------------------------------------------------- 单例
let hub = null;

/** 按配置拿到面板（关掉 settings.progress 时返回 null）。 */
export function getHub(config) {
  if (config && config.settings && config.settings.progress === false) return null;
  if (!hub) {
    const port = Number(config?.settings?.progressPort) || 7870;
    hub = new ProgressHub({ port });
  }
  return hub;
}

/** 拿到并确保已启动；失败时返回 null（不打断干活）。 */
export async function ensureHub(config) {
  const h = getHub(config);
  if (!h) return null;
  try {
    await h.ensure();
    return h;
  } catch {
    return null;
  }
}

export function resetHub() {
  if (hub) hub.stop();
  hub = null;
}

/** 用系统默认浏览器打开面板（失败就算了）。 */
export function openInBrowser(url) {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- 页面
// 注意：整页 HTML 是模板字符串，里面的浏览器脚本一律不用反引号 / ${}（用 + 拼接），
// 免得和外层模板打架。反引号用 String.fromCharCode(96) 或 \u0060 表示。
export function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AuroraTui · 团队面板</title>
<style>
  :root {
    --bg: #0b0f16; --panel: #121822; --panel2: #171f2b; --line: #222c3a;
    --text: #e6edf3; --dim: #8b98a9; --faint: #5b6a7d;
    --accent: #58a6ff; --accent2: #bc8cff; --ok: #3fb950; --warn: #d29922; --err: #f85149;
    --kw: #c792ea; --str: #a5d6a7; --num: #ffb86c; --com: #5f6b7a; --fn: #82aaff; --typ: #7fd3f7;
    --prop: #9fe0c0; --op: #8b98a9; --tag: #f2a0b5;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); overflow: hidden;
    font: 13px/1.65 "Segoe UI", ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Code", monospace; }
  .app { display: flex; height: 100vh; }
  /* ---------------------------------------------------------------- 左侧 */
  .rail { width: 258px; flex: 0 0 258px; border-right: 1px solid var(--line); background: #0d131c;
    display: flex; flex-direction: column; min-height: 0; }
  .brand { padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
  .brand h1 { font-size: 14px; margin: 0; letter-spacing: .4px; font-weight: 650; }
  .brand h1 b { color: var(--accent); }
  .brand .sub { color: var(--faint); font-size: 11px; margin-top: 2px; }
  .live { font-size: 10px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--line); color: var(--dim); }
  .live.on { color: var(--ok); border-color: #1f4b2b; }
  .live.off { color: var(--err); border-color: #5a2226; }
  .railhead { display: flex; align-items: center; gap: 8px; padding: 10px 14px 6px; color: var(--faint);
    font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
  .railhead .n { margin-left: auto; color: var(--dim); letter-spacing: 0; }
  .list { overflow: auto; padding: 0 8px 8px; min-height: 0; }
  .mrow { display: flex; gap: 9px; align-items: flex-start; padding: 8px 9px; border-radius: 9px;
    border: 1px solid transparent; cursor: pointer; }
  .mrow:hover { background: #131b26; }
  .mrow.sel { background: #17222f; border-color: #24405f; }
  .av { width: 22px; height: 22px; flex: 0 0 22px; border-radius: 7px; margin-top: 1px;
    display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
    background: #1d2b3d; color: var(--accent); }
  .mrow.s-done .av { background: #142a1c; color: var(--ok); }
  .mrow.s-error .av { background: #2d1618; color: var(--err); }
  .mrow.s-running .av { background: #1b2a44; color: var(--accent); box-shadow: 0 0 0 2px rgba(88,166,255,.18); }
  .mrow.s-pending .av { background: #2a2415; color: var(--warn); }
  .mrow.s-stopped .av { background: #232a33; color: var(--faint); }
  .minfo { min-width: 0; flex: 1; }
  .mname { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .mname span.t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; padding: 0 5px; border-radius: 7px; border: 1px solid var(--line); color: var(--faint); }
  .mrole { color: var(--faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mtail { color: var(--faint); font-size: 10.5px; margin-top: 2px; display: flex; gap: 8px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 5px; vertical-align: middle; }
  .dot.running { background: var(--accent); animation: pulse 1.1s infinite; }
  .dot.done { background: var(--ok); }
  .dot.error { background: var(--err); }
  .dot.pending { background: var(--warn); }
  .dot.stopped { background: var(--faint); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .28; } }
  .railfoot { border-top: 1px solid var(--line); padding: 6px 10px 10px; }
  details.feed-log summary { cursor: pointer; color: var(--faint); font-size: 11px; padding: 2px 0; outline: none; }
  .logbox { max-height: 22vh; overflow: auto; font-size: 11px; margin-top: 4px; }
  .logbox div { display: flex; gap: 6px; padding: 1px 0; }
  .logbox .ts { color: #3c4857; flex: 0 0 auto; }
  .logbox .who { color: var(--accent); flex: 0 0 auto; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logbox .msg { color: #9dabbb; word-break: break-word; }
  .logbox .k-error .msg { color: var(--err); }
  .logbox .k-member_done .msg, .logbox .k-done .msg { color: var(--ok); }
  /* ---------------------------------------------------------------- 右侧 */
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .mhead { border-bottom: 1px solid var(--line); padding: 11px 20px; display: flex; align-items: center; gap: 12px;
    background: linear-gradient(180deg, #121a24, #0e141d); flex: 0 0 auto; flex-wrap: wrap; }
  .mhead h2 { font-size: 14px; margin: 0; display: flex; align-items: center; gap: 8px; }
  .mhead .role { color: var(--accent2); font-size: 11.5px; }
  .pill { font-size: 10px; padding: 1px 8px; border-radius: 9px; border: 1px solid var(--line); color: var(--dim); }
  .pill.running { color: var(--accent); border-color: #1f6feb; background: rgba(88,166,255,.08); }
  .pill.done { color: var(--ok); border-color: #1f4b2b; background: rgba(63,185,80,.07); }
  .pill.error { color: var(--err); border-color: #5a2226; background: rgba(248,81,73,.07); }
  .pill.pending { color: var(--warn); border-color: #4d3a12; }
  .pill.stopped { color: var(--faint); }
  .mstats { margin-left: auto; display: flex; gap: 14px; color: var(--faint); font-size: 11.5px; }
  .mstats b { color: var(--text); font-weight: 600; }
  .goalbar { padding: 7px 20px; border-bottom: 1px solid var(--line); color: #97a6b8; font-size: 11.5px;
    background: #0e141d; flex: 0 0 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .goalbar b { color: var(--accent2); font-weight: 600; }
  .feed { flex: 1; overflow: auto; padding: 18px 20px 28px; scroll-behavior: auto; }
  .wrap { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
  .empty { color: var(--faint); text-align: center; padding: 60px 0; }
  /* 气泡 */
  .row { display: flex; gap: 10px; align-items: flex-start; }
  .row .who { width: 26px; flex: 0 0 26px; height: 26px; border-radius: 8px; display: flex; align-items: center;
    justify-content: center; font-size: 11px; font-weight: 700; background: #1d2b3d; color: var(--accent); }
  .row.lead .who { background: #241f33; color: var(--accent2); }
  .row.player .who { background: #1f2a1f; color: var(--ok); }
  .bubble { flex: 1; min-width: 0; }
  .bhead { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--faint); margin-bottom: 3px; }
  .bhead .nm { color: var(--dim); }
  .body { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 13px;
    overflow-wrap: break-word; word-break: break-word; }
  .row.lead .body { background: #141a26; border-color: #26314a; }
  .row.player .body { background: #111c14; border-color: #22402a; }
  .body.stream { border-style: dashed; }
  .result .body { background: #101a24; border-color: #1f4b6b; box-shadow: 0 0 0 1px rgba(88,166,255,.14) inset; }
  .errbox .body { background: #1e1113; border-color: #5a2226; color: #ffb4ae; }
  .sysline { color: var(--faint); font-size: 11.5px; padding: 0 0 0 36px; }
  .sysline.say { color: var(--ok); }
  /* 思考块 */
  .think { border: 1px solid var(--line); border-radius: 10px; background: #10161f; overflow: hidden; }
  .think summary { cursor: pointer; padding: 5px 12px; color: var(--warn); font-size: 11.5px; list-style: none; }
  .think summary::-webkit-details-marker { display: none; }
  .think .tb { padding: 0 12px 8px; color: #9aa8b8; font-style: italic; white-space: pre-wrap; border-top: 1px solid #1b2430; }
  /* 工具卡片 */
  .tool { border: 1px solid var(--line); border-radius: 10px; background: #101720; overflow: hidden; margin-left: 36px; }
  .tool.run { border-color: #1f4b6b; }
  .tool.err { border-color: #5a2226; }
  .tool .th { display: flex; gap: 8px; align-items: center; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .tool .th:hover { background: #131c27; }
  .tool .tn { color: var(--fn); font-weight: 600; }
  .tool .thint { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .tool .tstat { color: var(--faint); font-size: 10.5px; flex: 0 0 auto; }
  .tool.run .tstat { color: var(--accent); }
  .tool.err .tstat { color: var(--err); }
  .tool .tb { display: none; border-top: 1px solid #1b2430; padding: 8px 12px 10px; }
  .tool.open .tb { display: block; }
  .tool .tcap { color: var(--faint); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; margin: 6px 0 3px; }
  pre { margin: 0; overflow: auto; max-height: 42vh; background: #0b1119; border: 1px solid #1a2330;
    border-radius: 8px; padding: 8px 10px; font-size: 11.5px; line-height: 1.55; }
  pre code { font-family: inherit; white-space: pre; }
  .cl { color: var(--faint); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 3px; }
  /* markdown */
  .body h1, .body h2, .body h3, .body h4 { margin: 10px 0 5px; font-size: 13.5px; }
  .body h1 { font-size: 15px; } .body h2 { font-size: 14px; }
  .body p { margin: 5px 0; }
  .body ul, .body ol { margin: 5px 0 5px 18px; padding: 0; }
  .body li { margin: 2px 0; }
  .body code { background: #0c131c; border: 1px solid #1c2735; border-radius: 4px; padding: 0 4px; font-size: 11.5px; color: var(--num); }
  .body pre code { border: 0; background: none; padding: 0; color: inherit; }
  .body blockquote { margin: 6px 0; padding: 2px 10px; border-left: 2px solid #2b3a4d; color: #a4b1c1; }
  .body a { color: var(--accent); text-decoration: none; }
  .body a:hover { text-decoration: underline; }
  .body hr { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
  .body table { border-collapse: collapse; margin: 6px 0; font-size: 11.5px; }
  .body th, .body td { border: 1px solid var(--line); padding: 3px 8px; }
  .body th { background: #16202c; }
  /* 高亮 token */
  .t-k { color: var(--kw); } .t-s { color: var(--str); } .t-n { color: var(--num); }
  .t-c { color: var(--com); font-style: italic; } .t-f { color: var(--fn); } .t-y { color: var(--typ); }
  .t-p { color: var(--prop); } .t-o { color: var(--op); } .t-t { color: var(--tag); }
  .t-a { color: var(--ok); } .t-d { color: var(--err); }
  /* 输入框 */
  .composer { flex: 0 0 auto; border-top: 1px solid var(--line); padding: 10px 20px 12px; background: #0d131c; }
  .cwrap { max-width: 900px; margin: 0 auto; display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; height: 38px; max-height: 120px; background: #0b1119; color: var(--text);
    border: 1px solid #22303f; border-radius: 9px; padding: 9px 12px; font: inherit; font-size: 12.5px; outline: none; }
  textarea:focus { border-color: #2f5f92; }
  textarea:disabled { opacity: .5; }
  button.send { background: #1f6feb; color: #fff; border: 0; border-radius: 9px; padding: 0 16px; height: 38px;
    font: inherit; font-size: 12.5px; cursor: pointer; }
  button.send:disabled { background: #22303f; color: var(--faint); cursor: default; }
  .hint { max-width: 900px; margin: 5px auto 0; color: var(--faint); font-size: 10.5px; display: flex; gap: 10px; }
  .hint .flash { color: var(--accent); }
  .hint .bad { color: var(--err); }
  .hint .good { color: var(--ok); }
  .jump { position: absolute; right: 26px; bottom: 84px; background: #1f6feb; color: #fff; border: 0;
    border-radius: 14px; padding: 4px 12px; font: inherit; font-size: 11.5px; cursor: pointer; display: none; }
  @media (max-width: 720px) {
    .app { flex-direction: column; }
    .rail { width: auto; flex: 0 0 auto; max-height: 34vh; border-right: 0; border-bottom: 1px solid var(--line); }
    .mstats { width: 100%; margin-left: 0; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="rail">
    <div class="brand">
      <h1><b>AuroraTui</b> · 团队面板 <span class="live off" id="live">连接中</span></h1>
      <div class="sub" id="sub">点左边的成员，看他那一整段对话</div>
    </div>
    <div class="railhead">成员 <span class="n" id="mcount">0/0</span></div>
    <div class="list" id="list"></div>
    <div class="railfoot">
      <details class="feed-log">
        <summary>全局动态 <span id="logn">0</span></summary>
        <div class="logbox" id="log"></div>
      </details>
    </div>
  </aside>
  <section class="main">
    <div class="mhead" id="mhead"></div>
    <div class="goalbar" id="goalbar"></div>
    <div class="feed" id="feed"><div class="wrap" id="wrap"><div class="empty">还没有任务在跑 —— 让 AI 用 team 或 subagent 开工，这里会实时亮起来。</div></div></div>
    <button class="jump" id="jump">↓ 回到最新</button>
    <form class="composer" id="composer" autocomplete="off">
      <div class="cwrap">
        <textarea id="msg" placeholder="给这个成员补一句话（Enter 发送，Shift+Enter 换行）" disabled></textarea>
        <button class="send" id="send" type="submit" disabled>发送</button>
      </div>
      <div class="hint"><span id="flash">↑↓ 切换成员 · 1-9 直选 · 传话只在成员运行中有效</span></div>
    </form>
  </section>
</div>
<script>
(function () {
  'use strict';
  var TICK = String.fromCharCode(96);
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  };
  var fmt = function (n) {
    var v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(v));
  };
  var money = function (n) { return '$' + (Number(n) || 0).toFixed(4); };
  var dur = function (ms) {
    var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
  };
  var clock = function (ts) {
    try { return new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return ''; }
  };
  var STATUS = { pending: '排队中', running: '进行中', done: '完成', error: '失败', stopped: '已停止' };

  // ------------------------------------------------------------- 语法高亮
  var KW = {};
  ('true false null undefined nil this self super new delete typeof instanceof in of as is not and or if else elif then fi ' +
   'for while do done switch case default break continue return yield await async function func fn def class struct enum ' +
   'interface trait impl extends implements import export from package module using namespace public private protected ' +
   'internal static final abstract const let var val mut pub use crate mod match try catch except finally throw raise with ' +
   'lambda pass global void int long short float double char bool boolean string byte u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 ' +
   'go defer chan select map range where insert update delete create alter drop table join left right inner outer on group ' +
   'by order having limit offset union all distinct into values set').split(' ').forEach(function (k) { KW[k] = 1; });
  var BUILTIN = {};
  ('console window document process require module exports global JSON Math Object Array String Number Boolean Symbol Promise ' +
   'Map Set WeakMap Date RegExp Error TypeError parseInt parseFloat isNaN print len range str int float dict list set tuple ' +
   'type isinstance eval open file echo cd ls cat grep sed awk curl git node npm read write append close puts each println ' +
   'printf fmt cap make copy panic recover').split(' ').forEach(function (k) { BUILTIN[k] = 1; });
  var LANGALIAS = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', ts: 'js', typescript: 'js', tsx: 'js',
    json: 'js', jsonc: 'js', json5: 'js', py: 'py', python: 'py', python3: 'py',
    sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', cmd: 'sh', bat: 'sh',
    powershell: 'sh', ps1: 'sh', pwsh: 'sh', c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', cxx: 'c', hpp: 'c',
    java: 'c', cs: 'c', csharp: 'c', go: 'c', rust: 'c', rs: 'c', kt: 'c', kotlin: 'c', swift: 'c', dart: 'c',
    rb: 'py', ruby: 'py', php: 'c', lua: 'c', sql: 'sql', mysql: 'sql', postgres: 'sql', sqlite: 'sql',
    yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', cfg: 'yaml', conf: 'yaml', env: 'yaml',
    html: 'html', xml: 'html', svg: 'html', vue: 'html', htm: 'html', css: 'yaml', scss: 'yaml', less: 'yaml',
    diff: 'diff', patch: 'diff', udiff: 'diff'
  };
  var SPEC = {
    js: { line: ['//'], block: [['/*', '*/']], q: ['"', "'", TICK] },
    py: { line: ['#'], block: [], q: ['"', "'"] },
    sh: { line: ['#'], block: [], q: ['"', "'"] },
    c: { line: ['//'], block: [['/*', '*/']], q: ['"', "'"] },
    sql: { line: ['--'], block: [['/*', '*/']], q: ["'"] },
    yaml: { line: ['#'], block: [], q: ['"', "'"], kv: true }
  };
  var IDS = /[A-Za-z_$]/, IDB = /[A-Za-z0-9_$]/, NUMRE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/;

  function paintId(tok, next, prev) {
    var low = tok.toLowerCase();
    if (KW[tok] || KW[low]) return 't-k';
    if (BUILTIN[tok] || BUILTIN[low]) return 't-y';
    if (tok.length > 1 && tok[0] !== tok[0].toLowerCase()) return 't-y';
    if (next === '(') return 't-f';
    if (prev === '.') return 't-p';
    return '';
  }

  function hlLine(line, spec, st) {
    var out = '', i = 0, n = line.length, end, q, j, closed, tok, cls, rest;
    while (i < n) {
      if (st.block) {
        end = line.indexOf(st.block[1], i);
        if (end < 0) return out + '<span class="t-c">' + esc(line.slice(i)) + '</span>';
        out += '<span class="t-c">' + esc(line.slice(i, end + st.block[1].length)) + '</span>';
        i = end + st.block[1].length;
        st.block = null;
        continue;
      }
      if (st.quote) {
        j = i; closed = false;
        while (j < n) {
          if (line[j] === '\\\\') { j += 2; continue; }
          if (line.startsWith(st.quote, j)) { j += st.quote.length; closed = true; break; }
          j++;
        }
        out += '<span class="t-s">' + esc(line.slice(i, Math.min(j, n))) + '</span>';
        if (closed) st.quote = null;
        i = j;
        continue;
      }
      var lc = null;
      for (var a = 0; a < spec.line.length; a++) if (line.startsWith(spec.line[a], i)) { lc = spec.line[a]; break; }
      if (lc) return out + '<span class="t-c">' + esc(line.slice(i)) + '</span>';
      var blk = null;
      for (var b = 0; b < spec.block.length; b++) if (line.startsWith(spec.block[b][0], i)) { blk = spec.block[b]; break; }
      if (blk) {
        end = line.indexOf(blk[1], i + blk[0].length);
        if (end < 0) { st.block = blk; return out + '<span class="t-c">' + esc(line.slice(i)) + '</span>'; }
        out += '<span class="t-c">' + esc(line.slice(i, end + blk[1].length)) + '</span>';
        i = end + blk[1].length;
        continue;
      }
      var hit = null;
      for (var c2 = 0; c2 < spec.q.length; c2++) if (line.startsWith(spec.q[c2], i)) { hit = spec.q[c2]; break; }
      if (hit) {
        j = i + hit.length; closed = false;
        while (j < n) {
          if (line[j] === '\\\\') { j += 2; continue; }
          if (line.startsWith(hit, j)) { j += hit.length; closed = true; break; }
          j++;
        }
        out += '<span class="t-s">' + esc(line.slice(i, Math.min(j, n))) + '</span>';
        if (!closed && hit === TICK) st.quote = hit;
        i = j;
        continue;
      }
      var ch = line[i];
      if (ch >= '0' && ch <= '9') {
        var m = NUMRE.exec(line.slice(i));
        if (m && !IDB.test(line[i - 1] || '')) {
          out += '<span class="t-n">' + esc(m[0]) + '</span>';
          i += m[0].length;
          continue;
        }
      }
      if (IDS.test(ch)) {
        j = i + 1;
        while (j < n && IDB.test(line[j])) j++;
        tok = line.slice(i, j);
        rest = line.slice(j);
        if (spec.kv && /^\s*:/.test(rest) && /^\s*$/.test(line.slice(0, i))) {
          out += '<span class="t-p">' + esc(tok) + '</span>';
          i = j;
          continue;
        }
        var k = j;
        while (k < n && line[k] === ' ') k++;
        cls = paintId(tok, line[k], line[i - 1]);
        out += cls ? '<span class="' + cls + '">' + esc(tok) + '</span>' : esc(tok);
        i = j;
        continue;
      }
      out += /\\s/.test(ch) ? ch : '<span class="t-o">' + esc(ch) + '</span>';
      i++;
    }
    return out;
  }

  function hl(code, lang) {
    var id = LANGALIAS[String(lang || '').toLowerCase().replace(/^language-/, '')] || '';
    var lines = String(code == null ? '' : code).split('\\n');
    if (id === 'diff') {
      return lines.map(function (l) {
        var cls = /^(\\+\\+\\+|---)/.test(l) ? 't-o' : /^@@/.test(l) ? 't-f' : l.charAt(0) === '+' ? 't-a' : l.charAt(0) === '-' ? 't-d' : '';
        return cls ? '<span class="' + cls + '">' + esc(l) + '</span>' : esc(l);
      }).join('\\n');
    }
    if (id === 'html') {
      return lines.map(function (l) {
        return l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/(&lt;\\/?)([A-Za-z][\\w:.-]*)/g, '$1<span class="t-t">$2</span>')
          .replace(/([\\w-]+)=(&quot;|")/g, '<span class="t-p">$1</span>=$2');
      }).join('\\n');
    }
    var spec = SPEC[id];
    if (!spec) return esc(code);
    var st = { block: null, quote: null };
    return lines.map(function (l) { return hlLine(l, spec, st); }).join('\\n');
  }

  // ------------------------------------------------------------- markdown
  var TICKRE = /\\u0060([^\\u0060]+)\\u0060/g;
  function inline(text) {
    var codes = [];
    var s = esc(text).replace(TICKRE, function (m, x) {
      codes.push(x);
      return '\\u0000' + (codes.length - 1) + '\\u0000';
    });
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    s = s.replace(/(^|[\\s(])(https?:\\/\\/[^\\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    s = s.replace(/\\u0000(\\d+)\\u0000/g, function (m, i) { return '<code>' + codes[Number(i)] + '</code>'; });
    return s;
  }

  function codeBlock(lang, body) {
    var l = String(lang || '').trim();
    return '<div class="cl">' + esc(l || 'code') + '</div><pre><code>' + hl(body, l) + '</code></pre>';
  }

  function md(text) {
    var lines = String(text == null ? '' : text).split('\\n');
    var out = [], i = 0, m, buf, lang, body, rows;
    var isFence = function (s) { return s.replace(/\\s+$/, '').slice(0, 3) === TICK + TICK + TICK; };
    while (i < lines.length) {
      var line = lines[i];
      if (isFence(line)) {
        lang = line.replace(/\\s+$/, '').slice(3).trim();
        body = [];
        i++;
        while (i < lines.length) {
          if (isFence(lines[i])) break;
          body.push(lines[i]);
          i++;
        }
        i++;
        out.push(codeBlock(lang, body.join('\\n')));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if ((m = /^(#{1,4})\\s+(.*)$/.exec(line))) {
        var lv = Math.min(4, m[1].length);
        out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
        i++;
        continue;
      }
      if (/^\\s*([-*_])\\1{2,}\\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\\s*>\\s?/.test(line)) {
        buf = [];
        while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\\s*>\\s?/, '')); i++; }
        out.push('<blockquote>' + md(buf.join('\\n')) + '</blockquote>');
        continue;
      }
      if (/^\\s*([-*+]|\\d+[.)])\\s+/.test(line)) {
        var ordered = /^\\s*\\d+[.)]\\s+/.test(line);
        buf = [];
        while (i < lines.length && /^\\s*([-*+]|\\d+[.)])\\s+/.test(lines[i])) {
          buf.push('<li>' + inline(lines[i].replace(/^\\s*([-*+]|\\d+[.)])\\s+/, '')) + '</li>');
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + buf.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{2,}/.test(lines[i + 1])) {
        var head = line.split('|').map(function (x) { return x.trim(); }).filter(function (x, ix, arr) { return !(x === '' && (ix === 0 || ix === arr.length - 1)); });
        rows = [];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          rows.push(lines[i].split('|').map(function (x) { return x.trim(); }).filter(function (x, ix, arr) { return !(x === '' && (ix === 0 || ix === arr.length - 1)); }));
          i++;
        }
        out.push('<table><thead><tr>' + head.map(function (h) { return '<th>' + inline(h) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>');
        continue;
      }
      buf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\\s*([-*+]|\\d+[.)])\\s+/.test(lines[i]) && !/^\\s*>\\s?/.test(lines[i]) &&
             !/^#{1,4}\\s+/.test(lines[i]) && !isFence(lines[i])) {
        buf.push(inline(lines[i]));
        i++;
      }
      if (buf.length) out.push('<p>' + buf.join('<br>') + '</p>');
      else i++;
    }
    return out.join('');
  }

  // ------------------------------------------------------------- 渲染状态
  var S = { state: null, sel: null, follow: true, open: {}, nodes: new Map() };
  var wrapEl = $('wrap'), feedEl = $('feed');

  function members() {
    var st = S.state || {};
    var out = [];
    var team = st.team;
    if (team && team.members) {
      for (var i = 0; i < team.members.length; i++) {
        var m = team.members[i];
        m.kind = m.role ? 'member' : 'member';
        out.push(m);
      }
    }
    var solo = st.solo || [];
    for (var j = 0; j < solo.length; j++) {
      var s = solo[j];
      s.kind = 'solo';
      out.push(s);
    }
    return out;
  }

  function pick() {
    var list = members();
    if (!list.length) return null;
    if (S.sel && /^\\d+$/.test(String(S.sel))) {            // ?sel=2 直接选第 2 个
      var ix = Math.min(list.length - 1, Math.max(0, Number(S.sel) - 1));
      var byIx = list[ix];
      S.sel = byIx.id || byIx.name;
      return byIx;
    }
    for (var i = 0; i < list.length; i++) if (list[i].id === S.sel) return list[i];
    var running = null;
    for (var k = 0; k < list.length; k++) if (list[k].status === 'running') { running = list[k]; break; }
    var target = running || list[0];
    S.sel = target.id || target.name;
    return target;
  }

  function evSig(e) {
    return [e.k, e.n, e.status || '', (e.text || '').length, (e.result || '').length, e.closed ? 1 : 0].join('|');
  }

  function buildEvent(e, member) {
    if (e.k === 'tool') {
      var box = el('div', 'tool ' + (e.status || ''));
      var head = el('div', 'th');
      var icon = e.status === 'run' ? '◐' : e.status === 'err' ? '×' : '√';
      head.appendChild(el('span', 'tn', icon + ' ' + (e.name || 'tool')));
      head.appendChild(el('span', 'thint', e.hint || ''));
      head.appendChild(el('span', 'tstat', e.status === 'run' ? '运行中' : (e.dur ? dur(e.dur) : '') + (e.status === 'err' ? ' · 失败' : '')));
      var body = el('div', 'tb');
      if (e.input) {
        body.appendChild(el('div', 'tcap', '入参'));
        var pre1 = el('pre');
        var c1 = el('code');
        c1.innerHTML = hl(e.input, 'json');
        pre1.appendChild(c1);
        body.appendChild(pre1);
      }
      if (e.result) {
        body.appendChild(el('div', 'tcap', e.status === 'err' ? '错误输出' : '结果'));
        var pre2 = el('pre');
        var c2 = el('code');
        c2.innerHTML = hl(e.result, guessLang(e.name, e.result));
        pre2.appendChild(c2);
        body.appendChild(pre2);
      }
      box.appendChild(head);
      box.appendChild(body);
      if (S.open[e.n] == null) S.open[e.n] = e.status === 'err';
      if (S.open[e.n]) box.classList.add('open');
      head.onclick = function () {
        S.open[e.n] = !S.open[e.n];
        box.classList.toggle('open', !!S.open[e.n]);
      };
      return box;
    }
    if (e.k === 'think') {
      var d = el('details', 'think');
      d.appendChild(el('summary', '', '思考 · ' + (e.text || '').length + ' 字' + (e.closed ? '' : '（思考中…）')));
      d.appendChild(el('div', 'tb', e.text || ''));
      if (S.open[e.n]) d.open = true;
      d.ontoggle = function () { S.open[e.n] = d.open; };
      return d;
    }
    if (e.k === 'note') {
      var line = el('div', 'sysline' + (e.tone === 'say' ? ' say' : ''), (e.tone === 'say' ? '💬 队长/玩家：' : '· ') + (e.text || ''));
      return line;
    }
    // task / text / result / error → 气泡
    var row = el('div', 'row ' + (e.k === 'task' ? 'lead' : e.k === 'note' ? 'player' : '') + (e.k === 'result' ? ' result' : '') + (e.k === 'error' ? ' errbox' : ''));
    row.appendChild(el('div', 'who', e.k === 'task' ? '队' : e.k === 'result' ? '交' : 'AI'));
    var bub = el('div', 'bubble');
    var bh = el('div', 'bhead');
    var nm = e.k === 'task' ? '队长 · 派活' : e.k === 'result' ? (member.name || '成员') + ' · 最终交代' : e.k === 'error' ? '出错了' : member.name || '成员';
    bh.appendChild(el('span', 'nm', nm));
    bh.appendChild(el('span', '', clock(e.ts).slice(0, 8)));
    bub.appendChild(bh);
    var body = el('div', 'body' + (e.k === 'text' && !e.closed ? ' stream' : ''));
    body.innerHTML = md(e.text || '');
    bub.appendChild(body);
    row.appendChild(bub);
    return row;
  }

  function guessLang(name, text) {
    var s = String(text || '');
    if (name === 'shell') return 'sh';
    if (/^\\s*[[{]/.test(s) && /":/.test(s)) return 'json';
    if (/^\\+\\+\\+|^---/m.test(s)) return 'diff';
    if (/^<[a-z!]/i.test(s)) return 'html';
    return '';
  }

  function renderFeed(m) {
    var events = (m && m.events) || [];
    var seen = {};
    var prev = null;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      seen[e.n] = 1;
      var sig = evSig(e);
      var rec = S.nodes.get(e.n);
      if (!rec) {
        var node = buildEvent(e, m);
        rec = { el: node, sig: sig };
        S.nodes.set(e.n, rec);
      } else if (rec.sig !== sig) {
        var nn = buildEvent(e, m);
        if (rec.el.parentNode) rec.el.parentNode.replaceChild(nn, rec.el);
        rec.el = nn;
        rec.sig = sig;
      }
      if (prev) {
        if (rec.el.previousSibling !== prev) prev.parentNode.insertBefore(rec.el, prev.nextSibling);
      } else if (wrapEl.firstChild !== rec.el) {
        wrapEl.insertBefore(rec.el, wrapEl.firstChild);
      }
      prev = rec.el;
    }
    S.nodes.forEach(function (rec, n) {
      if (!seen[n]) { if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el); S.nodes.delete(n); }
    });
    var emptyEl = wrapEl.querySelector('.empty');
    if (events.length && emptyEl) emptyEl.remove();
    if (!events.length && !emptyEl) {
      wrapEl.appendChild(el('div', 'empty', '还没有内容 —— 等他开口。'));
    }
  }

  function resetFeed() {
    S.nodes.forEach(function (rec) { if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el); });
    S.nodes.clear();
    S.open = {};
    wrapEl.replaceChildren();
  }

  function renderRail(list, cur) {
    var box = $('list');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      (function (m, ix) {
        var id = m.id || m.name;
        var row = el('div', 'mrow s-' + (m.status || 'pending') + (id === S.sel ? ' sel' : ''));
        row.appendChild(el('div', 'av', String(m.name || '?').slice(0, 1)));
        var info = el('div', 'minfo');
        var nm = el('div', 'mname');
        nm.appendChild(el('span', 't', m.name || '成员'));
        if (m.kind === 'solo') nm.appendChild(el('span', 'badge', '子代理'));
        if (m.status === 'running') nm.appendChild(el('span', 'badge', '跑'));
        info.appendChild(nm);
        info.appendChild(el('div', 'mrole', (m.role || '开发') + (ix < 9 ? '  ·  ' + (ix + 1) : '')));
        var tail = el('div', 'mtail');
        var dot = el('span', 'dot ' + (m.status || 'pending'));
        tail.appendChild(dot);
        tail.appendChild(el('span', '', (STATUS[m.status] || m.status || '') + ' · ' + (m.steps || 0) + ' 步/' + (m.toolCalls || 0) + ' 工具'));
        info.appendChild(tail);
        row.appendChild(info);
        row.onclick = function () { select(id); };
        frag.appendChild(row);
      })(list[i], i);
    }
    box.replaceChildren(frag);
  }

  function renderHead(m, st) {
    var head = $('mhead');
    head.replaceChildren();
    if (!m) {
      head.appendChild(el('h2', '', '没有在跑的成员'));
      return;
    }
    var h2 = el('h2');
    h2.appendChild(el('span', '', m.name || '成员'));
    h2.appendChild(el('span', 'role', m.role || ''));
    h2.appendChild(el('span', 'pill ' + (m.status || ''), STATUS[m.status] || m.status || ''));
    head.appendChild(h2);
    var stats = el('div', 'mstats');
    var put = function (label, val) {
      var s = el('span');
      s.appendChild(document.createTextNode(label + ' '));
      s.appendChild(el('b', '', String(val)));
      stats.appendChild(s);
    };
    put('步数', m.steps || 0);
    put('工具', m.toolCalls || 0);
    put('token', fmt(((m.tokens && (m.tokens.input || 0) + (m.tokens.output || 0)) || 0)));
    put('花费', money(m.cost));
    if (m.startedAt) put('用时', dur((m.endedAt || Date.now()) - m.startedAt));
    head.appendChild(stats);

    var gb = $('goalbar');
    var team = (st && st.team) || null;
    if (team) {
      gb.innerHTML = '';
      gb.appendChild(el('b', '', '团队目标 · ' + (team.name || '')));
      gb.appendChild(document.createTextNode('  ' + (team.goal || '（未填写）')));
    } else {
      gb.textContent = m.kind === 'solo' ? '子代理 · 独立上下文' : '';
    }

    var ta = $('msg'), btn = $('send');
    var canSay = m.status === 'running';
    ta.disabled = !canSay;
    btn.disabled = !canSay;
    ta.placeholder = canSay ? '给 ' + (m.name || '成员') + ' 补一句话（Enter 发送，Shift+Enter 换行）' : '他不在运行中，没法传话';
  }

  function renderLog(st) {
    var log = $('log');
    var items = (st && st.log) || [];
    $('logn').textContent = String(items.length);
    var atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      var e = items[i];
      var row = el('div', 'k-' + (e.kind || 'info'));
      row.appendChild(el('span', 'ts', clock(e.ts).slice(0, 8)));
      if (e.who) row.appendChild(el('span', 'who', e.who));
      row.appendChild(el('span', 'msg', e.text));
      frag.appendChild(row);
    }
    log.replaceChildren(frag);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function render(state) {
    S.state = state;
    var list = members();
    var m = pick();
    document.title = (state.title || 'AuroraTui · 团队面板') + (state.team ? ' · ' + (state.team.name || '') : '');
    var t = state.totals || {};
    $('mcount').textContent = (t.done || 0) + '/' + (list.length || t.members || 0);
    $('sub').textContent = state.team
      ? (t.running
          ? '团队「' + (state.team.name || '') + '」· ' + t.running + ' 人跑着 · ' + fmt(t.tokens) + ' tok · ' + money(t.cost)
          : '团队「' + (state.team.name || '') + '」· ' + (t.done || 0) + '/' + (list.length || t.members || 0) + ' 完成' + (t.stopped ? ' · ' + t.stopped + ' 中断' : '') + ' · ' + fmt(t.tokens) + ' tok · ' + money(t.cost))
      : (list.length ? '子代理 · ' + (t.running || 0) + ' 个跑着' : '点左边的成员，看他那一整段对话');
    if (m && m.id !== S.__feedFor) {
      S.__feedFor = m.id;
      resetFeed();
    }
    renderRail(list, m);
    renderHead(m, state);
    renderFeed(m);
    renderLog(state);
    if (S.follow) feedEl.scrollTop = feedEl.scrollHeight;
    $('jump').style.display = S.follow ? 'none' : 'block';
  }

  function select(id) {
    if (S.sel === id) return;
    S.sel = id;
    S.__feedFor = null;
    S.follow = true;
    resetFeed();
    render(S.state || {});
    var m = pick();
    renderHead(m, S.state || {});
  }

  // 滚动：滚上去就停跟随
  feedEl.addEventListener('scroll', function () {
    var near = feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 40;
    S.follow = near;
    $('jump').style.display = near ? 'none' : 'block';
  });
  $('jump').onclick = function () {
    S.follow = true;
    feedEl.scrollTop = feedEl.scrollHeight;
    $('jump').style.display = 'none';
  };

  // 传话
  $('composer').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var ta = $('msg');
    var text = ta.value.trim();
    if (!text) return;
    var m = pick();
    if (!m) return;
    var flash = $('flash');
    flash.className = 'flash';
    flash.textContent = '发送中…';
    fetch('/api/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ member: m.id || m.name, text: text })
    }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (d) {
      flash.className = d && d.ok ? 'good' : 'bad';
      flash.textContent = (d && d.content) || (d && d.ok ? '已送到' : '没送到');
      if (d && d.ok) ta.value = '';
      setTimeout(function () { flash.className = ''; flash.textContent = hintDefault(); }, 4000);
    }).catch(function (e) {
      flash.className = 'bad';
      flash.textContent = '发送失败：' + e;
    });
  });
  function hintDefault() { return '↑↓ 切换成员 · 1-9 直选 · 传话只在成员运行中有效'; }

  // 键盘：↑↓ 切成员，1-9 直选
  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      if (ev.key === 'Escape') ev.target.blur();
      return;
    }
    var list = members();
    if (!list.length) return;
    var cur = -1;
    for (var i = 0; i < list.length; i++) if ((list[i].id || list[i].name) === S.sel) cur = i;
    if (ev.key === 'ArrowDown' || ev.key === 'j') { ev.preventDefault(); select((list[(cur + 1) % list.length] || list[0]).id || list[0].name); }
    else if (ev.key === 'ArrowUp' || ev.key === 'k') { ev.preventDefault(); select((list[(cur - 1 + list.length) % list.length]).id || list[(cur - 1 + list.length) % list.length].name); }
    else if (/^[1-9]$/.test(ev.key) && list[Number(ev.key) - 1]) { var t = list[Number(ev.key) - 1]; select(t.id || t.name); }
    else if (ev.key === '/') { ev.preventDefault(); $('msg').focus(); }
  });

  function connect() {
    var live = $('live');
    var es = new EventSource('/events');
    es.addEventListener('open', function () {
      live.textContent = '实时';
      live.className = 'live on';
    });
    es.addEventListener('state', function (ev) {
      try { render(JSON.parse(ev.data)); } catch (e) {}
    });
    es.addEventListener('error', function () {
      live.textContent = '重连中';
      live.className = 'live off';
    });
  }

  fetch('/api/state').then(function (r) { return r.json(); }).then(render).catch(function () {});
  // ?still = 不要 SSE（截图/存档用：一直挂着的流会让 headless 浏览器永远等不到 load 完成）
  if (!/[?&]still($|[=&])/.test(location.search)) connect();
  else { var lv = $('live'); lv.textContent = '静态'; lv.className = 'live off'; }
  (function () {                                             // ?sel=<序号|名字片段> 直接定位到某个成员
    var m = /[?&]sel=([^&]*)/.exec(location.search);
    if (m && m[1]) { try { S.sel = decodeURIComponent(m[1]); } catch (e) { S.sel = m[1]; } }
  })();
  setInterval(function () {
    var m = pick();
    if (m && m.status === 'running' && S.state) renderHead(m, S.state);
  }, 1000);
})();
</script>
</body>
</html>`;
}
