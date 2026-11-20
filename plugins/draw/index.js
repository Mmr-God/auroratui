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
import zlib from 'node:zlib';

import {
  Canvas, applyOps, encodePngScaled, asciiPreview, resolveColor, shade, OP_NAMES, cropCanvas, overlayGrid,
} from './core.js';
import { drawRecipeInto, recipeKeys, SUBJECT_RECIPES } from './recipes.js';
import { drawPartInto, partKeys, findPart } from './parts.js';

// 画板存档目录：跟随 AGENT_HOME（测试 / 便携安装），否则 ~/.agent/draw
const AGENT_HOME = process.env.AGENT_HOME ? path.resolve(process.env.AGENT_HOME) : path.join(os.homedir(), '.agent');
const ROOT = path.join(AGENT_HOME, 'draw');
// 画布上限：1024×1024。像素画本身的“好看”区间是 32~256，但 AI 要画风景/插画
// 就必须上一千像素级（山脊、云、雾、纹理层都要足够分辨率才不像色块）。
const MAX = 1024;
const MIN = 8;
const HISTORY = 6;

const safeName = (n) => String(n || 'board').trim().replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 60) || 'board';
const boardFile = (name) => path.join(ROOT, `${safeName(name)}.json`);

function loadBoard(name) {
  try {
    const j = JSON.parse(fs.readFileSync(boardFile(name), 'utf8'));
    const cv = new Canvas(j.w, j.h);
    // z = deflate 后的像素，data = 旧格式的裸 base64（兼容以前存的画板）
    const buf = j.z ? zlib.inflateSync(Buffer.from(j.z, 'base64')) : Buffer.from(j.data || '', 'base64');
    if (buf.length === cv.data.length) cv.data.set(buf);
    if (j.pen) cv.pen = { x: Number(j.pen.x) || 0, y: Number(j.pen.y) || 0 };
    return { cv, history: Array.isArray(j.history) ? j.history : [] };
  } catch {
    return null;
  }
}

/**
 * 存画板。大画布用 deflate 压缩后的 base64（z 字段）：
 * 1024² 裸 RGBA 是 4MB，base64 后 5.6MB —— 每存一次都这么干，磁盘和 IO 都受不了。
 * 风景图大片同色/渐变，deflate 通常能压到十分之一。
 */
function saveBoard(name, cv, history) {
  fs.mkdirSync(ROOT, { recursive: true });
  const packed = zlib.deflateSync(Buffer.from(cv.data), { level: 6 });
  fs.writeFileSync(
    boardFile(name),
    JSON.stringify({
      w: cv.w,
      h: cv.h,
      z: packed.toString('base64'),
      pen: cv.pen,
      history,
      savedAt: new Date().toISOString(),
    })
  );
}

const snapshot = (cv) => ({
  w: cv.w,
  h: cv.h,
  z: zlib.deflateSync(Buffer.from(cv.data), { level: 6 }).toString('base64'),
  pen: { ...cv.pen },
});
function restoreBoard(snap) {
  const cv = new Canvas(snap.w, snap.h);
  const buf = snap.z ? zlib.inflateSync(Buffer.from(snap.z, 'base64')) : Buffer.from(snap.data || '', 'base64');
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

  // 大画布（≥320）= 风景/插画模式。很多精灵图指标在这个尺度上会全部误报：
  //  “孤立像素”在风景里是星星/鸟/纹理，“轮廓毛刺”是树叶边缘，量化就毁了渐变。
  // 所以大画布只保留真正有用的那几条。
  const scene = cv.w * cv.h >= 320 * 240;

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
  } else if (!scene) {
    if (subjectPixels / total < 0.02) tips.push(`主体太小：只占 ${(subjectPixels / total * 100).toFixed(1)}% 画布，试试放大或跑一次 margin`);
    if (opaque / total > 0.92) tips.push('几乎糊满整张画布，没有留白，加一点 erase 留出呼吸空间');
    if (subject.minX <= 0 || subject.minY <= 0 || subject.maxX >= cv.w - 1 || subject.maxY >= cv.h - 1) {
      tips.push('主体贴到画布边缘了：用 {"op":"shift","dx":..,"dy":..} 或 {"op":"margin"} 拉回来');
    }
    if (subject.w < cv.w * 0.25 || subject.h < cv.h * 0.25) tips.push('主体偏小，可 shift + 放大重画，或换更大的 size 重来');
  }

  if (!scene) {
    const iso = cv.isolated();
    if (iso.length) tips.push(`有 ${iso.length} 个孤立像素（噪点），可能是坐标写错：${iso.slice(0, 3).map((p) => `(${p[0]},${p[1]})`).join(' ')}`);
    // 轮廓毛刺：凸/凹 1px 的小格子，多半是某格填错/漏填
    const spurs = cv.edgeSpurs(12);
    if (spurs.length) {
      const sample = spurs.slice(0, 4).map((s) => `(${s.x},${s.y})${s.type}`).join(' ');
      tips.push(`轮廓上有 ${spurs.length} 处毛刺（凸=多一格、凹=少一格）：${sample}；用 erase/pixel 修掉更干净`);
    }
  }

  // 渐变会自然产生很多中间色：有背景时放宽阈值，别催着量化。
  // 大画布风景本来就靠渐变做空气透视，强行量化到 24 色会直接毁掉远山层次。
  const maxColors = scene ? 1024 : bgm ? 64 : 16;
  if (stats.unique > maxColors) {
    tips.push(`用了 ${stats.unique} 种颜色，超过 ${maxColors} 色会显得脏：跑一次 {"op":"palette","colors":${bgm ? 24 : 16}}`);
  }
  if (scene) {
    tips.push('这是风景/插画尺度的画布（≥320×240）：靠手摆坐标铺不出山/云/雾，用 terrain/clouds/fog/water/sky/texture 这些程序化原语，或直接 stamp 风景配方打底再改');
  }
  return { box, subject, opaque, subjectPixels, total, stats, bg, tips, scene };
}

/** 一条 op 里的 stamp 需要配方库，所以放在这里而不是 core.js */
function applyStamp(cv, op) {
  const key = op.recipe || op.stamp || op.subject || op.key;
  const ov = {};
  // color 是 main 的别名（模型写 color 最自然，以前只认 main，于是「染色」被静默忽略）
  const alias = { color: 'main', c: 'main', main: 'main', accent: 'accent', white: 'white', dark: 'dark' };
  for (const k of ['color', 'c', 'main', 'accent', 'white', 'dark']) {
    if (op[k]) ov[alias[k]] = resolveColor(op[k]);
  }
  const ok = drawRecipeInto(cv, key, ov, {
    x: op.x == null ? undefined : Number(op.x),
    y: op.y == null ? undefined : Number(op.y),
    size: op.size == null ? undefined : Number(op.size),
    origin: op.origin || op.anchorMode,
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
    origin: op.origin || op.anchorMode,
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
    'gradient/gradient_radial/dither/mirror_x/mirror_y/symmetrize/hue_rotate/shift/erase/clear/margin/palette/noise\n' +
    '- 体积感：auto_shade 支持 dir（top 默认 / bottom 背光 / left / right / top-left；bevel 是斜光），' +
    '斜角方向已归一化；gradient_radial 画球体/光晕/宝石比竖向渐变自然；dither 用两色格子做无半透明过渡\n' +
    '- 配色变体：hue_rotate {deg:120} 整体换色（灰白/描边不动），同一条主体直接出蓝/红版本\n' +
    '- 画歪了：symmetrize 把左半边镜像到右边，一步抹平左右不均\n' +
    '- 相对坐标：op 里给 "anchor":[x,y]，则 x/y/cx/cy/pts 都按相对锚点的偏移算\n' +
    '- 高光用 blend:"lighten"（按底色提亮，不会盖掉 auto_shade 的渐变），阴影用 blend:"darken"'
      + '（按底色压暗：紫色主体的阴影仍是紫色，比叠半透明黑干净）；'
      + '不传则自动选（彩色半透明走 hue，灰阶阴影走普通叠色）\n' +
    '- 颜色：#rrggbb/#rgb/#rrggbbaa（8 位带透明度，如 #00000055 半透明阴影）或速记名 black/white/red/green/blue/yellow/orange/purple/pink/brown/gray/gold/navy/sand/skin/sky/grass/wood/steel\n' +
    '- 每轮建议 5~15 条 op，先用大色块定形，看图后再加细节\n' +
    '- 顺序很重要：主体 → auto_shade → auto_outline → 高光/五官(part)。描边必须在五官之前，'
      + '否则眼睛/嘴巴会被描成黑块；part 的 eyes 自带一双（不要再贴两次，会变四只）\n' +
    '- 改局部用 erase + color（用该颜色盖掉）；只给 erase 不给 color 是挖成透明，会在轮廓上留缺口\n' +
    '- 细节看不清：scale:4~8 放大导出（像素画放大不糊），或 crop:{x,y,w,h} 只看局部（配 scale:12 看 1~2px 的眼睛）\n' +
    '\n【大画布 / 风景（1024 级）】不要手摆山和云的坐标，那样铺不出景深：\n' +
    '- 风景一律拿 w:1024,h:576（或 1024×1024）开画，配 stamp 风景配方打底：' +
    '{"op":"stamp","recipe":"scene"} / seascape / snowpeak / forest / night\n' +
    '- 要「自己构图」而不是套现成图：用 {"op":"paint","layer":"terrain",...} 这类程序化图层一层层叠，' +
    '必须按纵深顺序：sky → sun → clouds → terrain(远) → fog → terrain(中) → ground → foliage → foreground\n' +
    '- 风景的四个“看着假”通病（都能用 op 修）：①整片平涂→加 texture；②边界是直线→用噪声起伏的 layer；' +
    '③远近同色→fog 做空气透视（越远越淡越蓝）；④全是中景没有前景→底部压一层暗剪影做前景\n' +
    '- 大画布改错了能回：undo:1 回退一步（大画布保留 3 步快照）；要改参数从某层重画就用 fresh:true 整张重来\n' +
    '- 大画布看全图用 view:true（默认就是原尺寸）；要看细节必须 crop 局部 + scale，1024 全图缩在对话里看不清 1~3px 的东西',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '画板名（如 "slime"）；同名画板会保留上次画面，便于接着改；想从空白重画就配 fresh:true 或换个名字' },
      fresh: { type: 'boolean', description: 'true = 丢掉同名画板的旧画面，从空白开始（默认 false：沿用上次画面继续改）' },
      size: { type: 'number', description: '新建时的画布边长（8~1024），默认 64。像素画用 32/64；插画/风景直接用 w/h 给宽高（如 w:1024,h:576）更合适' },
      w: { type: 'number', description: '新建时的画布宽（8~1024，省略则用 size）。风景/插画推荐 1024×576（16:9）或 1024×1024' },
      h: { type: 'number', description: '新建时的画布高（8~1024，省略则用 size）' },
      ops: { type: 'array', description: '绘图操作数组，例如 [{"op":"fill_ellipse","cx":32,"cy":34,"rx":18,"ry":16,"color":"#3b82f6"}]', items: { type: 'object' } },
      view: { type: 'boolean', description: 'true = 只看不改（返回 ASCII 预览 + 诊断 + PNG 路径）' },
      undo: { type: 'number', description: '回退 n 步（仅在传了 ops 之前生效；不传 ops 只 undo 也可）' },
      scale: { type: 'number', description: '导出 PNG 的最近邻放大倍数（1~16，默认 1；想看细节时用 4）' },
      crop: {
        type: 'object',
        description: '只看局部：{"x":..,"y":..,"w":..,"h":..}，把这一块裁出来放大成这次的图（不改画板）。画眼睛这种 1~2 像素的细节时必用',
      },
      grid: {
        type: ['number', 'boolean'],
        description: '叠加坐标网格：true=每 8px 一条线，或给数字指定间隔（如 16）。只在导出的图上有，不改画板；用来量「这东西到底在哪个坐标」',
      },
      save: { type: 'string', description: '额外另存一份 PNG 的路径（相对 cwd）' },
      stats: { type: 'boolean', description: 'true 时附上完整配色统计（默认只给摘要）' },
      ascii: { type: 'boolean', description: 'true 时额外返回 48 行 ASCII 索引预览（默认不给：图已经附在结果里，这堆字符只占位置）' },
    },
    required: ['name'],
  },
  async execute(input, ctx = {}) {
    const name = safeName(input?.name || 'board');
    // 同名画板会沿用上次画面（改细节很方便），但也容易「以为在画新东西，其实叠在
    // 旧图上」—— 脏底就是这么来的。所以给一个 fresh:true 强制从空白开始。
    const prev = loadBoard(name);
    const wantFresh = input?.fresh === true || input?.fresh === 'true';
    const loaded = wantFresh ? null : prev;
    const created = !prev || wantFresh;
    let cv;
    let history;
    if (loaded) {
      cv = loaded.cv;
      history = loaded.history;
    } else {
      // fresh 且没指定尺寸时沿用旧画板的宽高（换一张图但保持同样的规格）
      const base = wantFresh && prev ? prev.cv : null;
      const s = Math.max(MIN, Math.min(MAX, Math.round(Number(input?.size ?? (base ? base.w : 64)) || 64)));
      const w = Math.max(MIN, Math.min(MAX, Math.round(Number(input?.w ?? s) || s)));
      const h = Math.max(MIN, Math.min(MAX, Math.round(Number(input?.h ?? s) || s)));
      cv = new Canvas(w, h);
      history = [];
    }

    const notes = [];
    if (wantFresh && prev) notes.push(`已丢弃画板「${name}」的旧画面（fresh:true），从空白开始`);
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
    if (ops.length && loaded) {
      // 沿用旧画面 + 又有新 ops：提醒一句，避免「新图叠在旧图上」变成脏底
      let dirty = 0;
      for (let i = 3; i < cv.data.length; i += 4) if (cv.data[i] > 8) dirty++;
      if (dirty) {
        notes.push(
          `这里是在画板「${name}」已有画面（${dirty} 个不透明像素）上继续画的；` +
            `要从空白重新画，下次传 fresh:true（或换个新的 name）`
        );
      }
    }
    if (ops.length) {
      // 大画布不做逐步快照：1024² 一份快照 deflate 后仍有几百 KB，6 份快照
      // 叠起来比画板本体还大，而且每个 op 批次都要压一次 = 明显的卡顿。
      // 风景画的「改错」靠 fresh:true 重画 + 改参数，不靠 undo 链。
      const small = cv.w * cv.h <= 320 * 320;
      // 【大画布也要能 undo】以前凭「1024² 快照很大」直接清空大画布的 undo 链。
      // 实测风景图快照 deflate 后只有 5~20KB（大片同色/渐变很好压），
      // 单次 50~90ms，完全付得起。不能 undo 的代价更大：改错一步就得
      // fresh 重画整张，AI 于是倾向「每轮从头画」，越改越浪费。
      // 大画布留 3 步（够回退一次手误），小画布保持 6 步。
      const keep = small ? HISTORY : 3;
      history.push(snapshot(cv));
      while (history.length > keep) history.shift();
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
    // grid：叠加坐标网格（只在导出图上画，不改画板），方便定位元素坐标
    let gridded = false;
    if (input?.grid) {
      const gstep = typeof input.grid === 'number' ? input.grid : 8;
      shown = overlayGrid(shown, gstep);
      gridded = true;
    }
    const png = encodePngScaled(shown.w, shown.h, shown.data, scale);
    const file = path.join(dir, `${name}${cropped ? `_crop${cropped.w}x${cropped.h}` : ''}${gridded ? '_grid' : ''}.png`);
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
