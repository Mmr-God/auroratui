// 插件系统：agent 可以给自己写插件（JS 模块）并在运行时动态加载/卸载/重载。
// 一个插件 = <agent根>/plugins/<name>.js（或 <name>/index.js），默认导出：
//   export default {
//     name: 'xxx',
//     description: '...',
//     tools: [ { name, description, parameters, readOnly?, execute(input, ctx) } ],
//     onUnload?.()   // 可选清理钩子
//   }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');

// name -> { mod, tools:[], file }
const loaded = new Map();

function pluginFile(name) {
  const safe = String(name).replace(/[^\w.-]/g, '');
  const asJs = path.join(PLUGIN_DIR, safe.endsWith('.js') ? safe : safe + '.js');
  if (fs.existsSync(asJs)) return asJs;
  const asDir = path.join(PLUGIN_DIR, safe, 'index.js');
  if (fs.existsSync(asDir)) return asDir;
  return null;
}

/** 动态加载（或重载）一个插件，返回其注册的工具。 */
async function load(name) {
  const file = pluginFile(name);
  if (!file) throw new Error(`插件不存在: plugins/${name}（目录: ${PLUGIN_DIR}）`);
  if (loaded.has(name)) await unload(name);
  // 只给入口加 ?t= 是不够的：它 import 的 ./core.js 仍然命中进程里的旧模块，
  // 于是改了子文件、reload 之后还是老代码（并可能报 "does not provide an export"）。
  // 所以整份插件目录先复制到一个带时间戳的临时目录，内部相对 import 就都指向新文件了。
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const staged = path.join(os.tmpdir(), 'agent-plugin-' + stamp);
  const isDirPlugin = path.basename(path.dirname(file)) === name; // plugins/<name>/index.js
  try {
    if (isDirPlugin) {
      fs.cpSync(path.dirname(file), staged, {
        recursive: true,
        filter: (p) => !/[\\/]node_modules([\\/]|$)/.test(p) && !/\.(log|png|jpe?g|gif|webp)$/i.test(p),
      });
    } else {
      fs.mkdirSync(staged, { recursive: true });
      fs.copyFileSync(file, path.join(staged, path.basename(file)));
    }
    const entry = path.join(staged, path.basename(file));
    const mod = await import(pathToFileURL(entry).href);
    const def = mod.default || mod;
    if (!def || !Array.isArray(def.tools)) throw new Error('插件必须 default 导出 { name, description, tools: [...] }');
    loaded.set(name, { mod: def, file, tools: def.tools, staged });
    return { name: def.name || name, description: def.description || '', tools: def.tools.map((t) => t.name) };
  } catch (err) {
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

async function unload(name) {
  const e = loaded.get(name);
  if (!e) throw new Error(`插件未加载: ${name}`);
  try { await e.mod.onUnload?.(); } catch (err) { /* 忽略清理错误 */ }
  if (e.staged) { try { fs.rmSync(e.staged, { recursive: true, force: true }); } catch { /* ignore */ } }
  loaded.delete(name);
}

/** 已加载插件提供的全部工具（由 index.js 注入 toolMap / agent 系统提示）。 */
export function pluginTools() {
  const out = [];
  for (const e of loaded.values()) for (const t of e.tools) out.push(t);
  return out;
}

export function pluginStatus() {
  return [...loaded.values()].map((e) => ({ name: e.mod.name, file: e.file, tools: e.tools.map((t) => t.name) }));
}

export function pluginsDir() { return PLUGIN_DIR; }

/**
 * 开机自动加载 plugins/ 下的全部插件（<name>.js 或 <name>/index.js），
 * 这样玩家装好的能力（如 draw 画板）开箱即用，不用先进会话让它 load。
 * 单个插件加载失败只会被记录，不影响启动；同名目录优先于同名 .js。
 * 设置 settings.plugins = false 可以整个关掉自动加载。
 * @returns {{ loaded: string[], failed: { name: string, error: string }[] }}
 */
export async function autoloadPlugins() {
  const out = { loaded: [], failed: [] };
  let entries = [];
  try {
    entries = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  const names = [];
  const seen = new Set();
  for (const e of entries) {
    let name = null;
    if (e.isDirectory()) name = e.name;
    else if (e.name.endsWith('.js')) name = e.name.slice(0, -3);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  for (const name of names) {
    if (loaded.has(name)) continue;
    try {
      const r = await load(name);
      out.loaded.push(`${r.name}(${r.tools.join(',') || '无工具'})`);
    } catch (err) {
      out.failed.push({ name, error: err?.message || String(err) });
    }
  }
  return out;
}

export const pluginTool = {
  name: 'plugin',
  description:
    '给自己写插件并动态加载/卸载/重载（运行时生效，无需重启）。actions: load/unload/reload/list/status/create（create 用 content 直接把插件 JS 写入 plugins/ 并立即加载）。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['load', 'unload', 'reload', 'list', 'status', 'create'], description: '操作' },
      name: { type: 'string', description: '插件名（create/load/unload/reload 必填）' },
      content: { type: 'string', description: 'create 时的插件 JS 源码（default 导出 { name, description, tools }）' },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = String(input.action).toLowerCase();
    if (action === 'list') {
      let files = [];
      try {
        files = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? path.join(e.name, 'index.js') : e.name.endsWith('.js') ? e.name : null))
          .filter(Boolean);
      } catch { /* 目录不存在 */ }
      const st = pluginStatus().map((s) => `${s.name}（已加载，工具: ${s.tools.join(', ') || '无'}）`);
      return `插件目录: ${PLUGIN_DIR}\n文件: ${files.join(', ') || '（空）'}\n已加载:\n${st.join('\n') || '（无）'}`;
    }
    if (action === 'status') {
      return JSON.stringify(pluginStatus(), null, 2) || '（无已加载插件）';
    }
    if (action === 'create') {
      if (!input.name || !input.content) return { isError: true, content: 'create 需要 name 和 content' };
      fs.mkdirSync(PLUGIN_DIR, { recursive: true });
      const file = path.join(PLUGIN_DIR, String(input.name).replace(/[^\w.-]/g, '') + '.js');
      fs.writeFileSync(file, input.content, 'utf8');
      const r = await load(input.name);
      return `已写入 ${file} 并动态加载成功。新工具: ${r.tools.join(', ') || '（无）'}（立即可用，无需重启）`;
    }
    if (!input.name) return { isError: true, content: `${action} 需要 name` };
    if (action === 'load') {
      const r = await load(input.name);
      return `插件 ${r.name} 已动态加载。工具: ${r.tools.join(', ') || '（无）'}`;
    }
    if (action === 'reload') {
      await load(input.name);
      const s = pluginStatus().find((p) => p.name === input.name || p.file.includes(input.name));
      return `插件已重载。工具: ${s?.tools.join(', ') || '（无）'}`;
    }
    if (action === 'unload') {
      await unload(input.name);
      return `插件 ${input.name} 已卸载，其工具即刻不可用。`;
    }
    return { isError: true, content: `未知 action: ${action}` };
  },
};
