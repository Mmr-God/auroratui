// 部件库（parts）—— 给 AI 的「眼睛/嘴/翅膀/帽子」等小零件。
//
// 为什么要有它：AI 手算坐标画眼睛（1~2 像素）几乎必错，错了还看不出来，
// 于是同一张图一会儿好看一会儿糊。把常见零件做成配方后，AI 只需要
//   {"op":"part","part":"eyes","x":18,"y":24,"size":14}
// 就能得到一对规整的眼睛，再靠 x/y/size 摆位置 —— 从「算像素」变成「拼装」。
//
// 坐标系：每个部件在自己的方块画布（size×size）里用归一化 0..1 定义，
// 放大缩小都不失真；贴到画板时按 (x,y) 左上角定位，可 anchor / flip / 换色。
const DARK = "#1b2029";
const WHITE = "#f7f8fa";

function hexToRgb(hex) {
  const h = String(hex || "#000000").replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ------------------------------------------------------------ 局部栅格助手
function makeLocal(s) {
  return { s, data: new Uint8ClampedArray(s * s * 4) };
}
function put(c, nx, ny, hex, alpha = 255) {
  const s = c.s;
  const x = Math.round(nx * (s - 1));
  const y = Math.round(ny * (s - 1));
  if (x < 0 || y < 0 || x >= s || y >= s) return;
  const [r, g, b] = hexToRgb(hex);
  const i = (y * s + x) * 4;
  c.data[i] = r;
  c.data[i + 1] = g;
  c.data[i + 2] = b;
  c.data[i + 3] = alpha;
}
function ell(c, cx, cy, rx, ry, hex, alpha = 255) {
  const s = c.s;
  const X = cx * (s - 1);
  const Y = cy * (s - 1);
  const RX = Math.max(0.5, rx * (s - 1));
  const RY = Math.max(0.5, ry * (s - 1));
  for (let y = Math.floor(Y - RY); y <= Math.ceil(Y + RY); y++) {
    for (let x = Math.floor(X - RX); x <= Math.ceil(X + RX); x++) {
      const dx = (x - X) / RX;
      const dy = (y - Y) / RY;
      if (dx * dx + dy * dy <= 1.0) put(c, x / (s - 1), y / (s - 1), hex, alpha);
    }
  }
}
function box(c, x, y, w, h, hex, alpha = 255) {
  const s = c.s;
  const x0 = Math.round(x * (s - 1));
  const y0 = Math.round(y * (s - 1));
  const x1 = Math.round((x + w) * (s - 1));
  const y1 = Math.round((y + h) * (s - 1));
  for (let yy = y0; yy < Math.max(y0 + 1, y1); yy++) {
    for (let xx = x0; xx < Math.max(x0 + 1, x1); xx++) put(c, xx / (s - 1), yy / (s - 1), hex, alpha);
  }
}
function poly(c, pts, hex, alpha = 255) {
  const s = c.s;
  const P = pts.map(([x, y]) => [x * (s - 1), y * (s - 1)]);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of P) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < P.length; i++) {
      const [x1, y1] = P[i];
      const [x2, y2] = P[(i + 1) % P.length];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.floor(xs[k]); x <= Math.ceil(xs[k + 1]); x++) {
        if (x >= xs[k] - 0.5 && x <= xs[k + 1] + 0.5) put(c, x / (s - 1), y / (s - 1), hex, alpha);
      }
    }
  }
}
function seg(c, x1, y1, x2, y2, hex, alpha = 255, thick = 1) {
  const s = c.s;
  const steps = Math.max(2, Math.round(Math.hypot((x2 - x1) * s, (y2 - y1) * s) * 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (thick <= 1) put(c, x, y, hex, alpha);
    else {
      const r = (thick - 1) / 2 / s;
      for (let dy = -thick; dy <= thick; dy++) for (let dx = -thick; dx <= thick; dx++) {
        if (dx * dx + dy * dy > thick * thick) continue;
        put(c, x + dx / s, y + dy / s, hex, alpha);
      }
    }
  }
}
/** 圆弧（归一化）；t0..t1 是角度（0=右，90=下） */
function arc(c, cx, cy, rx, ry, t0, t1, hex, alpha = 255, thick = 0.06) {
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const a = ((t0 + ((t1 - t0) * i) / steps) * Math.PI) / 180;
    const x = cx + Math.cos(a) * rx;
    const y = cy + Math.sin(a) * ry;
    if (thick <= 0.07) put(c, x, y, hex, alpha);
    else ell(c, x, y, thick / 2, thick / 2, hex, alpha);
  }
}
/** 左右镜像（只画左半边，右半边自动复制） */
function mirrorX(c) {
  const s = c.s;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < Math.floor(s / 2); x++) {
      const si = (y * s + x) * 4;
      const di = (y * s + (s - 1 - x)) * 4;
      if (c.data[si + 3] < 8) continue;
      for (let k = 0; k < 4; k++) c.data[di + k] = c.data[si + k];
    }
  }
}

// ------------------------------------------------------------------- 部件
// 每个部件：draw(c, p) 在归一化方块里作画；sym=true 时自动左右镜像。
// p 是调色板：main / accent / white / dark / skin；部件自己的 palette 是默认值，
// 可被 op 里的 color/accent 覆盖（缺省时绝不能用黑色——那是「没上色」不是「黑色」）。
const DEFAULT_PAL = { main: "#3b82f6", accent: "#f0a6b4" };
const P = (part, over = {}) => {
  const base = part.palette || {};
  return {
    main: over.main || base.main || DEFAULT_PAL.main,
    accent: over.accent || base.accent || DEFAULT_PAL.accent,
    white: WHITE,
    dark: DARK,
    skin: "#f3c39a",
  };
};

export const PARTS = [
  {
    key: "eyes",
    label: "眼睛",
    hint: "默认圆眼（白底+瞳孔+高光）；variant: dot/round/sleepy/angry/closed/wink/sparkle，size 决定眼睛整体宽度",
    variants: ["round", "dot", "sleepy", "angry", "closed", "wink", "sparkle"],
    sym: true,
    // 不传 x/y 时：水平居中，纵向落在主体 42% 高度（脸的位置）
    auto: { ax: 0.5, ay: 0.42 },
    draw(c, p, v) {
      const cx = 0.27;
      const cy = 0.5;
      if (v === "dot") {
        ell(c, cx, cy, 0.085, 0.1, p.dark);
        put(c, cx - 0.02, cy - 0.04, p.white);
        return;
      }
      if (v === "sleepy") {
        box(c, 0.1, 0.46, 0.32, 0.08, p.dark);
        return;
      }
      if (v === "closed") {
        arc(c, cx, cy - 0.06, 0.14, 0.14, 20, 160, p.dark, 255, 0.09);
        return;
      }
      if (v === "angry") {
        // 怒目：内侧压低粗眉 + 下方小瞳孔
        poly(c, [[0.08, 0.24], [0.46, 0.4], [0.46, 0.5], [0.08, 0.36]], p.dark);
        ell(c, 0.28, 0.62, 0.11, 0.1, p.dark);
        put(c, 0.25, 0.6, p.white);
        return;
      }
      // round / sparkle：白眼底要比瞳孔大一圈，否则两种颜色糊成一团黑
      if (v === "wink") {
        // 左眼睁开、右眼闭上 —— 不对称，不能镜像（见 drawPartInto）
        ell(c, 0.24, cy, 0.21, 0.24, p.white);
        ell(c, 0.26, cy + 0.02, 0.11, 0.13, p.dark);
        put(c, 0.2, cy - 0.09, p.white);
        arc(c, 0.76, cy - 0.04, 0.16, 0.16, 25, 155, p.dark, 255, 0.1);
        return "no_mirror";
      }
      ell(c, cx, cy, 0.21, 0.24, p.white);
      ell(c, cx + 0.02, cy + 0.02, 0.11, 0.13, p.dark);
      put(c, cx - 0.09, cy - 0.09, p.white);
      put(c, cx - 0.08, cy - 0.08, p.white);
      if (v === "sparkle") put(c, cx + 0.12, cy + 0.13, p.white, 230);
    },
  },
  {
    key: "mouth",
    label: "嘴",
    hint: "variant: smile/cat/open/grin；cat 是 ω 猫嘴，open 带口腔",
    variants: ["smile", "cat", "open", "grin"],
    sym: true,
    auto: { ax: 0.5, ay: 0.68 },
    draw(c, p, v) {
      const cx = 0.5;
      const cy = 0.5;
      if (v === "cat") {
        arc(c, cx - 0.1, cy - 0.04, 0.1, 0.1, 20, 160, p.dark, 255, 0.08);
        return;
      }
      if (v === "open") {
        ell(c, cx, cy, 0.2, 0.16, p.dark);
        ell(c, cx, cy + 0.04, 0.12, 0.07, "#e0687f");
        return;
      }
      if (v === "grin") {
        // 咧齿笑：黑边 + 上排白牙，牙不盖满不然看着就是一块白
        box(c, 0.2, cy - 0.14, 0.6, 0.34, p.dark);
        box(c, 0.23, cy - 0.11, 0.54, 0.16, p.white);
        seg(c, 0.37, cy - 0.12, 0.37, cy + 0.06, p.dark);
        seg(c, 0.5, cy - 0.12, 0.5, cy + 0.06, p.dark);
        seg(c, 0.63, cy - 0.12, 0.63, cy + 0.06, p.dark);
        return;
      }
      arc(c, cx, cy - 0.12, 0.2, 0.18, 25, 155, p.dark, 255, 0.08);
    },
  },
  {
    key: "blush",
    label: "腮红",
    hint: "两团半透明粉色腮红，常配 eyes 一起用",
    palette: { main: "#f08fa8", accent: "#f08fa8" },
    sym: true,
    auto: { ax: 0.5, ay: 0.56 },
    draw(c, p) {
      ell(c, 0.27, 0.5, 0.15, 0.1, p.accent || "#f08fa8", 150);
    },
  },
  {
    key: "nose",
    label: "鼻子",
    hint: "小三角鼻（猫/狗），默认粉色",
    palette: { main: "#f08fa8", accent: "#f08fa8" },
    sym: true,
    auto: { ax: 0.5, ay: 0.56 },
    draw(c, p) {
      poly(c, [[0.4, 0.4], [0.6, 0.4], [0.5, 0.62]], p.accent || "#f08fa8");
    },
  },
  {
    key: "fang",
    label: "小尖牙",
    hint: "从嘴角露出的两颗小牙（默认白色，可 color 改）",
    palette: { main: "#ffffff", accent: "#ffffff" },
    sym: true,
    auto: { ax: 0.5, ay: 0.72 },
    draw(c, p) {
      poly(c, [[0.26, 0.16], [0.46, 0.16], [0.36, 0.86]], p.white);
    },
  },
  {
    key: "ears",
    label: "猫耳",
    hint: "variant: cat/bear/fox；贴在头顶，外耳 main + 内耳 accent",
    variants: ["cat", "bear", "fox"],
    palette: { main: "#e8a33d", accent: "#f0a6b4" },
    sym: true,
    // 耳朵画在部件画布的底部，所以「底边贴主体顶」而不是用纵向比例
    auto: { ax: 0.5, ay: 0.16, hang: "bottom" },
    draw(c, p, v) {
      if (v === "bear") {
        ell(c, 0.26, 0.42, 0.24, 0.24, p.main);
        ell(c, 0.26, 0.42, 0.12, 0.12, p.accent || "#f0a6b4");
        return;
      }
      const w = v === "fox" ? 0.34 : 0.3;
      // 只画「左耳」，右耳交给 mirrorX 生成；否则镜像后两只耳会叠成一个大方块
      poly(c, [[0.5 - w, 0.98], [0.5 - w * 0.5, 0.12], [0.5 - 0.05, 0.12], [0.5 - 0.04, 0.95]], p.main);
      // 内耳：居中偏上的小三角（不是一直到底的长条）
      poly(c, [[0.5 - w * 0.68, 0.84], [0.5 - w * 0.42, 0.34], [0.5 - w * 0.16, 0.84]], p.accent || "#f0a6b4");
    },
  },
  {
    key: "horn",
    label: "角",
    hint: "一对尖角（恶魔/龙），variant: single 时只画一个居中的",
    variants: ["pair", "single"],
    palette: { main: "#e8e0cf", accent: "#e8e0cf" },
    sym: true,
    auto: { ax: 0.5, ay: 0.14 },
    draw(c, p, v) {
      if (v === "single") {
        poly(c, [[0.34, 0.95], [0.5, 0.06], [0.66, 0.95]], p.accent || "#e8e0cf");
        return;
      }
      poly(c, [[0.06, 0.95], [0.24, 0.1], [0.44, 0.95]], p.accent || "#e8e0cf");
    },
  },
  {
    key: "wings",
    label: "翅膀",
    hint: "variant: feather/bat/small；feather 为三片羽毛，bat 为膜翼",
    variants: ["feather", "bat", "small"],
    palette: { main: "#f4f7fb", accent: "#8fa4c0" },
    sym: true,
    auto: { ax: 0.5, ay: 0.45 },
    draw(c, p, v) {
      if (v === "bat") {
        poly(c, [[0.5, 0.42], [0.04, 0.2], [0.12, 0.62], [0.26, 0.5], [0.3, 0.85], [0.5, 0.68]], p.main);
        seg(c, 0.5, 0.5, 0.1, 0.32, p.accent, 255, 0.5);
        seg(c, 0.46, 0.62, 0.16, 0.55, p.accent, 255, 0.4);
        return;
      }
      if (v === "small") {
        ell(c, 0.34, 0.5, 0.2, 0.14, p.main);
        ell(c, 0.3, 0.44, 0.09, 0.06, p.accent);
        return;
      }
      poly(c, [[0.5, 0.5], [0.08, 0.16], [0.02, 0.5], [0.2, 0.86], [0.5, 0.72]], p.main);
      seg(c, 0.46, 0.5, 0.1, 0.3, p.accent, 255, 0.42);
      seg(c, 0.46, 0.58, 0.08, 0.5, p.accent, 255, 0.42);
      seg(c, 0.44, 0.66, 0.14, 0.76, p.accent, 255, 0.42);
    },
  },
  {
    key: "crown",
    label: "皇冠",
    hint: "三尖皇冠，默认金色，带宝石",
    palette: { main: "#f0b429", accent: "#c98a17" },
    sym: true,
    auto: { ax: 0.5, ay: 0.02, hang: "bottom" },
    draw(c, p) {
      const gold = p.main || "#f0b429";
      poly(c, [[0.06, 0.86], [0.06, 0.3], [0.26, 0.56], [0.5, 0.16], [0.74, 0.56], [0.94, 0.3], [0.94, 0.86]], gold);
      box(c, 0.06, 0.72, 0.88, 0.14, p.accent || "#c98a17");
      ell(c, 0.5, 0.5, 0.06, 0.06, "#e14b6a");
    },
  },
  {
    key: "hat",
    label: "帽子",
    hint: "variant: wizard/straw/top；wizard 尖顶法师帽，straw 草帽，top 礼帽",
    variants: ["wizard", "straw", "top"],
    palette: { main: "#4f5bd5", accent: "#3a44a8" },
    sym: true,
    auto: { ax: 0.5, ay: 0.02, hang: "bottom" },
    draw(c, p, v) {
      const main = p.main || "#4f5bd5";
      if (v === "straw") {
        ell(c, 0.5, 0.74, 0.48, 0.16, p.accent || "#d9b45c");
        ell(c, 0.5, 0.6, 0.24, 0.24, p.accent || "#d9b45c");
        box(c, 0.26, 0.58, 0.48, 0.1, main);
        return;
      }
      if (v === "top") {
        box(c, 0.16, 0.7, 0.68, 0.1, DARK);
        box(c, 0.3, 0.14, 0.4, 0.6, main);
        box(c, 0.3, 0.56, 0.4, 0.1, p.accent || "#8a2b3a");
        return;
      }
      poly(c, [[0.5, 0.04], [0.74, 0.7], [0.26, 0.7]], main);
      ell(c, 0.5, 0.74, 0.44, 0.12, p.accent || main);
      ell(c, 0.5, 0.44, 0.05, 0.05, "#ffe9a3");
    },
  },
  {
    key: "tail",
    label: "尾巴",
    hint: "向右上翘的尾巴（不对称），flip:true 可翻到左边",
    palette: { main: "#e8a33d", accent: "#c9842c" },
    sym: false,
    auto: { ax: 0.78, ay: 0.62 },
    draw(c, p) {
      arc(c, 0.36, 0.5, 0.3, 0.32, -110, 30, p.main, 255, 0.22);
      ell(c, 0.62, 0.28, 0.1, 0.1, p.accent || p.main);
    },
  },
  {
    key: "shadow",
    label: "地面阴影",
    hint: "半透明椭圆投影，垫在脚下让人物站稳",
    palette: { main: "#000000", accent: "#000000" },
    sym: true,
    auto: { ax: 0.5, ay: 0.94 },
    draw(c) {
      ell(c, 0.5, 0.62, 0.5, 0.26, "#000000", 70);
      ell(c, 0.5, 0.6, 0.32, 0.15, "#000000", 55);
    },
  },
  {
    key: "shine",
    label: "高光",
    hint: "斜向白色高光条，给球体/宝石/金属加体积感（按底色提亮，不会盖住渐变）",
    palette: { main: "#ffffff", accent: "#ffffff" },
    sym: false,
    blend: "lighten",
    auto: { ax: 0.42, ay: 0.28 },
    draw(c, p) {
      seg(c, 0.2, 0.44, 0.52, 0.16, p.white, 190, 0.8);
      seg(c, 0.44, 0.5, 0.62, 0.34, p.white, 130, 0.6);
    },
  },
  {
    key: "sparkle",
    label: "闪光",
    hint: "三颗小星星，用于魔法/特效点缀",
    palette: { main: "#ffe9a3", accent: "#ffe9a3" },
    sym: false,
    auto: { ax: 0.7, ay: 0.3 },
    draw(c, p) {
      const star = (cx, cy, r) => {
        poly(c, [[cx, cy - r], [cx + r * 0.35, cy - r * 0.35], [cx + r, cy], [cx + r * 0.35, cy + r * 0.35], [cx, cy + r], [cx - r * 0.35, cy + r * 0.35], [cx - r, cy], [cx - r * 0.35, cy - r * 0.35]], p.accent || "#ffe9a3");
      };
      star(0.28, 0.3, 0.22);
      star(0.72, 0.46, 0.14);
      star(0.5, 0.8, 0.1);
    },
  },
  {
    key: "scarf",
    label: "围巾",
    hint: "绕脖一圈 + 一条垂下，适合戴在人形主体上",
    palette: { main: "#e14b6a", accent: "#a82b45" },
    sym: false,
    auto: { ax: 0.5, ay: 0.74 },
    draw(c, p) {
      const main = p.main || "#e14b6a";
      box(c, 0.1, 0.36, 0.8, 0.2, main);
      box(c, 0.52, 0.52, 0.2, 0.42, main);
      box(c, 0.52, 0.84, 0.24, 0.1, p.accent || "#a82b45");
      box(c, 0.1, 0.44, 0.8, 0.06, p.accent || "#a82b45");
    },
  },
  {
    key: "halo",
    label: "光环",
    hint: "头顶金色圆环（天使/圣物）",
    palette: { main: "#ffe9a3", accent: "#f0b429" },
    sym: true,
    auto: { ax: 0.5, ay: 0.02, hang: "bottom" },
    draw(c, p) {
      arc(c, 0.5, 0.5, 0.44, 0.16, 0, 360, p.main || "#ffe9a3", 255, 0.1);
    },
  },
  {
    key: "collar",
    label: "项圈",
    hint: "深色项圈 + 中央宝石（宠物/骑士）",
    palette: { main: "#8a5a2b", accent: "#f0b429" },
    sym: true,
    auto: { ax: 0.5, ay: 0.78 },
    draw(c, p) {
      box(c, 0.08, 0.32, 0.84, 0.16, p.main || "#8a5a2b");
      ell(c, 0.5, 0.6, 0.08, 0.08, p.accent || "#f0b429");
    },
  },
];

export const PART_KEYS = PARTS.map((r) => r.key);

/** 别名：模型可能写 eye/mouths/wing/hats 这些 */
const ALIAS = {
  eye: "eyes",
  eyeball: "eyes",
  mouths: "mouth",
  cheek: "blush",
  cheeks: "blush",
  blushs: "blush",
  ear: "ears",
  horns: "horn",
  wing: "wings",
  tails: "tail",
  shadows: "shadow",
  highlights: "shine",
  highlight: "shine",
  glint: "shine",
  stars: "sparkle",
  sparks: "sparkle",
  scarfs: "scarf",
  neck: "collar",
  ring: "halo",
};

export function findPart(key) {
  const k = String(key || "").trim().toLowerCase();
  const hit = PARTS.find((r) => r.key === k) || PARTS.find((r) => (ALIAS[k] || k) === r.key);
  return hit || null;
}

/** 部件清单（给工具描述用）：eyes(round/dot/…) */
export function partKeys() {
  return PARTS.map((r) => ({ key: r.key, label: r.label, variants: r.variants || [] }));
}

/**
 * 把一个部件画进目标画板。
 * @param {{w:number,h:number,setPx:Function}} cv
 * @param {string} key 部件名（见 PARTS，支持别名）
 * @param {{x?:number,y?:number,size?:number,variant?:string,color?:string,accent?:string,flip?:boolean,origin?:string}} opts
 *        x/y 默认是部件中心；不带 x/y 时按 part.auto 自动贴到主体（眼睛在脸、帽子在头顶）
 * @returns {boolean}
 */
export function drawPartInto(cv, key, opts = {}) {
  const part = findPart(key);
  if (!part) return false;
  const area = Math.max(4, Math.min(256, Math.round(Number(opts.size) || Math.min(cv.w, cv.h))));
  const c = makeLocal(area);
  const pal = P(part, { main: opts.color, accent: opts.accent });
  // 部件自己可以拒绝镜像（如 wink：左眼睁开、右眼闭上）
  const mirrored = part.draw(c, pal, String(opts.variant || "").toLowerCase()) !== "no_mirror";
  if (part.sym && mirrored) mirrorX(c);
  if (opts.flip) {
    // 水平翻转（不对称部件换朝向）
    for (let y = 0; y < area; y++) {
      for (let x = 0; x < Math.floor(area / 2); x++) {
        const a = (y * area + x) * 4;
        const b = (y * area + (area - 1 - x)) * 4;
        for (let k = 0; k < 4; k++) {
          const t = c.data[a + k];
          c.data[a + k] = c.data[b + k];
          c.data[b + k] = t;
        }
      }
    }
  }
  // x/y 默认是部件中心点（画眼睛时最直觉）；给 origin:'top-left' 则按旧语义当左上角
  const topLeft = String(opts.origin || '').toLowerCase() === 'top-left';
  // 没传 x/y 时按「部件性格」自动贴到主体上：眼睛在脸、帽子在头顶、影子在脚下。
  // 之前默认整张画布居中，帽子会卡在脸中间，照样得看图手调。
  let defX = cv.w / 2;
  let defY = cv.h / 2;
  if (part.auto) {
    const box = typeof cv.bbox === 'function' ? cv.bbox() : null;
    if (box && box.w > 0 && box.h > 0) {
      defX = box.minX + box.w * part.auto.ax;
      defY = box.minY + box.h * part.auto.ay;
      // hang:'bottom' —— 部件的底边对齐主体顶部（帽子/光环/耳朵这类「戴在头上」的）
      if (part.auto.hang === 'bottom') {
        // 头顶可能已经戴了东西（耳朵/先贴的帽子）：不能再贴主体顶，要接着往上堆，
        // 否则两件同一落点的部件会完全重叠。向上张望主体顶以上的已有内容。
        let top = box.minY;
        for (let y = box.minY - 1; y >= 0; y--) {
          let rowHas = false;
          for (let x = 0; x < cv.w; x++) {
            if (cv.a(x, y) > 8) { rowHas = true; break; }
          }
          if (!rowHas) break;
          top = y;
        }
        defY = top - area / 2 + 2;
      }
    }
  }
  const ox = Math.round(Number(opts.x ?? defX) - (topLeft ? 0 : area / 2));
  const oy = Math.round(Number(opts.y ?? defY) - (topLeft ? 0 : area / 2));
  // 半透明部件（腮红/地影/高光）交给 setPx 的 auto 模式：彩色叠彩色走 hue
  // （否则粉腮红叠在绿身上会变成灰），黑/灰阴影仍走普通叠色（该压暗就压暗）。
  // 不透明像素不受影响。
  // 但高光（shine/sparkle）例外：它需要按底色「提亮」而不是刷平色，否则会在
  // auto_shade 的渐变上贴一块硬补丁。部件可以用 blend:'lighten' 声明。
  const blend = part.blend || "auto";
  for (let y = 0; y < area; y++) {
    for (let x = 0; x < area; x++) {
      const i = (y * area + x) * 4;
      const a = c.data[i + 3];
      if (a < 8) continue;
      const hex = `#${[c.data[i], c.data[i + 1], c.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      cv.setPx(ox + x, oy + y, hex, a, blend);
    }
  }
  return true;
}
