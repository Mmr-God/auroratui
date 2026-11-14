// Tool-level tests for the navigation / memory / git / http tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
process.env.AGENT_HOME = HOME;
const { allTools, getTool, toolSchemas, runTool } = await import('../src/tools/index.js');

let failed = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const log = (m = '') => fs.writeSync(1, m + '\n');
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-proj-'));
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.mkdirSync(path.join(proj, 'node_modules', 'junk'), { recursive: true });
fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'export const ALPHA = 1;\nfunction hi() { return "hi"; }\n');
fs.writeFileSync(path.join(proj, 'src', 'b.ts'), 'const beta = 2;\n// TODO: 中文注释\n');
fs.writeFileSync(path.join(proj, 'node_modules', 'junk', 'x.js'), 'export const NOPE = 1;\n');
const ctx = { cwd: proj };

// schema sanity
const names = allTools.map((t) => t.name);
for (const need of ['read', 'write', 'edit', 'shell', 'glob', 'grep', 'ls', 'think', 'web_search', 'web_fetch', 'http_request', 'git', 'todo', 'memory', 'context']) {
  check(`tool registered: ${need}`, names.includes(need));
}
check('schemas generate', toolSchemas().length === names.length);

// glob
let r = await runTool({ id: '1', name: 'glob', input: { pattern: '**/*.{js,ts}' } }, ctx);
check('glob finds js+ts', /src\/a\.js/.test(r.content) && /src\/b\.ts/.test(r.content), r.content.split('\n')[0]);
check('glob skips node_modules', !/node_modules/.test(r.content));
r = await runTool({ id: '2', name: 'glob', input: { pattern: '**/*.js', ignore: ['src/**'] } }, ctx);
check('glob ignore works', !/src\/a\.js/.test(r.content));

// grep
r = await runTool({ id: '3', name: 'grep', input: { pattern: 'ALPHA' } }, ctx);
check('grep finds symbol', /a\.js.*ALPHA/.test(r.content.replace(/\s+/g, ' ')), r.content.slice(0, 60));
r = await runTool({ id: '4', name: 'grep', input: { pattern: '中文注释' } }, ctx);
check('grep handles CJK', /b\.ts/.test(r.content));
r = await runTool({ id: '5', name: 'grep', input: { pattern: 'nomatch_xyz' } }, ctx);
check('grep reports no match', !r.isError && /没有匹配/.test(r.content));
r = await runTool({ id: '6', name: 'grep', input: { pattern: '([' } }, ctx);
check('grep rejects bad regex', r.isError);

// ls
r = await runTool({ id: '7', name: 'ls', input: { depth: 2 } }, ctx);
check('ls lists tree', /src\//.test(r.content) && /a\.js/.test(r.content));
check('ls collapses node_modules', /node_modules\/\s+…/.test(r.content), r.content.split('\n').find((l) => l.includes('node_modules')) || '');

// think
r = await runTool({ id: '8', name: 'think', input: { thought: '先读文件再改' } }, ctx);
check('think acks', /已记录/.test(r.content));

// todo
r = await runTool({ id: '9', name: 'todo', input: { action: 'set', items: ['读代码', '改 bug', '跑测试'] } }, ctx);
check('todo set', /读代码/.test(r.content) && fs.existsSync(path.join(proj, '.agent-todo.json')));
r = await runTool({ id: '10', name: 'todo', input: { action: 'update', index: 2, status: 'done' } }, ctx);
check('todo update', /\[x\] 2\. 改 bug/.test(r.content), r.content.split('\n')[1] || '');
r = await runTool({ id: '11', name: 'todo', input: { action: 'list' } }, ctx);
check('todo list persists', /\[ \] 1\. 读代码/.test(r.content));
r = await runTool({ id: '12', name: 'todo', input: { action: 'add', items: ['写文档'] } }, ctx);
check('todo add', /写文档/.test(r.content));

// memory
r = await runTool({ id: '13', name: 'memory', input: { action: 'set', key: 'user.lang', value: '中文' } }, ctx);
check('memory set', /已记住/.test(r.content) && fs.existsSync(path.join(HOME, 'memory.json')));
r = await runTool({ id: '14', name: 'memory', input: { action: 'get', key: 'user.lang' } }, ctx);
check('memory get', /中文/.test(r.content));
const { memoryPrompt } = await import('../src/tools/todo.js');
check('memory injected into prompt', memoryPrompt().includes('user.lang: 中文'));
r = await runTool({ id: '15', name: 'memory', input: { action: 'forget', key: 'user.lang' } }, ctx);
check('memory forget', /已遗忘/.test(r.content) && !memoryPrompt().includes('user.lang'));

// git (read-only, works even outside a repo? must fail gracefully)
r = await runTool({ id: '16', name: 'git', input: { action: 'status' } }, ctx);
check('git status outside repo fails gracefully', typeof r.content === 'string' && r.content.length > 0, r.isError ? 'isError ok' : 'ok');
const repo = path.resolve('.');
r = await runTool({ id: '17', name: 'git', input: { action: 'status' } }, { cwd: repo });
check('git status in repo', /^(##|\?\?|M |A )/m.test(r.content) || r.isError, r.content.split('\n')[0]);
r = await runTool({ id: '18', name: 'git', input: { action: 'branches' } }, { cwd: repo });
check('git branches', typeof r.content === 'string' && r.content.length > 0);

// http
r = await runTool({ id: '19', name: 'http_request', input: { url: 'https://example.com' } }, ctx);
check('http_request GET', /200/.test(r.content) && /Example Domain/.test(r.content), r.content.split('\n')[0]);
r = await runTool({ id: '20', name: 'http_request', input: { url: 'not-a-url' } }, ctx);
check('http_request validates url', r.isError);

// alias + coercion still work
r = await runTool({ id: '21', name: 'read', input: { file_path: 'src/a.js' } }, ctx);
check('read alias file_path', /ALPHA/.test(r.content));
r = await runTool({ id: '22', name: 'glob', input: { pattern: '**/*.js', limit: '5' } }, ctx);
check('string→integer coercion', !r.isError);

log(failed ? `\n${failed} TOOL CHECK(S) FAILED` : '\nALL TOOL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
await new Promise((r) => setTimeout(r, 50));
