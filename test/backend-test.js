// 后端：命令登记表（shell 任务记录 / 输出尾巴 / 终止）
import assert from 'node:assert/strict';
import { jobs } from '../src/jobs.js';

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ok', name);
  } catch (e) {
    console.error('  FAIL', name, '\n   ', e.message);
    process.exitCode = 1;
  }
};

console.log('jobs');
const j = jobs.add({ command: 'echo hi', cwd: 'D:/tmp', source: '主代理', timeout: 5000 });
ok('add 返回 id 与 running', () => {
  assert.ok(j.id);
  assert.equal(j.status, 'running');
});
jobs.progress(j.id, 'hi\n');
ok('progress 记录尾巴', () => assert.match(jobs.get(j.id).tail, /hi/));
jobs.end(j.id, { code: 0, dur: 12, output: 'hi\n', status: 'ok' });
ok('end 置 ok 且保留输出', () => {
  const x = jobs.get(j.id);
  assert.equal(x.status, 'ok');
  assert.equal(x.output, 'hi\n');
  assert.equal(x.bytes, 3);
});
ok('list 带 preview 不含 output', () => {
  const row = jobs.list().find((x) => x.id === j.id);
  assert.ok(row);
  assert.equal(row.output, undefined);
  assert.match(row.preview, /hi/);
});
const k = jobs.add({ command: 'sleep', cwd: '.', timeout: 1000 });
let killed = 0;
k.kill = () => killed++;
ok('kill 调回调并置 killed', () => {
  const out = jobs.kill(k.id);
  assert.equal(out.ok, true);
  assert.equal(killed, 1);
  assert.equal(jobs.get(k.id).status, 'killed');
});
ok('clear 保留运行中任务', () => {
  const run = jobs.add({ command: 'node x', cwd: '.' });
  const kept = jobs.clear();
  assert.ok(kept >= 1);
  assert.ok(jobs.get(run.id));
  jobs.end(run.id, { code: 0, output: '' });
});

console.log('\n' + pass + ' checks passed');
