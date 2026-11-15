// 工具块「封装」测试：每种工具调用都应该压成
//   一行标题（✓ 标签 · 标签…  用时）+ 一行摘要（收起）+ 一行注脚（展开）
// 这里既检查工具返回的 meta（给 UI 的原料），也检查 describeTool 与真实渲染。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-toolview-'));
process.env.AGENT_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tv-ws-'));

const { Config } = await import('../src/config.js');
const { App } = await import('../src/ui/app.js');
const { describeTool, kNum } = await import('../src/ui/toolview.js');
const { stripAnsi, strWidth } = await import('../src/util.js');
const { contextTool } = await import('../src/tools/context.js');
const { skillTool } = await import('../src/tools/skill.js');
const { todoTool } = await import('../src/tools/todo.js');

const log = (m = '') => fs.writeSync(1, m + '\n');
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) return log(`√ ${name}`);
  failed++;
  log(`× ${name}${detail ? ` — ${detail}` : ''}`);
}

// --------------------------------------------------------------- 假引擎
function fakeEngine() {
  const state = { tokens: 40000, blocks: [] };
  state.blocks.push({ kind: 'block', id: 'b1', from: 'm00010', to: 'm00040', count: 12, topic: '格斗手感', summary: 'accel 900' });
  return {
    nodes: state.blocks,
    get stats() {
      return { messages: 42, blocks: state.blocks.filter((b) => b.kind === 'block').length, tokens: state.tokens, maxTokens: 128000, used: state.tokens / 128000 };
    },
    planFold: () => ({ start: 'm00100', end: 'm00160', nodes: new Array(12).fill({ kind: 'message' }) }),
    fold: (start, end, summary, topic) => {
      const b = { kind: 'block', id: 'b3', from: start, to: end, count: 12, topic, summary };
      state.blocks.push(b);
      state.tokens = 21000;
      return b;
    },
    textOf: () => ({ ref: 'b1', range: 'm00010-m00040', topic: '格斗手感', chars: 8200, text: 'a\nb\nc' }),
    search: () => [{ ref: 'b1', range: 'm00010-m00040', kind: 'block', topic: '格斗手感', score: 9, excerpt: 'accel 900 friction 1200' }],
    mechanicalSummary: () => '自动摘要',
  };
}

// ------------------------------------------------- 工具 meta（UI 的原料）
const engine = fakeEngine();
const item = (name, input, res) => ({ kind: 'tool', name, input, status: res.isError ? 'error' : 'ok', isError: !!res.isError, content: res.content, meta: res.meta, dur: 3, collapsible: true, collapsed: true, ver: 1 });

const st = await contextTool.execute({ action: 'status' }, { engine });
check('context status meta 带占用率/块数', st.meta.used > 0.3 && st.meta.blocks === 1 && !!st.meta.summary, JSON.stringify(st.meta));

const sr = await contextTool.execute({ action: 'search', query: '格斗' }, { engine });
check('context search meta 带命中数', sr.meta.count === 1 && sr.meta.query === '格斗' && !!sr.meta.summary, JSON.stringify(sr.meta));

const ex = await contextTool.execute({ action: 'expand', ref: 'b1' }, { engine });
check('context expand meta 带 ref/range/字符数', ex.meta.ref === 'b1' && ex.meta.range === 'm00010-m00040' && ex.meta.chars === 8200, JSON.stringify(ex.meta));

const t0 = engine.stats.tokens;
const cp = await contextTool.execute({ action: 'compress', topic: '手动压缩' }, { engine });
check(
  'context compress meta 带前后 token 与条数',
  cp.meta.block === 'b3' && cp.meta.nodes === 12 && cp.meta.before === t0 && cp.meta.after === 21000,
  JSON.stringify(cp.meta),
);

fs.mkdirSync(path.join(WS, '.agent', 'skills'), { recursive: true });
fs.writeFileSync(path.join(WS, '.agent', 'skills', 'godot-ai.md'), '---\nname: godot-ai\ndescription: Godot 4.x 游戏开发流程\n---\n\n1. 建场景\n2. 调手感\n');
const sk = await skillTool.execute({ action: 'load', name: 'godot-ai' }, { cwd: WS });
check('skill load meta.skill 完整', sk.meta.skill.name === 'godot-ai' && sk.meta.skill.chars > 0 && sk.meta.summary === 'Godot 4.x 游戏开发流程', JSON.stringify(sk.meta));

const td = await todoTool.execute({ action: 'set', items: ['a', 'b', 'c'] }, { cwd: WS });
check('todo set meta 带进度', td.meta.total === 3 && td.meta.done === 0 && /0\/3/.test(td.meta.summary), JSON.stringify(td.meta));

// ------------------------------------------------------ describeTool 封装
const vStatus = describeTool(item('context', { action: 'status' }, st));
check('context status 封装：标签=上下文 + 三项小标', vStatus.label === '上下文' && vStatus.tags.length >= 2 && vStatus.tone === 'memory', JSON.stringify(vStatus));
check('context status 摘要不是裸首行', /tokens|活跃|压缩块/.test(vStatus.summary), vStatus.summary);

const vSearch = describeTool(item('context', { action: 'search', query: '格斗' }, sr));
check('context search 封装：命中数进小标', vSearch.label === '搜索' && vSearch.hint === '格斗' && vSearch.tags.some((t) => /命中 1 处/.test(t.t)), JSON.stringify(vSearch));

const vExpand = describeTool(item('context', { action: 'expand', ref: 'b1' }, ex));
check('context expand 封装：标签=ref', vExpand.label === 'b1' && vExpand.tags.some((t) => /8\.2k 字符/.test(t.t)), JSON.stringify(vExpand));

const vCompress = describeTool(item('context', { action: 'compress' }, cp));
check(
  'context compress 封装：块 id + 条数 + 前后 token',
  vCompress.label === 'b3' && vCompress.tags.some((t) => t.t === '12 条') && vCompress.tags.some((t) => /40k→21k tok/.test(t.t)),
  JSON.stringify(vCompress),
);
check('compress 展开注脚提到区间', /m00100-m00160/.test(vCompress.note), vCompress.note);

const vSkill = describeTool(item('skill', { action: 'load', name: 'godot-ai' }, sk));
check(
  'skill 封装：标题 = Call Skill: 技能名',
  vSkill.label === 'Call Skill: godot-ai' && !vSkill.tags.some((t) => t.t === '技能') && vSkill.summary === 'Godot 4.x 游戏开发流程',
  JSON.stringify(vSkill),
);
const vSkillList = describeTool({ kind: 'tool', name: 'skill', input: { action: 'list' }, content: '- a' });
check('skill list 保持标签「技能」且不带 Call Skill 前缀', vSkillList.label === 'skill' && vSkillList.tags.some((t) => t.t === '技能'), JSON.stringify(vSkillList));
check('skill 展开注脚提到行数', /行/.test(vSkill.note), vSkill.note);

const vTodo = describeTool(item('todo', { action: 'set' }, td));
check('todo 封装：0/3 完成', vTodo.tags.some((t) => /0\/3 完成/.test(t.t)) && vTodo.summary.includes('下一项 a'), JSON.stringify(vTodo));

const vBrowserOpen = describeTool(
  item('browser', { action: 'open', url: 'https://a.com' }, { content: 'x', meta: { chars: 24300, url: 'https://a.com', title: 'T' } }),
);
check('browser open 封装：字符数小标', vBrowserOpen.tags.some((t) => /24k 字符/.test(t.t)) && vBrowserOpen.hint.includes('https://a.com'), JSON.stringify(vBrowserOpen));

const vBrowserShot = describeTool(
  item('browser', { action: 'screenshot', url: 'https://a.com' }, { content: 'x', meta: { bytes: 214000, size: '1280x900' } }),
);
check('browser screenshot 封装：尺寸 + 大小', vBrowserShot.tags.some((t) => t.t === '1280x900') && vBrowserShot.tags.some((t) => /KB/.test(t.t)), JSON.stringify(vBrowserShot));

const vMemory = describeTool(item('memory', { action: 'list' }, { content: 'a = 1', meta: { action: 'list', count: 1, summary: '1 条记忆：a' } }));
check('memory 封装：条数小标', vMemory.tags.some((t) => t.t === '1 条'), JSON.stringify(vMemory));

// 没有 meta 的工具（shell / ask / 老会话回放）不能炸
const vPlain = describeTool({ kind: 'tool', name: 'shell', input: { command: 'ls' }, content: '', status: 'ok' });
check('无 meta 时回落到工具名 + 参数', vPlain.label === 'shell' && vPlain.hint === 'ls' && vPlain.tags.length === 0);
check('完全空的 item 也不炸', (() => { try { describeTool({}); return true; } catch { return false; } })());
check('kNum 压缩数字', kNum(21000) === '21k' && kNum(8200) === '8.2k' && kNum(999) === '999', `${kNum(21000)} ${kNum(8200)} ${kNum(999)}`);

// ------------------------------------------------------------- 真实渲染
const app = new App({ config: new Config(), cwd: WS });
const W = 100;
app.width = W;
function render(rec) {
  return app.renderItem(Object.assign({ kind: 'tool', dur: 3, collapsible: true, collapsed: true, ver: 1 }, rec), W).map(stripAnsi);
}
const all = [
  ['context', { action: 'status' }, st],
  ['context', { action: 'search', query: '格斗' }, sr],
  ['context', { action: 'expand', ref: 'b1' }, ex],
  ['context', { action: 'compress' }, cp],
  ['skill', { action: 'load', name: 'godot-ai' }, sk],
  ['todo', { action: 'set' }, td],
];
for (const [name, input, res] of all) {
  const lines = render({ name, input, status: 'ok', content: res.content, meta: res.meta });
  const head = lines[0] || '';
  const tags = describeTool({ name, input, meta: res.meta, content: res.content }).tags.map((t) => t.t);
  check(
    `渲染 ${name} ${input.action}：✓ 开头 + 标签齐全 + 不超宽`,
    head.trimStart().startsWith('√') && tags.every((t) => head.includes(t)) && strWidth(head) <= W - 1,
    `head=${JSON.stringify(head)} tags=${JSON.stringify(tags)}`,
  );
  check(`渲染 ${name} ${input.action}：收起有摘要行`, lines.length >= 2 && lines[1].trim().length > 2, JSON.stringify(lines.slice(1)));
}

// 展开态：正文 + 注脚
const openLines = render({ name: 'context', input: { action: 'compress' }, status: 'ok', content: cp.content, meta: cp.meta, collapsed: false });
check('展开态带注脚（已折叠为 b3）', openLines.some((l) => /已折叠为 b3/.test(l)), JSON.stringify(openLines));

// 失败态：× 开头，标签还在
const errLines = render({ name: 'context', input: { action: 'expand', ref: 'b9' }, status: 'error', isError: true, content: '找不到 ref: b9', meta: { kind: 'context', action: 'expand' } });
check('失败态用 × 且保留标签', errLines[0].includes('×') && errLines[0].includes('展开') && errLines[0].includes('失败'), JSON.stringify(errLines[0]));

// 运行中：spinner + 标签（此时还没有 meta，靠 input 兜住）
const runLines = render({ name: 'skill', input: { action: 'load', name: 'godot-ai' }, status: 'running', content: '', meta: undefined });
check('运行中显示 Call Skill: 技能名', runLines[0].includes('Call Skill: godot-ai'), JSON.stringify(runLines[0]));

// draw 画板：标题带画板名、尺寸、这轮画了几笔；[图片] 徽章说明模型看见了
const drawMeta = { kind: 'image', board: 'slime', size: '32x32', applied: 5, scale: 8, bytes: 1024, images: [{ mime: 'image/png', width: 256, height: 256 }], summary: 'slime 32x32 · 5 op' };
const drawLines = render({ name: 'draw', input: { name: 'slime' }, status: 'ok', content: '画板「slime」…', meta: drawMeta });
check('draw 标题带画板名与标签', drawLines[0].includes('draw · slime') && drawLines[0].includes('画板') && drawLines[0].includes('32x32') && drawLines[0].includes('5 op'), JSON.stringify(drawLines[0]));
check('draw 收起摘要说清尺寸与 op 数', drawLines.some((l) => /slime 32x32 · 5 op/.test(l)), JSON.stringify(drawLines.slice(1)));
const drawView = describeTool({ name: 'draw', input: { name: 'slime', view: true }, meta: drawMeta });
check('draw view 标「只看」', drawView.hint === '只看', JSON.stringify(drawView));
const drawBig = describeTool({ name: 'draw', input: { name: 'x' }, meta: { kind: 'draw', tooBig: true } });
check('draw 超大图标「未内联」', drawBig.tags.some((t) => t.t === '未内联'), JSON.stringify(drawBig.tags));

log(failed ? `\n${failed} check(s) failed` : '\nALL TOOLVIEW CHECKS PASSED');
process.exit(failed ? 1 : 0);
