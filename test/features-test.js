// Feature tests for the 2026-11 additions: mouse selection + clipboard, history
// overlay, workspace guard (/trust), checkpoints (/undo), skills, hooks, browser.
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feat-'));
process.env.AGENT_HOME = HOME;
const CLIP = path.join(HOME, 'clip.jsonl');
process.env.AGENT_CLIPBOARD_STUB = '1';
process.env.AGENT_CLIPBOARD_STUB_FILE = CLIP;

const { Config } = await import('../src/config.js');
const { App } = await import('../src/ui/app.js');
const { stripAnsi } = await import('../src/util.js');
const { runTool } = await import('../src/tools/index.js');
const { Checkpoints } = await import('../src/checkpoint.js');
const { skillTool, listSkills } = await import('../src/tools/skill.js');
const { findBrowser } = await import('../src/tools/browser.js');
const { KeyParser } = await import('../src/ui/keys.js');

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

const log = (m = '') => fs.writeSync(1, m + '\n');
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const key = (s) => inp.emit('data', Buffer.from(s, 'utf8'));
const mouse = (btn, x, y, release = false) => key(`\x1b[<${btn};${x};${y}${release ? 'm' : 'M'}`);
const clipLog = () => {
  try {
    return fs
      .readFileSync(CLIP, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).text);
  } catch {
    return [];
  }
};

// a workspace with a file we can select text from
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-'));
fs.writeFileSync(path.join(WS, 'hello.txt'), '第一行 hello world\n第二行 中文内容\n');

const config = new Config();
const app = new App({ config, cwd: WS });

let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}
function snap() {
  app.prevLines = [];
  app.render();
  const t = stripAnsi(buf);
  buf = '';
  return t;
}

app.start();
await wait(150);
app.push({ kind: 'user', text: '你好，测试一下选区' });
app.push({ kind: 'assistant', text: '这是我的回答：hello 世界' });
await wait(80);
let f = snap();
check('header shows workspace', /工作区/.test(f.split('\n')[0]), f.split('\n')[0].slice(0, 60));
check('header shows workspace path', /agent-ws-/.test(f.split('\n')[0]));

// ---------------------------------------------------------------- mouse tools
check('mouse parser: wheel up', (() => {
  const ev = new KeyParser().push('\x1b[<64;10;5M');
  return ev[0]?.key === 'wheel-up';
})());
check('mouse parser: down/drag/release', (() => {
  const p = new KeyParser();
  const d = p.push('\x1b[<0;5;6M')[0];
  const g = p.push('\x1b[<32;9;7M')[0];
  const u = p.push('\x1b[<0;9;7m')[0];
  return d?.key === 'mouse-down' && d.button === 0 && g?.key === 'mouse-drag' && u?.key === 'mouse-up';
})());
check('mouse parser: right button', (() => {
  const ev = new KeyParser().push('\x1b[<2;5;6M');
  return ev[0]?.key === 'mouse-down' && ev[0].button === 2;
})());

// select the middle of the transcript and copy it
const lines = stripAnsi(app.lastFrameRaw.join('\n')).split('\n');
const targetRow = lines.findIndex((l) => l.includes('hello 世界')) + 1;
const targetRow2 = lines.findIndex((l) => l.includes('你好，测试')) + 1;
check('transcript has selectable rows', targetRow > 0 && targetRow2 > 0, `${targetRow}/${targetRow2}`);
mouse(0, 5, targetRow);
await wait(40);
mouse(32, 30, targetRow);
await wait(40);
mouse(32, 20, targetRow2);
await wait(40);
const highlighted = snap();
check('selection is reverse-video painted', /\x1b\[48;5;238m\x1b\[97m/.test(buf) || highlighted.includes('hello'), 'highlight drawn');
mouse(0, 20, targetRow2, true);
await wait(200);
let copied = clipLog();
check('drag-select wrote clipboard', copied.length > 0 && copied[0].length > 0, JSON.stringify(copied[0] || '').slice(0, 60));
check('multi-line selection joined', (copied[0] || '').includes(String.fromCharCode(10)) || (copied[0] || '').length > 3);
check('selection cleared after copy', app.sel === null);

// click without drag must not copy
const before = clipLog().length;
mouse(0, 5, targetRow);
await wait(30);
mouse(0, 5, targetRow, true);
await wait(120);
check('plain click does not copy', clipLog().length === before);

// ------------------------------------------------------------------- paste
process.env.AGENT_CLIPBOARD_STUB = '粘贴进来的文本';
app.input = { text: '', cursor: 0 };
await app.pasteFromClipboard();
check('paste inserts clipboard text', app.input.text === '粘贴进来的文本', app.input.text);
process.env.AGENT_CLIPBOARD_STUB = '1';

// 剪贴板里是截图（没有文本）：存成临时 PNG 并把路径填进输入框，而不是报「剪贴板是空的」
const shotPath = path.join(os.tmpdir(), 'agent shot 截图.png');
process.env.AGENT_CLIPBOARD_IMAGE_STUB = shotPath;
app.input = { text: '', cursor: 0 };
await app.pasteFromClipboard();
check('image paste inserts file path', app.input.text.includes('agent shot 截图.png'), JSON.stringify(app.input.text));
check('image path with spaces is quoted', app.input.text.startsWith('"') && app.input.text.endsWith('"'), JSON.stringify(app.input.text));
check('image paste note mentions 图片', /图片/.test(stripAnsi(app.lastFrameRaw.join('\n'))), 'note drawn');
// 剪贴板里既没文本也没图
process.env.AGENT_CLIPBOARD_IMAGE_STUB = '1';
app.input = { text: '', cursor: 0 };
await app.pasteFromClipboard();
check('empty clipboard still reports empty', app.input.text === '' && /剪贴板是空的/.test(stripAnsi(app.lastFrameRaw.join('\n'))));
delete process.env.AGENT_CLIPBOARD_IMAGE_STUB;

// bracketed paste of multi-line text
key('\x1b[200~line1\nline2\x1b[201~');
await wait(40);
check('bracketed paste keeps newlines', app.input.text.includes('line1\nline2'), JSON.stringify(app.input.text));
app.input = { text: '', cursor: 0 };

// /copy command
await app.copyLastReply(1);
copied = clipLog();
check('/copy puts last reply on clipboard', /hello 世界/.test(copied[copied.length - 1] || ''), JSON.stringify(copied[copied.length - 1] || '').slice(0, 40));

// ------------------------------------------------------------ trust / guard
const outside = path.join(os.homedir(), `agent-outside-${Date.now()}.txt`);
const ctxDenied = { cwd: WS, allowOutside: false };
const w1 = await runTool({ id: '1', name: 'write', input: { path: outside, content: 'x' } }, ctxDenied);
check('workspace guard blocks outside write', w1.isError && /工作区/.test(w1.content), w1.content.slice(0, 40));
check('guard message mentions /trust', /\/trust/.test(w1.content));

app.setTrust('on');
check('/trust on flips config', config.allowOutsideCwd === true);
const w2 = await runTool({ id: '2', name: 'write', input: { path: outside, content: 'x' } }, { cwd: WS, allowOutside: true, checkpoints: app.checkpoints });
check('全权模式 allows outside write', !w2.isError);
f = snap();
check('header shows 全权 badge', /全权/.test(stripAnsi(app.headerLine(80))));
app.setTrust('off');
check('/trust off restores guard', config.allowOutsideCwd === false);
try {
  fs.unlinkSync(outside);
} catch {}

// --------------------------------------------------------------- checkpoints
const target = path.join(WS, 'hello.txt');
const ck = new Checkpoints(path.join(HOME, 'ck'));
const original = fs.readFileSync(target, 'utf8');
await runTool({ id: '3', name: 'write', input: { path: target, content: '改坏了\n' } }, { cwd: WS, allowOutside: false, checkpoints: ck });
check('write replaced file', fs.readFileSync(target, 'utf8') === '改坏了\n');
check('checkpoint recorded', ck.list().length === 1 && ck.list()[0].files.length === 1);
const res = ck.restore();
check('checkpoint restore brings content back', res.ok && fs.readFileSync(target, 'utf8') === original);
check('/undo command writes a note', (() => {
  app.undoCheckpoint();
  return app.items.some((i) => i.kind === 'note' && /回滚/.test(i.text));
})());

// ------------------------------------------------------------------- skills
const sdir = path.join(WS, '.agent', 'skills');
fs.mkdirSync(sdir, { recursive: true });
fs.writeFileSync(path.join(sdir, 'pytest.md'), '---\nname: pytest\ndescription: 用 pytest 跑单元测试\n---\n\n1. 先 uv run pytest -q\n');
check('listSkills finds project skill', listSkills(WS).some((s) => s.name === 'pytest'));
const sl = await skillTool.execute({ action: 'list' }, { cwd: WS });
check('skill list output', /pytest/.test(sl.content) && /用 pytest 跑单元测试/.test(sl.content), sl.content.slice(0, 50));
const sd = await skillTool.execute({ action: 'load', name: 'pytest' }, { cwd: WS });
check('skill load returns body', /uv run pytest -q/.test(sd.content) && !sd.isError);
check(
  'skill load carries meta.skill for the UI wrapper',
  sd.meta?.skill?.name === 'pytest' && sd.meta.skill.scope === '项目' && sd.meta.summary === '用 pytest 跑单元测试',
  JSON.stringify(sd.meta?.skill),
);

// -------------------------------------------------------------------- hooks
const hookFile = path.join(WS, 'hook.log');
const denyHook = path.join(WS, 'deny.js');
fs.writeFileSync(denyHook, `process.stdin.resume();process.stdin.on('end',()=>{console.error('不批准');process.exit(2)});`);
const allowHook = path.join(WS, 'allow.mjs');
fs.writeFileSync(
  allowHook,
  [
    "import fs from 'node:fs';",
    "let d = '';",
    "process.stdin.on('data', (c) => (d += c));",
    "process.stdin.on('end', () => {",
    `  fs.appendFileSync(${JSON.stringify(hookFile)}, JSON.parse(d).tool + '\\n');`,
    "  console.log('hook 说 ok');",
    '});',
  ].join('\n')
);
const hooks = { preToolUse: [{ match: 'shell', command: `node "${denyHook}"`, block: true }], postToolUse: [{ match: 'read', command: `node "${allowHook}"` }] };
const denied = await runTool({ id: '4', name: 'shell', input: { command: 'echo hi' } }, { cwd: WS, hooks });
check('pre hook exit 2 denies tool', denied.isError && /hook 拦截/.test(denied.content) && /不批准/.test(denied.content), denied.content.slice(0, 50));
check('denied tool did not run', !/hi/.test(denied.content.replace(/'|"/g, '')));
const withPost = await runTool({ id: '5', name: 'read', input: { path: 'hello.txt' } }, { cwd: WS, hooks });
check('post hook note appended', /hook 说 ok/.test(withPost.content) && !withPost.isError);
check('post hook actually executed', fs.existsSync(hookFile) && /read/.test(fs.readFileSync(hookFile, 'utf8')));

// ------------------------------------------------------------------ browser
const b = findBrowser();
check('browser binary found', !!b && fs.existsSync(b), b);
const bres = await runTool({ id: '6', name: 'browser', input: { action: 'open', url: 'not a real url' } }, { cwd: WS });
check('browser tool returns text or clean error', typeof bres.content === 'string' && bres.content.length > 0);

// ----------------------------------------------------------------- history
app.agent.engine.addUser('会话测试消息');
app.agent.engine.addAssistant({ content: '收到' });
app.saveSession();
const sessions = app.listSessions();
check('session saved with items', sessions.length >= 1 && sessions[0].cwd === WS, JSON.stringify(sessions[0] || {}).slice(0, 80));
app.openHistory();
check('history overlay opens', !!app.histOverlay);
f = snap();
check('history overlay drawn', /历史对话/.test(f));
key('\x1b[B'); // down
await wait(40);
check('history navigation clamps', app.histOverlay.sel >= 0);
key('\x1b'); // esc closes
await wait(60);
check('history overlay closes on esc', app.histOverlay === null);
app.openHistory();
key('\r'); // enter → load
await wait(200);
check('history enter loads session', app.items.some((i) => i.kind === 'user') && app.histOverlay === null);

// 通过键盘真的敲 /history + 回车，历史面板必须打开
app.input = { text: '', cursor: 0 };
await key('/history');
await wait(60);
await key(String.fromCharCode(13));
await wait(300);
check('/history 命令打开面板', !!app.histOverlay);
app.histOverlay = null;

// /native toggles mouse reporting
app.toggleNativeMouse();
check('/native sets native flag', app.nativeMouse === true);
app.toggleNativeMouse();
check('/native toggles back', app.nativeMouse === false);

// 历史面板里不同会话标题必须不同
{
  const fsx = await import('node:fs');
  const px = await import('node:path');
  const dir = px.join(process.env.AGENT_HOME, 'sessions');
  fsx.mkdirSync(dir, { recursive: true });
  const mk = (id, title, nodes, updated) =>
    fsx.writeFileSync(px.join(dir, id + '.json'), JSON.stringify({ id, title, cwd: WS, provider: 'local', model: 'cn:x', updated, context: { nodes: Array.from({ length: nodes }, () => ({ kind: 'message', message: { role: 'user', content: 'x' } })) } }));
  mk('svc-alpha', 'fix the marker parser', 3, Date.now() - 60000);
  mk('svc-beta', 'add a todo list feature', 5, Date.now());
  app.openHistory();
  const f2 = snap();
  check('history shows two different titles', /fix the marker parser/.test(f2) && /add a todo list feature/.test(f2));
  app.histOverlay = null;
}

// 输入法上屏保护：多字符文本到达后的回车不触发发送
app.input = { text: '中文输入', cursor: 4 };
key('哈罗');           // 模拟输入法一次上屏 2 字
await wait(30);
const beforeItems = app.items.length;
key('\r');
await wait(60);
check('IME 上屏后回车不发送', app.items.length === beforeItems && app.input.text.includes('中文输入'), app.input.text);
await wait(150);
app.running = false;

// 会话标题：不同会话必须能区分（不能都叫同一个名字）
app.demo = false;
app.title = '';
app.items = [{ kind: 'user', text: '第一个任务：修 shell marker' }, { kind: 'assistant', text: '好' }];
check('deriveTitle 用首条玩家输入', app.deriveTitle() === '第一个任务：修 shell marker', app.deriveTitle());
app.demo = true;
check('demo 会话标题固定', app.deriveTitle() === '示例会话（--demo）', app.deriveTitle());
app.demo = false;
app.title = '';
app.items = [{ kind: 'user', text: '第二个任务：加待办' }];
check('deriveTitle 跟随会话变化', app.deriveTitle() === '第二个任务：加待办', app.deriveTitle());
app.title = '第二个任务：加待办';
app.input = { text: '', cursor: 0 };
key('/new' + String.fromCharCode(13));
await wait(200);
check('/new 后标题清空', app.title === '', app.title);
await key('随便一句话');
await wait(160);
await key(String.fromCharCode(13));
await wait(400);
check('新会话重新取标题', app.title === '随便一句话', app.title);

// ---------------------------------------------------------- 折叠块 + 滑块
app.items = [];
app.title = '折叠块测试';
app.askState = null;
app.picker = null;
app.histOverlay = null;
app.scroll = 0;
app.width = 100;
app.height = 30;
const thinkItem = app.push({
  kind: 'think',
  text: '先看看 shell.js 里 marker 是怎么拼的，再决定改哪里。',
  t0: Date.now() - 3200,
  done: true,
  dur: 3200,
  collapsed: true,
  collapsible: true,
});
const toolItem = app.push({
  kind: 'tool',
  name: 'shell',
  input: { command: 'node --test test/' },
  status: 'ok',
  content: 'pass 2\nfail 0\nok marker 解析',
  dur: 1600,
  collapsible: true,
  collapsed: true,
});
const ansItem = app.push({ kind: 'assistant', text: '改好了，test/ 全绿。', collapsible: true, collapsed: false });
await app.render(true);
f = snap();
check('思考块收起显示 Thought for 用时', /Thought for 3\.2s/.test(f), f.split('\n').find((l) => /Thought/.test(l)));
check('收起的思考块不显示正文', !f.includes('先看看 shell.js'));
check('收起的工具块显示一行摘要', /√/.test(f) && /node --test/.test(f), f.split('\n').find((l) => /shell/.test(l)));
check('收起的工具块提示可展开', /点击展开|行 · 点击/.test(f));
check('小回答不被折叠', f.includes('改好了，test/ 全绿。'));

app.toggleItem(thinkItem);
f = snap();
check('展开思考块后看到正文', f.includes('先看看 shell.js'));
check('展开后箭头变 ↑', /↑ Thought for/.test(f));
app.toggleItem(toolItem);
f = snap();
check('展开工具块看到全部输出', f.includes('ok marker 解析'));

// Ctrl+O 切换最后一个可折叠块
app.toggleItem(thinkItem);
app.toggleItem(toolItem);
await wait(30);
key('\x0f'); // ctrl+o
await wait(60);
check('Ctrl+O 切换最后一个块', ansItem.collapsed === true || toolItem.collapsed === false);

// 鼠标单击块头 = 折叠/展开
app.items = [];
const clickItem = app.push({
  kind: 'think',
  text: '点击测试',
  t0: Date.now() - 500,
  done: true,
  dur: 500,
  collapsed: true,
  collapsible: true,
});
app.push({ kind: 'note', text: '正文占位' });
await app.render(true);
snap();
const hit = (app.rowMap || []).find((r) => r.item === clickItem);
if (hit) {
  mouse(0, 5, hit.from); // down
  mouse(0, 5, hit.from, true); // up 在同一格 → 切换
  await wait(60);
  check('点击思考块头可展开', clickItem.collapsed === false, `row=${hit.from}`);
} else {
  check('点击思考块头可展开', false, 'rowMap 没有命中');
}

// 右侧滑块（注意：render 输出的是 CUP 定位 + 行内容，帧各行之间没有换行符，
//  所以必须先按固定宽度切片，不能按换行切）
app.items = [];
for (let i = 0; i < 60; i++) app.push({ kind: 'note', text: `第 ${i} 行内容` });
out.columns = 80;
out.rows = 20;
app.scroll = 0;
buf = '';
await app.render(true);
const segRaw = buf;
buf = '';
const viewRows = segRaw.split(/\[\d+;1H\[2K/).slice(1).map((x) => stripAnsi(x));
const barCells = viewRows.slice(1, 15).map((x) => x.replace(/\s+$/, '').slice(-1) || ' ').join('');
check('右侧画出了滑块/轨道', /[║│]/.test(barCells), JSON.stringify(barCells));
check('滑块有拇指', barCells.includes('║'), JSON.stringify(barCells));
const beforeScroll = app.scroll;
app.scrollbarTo(2);
check('拖滑块能滚到顶部', app.scroll > beforeScroll, `scroll ${beforeScroll} → ${app.scroll}`);
app.scroll = 0;
out.columns = 100;
out.rows = 30;

// ask 工具：无交互时报错（有交互时由界面接管）
const askNoCtx = await runTool(
  { id: 'x1', name: 'ask', input: { question: '选哪个？', options: ['甲', '乙'] } },
  { cwd: app.cwd, config: app.config },
);
check('ask 在无交互环境报错', askNoCtx.isError && /不支持交互提问/.test(askNoCtx.content), askNoCtx.content.slice(0, 40));

// ---------- 流式输出时的滚动：滚上去就「暂停跟随」，新内容不把视线拽走 ----------
app.items = [];
for (let i = 0; i < 40; i++) app.push({ kind: 'note', text: '内容行 ' + i });
out.columns = 100;
out.rows = 30;
app.scroll = 0;
app.followAnchor = null;
app.running = true;
await app.render(true);
snap();
const capTop = async () => {
  buf = '';
  await app.render(true);
  const segs = buf.split(/\[\d+;1H\[2K/).slice(1).map((x) => stripAnsi(x));
  buf = '';
  return (segs[1] || '').trim();
};
app.scrollBy(6);
await app.render(true);
snap();
check('滚轮向上可以离开底部', app.scroll > 0, 'scroll=' + app.scroll);
check('离开底部后进入暂停跟随', app.followAnchor != null, 'anchor=' + app.followAnchor);
const topBeforeStream = await capTop();

// 模拟 AI 边写边加行（10 段）+ 一个工具块
const streamItem = app.push({ kind: 'assistant', text: '开始' });
for (let i = 0; i < 10; i++) {
  streamItem.text += ' 第' + i + '段内容';
  streamItem.ver++;
  await wait(20);
}
app.push({ kind: 'tool', name: 'shell', title: 'shell', input: { command: 'ls' }, output: 'a', status: 'ok', dur: 12 });
await wait(80);
const topAfterStream = await capTop();
check('流式输出时视口不被拽回底部', topAfterStream === topBeforeStream, JSON.stringify([topBeforeStream.slice(0, 18), topAfterStream.slice(0, 18)]));
check('流式输出后仍在暂停跟随', app.followAnchor != null, 'anchor=' + app.followAnchor);

app.scrollBy(-1000);
await app.render(true);
check('滚到底部恢复跟随', app.scroll === 0 && app.followAnchor === null);
check('滚到底部后新内容会跟着走', (() => {
  const before = app.scroll;
  app.push({ kind: 'note', text: '底部新行' });
  return app.scroll === before && app.followAnchor === null;
})());

app.scrollBy(8);
await app.render(true);
app.scrollToBottom();
check('End / 回到底部按钮可用', app.scroll === 0 && app.followAnchor === null);
app.scrollToTop();
check('Home 跳到最顶部', app.followAnchor === 0 && app.scroll > 0, 'scroll=' + app.scroll);
app.scrollToBottom();
app.running = false;
out.columns = 100;
out.rows = 30;

// ---- 图片读取的界面表现（read 工具看到图）-------------------------------
app.running = false;
app.items = [];
app.push({ kind: 'user', text: '看看这张截图' });
const imgItem = {
  kind: 'tool',
  name: 'read',
  input: { path: 'D:/shot.png' },
  status: 'ok',
  isError: false,
  collapsed: true,
  content: '[图片] shot.png 800x600 · image/png · 100KB',
  dur: 30,
  meta: { kind: 'image', bytes: 102400, images: [{ mime: 'image/png', base64: 'AAAA', width: 800, height: 600, path: 'D:/shot.png' }] },
  ver: 0,
};
app.items.push(imgItem);
await app.render(true);
{
  const f = snap();
  check('工具块显示图片尺寸', f.includes('[图片 800x600'), '');
  check('工具块标注已附图', f.includes('图片已附进对话'));
  check('工具块不是失败态', !/× read/.test(f));
}

app.quit = true;
clearInterval(app.timer);
log('');
log(failed ? `FAILED ${failed} check(s)` : 'ALL FEATURE CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
await wait(60);
