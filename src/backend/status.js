// 跨进程的「会话在干什么」停靠区（backend）。
//
// 背景：玩家完全可能一边让 AI 干活、一边在 history 里切到另一个会话，甚至另开一个
// 终端跑第二个进程。**状态不能挂在进程内存里** —— 那份状态在别的进程里看不见，
// 进程被关掉之后也还在（就成了幽灵）。所以这里做的是「文件 + 心跳」：
//
//   ~/.agent/status/<sessionId>.json
//   { sessionId, pid, state, since, beat, node, title, cwd, question, note }
//
// state 只有四种：
//   working   在干活（调模型 / 跑工具）
//   asking    挂着等玩家回答（ask 工具阻塞中）—— 这条最要紧，玩家切走了也不会丢
//   done      刚干完（**只在 endedAt 之后 60 秒内有效**，否则会满屏绿点）
//   idle/其它 什么都不显示
//
// 判定「还活着」一律看 beat（心跳时间戳），**不看 pid**：
//   · pid 会被系统回收复用，看 pid 会把已经死掉的会话显示成在干活，比不显示更糟
//   · 容器 / WSL / 远程开发里 pid 根本对不上
//   · 所以：beat 在 STALE_MS 之内才算活着；进程被 kill -9 时心跳自然过期
//
// 这个模块不 import 任何 UI，也不引 fs 之外的依赖，方便被 app / agent / 测试共用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { agentDir } from '../config.js';

/** 心跳超过这么久没更新 = 那个进程已经不在（或被挂起）。 */
export const STALE_MS = 12000;
/** done 状态只活这么久：一分钟内刚干完的才值得标绿。 */
export const DONE_TTL_MS = 60000;
/** 心跳写盘的最小间隔（避免每个 token 都落一次盘）。 */
const BEAT_EVERY_MS = 2000;

export const STATES = { WORKING: 'working', ASKING: 'asking', DONE: 'done', IDLE: 'idle' };

export function statusDir() {
  return path.join(agentDir(), 'status');
}

function fileFor(sessionId) {
  return path.join(statusDir(), `${String(sessionId || '').replace(/[^\w.-]/g, '_')}.json`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一条状态记录是否还「算数」。
 *
 * @param {object} rec 落盘的那条记录
 * @param {number} [now] 当前时间（测试注入用）
 * @returns {{alive:boolean, state:string, age:number, reason:string}}
 *   alive=false 时 state 一律是 idle —— 调用方不用再自己判断
 */
export function evaluate(rec, now = Date.now()) {
  if (!rec || !rec.state) return { alive: false, state: STATES.IDLE, age: Infinity, reason: 'empty' };
  const beat = Number(rec.beat || 0);
  const age = now - beat;
  if (rec.state === STATES.DONE) {
    // 完成态看 endedAt，且只活一分钟
    const ended = Number(rec.endedAt || beat || 0);
    const doneAge = now - ended;
    if (doneAge > DONE_TTL_MS) return { alive: false, state: STATES.IDLE, age: doneAge, reason: 'done-expired' };
    if (doneAge < 0) return { alive: false, state: STATES.IDLE, age: doneAge, reason: 'clock-skew' };
    return { alive: true, state: STATES.DONE, age: doneAge, reason: 'done' };
  }
  if (!beat || age > STALE_MS) return { alive: false, state: STATES.IDLE, age, reason: 'stale' };
  if (age < -STALE_MS) return { alive: false, state: STATES.IDLE, age, reason: 'clock-skew' };
  if (rec.state === STATES.ASKING) return { alive: true, state: STATES.ASKING, age, reason: 'asking' };
  if (rec.state === STATES.WORKING) return { alive: true, state: STATES.WORKING, age, reason: 'working' };
  return { alive: true, state: STATES.IDLE, age, reason: 'idle' };
}

/**
 * 一个会话的状态停在文件里的「句柄」。
 * 用法：开工时 start()，干活期间 beat()，收工时 finish()，关进程时 dispose()。
 *
 * 所有方法都**不会抛错**：状态显示坏了不能连累正在干的活。
 */
export class SessionStatus {
  /**
   * @param {object} o
   * @param {string} o.sessionId 会话 id（和 sessions/<id>.json 同名）
   * @param {() => string} [o.title] 取标题（延迟求值：标题可能后改）
   * @param {() => string} [o.cwd] 取工作区
   * @param {number} [o.pid] 进程号（只写下来给人排查，判定活着不看它）
   */
  constructor({ sessionId, title, cwd, pid } = {}) {
    this.sessionId = String(sessionId || '');
    this.file = fileFor(this.sessionId);
    this._title = typeof title === 'function' ? title : () => String(title || '');
    this._cwd = typeof cwd === 'function' ? cwd : () => String(cwd || os.cwd?.() || process.cwd());
    this.pid = Number(pid) || process.pid;
    this.state = STATES.IDLE;
    this.since = 0;
    this.lastBeat = 0;
    this.lastWrite = 0;
    this.note = '';
    this.question = '';
    this._timer = null;
    this._endedAt = 0;
  }

  get active() {
    return this.state === STATES.WORKING || this.state === STATES.ASKING;
  }

  _payload(extra = {}) {
    const now = Date.now();
    return {
      sessionId: this.sessionId,
      pid: this.pid,
      state: this.state,
      since: this.since || now,
      beat: now,
      endedAt: this._endedAt || 0,
      title: String(this._title() || '').slice(0, 200),
      cwd: String(this._cwd() || ''),
      node: `${os.platform()}-${os.hostname()}`,
      note: String(this.note || '').slice(0, 200),
      question: String(this.question || '').slice(0, 300),
      ...extra,
    };
  }

  /** 立刻写盘（不看节流）。 */
  _write(extra) {
    const ok = writeJson(this.file, this._payload(extra));
    this.lastWrite = Date.now();
    this.lastBeat = this.lastWrite;
    return ok;
  }

  /**
   * 进入某个状态。切换到相同状态时只更新心跳，不重置 since
   * （否则「在干活 3 分钟」会被刷成「在干活 0 秒」）。
   */
  set(state, extra = {}) {
    try {
      const next = String(state || '');
      const changed = next !== this.state;
      if (changed) {
        this.state = next;
        this.since = Date.now();
        if (next === STATES.DONE) this._endedAt = this.since;
        if (next !== STATES.ASKING) this.question = '';
      }
      if (extra.note !== undefined) this.note = String(extra.note || '');
      if (extra.question !== undefined) this.question = String(extra.question || '');
      this._write(extra);
      this._ensureTimer();
    } catch {
      /* 状态是附加信息，失败了也要让主流程继续 */
    }
    return this;
  }

  /** 开工：working。 */
  start(extra = {}) {
    return this.set(STATES.WORKING, extra);
  }

  /**
   * AI 在等玩家回答。question 会写进状态文件，
   * 这样玩家在另一个进程的 /history 里也看得见「它在问什么」。
   */
  asking(question = '') {
    return this.set(STATES.ASKING, { question: String(question || '').slice(0, 300) });
  }

  /** 问完了 / 被跳过：回到干活（ask 之后模型一般还要继续）。 */
  answered(extra = {}) {
    return this.set(STATES.WORKING, { question: '', ...extra });
  }

  /** 收工：done（一分钟后自动失效）。 */
  finish(extra = {}) {
    return this.set(STATES.DONE, { question: '', ...extra });
  }

  /** 心跳：干活期间定期续命，别让别的进程以为我死了。 */
  beat(force = false) {
    if (!this.active && this.state !== STATES.DONE) return this;
    const now = Date.now();
    if (!force && now - this.lastWrite < BEAT_EVERY_MS) return this;
    try {
      this._write();
    } catch {}
    return this;
  }

  /** 本进程退出：把文件删掉，不留幽灵。 */
  dispose() {
    this._stopTimer();
    try {
      fs.unlinkSync(this.file);
    } catch {}
    this.state = STATES.IDLE;
    return this;
  }

  _ensureTimer() {
    if (this._timer || typeof setInterval !== 'function') return;
    if (!this.active) return;
    // 每 3 秒续一次心跳：STALE_MS=12s 给了 4 次容错，短暂卡死也不会误判成死了
    this._timer = setInterval(() => this.beat(true), 3000);
    this._timer.unref?.();
  }

  _stopTimer() {
    if (!this._timer) return;
    try {
      clearInterval(this._timer);
    } catch {}
    this._timer = null;
  }
}

// ---------------------------------------------------------------- 读侧

/** 读一个会话的状态（已按心跳/时效过滤，拿到的都是「现在真的成立」的）。 */
export function readStatus(sessionId, now = Date.now()) {
  const rec = readJson(fileFor(sessionId));
  const ev = evaluate(rec, now);
  if (!ev.alive) return { state: STATES.IDLE, sessionId, ...ev };
  return { ...rec, state: ev.state, age: ev.age };
}

/**
 * 一次读全部会话状态：history 列表一次渲染只该扫一遍目录。
 * @returns {Map<string, {state:string, age:number, question:string, note:string}>}
 */
export function readAllStatuses(now = Date.now()) {
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(statusDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const rec = readJson(path.join(statusDir(), f));
    if (!rec || !rec.sessionId) continue;
    const ev = evaluate(rec, now);
    if (!ev.alive) continue;
    out.set(rec.sessionId, {
      state: ev.state,
      age: ev.age,
      reason: ev.reason,
      question: rec.question || '',
      note: rec.note || '',
      since: Number(rec.since) || 0,
      endedAt: Number(rec.endedAt) || 0,
      pid: Number(rec.pid) || 0,
    });
  }
  return out;
}

/**
 * 清理过期 / 死掉的记录（心跳早就没了的那种）。
 * 不开定时任务，就在读的时候顺手扫一遍 —— 免得 ~/.agent/status 越攒越多。
 */
export function sweep(now = Date.now(), maxAgeMs = 24 * 3600 * 1000) {
  let removed = 0;
  let files = [];
  try {
    files = fs.readdirSync(statusDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  for (const f of files) {
    const file = path.join(statusDir(), f);
    const rec = readJson(file);
    const beat = Number(rec?.beat || 0);
    const ev = evaluate(rec, now);
    const tooOld = !beat || now - beat > maxAgeMs;
    if (!ev.alive && tooOld) {
      try {
        fs.unlinkSync(file);
        removed++;
      } catch {}
    }
  }
  return removed;
}

/** 状态 → 界面上那个圆点（颜色由调用方决定，这里只给字符和语义）。 */
export function dotOf(state) {
  if (state === STATES.ASKING) return 'yellow';
  if (state === STATES.WORKING) return 'blue';
  if (state === STATES.DONE) return 'green';
  return '';
}
