// The billion-context tool exposed to the model.
export const contextTool = {
  name: 'context',
  label: 'Context',
  readOnly: true, // `compress` mutates only the context, not the user's files
  description:
    '长期记忆管理（billion-context）。对话过长时会自动把早期历史压缩成摘要块（ref 形如 b1 / 区间 m00010-m00040）。' +
    '用 action:"status" 查看上下文占用与已压缩块；用 action:"search" 在全部历史（含已压缩部分）中按关键词检索；' +
    '用 action:"expand" 拿到某个块/区间的原始完整内容；用 action:"compress" 手动把较早的一段历史折叠成摘要（可给出 topic 与 summary）。' +
    '当你需要早前出现过的细节（原始命令输出、代码片段）时，先 search 再 expand。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'search', 'expand', 'compress'], description: '操作类型' },
      query: { type: 'string', description: 'search 时的关键词' },
      ref: { type: 'string', description: 'expand 时的目标：块 id（b1）、消息 id（m00042）或区间（m00010-m00040）' },
      topic: { type: 'string', description: 'compress 时的主题标签' },
      summary: { type: 'string', description: 'compress 时的摘要正文（不填则自动生成机械摘要）' },
      chars: { type: 'number', description: 'expand 返回的最大字符数，默认 20000' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const engine = ctx.engine;
    if (!engine) return { isError: true, content: '上下文引擎不可用' };
    const action = String(input.action || 'status').toLowerCase();

    if (action === 'status') {
      const s = engine.stats;
      const blocks = engine.nodes.filter((n) => n.kind === 'block');
      const lines = [
        `上下文占用: ${s.tokens} / ${s.maxTokens} tokens (${(s.used * 100).toFixed(1)}%)`,
        `活跃消息: ${s.messages} 条 · 压缩块: ${s.blocks} 个 (已折叠 ${s.foldedMessages} 条消息)`,
        '',
      ];
      if (blocks.length) {
        lines.push('已压缩块:');
        for (const b of blocks) {
          lines.push(`- ${b.id} [${b.from}-${b.to}] ${b.topic || '(无主题)'} · ${b.count} 条 · ${b.summary.length} 字符`);
          lines.push(`  ${b.summary.split('\n').slice(0, 2).join(' / ').slice(0, 220)}`);
        }
      } else {
        lines.push('暂无压缩块。');
      }
      return {
        content: lines.join('\n'),
        meta: { kind: 'context', action, stats: s, used: s.used, tokens: s.tokens, maxTokens: s.maxTokens, blocks: s.blocks, summary: `上下文占用 ${(s.used * 100).toFixed(1)}% · ${s.messages} 条活跃 · ${s.blocks} 个压缩块` },
      };
    }

    if (action === 'search') {
      if (!input.query) return { isError: true, content: 'search 需要 query' };
      const hits = engine.search(input.query, 8);
      if (!hits.length) return { content: `未找到与 “${input.query}” 相关的历史片段。` };
      const lines = hits.map((h, i) => `${i + 1}. [${h.ref}] ${h.range} ${h.kind === 'block' ? `(${h.topic || '压缩块'})` : `(${h.topic})`} · score ${h.score}\n   ${h.excerpt}`);
      return {
        content: `检索 “${input.query}” 命中 ${hits.length} 处（用 action:"expand" + ref 取原文）:\n\n${lines.join('\n\n')}`,
        meta: {
          kind: 'context',
          action,
          hits,
          query: input.query,
          count: hits.length,
          refs: hits.map((h) => h.ref),
          summary: `${hits.map((h) => h.ref).slice(0, 6).join('、')}${hits.length > 6 ? ' …' : ''} · ${hits[0].excerpt}`,
        },
      };
    }

    if (action === 'expand') {
      if (!input.ref) return { isError: true, content: 'expand 需要 ref' };
      const r = engine.textOf(String(input.ref).trim(), { maxChars: Math.max(2000, Math.min(200000, Number(input.chars) || 20000)) });
      if (!r) return { isError: true, content: `找不到 ref: ${input.ref}` };
      return {
        content: `原始内容 [${r.ref}] ${r.range}${r.topic ? ` · ${r.topic}` : ''} (${r.chars} 字符):\n\n${r.text}`,
        meta: { kind: 'context', action, ref: r.ref, range: r.range, topic: r.topic, chars: r.chars, summary: `${r.topic || r.ref} · ${r.range}` },
      };
    }

    if (action === 'compress') {
      const before = engine.stats.tokens;
      const plan = engine.planFold();
      if (!plan) return { content: '当前没有可压缩的历史区间（可能消息太少或已压缩）。' };
      const summary = input.summary || engine.mechanicalSummary(plan.nodes);
      const block = engine.fold(plan.start, plan.end, summary, input.topic || '手动压缩');
      const after = engine.stats;
      return {
        content: `已压缩 ${plan.nodes.length} 条记录 → ${block.id} [${block.from}-${block.to}]\n现在占用 ${after.tokens} / ${after.maxTokens} tokens (${(after.used * 100).toFixed(1)}%)`,
        meta: {
          kind: 'context',
          action,
          block: block.id,
          from: block.from,
          to: block.to,
          nodes: plan.nodes.length,
          before,
          after: after.tokens,
          used: after.used,
          summary: `${input.topic || block.topic || '手动压缩'} · ${plan.nodes.length} 条 → ${block.id}`,
        },
      };
    }

    return { isError: true, content: `未知 action: ${input.action}` };
  },
};
