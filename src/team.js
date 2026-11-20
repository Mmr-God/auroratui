// 团队协作：主 agent 组一支「AI 小队」，每个成员一个明确分工，各自在自己的
// 上下文里专注干活（共享同一个工作区）。成员在后台并行跑，进度实时推到 TUI。
//
// 和 subagent 的关系：一个成员 = 一个带团队的子代理（runSubagent 加角色提示）。
// 默认 runner 走 runSubagent，测试里可以注入假的 runner，不用联网。
import fs from 'node:fs';
import path from 'node:path';
import { runSubagent, runVerify } from './subagent.js';
import { Transcript } from './transcript.js';
import { addLesson, recallLessons, renderLessons } from './lessons.js';

const PERSIST_MS = 800;
/** 一个团队最多几个人（再多队长也看不过来）。 */
export const MAX_MEMBERS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 取一段文本的尾巴（报错几乎总在末尾，前面可能是滚屏日志）。 */
const tailText = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
};

/** 从工具入参里挑一个能代表这次调用的短文本（进度行上显示用）。 */
const hintOf = (input) => {
  const v = input?.path || input?.url || input?.pattern || input?.query || input?.command || input?.name || '';
  return typeof v === 'string' ? v : '';
};

export function teamDir(cwd) {
  return path.join(cwd, '.agent', 'team');
}

/** 两次 glob 式的范围是否沩上了（完全相等 / 一包含另一 / 目录前缀）。 */
export function scopeOverlap(a, b) {
  const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 目录 / 通配前缀：src/a 包含 src/a/b，src/**/* 包含 src/a.js
  const pref = (p, q) => q.startsWith(p + '/') || (p.endsWith('/**') && q.startsWith(p.slice(0, -3)));
  return pref(x, y) || pref(y, x);
}

/**
 * 检查各成员的文件范围是否重叠。
 * 重叠不一定错（两个人都要改同一个公共文件时确实没法拆），但绝大时候是拆错了：
 * 两个成员同时改同一个文件 = 互相覆盖。所以这里要提前告警，而不是等收工时才发现。
 */
export function checkScopes(members) {
  const list = Array.isArray(members) ? members : [];
  const conflicts = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      for (const fa of a.files || []) {
        for (const fb of b.files || []) {
          if (scopeOverlap(fa, fb)) conflicts.push({ a: a.name, b: b.name, aFile: fa, bFile: fb });
        }
      }
    }
  }
  return conflicts;
}

/**
 * 检查成员之间的依赖是否成立（depends 指向不存在的成员 / 存在环）。
 * 返回 { ok, error, order }；order 是拓扑序（能排出来就说明无环）。
 */
export function resolveDepends(members) {
  const list = Array.isArray(members) ? members : [];
  const byName = new Map(list.map((m) => [String(m.name || '').toLowerCase(), m]));
  for (const m of list) {
    for (const d of m.depends || []) {
      const key = String(d || '').trim().toLowerCase();
      if (!key) continue;
      if (!byName.has(key)) return { ok: false, error: `成员「${m.name}」依赖的「${d}」不存在（成员：${list.map((x) => x.name).join('、')}）` };
      if (key === String(m.name || '').toLowerCase()) return { ok: false, error: `成员「${m.name}」不能依赖自己` };
    }
  }
  // 拓扑排序 + 环检测（Kahn）
  const indeg = new Map(list.map((m) => [m, 0]));
  const next = new Map(list.map((m) => [m, []]));
  for (const m of list) {
    for (const d of m.depends || []) {
      const dep = byName.get(String(d || '').trim().toLowerCase());
      if (!dep) continue;
      indeg.set(m, (indeg.get(m) || 0) + 1);
      next.get(dep).push(m);
    }
  }
  const order = [];
  const ready = list.filter((m) => (indeg.get(m) || 0) === 0);
  while (ready.length) {
    const m = ready.shift();
    order.push(m);
    for (const n of next.get(m) || []) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) ready.push(n);
    }
  }
  if (order.length !== list.length) {
    const inCycle = list.filter((m) => !order.includes(m)).map((m) => m.name);
    return { ok: false, error: `成员依赖成环：${inCycle.join(' → ')}` };
  }
  return { ok: true, order, byName };
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
  constructor({ config, cwd, name, goal, members = [], concurrency = 2, briefing = '', checkpoints = null, emit = null, runner = null, verify = null, budget = 0 } = {}) {
    this.id = `t${Date.now().toString(36)}`;
    this.config = config;
    this.cwd = cwd;
    this.name = String(name || 'AI 团队').trim() || 'AI 团队';
    this.goal = String(goal || '').trim();
    // 团队简报：主代理本次会话已经查清的事实（用户可以手动给，也可以由 tools/team.js
    // 从主代理上下文里自动抽取）。成员最烧钱的动作是「从零把项目读一遍」，这块就是防它。
    this.briefing = String(briefing || '').trim();
    /** 共享板：已完工成员的关键结论，后启动的成员直接当已知条件用。 */
    this.board = [];
    this.concurrency = Math.max(1, Math.min(MAX_MEMBERS, Number(concurrency) || 2));
    this.checkpoints = checkpoints;
    this.emit = typeof emit === 'function' ? emit : null;
    this.runner = typeof runner === 'function' ? runner : defaultRunner;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.status = 'pending'; // pending | running | done | stopped
    /** 全队验收命令：所有人都收工后由队长亲手跑一遍（各人自己的 verify 只验他自己那块）。 */
    this.verify = Array.isArray(verify) ? verify.map(String).filter(Boolean) : verify ? [String(verify)] : [];
    /** 全队验收结果 {ok, code, command, output}（跑完才有）。 */
    this.verifyResult = null;
    /** 成本上限（美元）：累计花到这里就停发新活、停掉正在跑的（0 = 不限）。 */
    this.budget = Math.max(0, Number(budget) || Number(config?.settings?.teamBudget) || 0);
    /** 被预算熔断 / 卡住纠偏而停下的原因（report 里会写）。 */
    this.haltReason = '';
    this.lastPersist = 0;
    this.members = members.slice(0, MAX_MEMBERS).map((m, i) => ({
      id: `m${i + 1}`,
      name: String(m?.name || `成员${i + 1}`).trim() || `成员${i + 1}`,
      role: String(m?.role || '开发').trim(),
      task: String(m?.task || '').trim(),
      files: Array.isArray(m?.files) ? m.files.map(String) : [],
      /** 依赖哪些成员（名字）—— 要等他们完工才会起跑，并把他们的产出并进简报。 */
      depends: Array.isArray(m?.depends) ? m.depends.map(String) : [],
      model: String(m?.model || ''),
      verify: Array.isArray(m?.verify) ? m.verify.map(String) : [],
      tools: Array.isArray(m?.tools) ? m.tools.map(String) : [],
      status: 'pending',
      steps: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0 },
      cost: 0,
      /** 上下文占用（和 TUI 底部那条对齐）。 */
      ctx: null,
      /** 这个成员自己触发了多少次上下文压缩。 */
      compactions: 0,
      startedAt: null,
      endedAt: null,
      last: '',
      output: '',
      error: '',
      /** 这位成员的对话记录（出错时能回放他走了哪几步）。 */
      tr: new Transcript(),
      /** 结构化回报：改了哪些文件、验收跑没跑过、卡在哪（来自事实采集）。 */
      report: null,
      /** 他查到的「情报」（只读侦察的结论）—— 会进共享板给其他成员和队长看，省得各自重查一遍。 */
      findings: [],
      /** 实时状态（TUI 用）：正在调什么工具 / 是否在思考 / 当前在写哪个文件 */
      live: { tool: '', hint: '', since: 0, thinking: false },
      /** 纠偏计数：同一种卡法只提醒一次，别把成员烦死。 */
      nudged: { repeat: false, errors: false },
      /** 最近的工具调用指纹（用来识别「反复读同一个东西」）。 */
      recent: { sig: '', repeats: 0 },
      /** 连续失败的工具调用次数。 */
      failStreak: 0,
    }));
    this._finished = new Promise((r) => (this._finish = r));
  }

  get running() {
    return this.status === 'running';
  }

  /**
   * 依赖成员的产出（依赖 DAG 的核心）：等谁、等到了什么。
   * 起跑前会把它拼进简报 —— 「先定接口再实现」这种活全靠这段。
   */
  dependsFor(member) {
    const out = [];
    for (const raw of member?.depends || []) {
      const dep = this.member(raw);
      if (!dep || dep === member) continue;
      const r = dep.report;
      const facts = [];
      if (r?.files?.length) facts.push(`改了 ${r.files.slice(0, 10).map((f) => f.path).join('、')}`);
      if (r?.verifyNote) facts.push(r.verifyNote);
      const findings = (dep.findings || []).slice(0, 6);
      const body = String(dep.output || dep.error || '').trim();
      out.push({
        name: dep.name,
        role: dep.role,
        status: dep.status,
        // 依赖者的交代是「接口定义/约定」这类关键信息，给得比共享板更多
        text: body.length > 1400 ? body.slice(0, 1400) + '…' : body,
        facts: facts.join(' · '),
        findings,
      });
    }
    return out;
  }

  /** 依赖成员是否都跑完了（没跑完就不能起跑）。 */
  depsReady(member) {
    for (const raw of member?.depends || []) {
      const dep = this.member(raw);
      if (!dep) continue;
      if (dep.status === 'pending' || dep.status === 'running') return false;
    }
    return true;
  }

  /**
   * 给某位成员看的「其他成员已完工结论」。超过预算时保留最近的若干条
   * （早完工的通常是地基，反而更重要，所以从两头取）。
   */
  boardFor(member, { maxChars = 2600 } = {}) {
    const items = this.board.filter((b) => b.member !== member?.name);
    if (!items.length) return [];
    const out = [];
    let used = 0;
    for (const b of items) {
      const extra = [b.facts ? `（${b.facts}）` : '', b.findings?.length ? ` ${b.findings.join('；')}` : ''].join('');
      const line = `${b.member}（${b.role}）：${b.text}${extra}`;
      if (used + line.length > maxChars && out.length) break;
      out.push(line);
      used += line.length + 1;
    }
    return out;
  }

  /** 一位成员完工后的结论摘要（进共享板，后面的成员能看到）。 */
  _pushBoard(m) {
    const body = String(m.output || '').trim() || (m.error ? `（失败）${m.error}` : '');
    if (!body) return;
    // 共享的是「结论 + 硬账」，不是他整段对话（后者很贵，想看再用 inspect 按需拉）
    const r = m.report;
    const facts = [];
    if (r?.files?.length) facts.push(`改了 ${r.files.slice(0, 8).map((f) => f.path).join('、')}${r.files.length > 8 ? ' …' : ''}`);
    if (r?.blocked?.length) facts.push(`卡在 ${r.blocked.join('；')}`);
    if (r?.verifyNote) facts.push(r.verifyNote);
    const findings = (m.findings || []).slice(0, 5);
    this.board.push({
      member: m.name,
      role: m.role,
      text: oneLine(body, 320),
      facts: facts.join(' · '),
      findings,
      ts: Date.now(),
    });
    // 已经跑着的其他成员也递一句（他们不会再重读系统提示，只能靠注入）
    const detail = [oneLine(body, 900), facts.length ? `\n核实账：${facts.join(' · ')}` : '', findings.length ? `\n他查到：${findings.join('；')}` : ''].join('');
    for (const other of this.members) {
      if (other === m || other.status !== 'running') continue;
      try {
        other._agent?.queue(
          `【团队共享】成员「${m.name}（${m.role}）」已完成（当已知条件用，不要重复他的活，也不要重读他动过的文件）:\n${detail}`,
        );
        other.tr?.note(`收到「${m.name}」的完工结论`);
      } catch {
        /* 成员会话已结束就算了 */
      }
    }
  }

  /**
   * 成员产出一条「情报」（只读侦察的结论）：进共享板 + 立刻递给其他成员。
   * 这是团队最重要的省钱手段 —— A 已经查清的事实，B 不该再花 token 查一遍。
   */
  pushFinding(m, text) {
    const t = oneLine(text, 400);
    if (!t) return;
    if (!m.findings) m.findings = [];
    m.findings.push(t);
    const line = `${m.name}（${m.role}）：${t}`;
    this.board.push({ member: m.name, role: m.role, text: t, facts: '中途发现', findings: [], ts: Date.now(), interim: true });
    for (const other of this.members) {
      if (other === m || other.status !== 'running') continue;
      try {
        other._agent?.queue(`【团队共享·他查到的】不要再去查一遍：\n${line}`);
      } catch {}
    }
    m.tr?.note(`已向其他成员同步发现：${oneLine(t, 80)}`);
    this._wake(true);
  }

  /**
   * 按需取某位成员的对话记录（主代理想看再调，不自动塞 —— 整段对话很贵）。
   * @param {string} idOrName 成员
   * @param {number} lines 最多几行
   */
  inspect(idOrName, { lines = 40 } = {}) {
    const m = this.member(idOrName);
    if (!m) return null;
    const es = m.tr.entries();
    const pick = es.slice(-Math.max(1, Math.min(200, lines)));
    const out = pick.map((e) => {
      if (e.k === 'task') return `【任务】${oneLine(e.text, 200)}`;
      if (e.k === 'tool') return `【工具】${e.name} ${e.hint || ''} ${e.status === 'run' ? '(跑着)' : e.status === 'err' ? '× 失败' : '√'}${e.result ? `\n  ${oneLine(e.result, 300)}` : ''}`;
      if (e.k === 'think') return `【思考】${oneLine(e.text, 300)}`;
      if (e.k === 'result') return `【交代】${oneLine(e.text, 600)}`;
      if (e.k === 'error') return `【出错】${oneLine(e.text, 300)}`;
      if (e.k === 'note') return `· ${oneLine(e.text, 200)}`;
      return `【说话】${oneLine(e.text, 400)}`;
    });
    return {
      member: m.name,
      role: m.role,
      status: m.status,
      steps: m.steps,
      toolCalls: m.toolCalls,
      ctx: m.ctx,
      lines: out,
      text: out.join('\n'),
      truncated: es.length > pick.length ? es.length - pick.length : 0,
    };
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
        depends: m.depends || [],
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
        ctx: m.ctx || null,
        compactions: m.compactions || 0,
        report: m.report || null,
        findings: m.findings || [],
        live: m.live || null,
        events: events ? m.tr.entries() : undefined,
      })),
      totals: this.totals(),
      verify: this.verify,
      verifyResult: this.verifyResult || null,
      budget: this.budget || 0,
      haltReason: this.haltReason || '',
    };
  }

  /**
   * 实时状态（给 TUI 的「团队成员工具调用行」用）：只拿最小必要信息，每帧都能调。
   * 只返回**正在调工具**的成员 —— 在思考 / 空闲的不出现（玩家要的就是不刷屏）。
   */
  liveState() {
    const rows = [];
    for (const m of this.members) {
      const l = m.live || {};
      if (m.status !== 'running' || !l.tool) continue;
      rows.push({
        id: m.id,
        name: m.name,
        role: m.role,
        tool: l.tool,
        hint: l.hint || '',
        secs: l.since ? Math.max(0, Math.round((Date.now() - l.since) / 1000)) : 0,
      });
    }
    return rows;
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
    // 依赖 DAG 调度：每个 worker 不是「取队首」，而是「一直在里面找当前能跑的」——
    // 谁的依赖都完工了，谁就能起跑。这样 A → B → C 的串行链和 A ∥ B → C 的分叉
    // 能在同一个池里共存，并发度自动拉满。
    const waiting = [...this.members];
    /** 在 waiting 里挑一个依赖已就绪的；都被卡住就返回 null。 */
    const pick = () => {
      for (let i = 0; i < waiting.length; i++) {
        if (this.depsReady(waiting[i])) return waiting.splice(i, 1)[0];
      }
      return null;
    };
    const worker = async () => {
      while (waiting.length) {
        if (this.status === 'stopped') return;
        if (this._budgetExceeded()) return;
        const m = pick();
        if (!m) {
          // 剩下的都在等依赖：等一个成员收工唤醒，再重新挑（没人跑就说明死了，直接跑）
          const anyRunning = this.members.some((x) => x.status === 'running');
          if (!anyRunning) return;
          await sleep(120);
          continue;
        }
        if (m.depends.length) {
          const names = m.depends.join('、');
          m.tr?.note(`依赖 ${names} 已完工，开始干活`);
          this._publish('note', m.name, `依赖 ${names} 已完工，开始`, { quiet: true });
        }
        await this._runMember(m);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, this.members.length || 1) }, worker));
    } finally {
      // 依赖永远等不到（前置崩了/被停）的，标清楚，别让它们永远 pending
      for (const m of this.members) {
        if (m.status === 'pending') {
          m.status = 'error';
          m.error = `依赖的成员没能正常完工（${(m.depends || []).join('、')}），他这塊没法开工`;
          m.tr?.error(m.error);
        }
      }
      // 全队验收：各人只顾自己那块，合到一起就炋（接口不匹配 / 公共逻辑冲突），
      // 必须有一道「合并后的整体验收」，否则团队最大的价值点（发现集成问题）就流失了。
      if (this.status !== 'stopped' && this.verify.length) {
        await this._runTeamVerify();
      }
      if (this.status !== 'stopped') this.status = 'done';
      this._publish('team_done', this.name, `团队收工：${this.members.filter((m) => m.status === 'done').length}/${this.members.length} 人完成`);
      this._flushPersist();
      this._finish();
    }
  }

  /** 预算是不是已经烧超了（超了就停发新活）。 */
  _budgetExceeded() {
    if (!this.budget) return false;
    const { cost } = this.totals();
    if (cost < this.budget) return false;
    if (!this.haltReason) {
      this.haltReason = `花到 $${cost.toFixed(4)}，超过预算上限 $${this.budget.toFixed(4)}，已停发新活`;
      this._publish('note', '团队', this.haltReason);
      this._flushPersist();
    }
    return true;
  }

  /**
   * 全队验收：所有人收工后由队长亲手跑一遍（不进任何成员的上下文）。
   * 失败不自动派人修 —— 把失败输出 + 各人改动清单交给队长，由它决定。
   */
  async _runTeamVerify() {
    const cmds = this.verify.filter(Boolean);
    if (!cmds.length) return;
    this._publish('note', '团队', `全队验收：${cmds.join(' && ')}`);
    this.verifyResult = await runVerify({ config: this.config, cwd: this.cwd }, cmds, null);
    const ok = this.verifyResult?.ok;
    this._publish('note', '团队', `全队验收${ok ? '通过' : '失败'}（退出码 ${this.verifyResult?.code}）`);
    this._flushPersist();
  }

  /**
   * 拼这位成员的简报：团队简报 + 依赖成员的产出（+ 经验库在 runner 里单独传）。
   * 依赖那段给得比共享板更多 —— 它包含「接口定成什么样」这种必须先知道的事实。
   */
  _briefFor(member, dep = []) {
    const base = String(this.briefing || '').trim();
    if (!dep.length) return base;
    const rows = [];
    for (const d of dep) {
      const facts = d.facts ? `\n核实账：${d.facts}` : '';
      const findings = d.findings?.length ? `\n他查到：${d.findings.join('；')}` : '';
      const body = d.text || (d.status === 'done' ? '（他没留交代，只能读他的文件对齐接口）' : `（他状态是 ${d.status}，产出可能不完整，自己确认一下）`);
      rows.push(`## ${d.name}（${d.role}）已经做完的部分\n${body}${facts}${findings}`);
    }
    return [
      base,
      '# 你依赖的成员已经完工了（他们的产出就是你的已知条件）',
      '他们已经把地基打好，你直接建立在上面：不要重做他们那份，也不要推翻他们的接口约定；',
      '发现他们的做法有问题，就按既定接口先把自己的活干完，在最终交代里写「建议改…，因为…」，让队长拍。',
      '',
      ...rows,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** 把这位成员踩的坑写进经验库（下次同类活会被召回）。 */
  _learn(m, res) {
    const r = m.report || res?.report;
    if (!r) return;
    const tags = [m.role, ...(m.files || []).slice(0, 6)];
    // 验收失败：失败输出里往往就是真正的原因（报错码、文件名、缺失的依赖）
    if (r.verified === false) {
      addLesson(this.cwd, {
        task: m.task,
        kind: 'verify-fail',
        text: `${r.verifyNote || '验收失败'}：${tailText(r.verifyOutput || res?.verify?.output, 200)}`,
        tags,
      });
    }
    // 卡住的点：主代理一看就知道这类任务容易倒在哪
    for (const b of r.blocked || []) {
      addLesson(this.cwd, { task: m.task, kind: 'blocked', text: b, tags });
    }
    if (m.status === 'error' && m.error) {
      addLesson(this.cwd, { task: m.task, kind: 'error', text: m.error, tags });
    }
  }

  /**
   * 卡住时自动纠偏：只提醒一次，不再打断（成员也可能正是在正常试探）。
   * 实测 “原地打转” 的典型信号就两个：
   *   · 反复调同一个工具、同一个参数（反复读同一个文件 / 反复 grep 同一个词）
   *   · 工具连续失败（比如一直在改一个语法错、一直在跑一条跑不通的命令）
   */
  _maybeNudge(m, kind, detail) {
    if (m.status !== 'running' || !m._agent) return false;
    const key = kind === 'repeat' ? 'repeat' : 'errors';
    if (m.nudged?.[key]) return false; // 同一种卡法只提醒一次
    if (!m.nudged) m.nudged = { repeat: false, errors: false };
    m.nudged[key] = true;
    const msg =
      kind === 'repeat'
        ? `【自动提醒】你在反复调同一个工具、同一个参数（${detail}），这一步已经看不到新信息了。
换个做法：要么已经读够了、直接开始改代码；要么换关键词 / 换文件；实在推不下去就在交代里写「卡在…」，让队长决定。`
        : `【自动提醒】连续 ${detail} 次工具调用失败了。别再重试同一条路：先 read 一下报错旁边那几行看真正原因，或换一种命令写法；
再试两次还不行，就把当前进度和卡点写进交代，交牌。`;
    try {
      m._agent.queue(msg);
      this._publish('note', m.name, kind === 'repeat' ? `提醒他别在原地打转（${detail}）` : `工具连续失败 ${detail} 次，已提醒他改道`);
      m.tr?.note(kind === 'repeat' ? `自动纠偏：重复调用 ${detail}` : `自动纠偏：连续失败 ${detail} 次`);
      return true;
    } catch {
      return false;
    }
  }

  async _runMember(m) {
    m.status = 'running';
    m.startedAt = Date.now();
    // 第一条对话：队长派的活（回放时就是这段对话的开头）
    m.tr.task(m.task + (m.files.length ? `\n\n负责范围：${m.files.join('、')}` : ''));
    this._publish('member_start', m.name, `开始：${oneLine(m.task, 80)}`);
    this._wake();

    // 依赖成员的产出 + 经验库召回，都并进他的简报：
    //   · 依赖产出：同事定好的接口/约定就是他的已知条件（「先定接口再实现」全靠这段）
    //   · 经验库：同类活以前踩过的坑，不要重新踩一遍
    const dep = this.dependsFor(m);
    const brief = this._briefFor(m, dep);
    const lessons = renderLessons(recallLessons(this.cwd, `${m.task} ${m.files.join(' ')}`, { limit: 3 }));
    m.tr?.note(dep.length ? `已拿到 ${dep.map((d) => d.name).join('、')} 的产出` : '');

    // 重试时要告诉它「上一轮改了哪些文件」—— 否则它以为自己是刚接手，
    // 会重读一堆文件、甚至把上一轮已经改好的东西又重写一遍。
    const touched = new Set();
    const runOnce = async (retryNote = '') => {
      const ctrl = new AbortController();
      m._ctrl = ctrl;
      return this.runner({
        // onFinding：成员写的 FINDING 行 → 立刻广播给全队
        team: {
          name: this.name,
          goal: this.goal,
          briefing: this.briefing,
          onFinding: (fact) => this.pushFinding(m, fact),
        },
        member: m,
        briefing: retryNote ? `${brief}\n\n${retryNote}` : brief,
        board: this.boardFor(m),
        depends: dep,
        lessons,
        writeScope: m.files.length ? m.files : null,
        config: this.config,
        cwd: this.cwd,
        checkpoints: this.checkpoints,
        signal: ctrl.signal,
        onAgent: (a) => {
          m._agent = a;
        },
        onEvent: (ev) => {
          // 顺手记下它改动过的文件（只用于重试时的交接说明）
          if (ev?.type === 'tool_start' && (ev.name === 'write' || ev.name === 'edit' || ev.name === 'patch')) {
            const p = ev.input?.path || ev.input?.file;
            if (p) touched.add(String(p));
          }
          this._memberEvent(m, ev);
        },
      });
    };

    /** 重试交接：上一轮死在哪 + 已经落了哪些盘。 */
    const retryNote = (errMsg) => {
      const files = [...touched];
      return [
        '# 【重要】你是重试起跑的（上一轮跑到一半挂了）',
        '这不是新任务，是接着干。上一轮已经做的事不要重做，也不要推翻。',
        `上次挂掉的原因：${oneLine(errMsg, 300)}`,
        files.length
          ? `上次已经动过的文件（先 read 它们看当前状态，在此基础上继续）：${files.map((f) => `\n  - ${f}`).join('')}`
          : '上次还没来得及改文件就挂了。',
        '',
        '这次的做法：先把任务拆小，一步一步来；改完一个文件就验证一次，不要一口气改五个再一起跑。',
        '如果同一个地方已经失败过两次，换个思路（换 API / 换写法 / 先写最小复现），别硬碰。',
      ].join('\n');
    };

    try {
      let res;
      try {
        res = await runOnce('');
      } catch (e) {
        const msg = e?.message || String(e);
        // 被中断/超时不是「跑挂」，不重试（重试只会再撞一次同样的墙）
        const fatal = !!m._ctrl?.signal?.aborted || this.status === 'stopped';
        const canRetry = !fatal && !m.retried;
        if (!canRetry) throw e;
        m.retried = true;
        m.error = msg;
        this._publish('note', m.name, `跑挂了（${oneLine(msg, 80)}），正在重试 1 次`);
        m.tr?.note(`第一次失败：${oneLine(msg, 200)}。已带着「上次改了哪些文件」重试`);
        // 重试前把状态归位（_memberEvent/_maybeNudge 会看这些）
        m.nudged = { repeat: false, errors: false };
        res = await runOnce(retryNote(msg));
        m.error = '';
      }
      if (res?.report) m.report = res.report;
      m.output = String(res?.text || '').trim();
      m.steps = res?.steps || m.steps;
      const u = res?.usage || {};
      m.tokens = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0 };
      m.cost = u.cost || 0;
      m.status = res?.aborted ? 'stopped' : 'done';
      // 踩过的坑入库（跨任务复用）：验收失败原因 / 卡住的点 —— 下次同类活直接召回
      this._learn(m, res);
      m.last = m.output ? oneLine(m.output.split('\n').find((l) => l.trim()) || m.output, 110) : m.last;
      if (m.output) m.tr.result(m.output);
      else if (m.status === 'stopped') m.tr.note('被中断，没来得及交代');
      if (res?.timedOut) m.tr.note(res?.aborted ? '到时间上限被硬中断（已写的文件还在，产出按最后交代算）' : '到时间上限，已收尾交代');
      // 结论进共享板：后面启动的成员在系统提示里看到，正在跑的成员收到一条注入
      this._pushBoard(m);
      this._publish(m.status === 'done' ? 'member_done' : 'member_stopped', m.name,
        `${m.status === 'done' ? '完成' : '已中断'}${m.retried ? '（重试后）' : ''}`,
        `${m.status === 'done' ? '完成' : res?.timedOut ? '到时间上限，已收尾' : '已中断'} · ${m.steps} 步 · ${m.toolCalls} 次工具 · $${(m.cost || 0).toFixed(4)}`);
    } catch (e) {
      m.status = 'error';
      m.error = e?.message || String(e);
      m.tr.error(`失败：${m.error}${m.retried ? '（已重试过 1 次）' : ''}`);
      this._publish('member_error', m.name, `失败：${m.error}${m.retried ? '（重试过仍失败）' : ''}`);
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
      const hint = oneLine(hintOf(ev.input), 70);
      m.last = `${ev.name} ${hint}`.trim();
      m.live = { tool: ev.name, hint, since: Date.now(), thinking: false };
      // 卡住检测（一）：反复调同一个工具、同一个参数。连续 3 次就提醒一次。
      // 不把这个当错误上报，只是给它一句提醒 —— 正常试探也可能命中两次。
      const sig = `${ev.name}\u0000${hint}`;
      if (m.recent && m.recent.sig === sig) {
        m.recent.repeats++;
        if (m.recent.repeats >= 2) this._maybeNudge(m, 'repeat', `${ev.name} ${hint}`.trim());
      } else {
        m.recent = { sig, repeats: 0 };
      }
      m.tr.feed(ev);
      this._publish('tool', m.name, m.last, { quiet: true });
      return;
    }
    if (ev.type === 'tool_end') {
      m.live = { ...m.live, tool: '', hint: '', since: 0 };
      m.tr.feed(ev);
      if (ev.isError) {
        m.last = `${ev.name} 失败`;
        // 卡住检测（二）：连续失败。同一条路走不通就别死磕。
        m.failStreak = (m.failStreak || 0) + 1;
        if (m.failStreak >= 3) this._maybeNudge(m, 'errors', String(m.failStreak));
        this._publish('tool', m.name, `× ${ev.name} 失败：${oneLine(ev.content, 80)}`, { quiet: true });
      } else {
        m.failStreak = 0;
      }
      return;
    }
    // 思考中：TUI 上不显示任何工具行（玩家明确要求「思考时不要显示」）
    if (ev.type === 'reasoning' || (ev.type === 'text' && ev.delta)) {
      if (!m.live.thinking && !m.live.tool) {
        m.live.thinking = true;
        this._wake();
      }
      m.tr.feed(ev);
      return;
    }
    if (ev.type === 'usage') {
      const u = ev.total || ev.usage || {};
      m.tokens = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0 };
      m.cost = Number.isFinite(u.cost) ? u.cost : m.cost;
      // 上下文占用：和 TUI 底部那条 ctx% 同一个来源（engine.stats）
      if (ev.context) {
        const c = ev.context;
        m.ctx = {
          tokens: c.tokens || 0,
          maxTokens: c.maxTokens || 0,
          used: Number.isFinite(c.used) ? c.used : c.maxTokens ? (c.tokens || 0) / c.maxTokens : 0,
          messages: c.messages || 0,
          blocks: c.blocks || 0,
        };
      }
      this._wake();
      return;
    }
    // 压缩也记一笔：反复压缩说明读得太多，值得在报告里提一句
    if (ev.type === 'compact_end') m.compactions = (m.compactions || 0) + 1;
    if (ev.type === 'assistant_done' && ev.text) m.last = oneLine(ev.text, 110);
    // 文字 / 思考 / 压缩提示都进这位成员的对话记录
    m.tr.feed(ev);
    this._wake();
  }

  /** 收尾时的完整交代（每位成员一段）。 */
  report({ maxPerMember = 1800 } = {}) {
    const rows = this.members.map((m) => {
      const body = m.output ? (m.output.length > maxPerMember ? m.output.slice(0, maxPerMember) + '…' : m.output) : m.error ? `（失败）${m.error}` : '（还没有产出）';
      const ctxPct = m.ctx ? Math.round((m.ctx.used != null ? m.ctx.used : m.ctx.maxTokens ? m.ctx.tokens / m.ctx.maxTokens : 0) * 100) : null;
      const r = m.report;
      const verifyMark = r?.verified === true ? ' 验收✓' : r?.verified === false ? ' 验收✗' : '';
      const stat = `[${m.status}] ${m.steps} 步 · ${m.toolCalls} 次工具 · ${m.tokens.input + m.tokens.output} tok · $${(m.cost || 0).toFixed(4)}${ctxPct != null ? ` · ctx ${ctxPct}%` : ''}${m.compactions ? ` · 压缩 ${m.compactions} 次` : ''}${verifyMark}`;
      // 核实账：主代理靠这几行决定要不要复核，不用把整段对话读一遍
      const audit = [];
      if (r?.files?.length) audit.push(`  改动：${r.files.slice(0, 8).map((f) => f.path).join('、')}${r.files.length > 8 ? ' …' : ''}`);
      if (r?.blocked?.length) audit.push(`  卡住：${r.blocked.join('；')}`);
      if (r?.risks?.length) audit.push(`  风险：${r.risks.join('；')}`);
      if (r?.verifyNote) audit.push(`  验收：${r.verifyNote}`);
      if (m.depends?.length) audit.push(`  依赖：${m.depends.join('、')}`);
      return `## ${m.name}（${m.role}） ${stat}\n任务：${m.task}\n${body}${audit.length ? `\n${audit.join('\n')}` : ''}`;
    });
    const t = this.totals();
    const tail = [t.stopped ? `${t.stopped} 人中断（产出按最后交代算）` : '', t.error ? `${t.error} 人失败` : ''].filter(Boolean).join(' · ');
    // 全队验收：这是「合并后真的能用吗」的唯一答案，必须放在最前面让人看到
    const teamVerify = (() => {
      if (!this.verify.length) return [];
      const v = this.verifyResult;
      if (!v) return [`全队验收：${this.verify.join(' && ')}（还没跑）`];
      const head = `全队验收：${v.ok ? '✓ 通过' : '✗ 失败'}（${v.command}，退出码 ${v.code}）`;
      if (v.ok) return [head];
      return [head, '失败输出（只取尾部）：', tailText(v.output, 1200) || '（没输出）'];
    })();
    return [
      `# 团队「${this.name}」报告（${t.done}/${t.members} 完成${tail ? ` · ${tail}` : ''} · ${t.tokens} tok · $${t.cost.toFixed(4)}）`,
      `目标：${this.goal}`,
      ...(this.haltReason ? [`⏹ ${this.haltReason}`] : []),
      ...(teamVerify.length ? [teamVerify.join('\n')] : []),
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

  // ------------------------------------------------------------ 进度：TUI
  /** 手动把当前快照落盘一次（工具里等完/查完时用，保证快照不过期）。 */
  updateHub() {
    this._wake(true);
    return this.snapshot();
  }

  /** 播一条进度事件；日志去重靠 quiet 标记（工具级日志不进 TUI）。 */
  _publish(kind, who, text, { quiet = false } = {}) {
    this.updatedAt = Date.now();
    if (!quiet && this.emit) {
      const label = kind === 'team_start' ? '团队' : kind === 'team_done' || kind === 'team_stop' ? '团队' : who;
      try {
        this.emit({ kind: 'note', text: `${label} · ${text}` });
      } catch {}
    }
  }

  /** 节流地落盘（进程崩了还能看到最后的进度）。 */
  _wake(force = false) {
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
      // 落盘不存对话记录（那只用于回放，落盘只留进度骨架，文件小、重启能读）
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
async function defaultRunner({ team, member, briefing, board, depends = [], lessons = '', writeScope, config, cwd, checkpoints, signal, onEvent, onAgent }) {
  const filesHint = member.files.length
    ? `\n你负责的文件/范围：${member.files.join(', ')}\n` +
      '  这条是**硬限制**：write / edit 到范围之外的文件会被直接拒绝（不是建议）。\n' +
      '  别去改同事的文件，也别替同事打补丁 —— 他们正在改，动了就是互相覆盖。\n' +
      '  发现必须改别人的文件时：在最终交代里写清「需要改 path，因为…」，让队长统一处理。\n' +
      '  读不受限制（同事的文件可以随便 read 来对齐接口），只有「写」受限制。'
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
    // 成员自己点了模型就用它；没点则回落团队默认（settings.teamMemberModel）
    model: member.model || String(config?.settings?.teamMemberModel || ''),
    team,
    briefing: briefing || team?.briefing || '',
    board,
    depends,
    lessons,
    writeScope,
    verify: member.verify,
    report: true,
    checkpoints,
    signal,
    onEvent,
    onAgent,
    // 侦察发现实时共享给全队（team onFinding 由 _runMember 接）
    onFinding: typeof team?.onFinding === 'function' ? team.onFinding : null,
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
