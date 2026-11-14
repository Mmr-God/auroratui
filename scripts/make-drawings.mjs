// 重新生成 docs/drawings/ 里的宣传图：node scripts/make-drawings.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Canvas, encodePngScaled } from '../plugins/draw/core.js';
import { SUBJECT_RECIPES, drawRecipeInto } from '../plugins/draw/recipes.js';

const OUT = path.resolve('docs/drawings');
fs.mkdirSync(OUT, { recursive: true });

const TILE = 32;          // 配方栅格尺寸
const SCALE = 8;          // 导出放大倍数（最近邻，不糊）
const keys = SUBJECT_RECIPES.map((r) => r.key);
const labels = new Map(SUBJECT_RECIPES.map((r) => [r.key, r.label]));

const single = [];
for (const key of keys) {
  const cv = new Canvas(TILE, TILE);
  drawRecipeInto(cv, key, {}, { size: TILE });
  const png = encodePngScaled(cv.w, cv.h, cv.data, SCALE);
  const file = path.join(OUT, `${key}.png`);
  fs.writeFileSync(file, png);
  single.push({ key, label: labels.get(key), file: `docs/drawings/${key}.png`, bytes: png.length });
}

// 拼一张 6 x 3 的展示墙（深色卡片底 + 间距）
const COLS = 6;
const ROWS = Math.ceil(keys.length / COLS);
const GAP = 6;
const PAD = 10;
const W = PAD * 2 + COLS * TILE + (COLS - 1) * GAP;
const H = PAD * 2 + ROWS * TILE + (ROWS - 1) * GAP;
const sheet = new Canvas(W, H);
sheet.fillRect(0, 0, W, H, '#0d1117');

keys.forEach((key, i) => {
  const tile = new Canvas(TILE, TILE);
  drawRecipeInto(tile, key, {}, { size: TILE });
  const ox = PAD + (i % COLS) * (TILE + GAP);
  const oy = PAD + Math.floor(i / COLS) * (TILE + GAP);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const a = tile.a(x, y);
      if (a < 8) continue;
      const p = tile.getPx(x, y);
      sheet.setPx(ox + x, oy + y, p.hex, a);
    }
  }
});

const sheetPng = encodePngScaled(sheet.w, sheet.h, sheet.data, 4); // 928x448 左右
fs.writeFileSync(path.join(OUT, 'wall.png'), sheetPng);

console.log(JSON.stringify({ count: single.length, wall: `${W * 4}x${H * 4}`, files: single.map((s) => s.file) }, null, 1));
