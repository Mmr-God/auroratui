// team 工具：主 agent 组一支「AI 小队」并行开发，每个成员拿到一个明确分工。
//
// 成本提醒：每个成员都是独立上下文 + 独立模型调用，token 消耗是数倍。
// 所以默认关闭（settings.team=false），必须玩家 `/team on`，而且这里还会再拦一次。
import { Team, getActiveTeam, setActiveTeam, lastTeamSnapshot, teamDir, MAX_MEMBERS } from '../team.js';
import { ensureHub, openInBrowser } from '../progress.js';

const STATUS_WORD = { pending: '排队', running: '进行中', done: '完成', error: '失败', stopped: '中断' };

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
  return [
    `团队「${snap.name}」${STATUS_WORD[snap.status] || snap.status} · ${t.done || 0}/${t.members || 0} 完成 · 运行中 ${t.running || 0} · ${t.tokens || 0} tok · $${(t.cost || 0).toFixed(4)}`,
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
      model: String(m?.model || '').trim(),
      tools: Array.isArray(m?.tools) ? m.tools.map(String) : [],
    });
  }
  return out;
}

export const teamTool = {
  name: 'team',
  readOnly: false,
  description:
    '组一支「AI 开发小队」并行推进：你当队长，给每个成员一个明确角色 + 只属于他的任务（建议按文件/目录拆开，避免互相覆盖），成员在后台同时干活，共享同一个工作区。适合：一次要大改多个互不重叠的模块、需要同时做实现/测试/文档、需要几路调查并行。创建后立即返回，你继续做自己那部分，用 action=status 看进度、action=wait 等结果、action=report 收每人的交代。玩家能在浏览器面板里逐个点开成员看他的完整对话（含工具输出），也能直接在面板里给运行中的成员传话。共员会额外消耗 token（每个成员一份独立上下文），所以玩家必须先用 /team on 开启本功能。最多 10 个成员。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'status', 'wait', 'report', 'say', 'stop'],
        description: 'create 组队开工 / status 看进度 / wait 等成员跑完 / report 拿每人交代 / say 给某成员传话 / stop 停掉全队',
      },
      name: { type: 'string', description: 'create：团队名，例如「登录重构小队」。' },
      goal: { type: 'string', description: 'create：团队总目标（一句话说清最终要交付什么）。' },
      members: {
        type: 'array',
        description: 'create：成员列表。每个成员的 task 必须自包含（目标+文件范围+验收标准），成员之间的文件范围不要重叠。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '成员名字（面板上显示）' },
            role: { type: 'string', description: '角色，例如 前端 / 后端 / 测试 / 文档' },
            task: { type: 'string', description: '他的任务，自包含：做什么、改哪些文件、怎么算做完' },
            files: { type: 'array', items: { type: 'string' }, description: '他负责的文件/目录（其他成员别碰）' },
            model: { type: 'string', description: '可选：该成员单独用某个模型' },
            tools: { type: 'array', items: { type: 'string' }, description: '可选：限定该成员可用的工具' },
          },
          required: ['task'],
        },
      },
      concurrency: { type: 'integer', description: 'create：同时跑几个成员（默认取 settings.teamConcurrency，最大 10）。' },
      member: { type: 'string', description: 'say：成员名字或编号（m1）。' },
      message: { type: 'string', description: 'say：要对成员说的话。' },
      timeout_seconds: { type: 'integer', description: 'wait：最多等多少秒（默认 120）。超时也会把当前进度返回给你。' },
      open_dashboard: { type: 'boolean', description: 'create：是否顺手用系统浏览器打开团队面板（默认否，只在玩家要求时用）。' },
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
      if (team?.running) {
        return {
          isError: true,
          content: `已经有一支团队「${team.name}」在跑（${team.members.filter((m) => m.status === 'running').length} 人在忙）。先 team wait / team report / team stop 收掉它，再组新队。`,
        };
      }
      const concurrency = Math.max(1, Math.min(MAX_MEMBERS, Number(input.concurrency) || Number(cfg.settings?.teamConcurrency) || 2));
      team = new Team({
        config: cfg,
        cwd,
        name: String(input.name || 'AI 小队'),
        goal,
        members,
        concurrency,
        checkpoints: ctx?.checkpoints || null,
        emit: (item) => ctx?.emit?.(item),
      });
      setActiveTeam(team);
      const hub = await team.attachHub(cfg);
      team.start();

      if (input.open_dashboard && hub) openInBrowser(hub.url);
      const board = hub
        ? `团队面板：${hub.url}（浏览器里点任意成员，就能看他的完整对话：说了什么、调了哪些工具、结果和高亮；还能直接给他传话。关掉终端就停）`
        : '（团队面板未启动，请检查 settings.progress / progressPort）';
      const plan = team.members.map((m) => `· ${m.id} ${m.name}（${m.role}）${m.files.length ? ` → ${m.files.join(', ')}` : ''}\n    ${m.task}`).join('\n');
      return {
        content: [
          `团队「${team.name}」已开工：${team.members.length} 人 · 并发 ${concurrency} · 成员在后台并行跑。`,
          `目标：${goal}`,
          plan,
          board,
          '接下来：你继续做自己负责的那部分（或先给玩家汇报计划）；需要进度用 team/status，想等结果用 team/wait，最后用 team/report 汇总每位成员的交代，再合并、统一验证（跑测试）。',
        ].join('\n'),
        meta: { team: { id: team.id, name: team.name, members: team.members.length, concurrency }, summary: `${team.name} · ${team.members.length} 人在跑` },
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
        const hub = await ensureHub(cfg);
        ctx?.emit?.({ kind: 'note', text: `等团队「${team.name}」跑完（最多 ${secs}s）${hub ? ` · 团队面板 ${hub.url}` : ''}` });
        const how = await team.waitAll(secs * 1000);
        team.updateHub?.();
        if (how === 'timeout') {
          const running = team.members.filter((m) => m.status === 'running').length;
          return { content: `等了 ${secs}s，还有 ${running} 人没跑完（继续在后台跑）。当前进度：\n${snapText(team.snapshot())}\n可以再 team/wait，或先做别的事，最后 team/report。` };
        }
        return { content: `全队都跑完了：\n${snapText(team.snapshot())}\n\n${team.report()}`, meta: { team: team.snapshot(), summary: '全队完成' } };
      }
      // status
      const hub = await ensureHub(cfg);
      return {
        content: `${snapText(team.snapshot({ events: false }))}${hub ? `\n团队面板：${hub.url}` : ''}`,
        meta: { team: team.snapshot({ events: false }), summary: `${team.members.filter((m) => m.status === 'done').length}/${team.members.length} 完成` },
      };
    }

    if (action === 'say') {
      if (!team) return { isError: true, content: '当前没有团队在跑。' };
      const r = team.say(input.member, input.message);
      return { isError: !r.ok, content: r.content };
    }

    if (action === 'stop') {
      if (!team) return { content: '当前没有团队在跑。' };
      const ok = team.stop();
      return { content: ok ? `已让团队「${team.name}」停下（已完成的成员产出仍然有效，可用 team/report 取）。` : '团队已经收工了。' };
    }

    return { isError: true, content: `不认识的 action：${action}（可用：create / status / wait / report / say / stop）` };
  },
};
