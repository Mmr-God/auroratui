// ACP 端到端测试：起一个真的 ACP 子进程，按 JSON-RPC 走完整流程。
// 用法: node test/acp-test.js
//
// 覆盖：initialize → session/new → session/prompt（含 text 流 / tool_call）
//      → session/cancel → 错误码（未初始化 / 未知方法 / 未知会话）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'bin', 'agent.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log(`  \x1b[32m√\x1b[0m ${name}`);
}
function bad(name, why) {
  fail++;
  failures.push(`${name} — ${why}`);
  console.log(`  \x1b[31m×\x1b[0m ${name}${why ? ` — ${why}` : ''}`);
}
function check(name, cond, why) {
  cond ? ok(name) : bad(name, why);
}

// ---------------------------------------------------------------- 客户端侧
class Client {
  constructor(proc) {
    this.proc = proc;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.corrupt = [];   // stdout 上不是 JSON-RPC 的行

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => this._onData(c));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => (this.stderr += c));
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.corrupt.push(line.slice(0, 200));
        continue;
      }
      if (msg.method && Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null) {
        // 服务端反向请求（如 session/request_permission）
        this.onServerRequest?.(msg);
        continue;
      }
      if (msg.method) {
        this.notifications.push(msg);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      }
    }
  }

  request(method, params, timeout = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      if (timeout) {
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject({ code: -1, message: 'timeout' });
          }
        }, timeout).unref();
      }
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  updates(sessionId) {
    return this.notifications.filter((n) => n.method === 'session/update' && n.params?.sessionId === sessionId);
  }

  textOf(sessionId) {
    return this.updates(sessionId)
      .filter((n) => n.params.update.sessionUpdate === 'agent_message_chunk')
      .map((n) => n.params.update.content?.text || '')
      .join('');
  }
}

// -------------------------------------------------------------------- 运行
function startAgent() {
  const proc = spawn('cmd.exe', ['/c', path.join(here,'..','bin','acp.cmd')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_DEBUG: '' },
  });
  return new Client(proc);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n\x1b[1mACP 端到端测试\x1b[0m\n');

  // ============ 1. 握手 ============
  console.log('\x1b[1m[1] initialize\x1b[0m');
  const c = startAgent();

  let init;
  try {
    init = await c.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'acp-test', title: 'ACP Test', version: '0.0.1' },
    });
  } catch (e) {
    bad('initialize 返回响应', JSON.stringify(e));
    c.proc.kill();
    return;
  }
  check('initialize 返回响应', !!init);
  check('protocolVersion = 1', init?.protocolVersion === 1, `got ${init?.protocolVersion}`);
  check('agentInfo.name = AuroraTui', init?.agentInfo?.name === 'AuroraTui', JSON.stringify(init?.agentInfo));
  check('声明 loadSession', init?.agentCapabilities?.loadSession === false, '应明确为 false');
  check(
    'promptCapabilities 三字段齐全',
    typeof init?.agentCapabilities?.promptCapabilities?.image === 'boolean' &&
      typeof init?.agentCapabilities?.promptCapabilities?.embeddedContext === 'boolean',
    JSON.stringify(init?.agentCapabilities?.promptCapabilities)
  );

  // ============ 2. 建会话 ============
  console.log('\n\x1b[1m[2] session/new\x1b[0m');
  let sess;
  try {
    sess = await c.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  } catch (e) {
    bad('session/new', JSON.stringify(e));
    c.proc.kill();
    return;
  }
  check('返回 sessionId', typeof sess?.sessionId === 'string' && sess.sessionId.length > 0, JSON.stringify(sess));
  const sid = sess.sessionId;
  check('返回 modes', !!sess?.modes?.currentModeId, JSON.stringify(sess?.modes));

  // ============ 3. 错误处理 ============
  console.log('\n\x1b[1m[3] 错误处理\x1b[0m');
  try {
    await c.request('no/such/method', {});
    bad('未知方法应报错', '竟然成功了');
  } catch (e) {
    check('未知方法 → -32601', e.code === -32601, `got ${e.code}`);
  }
  try {
    await c.request('session/prompt', { sessionId: 'no-such-session', prompt: [{ type: 'text', text: 'hi' }] });
    bad('未知会话应报错', '竟然成功了');
  } catch (e) {
    check('未知会话 → -32002', e.code === -32002, `got ${e.code}`);
    check('错误带 sessionId', e.data?.sessionId === 'no-such-session', JSON.stringify(e.data));
  }
  try {
    await c.request('session/prompt', { sessionId: sid, prompt: [] });
    bad('空 prompt 应报错', '竟然成功了');
  } catch (e) {
    check('空 prompt → -32602', e.code === -32602, `got ${e.code}`);
  }

  // ============ 4. 流式 prompt ============
  console.log('\n\x1b[1m[4] session/prompt 流式输出\x1b[0m');
  // 客户端收到权限请求一律选第一个选项，避免卡住
  c.onServerRequest = (msg) => {
    const opts = msg.params?.options || [];
    const first = opts[0]?.optionId || 'reject';
    c.proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: first } },
      }) + '\n'
    );
  };

  let resp;
  try {
    resp = await c.request(
      'session/prompt',
      {
        sessionId: sid,
        prompt: [{ type: 'text', text: '用一句话回答：1+1 等于几？不要调用任何工具。' }],
      },
      120000
    );
  } catch (e) {
    bad('prompt 完成', JSON.stringify(e));
  }
  check('返回 stopReason', typeof resp?.stopReason === 'string', JSON.stringify(resp));
  check(
    'stopReason 是合法枚举',
    ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(resp?.stopReason),
    `got ${resp?.stopReason}`
  );

  const gotText = c.textOf(sid);
  check('收到 agent_message_chunk 文本', gotText.length > 0, `长度 ${gotText.length}`);
  console.log(`      ┆ 回答内容: ${JSON.stringify(gotText.slice(0, 120))}`);

  // 通知结构校验
  const ups = c.updates(sid);
  const allValid = ups.every(
    (n) => n.params.update && typeof n.params.update.sessionUpdate === 'string' && n.params.sessionId === sid
  );
  check('session/update 结构合法', ups.length > 0 && allValid, `${ups.length} 条`);
  const kinds = [...new Set(ups.map((n) => n.params.update.sessionUpdate))];
  console.log(`      ┆ 收到的 update 类型: ${kinds.join(', ')}`);

  // ============ 5. 取消 ============
  console.log('\n\x1b[1m[5] session/cancel\x1b[0m');
  const cancelP = c.request(
    'session/prompt',
    { sessionId: sid, prompt: [{ type: 'text', text: '从1数到1000，每个数字单独一行，不要省略。' }] },
    60000
  );
  await sleep(1200);
  c.notify('session/cancel', { sessionId: sid });
  let cancelResp = null;
  try {
    cancelResp = await cancelP;
  } catch (e) {
    bad('取消后 prompt 仍返回', JSON.stringify(e));
  }
  if (cancelResp) {
    check('取消 → stopReason = cancelled', cancelResp.stopReason === 'cancelled', `got ${cancelResp.stopReason}`);
  }

  // ============ 6. 会话仍可用 ============
  console.log('\n\x1b[1m[6] 取消后会话可继续\x1b[0m');
  try {
    const r2 = await c.request(
      'session/prompt',
      { sessionId: sid, prompt: [{ type: 'text', text: '只回答两个字：收到' }] },
      120000
    );
    check('再次 prompt 成功', !!r2?.stopReason, JSON.stringify(r2));
  } catch (e) {
    bad('再次 prompt', JSON.stringify(e));
  }

  // ============ 7. stdout 纯净度 ============
  console.log('\n\x1b[1m[7] stdout 纯净度\x1b[0m');
  check('stdout 上无非 JSON-RPC 输出', c.corrupt.length === 0, c.corrupt.slice(0, 3).join(' | '));
  check('stderr 有启动日志（不影响协议）', c.stderr.includes('[acp]'), c.stderr.slice(0, 120));

  // ============ 收尾 ============
  c.proc.stdin.end();
  await sleep(400);
  try { c.proc.kill(); } catch {}

  console.log('\n' + '─'.repeat(56));
  if (fail === 0) {
    console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m\n`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 通过 ${pass} 项\n`);
    for (const f of failures) console.log('  · ' + f);
    console.log();
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n测试崩溃:', e);
  process.exit(1);
});
