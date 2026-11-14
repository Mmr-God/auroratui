// subagent 工具：主 agent 派生一个「独立上下文的助手」去啃一块子任务。
//
// 触发条件很关键 —— 这个工具会额外烧 token，所以：
//   1) 默认不下发给模型（config.settings.subagents=false，见 tools/index.js 的 GATED_TOOLS）；
//   2) 即便模型硬调，这里也会再拦一次；
//   3) 子代理内部一律关掉 subagent/team，防止无限套娃（深度上限见 settings.subagentDepth）。
import { runSubagent } from '../subagent.js';
import { ensureHub, Transcript } from '../progress.js';

// 注意：不要在这里的顶层直接读写 ../subagent.js 导出的值（SUB_DEFAULT_TOOLS 等），
// 因为 tools/index.js ↔ src/subagent.js 是循环引用，顶层取值会撞上 TDZ
// （单独 import ../team.js 时尤其明显）。这些名字一律写死在描述里。
const DEFAULT_TOOL_LIST =
  'read / write / edit / shell / glob / grep / ls / think / todo / memory / skill / web_search / web_fetch / browser / http_request / git';

const solo = []; // 最近几个子代理的进度（推给面板用）
const soloTr = new Map(); // id → 对话记录（面板上点开就能看全过程）

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
      name: { type: 'string', description: '给它起个短名字（面板上显示），例如「测试-1」。' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: `限定它能用的工具（默认全部开发工具）。常用裁剪：只读调查用 ["read","grep","glob","ls"]；只跑测试可加 "shell"。可用：${DEFAULT_TOOL_LIST}`,
      },
      model: { type: 'string', description: '给子代理换一个模型（例如便宜快的模型做机械活），格式 model-id。' },
      max_steps: { type: 'integer', description: '步数上限，默认 40。简单活可给 15，复杂重构给 60。' },
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

    const name = String(input.name || '子代理').trim() || '子代理';
    const role = String(input.role || '').trim();
    const maxSteps = Math.max(1, Number(input.max_steps) || Number(cfg.settings?.subagentMaxSteps) || 40);
    const timeoutSec = Number(cfg.settings?.subagentTimeout) || 600;
    const id = `s${Date.now().toString(36)}`;
    const startedAt = Date.now();

    // 面板 + TUI 进度
    const tr = trOf(id);
    tr.task(task + (role ? `\n\n角色：${role}` : ''));
    const hub = await ensureHub(cfg);
    if (hub) {
      hub.log({ kind: 'start', who: name, text: `开工：${task.slice(0, 100)}` });
      hub.update({
        title: 'AuroraTui · 子代理',
        team: null,
        solo: pushSolo({ id, name, role: role || '子代理', task, status: 'running', steps: 0, toolCalls: 0, tokens: {}, cost: 0, startedAt, last: '', events: tr.entries() }),
      });
    }
    const board = hub ? ` · 团队面板 ${hub.url}` : '';
    ctx?.emit?.({ kind: 'note', text: `子代理「${name}」开工${board}` });

    let toolCalls = 0;
    let last = '';
    const t0 = Date.now();
    let res;
    try {
      res = await runSubagent({
        config: cfg,
        cwd: ctx?.cwd || process.cwd(),
        task,
        role,
        tools: Array.isArray(input.tools) ? input.tools : null,
        model: String(input.model || ''),
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
            if (hub) {
              hub.update({ solo: pushSolo({ id, toolCalls, last, status: 'running', events: tr.entries() }) });
              hub.log({ kind: 'tool', who: name, text: last });
            }
          } else if (ev.type === 'step' && hub) {
            hub.update({ solo: pushSolo({ id, steps: ev.step, toolCalls, last, status: 'running', events: tr.entries() }) });
          } else if (ev.type === 'usage' && hub) {
            const u = ev.total || {};
            hub.update({
              solo: pushSolo({
                id,
                steps: u.steps || 0,
                tokens: { input: u.input || 0, output: u.output || 0 },
                cost: u.cost || 0,
                events: tr.entries(),
              }),
            });
          } else if (hub && (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool_end')) {
            // 文字流/结果也推走，面板上才能实时长出来
            hub.update({ solo: pushSolo({ id, events: tr.entries() }) });
          }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tr.error(`跑挂了：${msg}`);
      if (hub) {
        hub.update({ solo: pushSolo({ id, status: 'error', endedAt: Date.now(), last: msg.slice(0, 120), events: tr.entries() }) });
        hub.log({ kind: 'error', who: name, text: `跑挂了：${msg}` });
      }
      return {
        isError: true,
        content: `子代理「${name}」跑挂了（${Math.round((Date.now() - t0) / 1000)}s，${toolCalls} 次工具）：${msg}\n建议：把任务拆小一点，或用更明确的验收标准再派一次。`,
        meta: { subagent: { name, role, steps: 0, toolCalls, status: 'error' }, summary: `${name} · 出错` },
      };
    }

    const status = res.timedOut ? 'stopped' : res.aborted ? 'stopped' : 'done';
    const tokens = res.usage || {};
    if (res.text) tr.result(res.text);
    else tr.note('（它没有给出最终答复，可能被中断或步数耗尽）');
    if (hub) {
      hub.update({
        solo: pushSolo({
          id,
          status,
          steps: res.steps,
          toolCalls,
          tokens: { input: tokens.input || 0, output: tokens.output || 0 },
          cost: tokens.cost || 0,
          endedAt: Date.now(),
          last,
          output: res.text,
          events: tr.entries(),
        }),
      });
      hub.log({
        kind: status === 'done' ? 'done' : 'note',
        who: name,
        text: `${status === 'done' ? '完成' : '已中断'} · ${res.steps} 步 · ${toolCalls} 次工具 · ${(tokens.input || 0) + (tokens.output || 0)} tok`,
      });
    }

    const secs = Math.round((Date.now() - t0) / 1000);
    const head = `子代理「${name}」${status === 'done' ? '完成' : res.timedOut ? `超时中断（${timeoutSec}s）` : '被中断'}：${res.steps} 步 · ${toolCalls} 次工具 · ${((tokens.input || 0) + (tokens.output || 0)).toLocaleString()} tok · $${(tokens.cost || 0).toFixed(4)} · ${secs}s · 模型 ${res.model}`;
    const body = res.text ? res.text : '（它没有给出最终答复，可能被中断或步数耗尽）';

    return {
      content: `${head}\n\n${body}`,
      meta: {
        subagent: { name, role, steps: res.steps, toolCalls, tokens, cost: tokens.cost || 0, status, secs, model: res.model },
        summary: `${name} · ${res.steps} 步 · ${status === 'done' ? '完成' : '中断'}`,
      },
    };
  },
};
