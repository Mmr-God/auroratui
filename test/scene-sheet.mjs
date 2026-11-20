// 把 5 个风景配方各渲一张，拼成一张总览图（用于一次性肉眼检查）
// 用法: node test/scene-sheet.mjs [w] [h] [out]
import fs from 'node:fs';
import { encodePng } from '../plugins/draw/core.js';
import { drawRecipeInto, recipeKeys } from '../plugins/draw/recipes.js';

const W = Number(process.argv[2] || 512);
const H = Number(process.argv[3] || 288);
const OUT = process.argv[4] || 'D:/Works/JS/AIAgent/drawings/_scene-sheet.png';

const keys = recipeKeys().filter((r) => ['scene', 'seascape', 'snowpeak', 'forest', 'night'].includes(r.key)).map((r) => r.key);

function render(key) {
  const data = new Uint8ClampedArray(W * H * 4);
  const cv = {
    w: W, h: H,
    setPx(x, y, color, a = 255) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const h = String(color).replace('#', '');
      const i = (y * W + x) * 4;
      data[i] = parseInt(h.slice(0, 2), 16);
      data[i + 1] = parseInt(h.slice(2, 4), 16);
      data[i + 2] = parseInt(h.slice(4, 6), 16);
      data[i + 3] = a;
    },
  };
  drawRecipeInto(cv, key);
  return data;
}

const cols = 2;
const rows = Math.ceil(keys.length / cols);
const pad = 6;
const SW = W * cols + pad * (cols + 1);
const SH = H * rows + pad * (rows + 1);
const sheet = new Uint8ClampedArray(SW * SH * 4);
for (let i = 0; i < SW * SH; i++) {
  sheet[i * 4] = 24; sheet[i * 4 + 1] = 26; sheet[i * 4 + 2] = 32; sheet[i * 4 + 3] = 255;
}
keys.forEach((key, n) => {
  const src = render(key);
  const ox = pad + (n % cols) * (W + pad);
  const oy = pad + Math.floor(n / cols) * (H + pad);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const di = ((oy + y) * SW + (ox + x)) * 4;
      for (let k = 0; k < 4; k++) sheet[di + k] = src[si + k];
    }
  }
});
fs.mkdirSync('D:/Works/JS/AIAgent/drawings', { recursive: true });
fs.writeFileSync(OUT, encodePng(SW, SH, sheet));
console.log(`已写出 ${OUT}  (${SW}x${SH})  顺序：${keys.join(' / ')}`);
