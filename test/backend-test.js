// 后端：命令登记表 + /shell、/spawn 页面与 API
import assert from 'node:assert/strict';
import { ProgressHub } from '../src/progress.js';
import { jobs } from '../src/jobs.js';
import { parseMemberLines } from '../src/spawn.js';

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

console.log('parseMemberLines');
ok('解析名字|角色|任务|文件', () => {
  const ms = parseMemberLines('阿岩 | 后端 | 写 /api/login | src/a.js, test/a-test.js\n# 注释\n小满|前端|接表单');
  assert.equal(ms.length, 2);
  assert.equal(ms[0].name, '阿岩');
  assert.equal(ms[0].role, '后端');
  assert.equal(ms[0].task, '写 /api/login');
  assert.deepEqual(ms[0].files, ['src/a.js', 'test/a-test.js']);
  assert.equal(ms[1].task, '接表单');
  assert.deepEqual(ms[1].files, []);
});
ok('任务里带竖线不丢', () => {
  const [m] = parseMemberLines('甲|开发|先跑 A | 再跑 B');
  assert.equal(m.task, '先跑 A | 再跑 B');
});

console.log('hub 路由');
const hub = new ProgressHub({ port: 7893 });
await hub.ensure();
const base = hub.url.replace(/\/$/, '');
try {
  const shellPage = await (await fetch(base + '/shell')).text();
  ok('/shell 页面含轮询与终止', () => {
    assert.match(shellPage, /\/api\/shell/);
    assert.match(shellPage, /终止/);
  });
  const spawnPage = await (await fetch(base + '/spawn')).text();
  ok('/spawn 页面含表单与 API', () => {
    assert.match(spawnPage, /\/api\/spawn/);
    assert.match(spawnPage, /members/);
  });
  const list = await (await fetch(base + '/api/shell')).json();
  ok('/api/shell 返回 jobs 数组', () => assert.ok(Array.isArray(list.jobs)));
  const dj = jobs.add({ command: 'echo detail', cwd: '.', timeout: 1000 });
  jobs.end(dj.id, { code: 0, dur: 1, output: 'hi\n', status: 'ok' });
  const detail = await (await fetch(base + '/api/shell?id=' + encodeURIComponent(dj.id))).json();
  ok('/api/shell?id 返回输出', () => assert.equal(detail.job.output, 'hi\n'));
  const notFound = await fetch(base + '/api/shell?id=nope');
  ok('未知 id 404', () => assert.equal(notFound.status, 404));

  let seen = null;
  hub.onSpawn = async (p) => {
    seen = p;
    return { ok: true, content: '已开工', url: base };
  };
  const r = await fetch(base + '/api/spawn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'solo', task: 'x' }),
  });
  const out = await r.json();
  ok('POST /api/spawn 调到 onSpawn', () => {
    assert.equal(r.status, 200);
    assert.equal(out.content, '已开工');
    assert.equal(seen.kind, 'solo');
  });
  hub.onSpawn = null;
  const r2 = await fetch(base + '/api/spawn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'solo', task: 'x' }),
  });
  const d2 = await r2.json();
  ok('没接 onSpawn 时 409 并提示', () => {
    assert.equal(r2.status, 409);
    assert.match(d2.content, /\/progress/);
  });
} finally {
  hub.stop();
}

console.log('\n' + pass + ' checks passed');
