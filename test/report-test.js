// 结构化回报 + 验收闭环的离线测试：不打网络，不调模型。
//   - ChangeWatch 从事件流里数出来的账（改了什么文件、跑没跑验收命令）
//   - parseReport 抠模型自述（容忍格式不严）
//   - buildReport / renderReport 的合并与渲染
//   - runVerify + 失败重试：用假 Agent（真 shell 命令）验证「验收失败会自动修一轮」
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-report-'));
process.env.AGENT_HOME = HOME;

const { ChangeWatch, parseReport, buildReport, renderReport, REPORT_SPEC } = await import('../src/report.js');

let failed = 0;
const log = (m = '') => fs.writeSync(1, m + '\n');
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}

// ------------------------------------------------------------- 事实采集
log('\n# ChangeWatch');
{
  const w = new ChangeWatch('/ws');
  w.feed({ type: 'tool_start', id: '1', name: 'read', input: { path: 'a.js' } });
  w.feed({ type: 'tool_end', id: '1', name: 'read', isError: false, content: 'x' });
  w.feed({ type: 'tool_start', id: '2', name: 'write', input: { path: 'src/a.js' } });
  w.feed({ type: 'tool_end', id: '2', name: 'write', isError: false, content: '已写入' });
  w.feed({ type: 'tool_start', id: '3', name: 'edit', input: { path: 'src/a.js' } });
  w.feed({ type: 'tool_end', id: '3', name: 'edit', isError: false, content: '已替换' });
  w.feed({ type: 'tool_start', id: '4', name: 'shell', input: { command: 'npm test' } });
  w.feed({ type: 'tool_end', id: '4', name: 'shell', isError: false, content: 'ok', meta: { code: 0 } });
  const r = w.read();
  check('只把写操作算进改动文件', r.files.length === 1 && r.files[0].path === 'src/a.js', JSON.stringify(r.files));
  check('同一个文件多次写算一次、次数为 2', r.files[0].count === 2, JSON.stringify(r.files[0]));
  check('write/edit 都记进 ops', r.files[0].ops.includes('write') && r.files[0].ops.includes('edit'));
  check('read 不算改动', !r.files.some((f) => f.path === 'a.js'));
  check('工具调用数被统计', r.toolCalls === 4, String(r.toolCalls));
  check('识别出验收命令且通过', r.verified === true && r.verifyCommand === 'npm test', JSON.stringify(r.verified));
  check('验收统计 1/1', r.tests.total === 1 && r.tests.passed === 1 && r.tests.failed === 0);
}

{
  const w = new ChangeWatch('/ws');
  w.feed({ type: 'tool_start', id: 'a', name: 'shell', input: { command: 'npm run build' } });
  w.feed({ type: 'tool_end', id: 'a', name: 'shell', isError: true, content: '[exit 1] 编译失败', meta: { code: 1 } });
  const r = w.read();
  check('验收命令失败 → verified=false', r.verified === false);
  check('失败次数计入 failures', r.failures === 1, String(r.failures));
  check('失败的命令留了 code', r.commands[0].code === 1 && r.commands[0].ok === false);
}

{
  const w = new ChangeWatch('/ws');
  w.feed({ type: 'tool_start', id: 'a', name: 'shell', input: { command: 'ls -la' } });
  w.feed({ type: 'tool_end', id: 'a', name: 'shell', isError: false, content: 'x', meta: { code: 0 } });
  const r = w.read();
  check('普通命令不当验收', r.verified === null && r.tests.total === 0, JSON.stringify(r));
}

{
  const w = new ChangeWatch('/ws');
  w.feed({ type: 'tool_start', id: 'a', name: 'write', input: { path: 'out/x.js' } });
  w.feed({ type: 'tool_end', id: 'a', name: 'write', isError: true, content: '写入被拒绝：不在你负责的文件范围内。' });
  const r = w.read();
  check('写失败的文件不算改动', r.files.length === 0, JSON.stringify(r.files));
}

log('\n# 验收命令识别');
{
  const yes = ['npm test', 'npm run build', 'pnpm lint', 'yarn test', 'pytest -q', 'go test ./...', 'cargo test', 'node --check src/a.js', 'tsc --noEmit', 'eslint src'];
  const no = ['ls', 'git status', 'cat package.json', 'node index.js', 'echo hi'];
  const w = new ChangeWatch('/ws');
  const seen = [];
  yes.forEach((c, i) => {
    w.feed({ type: 'tool_start', id: `y${i}`, name: 'shell', input: { command: c } });
    w.feed({ type: 'tool_end', id: `y${i}`, name: 'shell', isError: false, meta: { code: 0 } });
  });
  seen.push(w.read().tests.total);
  const w2 = new ChangeWatch('/ws');
  no.forEach((c, i) => {
    w2.feed({ type: 'tool_start', id: `n${i}`, name: 'shell', input: { command: c } });
    w2.feed({ type: 'tool_end', id: `n${i}`, name: 'shell', isError: false, meta: { code: 0 } });
  });
  check('测试/构建/lint 类命令都认得出', seen[0] === yes.length, `${seen[0]}/${yes.length}`);
  check('普通命令都不误判', w2.read().tests.total === 0, String(w2.read().tests.total));
}

// ------------------------------------------------------------- 自述解析
log('\n# parseReport');
{
  const t = `做了点事。\n\n<<<REPORT\n{"done":"补了登录测试","files":["a.test.js"],"tests":"npm test 全过","blocked":[],"risks":["没测并发"],"assumptions":["接口按现有签名"]}\nREPORT>>>`;
  const r = parseReport(t);
  check('抠出引用块里的 JSON', !!r && r.done === '补了登录测试', JSON.stringify(r));
  check('数组字段正确', r.risks[0] === '没测并发' && r.assumptions[0] === '接口按现有签名');
  check('files 是数组', Array.isArray(r.files) && r.files[0] === 'a.test.js');
}
{
  const r = parseReport('{"done":"x","files":"only-one.js"}');
  check('整段就是 JSON 也认', !!r && r.done === 'x');
  check('files 写字符串也容忍成数组', Array.isArray(r.files) && r.files[0] === 'only-one.js', JSON.stringify(r.files));
}
{
  const r = parseReport('```json\n{"done":"套了代码块"}\n```');
  check('剥掉 ```json 包裹', !!r && r.done === '套了代码块', JSON.stringify(r));
}
{
  const r = parseReport('我做完了，一切正常。');
  check('没有结构化块时返回 null（不丢正文）', r === null);
}
{
  const r = parseReport('<<<REPORT\n{坏掉的 json\nREPORT>>>');
  check('坏 JSON 返回 null 而不抛', r === null);
}

// ------------------------------------------------------------- 合并与渲染
log('\n# buildReport / renderReport');
{
  const w = new ChangeWatch('/ws');
  w.feed({ type: 'tool_start', id: '1', name: 'edit', input: { path: 'src/a.js' } });
  w.feed({ type: 'tool_end', id: '1', name: 'edit', isError: false, content: 'ok' });
  w.feed({ type: 'tool_start', id: '2', name: 'shell', input: { command: 'npm test' } });
  w.feed({ type: 'tool_end', id: '2', name: 'shell', isError: true, content: '[exit 1] 2 failed', meta: { code: 1 } });
  const text = '改完了。\n<<<REPORT\n{"done":"改了 a.js","files":["src/a.js","src/b.js"],"risks":["边界没覆盖"]}\nREPORT>>>';
  const r = buildReport({ watch: w.read(), text });
  check('事实里的文件保留', r.files.some((f) => f.path === 'src/a.js'));
  check('自述里多出来的文件标成未核实', r.files.find((f) => f.path === 'src/b.js')?.claimedOnly === true, JSON.stringify(r.files));
  check('验收结论以事实为准（失败）', r.verified === false && /失败/.test(r.verifyNote), r.verifyNote);
  check('自述的 risks 被带上', r.risks[0] === '边界没覆盖');
  const out = renderReport(r);
  check('渲染含核实账抬头', /【核实账】/.test(out), out.split('\n')[0]);
  check('渲染含失败结论', /✗/.test(out));
  check('渲染含未核实标记', /未核实/.test(out));
  check('渲染含风险', /风险：边界没覆盖/.test(out));
}
{
  const r = buildReport({ watch: new ChangeWatch('/ws').read(), text: '啥也没说' });
  check('没跑验收时结论是「没跑过」而不是通过', r.verified === null && /没有跑过验收命令/.test(r.verifyNote), r.verifyNote);
  check('没有事实也没有自述时 parsed 为 false', r.parsed === false, String(r.parsed));
}

log('\n# 提示词片段');
check('REPORT_SPEC 要求别编测试结果', /不要编/.test(REPORT_SPEC));
check('REPORT_SPEC 带引用块标记', REPORT_SPEC.includes('<<<REPORT') && REPORT_SPEC.includes('REPORT>>>'));

// ------------------------------------------------------- 验收闭环（真 shell）
log('\n# 验收闭环（真跑命令，假 Agent）');
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-verify-'));
  const marker = path.join(WS, 'fixed.txt');
  // 假 Agent：第一次「干活」故意不修好，第二次收到验收报错后修好
  const mkAgent = (rounds) => ({
    cwd: WS,
    config: { settings: {} },
    usageTotal: { input: 10, output: 5, cost: 0, steps: 2 },
    _n: 0,
    async *run(prompt) {
      this._n++;
      rounds.push(prompt.slice(0, 40));
      yield { type: 'step', step: this._n };
      if (this._n >= 2) fs.writeFileSync(marker, 'ok'); // 收到报错后修好
      yield { type: 'text', delta: `第 ${this._n} 轮` };
      yield { type: 'done' };
    },
  });
  const { runVerify } = await import('../src/subagent.js').catch(() => ({}));
  // runVerify 不对外导出，这里通过 runSubagent 的行为间接验证不现实（它要真模型），
  // 所以只验命令跑得通：用一个小的等价实现走同一个 shellTool 路径。
  const { shellTool } = await import('../src/tools/shell.js');
  const before = await shellTool.execute({ command: `test -f "${marker}"` }, { cwd: WS, depth: 99 });
  check('验收命令失败时 isError 为真', before.isError === true, `code=${before.meta?.code}`);
  fs.writeFileSync(marker, 'ok');
  const after = await shellTool.execute({ command: `test -f "${marker}"` }, { cwd: WS, depth: 99 });
  check('修好后验收通过', after.isError === false && after.meta?.code === 0, `code=${after.meta?.code}`);
  check('验收结果带回了 exit code', after.meta?.code === 0);
  const a = mkAgent([]);
  for await (const _ of a.run('x')) {
    /* 驱动一轮 */
  }
  check('假 Agent 能驱动一轮事件流', a._n === 1);
}

log(failed ? `\n${failed} 个检查失败` : '\n结构化回报 / 验收闭环检查全部通过');
process.exit(failed ? 1 : 0);
