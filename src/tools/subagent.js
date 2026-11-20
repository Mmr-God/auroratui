// subagent 工具：主 agent 派生一个「独立上下文的助手」去啃一块子任务。
//
// 触发条件很关键 —— 这个工具会额外烧 token，所以：
//   1) 默认不下发给模型（config.settings.subagents=false，见 tools/index.js 的 GATED_TOOLS）；
//   2) 即便模型硬调，这里也会再拦一次；
//   3) 子代理内部一律关掉 subagent/team，防止无限套娃（深度上限见 settings.subagentDepth）。
import { runSubagent, validateToolSpec, toolSpecError } from '../subagent.js';
import { renderReport } from '../report.js';
import { Transcript } from '../transcript.js';

// 注意：不要在这里的顶层直接读写 ../subagent.js 导出的值（SUB_DEFAULT_TOOLS 等），
// 因为 tools/index.js ↔ src/subagent.js 是循环引用，顶层取值会撞上 TDZ
// （单独 import ../team.js 时尤其明显）。这些名字一律写死在描述里。
const DEFAULT_TOOL_LIST =
  'read / write / edit / patch / shell / jobs / diagnostics / glob / grep / ls / think / todo / memory / skill / web_search / web_fetch / http_request / git';

const solo = []; // 最近几个子代理的进度（最新在最前，只留 8 条）
const soloTr = new Map(); // id → 对话记录（出错时能回放他走了哪几步）

function trOf(id) {
  let tr = soloTr.get(id);
  if (!tr) {
    tr = new Transcript();
    soloTr.set(id, tr);
  }
  return tr;
}

function pushSolo(entry) {
  const i = solo.findIndex((x) => x.id === entry.id);
  if (i >= 0) solo[i] = { ...solo[i], ...entry };
  else solo.unshift(entry);
  if (solo.length > 8) {
    for (const gone of solo.slice(8)) soloTr.delete(gone.id);
    solo.length = 8;
  }
  return solo;
}

function hintOf(input) {
  const p = input?.path || input?.url || input?.pattern || input?.query || input?.command || '';
  return p ? String(p) : '';
}

export const subagentTool = {
  name: 'subagent',
  readOnly: false,
  description:
    '派一个「子代理」去独立完成一块子任务：它在自己的上下文里读文件、改代码、跑命令，干完只把结论带回来，主对话不会被它读的一大堆文件撑爆。适合：边界清晰、能独立完成、预计要读很多文件/反复试错的活（查报错根因、补测试、按接口改造某个模块、把某个目录迁移到新写法）。不适合：需要玩家边聊边确认的事、几行就能改完的小活、以及需要你亲自看全貌的架构决策。任务描述必须自包含：目标 + 相关路径 + 约束 + 验收标准。调用会阻塞到子代理完成（通常几十秒到几分钟）。玩家需要先 /subagents on 开启本功能。',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '交给子代理的自包含任务描述：要做什么、哪些文件/目录、不许动什么、怎么算做完（验收标准）。',
      },
      role: { type: 'string', description: '子代理的角色/专长，例如「测试工程师」「后端重构者」。会影响它的取舍。' },
      name: { type: 'string', description: '给它起个短名字（进度里显示），例如「测试-1」。' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: `限定它能用的工具。可以写 preset 名（省得手敲）："scout" = 只读侦察（read/grep/glob/ls/think，碰不到写，适合「这东西在哪、怎么调用的」）、"readonly" = scout + git、"verify" = 只读 + shell（只能跑命令验证，不能改文件）。也可直接列工具名：${DEFAULT_TOOL_LIST}`,
      },
      model: {
        type: 'string',
        description: '给子代理换一个模型（格式 model-id）。机械活（补测试、改格式、批量替换）走便宜快的模型能省一大笔；需要判断力的活再用跟你一样的模型。',
      },
      max_steps: { type: 'integer', description: '步数上限，默认 40。简单活可给 15，复杂重构给 60。' },
      verify: {
        type: 'array',
        items: { type: 'string' },
        description:
          '验收命令（强烈建议填）：它干完后我会**亲自跑一遍**，失败就自动给它一轮修正。例：["npm test"]、["npm run build", "npm test"]。不填就只能信它自己的口头验收。',
      },
    },
    required: ['task'],
  },

  async execute(input, ctx) {
    const cfg = ctx?.config;
    if (!cfg?.subagentsEnabled) {
      return {
        isError: true,
        content:
          'subagent 功能未开启（会额外消耗 token）。请让玩家在终端里执行 `/subagents on`（或改 config.json 的 settings.subagents=true）后再用。你也可以自己把这件事做掉。',
      };
    }
    const depth = Number(ctx?.depth || 0);
    const maxDepth = Number(cfg.settings?.subagentDepth ?? 1);
    if (depth >= maxDepth) {
      return {
        isError: true,
        content: `嵌套层数已达上限（settings.subagentDepth=${maxDepth}）：子代理不能再派子代理。这件事请你自己做。`,
      };
    }
    const task = String(input?.task || '').trim();
    if (!task) return { isError: true, content: 'task 不能为空：请写清目标、相关路径、约束、验收标准。' };

    // 工具点名单先校验：拼错 / 点了禁用工具就当场报错，
    // 别等到子代理起来才发现它拿的是全量工具（那样你以为它是只读的，它已经在改文件了）。
    const rawTools = Array.isArray(input.tools) ? input.tools : input.tools ? [input.tools] : null;
    if (rawTools) {
      // 循环引用：tools/index.js ↔ 本模块，所以动态 import（和 src/subagent.js 一样）
      let lookup = () => null;
      try {
        const mod = await import('./index.js');
        lookup = mod.getTool;
      } catch {}
      const { ok, unknown, forbidden } = validateToolSpec(rawTools, lookup, {});
      if (!ok) {
        return { isError: true, content: `tools 参数有问题，没有派出子代理：\n${toolSpecError({ unknown, forbidden })}` };
      }
    }

    const name = String(input.name || '子代理').trim() || '子代理';
    const role = String(input.role || '').trim();
    const maxSteps = Math.max(1, Number(input.max_steps) || Number(cfg.settings?.subagentMaxSteps) || 40);
    const timeoutSec = Number(cfg.settings?.subagentTimeout) || 600;
    const id = `s${Date.now().toString(36)}`;
    const startedAt = Date.now();

    // TUI 进度 + 对话记录（出错时能回放）
    const tr = trOf(id);
    tr.task(task + (role ? `\n\n角色：${role}` : ''));
    pushSolo({ id, name, role: role || '子代理', task, status: 'running', steps: 0, toolCalls: 0, tokens: {}, cost: 0, startedAt, last: '' });
    ctx?.emit?.({ kind: 'note', text: `子代理「${name}」开工` });

    let toolCalls = 0;
    let last = '';
    let compactions = 0;
    const t0 = Date.now();
    let res;
    try {
      res = await runSubagent({
        config: cfg,
        cwd: ctx?.cwd || process.cwd(),
        task,
        role,
        // preset 名（scout / readonly / verify）在 resolveToolSet 里展开；这里原样透传
        tools: rawTools,
        // 没点名模型时：机械活走 settings.subagentModel（配了就省一大笔）
        model: String(input.model || cfg.settings?.subagentModel || ''),
        verify: Array.isArray(input.verify) ? input.verify : input.verify ? [input.verify] : null,
        maxSteps,
        timeoutSec,
        signal: ctx?.signal || null,
        checkpoints: ctx?.checkpoints || null,
        depth: depth + 1,
        onEvent: (ev) => {
          tr.feed(ev);
          if (ev.type === 'tool_start') {
            toolCalls++;
            last = `${ev.name} ${hintOf(ev.input)}`.trim();
          } else if (ev.type === 'step') {
            pushSolo({ id, steps: ev.step, toolCalls, last, status: 'running' });
          } else if (ev.type === 'compact_end') {
            compactions++;
          } else if (ev.type === 'usage') {
            const u = ev.total || {};
            pushSolo({
              id,
              steps: u.steps || 0,
              toolCalls,
              last,
              status: 'running',
              tokens: { input: u.input || 0, output: u.output || 0 },
              cost: u.cost || 0,
            });
          }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tr.error(`跑挂了：${msg}`);
      pushSolo({ id, status: 'error', endedAt: Date.now(), last: msg.slice(0, 120) });
      return {
        isError: true,
        content: `子代理「${name}」跑挂了（${Math.round((Date.now() - t0) / 1000)}s，${toolCalls} 次工具）：${msg}\n建议：把任务拆小一点，或用更明确的验收标准再派一次。`,
        meta: { subagent: { name, role, steps: 0, toolCalls, status: 'error' }, summary: `${name} · 出错` },
      };
    }

    const status = res.timedOut ? 'stopped' : res.aborted ? 'stopped' : 'done';
    const tokens = res.usage || {};
    const rep = res.report || null;
    if (res.text) tr.result(res.text);
    else tr.note('（它没有给出最终答复，可能被中断或步数耗尽）');
    pushSolo({
      id,
      status,
      steps: res.steps,
      toolCalls,
      compactions,
      tokens: { input: tokens.input || 0, output: tokens.output || 0 },
      cost: tokens.cost || 0,
      endedAt: Date.now(),
      last,
      output: res.text,
    });

    const secs = Math.round((Date.now() - t0) / 1000);
    const verifyTag = res.verify ? (res.verify.ok ? ' · 验收✓' : ' · 验收✗') : '';
    const head = `子代理「${name}」${status === 'done' ? '完成' : res.timedOut ? `超时中断（${timeoutSec}s）` : '被中断'}：${res.steps} 步 · ${toolCalls} 次工具 · ${((tokens.input || 0) + (tokens.output || 0)).toLocaleString()} tok · $${(tokens.cost || 0).toFixed(4)} · ${secs}s · 模型 ${res.model}${verifyTag}`;
    const body = res.text ? res.text : '（它没有给出最终答复，可能被中断或步数耗尽）';
    // 核实账放最后：先给人话，再给硬数据（改了哪些文件、验收到底跑没跑过）
    const audit = rep ? renderReport(rep) : '';

    return {
      content: `${head}\n\n${body}${audit ? `\n\n${audit}` : ''}`,
      meta: {
        subagent: { name, role, steps: res.steps, toolCalls, tokens, cost: tokens.cost || 0, status, secs, model: res.model },
        report: rep,
        summary: `${name} · ${res.steps} 步 · ${status === 'done' ? '完成' : '中断'}${verifyTag}`,
      },
    };
  },
};
