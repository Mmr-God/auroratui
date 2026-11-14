// Task list (todo) + persistent memory tools.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AGENT_DIR } from '../config.js';

// ---------------------------------------------------------------- todo list
function todoPath(cwd) {
  return path.join(cwd, '.agent-todo.json');
}

export function readTodo(cwd) {
  try {
    const raw = JSON.parse(fs.readFileSync(todoPath(cwd), 'utf8'));
    return Array.isArray(raw.items) ? raw : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeTodo(cwd, data) {
  try {
    fs.writeFileSync(todoPath(cwd), JSON.stringify({ ...data, updated: Date.now() }, null, 2));
    return true;
  } catch {
    return false;
  }
}

const STATUS_MARK = { pending: '[ ]', doing: '[~]', done: '[x]', blocked: '[!]' };

/** UI 封装用的元信息：完成进度 + 下一项待办 */
function todoMeta(data) {
  const items = data.items;
  const done = items.filter((t) => t.status === 'done').length;
  const doing = items.filter((t) => t.status === 'doing').length;
  const next = items.find((t) => t.status !== 'done');
  const head = items.length ? `${done}/${items.length} 完成${doing ? ` · ${doing} 进行中` : ''}` : '待办列表为空';
  return { todo: items, done, total: items.length, summary: next ? `${head} · 下一项 ${next.text}` : head };
}

export function formatTodo(data) {
  if (!data.items.length) return '（待办列表为空）';
  return data.items
    .map((t, i) => `${STATUS_MARK[t.status] || '[ ]'} ${i + 1}. ${t.text}${t.note ? `  · ${t.note}` : ''}`)
    .join('\n');
}

export const todoTool = {
  name: 'todo',
  readOnly: false,
  description: '维护当前项目的任务清单（写入 <项目>/.agent-todo.json）。长任务开始时先拆成 3-8 条，随进度更新状态，避免做到一半忘记剩余项。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'set', 'add', 'update', 'clear'], description: 'list 查看 / set 整体重写 / add 追加 / update 改状态 / clear 清空' },
      items: { type: 'array', items: { type: 'string' }, description: 'set / add 时的任务文本列表' },
      index: { type: 'integer', description: 'update 时的序号（从 1 开始）' },
      status: { type: 'string', enum: ['pending', 'doing', 'done', 'blocked'], description: 'update 时的状态' },
      note: { type: 'string', description: '备注' },
    },
    required: ['action'],
  },
  async execute({ action = 'list', items = [], index, status, note }, ctx) {
    const data = readTodo(ctx.cwd);
    if (action === 'list') return { content: formatTodo(data), meta: todoMeta(data) };
    if (action === 'clear') {
      writeTodo(ctx.cwd, { items: [] });
      return { content: '待办已清空。' };
    }
    if (action === 'set') {
      data.items = items.filter(Boolean).map((text) => ({ text, status: 'pending' }));
      writeTodo(ctx.cwd, data);
      return { content: `已写入 ${data.items.length} 条待办：\n${formatTodo(data)}`, meta: todoMeta(data) };
    }
    if (action === 'add') {
      for (const text of items.filter(Boolean)) data.items.push({ text, status: 'pending' });
      writeTodo(ctx.cwd, data);
      return { content: `已追加 ${items.length} 条：\n${formatTodo(data)}`, meta: todoMeta(data) };
    }
    if (action === 'update') {
      const i = Number(index) - 1;
      if (!(i >= 0 && i < data.items.length)) return { content: `序号无效（共 ${data.items.length} 条）。`, isError: true };
      if (status) data.items[i].status = status;
      if (note) data.items[i].note = note;
      writeTodo(ctx.cwd, data);
      return { content: formatTodo(data), meta: todoMeta(data) };
    }
    return { content: `未知 action: ${action}`, isError: true };
  },
};

// ------------------------------------------------------------------ memory
const MEMORY_PATH = path.join(AGENT_DIR, 'memory.json');

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveMemory(mem) {
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Memory entries as prompt lines (newest first, budgeted). */
/** All memory entries as [key, value] pairs, newest first. */
export function memoryList() {
  const mem = loadMemory();
  return Object.entries(mem).sort((x, y) => (y[1].ts || 0) - (x[1].ts || 0)).map(([k, v]) => [k, v.value]);
}

export function memoryPrompt(maxChars = 2000) {
  const mem = loadMemory();
  const entries = Object.entries(mem).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  const lines = [];
  let used = 0;
  for (const [key, v] of entries) {
    const line = `- ${key}: ${v.value}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export const memoryTool = {
  name: 'memory',
  readOnly: false,
  description: '跨会话记忆（键值存储，保存在 ~/.agent/memory.json）。用来记住用户偏好、项目约定、重要事实，下次会话会自动注入系统提示。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'get', 'list', 'forget'], description: 'set 写入 / get 读取 / list 全部 / forget 删除' },
      key: { type: 'string', description: '键名，例如 user.lang 或 project.build' },
      value: { type: 'string', description: 'set 时的值' },
    },
    required: ['action'],
  },
  async execute({ action = 'list', key, value }) {
    const mem = loadMemory();
    if (action === 'set') {
      if (!key) return { content: '缺少 key。', isError: true };
      mem[key] = { value: String(value ?? ''), ts: Date.now() };
      saveMemory(mem);
      return { content: `已记住 ${key} = ${value}`, meta: { action, key, summary: `记忆 ${key} = ${String(value ?? '')}` } };
    }
    if (action === 'get') {
      if (!key) return { content: '缺少 key。', isError: true };
      if (!mem[key]) return { content: `没有记录 ${key}。`, meta: { action, key } };
      return { content: `${key} = ${mem[key].value}`, meta: { action, key, summary: `${key} = ${mem[key].value}` } };
    }
    if (action === 'forget') {
      if (!key) return { content: '缺少 key。', isError: true };
      delete mem[key];
      saveMemory(mem);
      return { content: `已遗忘 ${key}。`, meta: { action, key } };
    }
    const entries = Object.entries(mem);
    if (!entries.length) return { content: '（记忆为空）' };
    return { content: entries.map(([k, v]) => `${k} = ${v.value}`).join('\n') };
  },
};

/** Project-local MEMORY.md, if the user keeps one. */
export function projectMemory(cwd, maxChars = 3000) {
  try {
    const p = path.join(cwd, 'MEMORY.md');
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

export { os };
