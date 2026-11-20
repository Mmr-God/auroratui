// shell tool — a *persistent* shell session (like pi), so cwd/env survive
// between calls and repeated commands stay fast.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { uid, fmtDuration } from '../util.js';
import { detectShell } from '../config.js';
import { jobs } from '../jobs.js';
import { guardShellScope } from './scope.js';

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
    if (this.alive) return true;
    // 重启前先把上一条命令的残渣清干净（旧 proc 的 marker 不能留给新命令）
    this.buf = '';
    this.waiters.length = 0;
    // spawn 的 cwd 不存在时 Node 报的是 “spawn xxx ENOENT”（看起来像可执行文件找不到，
    // 实际是目录没了）。团队/子代理常在某临时目录里干活、跑完就被删，
    // 这时必须回退到现有目录，否则整个 shell 工具直接不可用。
    if (!this.cwd || !safeIsDir(this.cwd)) this.cwd = process.cwd();
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
    try {
      this.proc = spawn(this.shellPath, args, {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.proc = null;
      this.alive = false;
      this.startError = `shell 没启动起来（${this.shellPath}）：${e?.message || e}`;
      return false;
    }
    this.alive = true;
    this.startError = '';
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
    proc.on('exit', (code, sig) => {
      if (process.env.SHDIAG) console.error('[EXIT] pid=' + proc.pid + ' code=' + code + ' sig=' + sig + ' same=' + (this.proc === proc) + ' buf=' + JSON.stringify(this.buf.slice(0,80)) + ' waiters=' + this.waiters.length);
      if (this.proc !== proc) return;
      this.alive = false;
      this._flush(true, proc);
      // flush 之后再置 null：让下一次 _runOnce 的“进程已死”判定一定命中
      this.proc = null;
    });
    proc.on('error', (e) => {
      if (process.env.SHDIAG) console.error('[ERR] pid=' + proc.pid + ' msg=' + e.message + ' same=' + (this.proc === proc));
      if (this.proc !== proc) return;
      this.alive = false;
      this._flush(true, proc);
      this.proc = null;
    });
  }

  _flush(dead = false, dyingProc = null) {
    if (!this.waiters.length) return;
    const w = this.waiters[0];
    // 死消息只对「死在它自己那个进程上」的 waiter 有效：shell 重启后
    // 旧进程的 exit/error 事件可能晚一步到达，不能把新会话的 waiter 当成
    // “shell 已死”抹成 142（表现为跑 echo 返回「被用户中断」）。
    // dyingProc 明确告知“死的是哪个 proc”，不能用 this.proc 比（它可能已被置 null）。
    if (dead && dyingProc && w.proc !== dyingProc) return;
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
    // 进程死了（比如上一条命令就是 `exit 3`）就重开一份。
    // 坑：不能只看 this.alive —— `exit` 事件是异步的，命令返回时事件可能还没送到，
    // 这时 alive 仍是 true，于是命令被写进已死进程的 stdin，随后的 error/exit
    // 回调把**新** waiter 当成“shell 已死”抹成 142「被用户中断」。
    // stdin.writable 在进程死时立刻变 false，比 exit 事件早，是可靠的存活探针。
    const proc0 = this.proc;
    const processGone =
      !this.alive ||
      !proc0 ||
      proc0.exitCode !== null ||
      proc0.signalCode !== null ||
      !proc0.stdin ||
      proc0.stdin.destroyed ||
      proc0.stdin.writable === false;
    if (processGone) {
      this.proc = null;
      this.buf = '';
      this.waiters.length = 0;
      const started = this.start();
      if (started === false || !this.proc) {
        // 启动失败（shell 丢了 / cwd 不可用）：直接给出人看得懂的错误，
        // 不要 push waiter 到没有进程的队列里等满超时。
        return {
          out: this.startError || 'shell 没能启动',
          code: 127,
          dur: 0,
          startFailed: true,
        };
      }
    }
    const marker = `__AGENT_${uid()}__`;
    // posix 分支上面已经用 __agent_rc 存下了真实退出码，这里必须读变量；
    // 直接写 "$?" 拿到的是 `__agent_rc=$?` 这条赋值语句自己的状态（永远是 0），
    // 会让所有 bash 命令都报 code=0，验收/失败判定全失灵。
    const markerLine =
      this.kind === 'posix'
        ? `printf '\\n%s:%s:%s\\n' '${marker}' "$__agent_rc" "$PWD"`
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
      const waiter = { marker: `${marker}:`, resolve: null, proc: this.proc };
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
      // timeout <= 0 表示不限时（后台任务用），绝不能传给 setTimeout（0 会立刻触发）
      const timer = timeout > 0 ? setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        this.kill();
        const out = this.buf + `\n[命令超时 ${fmtDuration(timeout)}，已终止 shell]`;
        this.buf = '';
        finish({ out, code: 124, timedOut: true });
      }, timeout) : null;
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
    // 外部（jobs.kill）杀掉时，正在等的 waiter 必须立刻收到结果，否则会挂到超时。
    this._flush(true, this.proc);
    this.proc = null;
    // 缓冲和队列必须一起清：这份 session 会被 getShell() 复用，
    // 残留的 buf 里还带着上一条命令的 marker，下一次命令一读就会拿到旧结果
    // （表现为「跑 echo 却返回 142 被中断」）。
    this.buf = '';
    this.waiters.length = 0;
  }

  dispose() {
    this.kill();
  }
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
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
/**
 * 一个进程只留一份常驻 shell（**懒启动**）。
 *
 * 以前的写法是「第一次用就 new 一份并且立刻 start()」。问题在 Windows 上很扎眼：
 * Git Bash 的 bash.exe 会拉一整串 Git for Windows 的进程（usr/bin/bash + 控制台宿主
 * + git 辅助进程），每份十几 MB；玩家开几个 agent 窗口就是好几份，加起来非常可观。
 * 更要命的是测试 / 子进程只要 import 了本模块就可能早早把 bash 拉起来。
 *
 * 现在改成：
 *   · 没真跑命令之前不起进程（第一次 shell 调用才 start）
 *   · 一个进程内复用同一份（持久 cwd/env 本来就要这个语义）
 *   · 进程退出时 bin/agent.js 的 finally 会 disposeShell()，不会留在后台
 */
export function getShell(cwd) {
  if (sharedSession) return sharedSession;
  sharedSession = new ShellSession({ cwd: cwd || process.cwd() });
  // 这里不 start()：交给 _runOnce 在真的要跑命令时启动（懒启动，省进程/内存）
  return sharedSession;
}
export function disposeShell() {
  if (sharedSession) sharedSession.dispose();
  sharedSession = null;
}

/**
 * 后台运行：不 await，立刻把 jobId 还给模型。
 * 之所以还是走同一个 shell：持久会话的 cwd/env 是模型已经习惯的东西，
 * 另起进程反而会让 `cd` 之类的状态对不上。代价是后台命令跑着的时候，
 * 下一条前台命令会排队等它（ShellSession.run 里有串行队列）——这点写进了工具描述里。
 */
function runBackground(command, ctx) {
  const shell = getShell(ctx.cwd);
  const job = jobs.add({
    command,
    cwd: shell.cwd || ctx.cwd,
    source: ctx.depth ? `子代理(层${ctx.depth})` : '主代理',
    session: ctx.sessionId || '',
    timeout: 0,
    background: true,
  });
  job.kill = () => shell.kill();
  // 不 await：这里就是要立刻返回。但仍要挂 catch，否则失败会变成未处理的 rejection。
  shell
    .run(command, {
      timeout: 0, // 0 = 不限时，后台命令自己负责退出（由 jobs.kill 收尾）
      onProgress: (t) => jobs.progress(job.id, t),
      signal: ctx.signal,
    })
    .then((r) => {
      jobs.end(job.id, {
        code: r.code,
        dur: r.dur,
        output: r.out,
        truncated: r.truncated,
        status: r.aborted ? 'killed' : r.timedOut ? 'timeout' : r.killed ? 'killed' : r.code === 0 ? 'ok' : 'error',
      });
    })
    .catch((e) => {
      jobs.end(job.id, { code: 1, output: `后台任务异常: ${e?.message || e}`, status: 'error' });
    });
  return {
    content:
      `已在后台启动（jobId=${job.id}）：${command}\n` +
      '用 jobs 工具 action="tail" 看它的实时输出，action="list" 看所有任务，action="kill" 终止它。\n' +
      '注意：它还在跑的时候，下一条前台 shell 命令会排队等它结束。',
    meta: { kind: 'shell', command, background: true, jobId: job.id },
  };
}

export const shellTool = {
  name: 'shell',
  label: 'Shell',
  description:
    '在持久化的 shell 会话中执行命令（cwd 与环境在多次调用间保留）。适合搜索、git、构建、测试、列目录。' +
    '输出过长会自动截断。不要用它来读整文件（用 read），也不要用来改文件（用 edit/write）。\n' +
    'background=true 时命令在后台跑、立刻返回 jobId（适合 dev server、长时间构建、watch 模式）；' +
    '之后用 jobs 工具（action=tail/kill）看输出和终止它。注意后台命令仍占着这个 shell，' +
    '下一条前台命令会等它跑完——需要同时跑多条就只能先收工或 kill。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: { type: 'number', description: '超时毫秒数（默认 120000）' },
      background: { type: 'boolean', description: '后台运行：立刻返回 jobId，不阻塞对话（之后用 jobs 工具查输出/终止）' },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    if (!input.command) return { isError: true, content: '缺少 command 参数' };
    // 团队成员的「文件范围」：fs/patch 已拦，但 shell 是个后门（echo x > 同事的文件）。
    // 只有带 writeScope 的上下文（团队成员）才会真的检查，主代理/单发子代理不受影响。
    const denied = guardShellScope(input.command, ctx);
    if (denied) return denied;
    if (input.background) return runBackground(String(input.command), ctx);
    const shell = getShell(ctx.cwd);
    const timeout = Math.max(5000, Math.min(600_000, Number(input.timeout) || DEFAULT_TIMEOUT));
    // 登记到 job 表：玩家能看到每条 shell 的命令、实时尾巴、退出码，并能手动终止（jobs.list/kill）。
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
