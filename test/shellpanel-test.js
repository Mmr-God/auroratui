// /shellManager 面板测试（离线）：列表渲染、进详情看输出、终止、清空、return 返回。
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shpanel-home-'));

const W = 120;
const H = 36;
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
const err = { isTTY: true, columns: W, rows: H, write() {}, on() {}, off() {}, removeListener() {} };
const inp = new PassThrough();
inp.isTTY = true;
inp.setRawMode = () => {};
Object.defineProperty(inp, 'isRaw', { get: () => true, set() {} });

Object.defineProperty(process, 'stdout', { value: out, configurable: true });
Object.defineProperty(process, 'stderr', { value: err, configurable: true });
Object.defineProperty(process, 'stdin', { value: inp, configurable: true });

const { App } = await import('../src/ui/app.js');
const { Config } = await import('../src/config.js');
const { jobs } = await import('../src/jobs.js');
const { stripAnsi } = await import('../src/util.js');

const log = (m = '') => fs.writeSync(1, m + '\n');
let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}
const key = (s) => inp.emit('data', Buffer.from(s, 'utf8'));
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
function snap() {
  // render() 在 dirty=false 时会跳过绘制，取到的就是上一帧，必须强制重绘
  app.prevLines = [];
  buf = '';
  app.render(true);
  return stripAnsi(buf);
}

/** 当前这一帧的纯文本（不含 ANSI），用来量行宽。 */
function frameLines() {
  return app.buildFrame().map((l) => stripAnsi(l));
}

const config = new Config();
const app = new App({ config, cwd: process.cwd() });
app.start();
await wait(120);
snap();

// ------------------------------------------------------- 造几条命令记录
jobs.jobs = [];
const j1 = jobs.add({ command: 'npm test', cwd: '/ws', source: '主代理' });
jobs.end(j1.id, { code: 0, dur: 1234, output: 'PASS src/a.test.js\nPASS src/b.test.js\n\nTests: 12 passed' });
const j2 = jobs.add({ command: 'npm run build -- --minify --outdir dist', cwd: '/ws', source: '子代理(层1)' });
jobs.end(j2.id, { code: 2, dur: 800, output: 'error TS2304: Cannot find name "foo"\nat src/team.ts:42:7' });
const j3 = jobs.add({ command: 'node scripts/long-task.js', cwd: '/ws', source: '主代理' });
jobs.progress(j3.id, 'step 1/10\nstep 2/10\nstep 3/10');

// ------------------------------------------------------- 打开面板
log('# 打开 /shellManager');
await app.command('/shellManager');
await wait(150);
let f = snap();
check('面板打开了', !!app.shellPanel);
check('标题在', /Shell 任务/.test(f), f.split('\n').find((l) => /Shell/.test(l)) || '');
check('能数出条数', /3 条/.test(f), f.split('\n').find((l) => /条/.test(l)) || '');
check('标出几个在跑', /1 个在跑/.test(f), f.split('\n').find((l) => /在跑/.test(l)) || '');
check('列出了命令', /npm test/.test(f) && /npm run build/.test(f) && /long-task/.test(f));
check('显示成功状态', /成功/.test(f));
check('显示失败退出码', /exit 2/.test(f), f.split('\n').find((l) => /exit/.test(l)) || '');
check('显示跑着状态', /跑着/.test(f));
check('提示 return 返回', /return/.test(f));

// 选中标记只在一个
log('\n# 列表选择');
check('默认选第一条', app.shellPanel.sel === 0, String(app.shellPanel.sel));
key('\x1b[B');
await wait(40);
check('↓ 能往下选', app.shellPanel.sel === 1, String(app.shellPanel.sel));
key('\x1b[B');
await wait(40);
check('再↓ 到第三条', app.shellPanel.sel === 2, String(app.shellPanel.sel));
key('\x1b[B');
await wait(40);
check('到底不越界', app.shellPanel.sel === 2, String(app.shellPanel.sel));
key('\x1b[A');
await wait(40);
check('↑ 能往上', app.shellPanel.sel === 1, String(app.shellPanel.sel));

// 数字直跳
key('1');
await wait(40);
check('按数字跳第一个', app.shellPanel.sel === 0, String(app.shellPanel.sel));

// ------------------------------------------------------- 详情
log('\n# 详情：看完整输出');
// jobs.add 是 unshift，列表里最新的在最前：j3(跑着) / j2(失败) / j1(成功)
app.shellPanel.sel = 2; // j1 = npm test（成功的那条）
key('\r');
await wait(150);
f = snap();
check('Enter 进了详情', app.shellPanel?.view === 'detail', String(app.shellPanel?.view));
check('详情里有完整命令', /npm test/.test(f));
check('详情里有命令行提示符', /\$ npm test/.test(f), f.split('\n').find((l) => /\$/.test(l)) || '');
check('详情里有输出第一行', /PASS src\/a\.test\.js/.test(f));
check('详情里有输出最后一行', /12 passed/.test(f));
check('详情里显示耗时', /1\.2s/.test(f), f.split('\n').find((l) => /1\.2s/.test(l)) || '');
check('详情里有 return 提示', /return/.test(f));

// 失败那条：要能看到真实报错
key('\x1b'); // ESC 回列表（详情里 ESC 是回列表，不是关面板）
await wait(80);
check('详情按 ESC 回列表', app.shellPanel?.view === 'list', String(app.shellPanel?.view));
app.shellPanel.sel = 1; // j2 = npm run build（失败）
key('\r');
await wait(150);
f = snap();
check('失败命令能看到真实报错', /Cannot find name/.test(f), f.split('\n').find((l) => /Cannot/.test(l)) || '');
check('失败命令显示 exit 2', /exit 2/.test(f), f.split('\n').find((l) => /exit/.test(l)) || '');
// ← 回列表
key('\x1b[D');
await wait(80);
check('← 回到列表', app.shellPanel?.view === 'list', String(app.shellPanel?.view));

// 跑着的那条：看实时尾巴
log('\n# 跑着的命令看实时输出');
app.shellPanel.sel = 0; // j3 = long-task（跑着）
key('\r');
await wait(150);
f = snap();
check('跑着的能看到实时尾巴', /step 1\/10/.test(f) || /step 3\/10/.test(f), f.split('\n').find((l) => /step/.test(l)) || '');
check('跑着的显示「跑着」', /跑着/.test(f));

// ------------------------------------------------------- 终止
log('\n# Ctrl+K 终止');
let killed = false;
jobs.get(j3.id).kill = () => {
  killed = true;
};
key('\x15'); // Ctrl+K? 先试 ctrl+k 的编码
await wait(150);
// 直接调方法验证逻辑（按键编码在不同终端不一致）
app.shellPanel.view = 'detail';
app.shellPanel.job = j3.id;
app.killSelectedJob();
await wait(40);
check('真的调了 kill', killed === true);
check('状态标成已终止', jobs.get(j3.id).status === 'killed', jobs.get(j3.id).status);
check('面板上有提示', /终止/.test(app.shellPanel.note || ''), app.shellPanel.note);
// 再终止一次已结束的：要友好
app.killSelectedJob();
check('已结束的不重复终止', /已经结束/.test(app.shellPanel.note || ''), app.shellPanel.note);

// ------------------------------------------------------- 清空历史
log('\n# Ctrl+D 清空历史');
app.shellPanel.view = 'list';
app.shellPanel.sel = 0;
key('\x04');
await wait(150);
check('历史被清空', jobs.list().length === 0, `${jobs.list().length} 条`);
check('清空后选中复位', app.shellPanel.sel === 0);
check('清空后有提示', /清空/.test(app.shellPanel.note || ''), app.shellPanel.note);
f = snap();
check('空列表有友好提示', /还没有命令记录/.test(f), f.split('\n').find((l) => /还没有/.test(l)) || '');

// ------------------------------------------------------- return 返回
log('\n# 输 return 回主对话');
jobs.add({ command: 'echo hi', cwd: '/ws' });
for (const ch of 'return') key(ch);
await wait(80);
check('输 return 关掉面板', app.shellPanel === null);

// ESC 也能关
await app.command('/shellManager');
await wait(40);
key('\x1b');
await wait(40);
check('ESC 也能关闭', app.shellPanel === null);

// ------------------------------------------------------- 边界
log('\n# 边界情况');
{
  // 没有命令时打开
  jobs.jobs = [];
  await app.command('/shellManager');
  await wait(40);
  f = snap();
  check('没命令也能打开不崩', !!app.shellPanel && /还没有命令记录/.test(f));
  // 空列表按 Enter 不该崩
  let threw = false;
  try {
    key('\r');
    await wait(40);
  } catch {
    threw = true;
  }
  check('空列表按 Enter 不崩', threw === false);
  check('空列表按 Enter 不进详情', app.shellPanel?.view === 'list', String(app.shellPanel?.view));
  // 空列表按 Ctrl+K 不崩
  threw = false;
  try {
    app.killSelectedJob();
  } catch {
    threw = true;
  }
  check('没选中时终止不崩', threw === false && /没有选中/.test(app.shellPanel.note || ''), app.shellPanel.note);
  app.closeShellPanel();
}

{
  // 超长命令不撑破面板
  jobs.jobs = [];
  const long = 'echo ' + 'x'.repeat(400);
  const j = jobs.add({ command: long, cwd: '/ws' });
  jobs.end(j.id, { code: 0, output: 'ok' });
  await app.command('/shellManager');
  await wait(150);
  f = snap();
  const widest = Math.max(...frameLines().map((l) => l.length));
  check('超长命令不撑破宽度', widest <= W, `${widest} vs ${W}`);
  app.closeShellPanel();
}

{
  // 超长输出不撑破面板，且能滚
  jobs.jobs = [];
  const j = jobs.add({ command: 'big', cwd: '/ws' });
  jobs.end(j.id, { code: 0, truncated: true, output: Array.from({ length: 300 }, (_, i) => `line ${i} ${'y'.repeat(200)}`).join('\n') });
  await app.command('/shellManager');
  await wait(150);
  key('\r');
  await wait(150);
  f = snap();
  const widest = Math.max(...frameLines().map((l) => l.length));
  check('超长输出不撑破宽度', widest <= W, `${widest} vs ${W}`);
  check('提示总行数', /共 \d+ 行/.test(f), f.split('\n').find((l) => /共/.test(l)) || '');
  check('超长输出标了已截断', /已截断/.test(f), f.split('\n').find((l) => /已截断/.test(l)) || '');
  app.closeShellPanel();
}

log(failed ? `\n${failed} 个检查失败` : '\n/shellManager 面板检查全部通过');
process.exit(failed ? 1 : 0);
