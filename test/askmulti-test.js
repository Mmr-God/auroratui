// ask 多选测试：AI 用 multi:true 提问时，玩家必须真的能多选。
//  1) 回车不再直接发送，而是勾选/取消光标所在的项
//  2) 空格 / 数字 / 鼠标左键都能勾选
//  3) 走到最后一行「完成」回车才提交，交回全部勾选项
//  4) 一项没勾就提交 → 不关弹层，给提示
//  5) 单选模式：回车/点击仍然是选定即提交（回归）
//  6) 滚轮 = 上下挪高亮，右键仍然是粘贴
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-askmulti-'));
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
const frame = () => stripAnsi(app.lastFrameRaw.join(NL));
const mouse = (btn, x, y, release = false) => key(`\x1b[<${btn};${x};${y}${release ? 'm' : 'M'}`);
const redraw = async () => {
  app.render(true);
  await wait(30);
};

// 起一个提问弹层，顺手把 resolve 结果存下来
function openAsk(opts = {}) {
  const got = { value: undefined };
  const p = app.askPlayer({ question: '要改哪些文件？', options: ['甲', '乙', '丙'], ...opts });
  got.promise = p;
  p.then((v) => {
    got.value = v;
  });
  app.render(true);
  return got;
}

app.start();
await wait(150);

// ---------------------------------------- 1) 多选：回车 = 勾选，不是发送
{
  const got = openAsk({ multi: true });
  await wait(20);
  key('\r'); // Enter
  await wait(60);
  check('多选：回车不关闭弹层', !!app.askState);
  check('多选：回车勾选了光标所在项', app.askState?.picked.has(0) === true, JSON.stringify([...(app.askState?.picked || [])]));
  check('多选：回车还保持窗口打开（没用 resolve）', got.value === undefined);

  // ↓ 再回车 → 勾第二项
  key('\x1b[B\r');
  await wait(60);
  check('多选：↓ + 回车 勾第二项', app.askState?.picked.has(1) === true, JSON.stringify([...(app.askState?.picked || [])]));
  check('多选：这时已勾两项', app.askState?.picked.size === 2, String(app.askState?.picked.size));

  // 再回车一次 = 取消勾选（同一个键来回切）
  key('\r');
  await wait(60);
  check('多选：再回车取消勾选', app.askState?.picked.has(1) === false, JSON.stringify([...(app.askState?.picked || [])]));

  // 空格 + 数字 也都能勾
  key(' ');
  await wait(40);
  key('3');
  await wait(40);
  check('多选：空格/数字勾选', app.askState?.picked.has(1) && app.askState?.picked.has(2), JSON.stringify([...(app.askState?.picked || [])]));

  // ---------------------------------------- 2) 鼠标左键点击选项
  await redraw();
  const hits = app.askHits;
  check('多选：渲染后记下了选项行位置', Array.isArray(hits?.rows) && hits.rows.length === 3, JSON.stringify(hits?.rows));
  const rowOf2 = hits.rows.find((r) => r.idx === 2);
  mouse(0, 10, rowOf2.from); // 点第三项
  await wait(80);
  check('多选：鼠标点击取消第三项', app.askState?.picked.has(2) === false, JSON.stringify([...(app.askState?.picked || [])]));
  check('多选：鼠标点击把高亮也挪过去', app.askState?.sel === 2, String(app.askState?.sel));

  await redraw();
  const rowOf0 = app.askHits.rows.find((r) => r.idx === 0);
  mouse(0, 10, rowOf0.from); // 再点第一项 → 第二次点击应该是「取消」
  await wait(80);
  check('多选：鼠标点击是勾选开关', app.askState?.picked.has(0) === false, JSON.stringify([...(app.askState?.picked || [])]));

  // ---------------------------------------- 3) 滚轮
  await redraw();
  const selBefore = app.askState.sel;
  mouse(64, 10, 5); // wheel-up
  await wait(60);
  check('多选：滚轮上移高亮', app.askState?.sel === (selBefore - 1 + 4) % 4, `${selBefore} → ${app.askState?.sel}`);
  mouse(65, 10, 5); // wheel-down
  await wait(60);
  check('多选：滚轮下移高亮', app.askState?.sel === selBefore, String(app.askState?.sel));

  // ---------------------------------------- 4) 一项没勾就「完成」→ 留在弹层
  app.askState.picked.clear();
  app.askState.sel = app.askState.options.length; // 走到「完成」行
  app.dirty = true;
  await redraw();
  check('多选：有「完成」行可点', Number.isFinite(app.askHits?.confirm), String(app.askHits?.confirm));
  key('\r');
  await wait(60);
  await redraw();
  check('多选：没勾选时提交不关窗', !!app.askState && got.value === undefined);
  check('多选：给出「先勾选」的提示', /勾选/.test(frame()), '');
  key(' '); // 停在「完成」行上按空格不该勾出第 4 项
  await wait(40);
  check('多选：完成行按空格不会勾出幽灵项', app.askState?.picked.size === 0, JSON.stringify([...(app.askState?.picked || [])]));

  // 勾两项后点「完成」行提交
  key('\x1b[A'); // 回到第三项
  await wait(40);
  key(' '); // 勾第三项
  await wait(40);
  await redraw();
  check('多选：勾选后「完成」行重新定位', Number.isFinite(app.askHits?.confirm), String(app.askHits?.confirm));
  mouse(0, 10, app.askHits.confirm); // 点「完成」
  await wait(150);
  check('多选：点「完成」提交并关闭弹层', !app.askState, JSON.stringify({ ...(app.askState || {}) }));
  check('多选：交回的 selections 是全部勾选项', JSON.stringify(got.value?.selections) === JSON.stringify(['丙']), JSON.stringify(got.value));
}

// ---------------------------------------- 5) 单选回归：回车 / 点击直接选定
{
  const got = openAsk();
  await wait(20);
  key('\x1b[B'); // ↓
  await wait(40);
  key('\r');
  await wait(60);
  check('单选：回车提交高亮项', got.value?.answer === '乙', JSON.stringify(got.value));

  const got2 = openAsk();
  await wait(20);
  await redraw();
  mouse(0, 10, app.askHits.rows.find((r) => r.idx === 2).from);
  await wait(80);
  check('单选：鼠标点击直接选定', got2.value?.answer === '丙', JSON.stringify(got2.value));
  check('单选：点击后弹层关闭', !app.askState);
}

// ---------------------------------------- 6) 右键仍然是粘贴（不勾选）
{
  process.env.AGENT_CLIPBOARD_STUB = '右键粘进来的';
  openAsk({ multi: true });
  await wait(20);
  await redraw();
  const before = [...app.askState.picked];
  mouse(2, 10, app.askHits.rows[0].from); // 右键
  await wait(200);
  check('多选：右键不勾选', JSON.stringify([...app.askState.picked]) === JSON.stringify(before));
  check('多选：右键照旧粘贴', app.askState?.other === '右键粘进来的', JSON.stringify(app.askState?.other));
  // 手打答案 + 回车 = 直接提交回答（不受多选影响）
  key('\r');
  await wait(60);
  check('多选：手打答案后回车直接提交', !app.askState);
}

log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
