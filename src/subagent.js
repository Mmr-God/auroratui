// 子代理（subagent）：主 agent 派生一个**独立上下文**的助手去啃一块子任务，
// 干完只把结论带回来 —— 主对话不会被它读的一堆文件撑爆。
//
// 实现上不重写一套循环：直接复用 Agent（流式 / 重试 / 自动压缩 / 检查点全都有），
// 只是换角色提示、限制工具集、限制步数与超时，并把事件转发给 TUI。
//
// 注意：本模块被 src/tools/subagent.js 引用，而 tools/index.js 又引用它（循环引用）。
// 所以对 Agent / getTool 的引用一律放在函数体里（静态导入会撞上 TDZ：
// 单独 import tools/team.js 时 tools/index.js 还没初始化完）。

// 子代理默认可用的工具：和主代理基本一致（skill / context / 插件工具也要给，
// 否则成员遇到压缩包、反编译、像素画这类活就干不了，只能自己写脚本重造轮子）。
// 只排除三类：能派生的（subagent/team，防递归）、要界面的（ask）、改程序本体的（plugin）。
export const SUB_DEFAULT_TOOLS = [
  'read', 'write', 'edit', 'patch', 'shell', 'jobs', 'diagnostics',
  'glob', 'grep', 'ls', 'think',
  'todo', 'memory', 'skill', 'context',
  'web_search', 'web_fetch', 'http_request', 'git',
];

/**
 * 内置 preset：只读侦察。查代码、定位符号、摸清调用链专用 ——
 * 拿不到 write/edit/shell，物理上不可能改坏东西，也不会顺手跑个命令把状态搞乱。
 * 派子代理时写 tools:'scout' 即可，不用再手敲一堆工具名。
 */
export const TOOL_PRESETS = {
  scout: ['read', 'grep', 'glob', 'ls', 'think'],
  readonly: ['read', 'grep', 'glob', 'ls', 'think', 'git'],
  // 只跑测试 / 构建的：能跑命令但不会写文件（验证别人的产出很好用）
  verify: ['read', 'grep', 'glob', 'ls', 'shell', 'git', 'think', 'diagnostics'],
};

/** 把 preset 名字（scout / readonly / verify）或数组解析成工具名清单。 */
export function expandToolNames(names) {
  if (typeof names === 'string') {
    const key = names.trim().toLowerCase();
    if (TOOL_PRESETS[key]) return [...TOOL_PRESETS[key]];
    return key ? key.split(/[\s,]+/).filter(Boolean) : null;
  }
  if (!Array.isArray(names)) return null;
  const out = [];
  for (const n of names) {
    const key = String(n || '').trim().toLowerCase();
    if (!key) continue;
    if (TOOL_PRESETS[key]) out.push(...TOOL_PRESETS[key]);
    else out.push(key);
  }
  return out.length ? out : null;
}

// 子代理永远拿不到的工具（就算玩家/模型在 tools 里点名）
const FORBIDDEN = new Set(['ask', 'subagent', 'team', 'plugin']);

/** 所有能点的工具名（报错时用来提示「你是不是想写这个」）。 */
export function knownToolNames(extra = []) {
  return [...Object.keys(TOOL_PRESETS), ...SUB_DEFAULT_TOOLS, ...(Array.isArray(extra) ? extra : [])];
}

/**
 * 校验一份 tools 点名单，**不静默吞错**。
 *
 * 以前的写法是「一个都没匹配上就退回默认全量工具集」，后果很严重：
 * 调用方写 `tools:['recon']`（想派一个只读侦察兵）拼错一个字母，子代理就拿到了
 * write / shell 全套写权限，然后在工作区里真改文件 —— 派活的人以为它是只读的。
 * 所以这里把「拼错」和「被禁止」都当成错误报出来，由上层回一句人话让人改。
 *
 * @returns {{ok:boolean, tools:object[]|null, unknown:string[], forbidden:string[]}}
 *          tools 为 null 表示「没点名」，调用方自己用默认集。
 */
export function validateToolSpec(names, lookup, { extra = [] } = {}) {
  const getTool = typeof lookup === 'function' ? lookup : () => null;
  const named = expandToolNames(names);
  if (!named || !named.length) return { ok: true, tools: null, unknown: [], forbidden: [] };
  const unknown = [];
  const forbidden = [];
  const out = [];
  for (const raw of named) {
    const n = String(raw || '').trim().toLowerCase();
    if (!n) continue;
    if (FORBIDDEN.has(n)) {
      if (!forbidden.includes(n)) forbidden.push(n);
      continue;
    }
    const t = getTool(n);
    if (!t) {
      if (!unknown.includes(n)) unknown.push(n);
      continue;
    }
    if (FORBIDDEN.has(t.name)) continue;
    if (!out.some((x) => x.name === t.name)) out.push(t);
  }
  return { ok: !unknown.length && out.length > 0, tools: out, unknown, forbidden };
}

/** 把校验失败翻译成一句能照着改的话（子代理 / 团队工具共用一个说法）。 */
export function toolSpecError({ unknown = [], forbidden = [], extra = [] } = {}) {
  const lines = [];
  if (unknown.length) {
    const known = knownToolNames(extra);
    lines.push(`不认识的工具名：${unknown.join('、')}。`);
    // 拼错提示：找一个编辑距离最近的，比一次性列 30 个名字有用
    const near = (w) =>
      known
        .map((k) => ({ k, d: editDistance(w, k) }))
        .filter((x) => x.d <= 2)
        .sort((a, b) => a.d - b.d)[0]?.k;
    const hints = unknown.map((u) => near(u)).filter(Boolean);
    if (hints.length) lines.push(`你是不是想写：${[...new Set(hints)].join('、')}？`);
    lines.push(`可用的 preset：${Object.keys(TOOL_PRESETS).join(' / ')}（scout=只读侦察，readonly=只读+git，verify=只读+shell）；也可直接列工具名：${knownToolNames([]).filter((n) => !TOOL_PRESETS[n]).join(' / ')}`);
  }
  if (forbidden.length) {
    lines.push(`这些工具子代理永远拿不到：${forbidden.join('、')}（防递归 / 防改程序本体 / 防等界面回答）。`);
  }
  if (!unknown.length && !forbidden.length) lines.push('tools 里一个可用的工具都没匹配上。');
  return lines.join('\n');
}

/** 极小的 Levenshtein（只为拼错提示，工具名都很短，开销可忽略）。 */
function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const dp = Array.from({ length: s.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= t.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[s.length][t.length];
}

/**
 * 把工具名列表解析成工具对象。
 * lookup 由调用方传入（tools/index.js 的 getTool），避免这里静态依赖它。
 * 点名了却解析不出来时**抛错**，不再静默退回全量默认集（见 validateToolSpec 的说明）。
 */
export function resolveToolSet(names, lookup, { extra = [] } = {}) {
  const getTool = typeof lookup === 'function' ? lookup : () => null;
  const pluginExtra = Array.isArray(extra) ? extra : [];
  const { ok, tools, unknown, forbidden } = validateToolSpec(names, lookup, { extra: pluginExtra });
  // 没点名工具时：默认集 + 插件工具（archive / dnspy / draw 之类，成员也该能用）
  if (tools === null) return [...SUB_DEFAULT_TOOLS, ...pluginExtra].map((n) => getTool(n)).filter(Boolean);
  if (!ok) throw new Error(toolSpecError({ unknown, forbidden, extra: pluginExtra }));
  return tools;
}

/** 包一层只读配置视图：让子代理用另一个模型/步数，而不动全局 active。 */
export function scopedConfig(base, { provider, model, settings } = {}) {
  if (!provider && !model && !settings) return base;
  const cfg = Object.create(base);
  const pid = provider || base.active.provider;
  const mid = model || base.active.model;
  Object.defineProperty(cfg, 'active', {
    get: () => ({ provider: pid, model: mid }),
    configurable: true,
    enumerable: true,
  });
  if (settings) {
    Object.defineProperty(cfg, 'settings', {
      get: () => ({ ...base.settings, ...settings }),
      configurable: true,
      enumerable: true,
    });
  }
  return cfg;
}

import { ChangeWatch, buildReport, REPORT_SPEC } from './report.js';

/** 子代理的系统提示片段（角色 + 子代理纪律 + 简报 + 省 token 读法）。 */
export function rolePrompt({ role, task, team, readOnly = false, depends = [], lessons = '' }) {
  const head = String(role || '').trim() || '你是一个通用开发助手，负责把交给你的子任务做完。';
  const lines = [
    head,
    '',
    '你是一个**子代理**，不直接面对玩家：',
    '- 不要调用 ask（没有界面等着你回答）；不确定的地方自己选最合理的做法，并在最终答复里注明「我假设了…」。',
    '- 只做交给你的这件事：不要顺手重构无关代码，不要重写别人正在改的文件，不要跑 git 提交。',
    '- 改动完要真的验证（跑测试 / 跑一次最小复现命令 / 读回文件），别空口说成功。',
    '- 最终答复就是交给主代理的报告，请写清楚、可直接转述，不要客套。',
  ];
  if (team) lines.push('', `你现在属于团队「${team.name}」，团队整体目标：${team.goal}`);
  if (task) lines.push('', `你被分到的任务：${task}`);
  // 只读侦察模式：手上没写权限，就别让它浪费时间写「我本来想改…」
  if (readOnly) {
    lines.push(
      '',
      '# 你是「只读侦察」模式',
      '你只能读（read / grep / glob / ls / think），没有写权限、也不能跑命令。',
      '所以不要声称「已修改」什么 —— 你的产出只有**情报**：位置、调用链、根因、建议怎么改（改哪个文件哪一行）。',
    );
  }
  // 团队简报：主代理 + 前面的成员已经查清的事实。成员最烧钱的动作就是「从零把项目读一遍」，
  // 所以这段要明确写成「不用再查」的既有结论。
  const briefing = String(team?.briefing || '').trim();
  if (briefing) {
    lines.push(
      '',
      '# 团队简报（主代理与已完工成员查清的事实，直接当已知条件用，不要再 read 一遍去验证）',
      briefing,
    );
  }
  const board = Array.isArray(team?.board) ? team.board.filter(Boolean) : [];
  if (board.length) {
    lines.push('', '# 其他成员已经做完的部分（别重复做，也别重读他们动过的文件）', ...board.map((b) => `- ${b}`));
  }
  // 依赖成员的产出：这是「先定接口再实现」的关键 —— 接口已经在里面定好了，直接用
  const deps = Array.isArray(depends) ? depends.filter(Boolean) : [];
  if (deps.length) {
    lines.push(
      '',
      '# 你依赖的成员已经完工（他们的产出就是你的已知条件）',
      '不要重做他们那份，也不要推翻他们定好的接口；照他们的约定往下写。',
      '如果发现他们的做法确实有问题：按现有约定先把自己的活干完，在最终交代里写「建议改…，因为…」，让队长拍。',
    );
    for (const d of deps) {
      const extra = [d.facts ? `核实账：${d.facts}` : '', d.findings?.length ? `他查到：${d.findings.join('；')}` : ''].filter(Boolean).join('\n');
      lines.push('', `## ${d.name}（${d.role || ''}）已完成`, String(d.text || '（没留交代，读他的文件对齐接口）'), ...(extra ? [extra] : []));
    }
  }
  // 经验库：同类活以前踩过的坑（跨任务沉淀）
  const lessonText = String(lessons || '').trim();
  if (lessonText) {
    lines.push(
      '',
      '# 以前同类活踩过的坑（经验库召回，别重新踩一遍）',
      lessonText,
      '这些具体环境可能和现在不完全一样：先判断是否适用，适用的直接避开，不适用的忽略。',
    );
  }
  // 团队里才有意义：查到的事实可以广播给其他成员，省得大家都去查一遍
  if (team) {
    lines.push(
      '',
      '# 怎么把你的发现分享给队友',
      '当你查到一条**别人也会需要**的关键事实（某个函数的真实签名、真正的报错原因、某个文件的位置、某个接口约定），',
      '就在回复里单独起一行写成 `FINDING: 一句话事实`（不要超过三行，也不要写废话）。',
      '这一行会被立刻广播给其他队友和队长，他们就不用再去查一遍了。',
    );
  }
  lines.push(
    '',
    '# 省上下文的干法（你的上下文预算有限，读文件的成本很高）',
    '- 先 grep / glob 定位，再 read 指定行段（offset / limit）；不要 ls -R，也不要把整目录读进来。',
    '- 同一个文件只读一次，读到关键片段就记住；别为了「再确认一下」反复 read 同一处。',
    '- 简报和上面的已知事实不要再查证；要找符号实现就直接 grep，不要通读全文。',
    '- 连续两次同类调用（同样的 grep / read）没有新信息，就换思路或直接开始写代码。',
    '- 干完就开始动手实现，不要先写长篇调研报告；调研部分在最终交代里一两句话概括即可。',
    '',
    REPORT_SPEC,
  );
  return lines.join('\n');
}

/** 到点收尾用的提示：让它在最后一轮把活交代清楚（别又开新活儿）。 */
const WRAP_UP = `\n\n【时间到】已经用完分配给你的时间，请**立即**收尾：不要再开新任务、不要继续大改。
先把你到目前为止的进度**写进文件或直接交代**（已改了哪些文件、正在改到一半的是哪个、下一步要干什么），
不要因为时间到了就丢掉已经完成的思考。
然后用 3-8 行交代：做了什么、（按当前状态）改了哪些文件、验证了什么、哪部分还没做完/有风险。
写得能让队长直接转述，末尾**必须**附结构化报告（REPORT 块）。`;

/** 第二次软提醒：离硬中断只差最后一点时间，逼它此刻就把 REPORT 吐出来。 */
const WRAP_UP_HARD = `\n\n【最后提醒】马上就会强制中断你。现在就停下手上的改动，
把当前进度（改到哪、下一步是什么）和结构化 REPORT 写出来，这是最后一次机会。`;

/** 一轮失败后给它的「上一轮都干了些啥」简报（失败经验回灌）。 */
function failureBrief({ verifyOutput, verifyCmds, prevText, prevFiles }) {
  const files = Array.isArray(prevFiles) ? prevFiles.filter(Boolean) : [];
  const lines = [
    '【上一轮的结果：验收没通过】',
    `验收命令：${verifyCmds.join(' && ')}`,
    '',
    '失败输出（只取尾部，报错就在这几行里）：',
    tailLines(verifyOutput, 40) || '（没有输出）',
  ];
  if (files.length) {
    lines.push(
      '',
      `你上一轮改过这些文件（共 ${files.length} 个）：${files.slice(0, 20).join('、')}${files.length > 20 ? ' …' : ''}`,
      '先看你已经改成什么样（read 相关行段），**不要从头重写**，也不要推翻自己上一轮的思路；',
      '只修真正导致失败的那几处。如果失败根因不在你改过的文件里，直说。',
    );
  }
  if (prevText) lines.push('', '你上一轮的说法（供对照，别重复同样的判断）：', tailLines(prevText, 20));
  return lines.join('\n');
}

/**
 * 跑一个子代理，阻塞到它结束。
 * @param {object} o
 * @param {object} o.config 主配置（提供 provider / key / settings）
 * @param {string} o.cwd 工作目录（和主代理共享工作区）
 * @param {string} o.task 任务描述（必须自包含）
 * @param {string} [o.role] 角色/职责描述
 * @param {string[]} [o.tools] 可用工具名（默认 SUB_DEFAULT_TOOLS）
 * @param {string} [o.model] 换一个模型跑（例如让子代理用便宜的 flash）
 * @param {string} [o.provider] 换一个服务商
 * @param {number} [o.maxSteps] 步数上限
 * @param {number} [o.timeoutSec] 时间上限（秒）：到点先让它收尾交代，宽限一段再硬断
 * @param {AbortSignal} [o.signal] 玩家按 ESC 时一起中断
 * @param {(ev:object)=>void} [o.onEvent] 进度回调（收到的是 Agent 原生事件）
 * @param {(fact:string)=>void} [o.onFinding] 它写出了 FINDING: 行时回调（团队共享情报用）
 * @param {object} [o.team] {name, goal} 团队信息（会写进角色提示）
 * @param {Array} [o.depends] 依赖成员的产出（团队用，会写进角色提示）
 * @param {string} [o.lessons] 经验库召回的坑（会写进角色提示）
 * @param {object} [o.checkpoints] 共享检查点（/undo 能回滚子代理的改动）
 * @param {string|string[]} [o.verify] 验收命令：它自己干完后由我们亲手跑，失败就给它一轮修正
 * @param {boolean} [o.report] 是否采集结构化回报（默认开）
 * @returns {Promise<{text:string, usage:object, steps:number, aborted:boolean, timedOut:boolean,
 *   wrappedUp:boolean, report:object|null, verify:object|null}>}
 */
export async function runSubagent({
  config,
  cwd,
  task,
  role = '',
  tools = null,
  model = '',
  provider = '',
  maxSteps = 40,
  timeoutSec = 600,
  signal = null,
  onEvent = null,
  onAgent = null,
  onFinding = null,
  team = null,
  briefing = '',
  board = null,
  depends = [],
  lessons = '',
  writeScope = null,
  verify = null,
  report = true,
  checkpoints = null,
  depth = 1,
} = {}) {
  const { Agent } = await import('./agent.js');
  const toolsMod = await import('./tools/index.js');
  const extraTools = (() => {
    try {
      return toolsMod.pluginTools().map((p) => p.name);
    } catch {
      return [];
    }
  })();
  const toolSet = resolveToolSet(tools, toolsMod.getTool, { extra: extraTools });
  // 手上没有任何写权限 = 只读侦察模式（自动识别，不用调用方再传一个开关）
  const readOnly = !toolSet.some((t) => !t.readOnly && t.name !== 'think');
  const cfg = scopedConfig(config, {
    provider,
    model,
    settings: { maxSteps: Math.max(1, Number(maxSteps) || 40), subagents: false, team: false },
  });

  const agent = new Agent({
    config: cfg,
    cwd,
    role: rolePrompt({ role, task, team: team ? { ...team, briefing, board } : null, readOnly, depends, lessons }),
    tools: toolSet,
    depth,
    writeScope,
  });
  if (checkpoints) agent.checkpoints = checkpoints;
  // 事实采集：从事件流里真数出「改了哪几个文件、跑了哪些命令」
  const watch = report ? new ChangeWatch(cwd) : null;
  try {
    onAgent?.(agent);
  } catch {
    /* 回调出错不影响干活 */
  }

  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onOuterAbort);
  let timedOut = false;
  let wrappedUp = false;
  const ms = Math.max(10, Number(timeoutSec) || 600) * 1000;
  // 到点不硬砍：先递一句「收尾交代」，给一小段宽限，真不行再断
  // （子代理/团队成员往往正在写大文件，一刀切下去等于白干十分钟）
  const graceMs = Math.max(15000, Math.min(180000, Math.round(ms * 0.15)));
  let hardTimer = null;
  let probeTimer = null;
  const softTimer = setTimeout(() => {
    timedOut = true;
    // 第一阶：让它把当前进度写成 REPORT（已完成的思考不能因为超时全丢掉）
    try {
      agent.queue(WRAP_UP);
    } catch {
      /* 会话已结束就随它去 */
    }
    // 第二阶：宽限期过半再催一次，逼它当场交报告
    probeTimer = setTimeout(() => {
      try {
        agent.queue(WRAP_UP_HARD);
        onEvent?.({ type: 'note', text: '到最后宽限了，已要求它立即交出进度报告' });
      } catch {}
    }, Math.round(graceMs * 0.55));
    if (probeTimer.unref) probeTimer.unref();
    // 第三阶：硬断
    hardTimer = setTimeout(() => {
      try {
        ctrl.abort();
      } catch {}
    }, graceMs);
    if (hardTimer.unref) hardTimer.unref();
  }, ms);
  if (softTimer.unref) softTimer.unref();

  let text = '';
  let steps = 0;
  let aborted = false;
  /** 已广播过的发现（防止同一行反复上报） */
  const seenFindings = new Set();
  /** 扫描一段流式文本里的 FINDING: 行，逐条回调 */
  const scanFindings = (chunk) => {
    if (!onFinding) return;
    for (const line of String(chunk || '').split('\n')) {
      const m = /^\s*FINDING\s*[:：]\s*(.+)$/i.exec(line);
      if (!m) continue;
      const fact = m[1].trim();
      if (!fact || seenFindings.has(fact)) continue;
      seenFindings.add(fact);
      try {
        onFinding(fact);
      } catch {}
    }
  };
  // 把一段 Agent 事件流跑完（修正轮再跑一遍时复用）
  /** 步数预警只在快用完时提醒一次（重复注入会把它的注意力搅乱）。 */
  let stepWarned = false;
  const stepBudget = Math.max(1, Number(maxSteps) || 40);
  const drain = async (prompt) => {
    for await (const ev of agent.run(prompt, { signal: ctrl.signal })) {
      if (ev.type === 'text') {
        text += ev.delta;
      }
      if (ev.type === 'step') {
        steps = ev.step;
        // 步数预警：快用完（还剩 20% 且至少只剩 3 步）就提醒它开始收尾，
        // 否则它会在最后一步还在开新活，然后被硬断，前面的整理全白费。
        const left = stepBudget - steps;
        if (!stepWarned && left <= Math.max(3, Math.round(stepBudget * 0.2))) {
          stepWarned = true;
          try {
            agent.queue(
              `【步数提醒】你还剩约 ${Math.max(1, left)} 步（总共 ${stepBudget} 步）。\n` +
                '接下来请**收尾**：不要再开新任务、不要把整个文件重读一遍；\n' +
                '优先把已经改了一半的东西保证完整、能跑，然后写出最终交代和 REPORT 块。',
            );
            onEvent?.({ type: 'note', text: `步数还剩约 ${Math.max(1, left)} 步，已提醒它收尾` });
          } catch {
            /* 会话已结束就随它去 */
          }
        }
      }
      if (ev.type === 'aborted') aborted = true;
      if (ev.type === 'done') wrappedUp = true;
      try {
        watch?.feed(ev);
        onEvent?.(ev);
      } catch {
        /* 进度回调 / 采集出错不能影响干活 */
      }
      // FINDING 行是流式的：按块解，不完整的行留到下一块再拼
      if (onFinding && ev.type === 'text') {
        const acc = String(text || '');
        const cut = acc.lastIndexOf('\n');
        if (cut > 0) scanFindings(acc.slice(0, cut));
      }
    }
    // 收尾时把最后没换行的那条也扫一遍
    if (onFinding) scanFindings(text);
  };

  let verifyRes = null;
  /** 每轮结束时勾出「这一轮它改了哪些文件 / 说了什么」，失败回灌时要用 */
  let roundFiles = [];
  let roundText = '';
  /** 验收修正轮用了几次（只修一轮，避免在同一个坑里无限打转） */
  let fixRounds = 0;
  try {
    text = '';
    await drain(`请完成这个任务：\n${task}`);
    roundText = text;
    roundFiles = (watch?.read()?.files || []).map((f) => f.path);
    // 验收：由我们亲手跑命令，不信它的口头「测过了」。失败就给它一轮修正。
    const vcmds = (Array.isArray(verify) ? verify : verify ? [verify] : [])
      .map((c) => String(c || '').trim())
      .filter(Boolean);
    if (vcmds.length && !aborted) {
      verifyRes = await runVerify(agent, vcmds, ctrl.signal);
      try {
        onEvent?.({ type: 'note', text: `验收命令${verifyRes.ok ? '通过' : '失败'}：${vcmds.join(' && ')}` });
      } catch {}
      if (!verifyRes.ok && !ctrl.signal.aborted) {
        // 同一个上下文再跑一轮：它刚刚做了什么、报错长什么样，自己最清楚。
        // 关键：不能只丢给它一句报错 —— 要把「上一轮改了哪些文件」一起告诉它，
        // 否则它以为自己是刚接手，会重读一堆文件、甚至推翻自己上一轮的改动重写一遍。
        const before = text;
        text = '';
        wrappedUp = false;
        fixRounds++;
        try {
          onEvent?.({ type: 'note', text: `验收失败，带上上一轮 ${roundFiles.length} 个改动文件让它修第 ${fixRounds} 轮` });
        } catch {}
        await drain(
          `${failureBrief({ verifyOutput: verifyRes.output, verifyCmds: vcmds, prevText: before, prevFiles: roundFiles })}\n\n` +
            '请根据这份报错**修正你的实现**（不要改验收命令，也不要为了让测试通过而删测试），改完重新交代一次。',
        );
        verifyRes = await runVerify(agent, vcmds, ctrl.signal);
      }
    }
  } finally {
    clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (probeTimer) clearTimeout(probeTimer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }

  const facts = watch ? watch.read({ verifyOutput: verifyRes?.output || '' }) : null;
  // 亲手跑过的验收命令以实测为准（覆盖模型自己可能吹牛的那部分）
  if (facts && verifyRes) {
    facts.verified = verifyRes.ok;
    facts.verifyCommand = verifyRes.command;
    facts.tests = { ...facts.tests, manual: true, ok: verifyRes.ok };
  }
  const built = report ? buildReport({ watch: facts, text: text.trim() }) : null;
  // 经验入库：单发的子代理（不在团队里）也要记教训，否则同一个坑每次重新踩。
  // 团队那边由 Team._learn 统一记（它会带上成员归属），这里只管没团队的。
  if (built && !team) {
    try {
      const { addLesson } = await import('./lessons.js');
      const tags = [role, ...(built.files || []).slice(0, 6).map((f) => f.path)];
      if (built.verified === false) {
        addLesson(cwd, {
          task,
          kind: 'verify-fail',
          // 失败输出的尾巴就是真正的报错（前头多半是滚屏日志）
          text: `${built.verifyNote || '验收失败'}：${tailLines(verifyRes?.output, 4)}`,
          tags,
        });
      }
      for (const b of built.blocked || []) addLesson(cwd, { task, kind: 'blocked', text: b, tags });
    } catch {
      /* 记不下就算了，不能因为经验库把干活搞崩 */
    }
  }
  return {
    text: text.trim(),
    usage: { ...agent.usageTotal },
    steps: steps || agent.usageTotal.steps || 0,
    // 到点但自己收住、把交代写完的，算「干完了」（只是超时收尾），不算中断
    aborted: aborted || (timedOut && !wrappedUp),
    timedOut,
    wrappedUp,
    // 验收修正轮跑了几次（0 = 一次就过或没给验收命令）
    fixRounds,
    model: `${cfg.active.provider}/${cfg.active.model}`,
    report: built,
    verify: verifyRes ? { ok: verifyRes.ok, command: verifyRes.command, code: verifyRes.code } : null,
  };
}

/** 取输出的尾巴（报错信息几乎总在末尾，前面可能是滚屏日志）。 */
function tailLines(s, n = 40) {
  const lines = String(s || '').split('\n');
  return lines.slice(-n).join('\n').trim();
}

/** 亲自跑验收命令（走子代理自己的 shell 工具选路，但不进它的上下文）。 */
export async function runVerify(agent, commands, signal) {
  const shellPath = agent.config?.settings?.shellPath;
  const command = commands.join(' && ');
  const timeout = Math.max(30000, Number(agent.config?.settings?.verifyTimeout) || 300000);
  const { shellTool } = await import('./tools/shell.js');
  let out;
  try {
    const r = await shellTool.execute({ command, timeout }, { cwd: agent.cwd, signal, depth: 99, shellPath });
    out = r;
  } catch (e) {
    return { ok: false, code: -1, command, output: `验收命令没跑起来：${e?.message || e}` };
  }
  const code = out?.meta?.code ?? (out?.isError ? 1 : 0);
  return { ok: !out?.isError && code === 0, code, command, output: String(out?.content || '') };
}
