// 子代理 / 团队协作的离线测试：不打网络。
// 团队用注入的假 runner 跑（真 runner 要调模型），团队面板用真 HTTP 请求验。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');
const { enabledTools, runTool } = await import('../src/tools/index.js');
const { teamTool } = await import('../src/tools/team.js');
const { Team, teamDir, setActiveTeam } = await import('../src/team.js');
const { ProgressHub, ensureHub, dashboardHtml, resetHub } = await import('../src/progress.js');
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
for (const rel of ['team.js', 'subagent.js', 'progress.js', 'tools/team.js', 'tools/subagent.js', 'tools/index.js']) {
  const r = coldImport(rel);
  check(`单独 import src/${rel} 不炸`, r === true, r === true ? '' : r);
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
function get(urlPath, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

const port = await freePort();
const config = new Config();
config.setSettings({ progress: true, progressPort: port, subagents: false, team: false });

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

// ------------------------------------------------------------------ 团队面板服务
// 走单例入口：团队 / 子代理工具也是拿这同一个面板，端口被占时自动往后挑
const hub = await ensureHub(config);
check('面板能启动', !!hub && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(hub.url), hub?.url);
check('默认用配置里的端口', hub && hub.port === port, String(hub?.port));
const dup = new ProgressHub({ port });
const dupUrl = await dup.ensure();
check('端口被占时自动换端口', new URL(dupUrl).port !== String(port), dupUrl);
dup.stop();
const stateRes = await get('/api/state', hub.port);
check('/api/state 返回 JSON', stateRes.status === 200 && JSON.parse(stateRes.body).log.length === 0);
const page = await get('/', hub.port);
check('/ 返回面板页面', page.status === 200 && /text\/html/.test(page.headers['content-type']));
check('页面含 EventSource 与标题', /EventSource/.test(page.body) && /团队面板/.test(page.body));
const health = await get('/health', hub.port);
check('/health 正常', health.status === 200 && JSON.parse(health.body).ok === true);
hub.log({ kind: 'note', who: '测试', text: '面板日志' });
hub.update({ title: 'Aurora · 测试' });
await wait(260);
const state2 = JSON.parse((await get('/api/state', hub.port)).body);
check('日志进了面板状态', state2.log.length === 1 && state2.log[0].text === '面板日志' && state2.title === 'Aurora · 测试');
check('dashboardHtml 自包含', /Aurora/.test(dashboardHtml()) && !/https?:\/\/[^"']*\.(js|css)/.test(dashboardHtml()));

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
await team.attachHub(config);
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

// 面板里能看到团队
const state3 = JSON.parse((await get('/api/state', hub.port)).body);
check('面板拿到团队快照', state3.team?.name === '测试小队' && state3.team.members.length === 3 && state3.totals.done === 3);
check('面板日志有成员动态', state3.log.some((l) => l.kind === 'member_done'));

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
check('team status 带团队面板地址', /团队面板：http:\/\/127\.0\.0\.1/.test(toolStatus.content) && /3\/3 完成/.test(toolStatus.content));
const badAction = await teamTool.execute({ action: 'nonsense' }, ctx);
check('未知 action 报错', badAction.isError && /不认识/.test(badAction.content));
const noMembers = await teamTool.execute({ action: 'create', goal: 'g' }, ctx);
check('缺成员时报错', noMembers.isError && /members/.test(noMembers.content));
const noGoal = await teamTool.execute({ action: 'create', members: [{ task: 'x' }] }, ctx);
check('缺目标时报错', noGoal.isError && /goal/.test(noGoal.content));

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
  appCfg.setSettings({ progress: true, progressPort: await freePort(), subagents: false, team: false });
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
  const pr = (await run('/progress')).replace(/\x1b\[[0-9;]*m/g, '');
  check('/progress 打印团队面板地址', /团队面板\s+http:\/\/127\.0\.0\.1:\d+\//.test(pr), pr.split('\n')[0]);
  const off = await run('/progress off');
  check('/progress off 关得掉', appCfg.settings.progress === false && /已关闭/.test(off));
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

resetHub();
log(failed ? `\n${failed} 个检查失败` : '\n子代理 / 团队检查全部通过');
process.exit(failed ? 1 : 0);
