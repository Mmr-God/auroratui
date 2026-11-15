// draw 插件 —— 给 AI 一块像素画板：画 → 存 PNG → 用 read 亲眼看看 → 继续改。
//
// 核心思路来自 pixel-forge（D:\Works\Mader\pixel-forge）：
//   模型不会画图也能画 —— 它只负责输出「短小的绘图操作 JSON」，
//   本地把它栅格化成像素，编码成 PNG；模型再用 read 把 PNG 读回对话里，
//   于是「看不见自己画了什么」的问题就消失了，形成 画→看→改 的闭环。
//
// 特点：
//  - 画板按名字持久化（~/.agent/draw/<name>.json），跨调用接着改，支持 undo
//  - 18 种内置主体配方（stamp op，移植自 pixel-forge 的 subject-recipes）
//  - 锚点相对坐标（anchor:[x,y] + dx/dy），省 token、方便整体挪
//  - 每次返回 ASCII 预览 + 诊断（包围盒/配色/对称度/孤立像素）
//  - **PNG 直接挂进工具结果（meta.images）**：模型下一步就"看见"画面，
//    不用再多花一次 read 调用。read 仍然可用（想放大看细节时传 scale）
//  - 版本化文件名？不用：同名覆盖，read 每次都看到最新画面
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Canvas, applyOps, encodePngScaled, asciiPreview, resolveColor, shade, OP_NAMES, cropCanvas,
} from './core.js';
import { drawRecipeInto, recipeKeys, SUBJECT_RECIPES } from './recipes.js';
import { drawPartInto, partKeys, findPart } from './parts.js';

// 画板存档目录：跟随 AGENT_HOME（测试 / 便携安装），否则 ~/.agent/draw
const AGENT_HOME = process.env.AGENT_HOME ? path.resolve(process.env.AGENT_HOME) : path.join(os.homedir(), '.agent');
const ROOT = path.join(AGENT_HOME, 'draw');
const MAX = 256;
const MIN = 8;
const HISTORY = 6;

const safeName = (n) => String(n || 'board').trim().replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 60) || 'board';
const boardFile = (name) => path.join(ROOT, `${safeName(name)}.json`);

function loadBoard(name) {
  try {
    const j = JSON.parse(fs.readFileSync(boardFile(name), 'utf8'));
    const cv = new Canvas(j.w, j.h);
    const buf = Buffer.from(j.data || '', 'base64');
    if (buf.length === cv.data.length) cv.data.set(buf);
    if (j.pen) cv.pen = { x: Number(j.pen.x) || 0, y: Number(j.pen.y) || 0 };
    return { cv, history: Array.isArray(j.history) ? j.history : [] };
  } catch {
    return null;
  }
}

function saveBoard(name, cv, history) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(
    boardFile(name),
    JSON.stringify({
      w: cv.w,
      h: cv.h,
      data: Buffer.from(cv.data).toString('base64'),
      pen: cv.pen,
      history,
      savedAt: new Date().toISOString(),
    })
  );
}

const snapshot = (cv) => ({ w: cv.w, h: cv.h, data: Buffer.from(cv.data).toString('base64'), pen: { ...cv.pen } });
function restoreBoard(snap) {
  const cv = new Canvas(snap.w, snap.h);
  const buf = Buffer.from(snap.data, 'base64');
  if (buf.length === cv.data.length) cv.data.set(buf);
  if (snap.pen) cv.pen = { x: snap.pen.x, y: snap.pen.y };
  return cv;
}

/** 画板目录（PNG 落盘位置）：项目内 drawings/，没有 cwd 时退回 ~/.agent/draw/out */
function outDir(ctx) {
  const base = ctx?.cwd || process.cwd();
  try {
    fs.mkdirSync(path.join(base, 'drawings'), { recursive: true });
    return path.join(base, 'drawings');
  } catch {
    const d = path.join(ROOT, 'out');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

/** 诊断：把「哪里不对」直接说给模型听，比让它自己猜有效得多 */
function diagnose(cv) {
  const tips = [];
  const opaque = cv.countOpaque();
  const total = cv.w * cv.h;
  const stats = cv.colorStats(8);
  if (!opaque) {
    tips.push('画板还是空的（没有任何不透明像素）');
    return { box: null, subject: null, opaque, total, stats, bg: null, tips };
  }

  // 有背景的画（渐变天空、地面）不该被当成「主体糊满画布 / 贴边」——
  // 先用「从最外一圈漫填」的办法把整块背景标出来，主体单独算。
  const bgm = cv.bgMask();
  let bgCount = 0;
  if (bgm) for (let k = 0; k < bgm.length; k++) bgCount += bgm[k];
  const bg = bgm ? cv.borderStats(1).list[0]?.hex ?? null : null;

  const box = cv.bbox();
  const subject = bgm ? cv.bboxMasked(bgm) : box;
  const subjectPixels = bgm ? opaque - bgCount : opaque;

  if (bgm) {
    tips.push(`检测到底色/背景（约 ${((bgCount / total) * 100).toFixed(0)}% 面积，主色 ${bg}）；下面的主体统计已排除它`);
  }
  if (!subject) tips.push('除了背景以外什么都没画，主体还是空的');
  else if (bgm) {
    // 有背景 = 场景画：地面/天空贴边是正常的，别拿精灵图那套"必须留白"来要求它
    if (subjectPixels / total < 0.02) tips.push(`主体太小：只占 ${(subjectPixels / total * 100).toFixed(1)}% 画布，放大一点`);
  } else {
    if (subjectPixels / total < 0.02) tips.push(`主体太小：只占 ${(subjectPixels / total * 100).toFixed(1)}% 画布，试试放大或跑一次 margin`);
    if (opaque / total > 0.92) tips.push('几乎糊满整张画布，没有留白，加一点 erase 留出呼吸空间');
    if (subject.minX <= 0 || subject.minY <= 0 || subject.maxX >= cv.w - 1 || subject.maxY >= cv.h - 1) {
      tips.push('主体贴到画布边缘了：用 {"op":"shift","dx":..,"dy":..} 或 {"op":"margin"} 拉回来');
    }
    if (subject.w < cv.w * 0.25 || subject.h < cv.h * 0.25) tips.push('主体偏小，可 shift + 放大重画，或换更大的 size 重来');
  }
  const iso = cv.isolated();
  if (iso.length) tips.push(`有 ${iso.length} 个孤立像素（噪点），可能是坐标写错：${iso.slice(0, 3).map((p) => `(${p[0]},${p[1]})`).join(' ')}`);
  // 渐变会自然产生很多中间色：有背景时放宽阈值，别催着量化
  const maxColors = bgm ? 64 : 16;
  if (stats.unique > maxColors) {
    tips.push(`用了 ${stats.unique} 种颜色，超过 ${maxColors} 色会显得脏：跑一次 {"op":"palette","colors":${bgm ? 24 : 16}}`);
  }
  return { box, subject, opaque, subjectPixels, total, stats, bg, tips };
}

/** 一条 op 里的 stamp 需要配方库，所以放在这里而不是 core.js */
function applyStamp(cv, op) {
  const key = op.recipe || op.stamp || op.subject || op.key;
  const ov = {};
  for (const k of ['main', 'accent', 'white', 'dark']) if (op[k]) ov[k] = resolveColor(op[k]);
  const ok = drawRecipeInto(cv, key, ov, {
    x: op.x == null ? undefined : Number(op.x),
    y: op.y == null ? undefined : Number(op.y),
    size: op.size == null ? undefined : Number(op.size),
  });
  return ok;
}

/** 部件（眼/嘴/翅膀/帽子…）：按 anchor 相对坐标贴到画板上 */
function applyPart(cv, op) {
  const ax = Array.isArray(op.anchor) ? Number(op.anchor[0]) : 0;
  const ay = Array.isArray(op.anchor) ? Number(op.anchor[1]) : 0;
  return drawPartInto(cv, op.part || op.name || op.key, {
    x: op.x == null ? undefined : Number(op.x) + ax,
    y: op.y == null ? undefined : Number(op.y) + ay,
    size: op.size == null ? undefined : Number(op.size),
    variant: op.variant || op.kind || op.style,
    color: op.color || op.main ? resolveColor(op.color || op.main) : undefined,
    accent: op.accent ? resolveColor(op.accent) : undefined,
    flip: op.flip === true || op.flip === 'true',
  });
}

export const drawTool = {
  name: 'draw',
  label: 'Draw',
  description:
    '像素画板：你输出绘图操作（ops），本地栅格化成像素并保存 PNG，**这张画会直接作为图片附在这次工具结果里**' +
    '（识图模型当场就能看见），你看图判断哪儿不对，再继续调用 draw（同名画板保留上次画面）修改，' +
    '反复 画→看→改 直到满意。不需要任何图像生成模型。\n' +
    '- 起手最快：{"op":"stamp","recipe":"penguin"} —— 内置配方：' +
    recipeKeys().map((r) => r.key).join('/') +
    '，stamp 完再用 op 改细节\n' +
    '- 贴零件：{"op":"part","part":"eyes","x":18,"y":24,"size":14} —— 内置部件：' +
    partKeys().map((r) => `${r.key}${r.variants.length ? `(${r.variants.join('/')})` : ''}`).join(' ') +
    '。画眼睛/嘴/翅膀这些 1~2px 的细节不要手算坐标，用 part 贴（支持 x/y/size/variant/color/accent/flip/anchor）\n' +
    '- 常用 op：fill_ellipse/fill_rect/fill_poly/line/pixel/ellipse/rect/flood_fill/outline_in/outline_out/' +
    'gradient/mirror_x/mirror_y/shift/erase/clear/margin/palette/noise\n' +
    '- 相对坐标：op 里给 "anchor":[x,y]，则 x/y/cx/cy/pts 都按相对锚点的偏移算\n' +
    '- 颜色：#rrggbb/#rgb/#rrggbbaa（8 位带透明度，如 #00000055 半透明阴影）或速记名 black/white/red/green/blue/yellow/orange/purple/pink/brown/gray/gold/navy/sand/skin/sky/grass/wood/steel\n' +
    '- 每轮建议 5~15 条 op，先用大色块定形，看图后再加细节，最后 outline_in 描边\n' +
    '- 细节看不清：scale:4~8 放大导出（像素画放大不糊），或 crop:{x,y,w,h} 只看局部（配 scale:12 看 1~2px 的眼睛）',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '画板名（如 "slime"）；同名画板会保留上次画面，便于接着改' },
      size: { type: 'number', description: '新建时的画布边长（8~256），默认 64；像素画建议 32/64' },
      w: { type: 'number', description: '新建时的画布宽（省略则用 size）' },
      h: { type: 'number', description: '新建时的画布高（省略则用 size）' },
      ops: { type: 'array', description: '绘图操作数组，例如 [{"op":"fill_ellipse","cx":32,"cy":34,"rx":18,"ry":16,"color":"#3b82f6"}]', items: { type: 'object' } },
      view: { type: 'boolean', description: 'true = 只看不改（返回 ASCII 预览 + 诊断 + PNG 路径）' },
      undo: { type: 'number', description: '回退 n 步（仅在传了 ops 之前生效；不传 ops 只 undo 也可）' },
      scale: { type: 'number', description: '导出 PNG 的最近邻放大倍数（1~16，默认 1；想看细节时用 4）' },
      crop: {
        type: 'object',
        description: '只看局部：{"x":..,"y":..,"w":..,"h":..}，把这一块裁出来放大成这次的图（不改画板）。画眼睛这种 1~2 像素的细节时必用',
      },
      save: { type: 'string', description: '额外另存一份 PNG 的路径（相对 cwd）' },
      stats: { type: 'boolean', description: 'true 时附上完整配色统计（默认只给摘要）' },
      ascii: { type: 'boolean', description: 'true 时额外返回 48 行 ASCII 索引预览（默认不给：图已经附在结果里，这堆字符只占位置）' },
    },
    required: ['name'],
  },
  async execute(input, ctx = {}) {
    const name = safeName(input?.name || 'board');
    const loaded = loadBoard(name);
    const created = !loaded;
    let cv;
    let history;
    if (loaded) {
      cv = loaded.cv;
      history = loaded.history;
    } else {
      const s = Math.max(MIN, Math.min(MAX, Math.round(Number(input?.size ?? 64) || 64)));
      const w = Math.max(MIN, Math.min(MAX, Math.round(Number(input?.w ?? s) || s)));
      const h = Math.max(MIN, Math.min(MAX, Math.round(Number(input?.h ?? s) || s)));
      cv = new Canvas(w, h);
      history = [];
    }

    const notes = [];
    // 1) 先做 undo（从快照回滚）
    const undoN = Math.max(0, Math.min(HISTORY, Math.round(Number(input?.undo) || 0)));
    if (undoN && history.length) {
      const snap = history.splice(-Math.min(undoN, history.length)).pop();
      if (snap) {
        cv = restoreBoard(snap);
        notes.push(`已回退到之前的快照（剩余 ${history.length} 步可回退）`);
      }
    }

    // 2) 执行 ops（先把当前状态压一份快照，方便 undo）
    let applied = 0;
    const bad = [];
    const ops = Array.isArray(input?.ops) ? input.ops : [];
    if (ops.length) {
      history.push(snapshot(cv));
      while (history.length > HISTORY) history.shift();
      for (const op of ops) {
        const kind = String(op?.op || '').toLowerCase();
        if (op && typeof op === 'object' && /^(stamp|recipe|subject)$/.test(kind)) {
          if (applyStamp(cv, op)) applied++;
          else bad.push({ ...op, _why: `未知配方 ${op.recipe ?? op.stamp ?? op.subject}（可用: ${SUBJECT_RECIPES.map((r) => r.key).join('/')}）` });
          continue;
        }
        if (op && typeof op === 'object' && /^(part|parts|append|attach)$/.test(kind)) {
          if (applyPart(cv, op)) applied++;
          else bad.push({ ...op, _why: `未知部件 ${op.part ?? op.name}（可用: ${partKeys().map((r) => r.key).join('/')}）` });
          continue;
        }
        const r = applyOps(cv, [op]);
        applied += r.applied;
        if (r.bad.length) bad.push(...r.bad);
      }
    }

    // 3) 落盘
    const changed = ops.length > 0 || undoN > 0;
    if (changed || !loaded) saveBoard(name, cv, history);
    const dir = outDir(ctx);
    const scale = Math.max(1, Math.min(16, Math.round(Number(input?.scale) || 1)));
    // 可选局部放大：crop:{x,y,w,h} —— 整张图看不清细节时（眼睛只有 1~2 像素）用它
    // 只对「你看到的这张图」生效，不改画板本身。
    let shown = cv;
    let cropped = null;
    if (input?.crop && typeof input.crop === 'object') {
      const c = input.crop;
      cropped = cropCanvas(cv, Number(c.x || 0), Number(c.y || 0), Number(c.w ?? cv.w), Number(c.h ?? cv.h));
      if (cropped.w && cropped.h) shown = cropped;
    }
    const png = encodePngScaled(shown.w, shown.h, shown.data, scale);
    const file = path.join(dir, `${name}${cropped ? `_crop${cropped.w}x${cropped.h}` : ''}.png`);
    fs.writeFileSync(file, png);
    let extraPath = '';
    if (input?.save) {
      const p = path.isAbsolute(String(input.save)) ? String(input.save) : path.join(ctx?.cwd || process.cwd(), String(input.save));
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, png);
        extraPath = p;
      } catch (e) {
        notes.push(`另存失败：${e.message}`);
      }
    }

    // 4) 报告
    // ASCII 预览默认关：一次 48 行网格 ~2.7k 字符，比图本身贵 5 倍，
    // 而且模型看图靠的是附上来的 PNG，不是这堆索引字符。需要才传 ascii:true。
    const diag = diagnose(cv);
    const wantAscii = input?.ascii === true || input?.ascii === 'true';
    const pv = wantAscii ? asciiPreview(shown, Math.min(48, Math.max(shown.w, shown.h))) : null;
    const lines = [];
    lines.push(
      `画板「${name}」${created ? `新建 ${cv.w}×${cv.h}` : `沿用 ${cv.w}×${cv.h}`}` +
        `${applied ? ` · 应用 ${applied} 条 op` : changed ? '' : ' · 未改动'}` +
        ` · 不透明像素 ${diag.opaque}/${diag.total}`
    );
    lines.push(`PNG：${file}${extraPath ? `\n另存：${extraPath}` : ''}${scale > 1 ? `（${scale}× 放大）` : ''}`);
    if (cropped) lines.push(`· 这是局部放大视图（画板 ${cv.w}×${cv.h} 的 ${cropped.w}×${cropped.h} 块，${scale}× 放大）；画板本身没变`);
    if (notes.length) lines.push(...notes.map((n) => `· ${n}`));
    if (bad.length) {
      const unknownOp = bad.find((b) => !b._why);
      const reasons = [...new Set(bad.map((b) => b._why).filter(Boolean))];
      lines.push(`⚠ ${bad.length} 条 op 没执行，前几条：${JSON.stringify(bad.slice(0, 3))}`);
      if (reasons.length) lines.push(`  原因：${reasons.join('；')}`);
      if (unknownOp) {
        lines.push(`  可用的 op 名：${OP_NAMES.join('/')}`);
        lines.push('  （或者坐标有笔误、pts 少于 3 点；stamp 的配方名见工具说明）');
      }
    }
    const box = diag.subject || diag.box;
    if (box) {
      lines.push(
        `${diag.bg ? '主体' : ''}包围盒 x ${box.minX}~${box.maxX}, y ${box.minY}~${box.maxY}（${box.w}×${box.h}）` +
          ` · 左右对称度 ${(cv.symmetry() * 100).toFixed(0)}%`
      );
    }
    lines.push(`配色 ${diag.stats.unique} 色：${diag.stats.list.slice(0, input?.stats ? 12 : 6).map((c) => `${c.hex}(${Math.round(c.pct * 100)}%)`).join(' ')}`);
    if (diag.tips.length) lines.push(...diag.tips.map((t) => `提示：${t}`));
    if (pv) {
      lines.push(`ASCII 预览（. =透明，0-f =调色板索引 ${pv.palette.join(' ')}）：`);
      lines.push(...pv.rows.map((r) => '  ' + r));
    }
    lines.push('');
    lines.push(
      applied || changed
        ? `下一步：画面已经附在上一步的工具结果里（${shown.w}×${shown.h} 像素${scale > 1 ? `，${scale}× 放大` : ''}），直接看它判断哪里不对。不满意就继续 draw（同名「${name}」+ 新 ops）；画错了用 erase 擦局部、undo:1 回退一步。想看清细节用 draw({name:"${name}", view:true, crop:{x,y,w,h}, scale:8})；想看全图就 view:true, scale:4。`
        : `下一步：画面已附在工具结果里（见上）。要改就继续 draw（同名「${name}」+ ops）。`
    );
    const text = lines.join('\n');
    // 关键：把 PNG 作为图片直接挂进工具结果，模型下一轮就真的「看见」这张画了。
    // 太大就不挂（避免把上下文顶爆），退回让模型自己 read。
    const MAX_ATTACH = 3 * 1024 * 1024;
    const meta = {
      kind: 'image',
      path: file,
      bytes: png.length,
      board: name,
      size: `${cv.w}x${cv.h}`,
      scale,
      applied,
      summary: `${name} ${cv.w}×${cv.h}${cropped ? ` · 局部 ${cropped.w}×${cropped.h}` : ''}${applied ? ` · ${applied} op` : ''}`,
    };
    if (png.length <= MAX_ATTACH) {
      meta.images = [{
        mime: 'image/png',
        base64: png.toString('base64'),
        width: shown.w * scale,
        height: shown.h * scale,
        path: file,
      }];
    } else {
      lines.push(`（图片 ${(png.length / 1048576).toFixed(1)}MB 超过内联上限，请用 read ${file} 查看）`);
      return { content: lines.join('\n'), meta: { ...meta, kind: 'draw', tooBig: true } };
    }
    return { content: text, meta };
  },
};

export default {
  name: 'draw',
  description: '像素画板：AI 通过绘图操作作画，保存 PNG 后可用 read 亲眼查看效果并迭代改进（不需要图像生成模型）',
  tools: [drawTool],
};
