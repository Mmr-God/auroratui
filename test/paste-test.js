// /key 这类自定义输入行的粘贴：Ctrl+V / 右键 / bracketed paste 三条路都得通。
// 以前只有 bracketed paste 接了，按 Ctrl+V 会掉进主输入框，key 还会被当成任务发给模型。
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-paste-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');

const W = 100;
const H = 30;
let buf = '';
const out = {
  isTTY: true,
  columns: W,
  rows: H,
  write(s) {
    buf += s;
    return true;
  },
  on() {},
  off() {},
  removeListener() {},
};
const err = { isTTY: true, columns: W, rows: H, write() {} };
const inp = new PassThrough();
inp.isTTY = true;
inp.setRawMode = () => {};
Object.defineProperty(inp, 'isRaw', { get: () => true, set() {} });

Object.defineProperty(process, 'stdout', { value: out, configurable: true });
Object.defineProperty(process, 'stderr', { value: err, configurable: true });
Object.defineProperty(process, 'stdin', { value: inp, configurable: true });

const { App } = await import('../src/ui/app.js');
const { stripAnsi } = await import('../src/util.js');

const config = new Config();
const app = new App({ config, cwd: process.cwd() });

const log = (m = '') => fs.writeSync(1, m + '\n');
const key = (s) => inp.emit('data', Buffer.from(s, 'utf8'));
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const clamp = (s, n = 180) => String(s).replace(/\n/g, ' ').slice(0, n);

function snap() {
  app.prevLines = [];
  app.render();
  const text = stripAnsi(buf);
  buf = '';
  return text;
}

let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${clamp(extra)}` : ''}`);
}

app.start();
await wait(120);
snap();

const provider = app.agent.target().providerId;
const FAKE = 'sk-paste0123456789abcdefghij';

// ---------------------------------------------------------------- 1. /key 弹出行
for (const ch of '/key') key(ch);
key('\r');
await wait(150);
check('弹出粘贴 key 的输入行', !!app.prompt && /API key/.test(app.prompt.question), app.prompt?.question);
if (!config.hasKey(provider)) config.clearApiKey?.(provider);

// bracketed paste（终端自带 Ctrl+Shift+V / 右键菜单走这条）
key(`\x1b[200~${FAKE}\x1b[201~`);
await wait(120);
check('bracketed paste 进了 prompt', app.prompt?.buffer === FAKE, JSON.stringify(app.prompt?.buffer));

// 屏幕上是点，不该把 key 画出来
let f = snap();
check('key 不明文显示', !f.includes(FAKE) && /\u2022/.test(f));

// Ctrl+V 这条路必须被 prompt 接住（以前掉进主输入框）
let routed = null;
const origPaste = app.pasteIntoPrompt.bind(app);
app.pasteIntoPrompt = async (raw) => {
  routed = raw === undefined ? '(clipboard)' : String(raw);
};
key('\x16');
await wait(80);
check('Ctrl+V 在 prompt 里被接住', routed === '(clipboard)', String(routed));
app.pasteIntoPrompt = origPaste;

// 右键同理
routed = null;
app.pasteIntoPrompt = async (raw) => {
  routed = raw === undefined ? '(clipboard)' : String(raw);
};
app.handleKey({ key: 'mouse-down', button: 2 });
await wait(50);
check('右键在 prompt 里被接住', routed === '(clipboard)', String(routed));
app.pasteIntoPrompt = origPaste;

// 回车提交
key('\r');
await wait(150);
check('回车后 key 存进配置', config.hasKey(provider), provider);
check('prompt 已关闭', !app.prompt);
f = snap();
check('保存后有提示', /已保存/.test(f));

// ------------------------------------------------- 2. 直接粘进对话框被拦下
for (let i = 0; i < 40; i++) key('\x7f');
await wait(50);
config.clearApiKey?.(provider);
buf = '';
key(`\x1b[200~${FAKE}\x1b[201~`);
await wait(120);
const beforeItems = app.items.length;
key('\r');
await wait(200);
f = stripAnsi(buf);
check('对话框里的 key 没被发给模型', app.running === false);
check('对话框里的 key 直接存进配置', config.hasKey(provider));
check('没有生成 user 气泡', app.items.length >= beforeItems && !app.items.some((i) => i.kind === 'user' && String(i.text).includes(FAKE)));
check('提示是“已直接存”', /已直接存给/.test(f), f.slice(-200));
check('标题里没有 key', !String(app.taskTitle || '').includes(FAKE), app.taskTitle);

log('');
log(failed ? `${failed} 个粘贴检查失败` : 'ALL PASTE CHECKS PASSED');
process.exit(failed ? 1 : 0);
