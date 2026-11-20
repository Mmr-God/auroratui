// 单独渲一张风景配方，用于细看伪影
// 用法: node test/scene-one.mjs <recipe> [w] [h] [out]
import fs from 'node:fs';
import { encodePng } from '../plugins/draw/core.js';
import { drawRecipeInto } from '../plugins/draw/recipes.js';

const key = process.argv[2] || 'scene';
const W = Number(process.argv[3] || 1024);
const H = Number(process.argv[4] || 576);
const OUT = process.argv[5] || `D:/Works/JS/AIAgent/drawings/_one-${key}.png`;

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
fs.mkdirSync('D:/Works/JS/AIAgent/drawings', { recursive: true });
fs.writeFileSync(OUT, encodePng(W, H, data));
console.log(`已写出 ${OUT} (${W}x${H})`);
