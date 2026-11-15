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
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, "0")).join("")}`;
}
function mix(hex, other, t) {
  const a = hexToRgb(hex), b = hexToRgb(other);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

// ---------- 栅格原语 ----------
function makeCanvas(s) {
  return { s, data: new Uint8ClampedArray(s * s * 4) };
}
function setPx(c, x, y, hex, alpha = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.s || y >= c.s) return;
  const [r, g, b] = hexToRgb(hex);
  const i = (y * c.s + x) * 4;
  c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = alpha;
}
function fillEllipse(c, ncx, ncy, nrx, nry, hex) {
  const s = c.s, cx = ncx * (s - 1), cy = ncy * (s - 1);
  const rx = Math.max(0.6, nrx * (s - 1)), ry = Math.max(0.6, nry * (s - 1));
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.0) setPx(c, x, y, hex);
    }
  }
}
function fillRect(c, nx, ny, nw, nh, hex) {
  const s = c.s;
  const x0 = Math.round(nx * (s - 1)), y0 = Math.round(ny * (s - 1));
  const x1 = Math.round((nx + nw) * (s - 1)), y1 = Math.round((ny + nh) * (s - 1));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPx(c, x, y, hex);
}
/** 多边形扫描线填充(偶奇规则),pts 为归一化点 */
function fillPoly(c, pts, hex) {
  const s = c.s;
  const P = pts.map(([x, y]) => [x * (s - 1), y * (s - 1)]);
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
  const s = c.s, cx = ncx * (s - 1), cy = ncy * (s - 1);
  const rx = Math.max(0.7, nrx * (s - 1)), ry = Math.max(0.7, nry * (s - 1));
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
  const s = c.s, src = new Uint8ClampedArray(c.data);
  const opaque = (x, y) => x >= 0 && y >= 0 && x < s && y < s && src[(y * s + x) * 4 + 3] > 8;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (!opaque(x, y)) continue;
      if (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1)) {
        setPx(c, x, y, hex);
      }
    }
  }
}
/** 完全对称化(按左半镜像到右半),保证 enforcement 必过 */
function mirrorX(c) {
  const s = c.s;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < Math.floor(s / 2); x++) {
      const si = (y * s + x) * 4, di = (y * s + (s - 1 - x)) * 4;
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

function drawScene(c, pal) {
  const { main } = pal;
  // 地面
  fillRect(c, 0.0, 0.795, 1.0, 0.205, "#6b8f4e");
  fillRect(c, 0.0, 0.775, 1.0, 0.03, "#87ad63");
  // 远山
  fillPoly(c, [[0.0, 0.80], [0.24, 0.42], [0.47, 0.80]], mix("#7fa6c9", main, 0.35));
  fillPoly(c, [[0.36, 0.80], [0.62, 0.30], [0.88, 0.80]], mix("#6d94bb", main, 0.45));
  fillPoly(c, [[0.60, 0.80], [0.80, 0.50], [1.0, 0.80]], mix("#88b0cf", main, 0.25));
  // 树
  fillRect(c, 0.185, 0.62, 0.055, 0.19, "#5c4023");
  fillEllipse(c, 0.212, 0.575, 0.115, 0.105, "#3f7a3a");
  fillEllipse(c, 0.755, 0.66, 0.10, 0.095, "#4d8a41");
  fillRect(c, 0.735, 0.70, 0.045, 0.11, "#5c4023");
  // 太阳
  fillEllipse(c, 0.845, 0.155, 0.085, 0.085, "#f8d75c");
  // 描边(仅主体感)
  outlineInOpacity(c, 255);
}
function outlineInOpacity() { /* 场景不描边,保留平面感 */ }

// ---------- 主体识别 ----------
export const SUBJECT_RECIPES = [
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
  { key: "scene", label: "场景", test: /场景|背景|地图|风景|scene|landscape|background/, draw: drawScene, palette: { main: "#5b8fc9", accent: "#6b8f4e", white: WHITE } },
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
  const area = Math.max(4, Math.round(opts.size || Math.min(cv.w, cv.h)));
  const s = Math.max(4, Math.min(256, area));
  const c = makeCanvas(s);
  rec.draw(c, paletteFor(rec.key, overrides));
  // x/y 默认是配方主体的中心点（跟 part 一致，避免「以为在中间其实歪到角落」）
  const topLeft = String(opts.origin || "").toLowerCase() === "top-left";
  const ox = Math.round((opts.x ?? cv.w / 2) - (topLeft ? 0 : s / 2));
  const oy = Math.round((opts.y ?? cv.h / 2) - (topLeft ? 0 : s / 2));
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      if (c.data[i + 3] < 8) continue;
      cv.setPx(ox + x, oy + y, `#${[c.data[i], c.data[i + 1], c.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`, c.data[i + 3]);
    }
  }
  return true;
}
