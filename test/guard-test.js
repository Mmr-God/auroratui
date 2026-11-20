// 守卫与能力回归：工具点名单校验（P0-1）、shell 文件范围守卫（P0-2）、
// 成员失败重试（P1-1）、teamMemberModel（P1-2）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-'));
process.env.AGENT_HOME = HOME;

let failed = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) {
    failed++;
    process.stdout.write(`✗ ${name}${detail ? ` — ${detail}` : ''}\n`);
  } else {
    process.stdout.write(`√ ${name}\n`);
  }
};

// ---------------------------------------------------------------- P0-1
{
  const { resolveToolSet, validateToolSpec, toolSpecError, expandToolNames } = await import('../src/subagent.js');
  const { getTool } = await import('../src/tools/index.js');

  const all = resolveToolSet(null, getTool).map((t) => t.name);
  check('不点名 → 默认全集', all.includes('write') && all.includes('shell') && all.length >= 15, `${all.length} 个`);

  const scout = resolveToolSet('scout', getTool).map((t) => t.name);
  check('preset scout 只给只读工具', scout.length === 5 && !scout.includes('write') && !scout.includes('shell'), scout.join(','));

  // 核心回归：拼错工具名绝不能静默退回全量工具集
  let threw = null;
  try {
    resolveToolSet(['recon'], getTool);
  } catch (e) {
    threw = e;
  }
  check('拼错工具名会抛错（不再静默拿到全量工具）', !!threw, threw ? threw.message.slice(0, 40) : '没抛错');
  check('拼错报错里带可用名称提示', !!threw && /不认识|scout/.test(threw.message));

  const v = validateToolSpec(['recon'], getTool);
  check('validateToolSpec 标出 unknown', v.ok === false && v.unknown[0] === 'recon', JSON.stringify(v.unknown));
  check('拼错提示能猜出最接近的名字', /read/.test(toolSpecError(v)), toolSpecError(v).split('\n')[1] || '');

  const v2 = validateToolSpec(['read', 'team', 'ask'], getTool);
  check('禁用工具被剔除但不炸', v2.ok === true && v2.tools.length === 1 && v2.tools[0].name === 'read', JSON.stringify(v2.forbidden));

  check('preset 名可展开', expandToolNames('verify').includes('shell'), expandToolNames('verify').join(','));
  check('点名单大小写不敏感', resolveToolSet(['READ', 'Grep'], getTool).length === 2);
}

// ---------------------------------------------------------------- P0-2
{
  const { guardShellScope, writeTargets, inScope } = await import('../src/tools/scope.js');
  const cwd = path.resolve(HOME, 'proj');
  const ctx = { cwd, writeScope: ['src/a.js', 'tests/'] };
  const allow = (cmd, c = ctx) => guardShellScope(cmd, c) === null;

  check('范围外重定向被拒', !allow('echo hi > src/b.js'));
  check('范围内重定向放行', allow('echo hi > src/a.js'));
  check('范围内子目录放行', allow('echo hi >> tests/x.txt'));
  check('cd 之后相对路径按新基准判断（范围内）', allow('cd tests && echo x > x.txt'));
  check('cd 之后相对路径按新基准判断（范围外）', !allow('cd other && echo x > x.txt'));
  check('工作区外的写交给 /trust 那套管（与 fs 的 guardWrite 一致）', allow('echo hi > /tmp/evil.txt'));
  check('阅读命令放行', allow('cat src/b.js') && allow('npm test') && allow('git status'));
  check('cp 到范围外被拒', !allow('cp src/a.js other/z.js'));
  check('mv 的源在范围外被拒（移动=改源目录）', !allow('mv other/y.js src/a.js'));
  check('sed -i 改范围外被拒', !allow('sed -i "s/a/b/" src/b.js'));
  check('sed -i 改范围内放行', allow('sed -i "s/a/b/" src/a.js'));
  check('sed 只读（无 -i）放行', allow('sed -n 1p src/b.js'));
  check('sed 脚本串不被当路径', !writeTargets('sed -i "s/a/b/" src/a.js').some((t) => t.startsWith('s/')));
  check('git checkout 一律拒', !allow('git checkout -- src/a.js'));
  check('git reset --hard 一律拒', !allow('git reset --hard'));
  check('find -delete 一律拒', !allow('find . -name "*.log" -delete'));
  check('touch 范围外被拒', !allow('touch other/new.txt'));
  check('2>/dev/null 不算越界', allow('echo hi 2>/dev/null'));
  check('无 writeScope 的上下文一律放行', allow('rm -rf /tmp/whatever', { cwd }));
  check('inScope 认目录前缀', inScope(['tests/'], cwd, 'tests/a/b.js') && !inScope(['tests/'], cwd, 'tests2/a.js'));

  // 真的接在 shell 工具上了吗（不只是单元函数）
  const { shellTool } = await import('../src/tools/shell.js');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  const r = await shellTool.execute({ command: 'echo hi > src/b.js' }, { cwd, writeScope: ['src/a.js'] });
  check('shell 工具这条路径真的拦住了越界写', r.isError === true && /范围/.test(r.content), r.content.split('\n')[0]);
}

// ---------------------------------------------------------------- P1-2
{
  const { Config } = await import('../src/config.js');
  const cfg = new Config();
  check('teamMemberModel 默认存在且为空', cfg.settings.teamMemberModel === '', String(cfg.settings.teamMemberModel));
  cfg.data.settings.teamMemberModel = 'deepseek-v4-flash';
  check('teamMemberModel 能写进配置', cfg.settings.teamMemberModel === 'deepseek-v4-flash');

  // defaultRunner 是否把回落逻辑传下去：直接读源码断言（跑真模型太贵）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/team.js'), 'utf8');
  check('defaultRunner 用 teamMemberModel 兜底', /model:\s*member\.model\s*\|\|\s*String\(config\?\.settings\?\.teamMemberModel/.test(src));
}

// ---------------------------------------------------------------- P1-1
{
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/team.js'), 'utf8');
  check('成员失败会重试一次', /canRetry\s*=\s*!fatal\s*&&\s*!m\.retried/.test(src) && /m\.retried\s*=\s*true/.test(src));
  check('重试时带上「上次改了哪些文件」', /上次已经动过的文件/.test(src) && /const touched = new Set\(\)/.test(src));
  check('中断/超时不重试', /const fatal = !!m\._ctrl\?\.signal\?\.aborted/.test(src));
  check('重试会重置纠偏状态', /m\.nudged = \{ repeat: false, errors: false \}/.test(src));

  // 用假 runner 真的跑一遍成员：第一次抛错、第二次成功
  const { Team } = await import('../src/team.js');
  const { Config } = await import('../src/config.js');
  const cfg = new Config();
  const dir = fs.mkdtempSync(path.join(HOME, 'team-retry-'));
  let calls = 0;
  const seenBriefs = [];
  const t = new Team({
    config: cfg,
    cwd: dir,
    name: '重试队',
    goal: '验证重试',
    concurrency: 1,
    members: [{ name: '甲', role: 'dev', task: '改一下 a.js', files: ['src/a.js'] }],
    runner: async ({ briefing, onEvent }) => {
      calls++;
      seenBriefs.push(String(briefing || ''));
      // 第一次先「改了个文件」再挂，第二次正常收工
      onEvent?.({ type: 'tool_start', name: 'write', input: { path: 'src/a.js' } });
      if (calls === 1) throw new Error('模拟网络断了');
      onEvent?.({ type: 'text', delta: '改好了' });
      return { text: '改好了', steps: 3, usage: { input: 10, output: 5, cost: 0.001 } };
    },
  });
  await t.start();
  await t.waitAll(5000);
  const m = t.members[0];
  check('成员失败后会自动重试', calls === 2, `runner 被调用 ${calls} 次`);
  check('重试后状态是 done', m.status === 'done', m.status);
  check('重试简报里说明了「上次挂掉的原因」', /模拟网络断了/.test(seenBriefs[1] || ''), (seenBriefs[1] || '').slice(0, 60));
  check('重试简报里带上了上次改过的文件', /src\/a\.js/.test(seenBriefs[1] || ''));
  check('重试标记留在成员上', m.retried === true);

  // 被中断（玩家按了停止）不该重试：stop() 会 abort 成员 ctrl，fatal 判定读到它就放弃
  const dir2 = fs.mkdtempSync(path.join(HOME, 'team-noretry-'));
  let calls2 = 0;
  let t2 = null;
  t2 = new Team({
    config: cfg,
    cwd: dir2,
    name: '不重试队',
    goal: 'g',
    concurrency: 1,
    members: [{ name: '乙', role: 'dev', task: 'x', files: ['b.js'] }],
    runner: async () => {
      calls2++;
      t2.stop(); // 相当于玩家按了停止（会 abort 这个成员的 ctrl）
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('被停了');
    },
  });
  await t2.start();
  await t2.waitAll(5000);
  check('被中断的成员不重试', calls2 === 1, `runner 被调用 ${calls2} 次`);

  // 一直挂的成员：最多重试 1 次（不能无限打转把 token 烧光）
  const dir3 = fs.mkdtempSync(path.join(HOME, 'team-exhaust-'));
  let calls3 = 0;
  const t3 = new Team({
    config: cfg,
    cwd: dir3,
    name: '总挂队',
    goal: 'g',
    concurrency: 1,
    members: [{ name: '丙', role: 'dev', task: 'x', files: ['c.js'] }],
    runner: async () => {
      calls3++;
      throw new Error('每次都挂');
    },
  });
  await t3.start();
  await t3.waitAll(5000);
  check('一直挂的成员最多重试 1 次', calls3 === 2, `runner 被调用 ${calls3} 次`);
  check('重试仍失败时成员状态是 error', t3.members[0].status === 'error', t3.members[0].status);
  check('错误信息里标明已重试过', /重试/.test(t3.members[0].tr?.entries?.().map((e) => JSON.stringify(e)).join('') || ''));
}

process.stdout.write(failed ? `\n${failed}/${n} 项失败\n` : `\n全部 ${n} 项守卫检查通过\n`);
process.exit(failed ? 1 : 0);
