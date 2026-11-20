// jobs 工具 — 让模型看得见、管得住自己跑过的命令。
//
// 为什么要有：shell 工具是 await 的，一条 10 分钟的构建会把对话卡死；而且
// 命令一旦被玩家的 /shellManager 终止、或者跑完退出码非 0，模型之前完全无感。
// 有了这个工具，模型才能「先起 dev server，再干别的，回头 tail 一下」。
//
// 数据源就是 src/jobs.js 的注册表 —— 和 /shellManager 面板、shell 工具共用
// 同一份记录，不会出现「面板里有、模型看不到」的割裂。
import { jobs } from '../jobs.js';
import { fmtBytes, fmtDuration } from '../util.js';

const MAX_TAIL_LINES = 200;

const STATUS_LABEL = {
  running: '跑着',
  ok: '成功',
  error: '失败',
  killed: '已终止',
  timeout: '超时',
};

function statusText(j) {
  if (j.status === 'running') return `● 跑着 ${fmtDuration(Date.now() - j.started)}`;
  const code = j.code === null || j.code === undefined ? '' : ` exit ${j.code}`;
  return `${STATUS_LABEL[j.status] || j.status}${code} · ${fmtDuration(j.dur)}`;
}

/** 列表里每行一条，别太长（模型读起来也省 token）。 */
function formatList(list) {
  if (!list.length) return '还没有任何命令记录。';
  const running = list.filter((j) => j.status === 'running').length;
  const lines = [`共 ${list.length} 条${running ? ` · ${running} 个在跑` : ''}（新的在前）：`];
  list.forEach((j, i) => {
    const bg = j.background ? ' [后台]' : '';
    lines.push(
      `${i + 1}. ${j.id}${bg} ${statusText(j)} · ${j.source}` +
        `${j.bytes ? ` · ${fmtBytes(j.bytes)}` : ''}\n   ${j.command.replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  });
  return lines.join('\n');
}

function pick(input) {
  const id = String(input.id || '').trim();
  const list = jobs.list(200);
  if (id) {
    // 先精确命中
    if (jobs.get(id)) return { job: jobs.get(id), list };
    // 再当前缀：短 id 也认（ids 形如 shmwoq8gfo3）
    const hits = list.filter((j) => j.id.startsWith(id));
    if (hits.length === 1) return { job: jobs.get(hits[0].id), list };
    if (hits.length > 1) {
      return { job: null, list, error: `id 前缀 ${id} 匹配到 ${hits.length} 条：${hits.map((j) => j.id).join(', ')}。请给更长的前缀。` };
    }
    return { job: null, list, error: `找不到 jobId=${id}。用 action="list" 看现有任务。` };
  }
  const n = Number(input.index);
  if (Number.isFinite(n) && n > 0 && n <= list.length) return { job: jobs.get(list[n - 1].id), list };
  if (list.length === 1) return { job: jobs.get(list[0].id), list };
  return { job: null, list, error: '请给 id（或 index，从 1 开始）。用 action="list" 看现有任务。' };
}

export const jobsTool = {
  name: 'jobs',
  label: 'Jobs',
  readOnly: false, // kill 会改状态
  description:
    '查看 / 收尾自己跑过的 shell 命令（和玩家界面的 `/shellManager` 面板是同一份记录）。\n' +
    'action="list"：所有命令的 id、状态、退出码、耗时、来源、输出大小；\n' +
    'action="tail"：看某条命令的输出（跑着的给实时尾巴，结束的给完整输出，可设 lines 取末尾几行）；\n' +
    'action="kill"：终止一条正在跑的命令。\n' +
    '典型用法：shell background=true 起 dev server → 干别的 → jobs tail 确认起来了 → 收工时 jobs kill。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'tail', 'kill'], description: 'list 列表 / tail 看输出 / kill 终止' },
      id: { type: 'string', description: 'jobId（可用前缀，如 shabc）；省略时按 index 或「只有一条」推断' },
      index: { type: 'integer', description: '按列表序号取（从 1 开始），和 action="list" 显示的一致' },
      lines: { type: 'integer', description: 'tail 时返回末尾多少行（默认 60，最多 200）' },
      limit: { type: 'integer', description: 'list 时最多列几条（默认 20）' },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = String(input.action || 'list').toLowerCase();

    if (action === 'list') {
      const n = Math.max(1, Math.min(200, Number(input.limit) || 20));
      const list = jobs.list(n);
      return {
        content: formatList(list),
        meta: { kind: 'jobs', count: list.length, running: list.filter((j) => j.status === 'running').length },
      };
    }

    if (action === 'tail') {
      const { job, error } = pick(input);
      if (!job) return { isError: true, content: error };
      const wantLines = Math.max(1, Math.min(MAX_TAIL_LINES, Number(input.lines) || 60));
      const running = job.status === 'running';
      const body = (running ? job.tail || job.output : job.output || job.tail) || '';
      const all = body.split('\n');
      const shown = all.slice(-wantLines);
      const head = [
        `# ${job.id}${job.background ? ' [后台]' : ''} ${statusText(job)} · ${job.source}`,
        `$ ${job.command}`,
        job.truncated ? `（输出已截断，原始 ${fmtBytes(job.bytes)}）` : '',
      ].filter(Boolean);
      const note =
        all.length > wantLines
          ? `\n…（共 ${all.length} 行，只显示末尾 ${wantLines} 行；要看更多就调大 lines）`
          : '';
      return {
        content: `${head.join('\n')}\n--- 输出 ---\n${shown.join('\n') || (running ? '（还没输出）' : '（没有输出）')}${note}`,
        meta: { kind: 'jobs', jobId: job.id, status: job.status, lines: all.length, running },
      };
    }

    if (action === 'kill') {
      const { job, error } = pick(input);
      if (!job) return { isError: true, content: error };
      if (job.status !== 'running') {
        return { content: `${job.id} 已经结束了（${statusText(job)}），不用终止。` };
      }
      const r = jobs.kill(job.id);
      return {
        isError: !r.ok,
        content: r.ok
          ? `${r.content}\n注意：shell 会话被一并杀掉了，下一条命令会自动重启一个新会话（cwd 会回到工作区根目录）。`
          : r.content,
        meta: { kind: 'jobs', jobId: job.id, killed: r.ok },
      };
    }

    return { isError: true, content: `未知 action: ${action}（可用 list / tail / kill）` };
  },
};
