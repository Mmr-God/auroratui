// 主体配方库（移植自 pixel-forge / server/src/tools/subject-recipes.js）
// 坐标系：归一化 0..1（左上为原点），栅格化到方块画布后再贴到目标画板中央。
// 用途：给 AI 一个「起点」——先 stamp 一个配方，再用 op 慢慢改成自己想要的样子。
// 对外只导出：SUBJECT_RECIPES / detectSubject / recipeKeys / drawRecipeInto / paletteFor

const DARK = "#1b2029";
const WHITE = "#f7f8fa";

function hexToRgb(hex) {
  const h = String(hex || "#3b82f6").replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function shade([r, g, b], k) {
  return rgbStr([r * k, g * k, b * k]);
}
function mix(hex, other, t) {
  const a = hexToRgb(hex), b = hexToRgb(other);
  return rgbStr(a.map((v, i) => v + (b[i] - v) * t));
}
/**
 * [r,g,b] → '#rrggbb'，必须钳制到 0~255。
 * 这不是防御性编程，是修一个真实出现过的严重 bug：
 * 手写 `v.toString(16)` 拼 hex 时，噪声采下来 r 稍有负数（或者 >255），
 * 得到的就是 "#-4a…”这种非法颜色，hexToRgb 解析成 NaN，setPx 写进
 * Uint8ClampedArray 时被当成 0 而 alpha 照样 255 —— 像素变成黑色；
 * 更坑的是它不会报错，只会让整片地面出现一条条难以归因的黑/白横线。
 */
function rgbStr(arr) {
  return `#${arr.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

// ---------- 栅格原语 ----------
// 画布改成 w×h（以前固定方形的 s）：风景配方天生是宽幅，强行在方形上栅格化
// 再居中贴，16:9 画板上会被裁成方块。归一化坐标照旧 0..1，
// 横向乘 (w-1)、纵向乘 (h-1)；c.s 保留为短边，旧配方代码不受影响。
function makeCanvas(w, h) {
  if (h == null) h = w;
  return { w, h, s: Math.min(w, h), data: new Uint8ClampedArray(w * h * 4) };
}
function setPx(c, x, y, hex, alpha = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const [r, g, b] = hexToRgb(hex);
  const i = (y * c.w + x) * 4;
  c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = alpha;
}
/** 带 alpha 混合的写点（风景配方叠雾/光用） */
function blendPx(c, x, y, hex, alpha = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  if (a <= 0) return;
  const [r, g, b] = hexToRgb(hex);
  const i = (y * c.w + x) * 4;
  if (a >= 255) {
    c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = 255;
    return;
  }
  const t = a / 255;
  const da = c.data[i + 3] / 255;
  const oa = t + da * (1 - t);
  if (oa <= 0) return;
  const k = t / oa;
  c.data[i] = c.data[i] + (r - c.data[i]) * k;
  c.data[i + 1] = c.data[i + 1] + (g - c.data[i + 1]) * k;
  c.data[i + 2] = c.data[i + 2] + (b - c.data[i + 2]) * k;
  c.data[i + 3] = Math.round(oa * 255);
}
function fillEllipse(c, ncx, ncy, nrx, nry, hex) {
  const W = c.w - 1, H = c.h - 1;
  const cx = ncx * W, cy = ncy * H;
  const rx = Math.max(0.6, nrx * W), ry = Math.max(0.6, nry * H);
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.0) setPx(c, x, y, hex);
    }
  }
}
function fillRect(c, nx, ny, nw, nh, hex) {
  const W = c.w - 1, H = c.h - 1;
  const x0 = Math.round(nx * W), y0 = Math.round(ny * H);
  const x1 = Math.round((nx + nw) * W), y1 = Math.round((ny + nh) * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPx(c, x, y, hex);
}
/** 多边形扫描线填充(偶奇规则),pts 为归一化点 */
function fillPoly(c, pts, hex) {
  const W = c.w - 1, H = c.h - 1;
  const P = pts.map(([x, y]) => [x * W, y * H]);
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of P) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < P.length; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
        xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.floor(xs[k]); x <= Math.ceil(xs[k + 1]); x++) {
        if (x >= xs[k] - 0.5 && x <= xs[k + 1] + 0.5) setPx(c, x, y, hex);
      }
    }
  }
}
/** 带三档纵向明暗的椭圆主体(上亮下暗,像素风常用) */
function fillEllipseShaded(c, ncx, ncy, nrx, nry, base, lightK = 1.22, darkK = 0.72) {
  const W = c.w - 1, H = c.h - 1;
  const cx = ncx * W, cy = ncy * H;
  const rx = Math.max(0.7, nrx * W), ry = Math.max(0.7, nry * H);
  const top = shade(hexToRgb(base), lightK), mid = base, bot = shade(hexToRgb(base), darkK);
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1.0) continue;
      const ty = (y - (cy - ry)) / (2 * ry); // 0=顶 1=底
      setPx(c, x, y, ty < 0.42 ? top : ty > 0.72 ? bot : mid);
    }
  }
}
/** 画 1px 深色描边(向内收缩,不改变外轮廓尺寸) */
function outlineIn(c, hex) {
  const { w, h } = c;
  const src = new Uint8ClampedArray(c.data);
  const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 8;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      if (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1)) {
        setPx(c, x, y, hex);
      }
    }
  }
}
/** 完全对称化(按左半镜像到右半),保证 enforcement 必过 */
function mirrorX(c) {
  const { w, h } = c;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < Math.floor(w / 2); x++) {
      const si = (y * w + x) * 4, di = (y * w + (w - 1 - x)) * 4;
      const a = c.data[si + 3];
      if (a > 8) {
        c.data[di] = c.data[si]; c.data[di + 1] = c.data[si + 1];
        c.data[di + 2] = c.data[si + 2]; c.data[di + 3] = a;
      } else if (c.data[di + 3] > 8) {
        // 右侧有而左侧无:把右侧复制到左侧,保证镜像完整
        c.data[si] = c.data[di]; c.data[si + 1] = c.data[di + 1];
        c.data[si + 2] = c.data[di + 2]; c.data[si + 3] = c.data[di + 3];
      }
    }
  }
}

// ---------- 主体配方 ----------
// 每个配方:(c, pal) => void ; pal = { main, accent, white, dark, s }

function drawPenguin(c, pal) {
  const { main, accent, white, dark } = pal;
  const darkK = shade(hexToRgb("#1f2430"), 1);
  const bodyCol = "#242b3a";
  // 脚(先画,位于身体后)
  fillEllipse(c, 0.38, 0.93, 0.10, 0.045, accent);
  fillEllipse(c, 0.62, 0.93, 0.10, 0.045, accent);
  // 翅膀
  fillEllipse(c, 0.17, 0.60, 0.075, 0.17, shade(hexToRgb(bodyCol), 0.85));
  fillEllipse(c, 0.83, 0.60, 0.075, 0.17, shade(hexToRgb(bodyCol), 0.85));
  // 身体(蛋形)
  fillEllipseShaded(c, 0.5, 0.55, 0.335, 0.40, bodyCol, 1.30, 0.80);
  // 白肚皮
  fillEllipse(c, 0.5, 0.60, 0.215, 0.285, white);
  // 白色脸颊
  fillEllipse(c, 0.395, 0.33, 0.095, 0.105, white);
  fillEllipse(c, 0.605, 0.33, 0.095, 0.105, white);
  // 眼睛
  fillEllipse(c, 0.415, 0.335, 0.033, 0.040, "#141821");
  fillEllipse(c, 0.585, 0.335, 0.033, 0.040, "#141821");
  // 喙(橙色三角)
  fillPoly(c, [[0.435, 0.405], [0.565, 0.405], [0.5, 0.485]], accent);
  // 描边
  outlineIn(c, darkK);
}

function drawSlime(c, pal) {
  const { main, white, dark } = pal;
  // 圆顶 + 平底
  fillEllipseShaded(c, 0.5, 0.62, 0.345, 0.30, main, 1.26, 0.74);
  fillRect(c, 0.155, 0.62, 0.69, 0.30, shade(hexToRgb(main), 0.74));
  fillEllipseShaded(c, 0.5, 0.78, 0.345, 0.155, shade(hexToRgb(main), 0.92), 1.0, 0.72);
  // 高光
  fillEllipse(c, 0.345, 0.44, 0.075, 0.055, mix(main, "#ffffff", 0.62));
  // 眼睛 + 嘴
  fillEllipse(c, 0.40, 0.60, 0.045, 0.060, "#141821");
  fillEllipse(c, 0.60, 0.60, 0.045, 0.060, "#141821");
  fillEllipse(c, 0.44, 0.455, 0.018, 0.022, mix(main, "#ffffff", 0.9));
  fillEllipse(c, 0.56, 0.455, 0.018, 0.022, mix(main, "#ffffff", 0.9));
  fillRect(c, 0.465, 0.72, 0.07, 0.028, "#141821");
  outlineIn(c, shade(hexToRgb(main), 0.52));
}

function drawCat(c, pal) {
  const { main, white } = pal;
  // 尾巴
  fillEllipse(c, 0.855, 0.70, 0.05, 0.15, shade(hexToRgb(main), 0.85));
  // 身体
  fillEllipseShaded(c, 0.5, 0.685, 0.265, 0.225, main, 1.2, 0.80);
  // 头
  fillEllipseShaded(c, 0.5, 0.405, 0.27, 0.24, main, 1.24, 0.82);
  // 耳朵:画在头之后,保证尖角可见
  fillPoly(c, [[0.27, 0.30], [0.30, 0.075], [0.455, 0.235]], main);
  fillPoly(c, [[0.73, 0.30], [0.70, 0.075], [0.545, 0.235]], main);
  fillPoly(c, [[0.30, 0.275], [0.325, 0.135], [0.42, 0.245]], mix(main, "#ffb4c8", 0.5));
  fillPoly(c, [[0.70, 0.275], [0.675, 0.135], [0.58, 0.245]], mix(main, "#ffb4c8", 0.5));
  // 眼睛 + 高光
  fillEllipse(c, 0.395, 0.405, 0.045, 0.055, "#141821");
  fillEllipse(c, 0.605, 0.405, 0.045, 0.055, "#141821");
  fillEllipse(c, 0.385, 0.390, 0.016, 0.018, "#ffffff");
  fillEllipse(c, 0.595, 0.390, 0.016, 0.018, "#ffffff");
  // 鼻子
  fillPoly(c, [[0.468, 0.478], [0.532, 0.478], [0.5, 0.518]], "#e97a95");
  // 胡须(移到脸下缘以下,避免横穿脸)
  const wk = mix(main, "#ffffff", 0.8);
  fillRect(c, 0.125, 0.545, 0.155, 0.014, wk);
  fillRect(c, 0.135, 0.585, 0.145, 0.014, wk);
  fillRect(c, 0.72, 0.545, 0.155, 0.014, wk);
  fillRect(c, 0.72, 0.585, 0.145, 0.014, wk);
  outlineIn(c, shade(hexToRgb(main), 0.55));
}

function drawBird(c, pal) {
  const { main, accent } = pal;
  fillEllipseShaded(c, 0.48, 0.58, 0.29, 0.28, main, 1.25, 0.76);
  fillEllipse(c, 0.55, 0.40, 0.185, 0.175, mix(main, "#ffffff", 0.12));
  // 翅膀
  fillEllipse(c, 0.31, 0.60, 0.10, 0.165, shade(hexToRgb(main), 0.8));
  // 喙
  fillPoly(c, [[0.70, 0.40], [0.875, 0.455], [0.70, 0.505]], accent);
  // 眼
  fillEllipse(c, 0.625, 0.375, 0.036, 0.042, "#141821");
  // 尾
  fillPoly(c, [[0.20, 0.62], [0.055, 0.72], [0.19, 0.78]], shade(hexToRgb(main), 0.8));
  outlineIn(c, shade(hexToRgb(main), 0.55));
}

function drawSword(c, pal) {
  const { main, accent, white } = pal;
  const blade = mix("#d9e2ec", main, 0.25);
  // 剑柄
  fillRect(c, 0.465, 0.755, 0.07, 0.155, "#6b4423");
  fillEllipse(c, 0.5, 0.925, 0.055, 0.045, accent);
  // 护手
  fillRect(c, 0.285, 0.705, 0.43, 0.052, accent);
  fillEllipse(c, 0.285, 0.731, 0.035, 0.026, shade(hexToRgb(accent), 0.85));
  fillEllipse(c, 0.715, 0.731, 0.035, 0.026, shade(hexToRgb(accent), 0.85));
  // 剑身
  fillRect(c, 0.445, 0.16, 0.11, 0.55, blade);
  fillPoly(c, [[0.445, 0.16], [0.555, 0.16], [0.5, 0.045]], blade);
  // 中线高光
  fillRect(c, 0.492, 0.09, 0.016, 0.60, mix("#ffffff", blade, 0.35));
  outlineIn(c, "#20262f");
}

function drawShield(c, pal) {
  const { main, accent, white } = pal;
  fillPoly(c, [
    [0.5, 0.075], [0.855, 0.205], [0.80, 0.575], [0.5, 0.925], [0.20, 0.575], [0.145, 0.205],
  ], main);
  fillPoly(c, [
    [0.5, 0.145], [0.795, 0.255], [0.745, 0.555], [0.5, 0.845], [0.255, 0.555], [0.205, 0.255],
  ], shade(hexToRgb(main), 1.18));
  // 十字徽记
  fillRect(c, 0.465, 0.22, 0.07, 0.46, accent);
  fillRect(c, 0.29, 0.375, 0.42, 0.07, accent);
  outlineIn(c, shade(hexToRgb(main), 0.5));
}

function drawPotion(c, pal) {
  const { main, accent } = pal;
  // 瓶塞
  fillRect(c, 0.435, 0.075, 0.13, 0.075, "#8a5a2b");
  // 瓶颈
  fillRect(c, 0.455, 0.145, 0.09, 0.145, mix("#d6e4f0", main, 0.15));
  // 瓶身
  fillEllipseShaded(c, 0.5, 0.635, 0.275, 0.275, mix("#d6e4f0", main, 0.15), 1.15, 0.85);
  // 液体
  fillEllipse(c, 0.5, 0.70, 0.225, 0.195, main);
  fillEllipse(c, 0.5, 0.755, 0.215, 0.135, shade(hexToRgb(main), 0.82));
  // 气泡 + 高光
  fillEllipse(c, 0.43, 0.65, 0.030, 0.030, mix(main, "#ffffff", 0.6));
  fillEllipse(c, 0.575, 0.715, 0.022, 0.022, mix(main, "#ffffff", 0.45));
  fillEllipse(c, 0.375, 0.535, 0.045, 0.055, mix("#ffffff", main, 0.15));
  outlineIn(c, shade(hexToRgb(main), 0.45));
}

function drawGem(c, pal) {
  const { main } = pal;
  fillPoly(c, [[0.5, 0.055], [0.895, 0.365], [0.5, 0.945], [0.105, 0.365]], main);
  fillPoly(c, [[0.5, 0.055], [0.895, 0.365], [0.5, 0.365]], mix(main, "#ffffff", 0.42));
  fillPoly(c, [[0.105, 0.365], [0.5, 0.365], [0.5, 0.945]], shade(hexToRgb(main), 0.74));
  fillPoly(c, [[0.5, 0.055], [0.5, 0.365], [0.105, 0.365]], mix(main, "#ffffff", 0.22));
  // 刻面高光
  fillEllipse(c, 0.405, 0.225, 0.038, 0.058, mix("#ffffff", main, 0.1));
  outlineIn(c, shade(hexToRgb(main), 0.45));
}

function drawChest(c, pal) {
  const { main, accent } = pal;
  const wood = "#8b5a2b";
  // 箱体
  fillRect(c, 0.155, 0.45, 0.69, 0.44, wood);
  // 箱盖(半圆)
  fillEllipse(c, 0.5, 0.45, 0.345, 0.19, shade(hexToRgb(wood), 1.15));
  fillRect(c, 0.155, 0.44, 0.69, 0.03, shade(hexToRgb(wood), 0.7));
  // 金属包边
  fillRect(c, 0.235, 0.28, 0.055, 0.61, accent);
  fillRect(c, 0.71, 0.28, 0.055, 0.61, accent);
  fillRect(c, 0.155, 0.60, 0.69, 0.045, accent);
  // 锁
  fillRect(c, 0.455, 0.545, 0.09, 0.10, mix(accent, "#ffffff", 0.3));
  outlineIn(c, "#4a3018");
}

function drawTree(c, pal) {
  const { main } = pal;
  const trunk = "#6b4423";
  fillRect(c, 0.455, 0.62, 0.09, 0.32, trunk);
  fillRect(c, 0.375, 0.885, 0.25, 0.055, shade(hexToRgb(trunk), 0.8));
  const leaf = main;
  fillEllipseShaded(c, 0.5, 0.40, 0.34, 0.30, leaf, 1.2, 0.74);
  fillEllipseShaded(c, 0.325, 0.505, 0.20, 0.16, shade(hexToRgb(leaf), 0.88), 1.1, 0.78);
  fillEllipseShaded(c, 0.675, 0.505, 0.20, 0.16, shade(hexToRgb(leaf), 0.88), 1.1, 0.78);
  outlineIn(c, shade(hexToRgb(leaf), 0.48));
}

function drawMushroom(c, pal) {
  const { main } = pal;
  const stem = "#f0e2cd";
  // 菌柄(先画,位于菌盖之下)
  fillRect(c, 0.415, 0.505, 0.17, 0.40, stem);
  fillRect(c, 0.395, 0.83, 0.21, 0.075, shade(hexToRgb(stem), 0.88));
  fillRect(c, 0.415, 0.545, 0.045, 0.35, shade(hexToRgb(stem), 0.9));
  // 菌盖(半圆,覆盖菌柄顶部)
  fillPoly(c, [[0.155, 0.545], [0.175, 0.415], [0.265, 0.285], [0.385, 0.195], [0.5, 0.165], [0.615, 0.195], [0.735, 0.285], [0.825, 0.415], [0.845, 0.545]], main);
  fillEllipseShaded(c, 0.5, 0.545, 0.345, 0.20, main, 1.18, 0.86);
  // 菌盖下沿阴影
  fillRect(c, 0.155, 0.525, 0.69, 0.035, shade(hexToRgb(main), 0.72));
  // 斑点
  fillEllipse(c, 0.345, 0.395, 0.062, 0.052, "#fdf6ec");
  fillEllipse(c, 0.655, 0.375, 0.052, 0.044, "#fdf6ec");
  fillEllipse(c, 0.5, 0.265, 0.045, 0.038, "#fdf6ec");
  outlineIn(c, shade(hexToRgb(main), 0.48));
}

function drawStar(c, pal) {
  const { main } = pal;
  const pts = [];
  const spikes = 5, cx = 0.5, cy = 0.5, R = 0.435, r = 0.19;
  for (let i = 0; i < spikes * 2; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / spikes;
    const rad = i % 2 === 0 ? R : r;
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
  }
  fillPoly(c, pts, main);
  fillPoly(c, [[cx, cy - 0.20], [cx + 0.12, cy], [cx, cy + 0.13], [cx - 0.12, cy]], mix(main, "#ffffff", 0.5));
  outlineIn(c, shade(hexToRgb(main), 0.5));
}

function drawHeart(c, pal) {
  const { main } = pal;
  fillEllipse(c, 0.335, 0.365, 0.185, 0.185, main);
  fillEllipse(c, 0.665, 0.365, 0.185, 0.185, main);
  fillPoly(c, [[0.155, 0.435], [0.845, 0.435], [0.5, 0.905]], main);
  fillEllipse(c, 0.325, 0.325, 0.070, 0.055, mix(main, "#ffffff", 0.62));
  outlineIn(c, shade(hexToRgb(main), 0.5));
}

function drawCoin(c, pal) {
  const { main } = pal;
  fillEllipseShaded(c, 0.5, 0.5, 0.415, 0.415, main, 1.28, 0.74);
  fillEllipse(c, 0.5, 0.5, 0.315, 0.315, shade(hexToRgb(main), 1.12));
  // 币面符号
  fillRect(c, 0.472, 0.265, 0.056, 0.47, shade(hexToRgb(main), 0.66));
  fillRect(c, 0.335, 0.415, 0.33, 0.052, shade(hexToRgb(main), 0.66));
  fillEllipse(c, 0.335, 0.245, 0.055, 0.040, mix(main, "#ffffff", 0.8));
  outlineIn(c, shade(hexToRgb(main), 0.5));
}

function drawGhost(c, pal) {
  const { main, white, dark } = pal;
  fillEllipseShaded(c, 0.5, 0.44, 0.285, 0.315, main, 1.2, 0.86);
  // 下摆波浪
  fillRect(c, 0.215, 0.44, 0.57, 0.32, shade(hexToRgb(main), 0.88));
  for (let i = 0; i < 4; i++) {
    const x = 0.215 + i * 0.1425;
    fillEllipse(c, x + 0.071, 0.775, 0.075, 0.055, shade(hexToRgb(main), 0.88));
  }
  fillRect(c, 0.215, 0.735, 0.57, 0.045, "#00000000");
  // 眼睛 + 嘴
  fillEllipse(c, 0.405, 0.40, 0.055, 0.075, "#141821");
  fillEllipse(c, 0.595, 0.40, 0.055, 0.075, "#141821");
  fillEllipse(c, 0.5, 0.575, 0.048, 0.048, "#141821");
  outlineIn(c, shade(hexToRgb(main), 0.6));
}

function drawHumanoid(c, pal) {
  const { main, accent } = pal;
  const skin = "#f0c9a4";
  // 腿
  fillRect(c, 0.425, 0.695, 0.065, 0.185, "#2f3f5c");
  fillRect(c, 0.51, 0.695, 0.065, 0.185, "#2f3f5c");
  fillRect(c, 0.405, 0.865, 0.095, 0.05, "#221a14");
  fillRect(c, 0.50, 0.865, 0.095, 0.05, "#221a14");
  // 躯干(梯形衣袍)
  fillPoly(c, [[0.375, 0.335], [0.625, 0.335], [0.665, 0.735], [0.335, 0.735]], main);
  // 腰带
  fillRect(c, 0.345, 0.615, 0.31, 0.045, accent);
  // 手臂
  fillEllipse(c, 0.318, 0.475, 0.048, 0.125, shade(hexToRgb(main), 0.88));
  fillEllipse(c, 0.682, 0.475, 0.048, 0.125, shade(hexToRgb(main), 0.88));
  // 手
  fillEllipse(c, 0.318, 0.585, 0.038, 0.040, skin);
  fillEllipse(c, 0.682, 0.585, 0.038, 0.040, skin);
  // 脖子
  fillRect(c, 0.468, 0.295, 0.064, 0.055, shade(hexToRgb(skin), 0.88));
  // 头
  fillEllipseShaded(c, 0.5, 0.235, 0.155, 0.165, skin, 1.1, 0.92);
  // 头发(只盖头顶,不遮脸)
  fillPoly(c, [[0.34, 0.235], [0.36, 0.10], [0.5, 0.065], [0.64, 0.10], [0.66, 0.235], [0.60, 0.175], [0.5, 0.155], [0.40, 0.175]], "#4a3728");
  // 眼睛
  fillEllipse(c, 0.443, 0.250, 0.024, 0.030, "#141821");
  fillEllipse(c, 0.557, 0.250, 0.024, 0.030, "#141821");
  // 嘴
  fillRect(c, 0.474, 0.315, 0.052, 0.018, "#b06a5e");
  outlineIn(c, "#20262f");
}

function drawSpark(c, pal) {
  const { main, accent, white } = pal;
  const cy = 0.5;
  fillPoly(c, [[0.5, 0.06], [0.585, 0.40], [0.5, 0.5], [0.415, 0.40]], mix(main, "#ffffff", 0.55));
  fillPoly(c, [[0.5, 0.94], [0.585, 0.60], [0.5, 0.5], [0.415, 0.60]], main);
  fillPoly(c, [[0.06, 0.5], [0.40, 0.415], [0.5, 0.5], [0.40, 0.585]], mix(main, "#ffffff", 0.35));
  fillPoly(c, [[0.94, 0.5], [0.60, 0.415], [0.5, 0.5], [0.60, 0.585]], accent);
  fillEllipse(c, 0.5, cy, 0.075, 0.075, "#ffffff");
}

// ---------- 风景配方 ----------
// 风景画与精灵图的画法完全不同：精灵图是「一个主体居中、留白、描边」，
// 风景是「按纵深分层叠上去 + 空气透视（越远越淡越偏蓝）」。
// 这里的配方按这个大思路写：天空 → 远近山（三层，逐层变淡）→ 地面/水 → 雾 → 光。

// 风景专用小工具：噪声（与 core.js 同一套 hash，保证确定性）
function hash1(i, seed) {
  let n = Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function hash2(x, y, seed) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
const smoothT = (t) => t * t * (3 - 2 * t);
function noise1(x, seed) {
  const i = Math.floor(x);
  const t = smoothT(x - i);
  const a = hash1(i, seed);
  return a + (hash1(i + 1, seed) - a) * t;
}
function fbm1(x, seed, oct = 4, rough = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    sum += noise1(x * f, seed + o * 1013) * amp;
    norm += amp; amp *= rough; f *= 2;
  }
  return norm ? sum / norm : 0;
}
function noise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smoothT(x - xi), ty = smoothT(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * tx, bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}
function fbm2(x, y, seed, oct = 4, rough = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    sum += noise2(x * f, y * f, seed + o * 1013) * amp;
    norm += amp; amp *= rough; f *= 2;
  }
  return norm ? sum / norm : 0;
}
function ridged1(x, seed, oct = 4, rough = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    const n = noise1(x * f, seed + o * 1013);
    sum += (1 - Math.abs(2 * n - 1)) * amp;
    norm += amp; amp *= rough; f *= 2;
  }
  return norm ? sum / norm : 0;
}
function makeRng(seed) {
  let s = (Math.abs(Math.round(seed)) || 1) % 2147483647;
  return () => {
    s = (Math.imul(s, 48271) % 2147483647 + 2147483647) % 2147483647;
    return s / 2147483647;
  };
}

/**
 * 【分辨率自适应】把「按 512 宽画布调出来的频率」换算到当前画布。
 *
 * 为什么必须有这个：风景配方里所有 fbm1/fbm2/ridged1 的参数都是按某个宽度
 * 调出来的。直接 x * 0.0042 在今天 512 宽的画布上合适，拉成 1024 宽后同一段
 * x 变化只覆盖原来一半的噪声范围 —— 结果是「细节数量不变、每个细节被拉宽一倍」，
 * 也就是**大画布反而更糊、更像色块**。这正是「AI 画不好 1024」的根因之一。
 *
 * 用法：把画布坐标系换成「参考分辨率坐标」再去采样噪声。
 *   const RS = resScale(c);           // 1024 画布 → 2.0
 *   fbm2(x * 0.0042 * RS, ...)        // 细节密度与 512 画布一致，但更锐
 *
 * 注意：**只对噪声频率做这个换算，不对归一化坐标做**。几何位置（山脚线、
 * 地平线）本来就该按比例缩放，换错了会让山跑到画外。
 */
const REF_W = 512;
function resScale(c) {
  return Math.max(0.25, (c.w || REF_W) / REF_W);
}

/**
 * 多段色标天空。
 *
 * 两个必须守住的实现细节（都踩过坑）：
 *  1. 逐行直接写像素。以前用 fillRect(c,0,t,1,1/(h-1),col) 逐行铺，
 *     归一化坐标乘完再 Math.round，行与行之间会零星撞成 0 高，
 *     天空上就出现一道道横向裂缝（透明或前置色漏出）。
 *  2. 色标之间用**连续性插值**，不能用 smoothstep。
 *     smoothstep 在每个色标处导数为 0，两段相接处会形成一个折角，
 *     天空上就会出现一条看得见的“色阶横带”（自动诊断报的就是它）。
 *     这里用简单的 Catmull-Rom 切线估计，让颜色函数 C¹ 连续。
 */
function skyGradient(c, y0, y1, stops) {
  const W = c.w;
  const list = stops.map(([t, col]) => ({ t, rgb: hexToRgb(col) }));
  const ya = Math.round(y0), yb = Math.round(y1);
  const n = list.length;
  // 预先算每个色标处的切线（Catmull-Rom），控制点不足时退化为 0
  const tan = list.map((p, i) => {
    const p0 = list[Math.max(0, i - 1)], p1 = list[Math.min(n - 1, i + 1)];
    const dt = p1.t - p0.t;
    if (dt <= 1e-9) return [0, 0, 0];
    return [0, 1, 2].map((ch) => (p1.rgb[ch] - p0.rgb[ch]) / dt);
  });
  for (let y = ya; y <= yb; y++) {
    const t = yb === ya ? 0 : (y - ya) / (yb - ya);
    let i = n - 2;
    for (let k = 0; k + 1 < n; k++) {
      if (t >= list[k].t && t <= list[k + 1].t) { i = k; break; }
    }
    const a = list[i], b = list[i + 1];
    const h = b.t - a.t;
    const f = h <= 1e-9 ? 0 : Math.max(0, Math.min(1, (t - a.t) / h));
    // Hermite 基
    const f2 = f * f, f3 = f2 * f;
    const h00 = 2 * f3 - 3 * f2 + 1;
    const h10 = f3 - 2 * f2 + f;
    const h01 = -2 * f3 + 3 * f2;
    const h11 = f3 - f2;
    const rgb = [0, 1, 2].map((ch) =>
      h00 * a.rgb[ch] + h10 * h * tan[i][ch] + h01 * b.rgb[ch] + h11 * h * tan[i + 1][ch]);
    const hex = rgbStr(rgb);
    for (let x = 0; x < W; x++) setPx(c, x, y, hex);
  }
}

/**
 * 一层山：按列求山脊高度，从山脊填到山脚，带 rim 受光边。
 * @param {number} topY 山脚线（归一化）
 * @param {number} peak  峰高占画面高度的比例
 * @param {number} freq  横向频率（越小越平阔）
 */
function terrainLayer(c, o) {
  // 统一用 c.w / c.h 换算归一化坐标（以前写 c.w-1 / c.h-1，跟 groundPlane、
  // foliageLine 用的 c.h 不一致，两层之间会缓出 1 px 的缝——大画布上就是一条横带）。
  const W = c.w, H = c.h;
  // 【分辨率自适应】噪声频率跟着画布宽走，否则 1024 上细节被拉宽一倍
  const RS = resScale(c);
  const baseY = Math.round(o.baseY * (H - 1));
  const peak = o.height * (H - 1);
  const topRgb = hexToRgb(o.top);
  const botRgb = hexToRgb(o.bottom || shade(hexToRgb(o.top), 0.62));
  const rimRgb = o.rim ? hexToRgb(o.rim) : null;
  const snowRgb = o.snow ? hexToRgb(o.snow) : null;
  // 默认填到 baseY（山脚）：山体不应该盖住前面的地面。
  // 注意：山脚之下的区域必须由后续地面层负责填满，否则会露出天空。
  const bottomY = Math.min(H - 1, Math.round((o.bottomY ?? o.baseY) * (H - 1)));
  let hy0 = 0; // 上一列的山脊高度（算 rim 的局部斜率用）
  for (let x = 0; x <= W; x++) {
    const n = o.ridge === false
      ? fbm1(x * o.freq * RS, o.seed || 1, o.octaves || 5, o.rough ?? 0.5)
      : ridged1(x * o.freq * RS, o.seed || 1, o.octaves || 5, o.rough ?? 0.5);
    const drift = fbm1(x * o.freq * 0.18 * RS, (o.seed || 1) + 977, 2, 0.5);
    const hy = baseY - (0.3 + 0.7 * n) * peak * (0.72 + 0.5 * drift);
    const top = Math.max(0, Math.round(hy));
    // 同 foliageLine：bottomY 可能超出画布（baseY 常写成 >1 让山脚落到画外），
    // 直接用 bottomY 循环会让底部几行变成“谁都没画”的空白，
    // 在风景里就表现为一条突兀的亮/异色横带。
    const spanEnd = Math.min(H - 1, bottomY);
    // span 用 max(1,·) 保护除零，但若 spanEnd < top（整层落在画布外），
    // t 会是很大的负数，f = t²*0.75 + t*0.25 在大负数下变成很大的正值，
    // 色值爆表→钳制成白/黑点。源头截断。
    const span = Math.max(1, spanEnd - top);
    for (let y = top; y <= spanEnd; y++) {
      const t = Math.max(0, Math.min(1, (y - top) / span));
      const f = t * t * 0.75 + t * 0.25;
      let r = topRgb[0] + (botRgb[0] - topRgb[0]) * f;
      let g = topRgb[1] + (botRgb[1] - topRgb[1]) * f;
      let b = topRgb[2] + (botRgb[2] - topRgb[2]) * f;
      if (snowRgb) {
        // 【雪线必须是“舌头状”的，不是碎斑】
        // 以前 sn 只按 y 线性衰减，再叠一个**高频** edge —— 1024 宽下
        // 高频噪声把雪区打碎成一颗颗白斑，远看就是山顶长了一层白毛。
        // 真实雪线：沿沟谷向上爬（V 形），但**整体是连续的**。
        // 做法：edge 用低频（0.02 而非 0.09），并且只在雪线附近起作用。
        const sn = 1 - (y - top) / Math.max(1, (baseY - top) * (o.snowLine ?? 0.35));
        const edge = fbm2(x * 0.018 * RS, y * 0.018 * RS, (o.seed || 1) + 31, 3, 0.6);
        // 低洼处（edge 小）雪伸得更低；山脊处（edge 大）雪退得更高
        const snowEdge = sn * 1.35 - (edge - 0.5) * 0.55;
        const k = Math.max(0, Math.min(1, snowEdge));
        // 雪与岩交界不要硬切：给 8% 的柔化带
        r += (snowRgb[0] - r) * k;
        g += (snowRgb[1] - g) * k;
        b += (snowRgb[2] - b) * k;
        // 【雪区必须有明暗，不能直接盖成 #ffffff】
        // 原来直接把颜色换成 snow 色 —— 雪线以上就是一块**没有任何变化的纯白**，
        // 整座山读成一坨白糖堆（没有任何体积感）。
        // 真实的雪坡和雪原一样只有两个尺度：低频坡向 + 极轻细纹。
        // 用低频（波长 ~125px）推雪坡朝光/背光，暗部压向冷蓝（雪影是蓝的）。
        const sdir = fbm2(x * 0.004 * RS, y * 0.007 * RS, (o.seed || 1) + 211, 3, 0.55) - 0.5;
        const sAmt = k * 40;
        r += sdir * sAmt;
        g += sdir * sAmt * 0.92;
        b += sdir * sAmt * 0.52;
      }
      // 【山体材质】纯色渐变的山 = 一块灰板。真实的岩体有沟壑与碎岩，
      // 用竖向拉长的噪声（沟是竖的，不是横的）。频率随高度变化：
      // 靠近山脚更细碎（近处看得清），靠近雪线更平滑（被雪盖住）。
      if (o.rock !== false) {
        const f2 = 0.055 + 0.09 * t;
        // y 频率远低于 x：竖向沟壑（横向条纹会立刻露馅）
        const rn = fbm2(x * f2 * RS, y * f2 * 0.22 * RS, (o.seed || 1) + 71, 3, 0.55) - 0.5;
        const amt = (o.rock ?? 0.30) * 46 * (0.35 + 0.65 * t);
        r += rn * amt;
        g += rn * amt * 0.97;
        b += rn * amt * 0.92;
      }
      setPx(c, x, y, rgbStr([r, g, b]));
    }
    // 【山脊受光边】以前是 setPx(c, x, top, rimRgb) —— 每列只画 1 px。
    // 问题是山脊线在低频山体上几乎水平，这一整排 1px 亮像素连起来
    // 就是一条**横贯全图的白色细线**（1024 画布上极其刺眼，
    // 在 snowpeak 里被误读成「远处有公路」）。
    // 正确做法：把 rim 做成一圈**渐隐的受光带**（往下 3~6px 逐渐减弱），
    // 并且强度随山脊坡度变化 —— 只有迎光的那一侧才该亮。
    if (rimRgb) {
      const prevTop = x > 0 ? Math.max(0, Math.round(hy0)) : top;
      // 山脊的局部斜率：越陡的坡被侧光照得越明显
      const steep = Math.min(1, Math.abs(top - prevTop) * 0.6);
      const rimH = 3 + Math.round(3 * steep);
      for (let k2 = 0; k2 < rimH; k2++) {
        const y = top + k2;
        if (y > spanEnd) break;
        // 线性渐隐 + 只保留一部分强度（不要盖掉山体）
        const a = (1 - k2 / rimH) * (0.45 + 0.35 * steep) * 255;
        blendPx(c, x, y, rgbStr(rimRgb), a);
      }
    }
    hy0 = hy;
  }
}

/** 云：fbm2 + 阈值，横向拉伸，云底压暗 */
function cloudLayer(c, o) {
  const W = c.w, H = c.h;
  const x0 = Math.round((o.x ?? 0) * W), x1 = Math.round(((o.x ?? 0) + (o.w ?? 1)) * W);
  const y0 = Math.round(o.y * H), y1 = Math.round((o.y + o.h) * H);
  const sc = o.scale ?? 0.006;
  const scY = o.scaleY ?? sc * 2.2;
  const RS = resScale(c);
  const spanY = Math.max(1, y1 - y0);
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    // 上下渐隐：云区是个矩形，不淡出的话区域顶/底会留下一道笔直的横切边，
    // 一眼就能看出“云被裁掉了一块”。
    // 【关键】fade 必须用平滑曲线（smoothstep）且区间要够长：
    // 以前用 min(1, ty/0.25) 这种线性斜坡，在最上面一行 fade 从 0 直接跳到
    // 1/spanY —— 行平均色会在两行内跳 10+，自动诊断直接报“横贯全图的色带”。
    // 改成两端各 40% 高度内做 smoothstep，一次只差 1~2 个色阶。
    const ty = (y - y0) / spanY;
    const ramp = 0.40;
    const fin = Math.min(1, ty / ramp);
    const fout = Math.min(1, (1 - ty) / ramp);
    const s = (v) => v * v * (3 - 2 * v);
    const fade = s(Math.max(0, fin)) * s(Math.max(0, fout));
    if (fade <= 0.004) continue;
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const n = fbm2(x * sc * RS, y * scY * RS, o.seed ?? 7, o.octaves ?? 5, 0.55);
      let k = (n - (o.threshold ?? 0.52)) / (o.soft ?? 0.14);
      if (k <= 0) continue;
      k = Math.min(1, k);
      k = k * k * (3 - 2 * k);
      const lower = fbm2(x * sc * 1.7 * RS, (y + 3) * scY * RS, (o.seed ?? 7) + 5, 3, 0.5);
      const d = 1 - (o.shade ?? 0.16) * Math.max(0, Math.min(1, (n - lower) * 6));
      const rgb = hexToRgb(o.color || '#ffffff');
      blendPx(c, x, y,
        rgbStr(rgb.map((v) => v * d)),
        k * fade * (o.alpha ?? 255));
    }
  }
}

/**
 * 雾带（空气透视：越远越淡。风景有无纵深就靠它）
 * 关键在“边界不规则”：均匀横条一眼就是 P 上去的灰带。
 * 用低频噪声把带状边推到 0.3~1.7 倍，雾就有了山间的厚度感。
 */
function fogBand(c, o) {
  const W = c.w, H = c.h;
  const cy = o.cy * H;
  const spread = Math.max(1, (o.spread ?? 0.08) * H);
  const maxA = o.alpha ?? 150;
  const sc = o.scale ?? 0.004;
  const RS = resScale(c);
  const noiseAmt = o.noise == null ? 0.55 : o.noise;
  for (let y = Math.max(0, Math.round(cy - spread * 2)); y < Math.min(H, Math.round(cy + spread * 2)); y++) {
    for (let x = 0; x < W; x++) {
      // 两个尺度一起推雾心：只用一个尺度的话，边界是一条滑顺的波浪线，
      // 大画布上一眼就看出“雾是一条带子”。低频定大形 + 中频打碎。
      const big = fbm2(x * sc * RS, y * sc * 0.5 * RS, o.seed ?? 21, 3, 0.55) - 0.5;
      const mid = fbm2(x * sc * 5.0 * RS, y * sc * 3.0 * RS, (o.seed ?? 21) + 61, 3, 0.5) - 0.5;
      const wave = (big * 2.0 + mid * 1.2) * noiseAmt;
      const d = Math.abs(y - cy) / spread - wave;
      if (d > 1) continue;
      const band = Math.pow(1 - d, o.power ?? 1.6);
      const n = fbm2(x * sc * 2.2 * RS, y * sc * 4 * RS, (o.seed ?? 21) + 17, 4, 0.55);
      // 【必预钳制】k = band * (0.45 + 0.9*n)，最大可达 1*1.35 = 1.35，
      // 而下一行是 Math.min(maxA, k*maxA) —— 只要 k>1 就被钉成**同一个颜色**，
      // 于是一大片雾变成实心色块，雾与山相接处出现一条死硬的亮线
      // （snowpeak 里那条“远山上的白公路”就是它）。
      // 正确做法：在源头就把 k 钳到 0..1，让雾始终保持柔和。
      const k = Math.max(0, Math.min(1, band * (0.45 + 0.9 * n)));
      if (k <= 0.012) continue;
      blendPx(c, x, y, o.color || '#dfe9f3', k * maxA);
    }
  }
}

/** 水面倒影 + 波光 */
function waterLayer(c, o) {
  const W = c.w - 1, H = c.h - 1;
  const shore = Math.round(o.shoreY * H);
  const depth = Math.min(H - shore, Math.round((o.depth ?? (1 - o.shoreY)) * H));
  if (depth <= 0) return;
  const RS = resScale(c);
  const src = new Uint8ClampedArray(c.data);
  for (let y = shore; y <= shore + depth; y++) {
    const t = (y - shore) / depth;
    // 【倒影不能是点对点镜像】原写法 srcY 只随 t 变、不随 x 变 ——
    // 等于把地平线上方的那一行**整行**复制下来，太阳被原样复制成一个圆盘
    // （看起来像一张白饼贴在水面上）。
    // 真实的太阳倒影是**被波纹左右打碎的垂直光柱**：每一行都要按这一行自己的
    // 波形平移采样位置，且越近（t 越大）平移幅度越大、碎片越宽。
    const srcY = shore - 1 - Math.round(t * depth * 0.98);
    for (let x = 0; x <= W; x++) {
      // 每行独立的波形（用 y 定相位、x 定横向扰动），让倒影左右晃
      const wave =
        Math.sin(y * (o.freq ?? 0.09) * 4.1 + x * 0.004) * (o.ripple ?? 2.2) * (0.5 + t * 2.2)
        + Math.sin(y * (o.freq ?? 0.09) * 11.0 + x * 0.017) * (o.ripple ?? 2.2) * (0.3 + t * 1.2);
      const sx = Math.round(x + wave);
      // 【压暗必须从 1 开始】原式 t=0 时 d=darken(0.62)，即紧贴海平线的那一行
      // 一下子被打暗 38%，而它上面是天空的亮色 → 接缝处亮度从 202 跳到 126，
      // 就是 lint 一直报的那条 3~5px 硬横带。
      // 真实的远水面接近天空亮度，只是整体压暗：让 d 随 t 从 1 平滑降到 darken。
      const dk = o.darken ?? 0.72;
      const d = 1 - (1 - dk) * Math.min(1, t * 3.6);
      if (srcY < 0 || sx < 0 || sx > W) { setPx(c, x, y, '#2a4a63'); continue; }
      const si = (srcY * c.w + sx) * 4;
      if (src[si + 3] <= 8) { setPx(c, x, y, '#2a4a63'); continue; }
      // 【波纹明暗】倒影本身只是"采样"，看起来仍像一块镜面玻璃。
      // 真实的近处水面有**横向的明暗条**（波峰朝天反光、波谷发暗），
      // 周期随距离变短（近处看得见单个波，远处被压缩成细纹）。
      // 【必须掺 x】第一版相位只跟 y 走 → 同一行整行取值相同，
      // 在大画布上就是一条条**横贯全图的色带**（lint 直接报了 y=365~369）。
      // 水面的波纹永远是弯的：相位用低频噪声推，让波峰起伏而不平直。
      const wavK = Math.sin(
        y * (0.30 + 1.4 * t)
        + Math.sin(x * 0.006 + t * 2.5) * 3.0
        + fbm2(x * 0.004 * RS, y * 0.010 * RS, (o.seed ?? 11) + 313, 3, 0.55) * 5.0,
      );
      const shade = 1 + wavK * (0.07 + 0.13 * t);
      setPx(c, x, y, rgbStr([
        src[si] * d * shade,
        src[si + 1] * d * 0.98 * shade,
        src[si + 2] * d * 1.04 * shade,
      ]));
    }
  }
  // 波光：海面的高光碎片 —— 只出现在太阳正下方那条垂直光带里（真实的
  // 「金光大道」），而不是均匀撒满整个水面。均匀撒 = 一层沙砾噪点。
  const rnd = makeRng(o.seed ?? 11);
  const sunX = (o.sunX ?? 0.5) * W; // 太阳所在的横向位置
  for (let y = shore + 1; y <= shore + depth; y++) {
    const near = 1 - (y - shore) / Math.max(1, depth);
    // 光带宽度随距离变宽（近处光柱铺得开）
    const spreadW = W * (0.02 + near * 0.10);
    const n = Math.round(6 + 26 * (0.25 + near * 0.9));
    for (let i = 0; i < n; i++) {
      const len = 2 + Math.round(rnd() * (4 + near * 16));
      // 高斯落在光带里（再叠一点全画布的零散碎光）
      const g = (rnd() + rnd() + rnd() - 1.5) / 1.5; // −1..1，中间密
      const sx = Math.round(sunX + g * spreadW + (rnd() - 0.5) * W * 0.12);
      if (sx < 0 || sx + len > W) continue;
      const a = 150 * (0.30 + rnd() * 0.70) * (0.45 + near * 0.55);
      for (let k = 0; k < len; k++) blendPx(c, sx + k, y, '#cfeeff', a);
    }
  }
}

/** 太阳 + 光晕 */
function sunBody(c, o) {
  const W = c.w - 1, H = c.h - 1;
  const cx = o.cx * W, cy = o.cy * H;
  const r = Math.max(1, o.r * Math.min(W, H));
  const haloR = r * (o.haloScale ?? 6);
  const rgb = hexToRgb(o.color || '#fff6d0');
  const halo = hexToRgb(o.halo || o.color || '#ffd9a0');
  for (let y = Math.floor(cy - haloR); y <= cy + haloR; y++) {
    for (let x = Math.floor(cx - haloR); x <= cx + haloR; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / haloR;
      if (d > 1) continue;
      const k = Math.pow(1 - d, 3);
      if (k <= 0.01) continue;
      blendPx(c, x, y, o.halo || o.color || '#ffd9a0', k * (o.haloAlpha ?? 60));
    }
  }
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if (Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) > r) continue;
      setPx(c, x, y, o.color || '#fff6d0');
    }
  }
}

/** 地面纹理（平涂大色块是「看着假」的主因，一层纹理就能救） */
function groundTexture(c, o) {
  // W 用 c.w-1 当循环上界会漏掉最右一列（x 取值 0..W 时实际覆盖 0..c.w-1 才对）
  const W = c.w - 1, H = c.h - 1;
  const y0 = Math.round(o.y0 * H), y1 = Math.round(o.y1 * H);
  const sc = o.scale ?? 0.05;
  const RS = resScale(c);
  const amount = o.amount ?? 0.18;
  const lr = hexToRgb(o.light || '#ffffff');
  const dr = hexToRgb(o.dark || '#000000');
  for (let y = y0; y <= y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    // 纵向长程明暗：地面应该有“一片亮一片暗”的大块起伏，
    // 而不是一条条分布均匀的条纹。只靠 fbm2 的话，小画布看着正常，
    // 1024 宽时频率不够低，整片会变成横条纹理。
    // （注意 macro 必须写在 x 循环里面：它是 x,y 的函数，不是每行常量。）
    for (let x = 0; x <= W; x++) {
      const n = fbm2(x * sc * RS, y * sc * RS, o.seed ?? 17, 3, 0.55) - 0.5;
      const macro = fbm2(x * sc * 0.12 * RS, y * sc * 0.30 * RS, (o.seed ?? 17) + 101, 3, 0.55) - 0.5;
      const k = (n * 2 + macro * 2.4) * amount;
      const tgt = k >= 0 ? lr : dr;
      const f = Math.min(1, Math.abs(k));
      const base = mix(o.top || '#6b8f4e', o.bottom || '#3f6330', t);
      const br = hexToRgb(base);
      setPx(c, x, y, rgbStr([br[0] + (tgt[0] - br[0]) * f, br[1] + (tgt[1] - br[1]) * f, br[2] + (tgt[2] - br[2]) * f]));
    }
  }
}

/**
 * 带纵深的地面（草地/田野/荒地）。
 * 平涂一个纯色矩形是最典型的「一眼假」，因为真实地面有两件必然的事：
 *  1) 远处被大气洗淡（偏蓝偏亮），近处才是个本色；
 *  2) 细节从远到近逐渐变密（远处一条草叶跨很多像素，被抹平了）。
 * 所以这里沿 y 同时调制「颜色」和「噪声频率」，而不是一层渐变 + 一层噪点。
 */
function groundPlane(c, o) {
  const W = c.w, H = c.h - 1;
  const y0 = Math.max(0, Math.round(o.y0 * H));
  const y1 = Math.min(H, Math.round(o.y1 * H));
      const far = hexToRgb(o.far || '#8fa4b3');
  const mid = o.mid ? hexToRgb(o.mid) : null;
  const near = hexToRgb(o.near || '#1b2a1f');
  const sc = o.scale ?? 0.016;
  const RS = resScale(c);
  const amount = o.amount ?? 0.34;
  const seed = o.seed ?? 3;
  const wob = o.wobble ?? 0.03; // 顶部边界起伏幅度（占面高比例）
  const span = Math.max(1, y1 - y0);
  for (let x = 0; x < W; x++) {
    // 【关键】每一列的顶部边界用噪声上下推，让地面与远山的交界是一条起伏的线，
    // 而不是一条横贯全图的直线。以前地面从 y0 开始平铺，边界笔直、
    // 且第一段颜色几乎不变（tt=t² 前 30% 几乎恒为 far 色），结果就是
    // **地平线下方一条蓝灰色横带**，像贴上去的贴纸。
    // 【必须钳到 y0 或以上】edge 双向抖动时，某些列的 topY 会被推到 y0+1、y0+2，
    // 而前面的 terrainLayer 只画到 baseY（通常就取 y0）—— 那一两行**两边都没画**，
    // 露出的是天空渐变的亮端，在 1024 画布上就是一条贯穿全图的白色细线
    // （snowpeak 里一度被误认为「远处有一条公路」）。
    // 只允许向上抖：地面多盖住一点山脚是自然的，露出缝是灾难。
    const edge = y0 + (fbm1(x * sc * 0.9 * RS, seed + 613, 3, 0.55) - 0.5) * wob * H * 2;
    const topY = Math.max(0, Math.min(y0, Math.round(edge)));
    for (let y = topY; y <= y1; y++) {
      const t = (y - y0) / span;
      // 颜色过渡必须**很快**收束到近景色：t^0.55 在前 10% 就完成大半，
      // 否则远处的 far 色（大气熏过的淡蓝）会铺成一大条横带 ——
      // 这也是本图里那条蓝灰带子的真正来源（并不是“没人画”）。
      const tt = Math.pow(Math.max(0, Math.min(1, t)), 0.55);
      const f = sc * (0.25 + 1.8 * tt);
      // 竖向拉长的噪声（y 频率远低于 x），地面纹理天然是竖长条，没有横向条纹
      const n = fbm2(x * f * RS, y * f * 0.35 * RS, seed, 4, 0.55) - 0.5;
      const rowN = fbm1(y * sc * 0.22 * RS, seed + 41, 2, 0.5) - 0.5;
      const k = (n * 1.8 + rowN * 0.22) * amount * (0.45 + 1.2 * tt);
      const v = k * 255;
      // 【近处要给细节】只用低频噪声铺近处，在方形/竖幅画布上底下会是一大片
      // 灰色天毯。真实的草地/地面越靠近镜头纹理越细（草叶、碎石、坟雪）。
      // 这里叠一层高频细节，强度随 t 增长（远处被大气抹平，不该有）。
      const fine = fbm2(x * f * 7.5 * RS, y * f * 2.6 * RS, seed + 907, 2, 0.5) - 0.5;
      const fineAmt = Math.max(0, tt - 0.35) * 0.85;
      const vf = fine * fineAmt * 255 * amount * 1.15;
      // 【三色插值】只给 far/near 两端时，中段是一条纯线性过渡 → 读成两层色带。
      // 给 mid 后：0~0.55 走 far→mid，0.55~1 走 mid→near，
      // 中景那一档才是“近处草坡的青绿”，纵深感立刻拉开。
      let cr, cg, cb;
      if (mid && tt < 0.55) {
        const u = tt / 0.55;
        cr = far[0] + (mid[0] - far[0]) * u;
        cg = far[1] + (mid[1] - far[1]) * u;
        cb = far[2] + (mid[2] - far[2]) * u;
      } else if (mid) {
        const u = (tt - 0.55) / 0.45;
        cr = mid[0] + (near[0] - mid[0]) * u;
        cg = mid[1] + (near[1] - mid[1]) * u;
        cb = mid[2] + (near[2] - mid[2]) * u;
      } else {
        cr = far[0] + (near[0] - far[0]) * tt;
        cg = far[1] + (near[1] - far[1]) * tt;
        cb = far[2] + (near[2] - far[2]) * tt;
      }
      setPx(c, x, y, rgbStr([
        cr + v + vf,
        cg + v * 0.98 + vf * 0.98,
        cb + v * 0.9 + vf * 0.95,
      ]));
    }
  }
}

/**
 * 植被剪影线（草兔/灌木/树线）。
 * 关键是「高频尖顶 + 双层」：单层平滑山脊看着像远山，不像草。
 * 在大画布上必须把频率跟上：一丛草只占 6~14 px，一根要几个像素。
 */
function foliageLine(c, o) {
  // 归一化基准统一用 (H-1) / (W-1)，跟 terrainLayer、groundPlane 保持一致。
  // 各层用不同的基准时，交界处会错开 1~2 px，在小画布上看不出来，
  // 1024 画布上就是一条贯穿全图的缝。
  const W = c.w, H = c.h - 1;
  const baseY = Math.round(o.baseY * H);
  const hgt = o.height * H;
  const sc = o.scale ?? 0.05;
  const RS = resScale(c);
  const topRgb = hexToRgb(o.top || '#2a3f33');
  const botRgb = hexToRgb(o.bottom || o.top || '#141d18');
  const rnd = makeRng(o.seed ?? 5);
  for (let x = 0; x < W; x++) {
    // 三层叠：大形 + 中频丛 + 高频草叶（单层不够碎）
    const a = ridged1(x * sc * 0.35 * RS, o.seed ?? 5, 3, 0.55);
    const b = fbm1(x * sc * 1.6 * RS, (o.seed ?? 5) + 17, 3, 0.55);
    const e = ridged1(x * sc * 5.5 * RS, (o.seed ?? 5) + 71, 2, 0.5);
    const hh = (a * 0.62 + b * 0.3 + e * 0.28) * hgt;
    const top = Math.round(baseY - hh);
    // 填充必须一直填到画布最后一行（y = H），不能只用 baseY：
    // 当 baseY 故意超出画布（1.06 这种写法）时，超出部分会被 setPx 跳过，
    // 于是画布最下面几行谁也没画，露出上一层的颜色 —— 在地面上就表现为
    // 底部一条异色横带。（H 已经是 c.h-1，所以最后一行是 H 本身。）
    // 【2026-11 修】以前写 min(H, baseY)：baseY=1.06 时 fillTo 超出 H 被钳回来没问题，
    // 但 baseY=0.885（中景灌木带）时 fillTo 就停在 0.885H，底下 11% 全空 ——
    // 1024×576 上那是 60 px 的一条死带，露出的正是 groundPlane 的深色底。
    // 前景带一律填到画布底，遮挡关系才对（后面的层本来就该被前面的草坡压住）。
    const fillTo = H;
    // 【必须钳制 t】span 取 max(1, fillTo-top) 后，如果 top > fillTo（整层落在画布
    // 以下、或山尖刚好超出下沿），t 会是 -25 这种大负数，q = 0.35+0.65t 就变成
    // 很大的负值，钳制后成纯黑 —— 画面上出现成片黑块/黑点，且不报错。
    // 同理 t > 1 时会推出超过 255 的值，钳制成白点。二者都要在源头截断。
    const span = Math.max(1, fillTo - top);
    for (let y = Math.max(0, top); y <= fillTo; y++) {
      const t = Math.max(0, Math.min(1, (y - top) / span));
      const q = 0.35 + 0.65 * t;
      setPx(c, x, y, rgbStr([topRgb[0] + (botRgb[0] - topRgb[0]) * q,
        topRgb[1] + (botRgb[1] - topRgb[1]) * q,
        topRgb[2] + (botRgb[2] - topRgb[2]) * q]));
    }
    // 零星竖草叶：只冒出一小截。（以前按 hgt*0.35 算，1024 宽、height 0.235 时
    // 一根草能有 47px 长，穿过整片草地像一堆“天线”；上限锁在 7px。）
    // 用 bottom 深色，才不会在浅色背景上刺眼。
    if (rnd() < (o.blades ?? 0.12)) {
      const len = Math.round(1 + rnd() * Math.min(7, hgt * 0.10));
      const bx = x + (rnd() < 0.5 ? 0 : 1);
      for (let k = 1; k <= len; k++) setPx(c, bx, top - k, o.bottom || o.top || '#141d18');
    }
  }
}

/**
 * 通用风景：黄昏山谷（默认 scene）。
 * 分层顺序就是画风景的正确顺序：天空 → 远景 → 中景 → 近景 → 雾 → 前景 → 光。
 */
function drawScene(c, pal) {
  // 【非 16:9 画布的构图自适应】
  // 所有 baseY/height 都是相对画布高的归一化值。在 1024×576 上这套参数
  // 构图正好；但拉到 1024×1024 时，山/雾依然按 0.74 的高度比例铺，
  // 而横向细节频率按宽度自适应，结果就是“山变宽变矮、画面下半部空出来”。
  // 做法：按宽高比把地平线往下推（方形画布给地面更多面积，天空更多留白）。
  const AR = c.h / c.w;                       // 0.5625(16:9) → 1.0(方形)
  const aspect = Math.max(0, Math.min(0.30, (AR - 0.5625) * 0.55));
  // 风景的画法就是「按纵深从远到近一层层盖上去」，但这里有一个必须守住的铁律：
  //   **所有层的基准线必须围绕同一条水平线（horizon）来定位。**
  // 最初版本各层 baseY 洩着写（0.72/0.76/1.02），结果：
  //  - 地平线以下的天空色洩了出来，变成一条橙色的“假地面”；
  //  - 中景山山峰盖住了太阳，雾也被山完全遮掉。
  // 正确顺序：天空 → 太阳 → 云 → 远景山 → 雾 → 中景山 → 地面 → 近景 → 纹理
  const HOR = 0.74 - aspect; // 地平线（所有层都从这里开始算）

  // 1) 天空：只铺到地平线略下（下面会被地面盖住，不会漏色）
  skyGradient(c, 0, c.h * (HOR + 0.10), [
    [0, '#16244a'], [0.26, '#34599a'], [0.58, '#7f9cc0'], [0.84, '#e8b184'], [1, '#fbe2bb'],
  ]);
  // 2) 太阳：明显高于地平线（还要避开中景山山峰），光晕收小否则糊满全屏
  sunBody(c, { cx: 0.71, cy: 0.44, r: 0.040, color: '#fff7e0', halo: '#ffb469', haloScale: 5, haloAlpha: 110 });
  // 3) 云：只在上半天空，稀一点（云铺满就把景深盖死了）
  cloudLayer(c, { y: 0.02, h: 0.30, scale: 0.0042, scaleY: 0.0145, seed: 7, threshold: 0.60, soft: 0.10, color: '#fff4e4', alpha: 235, shade: 0.10 });
  // 4) 远景山：最淡、最蓝，但也得看得出山形（雾会再洗一层，别自己先洗死）
  terrainLayer(c, { baseY: HOR + 0.01, height: 0.32, freq: 0.0026, seed: 101, octaves: 6, rough: 0.54, top: '#8299bb', bottom: '#667fa3' });
  // 5) 雾：紧贴山脚，但不能太浓（太浓就把远山完全抹掉，景深变成一片糊）
  fogBand(c, { cy: HOR + 0.012, spread: 0.040, alpha: 96, color: '#e6eff8', power: 2.6, scale: 0.0075, noise: 0.7 });
  // 6) 中景山：饱和、带山脊受光边
  terrainLayer(c, { baseY: HOR + 0.08, height: 0.21, freq: 0.0042, seed: 217, octaves: 5, rough: 0.5, top: '#4d698c', bottom: '#2f4259', rim: '#93acc8' });
  // 7) 地面：带纵深的 groundPlane（不是一块纯色矩形）。
  //    y0 要盖住中景山的山脚（baseY = HOR+0.08），否则中间会露出天空。
  //    far 色必须**跟中景山山脚色一致**（山脚 bottom 是 #2f4259）：
  //    如果地面远景是另一种蓝，两者相接处会出现一条明显的横带
  //    （两条窄色带相邻 = 人眼自动把它看成“分界线”）。
  // 【中间色阶】far→near 只在两端给色时，中段是一条线性过渡，
  // 看上去就是两层色带。加一个 mid 色把“近处草坡”的绿提前带进来。
  groundPlane(c, { y0: HOR + 0.055, y1: 1, far: '#2f4259', mid: '#2a4030', near: '#121e15', scale: 0.014, amount: 0.30, seed: 3, wobble: 0.022 });
  // 8) 中景灌木带：把整块地面分成两个纵深（远一点，更淡）
  foliageLine(c, { baseY: 0.885, height: 0.065, scale: 0.070, seed: 91, top: '#3a5240', bottom: '#22321f', blades: 0.05 });
  // 9) 近景草坡：最暗最实，baseY 超出画布，只露出顶部剪影（给画面压底）
  // 【blades 要很稀】这是 1024 宽的前景，blades 0.10 意味着平均每 10 列一根，
  // 一排 100 根“针”横在底下，像草地变成了铁栅栏。真实前景草是**成簇的**，
  // 而且尖顶密度已经由 ridged1 给了，blades 只补零星几根。
  foliageLine(c, { baseY: 1.06, height: 0.235, scale: 0.048, seed: 61, top: '#22361f', bottom: '#0c130e', blades: 0.035 });
  // 10) 地面纹理：让地面不平涸。范围必须覆盖**整个可见地面**，
  //     以前写 y0=HOR+0.07 y1=0.84 —— 只剩 3% 高度的一条细带，
  //     远端还会把地面刷成 top 色，在大画布上就是一道突兀的蓝灰横条。
  //     amount 也要小（0.10）：这层只是“调味”，不能盖掉 groundPlane 的纵深。
  groundTexture(c, { y0: HOR + 0.09, y1: 0.87, top: '#3c5142', bottom: '#1e2c1c', amount: 0.10, scale: 0.055, seed: 9 });
}

/**
 * 海边日落。
 * 海景的画法跟山景不同：地平线以下不是「地面」而是「镜像」——
 * 水面的颜色完全来自天空的倒影，只是被压暗、被横向拉扯（波纹）。
 * 所以顺序必须是「先把天空铺满整个画布 → 再把下半部分反着采样成水」。
 */
function drawSeascape(c, pal) {
  const HOR = 0.62; // 海平线
  // 天空直接铺满全画布：海水靠倒影采样，下面没天空就倒不出来
  skyGradient(c, 0, c.h - 1, [
    [0, '#1b2a52'], [0.28, '#4b5f96'], [0.45, '#a06880'], [0.56, '#e08a5e'], [0.62, '#ffcf88'],
  ]);
  cloudLayer(c, { y: 0.03, h: 0.30, scale: 0.0036, scaleY: 0.011, seed: 33, threshold: 0.50, color: '#ffd9c0', alpha: 210, shade: 0.14 });
  // 太阳压在海平线上：一半在天空、一半很快被水面倒影接住（日落的标准构图）
  sunBody(c, { cx: 0.5, cy: HOR - 0.015, r: 0.042, color: '#fff0c4', halo: '#ff9e4f', haloScale: 8, haloAlpha: 95 });
  // 海面：从天空反着采样 + 压暗 + 波纹扰动
  waterLayer(c, { shoreY: HOR, depth: 1 - HOR, darken: 0.62, ripple: 1.5, freq: 0.10, seed: 4, sunX: 0.5 });
  // 远处岛屿（压在海岸线上，剪影不能填到画底）
  // 【坑】terrainLayer 的 baseY 那一行会和海面形成一条横贯色带：
  // 岛屿填到 baseY 就停，下面紧接着是水，两种颜色硬碰。
  // 【更隐蔽的坑】不只是岛屿：海面 waterLayer 从 shoreY 那行开始画，
  // 而它还叠了一层**压暗+明度差**，于是 y=shoreY 那一行与天空直接咬合，
  // 亮度从 126 跳到 202，成了一条 3~5px 的硬横带（lint 报的 y=362~364）。
  // 做法：把岛屿的 baseY 往下推 1px（盖住接缝），并让雾带把它向下洗一层。
  terrainLayer(c, { baseY: HOR + 0.008, height: 0.035, freq: 0.013, seed: 88, octaves: 4, top: '#5c5f86', bottom: '#5c5f86', ridge: false, bottomY: HOR + 0.020 });
  // 岛顶/岛脚都用柔雾向上下两侧淡出，把硬边磨掉：
  // 一条雾带压在海岸线上并向上“爬” 3%，岛就不再是贴纸。
  fogBand(c, { cy: HOR - 0.004, spread: 0.036, alpha: 96, color: '#f6d3b0', power: 1.9, scale: 0.008, noise: 0.6 });
  // 【盖住岛屿下边界】岛屿底边与水面之间还有一道硬边（bottomY 那一行），
  // 在 512 上就是一条 5px 横带。用一条贴地平线的暖雾把它洗掉。
  fogBand(c, { cy: HOR + 0.026, spread: 0.024, alpha: 150, color: '#ffd9b8', power: 1.4, scale: 0.012, noise: 0.8 });
  fogBand(c, { cy: HOR + 0.016, spread: 0.024, alpha: 82, color: '#ffd9b8', power: 2.2, scale: 0.010, noise: 0.55 });
  // 近景沙堤（压在左下）：沙丘从左边缘伸出，斜坡入水
  const W = c.w, H = c.h - 1;
  // 沙丘是**逆光剪影**：太阳在正前方（海平线中央），所以朝向镜头的坡几乎全在阴影里，
  // 只有脊线顶部一圈被落日描出暖色轮廓光。层数越多越立体，但配色必须
  // 遵守「越近越暗」（空气透视的反向：近景占画面下方、被自身坡面挡住光）。
  const dunes = [
    { reach: 0.30, base: 0.700, drift: 0.30, amp: 0.080, seed: 61, top: '#b98f63', bottom: '#6a4f38', rim: '#f2cf9b', rip: 0.7 },
    { reach: 0.46, base: 0.800, drift: 0.24, amp: 0.068, seed: 62, top: '#96703f', bottom: '#4d3826', rim: '#e8b877', rip: 1.1 },
    { reach: 0.62, base: 0.895, drift: 0.17, amp: 0.052, seed: 63, top: '#754f2e', bottom: '#2f2318', rim: '#d19a5c', rip: 1.6 },
  ];
  for (const L of dunes) {
    const cTop = hexToRgb(L.top);
    const cBot = hexToRgb(L.bottom);
    const cRim = hexToRgb(L.rim);
    for (let x = 0; x < W; x++) {
      const t = x / W;
      if (t > L.reach) continue;
      const u = t / L.reach;
      // 脊线 = 独立相位的双尺度噪声 + 单向沉降。
      // 【坑】之前三层都写成「base + slope*u^k」，结果得到三条平行斜带 ——
      // 沙丘的脊线必须是各自随机起伏的大曲线，只有「整体下沉入水」这一项才是共用的。
      const wob =
        (fbm2(x * 0.0022, L.seed * 1.7, L.seed, 3, 0.58) - 0.5) * L.amp * 2 +
        (fbm2(x * 0.0125, L.seed * 0.9, L.seed + 31, 2, 0.5) - 0.5) * L.amp * 0.45;
      // 【坑】脊线一旦被 reach 硬截断，右端会留下一条笔直的水平线段 ——
      // 远看就是「沙丘上多了一道横线」。让脊线在接近 reach 时先被雾气吃掉
      // （整体透明度衰减），而不是靠 if 切断。
      const fade = Math.min(1, (L.reach - t) / (L.reach * 0.30));
      if (fade <= 0) continue;
      const top = Math.round(H * (L.base + L.drift * Math.pow(u, 1.5) + wob));
      if (top > H) continue;
      const span = Math.max(1, H - top);
      const edge = Math.min(1, fade * 2.2);
      for (let y = Math.max(0, top); y <= H; y++) {
        const d = (y - top) / span;
        // 坡面几乎全在阴影：只在脊线下方 0~12% 有受光，再往下迅速沉黑
        const l = Math.pow(1 - d, 3.0);
        let r = cBot[0] + (cTop[0] - cBot[0]) * l;
        let g = cBot[1] + (cTop[1] - cBot[1]) * l;
        let b = cBot[2] + (cTop[2] - cBot[2]) * l;
        // 轮廓光：脊线最上 1~3 像素的暖色描边（日落逆光最标志性的一笔）
        const rimD = Math.max(0, 1 - Math.abs(d - 0.012) / 0.055);
        r += (cRim[0] - r) * rimD * 0.7 * edge;
        g += (cRim[1] - g) * rimD * 0.7 * edge;
        b += (cRim[2] - b) * rimD * 0.7 * edge;
        // 风纹：斜向细纹，只在近处/坡面中段可见
        const rip = Math.sin((x * 0.55 + y * 1.05) * 0.30 + fbm2(x * 0.008, y * 0.014, L.seed + 5, 2, 0.5) * 9);
        const amp = L.rip * Math.pow(d, 1.6);
        r += rip * amp;
        g += rip * amp * 0.9;
        b += rip * amp * 0.75;
        // 贴水的一角湿沙压暗偏冷，跟水面自然咬合
        const wet = Math.min(1, Math.max(0, (u - 0.6) / 0.4)) * Math.min(1, Math.max(0, (d - 0.45) / 0.55));
        r -= wet * 18;
        g -= wet * 14;
        b -= wet * 2;
        const gr = (fbm2(x * 0.30, y * 0.42, L.seed + 11, 2, 0.5) - 0.5) * 6;
        // 末端的淡出：跟已经画好的水面做 alpha 混合（不能直接跳过，
        // 跳过的话脊线右端就变成一条齐平的水平边）
        if (fade < 1) blendPx(c, x, y, rgbStr([r + gr, g + gr, b + gr * 0.85]), fade * 255);
        else setPx(c, x, y, rgbStr([r + gr, g + gr, b + gr * 0.85]));
      }
    }
  }
}

/** 雪山晴空：练远景分层（雪线 + 空气透视） */
function drawSnowPeaks(c, pal) {
  const HOR = 0.80; // 地平线（主峰山脚）
  skyGradient(c, 0, c.h * (HOR + 0.06), [[0, '#1e5a94'], [0.45, '#5b9bc9'], [0.8, '#c3dfef'], [1, '#e8f3fa']]);
  cloudLayer(c, { y: 0.03, h: 0.32, scale: 0.0038, seed: 12, threshold: 0.58, color: '#ffffff', alpha: 190, shade: 0.12 });
  // 最远的雪山（淡蓝，几乎溶入大气）。
  // 【必须和主峰用不同 seed + 不同 freq + 不同高度】以前远山和主峰几乎
  // 同形，只是颜色淡一点 —— 结果看起来像“同一个山体叠了两层”。
  // 远山要更宽、更低、更平（低频率、大尺度），主峰才显得“立在前面”。
  terrainLayer(c, { baseY: HOR - 0.03, height: 0.26, freq: 0.0016, seed: 1409, octaves: 5, rough: 0.62, top: '#c2d2e4', bottom: '#9db2c9', snow: '#f0f6fb', snowLine: 0.38 });
  // 空气透视：远山与主峰之间的雾。
  // 【必须窄而薄】以前 spread 0.055（=63px）+ alpha 110 + power 2.0，
  // 在主峰前糊出一整片白墙 —— 雪山的“雪”和雾同色，一旦雾太厚，
  // 山体就被抹成一片白棉，层次全失。雾带改成窄（近山脚）、淡（alpha 60）。
  fogBand(c, { cy: HOR - 0.022, spread: 0.028, alpha: 62, color: '#dceaf5', power: 2.6, scale: 0.006, noise: 0.7 });
  // 主峰（更实、带山脊受光边与积雪）
  // 【雪线】snowLine 是“雪覆盖的山体比例”：0.42 意味着从山尖向下 42% 全是雪 ——
  // 配上 rim 与雾，整座山就变成一坨白。真实的高山雪线大约在山高的
  // 1/3 以下（下面露出岩壁），且**雪线本身是舌头状的**（沿沟谷下伸），
  // 所以 snowLine 用小值 + rock 加大，让下部露出青灰色岩体。
  terrainLayer(c, { baseY: HOR, height: 0.42, freq: 0.0042, seed: 77, octaves: 6, rough: 0.5, top: '#8ea6c0', bottom: '#3d5166', rim: '#e8f2fb', snow: '#eef4fa', snowLine: 0.30, rock: 0.65 });
  // 山脚再压一层很薄的雾：把主峰山脚与地面“咬”在一起，避免硬切
  fogBand(c, { cy: HOR - 0.006, spread: 0.016, alpha: 46, color: '#cfe2f2', power: 3.0, scale: 0.009, noise: 0.5 });
  // 地面：从主峰山脚无缝接过（y0 必须 ≤ 主峰 baseY，否则中间露天空）
  groundPlane(c, { y0: HOR - 0.005, y1: 1, far: '#4a5f76', near: '#1d2a22', scale: 0.015, amount: 0.26, seed: 23, wobble: 0.018 });
  // 山脚针叶林带（高频剪影，把山与地面接起来）
  foliageLine(c, { baseY: 0.800, height: 0.050, scale: 0.055, seed: 210, top: '#2f4436', bottom: '#182218', blades: 0.06 });
  // 近景雪地：不要用 foliageLine（那是「植被剪影」，画在雪地上会变成
  // 一排白森森的蛇牙，而且 baseY=1.08 还会把底部刷成死硬）。
  // 雪地是一块「铺在地上的面」，要的是低频起伏 + 冷蓝影（雪不是纯白）：
  //   1) 顶部边界是雪脊曲线（不是一条直边）
  //   2) 迎光面暖白、背光面冷蓝（雪影必须是蓝的，不是灰的）
  //   3) 叠加雪丘的凹凸，避免一大片纯白曝光过度
  // 【高度】原来只占底部 6%（0.935~1），在 16:9 画布上就是一条白带；
  // 现在从 0.86 开始，占 14%，才有「雪原」的面积感。
  {
    const W2 = c.w, H2 = c.h - 1;
    const RSS = resScale(c);
    // 【雪原上边界必须是起伏的雪脊线】
    // 以前雪原从 ty=0.86 开始平铺 —— 那是一条贯穿全宽的直线边，
    // 1024 画布上就是一根 820px 长的白尺子。真实雪原与林带之间是
    // 一道起伏的雪坡（雪把地面抹平，但**宏观起伏永遠存在**）。
    // 逐列算雪脊高度：低频大波（数十到数百 px）+ 中频雪堆。
    const ridgeLine = new Float32Array(W2);
    for (let x = 0; x < W2; x++) {
      const big = fbm1(x * 0.0018 * RSS, 341, 3, 0.55) - 0.5;
      const mid = fbm1(x * 0.0075 * RSS, 342, 3, 0.5) - 0.5;
      ridgeLine[x] = 0.812 + big * 0.075 + mid * 0.020;
    }
    // 【雪丘形体·逐像素】之前是按列预算 moundSlope 数组再复用到整列 ——
    // 结果是每一列亮度只有一个值，1024 上就是一根根**竖直条带**
    // （看上去像水面的波纹/拉丝），完全不像雪。
    // 改成逐像素用高度场的二维梯度求坡向：x 与 y 都有自己的变化，
    // 雪丘才有“左坡亮、右坡暗、顶亮、底暗”的真实立体感。
    const moundH = (px, py) =>
      fbm2(px * 0.008 * RSS, py * 0.012 * RSS, 371, 3, 0.55);
    // ↑【频率实测调参】原 x0.012/y0.030：在 1024 上 y 波长只有 17px，
    // 于是明暗每 17px 就翻一次 → 读起来是一块块**碎石/水泥地**。
    // 改成 x0.008/y0.012（波长 x≈62px、y≈42px），才是"雪丘"的尺度。
    const LIGHT_X = -0.62, LIGHT_Y = -0.78; // 光照方向（指向光源）
    for (let y = 0; y <= H2; y++) {
      const ty = y / H2;
      for (let x = 0; x < W2; x++) {
        if (ty < ridgeLine[x]) continue;
        // ═══ 雪面的“只有两个尺度”原则 ═══
        // 踩过的坑：之前用多层各向同性 fbm 的高度场求梯度做明暗，1024 上
        // 每一小块都独立亮暗 → 读起来是**碎石地/水泥地**，不是雪。
        // 真实的雪原被风抹平，肉眼只能看到两个尺度：
        //   ① 雪丘的宏观坡向（几十~两百 px，横向拉长的条带）
        //   ② 风纹 sastrugi（沿风向拉长，周期 30~50px 的细横纹，幅度极轻）
        // 除此之外**任何各向同性高频噪声都要清掉**。
        const nearK = Math.max(0, Math.min(1, (ty - ridgeLine[x]) / 0.10));
        // ① 宏观雪丘：moundH 的 x 频率(0.012)远低于 y(0.030)，天然是横向条带
        const e2 = 4;
        const mgx = moundH(x + e2, y) - moundH(x - e2, y);
        const mgy = moundH(x, y + e2) - moundH(x, y - e2);
        const moundK = -(mgx * LIGHT_X + mgy * LIGHT_Y) * 6;
        // 远处雪面被雪雾淡化，明暗对比随时间减弱（空气透视）
        const fade = 0.35 + 0.65 * nearK;
        const lift = Math.max(-1, Math.min(1, moundK * fade));
        // ② 风纹 sastrugi：真雪面的风纹是**横向长纹**（风沿一个方向刮），
        //    不是斑块。所以相位只能沿 x 缓慢变化，y 方向必须是干净正弦：
        //    之前用 fbm2 的 x+y 双变量推相位（×11）→ 纹路被揉碎成点状沙砾感。
        const ph = fbm1(x * 0.0022 * RSS, 345, 2, 0.5) * 3.2;
        const wind = Math.sin(y * 0.19 * RSS + ph);
        const wAmt = 7 * nearK * nearK; // 只在近处可见，远处被风抹平
        // ③ 明暗映射到雪的真实色域：
        //    背光面 = 冷蓝灰(r168 g178 b200)，受光面 = 近纯白(r243 g246 b250)。
        //    注意 b 的跨度要比 r 小 —— 雪是“亮部发白，暗部发蓝”，
        //    两个通道同幅变化会得到灰石头。
        const t = 0.5 + lift * 0.5;
        let r = 158 + t * 88 + wind * wAmt * 0.6;
        let g = 170 + t * 79 + wind * wAmt * 0.7;
        let b = 193 + t * 60 + wind * wAmt * 0.9;
        // 雪脊附近的暖受光边（落日低角度光擦过雪坡顶部）
        const edgeD = Math.max(0, 1 - (ty - ridgeLine[x]) / 0.010);
        if (edgeD > 0) { r += 20 * edgeD; g += 13 * edgeD; b += 4 * edgeD; }
        setPx(c, x, y, rgbStr([r, g, b]));
      }
    }
  }
}

/** 森林晨雾：练光柱与树的剪影层次 */
function drawForestMist(c, pal) {
  skyGradient(c, 0, c.h - 1, [[0, '#a8c4b0'], [0.5, '#d4e3d2'], [1, '#eef4e6']]);
  // 三层树剪影：越远越淡越偏青（空气透视）
  // 【层次】三层不能只靠颜色区分，更靠**密度与重叠**：
  //   远层：树小、间距小于冠幅 → 树冠互相咬合成一整片树线（看不到单棵树）
  //   中层：局部成片、局部露出单棵
  //   近层：单棵清楚可辨，裥幅大、树干可见
  // 以前三层用同一个间距公式，结果就是三排整齐的“梳齿”。
  const layers = [
    { y: 0.42, h: 0.22, col: '#8aa89e', bottom: '#6d8a80', lit: '#a8c7bd', gap: 0.52, trunk: '#6d8a80', sc: 0.012, seed: 51 },
    { y: 0.60, h: 0.26, col: '#4e6b62', bottom: '#35504a', lit: '#7ba396', gap: 0.72, trunk: '#425c53', sc: 0.016, seed: 52 },
    { y: 0.78, h: 0.24, col: '#2b3f38', bottom: '#16241f', lit: '#4a6b5e', gap: 1.05, trunk: '#1f2f29', sc: 0.022, seed: 53 },
  ];
  // 画布基准宽度（供间距/尺寸缩放用）
  const RSf = resScale(c);
  for (const L of layers) {
    const W = c.w - 1, H = c.h - 1;
    const baseY = Math.round((L.y + L.h) * H);
    // 先铺一层实心底（树线以下全是植被），否则树与树之间的缝隙会露出天空
    for (let x = 0; x <= W; x++) {
      // 底边同样起伏（坡地），但不是尖刺，是缓波
      const ground = Math.round(baseY + (fbm1(x * L.sc * 0.5 * RSf, L.seed + 41, 2, 0.5) - 0.5) * L.h * H * 0.10);
      for (let y = Math.max(0, ground); y <= H; y++) setPx(c, x, y, L.col);
    }
    // 【核心修法】以前靠 ridged1 叠曲线推「树冠轮廓」，画出来是一条锯齿细线 ——
    // 那是山脊的画法，不是树。树之所以一眼认得出，靠的是**一棵一棵的结构**：
    // 锥形冠 + 树干 + 树尖比树根窄，且每棵高度/宽度都不同。
    //
    // 【竖线根因·已彻底解决】逐棵用浮点 cx/dx 再 Math.round，会产生**整数列缺口**：
    // 两棵相邻树的覆盖列在取整后可能差 1 px 谁都没占，那一列永远是天空色，
    // 于是画面上出现一条条从树尖贯穿到地表的竖直亮线（我在 1024 画布上实测
    // 每层有 20+ 个这样的空列，比如 x=46、118、123、754）。
    // 正确做法是**按列求值**，而不是按棵画：
    //   对每个整数列 x，遍历每棵树算「这列在该冠内的顶边」，取最小值（最高的那棵），
    //   然后从该顶边一直填到地表。这样每一列必然有值，结构上不可能漏。
    const trees = [];
    {
      const rnd0 = makeRng(L.seed * 977);
      let tx = 0;
      while (tx <= W + 1) {
        const w = L.h * H * (0.075 + rnd0() * 0.075); // 冠幅半径
        const h = L.h * H * (0.50 + rnd0() * 0.85); // 树高
        const lean = (rnd0() - 0.5) * w * 0.35; // 树尖略歪
        // 【每棵树的独立色差】原来所有树共用 L.col/L.lit/L.bottom —— 几百棵
        // 同色的锥形贴上去，读起来是一面「梳齿墙」。真实树线里每棵树的
        // 受光程度、健康度、远近都不同，必须给每棵树一个 0~1 的随机明度。
        const tone = 0.30 + rnd0() * 0.70;
        // 近层（gap 大、树高）才露树干；但近层 baseY 已超出画布底，
        // 树干会被画在画布外 → 中层也要给，否则整片林看不到一棵有干的树。
        const trunk = L.gap > 0.60 ? 1 : 0;
        trees.push({ cx: tx + w, w, h, lean, topY: baseY - h, tone, trunk });
        tx += w * 2 * L.gap * (0.78 + rnd0() * 0.44);
      }
    }
    for (let x = 0; x <= W; x++) {
      // 该列被哪棵树覆盖得最高（顶边 y 最小）
      let topMin = Infinity;
      let owner = null;
      let ownerT = 0;
      for (const T of trees) {
        const dx = x - T.cx;
        const lim = T.w + Math.abs(T.lean) + 1;
        if (dx < -lim || dx > lim) continue;
        const t = Math.min(1, Math.abs(dx - T.lean * (1 - Math.abs(dx) / T.w)) / T.w);
        const crownH = T.h * (1 - t * t * 0.75);
        let y0 = Math.round(T.topY + (T.h - crownH));
        y0 += Math.round(Math.sin(dx * 1.7 + L.seed) * Math.min(3, T.w * 0.16));
        if (y0 < topMin) { topMin = y0; owner = T; ownerT = t; }
      }
      if (!Number.isFinite(topMin)) continue; // 这一列在树冠之外（不可能是常态）
      // 【树冠立体感】以前整列刷同一个 L.col —— 几百棵纯色三角贴上去，
      // 一眼就能看出是程序生成的“碍头堆”。真实的树冠有明确的两件事：
      //   1) 横向明暗：受光半边亮、背光半边暗（光源在左上）
      //   2) 枝层：针叶树是一层层的枝盘，轮廓有周期性凹凸，
      //      越靠下枝盘越宽 → 不能用一个光滞的锥形
      const cTop = hexToRgb(L.col);
      const cBot = hexToRgb(L.bottom || L.col);
      const cLit = hexToRgb(L.lit || L.col);
      const tEdge = Math.min(1, ownerT);
      const cTrunk = hexToRgb(L.trunk || L.bottom || L.col);
      for (let y = Math.max(0, topMin); y <= H; y++) {
        // 纵向位置（占树高的比例）—— 注意：列会一直填到画布底，所以 dy 会远大于 1
        const dy = (y - topMin) / Math.max(1, owner ? owner.h : 1);
        // 【树干】树冠底部是 baseY（树根），不再是 dy>0.86 ——
        // dy 是按树高归一化的，而列会填到画布底，dy 很容易就到 2、3，
        // 原写法把整个树干以下的区域全当成树干区，结果整层下半部都被 continue 掉了。
        // 改成用绝对坐标：最后一小段（baseY 以上 0~18% 树高）且靠近树心才是树干。
        if (owner && owner.trunk) {
          const trunkH = owner.h * 0.18;
          const trunkTop = baseY - trunkH;
          if (y >= trunkTop) {
            const tw = Math.max(1.5, owner.w * 0.14);
            if (Math.abs(x - owner.cx - owner.lean) <= tw) {
              setPx(c, x, y, shade(cTrunk, 0.82));
            } else { setPx(c, x, y, L.col); }
            continue;
          }
        }
        const vLight = Math.min(1, Math.max(0, (dy - 0.05) / 0.55));
        // 横向：左半边受光，右半边落影（光源在左上）
        const side = owner ? (x - owner.cx) / Math.max(1, owner.w) : 0;
        const litK = Math.min(1, Math.max(0, 0.5 - side * 0.55));
        // 【枝盘】针叶树是一层层的枝盘。这里翻过两个坑：
        // （1）相位掺 x → 横向毛刺；
        // （2）相位只跟 y 走但周期固定 → **横向条纹**（同一行上所有树、所有列
        //     共享同一个 branch 值，等于在整幅图上刷了一层等间距横纹）。
        // 正确做法：每棵树有自己的周期与相位；枝盘只出现在树冠**外缘**。
        const period = Math.max(9, owner ? owner.h * (0.10 + owner.tone * 0.06) : 12);
        const phase = L.seed * 3.1 + (owner ? owner.cx * 0.21 : 0);
        const branch = 0.5 + 0.5 * Math.sin((y / period) * Math.PI * 2 + phase);
        // 外缘遮罩：离树心越远枝盘越清晰（中心是枝干交叉的实心暗部）
        const edgeK = Math.min(1, Math.abs(side) * 1.5);
        const tone = owner ? owner.tone : 0.7;
        const rim = Math.max(0, branch - 0.62) * 0.50 * edgeK;
        const k = vLight * (0.35 + 0.65 * litK) * (0.86 + 0.14 * branch * edgeK) * (0.74 + 0.26 * tone);
        const base = [
          cBot[0] + (cTop[0] - cBot[0]) * 0.55,
          cBot[1] + (cTop[1] - cBot[1]) * 0.55,
          cBot[2] + (cTop[2] - cBot[2]) * 0.55,
        ];
        // 受光处往 lit 色提，背光处往 bottom 沉；枝盘外缘再抬一点（rim）
        const tt = Math.min(1, k + rim);
        setPx(c, x, y, rgbStr([
          base[0] + (cLit[0] - base[0]) * tt * 0.55,
          base[1] + (cLit[1] - base[1]) * tt * 0.55,
          base[2] + (cLit[2] - base[2]) * tt * 0.55,
        ]));
      }
    }
  }
  // 晨雾：从地面升起来，压住最远那层
  fogBand(c, { cy: 0.66, spread: 0.2, alpha: 120, color: '#e8f0e4', power: 1.2 });
  // 光柱从左上射下（森林里的耶稣光）
  sunBody(c, { cx: 0.12, cy: 0.02, r: 0.03, color: '#fffbe8', halo: '#fff4c8', haloScale: 10, haloAlpha: 40 });
  // 【竖线根因，务必理解】以前用 atan2 + 角度取模来生成 6 条光柱：
  //   rel = ((atan2(dy,dx) - θ0) / Δθ) * 6;  frac = rel - floor(rel)
  // 问题出在**角度是离散的**：atan2 在远离光源时对 x 极敏感，
  // 只要某一列的 atan2 值跨过 frac 的边界，这一整列就会突然判定成「光柱内」，
  // 于是整列 sn 加亮 45 —— 在图上就是一条从光源贯穿到画布底边的**竖直亮线**。
  // 正确的做法是按**屏幕空间**沿光柱方向取距离，而不是按角度取模：
  // 光柱是一组平行（略呈放射）的条带，用 u = x*sinθ - y*cosθ 的横向坐标取模，
  // 这样任何一列上的条带都是连续渐变的，不会出现整列跳变。
  const W = c.w - 1, H = c.h - 1;
  const th = Math.PI * 0.42; // 光柱方向（从左上射向右下）
  const cosT = Math.cos(th);
  const sinT = Math.sin(th);
  const srcX = 0.12 * W;
  const srcY = 0.02 * H;
  for (let y = 0; y <= H; y++) {
    for (let x = 0; x <= W; x++) {
      // 相对光源的位置；沿光柱横向的坐标 u（垂直光柱方向）
      const ddx = x - srcX;
      const ddy = y - srcY;
      // 只画光源下方（射线方向）的部分
      const along = ddx * sinT + ddy * cosT;
      if (along < 0) continue;
      const u = ddx * cosT - ddy * sinT;
      // 条带：周期 90px，用平滑的函数而不是 floor 硬切
      const band = 0.5 + 0.5 * Math.cos((u / 90) * Math.PI * 2);
      const bandK = Math.pow(Math.max(0, band - 0.25) / 0.75, 2.0);
      if (bandK < 0.02) continue;
      // 距离衰减 + 噪声（烟尘让光柱断断续续）
      const dist = Math.sqrt(ddx * ddx + ddy * ddy) / (H * 1.6);
      const fall = Math.max(0, 1 - dist);
      const n = 0.45 + 0.75 * fbm2(x * 0.010, y * 0.004, 5, 4, 0.55);
      const k = bandK * fall * fall * n;
      if (k > 0.01) blendPx(c, x, y, '#fff6cc', k * 70);
    }
  }
}

/** 星空夜色：练噪点星点与暗部渐变 */
function drawNightSky(c, pal) {
  skyGradient(c, 0, c.h - 1, [[0, '#070b1e'], [0.45, '#131c3b'], [0.78, '#2b3a63'], [1, '#4a5c85']]);
  // 星点：分两层，远处细密、近处少量亮星
  for (const L of [{ n: 900, a: 90, r: 0 }, { n: 120, a: 220, r: 1 }]) {
    const rnd = makeRng(L.n + 13);
    for (let i = 0; i < L.n; i++) {
      const x = Math.floor(rnd() * c.w);
      const y = Math.floor(Math.pow(rnd(), 1.4) * c.h * 0.8);
      const a = L.a * (0.4 + rnd() * 0.6);
      setPx(c, x, y, rnd() > 0.85 ? '#ffe9b0' : '#e8f0ff', a);
      if (L.r) { blendPx(c, x + 1, y, '#ffffff', a * 0.3); blendPx(c, x - 1, y, '#ffffff', a * 0.3); }
    }
  }
  // 银河：一条斜向的亮雾带
  // 【坑】以前是 `y - (0.15H + x*0.35)` —— 一条斜率恒定的直线，两边对称淡出。
  // 结果是一条从左上拉到右下的**直尺痕**，比没有银河更假。
  // 真实的银河：中心线本身是一大段低频噪声扭出来的蛇形，宽度也随机膨胀收缩，
  // 里面再叠尘埃带（暗纹）和星团（亮点）。
  const W = c.w, H = c.h;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 中心线：基准斜线 + 大尺度噪声偏移（让银河蜿蜒）
      const cx = 0.10 * H + x * 0.30 + (fbm1(x * 0.0016, 71, 3, 0.6) - 0.5) * H * 0.30;
      // 宽度：中段最宽、两端收窄，再叠噪声
      const widen = 0.55 + 0.45 * Math.sin((x / W) * Math.PI) + (fbm1(x * 0.004, 77, 2, 0.5) - 0.5) * 0.55;
      const halfW = H * 0.10 * Math.max(0.25, widen);
      const band = Math.abs(y - cx) / halfW;
      if (band > 1) continue;
      // 多层云雾：细节频率由粗到细，避免一团糊
      const n = fbm2(x * 0.006, y * 0.010, 71, 4, 0.55) * 0.7 + fbm2(x * 0.020, y * 0.028, 73, 3, 0.55) * 0.3;
      // 尘埃带：沿银河方向的一条暗纹，把亮带切成两半（银河最标志性的特征）
      const dust = Math.abs(y - (cx + halfW * 0.22)) / (halfW * 0.26);
      const dustK = dust < 1 ? 1 - dust : 1;
      let k = Math.pow(1 - band, 1.9) * (0.35 + 0.85 * n) * (0.45 + 0.55 * dustK);
      if (k > 0.02) {
        // 核心偏暖白（星团密集区），外缘偏冷蓝
        const warm = Math.pow(1 - band, 3);
        blendPx(c, x, y, warm > 0.5 ? '#f0e6d8' : '#cfd8ff', k * 105);
      }
    }
  }
  // 银河里的密集小星（只在带内），让雾带不是空的
  {
    const rnd = makeRng(907);
    for (let i = 0; i < 1400; i++) {
      const x = Math.floor(rnd() * W);
      const cx = 0.10 * H + x * 0.30 + (fbm1(x * 0.0016, 71, 3, 0.6) - 0.5) * H * 0.30;
      const off = (rnd() - 0.5) * H * 0.16;
      const y = Math.floor(cx + off);
      if (y < 0 || y >= H) continue;
      blendPx(c, x, y, '#eef2ff', 60 + rnd() * 130);
    }
  }
  // 远处山剪影：baseY 必须 = 1（贴到画布底）。
  // 以前写 0.88 —— 山脚停在 88% 高度，下面 12% 全是天空渐变的浅蓝尾，
  // 在夜色里就是一条刺眼的亮蓝横带（总览图上一眼就能看到）。
  //
  // 【渐变方向反了】top=#202a44 / bottom=#090d1a 意味着**山脚最黑、山脊发蓝**。
  // 但夜空里真正的远山是：山脊被天光洗成半透明蓝，山脚沉入最深的地景。
  // 原写法在 1024 上就是一块「上浅下深的黑三角」，没有体积。
  // 现在：山脊 top 保持天光的蓝（#2a3654），山体往下迅速沉到 #070b14，
  // 并且给山脊加一条极淡的 rim 受光线 —— 月光从右上方照下来。
  terrainLayer(c, {
    baseY: 1, height: 0.34, freq: 0.0032, seed: 501, octaves: 5, rough: 0.52,
    top: '#2a3654', bottom: '#070b14', rim: '#3d4f75',
  });
  // 月亮
  sunBody(c, { cx: 0.8, cy: 0.22, r: 0.035, color: '#f4f0dc', halo: '#c8d4f0', haloScale: 5, haloAlpha: 45 });
}

function outlineInOpacity() { /* 场景不描边,保留平面感 */ }


// ---------- 主体识别 ----------
// 顺序很重要：detectSubject 取第一条命中的配方。风景类必须放在最前面，
// 否则「星空」会被 star 的 /星/ 抢走。
/** 风景类配方：铺满整张画布，宽度天生是宽幅 */
const SCENE_KEYS = new Set(["scene", "seascape", "snowpeak", "forest", "night"]);
export const SUBJECT_RECIPES = [
  { key: "scene", label: "风景", test: /场景|背景|风景|莰谷|远山|山谷|日落山|scene|landscape/, draw: drawScene, palette: { main: "#5b8fc9", accent: "#6b8f4e", white: WHITE } },
  { key: "seascape", label: "海景", test: /海景|海边|海洋|沙滩|海岸|seascape|ocean|coast|beach/, draw: drawSeascape, palette: { main: "#f0975f", accent: "#4b5f96", white: WHITE } },
  { key: "snowpeak", label: "雪山", test: /雪山|雪峰|雪景|snow(l|y)?peak|snowy|alps|mountain.?snow/, draw: drawSnowPeaks, palette: { main: "#8ea6c0", accent: "#eef4fa", white: WHITE } },
  { key: "forest", label: "森林", test: /森林|树林|晨雾|林间|forest|woods|misty|woodland/, draw: drawForestMist, palette: { main: "#4e6b62", accent: "#a8c4b0", white: WHITE } },
  { key: "night", label: "星空", test: /星空|夜空|银河|星云|星夜|night|starry|galaxy|milkyway/, draw: drawNightSky, palette: { main: "#131c3b", accent: "#cfd8ff", white: WHITE } },
  { key: "penguin", label: "企鹅", test: /企鹅|penguin/, draw: drawPenguin, palette: { main: "#3b82f6", accent: "#f59e0b", white: WHITE } },
  { key: "slime", label: "史莱姆", test: /史莱姆|slime|黏液|软泥/, draw: drawSlime, palette: { main: "#3b82f6", accent: "#22c55e", white: WHITE } },
  { key: "cat", label: "猫", test: /猫|cat|kitten/, draw: drawCat, palette: { main: "#e8a33d", accent: "#f7c873", white: WHITE } },
  { key: "bird", label: "鸟", test: /鸟|bird|小鸡|鸡|chick|鸭|duck/, draw: drawBird, palette: { main: "#f5c542", accent: "#f97316", white: WHITE } },
  { key: "ghost", label: "幽灵", test: /幽灵|鬼|ghost|spirit/, draw: drawGhost, palette: { main: "#c8d6e5", accent: "#8fa8bf", white: WHITE } },
  { key: "humanoid", label: "人物", test: /人物|角色|小人|骑士|勇者|战士|法师|hero|character|knight|avatar|玩家|人/, draw: drawHumanoid, palette: { main: "#4f7fd4", accent: "#2b4a7d", white: WHITE } },
  { key: "sword", label: "剑", test: /剑|刀|sword|blade|武器/, draw: drawSword, palette: { main: "#9fb3c8", accent: "#c9a227", white: WHITE } },
  { key: "shield", label: "盾", test: /盾|shield|护甲/, draw: drawShield, palette: { main: "#8a6f3f", accent: "#d9b45c", white: WHITE } },
  { key: "potion", label: "药水", test: /药水|药剂|瓶|potion|flask|elixir/, draw: drawPotion, palette: { main: "#e14b6a", accent: "#8a5a2b", white: WHITE } },
  { key: "gem", label: "宝石", test: /宝石|宝石|钻石|晶|gem|diamond|crystal/, draw: drawGem, palette: { main: "#39c1d4", accent: "#8fe6f2", white: WHITE } },
  { key: "chest", label: "宝箱", test: /宝箱|箱|chest|宝盒/, draw: drawChest, palette: { main: "#8b5a2b", accent: "#c9a227", white: WHITE } },
  { key: "tree", label: "树", test: /树|tree|森林|植物/, draw: drawTree, palette: { main: "#3f8f45", accent: "#6b4423", white: WHITE } },
  { key: "mushroom", label: "蘑菇", test: /蘑菇|mushroom|菇/, draw: drawMushroom, palette: { main: "#d94f4f", accent: "#f3e7d3", white: WHITE } },
  { key: "star", label: "星星", test: /星|star|闪光/, draw: drawStar, palette: { main: "#f6c343", accent: "#ffe9a3", white: WHITE } },
  { key: "heart", label: "爱心", test: /心|heart|生命/, draw: drawHeart, palette: { main: "#e34b62", accent: "#ff9aae", white: WHITE } },
  { key: "coin", label: "金币", test: /金币|硬币|coin|钱|gold/, draw: drawCoin, palette: { main: "#f0b429", accent: "#8a5a2b", white: WHITE } },
  { key: "spark", label: "特效", test: /特效|光效|火花|爆炸|闪光|魔法|effect|spark|burst|fire|火焰|闪电/, draw: drawSpark, palette: { main: "#f6a13c", accent: "#e3533c", white: WHITE } },
];

/** 从文本识别主体配方 */
export function detectSubject(text) {
  const t = String(text || "").toLowerCase();
  for (const r of SUBJECT_RECIPES) if (r.test.test(t)) return r;
  return null;
}

/** 配方 key 列表（给工具描述/技能文档用） */
export function recipeKeys() {
  return SUBJECT_RECIPES.map((r) => ({ key: r.key, label: r.label }));
}

/** 配方调色板（可被调用方覆盖） */
export function paletteFor(key, overrides = {}) {
  const rec = SUBJECT_RECIPES.find((r) => r.key === key) || null;
  return { ...(rec?.palette || { main: "#3b82f6", accent: "#f59e0b", white: WHITE }), dark: DARK, ...overrides };
}

/**
 * 把一个配方画进目标画板（cv: { w, h, blendPx(x,y,r,g,b,a) }）。
 * 配方在方块画布上栅格化，然后居中贴到目标画板（目标非方形时按短边取方形区域）。
 * @param {{w:number,h:number,setPx:Function}} cv
 * @param {string} key 配方 key（也接受中文/label，走 detectSubject 兜底）
 * @param {object} overrides 覆盖调色板（main/accent/white）
 * @param {{x?:number,y?:number,size?:number,symmetry?:boolean}} opts
 * @returns {boolean} 是否画了（key 无法识别时 false）
 */
export function drawRecipeInto(cv, key, overrides = {}, opts = {}) {
  const rec = SUBJECT_RECIPES.find((r) => r.key === String(key || "").toLowerCase()) || detectSubject(key);
  if (!rec) return false;
  // 风景类配方天生是宽幅（天空/地平线/倒影需要横向空间），且必须铺满整个画布；
  // 精灵类配方是一个居中主体，画在方形区域再贴到中心。
  const isScene = rec.scene === true || SCENE_KEYS.has(rec.key);
  let rw;
  let rh;
  if (isScene && opts.size == null) {
    // 铺满整张目标画布（不考虑 x/y —— 风景就是整张图）
    rw = cv.w;
    rh = cv.h;
  } else {
    const area = Math.max(4, Math.round(opts.size || Math.min(cv.w, cv.h)));
    rw = Math.max(4, Math.min(1024, area));
    rh = rw;
  }
  const c = makeCanvas(rw, rh);
  rec.draw(c, paletteFor(rec.key, overrides));
  // x/y 默认是配方主体的中心点（跟 part 一致，避免「以为在中间其实歪到角落」）
  const topLeft = String(opts.origin || "").toLowerCase() === "top-left";
  const ox = Math.round((opts.x ?? cv.w / 2) - (topLeft ? 0 : rw / 2));
  const oy = Math.round((opts.y ?? cv.h / 2) - (topLeft ? 0 : rh / 2));
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4;
      if (c.data[i + 3] < 8) continue;
      cv.setPx(ox + x, oy + y, rgbStr([c.data[i], c.data[i + 1], c.data[i + 2]]), c.data[i + 3]);
    }
  }
  return true;
}
