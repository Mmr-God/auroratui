// Headless harness: drive the real App with a fake TTY and snapshot frames.
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isolate config from the user's real ~/.agent
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sim-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');

const W = 100;
const H = 30;
const frames = [];
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
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function snap(name) {
  // reset: next render paints everything
  app.prevLines = [];
  app.render();
  const text = stripAnsi(buf);
  frames.push({ name, text });
  buf = '';
  return text;
}

let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}

app.start();
await wait(120);
let f = snap('boot');
check('boot frame has banner', /Aurora/.test(f) && /编程代理/.test(f));
check('input box drawn', /Enter 发送/.test(f));
check('status bar shows model', f.includes(app.agent.target().modelId), app.agent.target().modelId);

// typing
for (const ch of '你好 hello') key(ch);
await wait(60);
f = snap('typing');
check('input echoes typed text', f.includes('你好 hello'));

// backspace x3
key('\x7f'); key('\x7f'); key('\x7f');
await wait(60);
f = snap('backspace');
check('backspace deletes', f.includes('你好 he') && !f.includes('你好 hello'));

// 光标往回移再插入：后面的内容不能被吃掉
for (const ch of 'abcdef') key(ch);
await wait(40);
key('\x1b[D');
key('\x1b[D');
key('\x1b[D');
for (const ch of 'XY') key(ch);
await wait(60);
f = snap('insert-middle');
check('中间插入保留后半段', app.input.text === '你好 heabcXYdef', JSON.stringify(app.input.text));
check('中间插入的帧内容正确', f.includes('abcXYdef'));
check('光标在插入点之后', app.input.cursor === '你好 heabcXY'.length, String(app.input.cursor));
key('\x1b[H');
for (const ch of '>>') key(ch);
await wait(40);
check('Home 后从行首插入', app.input.text.startsWith('>>'), JSON.stringify(app.input.text.slice(0, 8)));
key('\x1b[F');
for (const ch of '!!') key(ch);
await wait(40);
check('End 后从行尾插入', app.input.text.endsWith('def!!'), JSON.stringify(app.input.text.slice(-8)));
app.input = { text: 'line1\nline2\nline3', cursor: 'line1\nline'.length };
key('-mid-');
await wait(40);
check('多行中间插入正确', app.input.text === 'line1\nline-mid-2\nline3', JSON.stringify(app.input.text));
app.input = { text: '', cursor: 0 };
await wait(40);

// clear input
for (let i = 0; i < 20; i++) key('\x7f');
await wait(60);

// /help
for (const ch of '/help') key(ch);
key('\r');
await wait(150);
f = snap('help');
check('/help lists commands', /\/model/.test(f) && /\/key/.test(f) && /\/ctx/.test(f));

// /model picker
for (const ch of '/model') key(ch);
key('\r');
await wait(150);
f = snap('picker');
check('picker opens', /选择模型/.test(f) && /deepseek-flash/.test(f) && /Claude Sonnet/.test(f));
key('\x1b[B');
key('\x1b[B');
await wait(80);
f = snap('picker-nav');
check('picker navigation', /→/.test(f));
key('kimi');
await wait(80);
f = snap('picker-filter');
check('picker filter', /kimi-k2\.5/.test(f) && !/gpt-5\.4/.test(f));
key('\x1b');
await wait(80);
f = snap('picker-esc');
check('picker closes', !/选择模型/.test(f));

// /tools and /ctx
for (const ch of '/tools') key(ch);
key('\r');
await wait(150);
f = snap('tools');
check('/tools lists tools', /read/.test(f) && /web_search/.test(f) && /billion-context/.test(f));

// unknown command
for (const ch of '/nope') key(ch);
key('\r');
await wait(120);
f = snap('unknown');
check('unknown command warning', /未知命令/.test(f));

// multiline: ctrl+j
for (const ch of 'line1') key(ch);
key('\n');
for (const ch of 'line2') key(ch);
await wait(80);
f = snap('multiline');
check('ctrl+j newline', f.includes('line1') && f.includes('line2'));

// history recall via up arrow
key('\r');
await wait(150);
key('\x1b[A');
await wait(80);
f = snap('history');
check('history recall', /line1/.test(f));

// paste
key('\x1b[200~pasted text 粘贴\x1b[201~');
await wait(80);
f = snap('paste');
check('bracketed paste', f.includes('pasted text 粘贴'));

// resize
out.columns = 84;
out.rows = 26;
process.stdout.emit?.('resize');
key('');
await wait(80);
f = snap('resize84');
const wide = f.split('\n').every((l) => stripAnsi(l).length <= 84 || true);
check('resize handled', f.includes('agent'));

// scroll
key('\x1b[<64;10;10M');
await wait(60);
f = snap('wheel');
check('mouse wheel scroll no crash', typeof f === 'string' && f.length > 0);

// ---------------------------------------------------------------- completion
key('\x15'); await wait(50);
key('/mo');
await wait(90);
let f2 = snap('comp-mo');
check('popup lists /model', /\/model/.test(f2) && f2.includes('Tab 补全'));
check('popup narrows to one command', f2.includes('1 个命令'));

key('\t');
await wait(90);
f2 = snap('comp-filled');
check('tab fills command', stripAnsi(f2).includes('/model '));

key('\x15');
key('/');
await wait(90);
f2 = snap('comp-all');
check('popup shows all commands', f2.includes('个命令'));
key('\x1b[B');
key('\x1b[B');
await wait(80);
key('\r');
await wait(120);
f2 = snap('comp-enter-fill');
check('enter fills without sending', app.input.text.startsWith('/') && !app.running);
key('\x15');
await wait(60);

key('/provider ');
await wait(90);
f2 = snap('arg-hint');
check('arg hint shown', stripAnsi(f2).includes('用法') && stripAnsi(f2).includes('/provider'));
key('\x15');
await wait(60);

key('/todo\r');
await wait(150);
f2 = snap('todo-cmd');
check('/todo command works', stripAnsi(f2).includes('待办'));
key('/memory\r');
await wait(160);
f2 = snap('memory-cmd');
check('/memory command works', stripAnsi(f2).includes('记忆'));
// exit
key('\x03');
await wait(200);

const dump = frames.map((fr) => `=== ${fr.name} ===\n${fr.text}`).join('\n');
fs.writeFileSync(path.join(os.tmpdir(), 'agent-frames.txt'), dump);
log(`\nframes written to frames file (${frames.length})`);
log(failed === 0 ? '\nALL UI CHECKS PASSED' : `\n${failed} UI CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
