// 子代理 / 团队协作的离线测试：不打网络。
// 团队用注入的假 runner 跑（真 runner 要调模型）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');
const { enabledTools, runTool } = await import('../src/tools/index.js');
const { teamTool } = await import('../src/tools/team.js');
const { Team, teamDir, setActiveTeam, getActiveTeam } = await import('../src/team.js');
const { describeTool } = await import('../src/ui/toolview.js');
const { scopedConfig } = await import('../src/subagent.js');
const { Agent } = await import('../src/agent.js');

let failed = 0;
// 直接写 fd 1：后面会把 process.stdout 换成假 TTY 驱动 App，那时 write 就没了
const log = (m = '') => fs.writeSync(1, m + '\n');
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-ws-'));

// 循环引用回归：每个模块单独冷启动 import 一次（tools/index ↔ src/subagent 这类链
// 以前就撞过 TDZ，单进程内有缓存，测不出来，必须开子进程）。
function coldImport(rel) {
  const url = new URL(`../src/${rel}`, import.meta.url).href;
  const code = `import(${JSON.stringify(url)}).then(() => process.exit(0), (e) => { console.error(e && e.message); process.exit(1); })`;
  try {
    execFileSync(process.execPath, ['-e', code], { stdio: 'pipe', env: { ...process.env, AGENT_HOME: HOME }, timeout: 30000 });
    return true;
  } catch (e) {
    return String(e.stderr || e.message).trim().split('\n')[0].slice(0, 160) || 'failed';
  }
}
for (const rel of ['team.js', 'subagent.js', 'transcript.js', 'tools/team.js', 'tools/subagent.js', 'tools/index.js']) {
  const r = coldImport(rel);
  check(`单独 import src/${rel} 不炸`, r === true, r === true ? '' : r);
}

const config = new Config();
config.setSettings({ subagents: false, team: false });

// ------------------------------------------------------------- 开关与工具清单
const names = (list) => list.map((t) => t.name);
check('默认不下发 subagent / team', !names(enabledTools(config)).includes('subagent') && !names(enabledTools(config)).includes('team'));
config.setSettings({ subagents: true, team: true });
check('开启后才下发 subagent / team', names(enabledTools(config)).includes('subagent') && names(enabledTools(config)).includes('team'));

check('配置开关能读写', (() => {
  const c = new Config();
  c.setSubagents(true);
  c.setTeamEnabled(true);
  const ok = c.subagentsEnabled && c.teamEnabled;
  c.setSubagents(false);
  c.setTeamEnabled(false);
  return ok && !c.subagentsEnabled && !c.teamEnabled;
})());

config.setSettings({ subagents: false, team: false });
const off1 = await runTool({ id: 't1', name: 'subagent', input: { task: '改个 bug' } }, { config, cwd: WS });
check('关闭时 subagent 工具拒绝执行', off1.isError && /未开启/.test(off1.content));
const off2 = await runTool({ id: 't2', name: 'team', input: { action: 'create', goal: 'g', members: [{ task: 't' }] } }, { config, cwd: WS });
check('关闭时 team 工具拒绝执行', off2.isError && /未开启/.test(off2.content));

// ------------------------------------------------------------ 系统提示 / 权限
const agent = new Agent({ config, cwd: WS });
check('主代理工具清单不含 subagent', !names(agent.toolList()).includes('subagent'));
check('提示里说明未开启', /当前未开启/.test(agent.systemPrompt()));
config.setSettings({ subagents: true, team: true });
const agent2 = new Agent({ config, cwd: WS });
const sys = agent2.systemPrompt();
check('开启后提示包含 subagent 用法', /`subagent`/.test(sys) && /`team`/.test(sys));
check('开启后工具清单含 subagent', names(agent2.toolList()).includes('subagent'));
const blocked = await runTool({ id: 't3', name: 'write', input: { path: 'x.txt', content: 'x' } }, { config, cwd: WS, allowedTools: new Set(['read']) });
check('越权工具被拦', blocked.isError && /权限范围/.test(blocked.content));

// 子代理配置视图不改主配置
const scoped = scopedConfig(config, { model: 'cheap-model', settings: { maxSteps: 5 } });
check('scopedConfig 不改主配置', config.active.model !== 'cheap-model' && scoped.active.model === 'cheap-model' && scoped.settings.maxSteps === 5);

// ----------------------------------------------------------------- 团队（假跑）
const said = [];
const members = [
  { name: '前端', role: 'UI', task: '改 a.js 的按钮', files: ['a.js'] },
  { name: '后端', role: 'API', task: '改 b.js 的接口', files: ['b.js'] },
  { name: '测试', role: 'QA', task: '给 a.js b.js 补测试', files: ['test/'] },
];
let peak = 0;
const live = new Set();
const fakeRunner = async ({ member, onEvent, onAgent }) => {
  onAgent?.({ queue: (s) => said.push(`${member.name}:${s}`) });
  live.add(member.name);
  peak = Math.max(peak, live.size);
  for (let s = 1; s <= 3; s++) {
    onEvent({ type: 'step', step: s });
    onEvent({ type: 'tool_start', name: 'read', input: { path: `${member.name}.js` } });
    await wait(5);
  }
  live.delete(member.name);
  return { text: `${member.name} 完成：${member.task}`, usage: { input: 100, output: 50, cacheRead: 10, cost: 0.002 }, steps: 3 };
};

const team = new Team({ config, cwd: WS, name: '测试小队', goal: '把 a.js/b.js 的接口对齐', members, concurrency: 2, runner: fakeRunner });
setActiveTeam(team);
await team.start();
check('开跑后状态是 running', team.status === 'running' && team.members.some((m) => m.status !== 'pending'));
const how = await team.waitAll(5000);
check('全员跑完', how === 'done' && team.status === 'done');
check('并发受 concurrency 限制', peak <= 2, `peak=${peak}`);
check('每个成员都有交代', team.members.every((m) => /完成/.test(m.output)), team.members.map((m) => m.output.slice(0, 12)).join(' | '));
const tot = team.totals();
check('统计聚合正确', tot.done === 3 && tot.members === 3 && tot.tokens === 450, JSON.stringify(tot));
check('步数与工具次数记录了', team.members.every((m) => m.steps === 3 && m.toolCalls === 3));
const rep = team.report();
check('报告含所有成员', members.every((m) => rep.includes(m.name)) && rep.includes('把 a.js/b.js 的接口对齐'));
const persisted = JSON.parse(fs.readFileSync(path.join(teamDir(WS), 'latest.json'), 'utf8'));
check('快照落盘', persisted.name === '测试小队' && persisted.members.length === 3 && persisted.totals.done === 3);
const doneSay = team.say('前端', '再补一个断言');
check('已完成的成员不能传话', doneSay.ok === false && /没法插话/.test(doneSay.content));

// 运行中传话 + 停止
const slow = new Team({
  config,
  cwd: WS,
  name: '慢队',
  goal: '慢活',
  members: [{ name: '慢手', role: 'dev', task: '慢慢改 c.js' }],
  concurrency: 1,
  runner: async ({ member, onAgent }) => {
    onAgent?.({ queue: (s) => said.push(`${member.name}:${s}`) });
    await wait(200);
    return { text: '慢慢做完了', usage: { input: 1, output: 1, cost: 0 }, steps: 1 };
  },
});
await slow.start();
await wait(40);
const sayRes = slow.say('慢手', '注意别动 public/');
check('运行中的成员能收到传话', sayRes.ok === true && said.includes('慢手:注意别动 public/'));
check('停止团队', slow.stop() === true && slow.status === 'stopped');
await wait(250);
check('停止后不再标 done', slow.status === 'stopped', slow.status);

// ------------------------------------------------------------ team 工具的读取面
setActiveTeam(team);
const cfgOn = config;
cfgOn.setSettings({ team: true, subagents: true });
const ctx = { config: cfgOn, cwd: WS, emit: () => {} };
const toolReport = await teamTool.execute({ action: 'report' }, ctx);
check('team report 返回报告', /前端/.test(toolReport.content) && /后端/.test(toolReport.content));
const toolStatus = await teamTool.execute({ action: 'status' }, ctx);
check('team status 报进度', /3\/3 完成/.test(toolStatus.content));
const badAction = await teamTool.execute({ action: 'nonsense' }, ctx);
check('未知 action 报错', badAction.isError && /不认识/.test(badAction.content));
const noMembers = await teamTool.execute({ action: 'create', goal: 'g' }, ctx);
check('缺成员时报错', noMembers.isError && /members/.test(noMembers.content));
const noGoal = await teamTool.execute({ action: 'create', members: [{ task: 'x' }] }, ctx);
check('缺目标时报错', noGoal.isError && /goal/.test(noGoal.content));

// ------------------------------------------------------ 团队简报 / 共享板 / ctx
{
  // 搭建一个带项目记忆与待办的假工作区
  const BWS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-brief-'));
  fs.mkdirSync(path.join(BWS, 'src'), { recursive: true });
  fs.mkdirSync(path.join(BWS, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(BWS, 'MEMORY.md'), '# 项目约定\n- 构建用 npm run build');
  fs.writeFileSync(path.join(BWS, 'src', 'main.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(BWS, 'node_modules', 'noise.js'), 'x');
  const { ContextEngine } = await import('../src/context/engine.js');
  const eng = new ContextEngine({});
  eng.addUser('把 main.js 的主流程接到新接口上');
  eng.addAssistant({ content: '我已经查到：src/main.js 里导出常量 a，没有 main() 函数；构建命令是 npm run build，入口在 package.json 的 bin 字段。' });
  const briefCtx = { config: cfgOn, cwd: BWS, emit: () => {}, engine: eng };
  const bres = await teamTool.execute(
    {
      action: 'create',
      name: '简报队',
      goal: '接接口',
      briefing: '关键事实：src/main.js:1 只有常量 a，没有入口函数',
      members: [{ name: '甲', task: '改 main.js' }],
      concurrency: 1,
    },
    briefCtx,
  );
  const bt = getActiveTeam();
  check('create 返回里提示不要 wait 干等', /不要 team\/wait 干等/.test(bres.content), bres.content.slice(0, 80));
  check('团队带上了简报', bt.briefing.includes('src/main.js:1') && bt.briefing.includes('npm run build'), `${bt.briefing.length} 字符`);
  check('简报含项目结构且跳过 node_modules', /src\/main\.js|main\.js/.test(bt.briefing) && !/noise\.js/.test(bt.briefing));
  check('简报含主代理已说过的结论', /导出常量 a|没有 main\(\)/.test(bt.briefing), '(从上下文继承)');
  bt.stop();
}

{
  // 共享板：先完工的成员结论会进 board，后启动的成员（和正在跑的成员）都能拿到
  const seen = [];
  const bt2 = new Team({
    config,
    cwd: WS,
    name: '共享板队',
    goal: 'g',
    briefing: '已知：接口在 api.js',
    members: [
      { name: '甲', role: 'dev', task: 'a' },
      { name: '乙', role: 'dev', task: 'b' },
    ],
    concurrency: 1,
    runner: async ({ member, briefing, board, onAgent }) => {
      const queued = [];
      onAgent?.({ queue: (s) => queued.push(s) });
      seen.push({ name: member.name, briefing, board: [...(board || [])] });
      await wait(60);
      // 模拟成员跑着时收到别的成员的结论
      member._queuedSeen = queued.slice();
      return { text: `${member.name} 完成了：把 api.js 的 export 改成了 default`, usage: {}, steps: 2 };
    },
  });
  await bt2.start();
  await bt2.waitAll(4000);
  const jia = seen.find((s) => s.name === '甲');
  const yi = seen.find((s) => s.name === '乙');
  check('成员拿到团队简报', jia?.briefing === '已知：接口在 api.js' && yi?.briefing === '已知：接口在 api.js');
  check('第一个成员开始时共享板是空的', jia?.board.length === 0);
  check('后启动的成员看到前面成员的结论', yi?.board.some((l) => /甲/.test(l) && /api\.js/.test(l)), JSON.stringify(yi?.board));
  check('共享板排除了自己的结论', !yi?.board.some((l) => /乙/.test(l)));
  check('共享板累计 2 条结论且对外可读', bt2.board.length === 2 && bt2.board.every((b) => typeof b.text === 'string'));
}

{
  // 上下文占用：usage 事件里的 ctx 要塞进成员快照（面板 & 工具都能读到）
  const bt3 = new Team({
    config,
    cwd: WS,
    name: 'ctx 队',
    goal: 'g',
    members: [{ name: '甲', task: 'a' }],
    concurrency: 1,
    runner: async ({ onEvent }) => {
      onEvent({ type: 'usage', total: { input: 10, output: 5, cost: 0 }, context: { tokens: 64000, maxTokens: 128000, used: 0.5, messages: 12, blocks: 1 } });
      onEvent({ type: 'compact_end', block: 'b1', topic: '读代码' });
      return { text: 'ok', usage: {}, steps: 1 };
    },
  });
  await bt3.start();
  await bt3.waitAll(4000);
  const sm = bt3.snapshot({ events: false }).members[0];
  check('成员快照带上下文占用', sm.ctx?.tokens === 64000 && sm.ctx?.maxTokens === 128000 && Math.round(sm.ctx.used * 100) === 50, JSON.stringify(sm.ctx));
  check('成员快照记录压缩次数', sm.compactions === 1, String(sm.compactions));
}

{
  // 子代理默认工具集：要包含 skill / context 与插件工具，但永远不给 team/subagent/plugin/ask
  const { resolveToolSet, rolePrompt } = await import('../src/subagent.js');
  const { getTool } = await import('../src/tools/index.js');
  const { pluginTools, autoloadPlugins } = await import('../src/tools/plugin.js');
  try {
    await autoloadPlugins();
  } catch {}
  const extras = pluginTools().map((p) => p.name);
  const set = resolveToolSet(null, getTool, { extra: extras }).map((t) => t.name);
  check('子代理默认能用 skill / context', set.includes('skill') && set.includes('context'), set.join(','));
  check('子代理默认拿到插件工具', extras.every((n) => set.includes(n)), `插件: ${extras.join(',') || '（无）'}`);
  check('子代理永远拿不到 team/subagent/plugin/ask', !['team', 'subagent', 'plugin', 'ask'].some((n) => set.includes(n)));
  const onlyRead = resolveToolSet(['read', 'team', 'ask'], getTool).map((t) => t.name);
  check('点名工具时仍过滤禁区', onlyRead.includes('read') && !onlyRead.includes('team') && !onlyRead.includes('ask'), onlyRead.join(','));
  const rp = rolePrompt({ role: 'dev', task: '改 x', team: { name: '队', goal: 'g', briefing: '已知：x 在 src/x.js', board: ['甲（dev）：改好了 y'] } });
  check('角色提示含团队简报', /已知：x 在 src\/x\.js/.test(rp) && /不要再 read 一遍/.test(rp));
  check('角色提示含其他成员结论', /甲（dev）：改好了 y/.test(rp) && /别重复做/.test(rp));
  check('角色提示含省上下文纪律', /先 grep \/ glob 定位/.test(rp) && /同一个文件只读一次/.test(rp));
}

{
  // 成员文件范围 = 真的写保护（不是提示词），防止队友互相覆盖
  const { writeTool, editTool } = await import('../src/tools/fs.js');
  const SW = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scope-'));
  fs.mkdirSync(path.join(SW, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(SW, 'test'), { recursive: true });
  fs.writeFileSync(path.join(SW, 'src', 'core', 'a.js'), 'a\n');
  const ctx = { cwd: SW, writeScope: ['src/core/a.js'] };
  const okWrite = await writeTool.execute({ path: 'src/core/a.js', content: 'aa\n' }, ctx);
  check('范围内文件可写', !okWrite.isError, okWrite.content?.slice(0, 60));
  const denied = await writeTool.execute({ path: 'src/core/other.js', content: 'x' }, ctx);
  check('范围外文件被拒', denied.isError && /不在你负责的文件范围内/.test(denied.content), denied.content?.slice(0, 60));
  const deniedEdit = await editTool.execute({ path: 'test/x.js', old_string: 'a', new_string: 'b' }, ctx);
  check('范围外 edit 也被拒', deniedEdit.isError && /不在你负责的文件范围内/.test(deniedEdit.content));
  check('被拒的文件确实没被创建', !fs.existsSync(path.join(SW, 'src', 'core', 'other.js')));
  // 目录范围：写目录里的任意文件都行
  const dirCtx = { cwd: SW, writeScope: ['test/'] };
  const okDir = await writeTool.execute({ path: 'test/t1.js', content: 'x\n' }, dirCtx);
  const badDir = await writeTool.execute({ path: 'src/core/a.js', content: 'x' }, dirCtx);
  check('目录范围按前缀放行', !okDir.isError && badDir.isError);
  // 没设范围时完全不拦（主代理/普通子代理）
  const free = await writeTool.execute({ path: 'src/core/other.js', content: 'x\n' }, { cwd: SW });
  check('没有 writeScope 时不拦', !free.isError);
  // 读不受限
  const { readTool } = await import('../src/tools/fs.js');
  const rd = await readTool.execute({ path: 'src/core/a.js' }, ctx);
  check('读不受文件范围限制', !rd.isError, String(rd.content).slice(0, 30));
}

// ---------------------------------------------------------------- 界面封装层
const dv = describeTool({ name: 'subagent', input: { task: '补测试', name: '测试-1' }, meta: { subagent: { name: '测试-1', role: 'QA', steps: 12, toolCalls: 7, tokens: { input: 900, output: 300 }, cost: 0.01, secs: 40 } }, content: 'x' });
check('子代理工具块标题', /subagent · 测试-1/.test(dv.label) && dv.tags.some((t) => t.t === '子代理') && dv.tags.some((t) => /步/.test(t.t)));
const dt = describeTool({ name: 'team', input: { action: 'create', name: '小队', goal: '并行重构', members: [1, 2, 3] }, meta: { team: { name: '小队', members: 3, concurrency: 2 } }, content: 'x' });
check('团队工具块标题', /team · 小队/.test(dt.label) && dt.tags.some((t) => /3 人/.test(t.t)) && /并行重构/.test(dt.summary));

// ---------------------------------------------------------------- 界面命令层
// 用假 TTY 驱动真实 App：只看 item 内容，不比对渲染帧（帧的尺寸约束在 ui-sim 里测）
{
  const { PassThrough } = await import('node:stream');
  const out = { isTTY: true, columns: 100, rows: 30, write: () => true, on() {}, off() {}, removeListener() {} };
  const inp = new PassThrough();
  inp.isTTY = true;
  inp.setRawMode = () => {};
  Object.defineProperty(process, 'stdout', { value: out, configurable: true });
  Object.defineProperty(process, 'stderr', { value: out, configurable: true });
  Object.defineProperty(process, 'stdin', { value: inp, configurable: true });

  const { App } = await import('../src/ui/app.js');
  const appCfg = new Config();
  appCfg.setSettings({ subagents: false, team: false });
  const app = new App({ config: appCfg, cwd: WS });
  const lastText = () => {
    const it = app.items[app.items.length - 1];
    return it ? `${it.text || ''}${(it.lines || []).join('\n')}` : '';
  };
  const run = async (cmd) => {
    await app.command(cmd);
    return lastText();
  };

  const st1 = await run('/subagents');
  check('/subagents 有说明与代价', /子代理/.test(st1) && /未开启/.test(st1) && /token/.test(st1));
  const on1 = await run('/subagents on');
  check('/subagents on 开关生效', appCfg.subagentsEnabled === true && /已开启/.test(on1));
  const st2 = await run('/team');
  check('/team 有说明与代价', /团队协作/.test(st2) && /未开启/.test(st2) && /token/.test(st2));
  const on2 = await run('/team on');
  check('/team on 开关生效', appCfg.teamEnabled === true && /已开启/.test(on2));
  const tl = await run('/tools');
  check('/tools 列出协作区且显示已开', /subagent/.test(tl) && /team/.test(tl) && /已开/.test(tl));
  const bad = await run('/subagents maybe');
  check('/subagents 参数校验', /用法/.test(bad));
  // 团队 / 子代理在后台产生的提示要能直接冒到界面上
  check('App 把事件通道接到 agent', typeof app.agent.eventSink === 'function');
  app.agent.eventSink({ kind: 'note', text: '成员「前端」改了 src/app.js' });
  check('后台提示能进界面', /成员「前端」/.test(lastText()) && app.items[app.items.length - 1].kind === 'note');
  try {
    app.destroy?.();
  } catch {
    /* ignore */
  }
}

log(failed ? `\n${failed} 个检查失败` : '\n子代理 / 团队检查全部通过');
process.exit(failed ? 1 : 0);
