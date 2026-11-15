#!/usr/bin/env node
// agent — TUI entry point.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const here = path.dirname(__filename);
const load = (rel) => import(pathToFileURL(path.join(here, '..', rel)).href);

const VERSION = '2.1.0';
const APP_NAME = 'AuroraTui';

// Windows 控制台窗口标题 / *nix 进程名都跟着它走（截图里 cmd 上方那行名字）
process.title = APP_NAME;

function usage() {
  console.log(`${APP_NAME} ${VERSION} — 终端里的 AI 编程代理

用法:
  auroratui                     打开交互式界面（TUI）
  auroratui "帮我修复这个 bug"    一次性执行并输出（非交互）
  auroratui --continue          恢复上次会话
  auroratui --provider deepseek --model deepseek-flash
  auroratui --cwd <dir>         指定工作目录
  auroratui --plain "..."       强制非交互输出
  auroratui --version | --help

交互界面内:
  /model 切换模型   /key 配置密钥   /progress 团队面板   /help 全部命令   ESC 中断
`);
}

function parseArgs(argv) {
  const out = { flags: {}, prompt: null };
  const takes = new Set(['provider', 'model', 'cwd', 'key']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.flags.help = true;
    else if (a === '-v' || a === '--version') out.flags.version = true;
    else if (a === '-p' || a === '--plain') out.flags.plain = true;
    else if (a === '-c' || a === '--continue') out.flags.continue = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (takes.has(k)) out.flags[k] = v !== undefined ? v : argv[++i];
      else out.flags[k] = v ?? true;
    } else if (!out.prompt) out.prompt = a;
    else out.prompt += ' ' + a;
  }
  return out;
}

const { flags, prompt } = parseArgs(process.argv.slice(2));
if (flags.version) {
  console.log(`${APP_NAME} ${VERSION}`);
  process.exit(0);
}
if (flags.help) {
  usage();
  process.exit(0);
}

const { Config, AGENT_DIR } = await load('src/config.js');
const config = new Config();
config.load();

if (flags.provider || flags.model) {
  const pid = flags.provider || config.active.provider;
  const mid = flags.model || config.active.model;
  config.setActive(pid, mid);
}
if (flags.key) {
  config.setApiKey(config.active.provider, flags.key);
}
const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();

// 开机自动加载 plugins/ 下的插件（draw 画板等），失败只记日志不影响启动。
// settings.plugins = false 可整体关闭。
if (config.settings?.plugins !== false) {
  try {
    const { autoloadPlugins } = await load('src/tools/plugin.js');
    const r = await autoloadPlugins();
    if (r.loaded.length) logDbg(`plugins loaded: ${r.loaded.join(' ')}`);
    for (const f of r.failed) logDbg(`plugin failed: ${f.name}: ${f.error}`);
  } catch (e) {
    logDbg(`plugin autoload error: ${e?.message || e}`);
  }
}

// ------------------------------------------------------------------ one-shot
const wantsPlain = flags.plain || !!prompt;
if (wantsPlain) {
  const text = prompt || (await readStdin()).trim();
  if (!text) {
    console.error('没有输入内容。用法: auroratui "你的问题"');
    process.exit(1);
  }
  await runPlain(text, cwd);
  process.exit(0);
}

// ---------------------------------------------------------------------- TUI
const tty = !!(process.stdout.isTTY && process.stdin.isTTY);
if (!tty) {
  if (process.platform === 'win32') {
    relaunchInConsole();
    process.exit(0);
  }
  console.error('需要在交互式终端中运行（当前 stdout 不是 TTY）。');
  process.exit(1);
}

const { App } = await load('src/ui/app.js');
const app = new App({ config, cwd, resume: !!flags.continue });
if (flags.demo) app.seedDemo();
process.on('SIGINT', () => app.exit(0));
process.on('SIGTERM', () => app.exit(0));
process.on('uncaughtException', (e) => {
  try {
    app.push({ kind: 'error', text: `未捕获异常: ${e.stack || e.message}` });
    app.dirty = true;
  } catch {
    console.error(e);
  }
});
logDbg(`start tty=${process.stdout.isTTY}/${process.stdin.isTTY} size=${process.stdout.columns}x${process.stdout.rows} argv=${process.argv.slice(2).join(' ')}`);
try {
  const code = await app.start();
  process.exit(typeof code === 'number' ? code : 0);
} catch (e) {
  logCrash(e);
  throw e;
} finally {
  try {
    const { disposeShell } = await load('src/tools/shell.js');
    disposeShell();
  } catch {}
}

// ------------------------------------------------------------------- helpers
function logDbg(msg) {
  if (!process.env.AGENT_DEBUG) return;
  try {
    const dir = path.join(os.homedir(), '.agent', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'launch.log'), `[${new Date().toISOString()}] ${msg}
`);
  } catch {}
}

function logCrash(e) {
  try {
    const dir = path.join(os.homedir(), '.agent', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crash.log'), `[${new Date().toISOString()}] ${e?.stack || e}
`);
  } catch {}
}

function relaunchInConsole() {
  const script = __filename;
  const args = process.argv
    .slice(2)
    .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
  const cmdFile = path.join(os.tmpdir(), `auroratui-launch-${process.pid}.cmd`);
  fs.writeFileSync(cmdFile, `@echo off\r\nchcp 65001 >nul\r\ntitle AuroraTui\r\nmode con: cols=118 lines=36 2>nul\r\nnode "${script}" ${args}\r\nif errorlevel 1 pause\r\n`);
  console.log(`当前终端不是原生控制台（例如 Git Bash / mintty / 管道），已在新窗口启动 ${APP_NAME}…`);
  const child = spawn('cmd.exe', ['/c', 'start', '"AuroraTui"', `"${cmdFile}"`], { detached: true, stdio: 'inherit', windowsVerbatimArguments: true });
  child.on('error', (e) => {
    console.error('启动失败:', e.message);
    console.error(`请手动运行: node "${script}"`);
  });
  child.unref();
  setTimeout(() => {
    try {
      fs.rmSync(cmdFile, { force: true });
    } catch {}
  }, 4000);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function runPlain(text, cwd) {
  const { Agent } = await load('src/agent.js');
  const { T } = await load('src/ui/theme.js');
  const agent = new Agent({ config, cwd });
  let wroteText = false;
  const write = (s) => {
    process.stdout.write(s);
    wroteText = true;
  };
  for await (const ev of agent.run(text)) {
    if (ev.type === 'text') write(ev.delta);
    else if (ev.type === 'tool_start') {
      if (wroteText) process.stdout.write('\n');
      process.stderr.write(`${T.dimmer('→ ' + ev.name)} ${T.dim(String(JSON.stringify(ev.input || {})).slice(0, 120))}\n`);
      wroteText = false;
    } else if (ev.type === 'tool_end') {
      process.stderr.write(`${ev.isError ? T.err('×') : T.ok('√')} ${T.dimmer(ev.name + ' ' + (ev.dur ?? 0) + 'ms')}\n`);
    } else if (ev.type === 'error') {
      process.stderr.write(`${T.err('× ' + ev.message)}\n`);
    } else if (ev.type === 'need_key') {
      process.stderr.write(`${T.warn('! 缺少 ' + ev.provider + ' 的 API key：运行 auroratui，然后 /key 配置')}\n`);
    } else if (ev.type === 'compacted' || ev.type === 'compact_end') {
      process.stderr.write(`${T.accent2('~ 上下文已压缩')}\n`);
    } else if (ev.type === 'usage') {
      const t = agent.target();
      process.stderr.write(`${T.dimmer(`tokens ↑${ev.total.input} ↓${ev.total.output} · $${ev.total.cost.toFixed(5)} · ${t.providerId}/${t.modelId}`)}\n`);
    }
  }
  process.stdout.write('\n');
  void AGENT_DIR;
  void T;
}
