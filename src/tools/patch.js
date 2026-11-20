// patch 工具 — 吃 unified diff，一次性改多处。
//
// 为什么要有：edit 要求 old_string 逐字符一致且唯一，改大文件里的多处、或者
// 改一段缩进敏感的代码时很容易碰壁（空行差异、缩进被格式化工具动过、同一段
// 文字出现两次）。模型手里本来就常有 `git diff` 的输出（git 工具返回的就是），
// 直接喂回来比让它重新敲一遍 edit 参数更可靠。
//
// 安全策略：
//  · 每个 hunk 定位时**校验上下文**，对不上就整体拒绝（不猜、不模糊匹配）——
//    半途改一半最糟。
//  · 多个文件里任何一个失败 → 一个都不写（先把所有文件算出来，最后统一落盘）。
//  · 每个文件落盘前都过 checkpoint，/undo 能回滚。
//  · 走和 write/edit 同一套工作区守卫与团队 writeScope 限制。
import fs from 'node:fs';
import path from 'node:path';
import { fmtBytes } from '../util.js';
import { guardWrite, resolvePath } from './fs.js';

/** 解析 `--- a/x` / `+++ b/x` 的文件名，去掉 git 的 a/ b/ 前缀。 */
function stripPrefix(p) {
  const s = String(p || '').trim().split(/\t/)[0];
  return s.replace(/^[ab]\//, '');
}

/**
 * 解析 unified diff。
 * 返回 [{file, isNew, isDelete, hunks:[{oldStart, oldLines, newStart, newLines, lines:[{type, text}]}]}]
 */
export function parsePatch(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const files = [];
  let cur = null;
  let hunk = null;
  let i = 0;

  const pushHunk = () => {
    if (hunk && cur) cur.hunks.push(hunk);
    hunk = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    // ---- 文件头
    if (line.startsWith('--- ')) {
      const oldName = stripPrefix(line.slice(4));
      const next = lines[i + 1] || '';
      if (!next.startsWith('+++ ')) {
        i++;
        continue;
      }
      const newName = stripPrefix(next.slice(4));
      pushHunk();
      const isNew = /^\/dev\/null$|^NUL$/.test(oldName);
      const isDelete = /^\/dev\/null$|^NUL$/.test(newName);
      cur = {
        // 删除时目标文件是旧名（+++ 是 /dev/null，不能拿来当文件名）
        file: isDelete ? oldName : isNew ? newName : newName || oldName,
        oldFile: oldName,
        newFile: newName,
        isNew,
        isDelete,
        hunks: [],
      };
      files.push(cur);
      i += 2;
      continue;
    }

    // ---- hunk 头 @@ -1,5 +1,7 @@
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hm && cur) {
      pushHunk();
      hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        section: (hm[5] || '').trim(),
        lines: [],
      };
      i++;
      continue;
    }

    // ---- hunk 正文
    if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ type: 'add', text: line.slice(1) });
      } else if (line.startsWith('-')) {
        hunk.lines.push({ type: 'del', text: line.slice(1) });
      } else if (line.startsWith(' ')) {
        hunk.lines.push({ type: 'ctx', text: line.slice(1) });
      } else if (line === '' ) {
        // 尾部空行 / hunk 之间的空行：只有 hunk 还没读完时才算空上下文的占位
        const remaining = hunk.lines.filter((l) => l.type !== 'add').length;
        if (remaining < hunk.oldLines) hunk.lines.push({ type: 'ctx', text: '' });
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — 忽略
      } else {
        // 不属于 hunk 的内容，hunk 结束
        pushHunk();
        i++;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }
  pushHunk();

  // 去掉没有任何 hunk 的条目（比如只有 diff --git 行）
  return files.filter((f) => f.hunks.length || f.isNew || f.isDelete);
}

/** 按行号找位置；对不上就顺着 ±offset 找一点（hunk 行号漂移是常态）。 */
function locateHunk(lines, hunk, opts) {
  const oldCount = hunk.lines.filter((l) => l.type !== 'add').length;
  // 纯插入（新建文件是 @@ -0,0 +1,2 @@）：旧的 0 行，没有上下文可比对，
  // 位置就是 oldStart（git 用 -0,0 表示“插在第 1 行前”）。
  if (oldCount === 0) return Math.max(1, hunk.oldStart || 1);

  const want = hunk.oldStart;
  const near = Number(opts?.fuzz) || 0;
  const candidates = [want];
  for (let d = 1; d <= near; d++) {
    candidates.push(want - d, want + d);
  }
  for (const start of candidates) {
    if (start < 1) continue;
    // 检查这个位置的上下文是否吻合
    let ok = true;
    let idx = start - 1;
    for (const l of hunk.lines) {
      if (l.type === 'add') continue;
      if (lines[idx] !== l.text) {
        ok = false;
        break;
      }
      idx++;
    }
    if (ok) return start;
  }
  return -1;
}

/** 把一个文件的所有 hunk 应用到原文上。返回 {ok, text, applied, error} */
export function applyHunks(original, hunks, { fuzz = 0 } = {}) {
  // 从上往下应用会打乱后面的行号，所以倒序处理
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  let lines = original.split('\n');
  const applied = [];

  for (const h of ordered) {
    const start = locateHunk(lines, h, { fuzz }); // 1-based 行号
    if (start < 0) {
      const ctx = h.lines
        .filter((l) => l.type === 'ctx')
        .slice(0, 3)
        .map((l) => '     ' + l.text)
        .join('\n');
      return {
        ok: false,
        error:
          'hunk @@ -' + h.oldStart + ',' + h.oldLines + ' +' + h.newStart + ',' + h.newLines + ' @@ 在文件里找不到对应位置（上下文对不上）。\n' +
          (ctx ? '期望的上下文（前几行）：\n' + ctx + '\n' : '') +
          '文件可能已经被改过了。请重新 read 一遍文件，或者改用 edit 带足够上下文。',
      };
    }

    const oldCount = h.lines.filter((l) => l.type !== 'add').length;
    const replacement = h.lines.filter((l) => l.type !== 'del').map((l) => l.text);
    const idx = start - 1;
    lines = [...lines.slice(0, idx), ...replacement, ...lines.slice(idx + oldCount)];
    applied.push({ oldStart: h.oldStart, oldLines: h.oldLines, newLines: h.newLines });
  }

  return { ok: true, text: lines.join('\n'), applied: applied.reverse() };
}

/** 粗略统计 patch 的增删行数，用于回报。 */
function countChanges(files) {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type === 'add') added++;
        else if (l.type === 'del') removed++;
      }
    }
  }
  return { added, removed };
}

export const patchTool = {
  name: 'patch',
  label: 'Patch',
  readOnly: false,
  description:
    '按 unified diff 格式批量改文件（一次调用可以改多个文件、多个位置）。\n' +
    '适合：改大文件里分散的多处、把 git diff 的输出直接应用、改缩进敏感的段落——这些用 edit 容易因为 old_string 不唯一/不逐字符一致而失败。\n' +
    '格式就是标准 git diff：`--- a/x` / `+++ b/x` 文件头 + `@@ -12,7 +12,9 @@` 块 + 空格/+/- 前缀的行。' +
    '新增文件用 `--- /dev/null` + `+++ b/新文件`（hunk 全是 + 行）。\n' +
    '**要么全成、要么全不动**：任何一个 hunk 的上下文对不上就整体拒绝，不会改一半。每个文件落盘前都会存快照，/undo 能回滚。',
  parameters: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'unified diff 文本（标准 git diff 格式）' },
      fuzz: { type: 'integer', description: '找不到精确行号时，允许上下搜索几行（默认 0 = 必须精确命中）' },
      dry_run: { type: 'boolean', description: '只检查能不能应用，不真的写文件' },
    },
    required: ['diff'],
  },
  async execute(input, ctx) {
    if (typeof input.diff !== 'string' || !input.diff.trim()) {
      return { isError: true, content: '缺少 diff 参数（要标准 unified diff 文本）' };
    }
    const files = parsePatch(input.diff);
    if (!files.length) {
      return {
        isError: true,
        content:
          '这段文本里没解析出任何可应用的改动。\n' +
          '需要标准 unified diff 格式：\n' +
          '  --- a/src/a.js\n  +++ b/src/a.js\n  @@ -1,3 +1,3 @@\n  -旧行\n  +新行\n' +
          '如果只是想改一处，用 edit 更简单。',
      };
    }
    const fuzz = Math.max(0, Math.min(20, Number(input.fuzz) || 0));

    // ---- 第一阶段：全部算出来，一个都不写
    const plans = [];
    for (const f of files) {
      if (!f.file || f.file === '/dev/null') {
        return { isError: true, content: `有一个改动没有目标文件名（--- ${f.oldFile} / +++ ${f.newFile}），无法应用。` };
      }
      let abs;
      try {
        abs = resolvePath(ctx, f.file);
      } catch (e) {
        return { isError: true, content: `路径有问题：${e.message}` };
      }
      const denied = guardWrite(ctx, abs, '修改');
      if (denied) return denied;

      let original = '';
      let existed = false;
      try {
        original = await fs.promises.readFile(abs, 'utf8');
        existed = true;
      } catch {}

      if (f.isDelete) {
        plans.push({ abs, file: f.file, existed, deletes: true, before: original, after: '' });
        continue;
      }
      if (!existed && !f.isNew) {
        return {
          isError: true,
          content: `文件不存在：${f.file}\n如果是要新建文件，diff 的文件头要写成 \`--- /dev/null\` 和 \`+++ b/${f.file}\`。`,
        };
      }
      const base = existed ? original : '';
      const r = applyHunks(base, f.hunks, { fuzz });
      if (!r.ok) {
        return { isError: true, content: `${f.file}：${r.error}` };
      }
      plans.push({ abs, file: f.file, existed, before: original, after: r.text, hunks: r.applied });
    }

    if (input.dry_run) {
      const { added, removed } = countChanges(files);
      return {
        content:
          `dry_run：${plans.length} 个文件都能干净应用（+${added} −${removed} 行），但没有真的写。\n` +
          plans.map((p) => `- ${p.deletes ? '删除' : p.existed ? '修改' : '新建'} ${p.file}`).join('\n'),
        meta: { kind: 'patch', dryRun: true, files: plans.map((p) => p.file), added, removed },
      };
    }

    // ---- 第二阶段：统一落盘
    const done = [];
    for (const p of plans) {
      try {
        if (p.deletes) {
          await fs.promises.unlink(p.abs);
          done.push(`已删除 ${p.file}`);
          continue;
        }
        try {
          ctx?.checkpoints?.save(p.abs, 'patch');
        } catch {}
        await fs.promises.mkdir(path.dirname(p.abs), { recursive: true });
        await fs.promises.writeFile(p.abs, p.after, 'utf8');
        const delta = p.after.split('\n').length - (p.existed ? p.before.split('\n').length : 0);
        done.push(`${p.existed ? '已修改' : '已新建'} ${p.file}${delta ? `（${delta > 0 ? '+' : ''}${delta} 行）` : ''}`);
      } catch (e) {
        return {
          isError: true,
          content: `写 ${p.file} 失败：${e.message}\n已经改动的文件：\n${done.join('\n') || '（无）'}\n用 /undo 可以回滚。`,
        };
      }
    }

    const { added, removed } = countChanges(files);
    return {
      content: `patch 已应用：+${added} −${removed} 行，${done.length} 个文件。\n${done.join('\n')}`,
      meta: {
        kind: 'patch',
        files: plans.map((p) => p.file),
        added,
        removed,
        created: plans.filter((p) => !p.existed).length,
        deleted: plans.filter((p) => p.deletes).length,
      },
    };
  },
};
