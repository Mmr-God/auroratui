// End-to-end loop test against a local mock OpenAI-compatible server.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-'));
process.env.AGENT_HOME = HOME;

const { Config } = await import('../src/config.js');
const { Agent } = await import('../src/agent.js');

const script = [];
let turn = 0;

const server = http.createServer(async (req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('nope');
    return;
  }
  let body = '';
  for await (const c of req) body += c;
  const parsed = JSON.parse(body);
  turn++;
  const hasToolResult = parsed.messages.some((m) => m.role === 'tool');
  const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user');

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

  if (!hasToolResult) {
    // first turn: request two parallel read-only tools + one shell call
    send({ choices: [{ index: 0, delta: { reasoning_content: '需要先看文件。' } }] });
    send({ choices: [{ index: 0, delta: { content: '先读一下 package.json：' } }] });
    const calls = [
      { index: 0, id: 'call_a', function: { name: 'read', arguments: JSON.stringify({ file_path: 'package.json' }) } },
      { index: 1, id: 'call_b', function: { name: 'shell', arguments: JSON.stringify({ command: 'pwd && echo hello' }) } },
    ];
    for (const c of calls) send({ choices: [{ index: 0, delta: { tool_calls: [c] } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    send({ choices: [{ index: 0, delta: { content: '读完了，**一切正常**。\n\n```bash\npwd # ok\n```' } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 } } });
  res.write('data: [DONE]\n\n');
  res.end();
  void lastUser;
  void script;
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const config = new Config();
config.setApiKey('custom', 'test-key');
config.setBaseUrl('custom', `http://127.0.0.1:${port}/v1`);
config.setActive('custom', 'mock-model');
config.setSettings({ thinking: 'off' });

const agent = new Agent({ config, cwd: process.cwd() });
const events = [];
for await (const ev of agent.run('检查一下 package.json')) {
  events.push(ev);
  if (ev.type === 'text') process.stdout.write(ev.delta);
  else if (ev.type === 'tool_start') process.stdout.write(`\n[▸ ${ev.name} ${JSON.stringify(ev.input)}]\n`);
  else if (ev.type === 'tool_end') process.stdout.write(`[${ev.isError ? '✗' : '✓'} ${ev.name} ${ev.dur}ms]\n`);
  else if (ev.type === 'error') process.stdout.write(`\n[ERR ${ev.message}]\n`);
  else if (ev.type === 'usage') process.stdout.write(`\n[usage ↑${ev.usage.input} ↓${ev.usage.output} ctx=${(ev.context.used * 100).toFixed(1)}%]\n`);
}

const kinds = events.map((e) => e.type);
const stats = agent.engine.stats;
console.log('\n--- assertions ---');
const checks = [
  ['streaming text', kinds.includes('text')],
  ['two tool calls', events.filter((e) => e.type === 'tool_start').length === 2],
  ['read succeeded', events.some((e) => e.type === 'tool_end' && e.name === 'read' && !e.isError)],
  ['shell succeeded', events.some((e) => e.type === 'tool_end' && e.name === 'shell' && !e.isError)],
  ['tool result has pwd output', events.some((e) => e.type === 'tool_end' && e.name === 'shell' && /hello/.test(e.content))],
  ['done event', kinds.includes('done')],
  ['usage tracked', agent.usageTotal.input === 240 && agent.usageTotal.output === 60],
  ['final assistant text', events.some((e) => e.type === 'done' && /一切正常/.test(e.text))],
  ['messages stored', stats.messages === 5],
];
let ok = true;
for (const [name, pass] of checks) {
  if (!pass) ok = false;
  console.log(`${pass ? '✓' : '✗'} ${name}`);
}

// ---- context engine behaviours ----
console.log('\n--- context engine ---');
const { ContextEngine } = await import('../src/context/engine.js');
const e = new ContextEngine({ maxTokens: 1000, compactAt: 0.5 });
e.addUser('我要重构 shell 工具');
e.addAssistant({ content: '好的，先看代码', toolCalls: [{ id: 'c1', name: 'read', input: { file_path: 'a.js' } }] });
for (let i = 0; i < 12; i++) {
  e.addToolResult({ toolCallId: 'c1', name: 'read', content: `line ${i} of a.js ${'x'.repeat(200)}` });
  e.addUser(`继续第 ${i} 步`);
  e.addAssistant({ content: `第 ${i} 步完成 ${'y'.repeat(200)}` });
}
const plan = e.planFold();
console.log('needsCompact:', e.needsCompact(), 'plan nodes:', plan?.nodes.length);
const before = e.tokens();
const block = e.fold(plan.start, plan.end, e.mechanicalSummary(plan.nodes), 'shell 工具重构');
const after = e.tokens();
console.log(`${after < before ? '✓' : '✗'} fold shrinks context ${before} → ${after}`);
const hits = e.search('shell');
console.log(`${hits.length ? '✓' : '✗'} search finds folded content (${hits.length} hits)`);
const expanded = e.textOf(block.id);
console.log(`${/line 3 of/.test(expanded.text) ? '✓' : '✗'} expand restores original text (${expanded.chars} chars)`);
const rendered = e.render();
console.log(`${rendered.some((m) => m.role === 'context') ? '✓' : '✗'} block renders as context message`);
e.expand(block.id);
console.log(`${e.nodes.filter((n) => n.kind === 'message').length === 38 ? '✓' : '✗'} expand restores nodes (${e.nodes.length})`);

server.close();
const { disposeShell } = await import('../src/tools/shell.js');
disposeShell();
process.exit(ok ? 0 : 1);
