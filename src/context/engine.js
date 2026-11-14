// billion-context: a folding/expansion engine for conversation history.
//
// Nodes are either
//   { kind:'message', id:'m00001', message:{role,content,...} }
//   { kind:'block',   id:'b1', from:'m00002', to:'m00150', topic, summary, covers:[ids] }
//
// Live nodes are rendered into wire messages; folded blocks are rendered as a
// compact <compressed_history> pseudo-message whose summary carries the state.
// Any block can be expanded back to the original messages at any time.
import { estimateTokens } from '../util.js';

const KEEP_HEAD = 2; // system-side anchor + first user message
const KEEP_TAIL = 8; // recent turns kept verbatim

export class ContextEngine {
  constructor({ maxTokens = 128000, compactAt = 0.72, head = KEEP_HEAD, tail = KEEP_TAIL } = {}) {
    this.maxTokens = maxTokens;
    this.compactAt = compactAt;
    this.head = head;
    this.tail = tail;
    this.nodes = [];
    this.folded = new Map(); // blockId -> { nodes:[...], from, to, topic, summary }
    this.mseq = 0;
    this.bseq = 0;
    this.toolResultBudget = 4200; // chars of a tool result sent to the model
  }

  // ---------------------------------------------------------------- writing
  addMessage(message) {
    const id = `m${String(++this.mseq).padStart(5, '0')}`;
    const node = { kind: 'message', id, message: { ...message }, ts: Date.now() };
    this.nodes.push(node);
    return node;
  }

  addUser(text) {
    return this.addMessage({ role: 'user', content: text });
  }

  addAssistant({ content = '', reasoning, thinkingSignature, toolCalls }) {
    return this.addMessage({ role: 'assistant', content, reasoning, thinkingSignature, toolCalls });
  }

  addToolResult({ toolCallId, name, content, isError, meta, images }) {
    // full text kept on the node; shortened only when rendered
    // images: [{ mime, base64, width, height, path }] —— 工具返回的图片（read 读到的、draw 画出来的），
    // 直接进对话，模型下一轮就能看见
    return this.addMessage({ role: 'tool', toolCallId, name, content, isError, meta, images: images || meta?.images });
  }

  // ----------------------------------------------------------------- stats
  get stats() {
    const msgs = this.nodes.filter((n) => n.kind === 'message');
    const blocks = this.nodes.filter((n) => n.kind === 'block');
    const tokens = this.tokens();
    return {
      messages: msgs.length,
      blocks: blocks.length,
      tokens,
      maxTokens: this.maxTokens,
      used: tokens / this.maxTokens,
      foldedMessages: blocks.reduce((a, b) => a + (b.count || 0), 0),
      storedOriginal: [...this.folded.values()].reduce((a, f) => a + f.nodes.length, 0),
    };
  }

  tokens(nodes = this.nodes) {
    let t = 0;
    for (const n of nodes) {
      if (n.kind === 'block') {
        t += estimateTokens(n.summary || '') + 12;
      } else {
        const m = n.message;
        t += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) + 6;
        if (m.reasoning) t += estimateTokens(m.reasoning);
        if (m.toolCalls) t += estimateTokens(JSON.stringify(m.toolCalls));
        if (m.images?.length) t += 1100 * m.images.length; // 一张图大约按 1100 token 算
      }
    }
    return t;
  }

  needsCompact() {
    return this.tokens() > this.maxTokens * this.compactAt;
  }

  // -------------------------------------------------------------- rendering
  render({ toolBudget = this.toolResultBudget } = {}) {
    const out = [];
    for (const n of this.nodes) {
      if (n.kind === 'block') {
        out.push({
          role: 'context',
          content:
            `<compressed_history ref="${n.id}" range="${n.from}-${n.to}" topic="${(n.topic || '').replace(/"/g, "'")}" messages="${n.count}">\n` +
            `${n.summary}\n</compressed_history>`,
        });
        continue;
      }
      const m = n.message;
      if (m.role === 'tool') {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const cut = text.length > toolBudget ? text.slice(0, toolBudget) + `\n…(已省略 ${text.length - toolBudget} 字符，引用 ${n.id})` : text;
        out.push({
          role: 'tool',
          toolCallId: m.toolCallId,
          name: m.name,
          content: cut,
          isError: m.isError,
          images: m.images,
        });
      } else if (m.role === 'assistant') {
        out.push({
          role: 'assistant',
          text: m.content || '',
          thinking: m.reasoning,
          thinkingSignature: m.thinkingSignature,
          toolCalls: m.toolCalls,
        });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  // ------------------------------------------------------- fold planning
  /** Candidate contiguous range of middle nodes worth folding, or null. */
  planFold() {
    const live = this.nodes;
    if (live.length < this.head + this.tail + 4) return null;
    let start = this.head;
    let end = live.length - this.tail; // exclusive
    // never start on a tool result (its assistant call must come along)
    while (start < end && live[start].kind === 'message' && live[start].message.role === 'tool') start++;
    // never split a tool pair: don't end right after an assistant w/ toolCalls
    while (end > start) {
      const prev = live[end - 1];
      if (prev.kind === 'message' && prev.message.role === 'assistant' && prev.message.toolCalls?.length) end--;
      else break;
    }
    if (end - start < 3) return null;
    // shrink target so compaction is meaningful (aim ~40% of budget)
    const slice = live.slice(start, end);
    return { start, end, nodes: slice, tokens: this.tokens(slice) };
  }

  /** Fold nodes[start,end) into a block with the supplied summary text. */
  fold(start, end, summary, topic) {
    const slice = this.nodes.slice(start, end);
    if (!slice.length) return null;
    const id = `b${++this.bseq}`;
    const from = slice[0].id;
    const to = slice[slice.length - 1].id;
    const count = slice.filter((n) => n.kind === 'message').length;
    this.folded.set(id, { id, from, to, topic, summary, nodes: slice, count });
    const block = { kind: 'block', id, from, to, topic, summary, count, ts: Date.now() };
    this.nodes.splice(start, end - start, block);
    return block;
  }

  /** Restore a compressed block in place (exact original messages). */
  expand(id) {
    const f = this.folded.get(id);
    if (!f) return null;
    const idx = this.nodes.findIndex((n) => n.kind === 'block' && n.id === id);
    if (idx < 0) return null;
    this.nodes.splice(idx, 1, ...f.nodes);
    this.folded.delete(id);
    return f;
  }

  /** Search compressed blocks + live messages. */
  search(query, limit = 5) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const score = (text) => {
      const t = text.toLowerCase();
      let s = 0;
      for (const term of terms) {
        let i = -1;
        while ((i = t.indexOf(term, i + 1)) >= 0) s += 1 + (i < 200 ? 1 : 0);
      }
      return s;
    };
    const hits = [];
    for (const f of this.folded.values()) {
      const body = flattenNodes(f.nodes);
      const s = score(f.summary + '\n' + body) + score(f.topic || '') * 3;
      if (s > 0) {
        hits.push({ ref: f.id, kind: 'block', range: `${f.from}-${f.to}`, topic: f.topic, score: s, excerpt: excerpt(body, terms), chars: body.length });
      }
    }
    for (const n of this.nodes) {
      if (n.kind !== 'message') continue;
      const body = flattenNodes([n]);
      const s = score(body);
      if (s > 0) hits.push({ ref: n.id, kind: 'message', range: n.id, topic: n.message.role, score: s, excerpt: excerpt(body, terms), chars: body.length });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Full text of a range/ref (for expand results). */
  textOf(ref, { maxChars = 20000 } = {}) {
    const f = this.folded.get(ref);
    if (f) {
      const body = flattenNodes(f.nodes);
      return { ref, range: `${f.from}-${f.to}`, topic: f.topic, text: body.length > maxChars ? body.slice(0, maxChars) + '\n…(截断)' : body, chars: body.length };
    }
    const n = this.nodes.find((x) => x.id === ref);
    if (!n) {
      // maybe a range "m00010-m00040"
      const m = /^(m\d+)-(m\d+)$/.exec(ref);
      if (m) {
        const a = this.nodes.findIndex((x) => x.id === m[1]);
        const b = this.nodes.findIndex((x) => x.id === m[2]);
        if (a >= 0 && b >= 0) {
          const body = flattenNodes(this.nodes.slice(a, b + 1));
          return { ref, range: ref, text: body.length > maxChars ? body.slice(0, maxChars) + '\n…(截断)' : body, chars: body.length };
        }
      }
      return null;
    }
    if (n.kind === 'block') return this.textOf(n.id, { maxChars });
    const body = flattenNodes([n]);
    return { ref, range: ref, text: body, chars: body.length };
  }

  /** Mechanical summary used when no model summary is available. */
  mechanicalSummary(nodes) {
    const lines = [];
    let userTopics = 0;
    for (const n of nodes) {
      if (n.kind === 'block') {
        lines.push(`- [${n.id} ${n.from}-${n.to}] ${n.topic || '已压缩片段'}: ${firstLineOf(n.summary)}`);
        continue;
      }
      const m = n.message;
      if (m.role === 'user') {
        userTopics++;
        lines.push(`- 用户: ${clip(m.content, 180)}`);
      } else if (m.role === 'assistant') {
        if (m.toolCalls?.length) lines.push(`- 助手调用: ${m.toolCalls.map((c) => `${c.name}(${clip(JSON.stringify(c.input), 90)})`).join('; ')}`);
        else if (m.content) lines.push(`- 助手: ${clip(m.content, 180)}`);
      } else if (m.role === 'tool') {
        lines.push(`  - ${m.name}${m.isError ? ' 失败' : ''}: ${clip(m.content, 140)}`);
      }
    }
    return `（自动整理的压缩摘要，共 ${nodes.length} 条记录 / ${userTopics} 轮用户请求）\n${lines.join('\n')}`;
  }

  serialize() {
    return {
      nodes: this.nodes,
      folded: [...this.folded.values()].map((f) => ({ ...f })),
      mseq: this.mseq,
      bseq: this.bseq,
    };
  }

  static deserialize(data, opts = {}) {
    const e = new ContextEngine(opts);
    if (!data) return e;
    e.nodes = data.nodes || [];
    e.mseq = data.mseq || 0;
    e.bseq = data.bseq || 0;
    for (const f of data.folded || []) e.folded.set(f.id, f);
    return e;
  }
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function firstLineOf(s) {
  return clip(String(s || '').split('\n')[0], 140);
}

export function flattenNodes(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'block') {
      out.push(`[压缩块 ${n.id} ${n.from}-${n.to}] ${n.topic || ''}\n${n.summary}`);
      continue;
    }
    const m = n.message;
    const tag = m.role === 'tool' ? `tool:${m.name || ''}` : m.role;
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    let line = `[${n.id} ${tag}] ${body}`;
    if (m.toolCalls?.length) line += `\n[tool_calls] ${JSON.stringify(m.toolCalls)}`;
    if (m.reasoning) line += `\n[reasoning] ${m.reasoning}`;
    out.push(line);
  }
  return out.join('\n\n');
}

function excerpt(body, terms, pad = 140) {
  const low = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return body.slice(0, pad * 2).replace(/\s+/g, ' ');
  const s = Math.max(0, at - pad);
  const e = Math.min(body.length, at + pad);
  return (s > 0 ? '…' : '') + body.slice(s, e).replace(/\s+/g, ' ') + (e < body.length ? '…' : '');
}
