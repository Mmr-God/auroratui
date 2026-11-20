// 对话记录（Transcript）：把 Agent 的原生事件攒成一串「折叠好的对话条」，
// 子代理 / 团队成员共用。以前它住在 progress.js（浏览器面板）里，
// 面板下线后独立成模块 —— 记录本身仍然有用：出错时能回放它走了哪几步。

const EV_MAX = 160; // 最多保留多少条
const EV_BUDGET = 22000; // 总字符预算（超了从第二条开始丢最老的）
const CLIP_TEXT = 4000;
const CLIP_TOOL = 2500;

export const clip = (s, n) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}\n…（后面还有 ${v.length - n} 字符，已省略）` : v;
};

const oneLine = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 从工具入参里挑一个能代表这次调用的短文本。 */
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

  /** 玩家中途插的一句话。 */
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
