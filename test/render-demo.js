// Offline UI harness: renders frames to a text file so layout can be inspected
// without a real TTY (`node test/render-demo.js > out.txt`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-demo-'));
const { Config } = await import('../src/config.js');
const { App } = await import('../src/ui/app.js');
const { stripAnsi, strWidth } = await import('../src/util.js');

const W = Number(process.env.COLS || 100);
const H = Number(process.env.ROWS || 30);

const config = new Config();
const app = new App({ config, cwd: process.cwd() });
app.width = W;
app.height = H;

app.items = [];
app.items.push({ kind: 'banner', lines: ['◆ agent · 终端里的 AI 编程代理'], ver: 1 });
app.items.push({ kind: 'user', text: '帮我看看 src/tools/shell.js 里 marker 解析有没有问题，顺便跑一下测试', ver: 1 });
app.items.push({
  kind: 'assistant',
  think: '先读文件确认 marker 协议，然后跑 node 测试。',
  text:
    '先定位到解析逻辑：\n\n- marker 由 `printf` 输出，形如 `__AGENT_x__:\\d+:cwd`\n- 解析用正则，含 `$?` 与 `$PWD`\n\n```js\nconst m = /^(-?\\d+):(.*)$/s.exec(tail.trim());\nif (m) this.cwd = normalizeCwd(m[2]);\n```\n\n再看一下 **测试** 结果：',
  ver: 1,
});
app.items.push({
  kind: 'tool',
  id: 't1',
  name: 'shell',
  input: { command: 'node --test test/' },
  status: 'ok',
  dur: 820,
  content: '✔ marker 解析 (12ms)\n✔ 输出截断 (3ms)\nℹ pass 2\nℹ fail 0',
  ver: 1,
});
app.items.push({ kind: 'tool', id: 't2', name: 'web_search', input: { query: 'ansi 256 color' }, status: 'running', content: '', ver: 1 });
app.items.push({ kind: 'compacted', text: '已折叠为 b1（修复 marker 正则）· 上下文降到 38.2%', ver: 1 });
app.input = { text: '/model deepseek', cursor: '/model deepseek'.length };
app.context = { tokens: 12000, maxTokens: 1000000, used: 0.012 };
app.usage = { input: 1200, output: 340, cost: 0.0012 };
app.running = false;

const frame = app.buildFrame();
const plain = frame.map((l) => pad(stripAnsi(l)));
const issues = [];
plain.forEach((l, i) => {
  if (strWidth(l) !== W) issues.push(`row ${i}: width ${strWidth(l)} != ${W}`);
});

// picker frame
app.openModelPicker();
app.picker.filter = '';
const frame2 = app.buildFrame();
const plain2 = frame2.map((l) => pad(stripAnsi(l)));

const outPath = path.join(process.cwd(), 'test', 'render-demo.txt');
fs.writeFileSync(
  outPath,
  [
    `=== normal frame (${W}x${H}) ===`,
    plain.join('\n'),
    '',
    `=== model picker frame ===`,
    plain2.join('\n'),
    '',
    issues.length ? 'WIDTH ISSUES:\n' + issues.join('\n') : 'width check: ok',
  ].join('\n'),
);
console.log(fs.readFileSync(outPath, 'utf8'));

function pad(s) {
  return s + ' '.repeat(Math.max(0, W - strWidth(s)));
}
