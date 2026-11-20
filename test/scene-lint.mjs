/**
 * 风景配方自动诊断（scene lint）
 *
 * 为什么需要它：画风景最容易出的是「结构性缺陷」—— 横贯全图的色带、
 * 谁都没画的透明缝、非法色导致的破图。这些缺陷在小画布上不明显，
 * 1024 宽时非常刺眼，但**不会报错**，靠肉眼逐轮排查一次要改十几轮。
 *
 * 用一个脚本把三类问题量化出来，改一次跑一次，比看图快得多。
 *
 * 用法：node test/scene-lint.mjs [配方名...] [--all]
 *   默认只检查 1024×576（该尺寸下缺陷最明显）；--all 额外跑 512/320。
 */
import { Canvas, encodePngScaled } from '../plugins/draw/core.js';
import { drawRecipeInto, recipeKeys } from '../plugins/draw/recipes.js';
import fs from 'node:fs';
import path from 'node:path';

// 默认只跑 1024（最大尺寸问题最明显）。加 --all 才跑全部尺寸。
const SIZES = process.argv.includes('--all')
  ? [[1024, 576], [512, 288], [320, 180]]
  : [[1024, 576]];
const SCENE_KEYS = ['scene', 'seascape', 'snowpeak', 'forest', 'night'];

function analyze(cv) {
  const { w: W, h: H, data } = cv;
  const issues = [];

  // --- 1) 透明像素（谁都没画）---
  const transparent = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] < 8) n++;
    if (n > 0) transparent.push({ y, n });
  }
  if (transparent.length) {
    issues.push({
      kind: 'transparent',
      msg: `${transparent.length} 行有透明像素（共 ${transparent.reduce((s, r) => s + r.n, 0)} px）`,
      detail: transparent.slice(0, 6).map((r) => `y=${r.y}:${r.n}`).join(' '),
    });
  }

  // --- 2) 非法色 / NaN（拼 hex 没钳制的典型后果）---
  // Uint8ClampedArray 会把非法值钉成 0 而 alpha 仍是 255。
  // 但「纯黑」本身也可能是合法的深色（夜景、树影、地面近端压暗），
  // 所以不能只数纯黑 —— 得看它是否**和周围断层**：真正的钳制 bug
  // 是孤立/成片地插入死黑，四周颜色正常；合法暗部是一条平滑渐变。
  let harshBlack = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 200 || data[i] + data[i + 1] + data[i + 2] > 6) continue;
      // 与上下左右比较，若邻居明显更亮 → 断层黑点
      let brighter = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = ((y + dy) * W + (x + dx)) * 4;
        if (data[j] + data[j + 1] + data[j + 2] > 60) brighter++;
      }
      if (brighter >= 3) harshBlack++;
    }
  }
  if (harshBlack > W * H * 0.002) {
    issues.push({ kind: 'illegal-color', msg: `${harshBlack} 个孤立死黑像素（四周明显更亮），疑似 hex 拼接未钳制`, detail: '' });
  }

  // --- 3) 横贯全图的色带 ---
  // 判据（2026-11 重写）：逐**像素列**比「这一行 vs 上一行」的变化，
  // 统计突变像素占整行的比例。真的色带是「几乎每一列都同时换了颜色」（比例接近 1）；
  // 有机内容（雪脊边缘、树冠、云）只在局部几十列上突变，比例很低。
  //
  // 【为什么不能再用行平均色】旧判据用「整行平均色的跳变」+「左右两端同色」，
  // 会被两类情况误导：
  //   a) 横贯全图的窄带若两端局部内容不同（比如两端有云），会被漏判；
  //   b) 反过来，行平均色的普通跳变（例如某行恰好有 70 列同时越过雪脊）
  //      会被误判成色带 —— snowpeak/seascape 上实测踩到了这个误报
  //      （突变列只有 69/1024，却报「横贯全图」）。
  // 改成「突变列占比」后两类都干净了。
  const rowAvg = [];
  for (let y = 0; y < H; y++) {
    let r = 0, g = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    rowAvg.push([r / W, g / W, b / W]);
  }
  const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const diffs = rowAvg.slice(1).map((v, i) => diff(v, rowAvg[i]));
  const med = [...diffs].sort((a, b) => a - b)[Math.floor(diffs.length / 2)] || 1;

  const bands = [];
  for (let y = 1; y < H; y++) {
    const d = diffs[y - 1];
    if (d < Math.max(6, med * 3)) continue;
    // 逐列统计突变占比
    let changed = 0;
    const picks = [];
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const j = ((y - 1) * W + x) * 4;
      const dd = Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
      if (dd > 24) {
        changed++;
        if (picks.length < 400) picks.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    const ratio = changed / W;
    if (ratio < 0.55) continue; // 不是横贯：只是一片有机内容过界
    // 并且换成的那个新颜色在全行是一致的（不是各列各变各的）
    let same = 0;
    for (const p of picks) {
      if (Math.abs(p[0] - picks[0][0]) + Math.abs(p[1] - picks[0][1]) + Math.abs(p[2] - picks[0][2]) < 30) same++;
    }
    if (picks.length === 0 || same / picks.length < 0.7) continue;
    bands.push({ y, jump: d.toFixed(0), ratio: ratio.toFixed(2) });
  }
  // 连续行合并成一条带
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y - last.y1 <= 2) last.y1 = b.y;
    else merged.push({ y0: b.y, y1: b.y });
  }
  for (const m of merged) {
    const hgt = m.y1 - m.y0 + 1;
    if (hgt >= 2) {
      issues.push({
        kind: 'band',
        msg: `y=${m.y0}~${m.y1}（${hgt}px）横贯全图的色带`,
        detail: `占画面高度 ${(hgt / H * 100).toFixed(1)}%`,
      });
    }
  }

  // --- 4) 底部/顶部未覆盖 ---
  const lastRowOpaque = [...Array(W)].every((_, x) => data[((H - 1) * W + x) * 4 + 3] > 200);
  if (!lastRowOpaque) issues.push({ kind: 'coverage', msg: '最后一行没有完全覆盖', detail: '' });

  return issues;
}

const keys = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!keys.length) keys.push(...SCENE_KEYS);
let total = 0;
const OUT = 'D:/Works/JS/AIAgent/.tmp/lint';
fs.mkdirSync(OUT, { recursive: true });

for (const key of keys) {
  for (const [W, H] of SIZES) {
    const cv = new Canvas(W, H);
    const ok = drawRecipeInto(cv, key, {}, {});
    if (!ok) { console.log(`✗ ${key} 配方不存在`); continue; }
    const issues = analyze(cv);
    total += issues.length;
    const tag = `${key} ${W}x${H}`;
    if (!issues.length) {
      console.log(`✓ ${tag}`);
    } else {
      console.log(`✗ ${tag}`);
      for (const i of issues) console.log(`    [${i.kind}] ${i.msg}${i.detail ? '  ' + i.detail : ''}`);
    }
    // 只在最大尺寸存图，方便人眼复核
    if (W === 1024) {
      fs.writeFileSync(path.join(OUT, `${key}.png`), encodePngScaled(W, H, cv.data, 1));
    }
  }
}

console.log(total ? `\n共 ${total} 个问题` : '\n全部通过');
process.exit(total ? 1 : 0);
