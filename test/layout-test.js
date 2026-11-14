// Layout invariants: a frame is at most H-1 rows (one spare row so a force-wrap
// scroll can never eat the header) and never wider than W-1 columns.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layout-'));
process.env.AGENT_HOME = HOME;
const { Config } = await import('../src/config.js');
const { App } = await import('../src/ui/app.js');
const { stripAnsi, strWidth } = await import('../src/util.js');

const log = (m = '') => fs.writeSync(1, m + '\n');
const SIZES = [[40, 12], [50, 14], [60, 16], [70, 18], [80, 24], [90, 20], [100, 30], [120, 30], [140, 40], [160, 50]];
let failed = 0;

for (const [W, H] of SIZES) {
  const app = new App({ config: new Config(), cwd: process.cwd() });
  app.width = W;
  app.height = H;
  app.seedDemo();
  let frame;
  try {
    frame = app.buildFrame();
  } catch (e) {
    failed++;
    log(`× ${W}x${H} threw: ${e.message}`);
    continue;
  }
  const over = frame.map((l) => strWidth(stripAnsi(l))).filter((w) => w > W - 1).length;
  const ok = frame.length <= H - 1 && over === 0;
  if (!ok) failed++;
  log(`${ok ? '√' : '×'} ${W}x${H}: rows=${frame.length} over-wide=${over}`);

  // plain (non-demo) frame too: welcome banner + empty input
  const app2 = new App({ config: new Config(), cwd: process.cwd() });
  app2.width = W;
  app2.height = H;
  app2.pushWelcome();
  const f2 = app2.buildFrame();
  const over2 = f2.map((l) => strWidth(stripAnsi(l))).filter((w) => w > W - 1).length;
  if (f2.length > H - 1 || over2) {
    failed++;
    log(`× ${W}x${H} welcome: rows=${f2.length} over-wide=${over2}`);
  }
}

// prompt + completion popup must also fit
const app = new App({ config: new Config(), cwd: process.cwd() });
app.width = 60;
app.height = 20;
app.input = { text: '/', cursor: 1 };
const f = app.buildFrame();
const over = f.map((l) => strWidth(stripAnsi(l))).filter((w) => w > 59).length;
if (f.length > 19 || over) {
  failed++;
  log(`× popup frame at 60x20: rows=${f.length} over-wide=${over}`);
} else log('√ popup frame fits 60x20');

log(failed ? `\n${failed} LAYOUT CHECK(S) FAILED` : '\nALL LAYOUT CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
await new Promise((r) => setTimeout(r, 30));
