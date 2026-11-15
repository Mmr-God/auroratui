// 浏览器后端「手动开工」：玩家在 /spawn 页面直接组队或派一个子代理。
// 与模型调用 team/subagent 工具的区别：这是玩家亲自发起，不受 settings.team /
// settings.subagents 的开关限制（那两个开关只防止模型自作主张烧 token）。
import { Team, getActiveTeam, setActiveTeam, MAX_MEMBERS } from './team.js';
import { runSubagent } from './subagent.js';
import { ensureHub, Transcript } from './progress.js';

const soloList = [];

function pushSolo(entry) {
  const i = soloList.findIndex((x) => x.id === entry.id);
  if (i >= 0) soloList[i] = { ...soloList[i], ...entry };
  else soloList.unshift(entry);
  if (soloList.length > 8) soloList.length = 8;
  return soloList.slice();
}

function oneLine(v, n = 200) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

export async function spawnFromBrowser({ config, cwd, checkpoints = null, emit = null } = {}, payload = {}) {
  const kind = String(payload.kind || 'team').toLowerCase();
  const hub = await ensureHub(config);
  if (!hub) throw new Error('面板服务没起来（检查 settings.progress / progressPort）');

  if (kind === 'solo') {
    const task = String(payload.task || '').trim();
    if (!task) return { ok: false, content: '任务不能为空。' };
    const name = String(payload.name || '子代理').trim() || '子代理';
    const role = String(payload.role || '').trim();
    const model = String(payload.model || '').trim();
    const maxSteps = Math.max(1, Math.min(200, Number(payload.maxSteps) || 40));
    const timeoutSec = Math.max(30, Math.min(3600, Number(payload.timeoutSec) || 600));
    const tools = Array.isArray(payload.tools)
      ? payload.tools
      : String(payload.tools || '')
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
    const id = `b${Date.now().toString(36)}`;
    const tr = new Transcript();
    tr.task(task + (role ? `\n\n角色：${role}` : ''));
    const startedAt = Date.now();
    const base = {
      id,
      name,
      role: role || '子代理',
      task,
      status: 'running',
      steps: 0,
      toolCalls: 0,
      tokens: {},
      cost: 0,
      startedAt,
      last: '开工',
      events: tr.entries(),
    };
    hub.update({ title: 'AuroraTui · 子代理', solo: pushSolo(base) });
    hub.log({ kind: 'start', who: name, text: `浏览器手动派活：${task.slice(0, 120)}` });

    // 后台跑，HTTP 请求立刻返回
    let toolCalls = 0;
    let last = '';
    (async () => {
      try {
        const res = await runSubagent({
          config,
          cwd,
          task,
          role,
          model,
          tools: tools.length ? tools : null,
          maxSteps,
          timeoutSec,
          depth: 1,
          checkpoints,
          onEvent: (ev) => {
            tr.feed(ev);
            if (ev.type === 'tool_start') {
              toolCalls++;
              last = `${ev.name} ${oneLine(ev.input?.path || ev.input?.command || ev.input?.pattern || '', 80)}`.trim();
              hub.update({ solo: pushSolo({ id, toolCalls, last, status: 'running', events: tr.entries() }) });
              hub.log({ kind: 'tool', who: name, text: last });
            } else if (ev.type === 'step') {
              hub.update({ solo: pushSolo({ id, steps: ev.step, toolCalls, last, status: 'running', events: tr.entries() }) });
            } else if (ev.type === 'usage') {
              const u = ev.total || {};
              hub.update({
                solo: pushSolo({
                  id,
                  steps: u.steps || 0,
                  tokens: { input: u.input || 0, output: u.output || 0 },
                  cost: u.cost || 0,
                  events: tr.entries(),
                }),
              });
            } else if (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool_end') {
              hub.update({ solo: pushSolo({ id, events: tr.entries() }) });
            }
          },
        });
        tr.result(res.text || '（没有输出）');
        hub.update({
          solo: pushSolo({
            id,
            status: res.aborted ? 'stopped' : res.timedOut && !res.wrappedUp ? 'stopped' : 'done',
            endedAt: Date.now(),
            last: oneLine(res.text, 160),
            steps: res.steps || 0,
            events: tr.entries(),
          }),
        });
        hub.log({ kind: 'done', who: name, text: `收工：${oneLine(res.text, 200)}` });
      } catch (e) {
        const msg = e?.message || String(e);
        tr.error(`跑挂了：${msg}`);
        hub.update({ solo: pushSolo({ id, status: 'error', endedAt: Date.now(), last: msg.slice(0, 160), events: tr.entries() }) });
        hub.log({ kind: 'error', who: name, text: msg });
      }
    })();

    return {
      ok: true,
      content: `子代理「${name}」已开工（${maxSteps} 步上限，${timeoutSec}s 超时）。面板会实时显示他的进度；跑完在全局动态里有结论。`,
      url: hub.url,
    };
  }

  // ---- 团队
  const goal = String(payload.goal || '').trim();
  if (!goal) return { ok: false, content: '团队目标（goal）不能为空。' };
  const raw = Array.isArray(payload.members) ? payload.members : [];
  const members = raw
    .map((m, i) => ({
      name: String(m?.name || `成员${i + 1}`).trim() || `成员${i + 1}`,
      role: String(m?.role || '开发').trim() || '开发',
      task: String(m?.task || '').trim(),
      files: Array.isArray(m?.files)
        ? m.files
        : String(m?.files || '')
            .split(/[,，\n]+/)
            .map((s) => s.trim())
            .filter(Boolean),
    }))
    .filter((m) => m.task);
  if (!members.length) return { ok: false, content: '至少要有 1 个成员，而且每个成员都要有任务描述。' };
  const running = getActiveTeam();
  if (running?.running) {
    return {
      ok: false,
      content: `已经有一支团队「${running.name}」在跑，等它收工或先在终端 team stop 后再建新队。`,
    };
  }
  const concurrency = Math.max(1, Math.min(MAX_MEMBERS, Number(payload.concurrency) || 2));
  const team = new Team({
    config,
    cwd,
    name: String(payload.name || '浏览器小队').trim() || '浏览器小队',
    goal,
    members: members.slice(0, MAX_MEMBERS),
    concurrency,
    checkpoints,
    emit: (item) => {
      try {
        emit?.(item);
      } catch {}
    },
  });
  setActiveTeam(team);
  await team.attachHub(config);
  team.start();
  return {
    ok: true,
    content: `团队「${team.name}」已开工：${team.members.length} 人 · 并发 ${concurrency}。成员在后台并行跑，面板里能点开每个人看全过程。`,
    url: hub.url,
  };
}

/** 给页面用：解析 textarea 里「名字 | 角色 | 任务 | 文件1,文件2」的行。 */
export function parseMemberLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, i) => {
      // 任务里可能也有 |：最后一段只有当它「每个词都像路径」时才当文件列表
      const parts = line.split('|').map((s) => s.trim());
      let files = [];
      if (parts.length >= 4) {
        const cand = parts[parts.length - 1].split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        const looksLikeFiles = cand.length > 0 && cand.every((f) => /[.\/\\~]/.test(f) && !/\s/.test(f));
        if (looksLikeFiles) files = parts.pop().split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
      }
      const task = parts.slice(2).join(' | ').trim();
      return { name: parts[0] || `成员${i + 1}`, role: parts[1] || '开发', task, files };
    })
    .filter((m) => m.task);
}
