// Shell job registry: every shell command the agent runs is recorded here so the
// /shell and the TUI can list / tail / kill it. Kept dependency-free and tiny —
// progress.js subscribes, shell.js writes.
const MAX_JOBS = 200;
const MAX_OUTPUT = 60_000; // chars kept per job
const MAX_TAIL = 4000;

let seq = 0;

class JobRegistry {
  constructor() {
    this.jobs = [];
    this.listeners = new Set();
    this.timer = null;
  }

  add({ command, cwd, source = '主代理', session = '', timeout = 0, background = false } = {}) {
    const job = {
      // 时间戳与序号之间用分隔符：否则一个 id 可能是另一个 id 的前缀
      // （`shmwoqbxjs` 是 `shmwoqbxjs2` 的前缀），按前缀查找会误命中。
      id: `sh${Date.now().toString(36)}-${(++seq).toString(36)}`,
      command: String(command || ''),
      cwd: String(cwd || ''),
      source: String(source || '主代理'),
      session: String(session || ''),
      timeout: Number(timeout) || 0,
      background: !!background,
      status: 'running',
      code: null,
      started: Date.now(),
      ended: null,
      dur: 0,
      bytes: 0,
      tail: '',
      output: '',
      truncated: false,
      kill: null,
    };
    this.jobs.unshift(job);
    if (this.jobs.length > MAX_JOBS) {
      // 只淘汰已结束的老任务，运行中的一律保留
      for (let i = this.jobs.length - 1; i >= 0 && this.jobs.length > MAX_JOBS; i--) {
        if (this.jobs[i].status !== 'running') this.jobs.splice(i, 1);
      }
    }
    this._notify();
    return job;
  }

  update(id, patch = {}) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return null;
    Object.assign(j, patch);
    if (patch.tail != null) j.tail = String(patch.tail).slice(-MAX_TAIL);
    this._notify();
    return j;
  }

  progress(id, text) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    j.tail = String(text || '').slice(-MAX_TAIL);
    this._notify();
  }

  end(id, { code = 0, dur = 0, output = '', status = '', truncated = false } = {}) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return null;
    j.ended = Date.now();
    j.dur = Number(dur) || j.ended - j.started;
    j.code = code;
    j.status = status || (code === 0 ? 'ok' : 'error');
    j.output = String(output || '').slice(0, MAX_OUTPUT);
    j.bytes = Buffer.byteLength(String(output || ''));
    j.truncated = !!truncated;
    j.tail = '';
    j.kill = null;
    this._notify();
    return j;
  }

  /** 立刻终止某个正在跑的命令（会杀掉持久 shell，下条命令自动重启）。 */
  kill(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return { ok: false, content: '找不到这个任务。' };
    if (j.status !== 'running') return { ok: false, content: '这个任务已经结束了。' };
    try {
      j.kill?.();
      j.status = 'killed';
      j.ended = Date.now();
      j.dur = j.ended - j.started;
      this._notify();
      return { ok: true, content: `已终止 ${j.id}（${j.command.slice(0, 80)}）` };
    } catch (e) {
      return { ok: false, content: `终止失败：${e?.message || e}` };
    }
  }

  clear() {
    const running = this.jobs.filter((j) => j.status === 'running');
    this.jobs = running;
    this._notify();
    return running.length;
  }

  get(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  /** 列表：不带完整 output，避免每次推送几十 MB。 */
  list(limit = 60) {
    return this.jobs.slice(0, Math.max(1, Number(limit) || 60)).map((j) => ({
      id: j.id,
      command: j.command,
      cwd: j.cwd,
      source: j.source,
      background: j.background,
      status: j.status,
      code: j.code,
      started: j.started,
      ended: j.ended,
      dur: j.dur,
      bytes: j.bytes,
      truncated: j.truncated,
      preview: (j.output || j.tail || '').slice(-600),
    }));
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    if (!this.listeners.size) return;
    // 合并高频进度更新：150ms 一次就够了
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const list = this.list();
      for (const fn of [...this.listeners]) {
        try {
          fn(list);
        } catch {
          /* 订阅者报错不影响命令执行 */
        }
      }
    }, 150);
    if (this.timer.unref) this.timer.unref();
  }
}

export const jobs = new JobRegistry();
export { MAX_OUTPUT };
