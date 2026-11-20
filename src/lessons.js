// 跨任务经验库（lessons）：把子代理/团队踩过的坑记下来，下次派活时按任务
// 关键词召回最相关的几条，塞进简报。
//
// 为什么需要它：验收失败的原因、成员卡在哪、哪条路走不通 —— 这些信息现在
// 用完就丢。同一个坑下个任务重新踩一遍，就是纯浪费 token。
//
// 存储：<项目>/.agent/lessons.jsonl，一行一条 JSON（追加写，不上锁，坏了就跳过）。
// 召回：不搞分词（中文没法可靠切词），而是从文本里抓「ASCII 标识符」当标签
//       （文件名、函数名、报错码、包名 —— 这些东西跨任务重复率最高）。
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 512 * 1024; // 超过就轮转一次（留最近一半）
const MAX_KEEP = 300; // 读取时最多加载多少条（新的在后）

/** 单条经验的正文长度上限：太长会把简报挤爆，也没必要。 */
const MAX_TEXT = 300;

export function lessonsPath(cwd) {
  return path.join(cwd, '.agent', 'lessons.jsonl');
}

/** 从一段文本里抓出可以跨任务匹配的「标识符」标签。 */
export function tagsOf(text) {
  const src = String(text || '');
  const out = new Set();
  // 路径 / 文件名 / 标识符 / 报错码：3 字符以上，必须含字母（纯数字没意义）
  const re = /[A-Za-z0-9_@$./\\-]{3,}/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[0].replace(/\\/g, '/').replace(/^[./-]+|[./-]+$/g, '');
    if (raw.length < 3) continue;
    if (!/[A-Za-z]/.test(raw)) continue;
    // 太常见的词当标签没有区分度
    if (NOISE.has(raw.toLowerCase())) continue;
    out.add(raw.toLowerCase());
    if (out.size >= 40) break;
  }
  return [...out];
}

const NOISE = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'not', 'but', 'you', 'can',
  'var', 'let', 'const', 'return', 'function', 'null', 'undefined', 'true', 'false',
  'node', 'npm', 'test', 'src', 'lib', 'dist', 'error', 'exit', 'stdout', 'stderr',
  'cmd', 'bash', 'shell', 'path', 'file', 'true', 'false', 'null',
]);

/** 一条经验是否「值钱」（不值得记的全丢掉，否则库会变成噪音垃圾场）。 */
function worthKeeping(kind, text) {
  const t = String(text || '').trim();
  if (t.length < 8) return false;
  if (kind === 'blocked' && /^(还没|暂无|无$)/.test(t)) return false;
  return true;
}

/**
 * 记一条经验。
 * @param {string} cwd 工作区
 * @param {{task?:string, kind:string, text:string, tags?:string[]}} o
 *   kind: verify-fail 验收失败 / blocked 卡住 / error 出错 / pitfall 通用坑
 * @returns {boolean} 是否真的写进去了
 */
export function addLesson(cwd, { task = '', kind = 'pitfall', text = '', tags = [] } = {}) {
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!worthKeeping(kind, body)) return false;
  const file = lessonsPath(cwd);
  // 去重：同 kind + 同正文的只留最早那条（后面的重复没有新信息）
  const existing = loadLessons(cwd, { max: MAX_KEEP });
  if (existing.some((l) => l.kind === kind && l.text === body)) return false;
  const row = {
    ts: Date.now(),
    kind,
    // 任务只留一小段：用来让人看懂这条经验是在干什么活时踩的
    task: String(task || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    text: body,
    tags: [...new Set([...(Array.isArray(tags) ? tags : []), ...tagsOf(`${task} ${body}`)])].slice(0, 30),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 文件太大就轮转（只留最近一半，老的坑大概率已经修掉了）
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        const keep = existing.slice(-Math.floor(MAX_KEEP / 2));
        fs.writeFileSync(file, keep.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
    } catch {
      /* 文件还不存在 / 读不到，直接追加就是 */
    }
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false; // 记不下就算了，绝不能因为记经验把干活搞崩
  }
}

/** 读全部经验（新的在前）。坏行直接跳过，不让一条脏数据毁掉整个库。 */
export function loadLessons(cwd, { max = MAX_KEEP } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(lessonsPath(cwd), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o.text === 'string' && o.text.trim()) out.push(o);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out.slice(-Math.max(1, max)).reverse();
}

/**
 * 按当前任务召回最相关的几条经验。
 * 打分 = 标签交集数量；交集为 0 的一律不召回（宁可空着也不塞无关噪音）。
 * @returns {Array<{kind:string, text:string, task:string, score:number}>}
 */
export function recallLessons(cwd, task, { limit = 3 } = {}) {
  const want = new Set(tagsOf(task));
  if (!want.size) return [];
  const hits = [];
  for (const l of loadLessons(cwd)) {
    const lt = Array.isArray(l.tags) ? l.tags : tagsOf(l.text);
    let score = 0;
    for (const t of lt) if (want.has(t)) score++;
    if (!score) continue;
    hits.push({ kind: l.kind, text: l.text, task: l.task || '', score, ts: l.ts || 0 });
  }
  // 分数高的优先；同分取更新的
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return hits.slice(0, Math.max(1, limit));
}

const KIND_WORD = {
  'verify-fail': '验收失败',
  blocked: '卡住',
  error: '出错',
  pitfall: '踩过的坑',
};

/** 把召回结果渲染成简报里的一段（没命中就返回空串，不要输出空标题）。 */
export function renderLessons(list, { maxChars = 900 } = {}) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return '';
  const lines = [];
  let used = 0;
  for (const l of rows) {
    const line = `- [${KIND_WORD[l.kind] || l.kind}] ${l.text}${l.task ? `（当时在做：${l.task}）` : ''}`;
    if (used + line.length > maxChars && lines.length) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
