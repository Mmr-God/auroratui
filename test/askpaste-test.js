// ask 弹层粘贴测试：AI 用 ask 提问时，玩家在自定义输入里也要能粘贴。也测光标编辑。
//  1) Ctrl+V / Ctrl+Shift+V 走系统剪贴板（文本）
//  2) bracketed paste（终端自己的 Ctrl+Shift+V / 右键菜单）用 ev.text，不重复去读剪贴板
//  3) 剪贴板里是截图 → 存成临时 PNG，把路径填进答案（模型能 read 看图）
//  4) 右键 = 粘贴（按下贴、抬起不重复贴）
//  5) 换行压成空格（弹层里的自定义输入是单行）
//  6) 粘贴之后能在光标处插入 / backspace / Ctrl+U / Ctrl+E / ←→ 移动
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-askpaste-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');
const { App } = await import('../src/ui/app.js');
const { stripAnsi } = await import('../src/util.js');

const W = 100;
const H = 30;
let buf = '';
const mkStream = () => ({
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
});
const inp = new PassThrough();
inp.isTTY = true;
inp.setRawMode = () => {};
Object.defineProperty(inp, 'isRaw', { get: () => true, set() {} });
Object.defineProperty(process, 'stdout', { value: mkStream(), configurable: true });
Object.defineProperty(process, 'stderr', { value: mkStream(), configurable: true });
Object.defineProperty(process, 'stdin', { value: inp, configurable: true });

const NL = String.fromCharCode(10);
let failed = 0;
const log = (m = '') => fs.writeSync(1, m + NL);
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}

const config = new Config();
const app = new App({ config, cwd: HOME });
app.width = W;
app.height = H;

const key = (s) => inp.emit('data', Buffer.from(s, 'utf8'));
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const screen = () => stripAnsi(app.lastFrameRaw.join(NL));
const resetOther = () => {
  app.askState.other = '';
  app.askState.cur = 0;
};

app.start();
await wait(150);

// 起一个提问弹层
function openAsk(opts = {}) {
  app.askState = null;
  const p = app.askPlayer({ question: '选哪个？', options: ['甲', '乙'], ...opts });
  return p;
}

// ---------------------------------------------------------------- 1) Ctrl+V
process.env.AGENT_CLIPBOARD_STUB = '剪贴板里的文本';
process.env.AGENT_CLIPBOARD_IMAGE_STUB = '1';
openAsk();
await wait(50);
check('ask 弹层打开', !!app.askState);
key('\x16'); // Ctrl+V
await wait(200);
check('Ctrl+V 把剪贴板文本填进自定义输入', app.askState?.other === '剪贴板里的文本', JSON.stringify(app.askState?.other));

// 再按一次：追加而不是覆盖
key('\x16');
await wait(200);
check('再 Ctrl+V 是追加', app.askState?.other === '剪贴板里的文本剪贴板里的文本', JSON.stringify(app.askState?.other));

// ------------------------------------- 1b) 粘贴之后能在光标处继续编辑
key('\x1b[D\x1b[D'); // ←←（从末尾回退 2 个字）
await wait(80);
check('← 移动光标', app.askCursor() === 12, String(app.askCursor()));
process.env.AGENT_CLIPBOARD_STUB = '【插入】';
key('\x16');
await wait(250);
check(
  '粘贴插在光标处（不是只会追加到末尾）',
  app.askState?.other === '剪贴板里的文本剪贴板里的【插入】文本',
  JSON.stringify(app.askState?.other)
);
check('光标停在插入内容之后', app.askCursor() === 16, String(app.askCursor()));
key('\x7f'); // backspace
await wait(80);
check('backspace 删光标前一个字', app.askState?.other === '剪贴板里的文本剪贴板里的【插入文本', JSON.stringify(app.askState?.other));
key('\x15'); // Ctrl+U
await wait(80);
check('Ctrl+U 清空光标前的内容', app.askState?.other === '文本', JSON.stringify(app.askState?.other));
check('Ctrl+U 后光标回到 0', app.askCursor() === 0, String(app.askCursor()));
key('\x05'); // Ctrl+E
await wait(60);
check('Ctrl+E 光标到末尾', app.askCursor() === (app.askState?.other.length || 0), String(app.askCursor()));
app.dirty = true;
app.render(true);
await wait(60);
check('输入行画出光标（有反白段）', /\x1b\[7m/.test(app.lastFrameRaw.join('')), '反白');

// ------------------------------------------------- 2) bracketed paste 用 ev.text
process.env.AGENT_CLIPBOARD_STUB = 'XXX不该被读到';
key('\x1b[200~终端粘贴\n第二行\t制表\x1b[201~');
await wait(200);
check(
  'bracketed paste 用 ev.text（换行/制表压成空格）',
  app.askState?.other.endsWith('终端粘贴 第二行  制表'),
  JSON.stringify(app.askState?.other)
);
check('bracketed paste 不再去读剪贴板（没有重复 XXX）', !app.askState?.other.includes('XXX'), JSON.stringify(app.askState?.other));

// 多行粘贴压成一行，不会把界面顶乱
process.env.AGENT_CLIPBOARD_STUB = '第一行|第二行|第三行';
resetOther();
key('\x16');
await wait(200);
check('多行/带换行的粘贴压成单行', app.askState?.other === '第一行|第二行|第三行', JSON.stringify(app.askState?.other));

// ------------------------------------------------------ 3) 剪贴板是截图
process.env.AGENT_CLIPBOARD_STUB = '1'; // 没有文本
const shot = path.join(HOME, 'clip shot 截图.png');
process.env.AGENT_CLIPBOARD_IMAGE_STUB = shot;
resetOther();
key('\x16');
await wait(300);
check('图片剪贴板填的是图片路径', /clip shot 截图\.png/.test(app.askState?.other || ''), JSON.stringify(app.askState?.other));
check('带空格的路径加了引号', (app.askState?.other || '').trim().startsWith('"'), JSON.stringify(app.askState?.other));
check('界面提示这是图片', /图片/.test(screen()), screen().split(NL).find((l) => /图片/.test(l)) || '');

// ------------------------------------------------------------ 4) 右键粘贴
process.env.AGENT_CLIPBOARD_STUB = '右键内容';
process.env.AGENT_CLIPBOARD_IMAGE_STUB = '1';
resetOther();
key('\x1b[<2;10;10M'); // 右键按下
await wait(250);
check('右键也能粘贴', app.askState?.other === '右键内容', JSON.stringify(app.askState?.other));
key('\x1b[<0;10;10m'); // 右键抬起
await wait(250);
check('右键抬起不会重复粘贴', app.askState?.other === '右键内容', JSON.stringify(app.askState?.other));

// ----------------------------------------------------- 5) 空剪贴板不炸
process.env.AGENT_CLIPBOARD_STUB = '1';
process.env.AGENT_CLIPBOARD_IMAGE_STUB = '1';
resetOther();
key('\x16');
await wait(250);
check('空剪贴板：输入不变且给出提示', app.askState?.other === '' && /没有文本可粘贴|剪贴板是空的/.test(screen()), screen().split(NL).find((l) => /粘贴/.test(l)) || '');

// ------------------------------------------------- 6) 粘贴的内容能被提交
process.env.AGENT_CLIPBOARD_STUB = '就用这个答案';
resetOther();
key('\x16');
await wait(250);
const before = app.items.length;
key('\r');
await wait(200);
check('回车把粘贴的答案提交出去', app.askState === null && app.items.length > before, `items ${before} → ${app.items.length}`);

// ------------------------------------------ 7) 其它弹层（picker/prompt）不受影响
openAsk();
await wait(30);
key('\x1b'); // ESC 跳过
await wait(80);
check('ESC 仍能跳过提问', app.askState === null);

fs.writeSync(1, failed ? `\n${failed} 项失败\n` : '\nALL ASKPASTE CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
