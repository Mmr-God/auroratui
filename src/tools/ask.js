// ask — 让 AI 在不确定的时候停下来问玩家。
// 这是唯一一个"会等人"的工具：execute 会一直挂着，直到玩家在界面上选了选项
// （或自己敲了答案 / 按 ESC 取消），然后把结果当作工具结果交回给模型。
//
// 交互能力由宿主注入：ctx.ask({question, options, multi, default}) → Promise<
//   {answer: string} | {selections: string[]} | null>  （null = 玩家取消）
// TUI 里是弹出选择面板，--plain 模式下退化成终端问答。

function normOptions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const o of list) {
    if (o == null) continue;
    if (typeof o === 'string') {
      const s = o.trim();
      if (s) out.push({ label: s, desc: '' });
    } else if (typeof o === 'object') {
      const label = String(o.label ?? o.title ?? o.text ?? o.value ?? '').trim();
      if (!label) continue;
      out.push({ label, desc: String(o.desc ?? o.description ?? '') });
    }
  }
  return out.slice(0, 9);
}

export const askTool = {
  name: 'ask',
  readOnly: false,
  description:
    '向玩家提问并等待回答。当你不确定玩家意图、缺少关键信息、或要在几种方案之间取舍时，' +
    '用这个工具给出 2-5 个具体选项让玩家选，而不是自己猜着做。' +
    '玩家可以选择其中一个选项（multi=false）或多个选项（multi=true），也可以自己输入选项以外的答案。' +
    '需要改文件/删东西/不可逆操作但信息不足时，优先先问。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问玩家的问题，一句话说清，别啰嗦' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '2-5 个选项，简短明确（例如 "只改 src/ui/app.js" / "顺带改测试"）',
      },
      multi: { type: 'boolean', description: '是否可多选，默认 false' },
      default: { type: 'string', description: '玩家不想选时的默认答案（可选）' },
    },
    required: ['question', 'options'],
  },
  async execute(input, ctx) {
    const question = String(input?.question || '').trim();
    if (!question) return { isError: true, content: '缺少 question：要问玩家什么？' };
    const options = normOptions(input?.options);
    if (options.length < 2) {
      return { isError: true, content: 'options 至少要有 2 个，玩家才好在里面选（也可以让玩家自己输入）。' };
    }
    const multi = !!input?.multi;
    const fallback = input?.default == null ? '' : String(input.default);

    if (typeof ctx?.ask !== 'function') {
      return {
        isError: true,
        content:
          '当前环境不支持交互提问（没有交互界面）。请直接说明你的假设，按最合理的方案继续，并在结尾标注你假设了什么。',
      };
    }

    let result;
    try {
      result = await ctx.ask({ question, options, multi, default: fallback });
    } catch (e) {
      return { isError: true, content: `提问失败：${e?.message || e}` };
    }

    if (result == null || result.cancelled) {
      const tail = fallback ? `玩家没有回答。请采用默认值「${fallback}」继续。` : '玩家没有回答（取消或跳过）。请自行做最合理的假设继续，并在结尾说明这个假设。';
      return { content: tail, meta: { cancelled: true } };
    }
    if (Array.isArray(result.selections) && result.selections.length) {
      return { content: `玩家选择了：${result.selections.join(' / ')}`, meta: { selections: result.selections } };
    }
    const answer = String(result.answer ?? '').trim();
    if (!answer) return { content: '玩家没有给出内容。请自行做最合理的假设继续，并在结尾说明这个假设。' };
    return { content: `玩家回答：${answer}`, meta: { answer } };
  },
};
