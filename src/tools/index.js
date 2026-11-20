import { readTool, writeTool, editTool } from './fs.js';
import { patchTool } from './patch.js';
import { shellTool } from './shell.js';
import { jobsTool } from './jobs.js';
import { diagnosticsTool } from './diagnostics.js';
import { webSearchTool, webFetchTool } from './web.js';
import { contextTool } from './context.js';
import { globTool, grepTool, lsTool, thinkTool } from './search.js';
import { askTool } from './ask.js';
import { todoTool, memoryTool } from './todo.js';
import { gitTool, httpTool } from './git.js';
import { skillTool } from './skill.js';
import { pluginTool, pluginTools } from './plugin.js';
import { subagentTool } from './subagent.js';
import { teamTool } from './team.js';
import { runPreHooks, runPostHooks } from './hooks.js';

export const allTools = [
  readTool, writeTool, editTool, patchTool,
  shellTool, jobsTool, diagnosticsTool,
  globTool, grepTool, lsTool, thinkTool, askTool,
  webSearchTool, webFetchTool, httpTool,
  gitTool, todoTool, memoryTool, skillTool,
  contextTool, pluginTool, subagentTool, teamTool,
];

export const toolMap = new Map(allTools.map((t) => [t.name, t]));

// 需要玩家手动开启的「烧 token」工具：默认不下发给模型，玩家在界面里
// /subagents on、/team on（或改 config.json）后才出现在工具清单里。
export const GATED_TOOLS = { subagent: 'subagents', team: 'team' };

/** 当前配置下允许出现的工具（关掉的工具连 schema 都不发，模型不会误调）。 */
export function enabledTools(config) {
  const s = config?.settings || {};
  return allTools.filter((t) => {
    const flag = GATED_TOOLS[t.name];
    return !flag || !!s[flag];
  });
}

export function toolSchemas(tools = allTools, { plugins = true } = {}) {
  const list = [
    ...tools,
    ...(plugins ? pluginTools().filter((p) => !tools.some((t) => t.name === p.name)) : []),
  ];
  return list.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    readOnly: !!t.readOnly,
  }));
}

export function getTool(name) {
  const direct = toolMap.get(name) || toolMap.get(name?.toLowerCase());
  if (direct) return direct;
  const q = String(name || '').toLowerCase();
  return pluginTools().find((t) => t.name.toLowerCase() === q) || null;
}

const ALIASES = {
  file_path: 'path',
  filepath: 'path',
  filename: 'path',
  absolute_path: 'path',
  file: 'path',
  cmd: 'command',
  script: 'command',
  commandline: 'command',
  file_text: 'content',
  text: 'content',
  old_str: 'old_string',
  new_str: 'new_string',
  search_query: 'query',
  q: 'query',
  uri: 'url',
  link: 'url',
};

/** Coerce obvious type mistakes (model sending numbers as strings, etc). */
function coerce(tool, input) {
  const out = {};
  const props = tool.parameters?.properties || {};
  for (const [k, v] of Object.entries(input || {})) {
    const target = props[k] ? k : ALIASES[k] && props[ALIASES[k]] ? ALIASES[k] : k;
    if (out[target] === undefined) out[target] = v;
  }
  for (const [k, v] of Object.entries(out)) {
    const p = props[k];
    if (!p) continue;
    if ((p.type === 'number' || p.type === 'integer') && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) out[k] = Number(v);
    if (p.type === 'string' && typeof v === 'number') out[k] = String(v);
  }
  return out;
}

/** Split a list of calls into batches: consecutive read-only calls run together. */
export function planBatches(calls) {
  const batches = [];
  let current = null;
  for (const c of calls) {
    const tool = getTool(c.name);
    const ro = !!tool?.readOnly;
    if (ro && current?.readOnly) current.calls.push(c);
    else {
      current = { readOnly: ro, calls: [c] };
      batches.push(current);
    }
  }
  return batches;
}

export async function runTool(call, ctx) {
  const tool = getTool(call.name);
  const started = Date.now();
  if (!tool) {
    return { id: call.id, name: call.name, isError: true, content: `未知工具: ${call.name}`, dur: 0 };
  }
  try {
    const input = coerce(tool, call.input);
    if (ctx?.allowedTools && !ctx.allowedTools.has(tool.name)) {
      return {
        id: call.id,
        name: call.name,
        isError: true,
        content: `工具 ${call.name} 不在当前子代理的权限范围内。可用工具: ${[...ctx.allowedTools].join(', ')}`,
        dur: 0,
      };
    }
    const missing = (tool.parameters?.required || []).filter((k) => input[k] === undefined || input[k] === null || input[k] === '');
    if (missing.length) {
      return { id: call.id, name: call.name, isError: true, content: `缺少参数: ${missing.join(', ')}`, dur: 0 };
    }
    const fn = tool.execute || tool.run;
    // life-cycle hooks: pre (can deny) → tool → post (notes appended)
    const notes = [];
    if (ctx?.hooks) {
      const pre = await runPreHooks(ctx.hooks, { ...call, input }, ctx);
      notes.push(...(pre.notes || []));
      if (pre.deny) {
        return {
          id: call.id,
          name: call.name,
          input,
          isError: true,
          content: `被 hook 拦截：${pre.reason}`,
          dur: Date.now() - started,
        };
      }
    }
    const res = await fn.call(tool, input, ctx);
    const out = {
      id: call.id,
      name: call.name,
      input,
      isError: !!res.isError,
      content: typeof res === 'string' ? res : (res.content ?? ''),
      meta: res.meta,
      dur: Date.now() - started,
    };
    if (ctx?.hooks) {
      try {
        const post = await runPostHooks(ctx.hooks, { ...call, input }, out, ctx);
        notes.push(...post);
      } catch {}
    }
    if (notes.length) {
      out.content = `${out.content}\n\n${notes.join('\n')}`;
      out.meta = { ...(out.meta || {}), hooks: notes.length };
    }
    return out;
  } catch (e) {
    return { id: call.id, name: call.name, isError: true, content: `工具执行失败: ${e?.message || e}`, dur: Date.now() - started };
  }
}
