// 子代理 / 团队成员的「结构化回报」。
//
// 两个来源，优先级从高到低：
//   1) 事实采集（watch）：从 Agent 的事件流里直接数出来的东西 —— 改了哪些文件、
//      跑了什么命令、失败几次、压缩几轮。这个造假不了，是硬账。
//   2) 模型自述（parseReport）：交代里写的「没做完 / 有风险 / 我假设了…」。
//      这些只有模型自己知道，但可能漏写，所以只用它补「人话」部分。
//
// 合并后的对象既能给主代理看（render），也能进 meta 让它自己判断要不要复核。

const MAX_FILES = 40;
const MAX_CMDS = 20;

// 这些工具会改工作区；writeScope 之外的写入会被 fs 工具拦掉，不会出现在这里
const WRITE_TOOLS = new Set(['write', 'edit']);

const oneLine = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 从一次 shell 调用里挑出「能当验收用」的命令（跑测试 / 构建 / lint 之类）。 */
function isVerifyCommand(cmd) {
  const c = String(cmd || '');
  if (!c.trim()) return false;
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check|ci)\b|\b(bun|deno)\s+(test|check)\b|\bpytest\b|\bpython\s+-m\s+(pytest|unittest)\b|\bgo\s+(test|build|vet)\b|\bcargo\s+(test|build|clippy|check)\b|\bdotnet\s+(test|build)\b|\bmvn\b|\bgradle\b|\bnode\s+--check\b|\bmake\s+(test|all|check)\b|\btsc\b|\beslint\b|\bnode\s+test\//i.test(
    c,
  );
}

/**
 * 事实采集器：喂 Agent 事件，攒出「这次到底干了什么」的硬账。
 * 生命周期跟一次 runSubagent 走，结束时 read() 拿结果。
 */
export class ChangeWatch {
  constructor(cwd = '') {
    this.cwd = cwd;
    this.files = new Map(); // path → { ops:Set, count, lastErr }
    this.commands = []; // { command, code, ok, verify, dur }
    this.toolCount = new Map(); // 工具名 → 次数
    this.toolCalls = 0;
    this.failures = 0;
    this._byId = new Map(); // toolCallId → 这次调用的描述（供 tool_end 回填）
  }

  _note(path, op) {
    const p = String(path || '').trim();
    if (!p) return null;
    let row = this.files.get(p);
    if (!row) {
      row = { path: p, ops: new Set(), count: 0 };
      this.files.set(p, row);
    }
    row.ops.add(op);
    row.count++;
    return row;
  }

  /** 喂一条 Agent 事件；返回 true 表示这条事件被记进了账。 */
  feed(ev) {
    if (!ev || !ev.type) return false;
    if (ev.type === 'tool_start') {
      this.toolCalls++;
      const name = String(ev.name || '');
      this.toolCount.set(name, (this.toolCount.get(name) || 0) + 1);
      const input = ev.input || {};
      let kind = name;
      if (WRITE_TOOLS.has(name)) {
        kind = name === 'write' ? 'write' : 'edit';
        this._note(input.path, kind);
      } else if (name === 'shell') {
        kind = 'shell';
      }
      this._byId.set(String(ev.id || `${name}:${this.toolCalls}`), { kind, name, input });
      return true;
    }
    if (ev.type === 'tool_end') {
      const key = String(ev.id || '');
      const info = this._byId.get(key);
      if (ev.isError) this.failures++;
      if (!info) return false;
      if (info.kind === 'shell') {
        const code = ev.meta?.code;
        const command = String(info.input?.command || '');
        const ok = !ev.isError && (code == null || code === 0);
        this.commands.push({
          command: oneLine(command, 200),
          code: code == null ? (ev.isError ? 1 : 0) : code,
          ok,
          verify: isVerifyCommand(command),
          dur: Number(ev.dur) || 0,
        });
        if (this.commands.length > MAX_CMDS) this.commands.splice(0, this.commands.length - MAX_CMDS);
      } else if (WRITE_TOOLS.has(info.name) && ev.isError) {
        // 写失败（越权 / 磁盘错误）：记一笔，别让「改了 N 个文件」虚高
        const row = this.files.get(String(info.input?.path || ''));
        if (row) {
          row.count = Math.max(0, row.count - 1);
          row.lastErr = oneLine(ev.content, 120);
        }
      }
      this._byId.delete(key);
      return true;
    }
    return false;
  }

  /**
   * @returns {{files:{path:string,ops:string[],count:number}[], commands:object[],
   *            toolCalls:number, failures:number, verified:boolean|string,
   *            verifyCommand:string|null, verifyOutput:string}}
   */
  read({ verifyOutput = '' } = {}) {
    const files = [...this.files.values()]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_FILES)
      .map((r) => ({ path: r.path, ops: [...r.ops], count: r.count }));
    const verifyCmds = this.commands.filter((c) => c.verify);
    const passed = verifyCmds.filter((c) => c.ok).length;
    const failed = verifyCmds.filter((c) => !c.ok).length;
    return {
      files,
      commands: this.commands.slice(),
      toolCalls: this.toolCalls,
      failures: this.failures,
      // true=验收命令全过；false=有失败；null=压根没跑过验收命令
      verified: !verifyCmds.length ? null : failed === 0,
      verifyCommand: verifyCmds.length ? verifyCmds[verifyCmds.length - 1].command : null,
      verifyOutput: String(verifyOutput || ''),
      tests: { total: verifyCmds.length, passed, failed },
    };
  }
}

const BLOCK_RE = /<<<REPORT\s*([\s\S]*?)REPORT>>>/;

/**
 * 从交代文本里抠出模型自述的结构化部分。
 * 认两种写法：带 <<<REPORT … REPORT>>> 包裹的 JSON，或者整段就是一个 JSON 对象。
 * 抠不出来就返回 null（不要因为格式没守住就把整个交代丢掉）。
 */
export function parseReport(text) {
  const body = String(text || '');
  const m = BLOCK_RE.exec(body);
  // 先剥 ```json 包裹，再看剩下的是不是一整段 JSON（模型经常两种写法混用）
  const unfence = (v) =>
    String(v)
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/, '')
      .trim();
  const raw = m ? m[1] : unfence(body).startsWith('{') ? unfence(body) : null;
  if (!raw) return null;
  const cleaned = unfence(raw);
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // 再试一次：截取第一个 { 到最后一个 }
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      obj = JSON.parse(cleaned.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : v ? [String(v).trim()] : []);
  return {
    done: typeof obj.done === 'string' ? oneLine(obj.done, 300) : '',
    files: arr(obj.files ?? obj.files_changed),
    tests: obj.tests == null ? '' : typeof obj.tests === 'string' ? obj.tests : JSON.stringify(obj.tests),
    blocked: arr(obj.blocked),
    risks: arr(obj.risks ?? obj.risk),
    assumptions: arr(obj.assumptions ?? obj.assumed),
  };
}

/** 把自述里的文件路径和事实采集的合并（事实优先，自述只补充没抓到的）。 */
function mergeFiles(facts, said) {
  const seen = new Set(facts.map((f) => f.path));
  const extra = said.filter((p) => p && !seen.has(p)).map((p) => ({ path: p, ops: ['？'], count: 0, claimedOnly: true }));
  return [...facts, ...extra];
}

/**
 * 汇总成一份结构化回报。
 * @param {object} o.watch ChangeWatch 的 read() 结果（没装 watcher 时传 null）
 * @param {string} o.text 子代理最终交代原文
 * @returns {object} 可直接进 meta / 渲染
 */
export function buildReport({ watch = null, text = '' } = {}) {
  const said = parseReport(text) || {};
  const facts = watch || { files: [], commands: [], toolCalls: 0, failures: 0, verified: null, tests: { total: 0, passed: 0, failed: 0 } };
  const files = mergeFiles(facts.files, said.files || []);
  const verifyCmds = facts.commands.filter((c) => c.verify);
  const failedCmds = verifyCmds.filter((c) => !c.ok);
  return {
    // 验收结论：只有真跑过命令才算数，模型说「测过了」不算
    verified: facts.verified,
    verifyNote:
      facts.verified === true
        ? `${facts.tests.passed} 条验收命令全过`
        : facts.verified === false
          ? `${failedCmds.length} 条验收命令失败`
          : '没有跑过验收命令（测试/构建/lint 都没跑）',
    verifyCommand: facts.verifyCommand,
    verifyOutput: facts.verifyOutput,
    files,
    commands: facts.commands,
    toolCalls: facts.toolCalls,
    failures: facts.failures,
    tests: facts.tests,
    // 模型自述部分
    blocked: said.blocked || [],
    risks: said.risks || [],
    assumptions: said.assumptions || [],
    summary: said.done || '',
    // 有事实 / 有自述 任一即视为结构化成功（主代理可以据此决定要不要复核）
    parsed:
      !!watch?.toolCalls ||
      !!facts.files?.length ||
      Object.values(said || {}).some((v) => (Array.isArray(v) ? v.length : v)),
  };
}

/** 渲染成给主代理看的一小段（不进正文，放返回值末尾）。 */
export function renderReport(r) {
  if (!r) return '';
  const lines = [];
  const mark = r.verified === true ? '✓' : r.verified === false ? '✗' : '–';
  lines.push(`【核实账】${mark} ${r.verifyNote}`);
  if (r.verifyCommand) {
    const out = String(r.verifyOutput || '').trim();
    lines.push(`  验收命令：${oneLine(r.verifyCommand, 160)}${out ? `\n  输出尾部：${oneLine(out.split('\n').slice(-6).join(' | '), 400)}` : ''}`);
  }
  if (r.files?.length) {
    const shown = r.files.slice(0, 12);
    lines.push(`  改动文件（${r.files.length}）：${shown.map((f) => `${f.path}${f.claimedOnly ? '（未核实）' : `[${f.ops.join('/')}]`}`).join('、')}${r.files.length > shown.length ? ' …' : ''}`);
  }
  if (r.blocked?.length) lines.push(`  卡住：${r.blocked.join('；')}`);
  if (r.risks?.length) lines.push(`  风险：${r.risks.join('；')}`);
  if (r.assumptions?.length) lines.push(`  它自己假设了：${r.assumptions.join('；')}`);
  if (r.failures) lines.push(`  失败的调用：${r.failures} 次`);
  return lines.join('\n');
}

/** 自述格式要求：塞进子代理的角色提示里，让它最后按这个交。 */
export const REPORT_SPEC = `# 最后怎么交代（先对人说人话，末尾附一段结构化结论）

先用 3-8 行人话说明你做了什么、改了哪些文件、验证了什么、哪部分没做完。
然后**另起一行**，输出这段结构化结论（JSON 必须合法，字段没有就写空数组）：

<<<REPORT
{
  "done": "一句话总结这次完成了什么",
  "files": ["实际改过的文件路径"],
  "tests": "跑过的验收命令与结果，例如 npm test 全过 / 未跑",
  "blocked": ["卡住没做完的事，没有就 []"],
  "risks": ["可能出问题的地方，没有就 []"],
  "assumptions": ["你不确定时自己做的假设，没有就 []"]
}
REPORT>>>

注意：files 只写你真的改过的；没跑测试就在 tests 里写「未跑」，不要编。`;
