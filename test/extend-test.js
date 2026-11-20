// 新增三个工具（jobs / diagnostics / patch）的离线测试。
// 不依赖真实 LLM、不依赖网络；shell 相关的用真实 bash（环境里就有）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-extend-home-'));

const { jobs } = await import('../src/jobs.js');
const { jobsTool } = await import('../src/tools/jobs.js');
const { diagnosticsTool, parseTsc, parseEslintUnix, parseColon, parseRuff, detectChecks } = await import('../src/tools/diagnostics.js');
const { patchTool, parsePatch, applyHunks } = await import('../src/tools/patch.js');
const { getTool, allTools, enabledTools, toolSchemas } = await import('../src/tools/index.js');

const log = (m = '') => fs.writeSync(1, m + '\n');
let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-extend-ws-'));
const ctx = { cwd: WS, allowOutside: false };
const write = (rel, content) => {
  const p = path.join(WS, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
};
const read = (rel) => fs.readFileSync(path.join(WS, rel), 'utf8');

// ============================================================ 注册
log('# 工具注册');
check('jobs 注册了', !!getTool('jobs'));
check('diagnostics 注册了', !!getTool('diagnostics'));
check('patch 注册了', !!getTool('patch'));
check('allTools 里有三个新工具', ['jobs', 'diagnostics', 'patch'].every((n) => allTools.some((t) => t.name === n)));
check('schema 能生成', [jobsTool, diagnosticsTool, patchTool].every((t) => t.name && t.description && t.parameters));
check('patch 不是 readOnly', patchTool.readOnly === false);
check('diagnostics 是 readOnly', diagnosticsTool.readOnly === true);
const schemas = toolSchemas(enabledTools({ settings: {} }));
check('默认配置下三个工具都下发给模型', ['jobs', 'diagnostics', 'patch'].every((n) => schemas.some((s) => s.name === n)));

// ============================================================ jobs 工具
log('\n# jobs 工具');
jobs.jobs = [];
{
  const empty = await jobsTool.execute({ action: 'list' }, ctx);
  check('空列表有友好提示', /还没有任何命令记录/.test(empty.content), empty.content);

  const j1 = jobs.add({ command: 'npm test', cwd: WS, source: '主代理' });
  jobs.end(j1.id, { code: 0, dur: 1500, output: 'PASS a\nPASS b' });
  const j2 = jobs.add({ command: 'npm run build', cwd: WS, source: '子代理(层1)' });
  jobs.end(j2.id, { code: 2, dur: 900, output: 'error TS2304: Cannot find name "foo"' });
  const j3 = jobs.add({ command: 'node watch.js', cwd: WS, background: true });
  jobs.progress(j3.id, 'step 1\nstep 2');

  const list = await jobsTool.execute({ action: 'list' }, ctx);
  check('list 列出全部', /共 3 条/.test(list.content), list.content.split('\n')[0]);
  check('list 标出几个在跑', /1 个在跑/.test(list.content));
  check('list 标出后台任务', /\[后台\]/.test(list.content));
  check('list 有退出码', /exit 2/.test(list.content));
  check('list 有来源', /子代理\(层1\)/.test(list.content));
  check('list 带序号', /^1\. /m.test(list.content));
  check('list meta 统计对', list.meta.count === 3 && list.meta.running === 1, JSON.stringify(list.meta));

  // tail：跑着的给实时尾巴
  const tailRunning = await jobsTool.execute({ action: 'tail', id: j3.id }, ctx);
  check('tail 能看实时尾巴', /step 1/.test(tailRunning.content) && /step 2/.test(tailRunning.content), tailRunning.content);
  check('tail 标出跑着', /跑着/.test(tailRunning.content));
  check('tail 带命令本身', /\$ node watch\.js/.test(tailRunning.content));

  // tail：结束的给完整输出
  const tailDone = await jobsTool.execute({ action: 'tail', id: j2.id }, ctx);
  check('tail 结束的给完整输出', /Cannot find name/.test(tailDone.content));
  check('tail 标题带状态', /失败.*exit 2/.test(tailDone.content), tailDone.content.split('\n')[0]);

  // tail 按 index（列表顺序：j3/j2/j1）
  const tailByIndex = await jobsTool.execute({ action: 'tail', index: 3 }, ctx);
  check('tail 能按 index 取', /npm test/.test(tailByIndex.content), tailByIndex.content.split('\n')[1]);

  // tail 按 id 前缀：用「完整 id 去掉最后一位」才可能唯一，所以直接构造一个
  // 独苗 job（等一会儿让时间戳错开），确保前缀能唯一定位
  await new Promise((res) => setTimeout(res, 20));
  const solo = jobs.add({ command: 'unique-prefix-target', cwd: WS });
  jobs.end(solo.id, { code: 0, output: 'solo-out' });
  const soloPrefix = solo.id.slice(0, -1);
  const tailByPrefix = await jobsTool.execute({ action: 'tail', id: soloPrefix }, ctx);
  check('tail 能按 id 前缀取', /solo-out/.test(tailByPrefix.content), tailByPrefix.content.slice(0, 80));
  // 前缀歧义时要报错，不能乱选一条：造两条共享时间戳段的 job
  const t = Date.now().toString(36);
  jobs.jobs = [
    { id: `sh${t}-a`, command: 'x1', cwd: WS, source: '主代理', status: 'ok', code: 0, started: Date.now(), ended: Date.now(), dur: 1, bytes: 0, tail: '', output: 'o1', truncator: false, kill: null },
    { id: `sh${t}-b`, command: 'x2', cwd: WS, source: '主代理', status: 'ok', code: 0, started: Date.now(), ended: Date.now(), dur: 1, bytes: 0, tail: '', output: 'o2', truncator: false, kill: null },
  ];
  const ambiguous = await jobsTool.execute({ action: 'tail', id: `sh${t}` }, ctx);
  check('前缀歧义时报错而不是乱选', ambiguous.isError === true && /匹配到/.test(ambiguous.content), ambiguous.content);

  // lines 截断
  const jL = jobs.add({ command: 'big-output', cwd: WS });
  jobs.end(jL.id, { code: 0, output: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') });
  const tailLimit = await jobsTool.execute({ action: 'tail', id: jL.id, lines: 5 }, ctx);
  check('tail 尊重 lines', /line 299/.test(tailLimit.content) && !/line 100/.test(tailLimit.content), tailLimit.content.split('\n').slice(-3).join(' | '));
  check('tail 提示总行数', /共 \d+ 行/.test(tailLimit.content));

  // 找不到 / 参数不足
  const notFound = await jobsTool.execute({ action: 'tail', id: 'nosuchjob' }, ctx);
  check('找不到的 id 报错', notFound.isError && /找不到/.test(notFound.content), notFound.content);
  const noId = await jobsTool.execute({ action: 'tail' }, ctx);
  check('多条命令且没给 id 时报错', noId.isError && /请给 id/.test(noId.content), noId.content);

  // kill
  const j4 = jobs.add({ command: 'sleep 100', cwd: WS });
  let killed = false;
  jobs.get(j4.id).kill = () => {
    killed = true;
  };
  const killRes = await jobsTool.execute({ action: 'kill', id: j4.id }, ctx);
  check('kill 真的调了 kill', killed);
  check('kill 返回成功', !killRes.isError && /已终止/.test(killRes.content), killRes.content);
  check('kill 后状态是 killed', jobs.get(j4.id).status === 'killed');
  const killAgain = await jobsTool.execute({ action: 'kill', id: j4.id }, ctx);
  check('重复 kill 友好提示', !killAgain.isError && /已经结束/.test(killAgain.content), killAgain.content);

  const badAction = await jobsTool.execute({ action: 'explode' }, ctx);
  check('未知 action 报错', badAction.isError && /未知 action/.test(badAction.content));
}

// ============================================================ 解析器
log('\n# diagnostics 输出解析器');
{
  const tsc = parseTsc(
    [
      'src/a.ts(42,7): error TS2304: Cannot find name \'foo\'.',
      'src/b.ts(1,1): warning TS6133: \'x\' is declared but never read.',
      'some noise line',
    ].join('\n'),
  );
  check('tsc 解析出 2 条', tsc.length === 2, JSON.stringify(tsc));
  check('tsc 字段对', tsc[0].file === 'src/a.ts' && tsc[0].line === 42 && tsc[0].col === 7 && tsc[0].severity === 'error' && tsc[0].rule === 'TS2304', JSON.stringify(tsc[0]));
  check('tsc 识别 warning', tsc[1].severity === 'warning');

  const eslint = parseEslintUnix(
    ['/abs/src/a.js:42:7: Cannot find name \'foo\'. [Error/no-undef]', '/abs/b.js:1:1: unused var [Warning/no-unused-vars]', '  2 problems'].join('\n'),
  );
  check('eslint 解析出 2 条', eslint.length === 2, JSON.stringify(eslint));
  check('eslint 带规则名', eslint[0].rule === 'no-undef' && eslint[0].severity === 'error', JSON.stringify(eslint[0]));
  check('eslint 识别 warning', eslint[1].severity === 'warning');

  const colon = parseColon(['./main.go:12:4: undefined: foo', '/x/y.rs:5:1: error[E0308]: mismatched types', 'npm ERR! not a path'].join('\n'));
  check('通用冒号格式解析出 2 条（排除非路径行）', colon.length === 2, JSON.stringify(colon));
  check('通用格式行号列号对', colon[0].file === './main.go' && colon[0].line === 12 && colon[0].col === 4);

  const ruff = parseRuff(["src/a.py:42:7: F821 Undefined name 'foo'"].join('\n'));
  check('ruff 解析对', ruff.length === 1 && ruff[0].rule === 'F821' && ruff[0].line === 42, JSON.stringify(ruff));
}

// ============================================================ 探测
log('\n# diagnostics 项目探测');
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-probe-none-'));
  check('空目录探测不到检查器', detectChecks(empty).length === 0);

  const tsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-probe-ts-'));
  fs.writeFileSync(path.join(tsDir, 'tsconfig.json'), '{}');
  const tsChecks = detectChecks(tsDir);
  check('有 tsconfig 就探测到 tsc', tsChecks.some((c) => c.name === 'tsc'), JSON.stringify(tsChecks.map((c) => c.name)));
  check('tsc 命令带 --noEmit', tsChecks.find((c) => c.name === 'tsc').command.includes('--noEmit'));

  const goDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-probe-go-'));
  fs.writeFileSync(path.join(goDir, 'go.mod'), 'module x\n');
  check('有 go.mod 探测到 go vet', detectChecks(goDir).some((c) => c.name === 'go vet'));

  const rsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-probe-rs-'));
  fs.writeFileSync(path.join(rsDir, 'Cargo.toml'), '[package]\n');
  check('有 Cargo.toml 探测到 cargo check', detectChecks(rsDir).some((c) => c.name === 'cargo check'));

  const pyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-probe-py-'));
  fs.writeFileSync(path.join(pyDir, 'requirements.txt'), 'requests\n');
  check('有 requirements.txt 探测到 ruff', detectChecks(pyDir).some((c) => c.name === 'ruff'));
}

// ============================================================ diagnostics 端到端
log('\n# diagnostics 端到端（真实跑命令）');
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-diag-none-'));
  const r = await diagnosticsTool.execute({}, { cwd: empty });
  check('探测不到检查器时明确报错，不谎报通过', r.isError && /没探测到/.test(r.content), r.content.slice(0, 120));
  check('报错里说明「这不是代码没问题」', /这不是「代码没问题」/.test(r.content), r.content);

  // 用自定义命令测：能被解析的格式
  const parsed = await diagnosticsTool.execute({ command: 'echo "./src/x.go:3:5: something wrong"; exit 1' }, { cwd: empty });
  check('自定义命令的输出被解析', /src\/x\.go:3:5/.test(parsed.content), parsed.content);
  check('有错误时 isError', parsed.isError === true);

  // 干净的检查：退出码 0 且无输出
  const clean = await diagnosticsTool.execute({ command: 'echo ""' }, { cwd: empty });
  check('干净的检查报没问题', /没有问题/.test(clean.content), clean.content);
  check('干净时 isError 为假', clean.isError === false);

  // 命令不存在：不能当成通过
  const missing = await diagnosticsTool.execute({ command: 'definitely-not-a-real-tool-xyz --check .' }, { cwd: empty });
  check('命令不存在时不谎报通过', missing.isError === true, missing.content.slice(0, 160));
  check('命令不存在时给出原因', /没安装|跑不起来|命令不存在/.test(missing.content), missing.content.slice(0, 200));

  // 输出格式认不出来但退出码非 0：要把原文带回去
  const unparsed = await diagnosticsTool.execute({ command: 'echo "完全是另一种格式的一段话"; exit 3' }, { cwd: empty });
  check('认不出格式时把原文带回去', /没认出来|原文/.test(unparsed.content), unparsed.content.slice(0, 160));
  check('认不出格式时 isError', unparsed.isError === true);
}

// ============================================================ patch 解析
log('\n# patch 解析器');
{
  const diff = [
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,5 +1,6 @@',
    ' line1',
    ' line2',
    '-line3',
    '+line3 modified',
    '+line3.5',
    ' line4',
    ' line5',
  ].join('\n');
  const files = parsePatch(diff);
  check('解析出 1 个文件', files.length === 1, JSON.stringify(files.map((f) => f.file)));
  check('文件名去掉了 a/ b/ 前缀', files[0].file === 'src/a.js', files[0].file);
  check('解析出 1 个 hunk', files[0].hunks.length === 1);
  const h = files[0].hunks[0];
  check('hunk 行号对', h.oldStart === 1 && h.oldLines === 5 && h.newStart === 1 && h.newLines === 6, JSON.stringify(h));
  check('hunk 类型对', h.lines.filter((l) => l.type === 'add').length === 2 && h.lines.filter((l) => l.type === 'del').length === 1 && h.lines.filter((l) => l.type === 'ctx').length === 4);

  // 多文件
  const multi = parsePatch(['--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-old', '+new', '--- a/y.txt', '+++ b/y.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n'));
  check('多文件解析', multi.length === 2 && multi[0].file === 'x.txt' && multi[1].file === 'y.txt', JSON.stringify(multi.map((f) => f.file)));

  // 新建文件
  const created = parsePatch(['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+hello', '+world'].join('\n'));
  check('新建文件识别成 isNew', created.length === 1 && created[0].isNew === true, JSON.stringify(created[0]));

  // 删除文件
  const deleted = parsePatch(['--- a/old.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n'));
  check('删除文件识别成 isDelete', deleted.length === 1 && deleted[0].isDelete === true);

  // 应用
  const base = 'line1\nline2\nline3\nline4\nline5\n';
  const applied = applyHunks(base, files[0].hunks);
  check('applyHunks 成功', applied.ok === true);
  check('applyHunks 内容正确', applied.text === 'line1\nline2\nline3 modified\nline3.5\nline4\nline5\n', JSON.stringify(applied.text));

  // 上下文对不上 → 拒绝
  const bad = applyHunks('completely\ndifferent\ncontent\n', files[0].hunks);
  check('上下文对不上时拒绝', bad.ok === false && /找不到对应位置/.test(bad.error), bad.ok ? 'unexpectedly ok' : bad.error.split('\n')[0]);
  check('拒绝时给出期望的上下文', /期望的上下文/.test(bad.error));

  // fuzz 能救一点点漂移
  const drifted = applyHunks('extra\nline1\nline2\nline3\nline4\nline5\n', files[0].hunks, { fuzz: 0 });
  check('行号漂移 1 行、fuzz=0 时拒绝', drifted.ok === false);
  const fuzzed = applyHunks('extra\nline1\nline2\nline3\nline4\nline5\n', files[0].hunks, { fuzz: 2 });
  check('fuzz=2 能救回漂移', fuzzed.ok === true, fuzzed.ok ? '' : fuzzed.error.split('\n')[0]);
}

// ============================================================ patch 端到端
log('\n# patch 端到端');
{
  write('a.txt', 'one\ntwo\nthree\nfour\nfive\n');
  const diff = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,5 +1,5 @@', ' one', ' two', '-three', '+THREE', ' four', ' five'].join('\n');
  const r = await patchTool.execute({ diff }, ctx);
  check('patch 应用成功', !r.isError, r.content);
  check('文件内容真的改了', read('a.txt') === 'one\ntwo\nTHREE\nfour\nfive\n', JSON.stringify(read('a.txt')));
  check('回报里写了 +1 −1', /\+1 −1/.test(r.content), r.content.split('\n')[0]);

  // dry_run 不写
  write('b.txt', 'x\n');
  const dry = await patchTool.execute({ diff: ['--- a/b.txt', '+++ b/b.txt', '@@ -1 +1 @@', '-x', '+y'].join('\n'), dry_run: true }, ctx);
  check('dry_run 不写文件', read('b.txt') === 'x\n', JSON.stringify(read('b.txt')));
  check('dry_run 说能应用', /都能干净应用/.test(dry.content), dry.content.split('\n')[0]);

  // 多文件：一个失败 → 全都不动
  write('m1.txt', 'aaa\n');
  write('m2.txt', 'zzz\n');
  const multiDiff = [
    '--- a/m1.txt', '+++ b/m1.txt', '@@ -1 +1 @@', '-aaa', '+AAA',
    '--- a/m2.txt', '+++ b/m2.txt', '@@ -1 +1 @@', '-never-match', '+BBB',
  ].join('\n');
  const multiRes = await patchTool.execute({ diff: multiDiff }, ctx);
  check('多文件有失败时整体拒绝', multiRes.isError === true, multiRes.content.split('\n')[0]);
  check('m1 没被改动（要么全成要么全不动）', read('m1.txt') === 'aaa\n', JSON.stringify(read('m1.txt')));
  check('m2 没被改动', read('m2.txt') === 'zzz\n');

  // 新建文件
  const createDiff = ['--- /dev/null', '+++ b/brand/new.txt', '@@ -0,0 +1,2 @@', '+hello', '+world'].join('\n');
  const created = await patchTool.execute({ diff: createDiff }, ctx);
  check('能新建文件', !created.isError && read('brand/new.txt') === 'hello\nworld\n', created.isError ? created.content : JSON.stringify(read('brand/new.txt')));

  // 删除文件
  const delDiff = ['--- a/brand/new.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-hello', '-world'].join('\n');
  const delRes = await patchTool.execute({ diff: delDiff }, ctx);
  check('能删除文件', !delRes.isError && !fs.existsSync(path.join(WS, 'brand/new.txt')), delRes.isError ? delRes.content : 'still exists');

  // 文件不存在（非新建）
  const noFile = await patchTool.execute({ diff: ['--- a/nope.txt', '+++ b/nope.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n') }, ctx);
  check('改不存在的文件会报错', noFile.isError && /文件不存在/.test(noFile.content), noFile.content.slice(0, 100));

  // 坏输入
  const badInput = await patchTool.execute({ diff: '这就是一段普通文字，不是 diff' }, ctx);
  check('非 diff 文本报错并给格式提示', badInput.isError && /没解析出/.test(badInput.content), badInput.content.slice(0, 80));
  const noDiff = await patchTool.execute({}, ctx);
  check('缺 diff 参数报错', noDiff.isError && /缺少 diff/.test(noDiff.content));

  // 工作区守卫：越界写被拦
  const outside = await patchTool.execute(
    { diff: ['--- a/../../evil.txt', '+++ b/../../evil.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n') },
    { cwd: WS, allowOutside: false },
  );
  check('工作区外写入被拒绝', outside.isError === true && /工作区/.test(outside.content), outside.content.slice(0, 120));

  // checkpoint 被调用
  let saved = 0;
  write('ck.txt', 'p\n');
  await patchTool.execute(
    { diff: ['--- a/ck.txt', '+++ b/ck.txt', '@@ -1 +1 @@', '-p', '+q'].join('\n') },
    { cwd: WS, allowOutside: false, checkpoints: { save: () => saved++ } },
  );
  check('落盘前调了 checkpoint', saved === 1, String(saved));
}

// ============================================================ shell background
log('\n# shell background 参数');
{
  const { shellTool, disposeShell } = await import('../src/tools/shell.js');
  jobs.jobs = [];
  const r = await shellTool.execute({ command: 'echo bg-ok', background: true }, { cwd: WS, allowOutside: true });
  check('background 立刻返回', !r.isError, r.content);
  check('拿到 jobId', !!r.meta?.jobId, JSON.stringify(r.meta));
  check('返回里提示用 jobs 工具', /jobs/.test(r.content));
  const job = jobs.get(r.meta.jobId);
  check('job 表里有这条', !!job);
  check('标记成 background', job.background === true);
  check('一开始是 running', job.status === 'running', job.status);

  // 等它跑完
  await new Promise((res) => setTimeout(res, 1500));
  const after = jobs.get(r.meta.jobId);
  check('跑完后状态变 ok', after.status === 'ok', after.status);
  check('拿到了输出', /bg-ok/.test(after.output || after.tail || ''), after.output);
  const tail = await jobsTool.execute({ action: 'tail', id: r.meta.jobId }, ctx);
  check('jobs tail 能看到后台输出', /bg-ok/.test(tail.content), tail.content);
  disposeShell();
  jobs.jobs = [];
}

log(failed ? `\n${failed} 个检查失败` : '\n扩展工具检查全部通过');
process.exit(failed ? 1 : 0);
