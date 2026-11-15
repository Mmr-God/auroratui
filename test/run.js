// Test runner: node test/run.js [--live]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const live = process.argv.includes('--live');
const suites = ['loop-test.js', 'tools-test.js', 'ui-sim.js', 'paste-test.js', 'askpaste-test.js', 'layout-test.js', 'toolview-test.js', 'features-test.js', 'backend-test.js', 'collab-test.js', 'image-test.js', 'draw-test.js', 'highlight-test.js'];
if (live) suites.push('live-test.mjs');

let failed = 0;
for (const suite of suites) {
  process.stdout.write(`\n──── ${suite} ────\n`);
  const r = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit', cwd: path.resolve(here, '..') });
  if (r.status !== 0) failed++;
}
process.stdout.write(failed ? `\n${failed} suite(s) failed\n` : '\n全部测试通过\n');
process.exit(failed ? 1 : 0);
