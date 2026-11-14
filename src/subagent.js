// 子代理（subagent）：主 agent 派生一个**独立上下文**的助手去啃一块子任务，
// 干完只把结论带回来 —— 主对话不会被它读的一堆文件撑爆。
//
// 实现上不重写一套循环：直接复用 Agent（流式 / 重试 / 自动压缩 / 检查点全都有），
// 只是换角色提示、限制工具集、限制步数与超时，并把事件转发出去（TUI + 浏览器面板）。
//
// 注意：本模块被 src/tools/subagent.js 引用，而 tools/index.js 又引用它（循环引用）。
// 所以对 Agent / getTool 的引用一律放在函数体里（静态导入会撞上 TDZ：
// 单独 import tools/team.js 时 tools/index.js 还没初始化完）。

// 子代理默认可用的工具：能读能写能跑命令，但**不能**再派生代理（防递归）、
// 不能向玩家提问（没有界面）、不能造插件（影响面太大）。
export const SUB_DEFAULT_TOOLS = [
  'read', 'write', 'edit', 'shell',
  'glob', 'grep', 'ls', 'think',
  'todo', 'memory', 'skill',
  'web_search', 'web_fetch', 'browser', 'http_request', 'git',
];

// 子代理永远拿不到的工具（就算玩家/模型在 tools 里点名）
const FORBIDDEN = new Set(['ask', 'subagent', 'team', 'plugin', 'context']);

/**
 * 把工具名列表解析成工具对象；非法/被禁止的名字会被丢掉。
 * lookup 由调用方传入（tools/index.js 的 getTool），避免这里静态依赖它。
 */
export function resolveToolSet(names, lookup) {
  const getTool = typeof lookup === 'function' ? lookup : () => null;
  const want = (Array.isArray(names) && names.length ? names : SUB_DEFAULT_TOOLS)
    .map((n) => String(n || '').trim().toLowerCase())
    .filter((n) => n && !FORBIDDEN.has(n));
  const out = [];
  for (const n of want) {
    const t = getTool(n);
    if (t && !FORBIDDEN.has(t.name) && !out.some((x) => x.name === t.name)) out.push(t);
  }
  return out.length ? out : SUB_DEFAULT_TOOLS.map((n) => getTool(n)).filter(Boolean);
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

/** 子代理的系统提示片段（角色 + 子代理纪律）。 */
export function rolePrompt({ role, task, team }) {
  const head = String(role || '').trim() || '你是一个通用开发助手，负责把交给你的子任务做完。';
  const lines = [
    head,
    '',
    '你是一个**子代理**，不直接面对玩家：',
    '- 不要调用 ask（没有界面等着你回答）；不确定的地方自己选最合理的做法，并在最终答复里注明「我假设了…」。',
    '- 只做交给你的这件事：不要顺手重构无关代码，不要重写别人正在改的文件，不要跑 git 提交。',
    '- 改动完要真的验证（跑测试 / 跑一次最小复现命令 / 读回文件），别空口说成功。',
    '- 最后用 3-8 行交代：做了什么、改了哪些文件（`path:line`）、验证了什么、没做完的与风险。',
    '- 最终答复就是交给主代理的报告，请写清楚、可直接转述，不要客套。',
  ];
  if (team) lines.push('', `你现在属于团队「${team.name}」，团队整体目标：${team.goal}`);
  if (task) lines.push('', `你被分到的任务：${task}`);
  return lines.join('\n');
}

/** 到点收尾用的提示：让它在最后一轮把活交代清楚（别又开新活儿）。 */
const WRAP_UP = `\n\n【时间到】已经用完分配给你的时间，请**立即**收尾：不要再开新任务、不要继续大改。
用 3-8 行交代：做了什么、（按当前状态）改了哪些文件、验证了什么、哪部分还没做完/有风险。
写得能让队长直接转述。`;

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
 * @param {object} [o.team] {name, goal} 团队信息（会写进角色提示）
 * @param {object} [o.checkpoints] 共享检查点（/undo 能回滚子代理的改动）
 * @returns {Promise<{text:string, usage:object, steps:number, aborted:boolean, timedOut:boolean, wrappedUp:boolean}>}
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
  team = null,
  checkpoints = null,
  depth = 1,
} = {}) {
  const { Agent } = await import('./agent.js');
  const { getTool } = await import('./tools/index.js');
  const toolSet = resolveToolSet(tools, getTool);
  const cfg = scopedConfig(config, {
    provider,
    model,
    settings: { maxSteps: Math.max(1, Number(maxSteps) || 40), subagents: false, team: false },
  });

  const agent = new Agent({
    config: cfg,
    cwd,
    role: rolePrompt({ role, task, team }),
    tools: toolSet,
    depth,
  });
  if (checkpoints) agent.checkpoints = checkpoints;
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
  const softTimer = setTimeout(() => {
    timedOut = true;
    try {
      agent.queue(WRAP_UP);
    } catch {
      /* 会话已结束就随它去 */
    }
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
  try {
    for await (const ev of agent.run(`请完成这个任务：\n${task}`, { signal: ctrl.signal })) {
      if (ev.type === 'text') text += ev.delta;
      if (ev.type === 'step') steps = ev.step;
      if (ev.type === 'aborted') aborted = true;
      if (ev.type === 'done') wrappedUp = true;
      try {
        onEvent?.(ev);
      } catch {
        /* 进度回调出错不能影响干活 */
      }
    }
  } finally {
    clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }

  return {
    text: text.trim(),
    usage: { ...agent.usageTotal },
    steps: steps || agent.usageTotal.steps || 0,
    // 到点但自己收住、把交代写完的，算「干完了」（只是超时收尾），不算中断
    aborted: aborted || (timedOut && !wrappedUp),
    timedOut,
    wrappedUp,
    model: `${cfg.active.provider}/${cfg.active.model}`,
  };
}
