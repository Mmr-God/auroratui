// 团队协作的「能力」测试（离线、不联网、不跑真模型）：
//   1. 依赖 DAG：depends 校验 / 就绪判定 / 依赖者产出进简报
//   2. 全队验收：所有人收工后跑一次，结果进报告
//   3. 成本熔断：花超预算就停发新活
//   4. 卡住纠偏：重复调用 / 连续失败时提醒一次
//   5. 经验库：踩过的坑入库 + 按关键词召回
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teamcap-'));
process.env.AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teamcap-home-'));

const { Team, resolveDepends, checkScopes, scopeOverlap } = await import('../src/team.js');
const { addLesson, loadLessons, recallLessons, renderLessons, tagsOf } = await import('../src/lessons.js');
const { rolePrompt } = await import('../src/subagent.js');

let failed = 0;
const log = (m = '') => fs.writeSync(1, m + '\n');
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeConfig = { settings: {}, active: { provider: 'x', model: 'y' } };

// =================================================== 1. 依赖 DAG
log('# 依赖 DAG');
{
  const ms = [
    { name: '接口', task: '定接口' },
    { name: '实现', task: '写实现', depends: ['接口'] },
    { name: '文档', task: '写文档' },
  ];
  const r = resolveDepends(ms);
  check('合法依赖能解析', r.ok === true, r.error || '');
  check('拓扑序：接口在实现之前', r.order.indexOf(ms[0]) < r.order.indexOf(ms[1]));

  const bad = resolveDepends([{ name: 'A', task: 'x', depends: ['不存在的人'] }]);
  check('依赖不存在的成员被拦住', bad.ok === false && /不存在/.test(bad.error), bad.error);

  const self = resolveDepends([{ name: 'A', task: 'x', depends: ['A'] }]);
  check('依赖自己被拦住', self.ok === false && /自己/.test(self.error), self.error);

  const cycle = resolveDepends([
    { name: 'A', task: 'x', depends: ['C'] },
    { name: 'B', task: 'y', depends: ['A'] },
    { name: 'C', task: 'z', depends: ['B'] },
  ]);
  check('成环被拦住', cycle.ok === false && /成环/.test(cycle.error), cycle.error);

  // 依赖名字大小写不敏感
  const ci = resolveDepends([
    { name: 'API', task: 'x' },
    { name: 'Impl', task: 'y', depends: ['api'] },
  ]);
  check('依赖名大小写不敏感', ci.ok === true, ci.error || '');
}

// 就绪判定
{
  const t = new Team({
    config: fakeConfig,
    cwd: WS,
    name: 'T',
    goal: 'g',
    members: [
      { name: 'A', task: 'a' },
      { name: 'B', task: 'b', depends: ['A'] },
    ],
  });
  const [a, b] = t.members;
  check('A 没依赖，一开始就绪', t.depsReady(a) === true);
  check('B 依赖 A，A 没跑完就不就绪', t.depsReady(b) === false);
  a.status = 'done';
  check('A 完工后 B 就绪', t.depsReady(b) === true);
  a.status = 'running';
  check('A 还在跑时 B 不就绪', t.depsReady(b) === false);
}

// =================================================== 2. 依赖产出进简报
log('\n# 依赖者产出进简报');
{
  const t = new Team({
    config: fakeConfig,
    cwd: WS,
    name: 'T2',
    goal: 'g',
    members: [
      { name: '接口', role: '后端', task: '定接口' },
      { name: '实现', role: '前端', task: '照着写', depends: ['接口'] },
    ],
  });
  const [api, impl] = t.members;
  api.status = 'done';
  api.output = '接口定好了：GET /api/users 返回 {id,name}';
  api.report = { files: [{ path: 'src/api.js', ops: ['edit'] }], verifyNote: '验收通过' };
  api.findings = ['users 表字段是 user_id 不是 id'];

  const dep = t.dependsFor(impl);
  check('能拿到依赖者的产出', dep.length === 1 && dep[0].name === '接口', JSON.stringify(dep));
  check('产出正文带上了', /GET \/api\/users/.test(dep[0].text), dep[0].text);
  check('核实账带上了', /src\/api\.js/.test(dep[0].facts), dep[0].facts);
  check('情报带上了', dep[0].findings.some((f) => /user_id/.test(f)), JSON.stringify(dep[0].findings));

  const brief = t._briefFor(impl, dep);
  check('简报里有依赖段落', /你依赖的成员已经完工/.test(brief), brief.slice(0, 80));
  check('简报里有接口正文', /GET \/api\/users/.test(brief));

  // 没依赖的成员简报保持原样，不该凭空多出段落
  check('没依赖时简报不多内容', t._briefFor(api, []) === '', JSON.stringify(t._briefFor(api, [])));

  // rolePrompt 里真的会出现
  const prompt = rolePrompt({ role: '前端', task: '照接口写页面', depends: dep });
  check('子代理提示里包含依赖产出', /GET \/api\/users/.test(prompt), prompt.slice(0, 60));
  check('子代理提示里让他别推翻接口', /不要推翻/.test(prompt));
}

// =================================================== 3. 全队验收
log('\n# 全队验收');
{
  const t = new Team({
    config: fakeConfig,
    cwd: WS,
    name: 'T3',
    goal: 'g',
    members: [{ name: 'A', task: 'a' }],
    verify: ['echo team-verify-ok'],
  });
  check('verify 被存下来', t.verify.length === 1 && t.verify[0] === 'echo team-verify-ok', JSON.stringify(t.verify));

  // 直接跑一次全队验收（真的执行命令，但用 echo，跨平台都行）
  await t._runTeamVerify();
  check('全队验收跑成功了', t.verifyResult?.ok === true, JSON.stringify(t.verifyResult));
  check('验收结果里有输出', /team-verify-ok/.test(t.verifyResult?.output || ''), t.verifyResult?.output);

  t.members[0].status = 'done';
  t.members[0].output = 'a 干完了';
  const rep = t.report();
  check('报告里有全队验收结论', /全队验收/.test(rep), rep.split('\n').slice(0, 4).join(' | '));
  check('报告里是全队验收 ✓', /全队验收：✓/.test(rep), rep.slice(0, 120));
}
{
  // 没设 verify 的队伍，报告里不该出现「全队验收」这句
  const t = new Team({ config: fakeConfig, cwd: WS, name: 'T4', goal: 'g', members: [{ name: 'A', task: 'a' }] });
  t.members[0].status = 'done';
  check('没设全队验收时不编造结论', !/全队验收/.test(t.report()));
}
{
  // 失败的验收要能带出失败输出
  const t = new Team({
    config: fakeConfig,
    cwd: WS,
    name: 'T5',
    goal: 'g',
    members: [{ name: 'A', task: 'a' }],
    verify: ['exit 3'],
  });
  await t._runTeamVerify();
  t.members[0].status = 'done';
  const rep = t.report();
  check('失败的验收标 ✗', /全队验收：✗/.test(rep), rep.slice(0, 160));
}

// =================================================== 4. 成本熔断
log('\n# 成本熔断');
{
  const t = new Team({ config: fakeConfig, cwd: WS, name: 'T6', goal: 'g', members: [{ name: 'A', task: 'a' }], budget: 0.01 });
  check('预算被记下来', t.budget === 0.01, String(t.budget));
  t.members[0].cost = 0.005;
  check('没超预算时不停', t._budgetExceeded() === false);
  t.members[0].cost = 0.02;
  check('超预算时停发新活', t._budgetExceeded() === true);
  check('熔断原因写清楚了', /预算/.test(t.haltReason), t.haltReason);
  t.members[0].status = 'done';
  check('报告里标出被熔断', /预算/.test(t.report()));
}
{
  const t = new Team({ config: fakeConfig, cwd: WS, name: 'T7', goal: 'g', members: [{ name: 'A', task: 'a' }] });
  check('不填 budget 就不限（默认 0）', t.budget === 0 && t._budgetExceeded() === false);
}

// =================================================== 5. 卡住纠偏
log('\n# 卡住自动纠偏');
{
  const t = new Team({ config: fakeConfig, cwd: WS, name: 'T8', goal: 'g', members: [{ name: 'A', task: 'a' }] });
  const m = t.members[0];
  const queued = [];
  m.status = 'running';
  m._agent = { queue: (s) => queued.push(s) };

  // 反复调同一个工具、同一个参数
  const ev = (name, p) => ({ type: 'tool_start', name, input: { path: p } });
  t._memberEvent(m, ev('read', 'src/a.js'));
  t._memberEvent(m, { type: 'tool_end', name: 'read', isError: false, content: 'x' });
  check('第一次调用不提醒', queued.length === 0);
  t._memberEvent(m, ev('read', 'src/a.js'));
  t._memberEvent(m, { type: 'tool_end', name: 'read', isError: false, content: 'x' });
  check('第二次也不提醒（可能是正常确认）', queued.length === 0);
  t._memberEvent(m, ev('read', 'src/a.js'));
  check('第三次重复 → 提醒一次', queued.length === 1, JSON.stringify(queued));
  check('提醒内容说清在重复什么', /重复|反复/.test(queued[0]) && /read/.test(queued[0]), queued[0].slice(0, 60));
  // 继续重复不该再刷屏
  t._memberEvent(m, ev('read', 'src/a.js'));
  check('同一种卡法只提醒一次', queued.length === 1, String(queued.length));

  // 换个文件，重置
  t._memberEvent(m, ev('read', 'src/b.js'));
  t._memberEvent(m, { type: 'tool_end', name: 'read', isError: false, content: 'y' });
  check('换参数后重置计数', m.recent.repeats === 0, String(m.recent.repeats));
}
{
  const t = new Team({ config: fakeConfig, cwd: WS, name: 'T9', goal: 'g', members: [{ name: 'A', task: 'a' }] });
  const m = t.members[0];
  const queued = [];
  m.status = 'running';
  m._agent = { queue: (s) => queued.push(s) };

  for (let i = 1; i <= 3; i++) {
    t._memberEvent(m, { type: 'tool_start', name: `cmd${i}`, input: { command: `c${i}` } });
    t._memberEvent(m, { type: 'tool_end', name: `cmd${i}`, isError: true, content: 'boom' });
  }
  check('连续 3 次失败 → 提醒改道', queued.length === 1, JSON.stringify(queued));
  check('提醒里说清了失败次数', /连续 3 次/.test(queued[0]), queued[0].slice(0, 50));
  check('失败计数被记录', m.failStreak === 3, String(m.failStreak));

  // 成功后清零
  t._memberEvent(m, { type: 'tool_start', name: 'ok', input: { command: 'ok' } });
  t._memberEvent(m, { type: 'tool_end', name: 'ok', isError: false, content: 'fine' });
  check('成功一次就把失败计数清零', m.failStreak === 0, String(m.failStreak));
}
{
  // 没开会话（成员已结束）时不能崩
  const t = new Team({ config: fakeConfig, cwd: WS, name: 'T10', goal: 'g', members: [{ name: 'A', task: 'a' }] });
  const m = t.members[0];
  m.status = 'done';
  let threw = false;
  try {
    t._maybeNudge(m, 'repeat', 'read a.js');
  } catch {
    threw = true;
  }
  check('成员已收工时纠偏不报错', threw === false);
}

// =================================================== 6. 经验库
log('\n# 跨任务经验库');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lessons-'));
  check('空库读出来是空数组', loadLessons(ws).length === 0);

  const ok1 = addLesson(ws, {
    task: '给 team.js 加依赖',
    kind: 'verify-fail',
    text: '跑 npm test 时 team.js 里 resolveDepends 的拓扑排序报 TypeError',
    tags: ['team.js', 'resolveDepends'],
  });
  check('写入一条经验', ok1 === true);
  check('文件真的落盘了', fs.existsSync(path.join(ws, '.agent', 'lessons.jsonl')));

  const ok2 = addLesson(ws, {
    task: '给 team.js 加依赖',
    kind: 'verify-fail',
    text: '跑 npm test 时 team.js 里 resolveDepends 的拓扑排序报 TypeError',
    tags: ['team.js'],
  });
  check('重复的经验不再写一遍', ok2 === false);
  check('库里还是 1 条', loadLessons(ws).length === 1);

  addLesson(ws, { task: '改画板', kind: 'blocked', text: 'draw 插件的 crop 参数和 scale 冲突，画面裁不出来', tags: ['draw', 'crop'] });

  // 召回：任务里提到 team.js 就该中第一条
  const hit = recallLessons(ws, '继续改 team.js 的 resolveDepends 逻辑');
  check('按关键词能召回', hit.length >= 1, JSON.stringify(hit));
  check('召回到的是正确那条', /resolveDepends/.test(hit[0].text), hit[0]?.text);

  // 不相关任务不该召回
  const miss = recallLessons(ws, '写一个完全无关的 python 脚本');
  check('不相关就不召回（不塞噪音）', miss.length === 0, JSON.stringify(miss));

  // 渲染
  const rendered = renderLessons(hit);
  check('渲染出可读的条目', /^- \[/m.test(rendered), rendered);
  check('渲染带上了当时在做什么', /当时在做/.test(rendered), rendered);
  check('空列表渲染成空串', renderLessons([]) === '');

  // 太短的垃圾不记
  check('太短的经验不记', addLesson(ws, { task: 'x', kind: 'blocked', text: '无' }) === false);

  // 标签提取
  const tags = tagsOf('修 src/team.js 里 resolveDepends 的 bug，报 ENOENT');
  check('标签抓到了文件名', tags.includes('src/team.js'), JSON.stringify(tags));
  check('标签抓到了报错码', tags.includes('enoent'), JSON.stringify(tags));
}

// 经验库真的会注入到子代理提示里
{
  const prompt = rolePrompt({ role: '开发', task: '改 team.js', lessons: '- [验收失败] resolveDepends 爆了' });
  check('经验库进了子代理提示', /以前同类活踩过的坑/.test(prompt), prompt.slice(0, 60));
  check('提示里带了具体那条经验', /resolveDepends/.test(prompt));
}

// =================================================== 7. 团队踩坑入库
log('\n# 团队踩坑自动入库');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-learn-'));
  const t = new Team({ config: fakeConfig, cwd: ws, name: 'L', goal: 'g', members: [{ name: 'A', role: '后端', task: '改 src/api.js 的路由', files: ['src/api.js'] }] });
  const m = t.members[0];
  m.status = 'done';
  m.report = { verified: false, verifyNote: '1 条验收命令失败', verifyOutput: 'FAIL src/api.js: 路由重复注册', blocked: ['routes 表里已经有一条 GET /users'], files: [{ path: 'src/api.js' }] };
  t._learn(m, {});
  const all = loadLessons(ws);
  check('验收失败入库了', all.some((l) => l.kind === 'verify-fail'), JSON.stringify(all.map((l) => l.kind)));
  check('卡住的点也入库了', all.some((l) => l.kind === 'blocked'));
  check('入库内容带上了真实报错', all.some((l) => /路由重复注册/.test(l.text)), all[0]?.text);
  // 下次同类活能被召回
  const again = recallLessons(ws, '再改一下 src/api.js 的路由');
  check('下次同类活能召回', again.length >= 1, JSON.stringify(again.map((x) => x.text)));
}

// =================================================== 8. 范围重叠（回归）
log('\n# 文件范围重叠（回归）');
{
  check('同文件算重叠', scopeOverlap('src/a.js', 'src/a.js') === true);
  check('不相关不算重叠', scopeOverlap('src/a.js', 'src/b.js') === false);
  check('checkScopes 能报出冲突', checkScopes([
    { name: 'X', files: ['src/a.js'] },
    { name: 'Y', files: ['src/a.js'] },
  ]).length === 1);
}

// =================================================== 9. 串起来的完整流程
log('\n# 依赖串行 + 全队验收（假 runner）');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-'));
  const order = [];
  const t = new Team({
    config: fakeConfig,
    cwd: ws,
    name: 'Flow',
    goal: '先定接口再实现',
    concurrency: 2,
    members: [
      { name: '接口', role: '后端', task: '定接口' },
      { name: '实现', role: '前端', task: '照接口实现', depends: ['接口'] },
      { name: '文档', role: '文档', task: '写文档' },
    ],
    verify: ['echo all-good'],
    runner: async ({ member, depends }) => {
      order.push(member.name);
      // 实现必须先拿到接口的产出
      if (member.name === '实现') {
        if (!depends || !depends.some((d) => d.name === '接口')) throw new Error('实现没有拿到依赖产出');
        if (!depends.some((d) => /GET \/api\/users/.test(d.text))) throw new Error('依赖产出内容不对');
      }
      await sleep(10);
      return {
        text: member.name === '接口' ? '接口定好了：GET /api/users 返回 {id,name}' : `${member.name} 干完了`,
        steps: 3,
        usage: { input: 10, output: 5, cost: 0.0001 },
        report: { files: [], verified: null },
      };
    },
  });
  await t.start();
  await t.waitAll(8000);
  check('三个人都跑完了', t.members.every((m) => m.status === 'done'), t.members.map((m) => `${m.name}:${m.status}`).join(' '));
  check('实现的产出拿到了依赖（runner 里断言过）', order.includes('实现'));
  check('实现排在接口之后', order.indexOf('接口') < order.indexOf('实现'), order.join(' → '));
  check('不依赖的文档可以和接口并行（先于实现）', order.indexOf('文档') < order.indexOf('实现'), order.join(' → '));
  check('全队验收跑过了', t.verifyResult?.ok === true, JSON.stringify(t.verifyResult));
  const rep = t.report();
  check('报告里有全队验收 ✓', /全队验收：✓/.test(rep));
  check('报告里标了依赖关系', /依赖：接口/.test(rep), rep.slice(0, 200));
}

log(failed ? `\n${failed} 个检查失败` : '\n团队能力（依赖/验收/熔断/纠偏/经验库）检查全部通过');
process.exit(failed ? 1 : 0);
