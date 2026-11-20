// team 工具：主 agent 组一支「AI 小队」并行开发，每个成员拿到一个明确分工。
//
// 成本提醒：每个成员都是独立上下文 + 独立模型调用，token 消耗是数倍。
// 所以默认关闭（settings.team=false），必须玩家 `/team on`，而且这里还会再拦一次。
import fs from 'node:fs';
import path from 'node:path';
import { Team, getActiveTeam, setActiveTeam, lastTeamSnapshot, teamDir, checkScopes, resolveDepends, MAX_MEMBERS } from '../team.js';
import { validateToolSpec, toolSpecError } from '../subagent.js';
import { memoryPrompt, projectMemory, readTodo, formatTodo } from '../tools/todo.js';

const STATUS_WORD = { pending: '排队', running: '进行中', done: '完成', error: '失败', stopped: '中断' };
const oneLine = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// 目录树里不看的目录（成员完全不关心，列出来只会诱使他们去翻）
const TREE_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', 'coverage', '.next',
  '__pycache__', '.venv', 'bin', 'obj', '.idea', '.vscode', 'tmp', '.cache',
]);

/** 一份浅层目录树：让成员一开始就知道项目长什么样，不用 ls -R 自己探。 */
function treeOf(cwd, { depth = 2, maxEntries = 90 } = {}) {
  const lines = [];
  let count = 0;
  const walk = (dir, prefix, level) => {
    if (level > depth || count >= maxEntries) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries.filter((e) => !e.name.startsWith('.') && !TREE_SKIP.has(e.name));
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (count >= maxEntries) return;
      count++;
      if (e.isDirectory()) {
        lines.push(`${prefix}${e.name}/`);
        walk(path.join(dir, e.name), `${prefix}  `, level + 1);
      } else {
        lines.push(`${prefix}${e.name}`);
      }
    }
  };
  walk(cwd, '', 1);
  if (count >= maxEntries) lines.push('…（更多文件略）');
  return lines.join('\n');
}

/**
 * 自动给团队生成一份简报：主代理已经知道的东西，成员不用再从零读一遍。
 * 顺序：玩家目标 → 项目记忆/长期记忆 → 已确认事实（主代理自己写的）→ 目录树。
 */
function buildBriefing(ctx, input) {
  const cwd = ctx?.cwd || process.cwd();
  const parts = [];
  const manual = String(input?.briefing || '').trim();
  if (manual) parts.push(`## 主代理已经查清的事实（直接用，不要重查）\n${manual}`);
  const project = (() => {
    try {
      return projectMemory(cwd, 1500) || '';
    } catch {
      return '';
    }
  })();
  if (project) parts.push(`## 项目记忆（${cwd}/MEMORY.md）\n${project.slice(0, 1500)}`);
  const mem = (() => {
    try {
      return memoryPrompt(900) || '';
    } catch {
      return '';
    }
  })();
  if (mem) parts.push(`## 长期记忆（跨会话约定）\n${mem}`);
  const todo = (() => {
    try {
      const t = readTodo(cwd);
      return t.items.length ? formatTodo(t) : '';
    } catch {
      return '';
    }
  })();
  if (todo) parts.push(`## 当前待办\n${todo}`);
  // 主代理最近几轮说了什么（它的调查结论往往写在文字里，这是最便宜的上下文继承）
  try {
    const eng = ctx?.engine;
    if (eng?.nodes) {
      const said = [];
      for (const n of eng.nodes) {
        if (n.kind !== 'message') continue;
        const msg = n.message;
        if (!msg) continue;
        const own = typeof msg.content === 'string' ? msg.content : '';
        if (msg.role === 'user' && own.trim() && !own.includes('<compressed_history>')) {
          said.push(`（玩家）${oneLine(own, 300)}`);
        } else if (msg.role === 'assistant' && own.trim().length > 60) {
          said.push(`（主代理）${oneLine(own, 500)}`);
        }
      }
      if (said.length) {
        parts.push(`## 对话里已确认的背景（依据，不要照着重新调研）\n${said.slice(-6).join('\n')}`);
      }
    }
  } catch {
    /* 拿不到就算了 */
  }
  const tree = treeOf(cwd);
  if (tree) parts.push(`## 项目结构（浅两层，已省略 dist/node_modules 之类）\n${tree}`);
  return parts.join('\n\n').slice(0, 12000);
}

function fmtMembers(snap) {
  const rows = (snap.members || []).map((m) => {
    const tok = (m.tokens?.input || 0) + (m.tokens?.output || 0);
    const dur = m.startedAt ? Math.round(((m.endedAt || Date.now()) - m.startedAt) / 1000) + 's' : '-';
    return `· ${m.name}（${m.role}）${STATUS_WORD[m.status] || m.status} · ${m.steps} 步/${m.toolCalls} 工具 · ${tok} tok · $${(m.cost || 0).toFixed(4)} · ${dur}${m.last ? `\n    → ${m.last}` : ''}${m.error ? `\n    × ${m.error}` : ''}`;
  });
  return rows.join('\n');
}

function snapText(snap) {
  const t = snap.totals || {};
  const v = snap.verifyResult
    ? `· 全队验收 ${snap.verifyResult.ok ? '✓' : '✗'}`
    : snap.verify?.length
      ? `· 全队验收待跑`
      : '';
  return [
    `团队「${snap.name}」${STATUS_WORD[snap.status] || snap.status} · ${t.done || 0}/${t.members || 0} 完成 · 运行中 ${t.running || 0} · ${t.tokens || 0} tok · $${(t.cost || 0).toFixed(4)}${v ? ` ${v}` : ''}${snap.haltReason ? ` · ⏹ ${snap.haltReason}` : ''}`,
    `目标：${snap.goal || '（未填）'}`,
    fmtMembers(snap),
  ].join('\n');
}

function parseMembers(raw, max) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const m of list) {
    if (out.length >= max) break;
    const task = String(m?.task || m?.goal || m?.description || '').trim();
    if (!task) continue;
    out.push({
      name: String(m?.name || m?.title || `成员${out.length + 1}`).trim() || `成员${out.length + 1}`,
      role: String(m?.role || m?.title || '开发').trim(),
      task,
      files: Array.isArray(m?.files) ? m.files.map(String) : Array.isArray(m?.scope) ? m.scope.map(String) : [],
      depends: Array.isArray(m?.depends) ? m.depends.map(String) : Array.isArray(m?.needs) ? m.needs.map(String) : [],
      model: String(m?.model || '').trim(),
      verify: Array.isArray(m?.verify) ? m.verify.map(String) : [],
      tools: Array.isArray(m?.tools) ? m.tools.map(String) : [],
    });
  }
  return out;
}

export const teamTool = {
  name: 'team',
  readOnly: false,
  description:
    '组一支「AI 开发小队」并行推进：你当队长，给每个成员一个明确角色 + 只属于他的任务（建议按文件/目录拆开，避免互相覆盖），成员在后台同时干活，共享同一个工作区。适合：一次要大改多个互不重叠的模块、需要同时做实现/测试/文档、需要几路调查并行。创建后立即返回 —— **你应该继续自己干活，不要在那里 team/wait 干等**（干等就是让主线程空转）；成员靠 briefing 团队简报继承你已经查清的上下文，不会再从零读一遍项目。用 action=status 秒回看进度、action=report 收每人的交代（含「改了哪些文件 / 验收跑没跑过 / 卡在哪」的核实账），只有确实无事可做时才 action=wait。成员会额外消耗 token（每个成员一份独立上下文），所以玩家必须先用 /team on 开启本功能。最多 10 个成员。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'status', 'wait', 'report', 'say', 'stop', 'inspect'],
        description:
          'create 组队开工 / status 看进度 / wait 等成员跑完 / report 拿每人交代 / say 给某成员传话 / stop 停掉全队 / inspect 看某成员具体走了哪几步（按需看，别当默认操作）',
      },
      name: { type: 'string', description: 'create：团队名，例如「登录重构小队」。' },
      goal: { type: 'string', description: 'create：团队总目标（一句话说清最终要交付什么）。' },
      members: {
        type: 'array',
        description: 'create：成员列表。每个成员的 task 必须自包含（目标+文件范围+验收标准），成员之间的文件范围不要重叠。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '成员名字（进度里显示）' },
            role: { type: 'string', description: '角色，例如 前端 / 后端 / 测试 / 文档' },
            task: { type: 'string', description: '他的任务，自包含：做什么、改哪些文件、怎么算做完' },
            files: { type: 'array', items: { type: 'string' }, description: '他负责的文件/目录（其他成员别碰）' },
            depends: {
              type: 'array',
              items: { type: 'string' },
              description:
                '可选：依赖哪个/哪些成员（写成员名字）。他会被推迟到那些成员完工后才起跑，并自动拿到他们的产出当已知条件。**「先定接口再实现」「先改 schema 再写查询」这类活必须填**，否则两人同时摸同一个接口一定打架。',
            },
            model: { type: 'string', description: '可选：该成员单独用某个模型' },
            verify: {
              type: 'array',
              items: { type: 'string' },
              description: '可选但强烈建议：验收命令，他干完后会被亲手跑一遍，失败自动给他一轮修正（例 ["npm test"]）。',
            },
            tools: { type: 'array', items: { type: 'string' }, description: '可选：限定该成员可用的工具' },
          },
          required: ['task'],
        },
      },
      concurrency: { type: 'integer', description: 'create：同时跑几个成员（默认取 settings.teamConcurrency，最大 10）。' },
      verify: {
        type: 'array',
        items: { type: 'string' },
        description:
          'create：**全队验收命令**，所有人都收工后由我亲手跑一遍（例 ["npm test"]）。成员各自的 verify 只验他自己那块；两人单挑都过、合起来炸（接口不匹配、公共逻辑冲突）只能靠这一道发现。强烈建议填。',
      },
      budget: {
        type: 'number',
        description: 'create：成本上限（美元）。累计花到这就停发新活，避免跑到一半发现烧了好几块。不填则取 settings.teamBudget（0 = 不限）。',
      },
      member: { type: 'string', description: 'say / inspect：成员名字或编号（m1）。' },
      message: { type: 'string', description: 'say：要对成员说的话。' },
      timeout_seconds: { type: 'integer', description: 'wait：最多等多少秒（默认 120）。超时也会把当前进度返回给你。' },
      lines: { type: 'integer', description: 'inspect：最多看这位成员最近几条（默认 40）。' },
    },
    required: ['action'],
  },

  async execute(input, ctx) {
    const cfg = ctx?.config;
    if (!cfg?.teamEnabled) {
      return {
        isError: true,
        content:
          'team 功能未开启（每个成员都会各烧一份 token）。请让玩家在终端执行 `/team on`（或改 config.json 的 settings.team=true）后再用。你也可以自己按顺序把这些活干完。',
      };
    }
    const action = String(input?.action || '').trim().toLowerCase();
    const cwd = ctx?.cwd || process.cwd();
    let team = getActiveTeam();

    if (action === 'create') {
      const max = Math.max(1, Math.min(MAX_MEMBERS, Number(cfg.settings?.teamMaxMembers) || MAX_MEMBERS));
      const members = parseMembers(input.members, max);
      if (!members.length) {
        return { isError: true, content: 'members 不能为空：至少给 1 个成员，每个成员要有 task（自包含）。' };
      }
      const goal = String(input.goal || '').trim();
      if (!goal) return { isError: true, content: 'goal 不能为空：写一句团队总目标，成员都靠它对齐。' };
      // 拆活拆错了最常见的形态：两个成员同时改同一个文件 → 互相覆盖。
      // 这里提前拦一下并把话说清楚（不硬拦：有时确实只能共用一个公共文件）。
      const conflicts = checkScopes(members);
      if (conflicts.length) {
        const seen = new Set();
        const rows = conflicts
          .filter((c) => {
            const k = `${c.a}|${c.b}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((c) => `  · ${c.a} 与 ${c.b} 都碰 ${c.aFile === c.bFile ? c.aFile : `${c.aFile} / ${c.bFile}`}`);
        return {
          isError: true,
          content: [
            '成员的文件范围重叠了，先把范围拆清楚再开工（两人同时改同一个文件 = 互相覆盖）：',
            ...rows,
            '',
            '改法（任选）：',
            '  · 把重叠的文件分给一个人，另一个人的任务里写成「需要改 X，因为…」交给队长处理',
            '  · 或把范围改成更细的文件（src/a.js 而不是 src/）',
            '  · 如果确实必须共用（比如都要改同一个公共接口文件），就合并成一个成员干',
          ].join('\n'),
        };
      }
      // 成员的工具点名单同样先校验：拼错就会退回全量工具集，成员拿到写权限却没人知道。
      const badTools = [];
      {
        const mod = await import('./index.js');
        for (const m of members) {
          if (!m.tools || !m.tools.length) continue;
          const r = validateToolSpec(m.tools, mod.getTool, {});
          if (!r.ok) badTools.push(`成员「${m.name}」：${toolSpecError({ unknown: r.unknown, forbidden: r.forbidden })}`);
        }
      }
      if (badTools.length) {
        return { isError: true, content: `有成员的工具参数不对，团队没有开工：\n${badTools.join('\n')}` };
      }
      if (team?.running) {
        return {
          isError: true,
          content: `已经有一支团队「${team.name}」在跑（${team.members.filter((m) => m.status === 'running').length} 人在忙）。先 team wait / team report / team stop 收掉它，再组新队。`,
        };
      }
      // 依赖校验：名字写错 / 成环 都要在开工前拦住（否则成员会永远 pending 等到超时）
      const depCheck = resolveDepends(members);
      if (!depCheck.ok) {
        return { isError: true, content: `成员依赖有问题，先改好再开工：\n  ${depCheck.error}` };
      }
      const concurrency = Math.max(1, Math.min(MAX_MEMBERS, Number(input.concurrency) || Number(cfg.settings?.teamConcurrency) || 2));
      // 团队简报：把主代理已经查清的东西（记忆/待办/它自己说过的结论/目录树）打包给成员，
      // 否则每个成员都会从零 read 一遍项目 —— 那是团队最常见、也最贵的一种浪费。
      const briefing = buildBriefing(ctx, input);
      team = new Team({
        config: cfg,
        cwd,
        name: String(input.name || 'AI 小队'),
        goal,
        members,
        concurrency,
        briefing,
        // 全队验收：合并后的整体验收（成员各自的 verify 只验他自己那块）
        verify: Array.isArray(input.verify) ? input.verify : input.verify ? [input.verify] : [],
        budget: Number(input.budget) || 0,
        checkpoints: ctx?.checkpoints || null,
        emit: (item) => ctx?.emit?.(item),
      });
      setActiveTeam(team);
      team.start();

      const plan = team.members
        .map((m) => {
          const dep = m.depends.length ? ` 〔依赖 ${m.depends.join('、')}，等他们完工再起跑〕` : '';
          return `· ${m.id} ${m.name}（${m.role}）${m.files.length ? ` → ${m.files.join(', ')}` : ''}${dep}\n    ${m.task}`;
        })
        .join('\n');
      return {
        content: [
          `团队「${team.name}」已开工：${team.members.length} 人 · 并发 ${concurrency} · 成员在后台并行跑。`,
          `目标：${goal}`,
          plan,
          team.verify.length ? `全队验收：${team.verify.join(' && ')}（所有人收工后我会亲手跑一遍，失败会把输出给你）` : '⚠ 没设全队验收：各成员自己那块能过，合起来能不能跑没人知道。下次记得给 verify。',
          team.budget ? `成本上限：$${team.budget.toFixed(2)}（花到就自动停发新活）` : '',
          `团队简报已注入（${briefing.length} 字符）：项目记忆 / 长期记忆 / 待办 / 你这段对话的结论 / 项目结构。成员已被告知「简报里的事实不要再 read 验证」，你不用再替他们查一遍。`,
          '重要：成员在后台自己跑，**你不要 team/wait 干等**（干等等于让主线程空转）。',
          '  · 正确姿势：立刻接着做你手上属于队长的那部分活（集成、公共文件、验证脚本、文档），或者先测试/构建验证已有部分；',
          '  · 中途想看看进度就 team/status（秒回），真需要汇总再 team/report；',
          '  · 只有你是纯调度、手上确实没活可干时，才用 team/wait（它会阻塞你，尽量给短超时 60-180s）。',
        ]
          .filter(Boolean)
          .join('\n'),
        meta: { team: { id: team.id, name: team.name, members: team.members.length, concurrency, briefing: briefing.length }, summary: `${team.name} · ${team.members.length} 人在跑` },
      };
    }

    if (action === 'status' || action === 'report' || action === 'wait') {
      if (!team) {
        const last = lastTeamSnapshot(cwd);
        if (!last) return { content: `当前没有团队在跑（也没有上回留下的记录）。用 action=create 组一队。\n记录目录：${teamDir(cwd)}` };
        return { content: `当前没有活跃团队。上一支团队（${new Date(last.updatedAt || last.createdAt || Date.now()).toLocaleString('zh-CN')}）：\n${snapText(last)}` };
      }
      if (action === 'report') {
        return { content: team.report(), meta: { team: team.snapshot(), summary: `报告 · ${team.members.length} 人` } };
      }
      if (action === 'wait') {
        const secs = Math.max(5, Number(input.timeout_seconds) || 120);
        ctx?.emit?.({ kind: 'note', text: `等团队「${team.name}」跑完（最多 ${secs}s）` });
        const how = await team.waitAll(secs * 1000);
        team.updateHub?.();
        if (how === 'timeout') {
          const running = team.members.filter((m) => m.status === 'running').length;
          return { content: `等了 ${secs}s，还有 ${running} 人没跑完（继续在后台跑）。当前进度：\n${snapText(team.snapshot())}\n可以再 team/wait，或先做别的事，最后 team/report。` };
        }
        return { content: `全队都跑完了：\n${snapText(team.snapshot())}\n\n${team.report()}`, meta: { team: team.snapshot(), summary: '全队完成' } };
      }
      // status
      return {
        content: snapText(team.snapshot({ events: false })),
        meta: { team: team.snapshot({ events: false }), summary: `${team.members.filter((m) => m.status === 'done').length}/${team.members.length} 完成` },
      };
    }

    if (action === 'say') {
      if (!team) return { isError: true, content: '当前没有团队在跑。' };
      const r = team.say(input.member, input.message);
      return { isError: !r.ok, content: r.content };
    }

    // 按需看某位成员的对话（默认不自动拼进 report —— 整段对话很贵）
    if (action === 'inspect') {
      if (!team) return { isError: true, content: '当前没有团队在跑。' };
      const r = team.inspect(input.member, { lines: Number(input.lines) || 40 });
      if (!r) return { isError: true, content: `没有这个成员：${input.member}（成员：${team.members.map((x) => x.name).join('、')}）` };
      const ctxPct = r.ctx ? Math.round((r.ctx.used != null ? r.ctx.used : 0) * 100) : null;
      return {
        content: [
          `${r.member}（${r.role}）${STATUS_WORD[r.status] || r.status} · ${r.steps} 步 · ${r.toolCalls} 次工具${ctxPct != null ? ` · ctx ${ctxPct}%` : ''}`,
          r.truncated ? `（只取了最后 ${r.lines.length} 条，前面省略 ${r.truncated} 条）` : '',
          '',
          r.text,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    if (action === 'stop') {
      if (!team) return { content: '当前没有团队在跑。' };
      const ok = team.stop();
      return { content: ok ? `已让团队「${team.name}」停下（已完成的成员产出仍然有效，可用 team/report 取）。` : '团队已经收工了。' };
    }

    return { isError: true, content: `不认识的 action：${action}（可用：create / status / wait / report / say / stop / inspect）` };
  },
};
