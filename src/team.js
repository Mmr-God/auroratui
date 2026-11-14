// 团队协作：主 agent 组一支「AI 小队」，每个成员一个明确分工，各自在自己的
// 上下文里专注干活（共享同一个工作区）。成员在后台并行跑，进度实时推到
// 浏览器面板（src/progress.js）和 TUI。
//
// 和 subagent 的关系：一个成员 = 一个带团队的子代理（runSubagent 加角色提示）。
// 默认 runner 走 runSubagent，测试里可以注入假的 runner，不用联网。
import fs from 'node:fs';
import path from 'node:path';
import { runSubagent } from './subagent.js';
import { ensureHub, Transcript } from './progress.js';

const PERSIST_MS = 800;
/** 一个团队最多几个人（面板上一屏能点得过来）。 */
export const MAX_MEMBERS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 从工具入参里挑一个能代表这次调用的短文本（面板上显示用）。 */
const hintOf = (input) => {
  const v = input?.path || input?.url || input?.pattern || input?.query || input?.command || input?.name || '';
  return typeof v === 'string' ? v : '';
};

export function teamDir(cwd) {
  return path.join(cwd, '.agent', 'team');
}

export class Team {
  /**
   * @param {object} o
   * @param {object} o.config 主配置
   * @param {string} o.cwd 工作区
   * @param {string} o.name 团队名
   * @param {string} o.goal 总目标
   * @param {Array<{name?:string, role?:string, task:string, files?:string[], model?:string, tools?:string[]}>} o.members
   * @param {number} [o.concurrency] 同时跑几个
   * @param {object} [o.checkpoints] 共享检查点（/undo 能回滚成员的写文件）
   * @param {(item:object)=>void} [o.emit] TUI 进度回调
   * @param {Function} [o.runner] 自定义成员执行器（测试注入）
   */
  constructor({ config, cwd, name, goal, members = [], concurrency = 2, checkpoints = null, emit = null, runner = null } = {}) {
    this.id = `t${Date.now().toString(36)}`;
    this.config = config;
    this.cwd = cwd;
    this.name = String(name || 'AI 团队').trim() || 'AI 团队';
    this.goal = String(goal || '').trim();
    this.concurrency = Math.max(1, Math.min(MAX_MEMBERS, Number(concurrency) || 2));
    this.checkpoints = checkpoints;
    this.emit = typeof emit === 'function' ? emit : null;
    this.runner = typeof runner === 'function' ? runner : defaultRunner;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.status = 'pending'; // pending | running | done | stopped
    this.hub = null;
    this.lastPersist = 0;
    this.members = members.slice(0, MAX_MEMBERS).map((m, i) => ({
      id: `m${i + 1}`,
      name: String(m?.name || `成员${i + 1}`).trim() || `成员${i + 1}`,
      role: String(m?.role || '开发').trim(),
      task: String(m?.task || '').trim(),
      files: Array.isArray(m?.files) ? m.files.map(String) : [],
      model: String(m?.model || ''),
      tools: Array.isArray(m?.tools) ? m.tools.map(String) : [],
      status: 'pending',
      steps: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0 },
      cost: 0,
      startedAt: null,
      endedAt: null,
      last: '',
      output: '',
      error: '',
      /** 这位成员的对话记录（面板上点开他就能看全过程）。 */
      tr: new Transcript(),
    }));
    this._finished = new Promise((r) => (this._finish = r));
  }

  get running() {
    return this.status === 'running';
  }

  member(idOrName) {
    const q = String(idOrName || '').toLowerCase();
    return this.members.find((m) => m.id === q || m.name.toLowerCase() === q) || null;
  }

  totals() {
    let tokens = 0;
    let cost = 0;
    let done = 0;
    let running = 0;
    let stopped = 0;
    let error = 0;
    for (const m of this.members) {
      tokens += (m.tokens.input || 0) + (m.tokens.output || 0);
      cost += m.cost || 0;
      if (m.status === 'done') done++;
      else if (m.status === 'running') running++;
      else if (m.status === 'error') error++;
      else if (m.status === 'stopped') stopped++;
    }
    return { members: this.members.length, done, running, stopped, error, tokens, cost };
  }

  snapshot({ events = true } = {}) {
    return {
      id: this.id,
      name: this.name,
      goal: this.goal,
      cwd: this.cwd,
      status: this.status,
      concurrency: this.concurrency,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      members: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        task: m.task,
        files: m.files,
        status: m.status,
        steps: m.steps,
        toolCalls: m.toolCalls,
        tokens: m.tokens,
        cost: m.cost,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        last: m.last,
        output: m.output,
        error: m.error,
        events: events ? m.tr.entries() : undefined,
      })),
      totals: this.totals(),
    };
  }

  /** 起跑：立刻返回（成员在后台并行跑）。 */
  async start() {
    if (this.status !== 'pending') return this;
    this.status = 'running';
    this._publish('team_start', this.name, `团队「${this.name}」开工 · ${this.members.length} 人 · 并发 ${this.concurrency}`);
    this._wake();
    this._runPool().catch(() => {});
    return this;
  }

  async _runPool() {
    const queue = [...this.members];
    const worker = async () => {
      while (queue.length) {
        if (this.status === 'stopped') return;
        const m = queue.shift();
        await this._runMember(m);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, this.members.length || 1) }, worker));
    } finally {
      if (this.status !== 'stopped') this.status = 'done';
      this._publish('team_done', this.name, `团队收工：${this.members.filter((m) => m.status === 'done').length}/${this.members.length} 人完成`);
      this._flushPersist();
      this._finish();
    }
  }

  async _runMember(m) {
    m.status = 'running';
    m.startedAt = Date.now();
    const ctrl = new AbortController();
    m._ctrl = ctrl;
    // 第一条对话：队长派的活（面板上就是这个成员的聊天开头）
    m.tr.task(m.task + (m.files.length ? `\n\n负责范围：${m.files.join('、')}` : ''));
    this._publish('member_start', m.name, `开始：${oneLine(m.task, 80)}`);
    this._wake();
    try {
      const res = await this.runner({
        team: { name: this.name, goal: this.goal },
        member: m,
        config: this.config,
        cwd: this.cwd,
        checkpoints: this.checkpoints,
        signal: ctrl.signal,
        onAgent: (a) => {
          m._agent = a;
        },
        onEvent: (ev) => this._memberEvent(m, ev),
      });
      m.output = String(res?.text || '').trim();
      m.steps = res?.steps || m.steps;
      const u = res?.usage || {};
      m.tokens = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0 };
      m.cost = u.cost || 0;
      m.status = res?.aborted ? 'stopped' : 'done';
      m.last = m.output ? oneLine(m.output.split('\n').find((l) => l.trim()) || m.output, 110) : m.last;
      if (m.output) m.tr.result(m.output);
      else if (m.status === 'stopped') m.tr.note('被中断，没来得及交代');
      if (res?.timedOut) m.tr.note(res?.aborted ? '到时间上限被硬中断（已写的文件还在，产出按最后交代算）' : '到时间上限，已收尾交代');
      this._publish(m.status === 'done' ? 'member_done' : 'member_stopped', m.name,
        `${m.status === 'done' ? '完成' : '已中断'}`,
        `${m.status === 'done' ? '完成' : res?.timedOut ? '到时间上限，已收尾' : '已中断'} · ${m.steps} 步 · ${m.toolCalls} 次工具 · $${(m.cost || 0).toFixed(4)}`);
    } catch (e) {
      m.status = 'error';
      m.error = e?.message || String(e);
      m.tr.error(`失败：${m.error}`);
      this._publish('member_error', m.name, `失败：${m.error}`);
    } finally {
      m.endedAt = Date.now();
      this._wake();
    }
  }

  _memberEvent(m, ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'step') {
      m.steps = ev.step;
      return;
    }
    if (ev.type === 'tool_start') {
      m.toolCalls++;
      m.last = `${ev.name} ${oneLine(hintOf(ev.input), 70)}`.trim();
      m.tr.feed(ev);
      this._publish('tool', m.name, m.last, { quiet: true });
      return;
    }
    if (ev.type === 'tool_end') {
      m.tr.feed(ev);
      if (ev.isError) {
        m.last = `${ev.name} 失败`;
        this._publish('tool', m.name, `× ${ev.name} 失败：${oneLine(ev.content, 80)}`, { quiet: true });
      }
      return;
    }
    if (ev.type === 'usage') {
      const u = ev.total || ev.usage || {};
      m.tokens = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0 };
      m.cost = Number.isFinite(u.cost) ? u.cost : m.cost;
      this._wake();
      return;
    }
    if (ev.type === 'assistant_done' && ev.text) m.last = oneLine(ev.text, 110);
    // 文字 / 思考 / 压缩提示都进这位成员的对话记录
    m.tr.feed(ev);
    this._wake();
  }

  /** 收尾时的完整交代（每位成员一段）。 */
  report({ maxPerMember = 1800 } = {}) {
    const rows = this.members.map((m) => {
      const body = m.output ? (m.output.length > maxPerMember ? m.output.slice(0, maxPerMember) + '…' : m.output) : m.error ? `（失败）${m.error}` : '（还没有产出）';
      const stat = `[${m.status}] ${m.steps} 步 · ${m.toolCalls} 次工具 · ${m.tokens.input + m.tokens.output} tok · $${(m.cost || 0).toFixed(4)}`;
      return `## ${m.name}（${m.role}） ${stat}\n任务：${m.task}\n${body}`;
    });
    const t = this.totals();
    const tail = [t.stopped ? `${t.stopped} 人中断（产出按最后交代算）` : '', t.error ? `${t.error} 人失败` : ''].filter(Boolean).join(' · ');
    return [
      `# 团队「${this.name}」报告（${t.done}/${t.members} 完成${tail ? ` · ${tail}` : ''} · ${t.tokens} tok · $${t.cost.toFixed(4)}）`,
      `目标：${this.goal}`,
      ...rows,
    ].join('\n\n');
  }

  /** 给某个成员补一句话（成员下一轮会看到）。 */
  say(idOrName, message) {
    const m = this.member(idOrName);
    if (!m) return { ok: false, content: `没有这个成员：${idOrName}（成员：${this.members.map((x) => x.name).join('、')}）` };
    if (m.status !== 'running') return { ok: false, content: `成员 ${m.name} 当前是「${m.status}」，没法插话（只能给运行中的成员传话）。` };
    try {
      m._agent?.queue(String(message || ''));
    } catch {
      return { ok: false, content: '传话失败（成员会话已结束）' };
    }
    m.tr.say(String(message || ''));
    this._publish('note', m.name, `收到补充指示：${oneLine(message, 100)}`);
    this._wake(true);
    return { ok: true, content: `已把补充指示交给 ${m.name}，他会在下一步看到。` };
  }

  stop() {
    if (this.status === 'done' || this.status === 'stopped') return false;
    this.status = 'stopped';
    for (const m of this.members) {
      try {
        m._ctrl?.abort();
      } catch {}
      if (m.status === 'running') {
        m.status = 'stopped';
        m.tr.note('团队被停止，他这段就到这里');
      }
    }
    this._publish('team_stop', this.name, '团队已停止');
    this._flushPersist();
    this._finish();
    return true;
  }

  /** 等到全部成员跑完，或超时（timeoutMs）。 */
  async waitAll(timeoutMs = 120000) {
    const ms = Math.max(1000, Number(timeoutMs) || 120000);
    const timer = sleep(ms);
    const winner = await Promise.race([this._finished.then(() => 'done'), timer.then(() => 'timeout')]);
    return winner;
  }

  // ------------------------------------------------------- 进度：面板 + TUI
  async attachHub(config) {
    try {
      this.hub = await ensureHub(config);
    } catch {
      this.hub = null;
    }
    if (this.hub) {
      // 面板里的输入框 → 给某个成员传话（成员跑完时 say() 会给出说明）
      this.hub.onSay = (member, message) => this.say(member, message);
      this._wake(true);
    }
    return this.hub;
  }

  /** 手动把当前快照推一次（工具里等完/查完时用，保证面板不过期）。 */
  updateHub() {
    this._wake(true);
    return this.snapshot();
  }

  /** 把状态推到面板；日志去重靠 quiet 标记（工具级日志只进面板不进 TUI）。 */
  _publish(kind, who, text, { quiet = false } = {}) {
    this.updatedAt = Date.now();
    if (this.hub) {
      this.hub.log({ kind, who, text });
      this._wake();
    }
    if (!quiet && this.emit) {
      const label = kind === 'team_start' ? '团队' : kind === 'team_done' || kind === 'team_stop' ? '团队' : who;
      try {
        this.emit({ kind: 'note', text: `${label} · ${text}` });
      } catch {}
    }
  }

  /** 节流地把快照推给面板 + 落盘（进程崩了还能看到最后的进度）。 */
  _wake(force = false) {
    if (this.hub) this.hub.update({ title: `AuroraTui · ${this.name}`, team: this.snapshot(), totals: this.totals() });
    const now = Date.now();
    if (this._persistTimer) return;
    const wait = force ? 0 : Math.max(0, PERSIST_MS - (now - this.lastPersist));
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.lastPersist = Date.now();
      this._persist();
    }, wait);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  _persist() {
    try {
      const dir = teamDir(this.cwd);
      fs.mkdirSync(dir, { recursive: true });
      // 落盘不存对话记录（那是给面板看的，落盘只留进度骨架，文件小、重启能读）
      fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(this.snapshot({ events: false }), null, 2));
    } catch {
      /* 落盘失败不影响干活 */
    }
  }

  /** 立刻落盘（收工 / 停止时调，免得最后一段进度还在节流窗口里就结束）。 */
  _flushPersist() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this.lastPersist = Date.now();
    this._persist();
  }
}

// --------------------------------------------------------------- 默认执行器
async function defaultRunner({ team, member, config, cwd, checkpoints, signal, onEvent, onAgent }) {
  const filesHint = member.files.length
    ? `\n你负责的文件/范围：${member.files.join(', ')}（别改这个范围以外的文件；确实要改就先在最终答复里说明理由）`
    : '';
  const res = await runSubagent({
    config,
    cwd,
    task: member.task,
    role: `你是团队「${team.name}」的成员：${member.name}。
分工：${member.role}
团队总目标：${team.goal}
你只负责自己的那一块，不要替别的成员干活，也不要大范围重构。${filesHint}`,
    tools: member.tools,
    model: member.model,
    team,
    checkpoints,
    signal,
    onEvent,
    onAgent,
    maxSteps: Number(config?.settings?.subagentMaxSteps) || 40,
    // 成员的时间上限单独一个旋钮（比单发子代理宽松得多）：六百秒一刀切会把写了半天的活直接枝掉
    timeoutSec: Number(config?.settings?.teamMemberTimeout) || Math.max(1800, Number(config?.settings?.subagentTimeout) || 600),
  });
  return res;
}

// ------------------------------------------------------------------- 注册表
let activeTeam = null;

export function getActiveTeam() {
  return activeTeam;
}

export function setActiveTeam(t) {
  activeTeam = t;
  return t;
}

/** 读上次落盘的快照（进程重启后 /team status 还能看到上回）。 */
export function lastTeamSnapshot(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(teamDir(cwd), 'latest.json'), 'utf8'));
  } catch {
    return null;
  }
}

export { oneLine };
