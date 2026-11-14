// Live end-to-end test against the configured provider (skips if no key).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-'));
const { Config } = await import('../src/config.js');
const { Agent } = await import('../src/agent.js');
const { disposeShell } = await import('../src/tools/shell.js');

// 目标服务商走环境变量（不把任何人的 key / 网关地址提交进仓库）：
//   AURORA_LIVE_PROVIDER=deepseek  AURORA_LIVE_MODEL=deepseek-v4  DEEPSEEK_API_KEY=sk-...
//   # 或者自建网关：AURORA_LIVE_BASE_URL=http://127.0.0.1:8000/v1 AURORA_LIVE_KEY=... AURORA_LIVE_MODEL=my-model
const LIVE_BASE = process.env.AURORA_LIVE_BASE_URL || '';
const LIVE_KEY = process.env.AURORA_LIVE_KEY || '';
const LIVE_MODEL = process.env.AURORA_LIVE_MODEL || '';

const cfg = new Config();
if (LIVE_BASE) {
  cfg.addProvider({ id: 'live', name: 'live', baseUrl: LIVE_BASE });
  if (LIVE_MODEL) cfg.addProviderModel('live', LIVE_MODEL);
  if (LIVE_KEY) cfg.setApiKey('live', LIVE_KEY);
  cfg.setActive('live', LIVE_MODEL || 'default');
} else {
  const { getProvider } = await import('../src/providers.js');
  const p = process.env.AURORA_LIVE_PROVIDER || 'deepseek';
  const first = getProvider(p)?.models?.[0]?.id || LIVE_MODEL;
  cfg.setActive(p, LIVE_MODEL || first);
}
cfg.setSettings({ thinking: 'off' });

const agent = new Agent({ config: cfg, cwd: process.cwd() });
const used = [];
let text = '';
const t0 = Date.now();
for await (const ev of agent.run('用 glob 找出 src 目录下所有 .js 文件（不要用 shell），数一数有几个，并列出前 3 个路径。只回答结果。')) {
  if (ev.type === 'tool_start') used.push(ev.name);
  if (ev.type === 'text') text += ev.delta;
  if (ev.type === 'error') { console.log('ERR', ev.message); break; }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('tools used:', used.join(',') || '(none)');
console.log(`elapsed: ${secs}s  steps: ${agent.usageTotal.steps}  tokens: ${agent.usageTotal.input}/${agent.usageTotal.output}`);
console.log('reply:', text.trim().slice(0, 300));
const ok = used.includes('glob') && /src/.test(text);
console.log(ok ? 'LIVE TEST PASSED' : 'LIVE TEST FAILED');
disposeShell();
process.exitCode = ok ? 0 : 1;
await new Promise((r) => setTimeout(r, 80));
