// Lifecycle hooks (Claude-Code style): run shell commands around tool calls.
//
// Config shape (~/.agent/config.json):
//   "hooks": {
//     "preToolUse":  [ { "match": "shell",  "command": "node .agent/hooks/guard.js", "block": true } ],
//     "postToolUse": [ { "match": "write|edit", "command": "npx prettier --write \"$AGENT_FILE\"" } ]
//   }
//
// The hook gets the call as JSON on stdin:
//   { "event":"pre-tool"|"post-tool", "tool":"shell", "input":{...}, "cwd":"...",
//     "isError":false, "content":"…(post only, 前 4000 字)" }
// Environment: AGENT_TOOL, AGENT_CWD, AGENT_SESSION, AGENT_TOOL_ERROR.
// Exit codes: 0 = pass (stdout recorded as a note), 2 = deny the tool (stderr shown
// to the model as the reason), other = warn only.
import { spawn } from 'node:child_process';

function matches(rule, name) {
  const pattern = String(rule.match || '*').trim();
  if (!pattern || pattern === '*') return true;
  return pattern
    .split(/[|,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

function runHook(rule, payload, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(String(rule.command), {
        shell: true,
        cwd: payload.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENT_TOOL: payload.tool,
          AGENT_CWD: payload.cwd,
          AGENT_SESSION: payload.session || '',
          AGENT_EVENT: payload.event,
          AGENT_TOOL_ERROR: payload.isError ? '1' : '0',
        },
      });
    } catch (e) {
      return finish({ code: 1, out, err: e.message });
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ code: 124, out, err: 'hook 超时' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ code: 1, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 0, out, err });
    });
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {}
  });
}

/** Run every pre hook matching the call. Returns { deny, reason, notes }. */
export async function runPreHooks(hooks, call, ctx = {}) {
  const list = (hooks?.preToolUse || []).filter((r) => r && r.command && matches(r, call.name));
  const notes = [];
  for (const rule of list) {
    const r = await runHook(rule, {
      event: 'pre-tool',
      tool: call.name,
      input: call.input || {},
      cwd: ctx.cwd || process.cwd(),
      session: ctx.sessionId || '',
    });
    const text = (r.out || r.err || '').trim();
    if (r.code === 2 && rule.block !== false) {
      return { deny: true, reason: text || `被 pre-tool hook 拒绝: ${rule.command}`, notes };
    }
    if (text) notes.push(`[pre ${call.name}] ${text.slice(0, 600)}`);
  }
  return { deny: false, notes };
}

/** Run post hooks; their output is appended to the tool result as a note. */
export async function runPostHooks(hooks, call, result, ctx = {}) {
  const list = (hooks?.postToolUse || []).filter((r) => r && r.command && matches(r, call.name));
  const notes = [];
  for (const rule of list) {
    const r = await runHook(rule, {
      event: 'post-tool',
      tool: call.name,
      input: call.input || {},
      cwd: ctx.cwd || process.cwd(),
      session: ctx.sessionId || '',
      isError: !!result?.isError,
      content: String(result?.content ?? '').slice(0, 4000),
    });
    const text = (r.out || r.err || '').trim();
    if (text) notes.push(`[post ${call.name}] ${text.slice(0, 600)}`);
  }
  return notes;
}

export function describeHooks(hooks) {
  const rows = [];
  for (const kind of ['preToolUse', 'postToolUse']) {
    for (const rule of hooks?.[kind] || []) {
      rows.push({ kind, match: rule.match || '*', command: rule.command, block: rule.block !== false });
    }
  }
  return rows;
}
