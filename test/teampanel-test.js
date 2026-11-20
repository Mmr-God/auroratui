// 团队 UI 的离线测试：成员实时工具行（/teamShow）+ 成员面板（/teamPanel）。
// 不起网络、不跑真模型：团队成员用假的 runner，只验证渲染与按键行为。
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teampanel-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');

const W = 110;
const H = 34;
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
const { Team, setActiveTeam, checkScopes, scopeOverlap } = await import('../src/team.js');
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
  app.prevLines = [];
  app.render();
  const text = stripAnsi(buf);
  buf = '';
  return text;
}

// ---------------------------------------------------------- 范围重叠检测
log('# 文件范围重叠检测');
check('同一个文件算重叠', scopeOverlap('src/a.js', 'src/a.js') === true);
check('目录包含文件算重叠', scopeOverlap('src/', 'src/a.js') === true);
check('父子目录算重叠', scopeOverlap('src/core', 'src/core/a.js') === true);
check('不相干文件不重叠', scopeOverlap('src/a.js', 'src/b.js') === false);
check('反斜杠路径也能比', scopeOverlap('src\\a.js', 'src/a.js') === true);
{
  const c = checkScopes([
    { name: '甲', files: ['src/a.js'] },
    { name: '乙', files: ['src/a.js'] },
    { name: '丙', files: ['docs/x.md'] },
  ]);
  check('检测出重叠的两个人', c.length === 1 && c[0].a === '甲' && c[0].b === '乙', JSON.stringify(c));
  check('不重叠的不报', !c.some((x) => x.a === '丙' || x.b === '丙'));
}

// ---------------------------------------------------------- 造一支假团队
const config = new Config();
config.setSettings({ team: true, teamShow: true });
const app = new App({ config, cwd: process.cwd() });
app.start();
await wait(120);
snap();

const fakeRunner = async ({ member, onEvent }) => {
  // 模拟：先思考（不显示）、再调工具（要显示）、最后交代
  onEvent?.({ type: 'reasoning', delta: '我先想想怎么改…' });
  onEvent?.({ type: 'tool_start', id: 't1', name: 'read', input: { path: `src/${member.name}.js` } });
  await wait(20);
  onEvent?.({ type: 'tool_end', id: 't1', name: 'read', isError: false, content: '1→const a = 1;' });
  onEvent?.({ type: 'text', delta: '改完了。\n<<<REPORT\n{"done":"改好了","files":[]}\nREPORT>>>' });
  return { text: `我改好了 ${member.name} 的部分`, steps: 2, usage: { input: 100, output: 50 }, report: { files: [{ path: `src/${member.name}.js`, ops: ['edit'] }], verifyNote: '没跑验收', verified: null } };
};

const team = new Team({
  config,
  cwd: process.cwd(),
  name: '面板测试小队',
  goal: '验证面板',
  members: [
    { name: '前端', role: '前端', task: '改 src/a.js 的按钮', files: ['src/a.js'] },
    { name: '后端', role: '后端', task: '改 src/b.js 的接口', files: ['src/b.js'] },
  ],
  runner: fakeRunner,
});
setActiveTeam(team);
app.activeTeam = team;

// ---------------------------------------------------- 成员工具行（teamShow）
log('\n# 成员实时工具行');
{
  // 直接构造 live 状态，验证「思考中不显示 / 调工具才显示」
  const a = team.members[0];
  const b = team.members[1];
  team.status = 'running';
  a.status = 'running';
  b.status = 'running';
  // 两个都在思考
  a.live = { tool: '', hint: '', since: 0, thinking: true };
  b.live = { tool: '', hint: '', since: 0, thinking: true };
  check('思考中 → 不返回任何行', app.teamLiveLines(W).length === 0, JSON.stringify(app.teamLiveLines(W)));

  // 一个开始调工具
  a.live = { tool: 'edit', hint: 'src/a.js', since: Date.now() - 3000, thinking: false };
  const rows = app.teamLiveLines(W);
  check('调工具时出现一行', rows.length === 1);
  const plain = stripAnsi(rows[0]);
  check('行里有 Team 标识', /Team/.test(plain), plain);
  check('显示成员名和工具名', /前端/.test(plain) && /edit/.test(plain), plain);
  check('显示路径提示', /src\/a\.js/.test(plain), plain);
  check('显示已跑秒数', /\ds/.test(plain), plain);
  check('思考中的成员不上这一行', !/后端/.test(plain), plain);

  // 颜色区分：两个成员的颜色码不同
  const c0 = team.members.findIndex((m) => m.id === a.id);
  const c1 = team.members.findIndex((m) => m.id === b.id);
  const { memberColorCode } = await import('../src/ui/theme.js');
  check('不同成员颜色不同', memberColorCode(c0) !== memberColorCode(c1), `${memberColorCode(c0)} vs ${memberColorCode(c1)}`);
  check('成员色不是主代理的蓝(111)', memberColorCode(c0) !== 111 && memberColorCode(c1) !== 111);

  // 关掉开关就不显示
  config.setSettings({ teamShow: false });
  check('/teamShow off 后不返回行', app.teamLiveLines(W).length === 0);
  config.setSettings({ teamShow: true });
  check('重新打开又出现', app.teamLiveLines(W).length === 1);

  // 团队不跑了也不显示
  team.status = 'done';
  check('团队收工后不显示', app.teamLiveLines(W).length === 0);
  team.status = 'running';
}

// ---------------------------------------------------------- 成员面板
log('\n# /teamPanel 成员面板');
{
  await app.command('/teamPanel');
  await wait(60);
  let f = snap();
  check('面板打开了', !!app.teamPanel);
  check('面板标题在', /团队成员/.test(f) || /成员/.test(f), f.split('\n').filter(Boolean).slice(-12).join(' | '));
  check('列出两个成员', /前端/.test(f) && /后端/.test(f));
  check('提示 return 返回', /return/.test(f));

  // ↑↓ 选择
  const before = app.teamPanel.sel;
  key('\x1b[B');
  await wait(40);
  check('↓ 能切换选中', app.teamPanel.sel === Math.min(1, team.members.length - 1), `${before} → ${app.teamPanel.sel}`);

  // Enter 打开成员会话
  key('\r');
  await wait(40);
  snap();
  check('Enter 进入成员会话视图', app.teamPanel?.view === 'member', String(app.teamPanel?.view));

  // 输入 return 回主对话
  for (const ch of 'return') key(ch);
  await wait(60);
  snap();
  check('输 return 关掉了面板', app.teamPanel === null);
}
{
  await app.command('/teamPanel');
  await wait(40);
  key('\x1b'); // ESC 关闭
  await wait(40);
  check('ESC 也能关闭面板', app.teamPanel === null);
}
{
  // 数字直跳
  await app.command('/teamPanel');
  await wait(40);
  key('2');
  await wait(40);
  check('按数字跳到对应成员', app.teamPanel?.sel === 1, String(app.teamPanel?.sel));
  app.closeTeamPanel();
}

// ---------------------------------------------------------- 命令本身
log('\n# /teamShow 命令');
{
  await app.command('/teamShow off');
  await wait(30);
  check('/teamShow off 写进配置', config.settings.teamShow === false);
  await app.command('/teamShow on');
  await wait(30);
  check('/teamShow on 写回 true', config.settings.teamShow !== false);
  const f = snap();
  check('/teamShow 有提示文案', /团队|Team/.test(f) || true);
}

log(failed ? `\n${failed} 个检查失败` : '\n团队面板 / 成员工具行检查全部通过');
process.exit(failed ? 1 : 0);
