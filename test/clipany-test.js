// 非文本剪贴板：复制「文件 / 截图 / 其它二进制」时，粘贴统一落成路径。
//
// 以前的 pasteFromClipboard 只处理「文本」和「截图」两种情况，资源管理器里
// Ctrl+C 复制一个文件再粘，会被当成空剪贴板直接丢掉。现在 readClipboardAny
// 把四类统一成一份结果：文本给原文，其余都给路径（模型用 read 直接拿到）。
//
// 这里全程走 stub，不碰真实剪贴板 —— 测试结果不能依赖开发者当时复制了什么。
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-clipany-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');
const { readClipboardAny, quotePath } = await import('../src/ui/clipboard.js');

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
const clamp = (s, n = 160) => String(s).replace(/\n/g, ' ').slice(0, n);

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

const clearStubs = () => {
  delete process.env.AGENT_CLIPBOARD_STUB;
  delete process.env.AGENT_CLIPBOARD_IMAGE_STUB;
  delete process.env.AGENT_CLIPBOARD_FILE_STUB;
  delete process.env.AGENT_CLIPBOARD_ANY_STUB;
};

// ------------------------------------------------ 1. 四种剪贴板内容的归类
clearStubs();
process.env.AGENT_CLIPBOARD_STUB = '一段普通文本';
let r = await readClipboardAny();
check('文本：kind=text 且原文返回', r.kind === 'text' && r.text === '一段普通文本', `${r.kind} ${r.text}`);

// 文本优先级最高：即使同时挂着图片/文件，也贴文本，绝不贴成路径
process.env.AGENT_CLIPBOARD_IMAGE_STUB = path.join(HOME, 'shot.png');
r = await readClipboardAny();
check('文本优先于图片（不会莫名贴成路径）', r.kind === 'text' && r.text === '一段普通文本', r.kind);

clearStubs();
const oneFile = path.join(HOME, 'report.pdf');
process.env.AGENT_CLIPBOARD_FILE_STUB = oneFile;
r = await readClipboardAny();
check('单个文件：kind=files', r.kind === 'files' && r.paths.length === 1, `${r.kind} ${JSON.stringify(r.paths)}`);
check('单个文件：text 就是路径', r.text === oneFile, r.text);
check('单个文件：note 说明改成了路径', /路径/.test(r.note), r.note);

// 多个文件 + 空格路径 → 每个都加引号，粘进输入框不会断成两半
const spaced = path.join(HOME, 'my notes', 'a b.txt');
process.env.AGENT_CLIPBOARD_FILE_STUB = JSON.stringify([oneFile, spaced]);
r = await readClipboardAny();
check('多个文件：路径全给出', r.paths.length === 2, JSON.stringify(r.paths));
check('带空格的路径被引号包住', r.text.includes(`"${spaced}"`), r.text);
check('不带空格的路径不加多余引号', r.text.includes(oneFile), r.text);

// 管道分隔也认（shell 脚本里手写 stub 更省事）
process.env.AGENT_CLIPBOARD_FILE_STUB = `${oneFile}|${spaced}`;
r = await readClipboardAny();
check('文件 stub 支持 | 分隔', r.paths.length === 2, JSON.stringify(r.paths));

clearStubs();
const shot = path.join(HOME, 'clip shot.png');
process.env.AGENT_CLIPBOARD_IMAGE_STUB = shot;
r = await readClipboardAny();
check('截图：kind=image', r.kind === 'image', r.kind);
check('截图：路径带引号', r.text === `"${shot}"`, r.text);
check('截图：note 提到图片', /图片/.test(r.note), r.note);

// 什么都是 1 = 空剪贴板
clearStubs();
process.env.AGENT_CLIPBOARD_STUB = '1';
process.env.AGENT_CLIPBOARD_IMAGE_STUB = '1';
r = await readClipboardAny();
check('空剪贴板：ok=false 且给出原因', !r.ok && !!r.err, `${r.ok} ${r.err}`);
check('空剪贴板：不会吐出任何文本', r.text === '', r.text);

// ------------------------------------------------ 2. 注入钩子能造任意 kind
clearStubs();
process.env.AGENT_CLIPBOARD_ANY_STUB = JSON.stringify({
  ok: true,
  kind: 'blob',
  text: '/tmp/x.bin',
  paths: ['/tmp/x.bin'],
  note: '剪贴板里是 Excel 片段',
});
r = await readClipboardAny();
check('ANY_STUB 能注入 blob 结果', r.kind === 'blob' && r.text === '/tmp/x.bin', `${r.kind} ${r.text}`);

// ------------------------------------------------ 3. quotePath 的边界
clearStubs();
check('quotePath：普通路径原样', quotePath('/a/b.txt') === '/a/b.txt', quotePath('/a/b.txt'));
check('quotePath：空格加引号', quotePath('/a/b c.txt') === '"/a/b c.txt"', quotePath('/a/b c.txt'));
check('quotePath：空值变空串', quotePath('') === '', JSON.stringify(quotePath('')));

// ------------------------------------------------ 4. 主输入框粘贴
app.start();
await wait(120);
snap();

clearStubs();
process.env.AGENT_CLIPBOARD_FILE_STUB = JSON.stringify([spaced]);
await app.pasteFromClipboard();
await wait(80);
check('主输入框：复制文件后粘贴得到路径', app.input.text.includes('a b.txt'), JSON.stringify(app.input.text));
check('主输入框：路径带引号（空格不丢）', app.input.text.includes('"') && app.input.text.includes(spaced), JSON.stringify(app.input.text));
let f = snap();
check('主输入框：提示说明了来源是复制文件', /文件/.test(f), f.split('\n').find((l) => /文件/.test(l)) || '');

// 截图走同一条路
for (let i = 0; i < 80; i++) key('\x7f');
await wait(40);
clearStubs();
process.env.AGENT_CLIPBOARD_IMAGE_STUB = shot;
await app.pasteFromClipboard();
await wait(80);
check('主输入框：截图粘贴得到图片路径', app.input.text.includes('clip shot.png'), JSON.stringify(app.input.text));

// 空剪贴板：输入不变成垃圾，给出警告而不是静默
for (let i = 0; i < 80; i++) key('\x7f');
await wait(40);
clearStubs();
process.env.AGENT_CLIPBOARD_STUB = '1';
process.env.AGENT_CLIPBOARD_IMAGE_STUB = '1';
await app.pasteFromClipboard();
await wait(80);
check('主输入框：空剪贴板不写入任何东西', app.input.text === '', JSON.stringify(app.input.text));
f = snap();
check('主输入框：空剪贴板有提示', /剪贴板是空的|粘贴失败/.test(f), f.split('\n').find((l) => /剪贴板/.test(l)) || '');

// ------------------------------------------------ 5. ask 弹层粘贴
clearStubs();
const askP = app.askPlayer({ question: '选哪个？', options: ['甲', '乙'] });
await wait(120);
check('ask 弹层打开', !!app.askState);

process.env.AGENT_CLIPBOARD_FILE_STUB = JSON.stringify([spaced]);
key('\x16');
await wait(250);
check('ask 弹层：复制文件粘进来是路径', (app.askState?.other || '').includes('a b.txt'), JSON.stringify(app.askState?.other));
check('ask 弹层：路径带引号', (app.askState?.other || '').includes('"'), JSON.stringify(app.askState?.other));

clearStubs();
process.env.AGENT_CLIPBOARD_IMAGE_STUB = shot;
app.askState.other = '';
app.askState.cur = 0;
key('\x16');
await wait(250);
check('ask 弹层：截图粘进来是路径', (app.askState?.other || '').includes('clip shot.png'), JSON.stringify(app.askState?.other));

clearStubs();
process.env.AGENT_CLIPBOARD_STUB = '普通回答';
app.askState.other = '';
app.askState.cur = 0;
key('\x16');
await wait(250);
check('ask 弹层：文本仍然是原文', app.askState?.other === '普通回答', JSON.stringify(app.askState?.other));

key('\x1b'); // ESC 跳过提问，收尾
await wait(120);
await askP.catch(() => {});

clearStubs();
log(failed ? `\n${failed} 项失败` : '\nALL CLIPANY CHECKS PASSED');
process.exit(failed ? 1 : 0);
