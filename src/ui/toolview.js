// 工具块的「封装」层：把一次工具调用压成
//   一行标题（✓ 标签 · 标签 · 标签  用时）+ 收起时的一行摘要 + 展开时的注脚。
// 这里只产数据（文字 + 色调名），颜色与排版交给 app.js，方便单测。
import { fmtBytes, fmtNum } from '../util.js';

/** 数字压短：12345 → 12.3k（上下文用，省地方）。 */
export function kNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return String(Math.round(v));
}

const oneLine = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const linesOf = (s) => String(s || '').split(String.fromCharCode(10)).length;

// 老位置：每种工具「参数 → 一行提示」（放在标签后面）
const HINTS = {
  shell: (i) => i.command,
  jobs: (i) => `${i.action || 'list'}${i.id ? ` ${i.id}` : ''}`,
  diagnostics: (i) => i.check || (i.command ? oneLine(i.command, 50) : '自动探测'),
  patch: (i) => oneLine(String(i.diff || '').split('\n').find((l) => l.startsWith('+++ '))?.slice(4) || '', 50),
  read: (i) => i.path,
  write: (i) => i.path,
  edit: (i) => i.path,
  web_search: (i) => i.query,
  web_fetch: (i) => i.url,
  context: (i) => `${i.action || 'status'}`,
  skill: (i) => (String(i.action || '').toLowerCase() === 'load' ? '' : i.action),
  todo: (i) => (i.action && i.action !== 'list' ? i.action : ''),
  subagent: (i) => i.name || oneLine(i.task, 60),
  team: (i) => i.action || '',
  draw: (i) => i.name || '',
};

const tag = (t, s = 'info') => ({ t, s });

/**
 * @returns {{label:string, hint:string, tags:{t:string,s:string}[], summary:string, note:string, tone:string}}
 *  tone: 'tool'（默认，蓝）| 'skill'（技能）| 'memory'（billion-context）
 */
export function describeTool(item = {}) {
  const name = String(item.name || '');
  const input = item.input || {};
  const meta = item.meta || {};
  const view = {
    label: name,
    hint: oneLine((HINTS[name] || (() => ''))(input)),
    tags: [],
    summary: oneLine(meta.summary || ''),
    note: '',
    tone: 'tool',
  };

  if (name === 'jobs') {
    const action = String(input.action || 'list').toLowerCase();
    view.label = `jobs · ${action}`;
    if (action === 'list') {
      if (meta.running) view.tags.push(tag(`${meta.running} 个在跑`, 'ok'));
      view.tags.push(tag(`${meta.count || 0} 条`));
    } else if (action === 'tail') {
      if (meta.running) view.tags.push(tag('实时', 'ok'));
      if (meta.status) view.tags.push(tag(meta.status, meta.status === 'ok' ? 'ok' : meta.status === 'running' ? 'info' : 'warn'));
      if (meta.lines) view.tags.push(tag(`${meta.lines} 行`));
    } else if (action === 'kill') {
      view.tags.push(tag(meta.killed ? '已终止' : '未终止', meta.killed ? 'warn' : 'info'));
    }
    return view;
  }

  if (name === 'diagnostics') {
    view.label = 'diagnostics';
    if (meta.checks?.length) view.tags.push(tag(meta.checks.join('+'), 'skill'));
    if (meta.errors) view.tags.push(tag(`${meta.errors} 错误`, 'warn'));
    if (meta.warnings) view.tags.push(tag(`${meta.warnings} 警告`, 'warn'));
    if (meta.total === 0) view.tags.push(tag('干净', 'ok'));
    if (meta.total) view.tags.push(tag(`${meta.total} 条`));
    return view;
  }

  if (name === 'patch') {
    view.label = 'patch';
    if (meta.dryRun) view.tags.push(tag('试跑', 'skill'));
    const nf = (meta.files || []).length;
    if (nf) view.tags.push(tag(`${nf} 文件`));
    if (meta.added || meta.removed) view.tags.push(tag(`+${meta.added || 0} −${meta.removed || 0}`, 'ok'));
    if (meta.created) view.tags.push(tag(`新建 ${meta.created}`));
    if (meta.deleted) view.tags.push(tag(`删除 ${meta.deleted}`, 'warn'));
    return view;
  }

  if (name === 'subagent') {
    const s = meta.subagent || {};
    view.label = s.name ? `subagent · ${s.name}` : 'subagent';
    view.tags.push(tag('子代理', 'memory'));
    if (s.role) view.tags.push(tag(s.role));
    if (s.steps) view.tags.push(tag(`${s.steps} 步`));
    if (s.toolCalls) view.tags.push(tag(`${s.toolCalls} 次工具`));
    const tok = (s.tokens?.input || 0) + (s.tokens?.output || 0);
    if (tok) view.tags.push(tag(`${kNum(tok)} tok`));
    if (s.secs) view.tags.push(tag(`${s.secs}s`));
    if (!view.summary) view.summary = oneLine(input.task, 100);
    view.tone = 'memory';
    return view;
  }

  if (name === 'team') {
    const t = meta.team || {};
    const action = String(input.action || '').toLowerCase();
    view.label = action === 'create' ? `team · ${input.name || 'AI 小队'}` : `team · ${action || 'status'}`;
    view.tags.push(tag('团队', 'memory'));
    if (action === 'create') {
      view.tags.push(tag(`${t.members || (input.members || []).length} 人`));
      if (t.concurrency) view.tags.push(tag(`并发 ${t.concurrency}`));
      view.summary = oneLine(input.goal, 100);
    } else if (t.totals) {
      view.tags.push(tag(`${t.totals.done || 0}/${t.totals.members || 0} 完成`));
      if (t.totals.tokens) view.tags.push(tag(`${kNum(t.totals.tokens)} tok`));
    }
    view.tone = 'memory';
    return view;
  }

  if (name === 'skill') {
    const sk = meta.skill || null;
    const loading = String(input.action || '').toLowerCase() === 'load';
    // 调技能渲染成「Call Skill: 技能名」——一眼看出在调哪个技能，而不是干巴巴一个 skill
    const skName = sk?.name || (loading ? String(input.name || '') : '');
    view.label = skName ? `Call Skill: ${skName}` : name;
    if (!loading) view.tags.push(tag('技能', 'skill'));
    if (sk?.scope) view.tags.push(tag(sk.scope));
    if (sk?.chars) view.tags.push(tag(`${fmtNum(sk.chars)} 字`));
    if (sk?.description) view.summary = oneLine(sk.description);
    const total = linesOf(item.content);
    if (loading && total > 1 && item.status !== 'running' && !item.isError) view.note = `技能正文已进上下文（共 ${total} 行）`;
    return view;
  }

  if (name === 'context') {
    const action = String(meta.action || input.action || 'status').toLowerCase();
    view.tone = 'memory';
    view.hint = '';
    if (action === 'compress') {
      view.label = meta.block || '压缩';
      view.tags.push(tag('压缩', 'memory'));
      if (meta.nodes) view.tags.push(tag(`${meta.nodes} 条`));
      if (meta.before && meta.after != null) view.tags.push(tag(`${kNum(meta.before)}→${kNum(meta.after)} tok`));
      view.note = `区间 ${meta.from || '?'}-${meta.to || '?'} 已折叠为 ${meta.block || '块'}`;
    } else if (action === 'expand') {
      view.label = meta.ref || String(input.ref || '');
      view.tags.push(tag('展开', 'memory'));
      if (meta.range) view.tags.push(tag(meta.range));
      if (meta.chars) view.tags.push(tag(`${kNum(meta.chars)} 字符`));
      view.note = '原始内容已进上下文';
    } else if (action === 'search') {
      view.label = '搜索';
      view.hint = oneLine(meta.query || input.query || '');
      view.tags.push(tag(`命中 ${meta.count ?? meta.hits?.length ?? 0} 处`));
    } else {
      view.label = '上下文';
      if (meta.used != null) view.tags.push(tag(`${(meta.used * 100).toFixed(1)}%`));
      if (meta.tokens != null && meta.maxTokens) view.tags.push(tag(`${kNum(meta.tokens)}/${kNum(meta.maxTokens)}`));
      if (meta.blocks != null) view.tags.push(tag(`${meta.blocks} 块`));
    }
    return view;
  }

  if (name === 'todo' && Array.isArray(meta.todo)) {
    const total = meta.total ?? meta.todo.length;
    const done = meta.done ?? meta.todo.filter((t) => t.status === 'done').length;
    view.hint = '';
    if (!total) view.tags.push(tag('空', 'info'));
    else if (done >= total) view.tags.push(tag('全部完成', 'ok'));
    else view.tags.push(tag(`${done}/${total} 完成`));
    return view;
  }

  if (name === 'draw') {
    // 画板工具：把「画板名 + 尺寸 + 这轮画了几笔」摆在标题上，玩家一眼看出在改哪张画
    view.label = `draw · ${input.name || 'board'}`;
    view.tags.push(tag('画板', 'skill'));
    if (meta.size) view.tags.push(tag(meta.size));
    if (meta.applied) view.tags.push(tag(`${meta.applied} op`));
    if (meta.scale > 1) view.tags.push(tag(`${meta.scale}×`));
    if (meta.tooBig) view.tags.push(tag('未内联', 'warn'));
    view.hint = input.view ? '只看' : '';
    return view;
  }

  if (name === 'memory') {
    if (meta.count != null) view.tags.push(tag(`${meta.count} 条`));
    if (meta.key) view.tags.push(tag(meta.key));
    return view;
  }

  return view;
}
