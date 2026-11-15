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
const MIN_TOOL_BUDGET = 700; // 再挤也要给工具结果留一点内容

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
    // 给模型这次输出预留的空间：预算 = 窗口 - 预留，避免“输入刚好塞满 → 没有位置输出”
    this.reserveTokens = 0;
    // 真正请求前如果仍然超了，渲染层会逐级压缩工具输出（最后一道保险）
    this.hardCapAt = 0.94;
  }

  /** 可用于输入的有效窗口（扣掉输出预留）。 */
  get budget() {
    return Math.max(2000, this.maxTokens - Math.max(0, this.reserveTokens || 0));
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
      budget: this.budget,
      wire: this.wireTokens(this.toolResultBudget),
      used: tokens / this.maxTokens,
      foldedMessages: blocks.reduce((a, b) => a + (b.count || 0), 0),
      storedOriginal: [...this.folded.values()].reduce((a, f) => a + f.nodes.length, 0),
    };
  }

  /**
   * 真正发出去的内容大约多少 token。tokens() 统计的是完整存储内容，
   * 而 render() 会截断老工具结果；压缩判断必须按“发出去的”算，否则会误判。
   */
  wireTokens(toolBudget = this.toolResultBudget) {
    let t = 0;
    for (const n of this.nodes) {
      if (n.kind === 'block') {
        t += estimateTokens(n.summary || '') + 12;
        continue;
      }
      const m = n.message;
      if (m.role === 'tool') {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const used = Math.min(text.length, toolBudget) + (text.length > toolBudget ? 40 : 0);
        t += estimateTokens('x'.repeat(used)) + 6;
        if (m.images?.length) t += 1100 * m.images.length;
      } else {
        t += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) + 6;
        if (m.reasoning) t += estimateTokens(m.reasoning);
        if (m.toolCalls) t += estimateTokens(JSON.stringify(m.toolCalls));
        if (m.images?.length) t += 1100 * m.images.length;
      }
    }
    return t;
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

  /** extra：马上要追加的输入（比如一条新用户消息）估算 token。 */
  needsCompact(extra = 0) {
    return this.wireTokens(this.toolResultBudget) + extra > this.budget * this.compactAt;
  }

  /** 已经挤到硬上限（再发就可能被服务端拒绝）。 */
  critical() {
    return this.wireTokens(MIN_TOOL_BUDGET) > this.budget * this.hardCapAt;
  }

  /** 渲染前自适应的工具结果预算：越接近上限，老工具输出保留得越少。 */
  adaptiveToolBudget() {
    let b = this.toolResultBudget;
    for (let i = 0; i < 5 && this.wireTokens(b) > this.budget * this.compactAt; i++) {
      b = Math.max(MIN_TOOL_BUDGET, Math.floor(b * 0.55));
    }
    return b;
  }

  // -------------------------------------------------------------- rendering
  render({ toolBudget = null } = {}) {
    const budget = toolBudget == null ? this.adaptiveToolBudget() : toolBudget;
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
        const cut = text.length > budget ? text.slice(0, budget) + `\n…(已省略 ${text.length - budget} 字符，引用 ${n.id}；需要时用 context expand 取回)` : text;
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
  /**
   * Candidate contiguous range of middle nodes worth folding, or null.
   * tail 越小折得越狠（上下文吃紧时 agent 会依次用 8 → 4 → 2 → 1）。
   */
  planFold({ tail = this.tail, minNodes = 3 } = {}) {
    const live = this.nodes;
    if (live.length < this.head + 1 + Math.max(1, tail)) return null;
    let start = this.head;
    let end = Math.max(start, live.length - Math.max(1, tail)); // exclusive
    // 起点不能落在工具结果上：它的 assistant 调用必须一起带走
    while (start < end && live[start].kind === 'message' && live[start].message.role === 'tool') start++;
    // 终点不能把 assistant(tool_calls) 和它的 tool 结果拆开：宁可多留几条
    while (end > start && end < live.length) {
      const prev = live[end - 1];
      const next = live[end];
      const prevCalls = prev?.kind === 'message' && prev.message.role === 'assistant' && prev.message.toolCalls?.length;
      const nextIsTool = next?.kind === 'message' && next.message.role === 'tool';
      if (prevCalls || nextIsTool) end++;
      else break;
    }
    // 起点后如果紧跟着 tool 结果（assistant 被切在 start 之外），把 assistant 拉回来
    if (start > this.head) {
      const prev = live[start - 1];
      const prevCalls = prev?.kind === 'message' && prev.message.role === 'assistant' && prev.message.toolCalls?.length;
      const curIsTool = live[start]?.kind === 'message' && live[start].message.role === 'tool';
      if (prevCalls && curIsTool) start--;
    }
    if (end - start < minNodes) return null;
    const slice = live.slice(start, end);
    return { start, end, nodes: slice, tokens: this.tokens(slice) };
  }

  /**
   * 应急：老图片只留最近 keep 张。图片每张按 ~1100 token 算，是最贵的历史。
   * 返回省下的图片张数（0 表示没动）。
   */
  trimImages(keep = 2) {
    let seen = 0;
    let dropped = 0;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.kind !== 'message' || !n.message.images?.length) continue;
      if (seen < keep) {
        seen += n.message.images.length;
        continue;
      }
      dropped += n.message.images.length;
      n.message.images = undefined;
    }
    return dropped;
  }

  /** 最近的用户请求 + 压缩块主题，用于给模型一份“会话脉络”防遗忘。 */
  brief({ maxChars = 2600 } = {}) {
    const users = [];
    for (const n of this.nodes) {
      if (n.kind === 'message' && n.message.role === 'user') users.push(String(n.message.content || ''));
    }
    const blocks = this.nodes.filter((n) => n.kind === 'block');
    const lines = [];
    for (const b of blocks.slice(-4)) lines.push(`- [${b.id} ${b.from}-${b.to}] ${b.topic || '历史'}：${firstLineOf(b.summary)}`);
    for (const u of users.slice(-4)) lines.push(`- 用户：${clip(u, 200)}`);
    if (!lines.length) return '';
    let text = lines.join('\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
    return text;
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
