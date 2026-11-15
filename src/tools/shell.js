// shell tool — a *persistent* shell session (like pi), so cwd/env survive
// between calls and repeated commands stay fast.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { uid, fmtDuration } from '../util.js';
import { detectShell } from '../config.js';
import { jobs } from '../jobs.js';

const MAX_OUT = 24 * 1024;
const DEFAULT_TIMEOUT = 120_000;

export class ShellSession {
  constructor({ shellPath, cwd = process.cwd(), env = {} } = {}) {
    this.shellPath = shellPath || detectShell();
    this.base = path.basename(this.shellPath).toLowerCase();
    this.kind = this.base.includes('bash') || this.base.includes('sh') || this.base.includes('zsh') ? 'posix' : this.base.includes('powershell') || this.base.includes('pwsh') ? 'pwsh' : 'cmd';
    this.cwd = cwd;
    this.env = env;
    this.proc = null;
    this.queue = Promise.resolve();
    this.buf = '';
    this.waiters = [];
    this.alive = false;
  }

  start() {
    if (this.alive) return;
    const args = this.kind === 'posix' ? ['--noprofile', '--norc'] : this.kind === 'pwsh' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : [];
    const env = {
      ...process.env,
      ...this.env,
      PS1: '',
      PS2: '',
      TERM: 'dumb',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      COLUMNS: '200',
      AGENT_TUI: '1',
    };
    this.proc = spawn(this.shellPath, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.alive = true;
    // 记下这一份 proc：中断/超时会 kill() 并重启，旧进程的 exit 事件不能把
    // 新会话的 waiter 当成“shell 已死”给解决掉。
    const proc = this.proc;
    const onData = (d) => {
      if (this.proc !== proc) return;
      this.buf += d.toString('utf8');
      this._flush();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.alive = false;
      this._flush(true);
    });
    proc.on('error', () => {
      if (this.proc !== proc) return;
      this.alive = false;
      this._flush(true);
    });
  }

  _flush(dead = false) {
    if (!this.waiters.length) return;
    const w = this.waiters[0];
    const idx = this.buf.indexOf(w.marker);
    if (idx >= 0) {
      const raw = this.buf.slice(0, idx);
      const after = this.buf.slice(idx + w.marker.length);
      const nl = after.indexOf('\n');
      const tail = nl >= 0 ? after.slice(0, nl) : after;
      this.buf = nl >= 0 ? after.slice(nl + 1) : '';
      this.waiters.shift();
      const m = /^(-?\d+):(.*)$/s.exec(tail.trim());
      if (m) this.cwd = normalizeCwd(m[2].trim()) || this.cwd;
      w.resolve({ out: raw, code: m ? Number(m[1]) : 0, exitCodeKnown: !!m });
      return;
    }
    if (dead) {
      this.waiters.shift();
      w.resolve({ out: this.buf, code: 142, exitCodeKnown: false, dead: true });
      this.buf = '';
    }
  }

  run(command, { timeout = DEFAULT_TIMEOUT, onProgress, signal } = {}) {
    const job = () => this._runOnce(command, timeout, onProgress, signal);
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => {});
    return p;
  }

  async _runOnce(command, timeout, onProgress, signal) {
    this.start();
    if (!this.alive) {
      // restart once
      this.proc = null;
      this.start();
    }
    const marker = `__AGENT_${uid()}__`;
    const markerLine =
      this.kind === 'posix'
        ? `printf '\\n%s:%s:%s\\n' '${marker}' "$?" "$PWD"`
        : this.kind === 'pwsh'
          ? `Write-Output ("${marker}:$($LASTEXITCODE):$(Get-Location)")`
          : `echo ${marker}:%errorlevel%:%CD%`;

    const wrapped =
      this.kind === 'posix'
        ? `${command}\n__agent_rc=$?\n${markerLine}\n`
        : this.kind === 'pwsh'
          ? `${command}\n${markerLine}\n`
          : `${command} & ${markerLine}\r\n`;

    const started = Date.now();
    const result = await new Promise((resolve) => {
      let done = false;
      const waiter = { marker: `${marker}:`, resolve: null };
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(tick);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      waiter.resolve = finish;
      this.waiters.push(waiter);
      const tick = setInterval(() => onProgress?.(this.buf.slice(-2000)), 500);
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        this.kill();
        const out = this.buf + `\n[命令超时 ${fmtDuration(timeout)}，已终止 shell]`;
        this.buf = '';
        finish({ out, code: 124, timedOut: true });
      }, timeout);
      // 用户按 ESC/Ctrl+C：立刻杀掉整棵进程树，不等它自己跑完
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        const out = this.buf + '\n[命令被用户中断，已终止 shell]';
        this.buf = '';
        this.kill();
        finish({ out, code: 130, aborted: true });
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        this.proc.stdin.write(wrapped);
      } catch {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        finish({ out: '无法写入 shell stdin', code: 1, dead: true });
      }
    });

    let out = result.out;
    // remove the echo of the command itself if the shell echoed input
    out = out.replace(/\r\n/g, '\n').replace(/^[\s\S]{0,0}/, '');
    const dur = Date.now() - started;
    const { text, truncated, total } = truncate(out);
    return { out: text, code: result.code ?? 0, dur, truncated, total, aborted: !!result.aborted, timedOut: !!result.timedOut, killed: !!result.dead && !result.aborted && !result.timedOut };
  }

  kill() {
    const pid = this.proc?.pid;
    try {
      this.proc?.stdin?.end();
      this.proc?.kill('SIGKILL');
    } catch {}
    try {
      if (process.platform === 'win32' && pid) {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 4000 });
      }
    } catch {}
    this.alive = false;
    // 外部（浏览器面板）杀掉时，正在等的 waiter 必须立刻收到结果，否则会挂到超时。
    this._flush(true);
    this.proc = null;
  }

  dispose() {
    this.kill();
  }
}

function normalizeCwd(p) {
  if (!p) return null;
  if (process.platform === 'win32') {
    // /d/project/x -> D:/project/x
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  }
  return p;
}

function truncate(s) {
  const total = Buffer.byteLength(s);
  if (total <= MAX_OUT) {
    return { text: s.replace(/\s+$/, ''), truncated: false, total };
  }
  const lines = s.split('\n');
  const head = lines.slice(0, 160).join('\n');
  const tail = lines.slice(-60).join('\n');
  const text = `${head}\n…[输出过长已截断 ${lines.length - 220} 行]…\n${tail}`.slice(0, MAX_OUT);
  return { text, truncated: true, total };
}

let sharedSession = null;
export function getShell(cwd) {
  if (!sharedSession || !sharedSession.alive) {
    sharedSession = new ShellSession({ cwd: cwd || process.cwd() });
    sharedSession.start();
  }
  return sharedSession;
}
export function disposeShell() {
  if (sharedSession) sharedSession.dispose();
  sharedSession = null;
}

export const shellTool = {
  name: 'shell',
  label: 'Shell',
  description:
    '在持久化的 shell 会话中执行命令（cwd 与环境在多次调用间保留）。适合搜索、git、构建、测试、列目录。' +
    '输出过长会自动截断。不要用它来读整文件（用 read），也不要用来改文件（用 edit/write）。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: { type: 'number', description: '超时毫秒数（默认 120000）' },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    if (!input.command) return { isError: true, content: '缺少 command 参数' };
    const shell = getShell(ctx.cwd);
    const timeout = Math.max(5000, Math.min(600_000, Number(input.timeout) || DEFAULT_TIMEOUT));
    // 登记到浏览器后端：玩家能看到每条 shell 的命令、实时尾巴、退出码，并能手动终止。
    const job = jobs.add({
      command: String(input.command),
      cwd: shell.cwd || ctx.cwd,
      source: ctx.depth ? `子代理(层${ctx.depth})` : '主代理',
      session: ctx.sessionId || '',
      timeout,
    });
    job.kill = () => shell.kill();
    const r = await shell.run(String(input.command), {
      timeout,
      onProgress: (t) => {
        jobs.progress(job.id, t);
        ctx.onProgress?.(t);
      },
      signal: ctx.signal,
    });
    jobs.end(job.id, {
      code: r.code,
      dur: r.dur,
      output: r.out,
      truncated: r.truncated,
      status: r.aborted ? 'killed' : r.timedOut ? 'timeout' : r.killed ? 'killed' : r.code === 0 ? 'ok' : 'error',
    });
    const head = r.aborted || r.killed ? '[被用户中断] ' : r.code === 0 ? '' : `[exit ${r.code}] `;
    const tail = r.truncated ? `\n[输出已截断，共 ${(r.total / 1024).toFixed(1)}KB]` : '';
    return {
      isError: r.aborted || r.killed || r.code !== 0,
      content: `${head}${r.out || '(无输出)'}${tail}`,
      meta: { kind: 'shell', command: input.command, code: r.code, dur: r.dur, cwd: shell.cwd, truncated: r.truncated, jobId: job.id },
    };
  },
};

export const shellInfo = () => {
  const s = sharedSession;
  return s ? { shell: s.shellPath, kind: s.kind, cwd: s.cwd } : null;
};

/** 给系统提示用的 shell 说明：模型必须知道当前是哪种 shell，否则会写错语法（如 Git Bash 下的 `cd /d`）。 */
export function describeShell() {
  const shellPath = detectShell();
  const base = path.basename(shellPath).toLowerCase();
  const kind = base.includes('bash') || base.includes('sh') || base.includes('zsh')
    ? 'posix'
    : base.includes('powershell') || base.includes('pwsh')
      ? 'pwsh'
      : 'cmd';
  if (kind === 'posix') {
    return {
      kind,
      shellPath,
      text:
        `- shell: ${shellPath}（POSIX / Git Bash，不是 cmd.exe）\n` +
        '  - 用 POSIX 语法：`cmd1 && cmd2`、`$VAR`、`$(...)`、`/d/project/x` 这样的路径都能用；D:\\project\\x 也行。\n' +
        '  - 不要用 cmd.exe 语法：`cd /d D:\\x` 会报 “cd: too many arguments”（/d 被当成第二个参数），直接 `cd D:/x` 或 `cd /d/x`。\n' +
        '  - 不要用 `dir`/`set`/`where`；用 `ls`/`env`/`which`。反斜杠是转义符，路径优先写成正斜杠。',
    };
  }
  if (kind === 'pwsh') {
    return {
      kind,
      shellPath,
      text:
        `- shell: ${shellPath}（PowerShell）\n` +
        '  - 用 PowerShell 语法（管道、Where-Object 等），`;` 或换行分隔命令，路径用 D:\\Works\\x。',
    };
  }
  return {
    kind,
    shellPath,
    text:
      `- shell: ${shellPath}（cmd.exe）\n` + '  - 用 cmd 语法：`cd /d D:\\x`、`&&`、`%VAR%`、`dir`。',
  };
}

void os;
void fs;
