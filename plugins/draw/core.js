// 像素画板内核：PNG 编码、颜色换算、栅格化操作、诊断统计。
// 纯 Node 实现，不依赖 sharp / canvas / node_modules。
// 设计来自 pixel-forge（D:\Works\Mader\pixel-forge\server\src\tools\canvas.js）：
// AI 只输出「短小的绘图操作」，本地栅格化成像素，再编码成 PNG 交给模型自己看。
import zlib from 'node:zlib';

// ---------------------------------------------------------------- PNG 编码
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
/**
 * 逐行选最优 PNG 过滤（none / Sub / Up）。
 * 只用 filter:none 时 1024×1024 的渐变天空体积很大 —— base64 塞进对话直接顶爆
 * 上下文，还会撞 3MB 内联上限。像素画大面积同色/渐变，Up 过滤能把每行压成
 * 一片 0，文件小一个数量级；代价是每行多算两轮绝对值求和。
 * （Paeth 收益更高但要多算 5 组，对 1024 来说这个折中刚好。）
 */
function rawRgba(w, h, rgba) {
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  const zero = Buffer.alloc(stride);
  const sub = Buffer.alloc(stride);
  const up = Buffer.alloc(stride);
  let prev = zero;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let sSub = 0;
    let sUp = 0;
    for (let i = 0; i < stride; i++) {
      const cur = rgba[row + i];
      const left = i >= bpp ? rgba[row + i - bpp] : 0;
      const vSub = (cur - left) & 0xff;
      const vUp = (cur - prev[i]) & 0xff;
      sub[i] = vSub;
      up[i] = vUp;
      // 过滤后的字节按 int8 解释，越接近 0 越好压
      sSub += vSub < 128 ? vSub : 256 - vSub;
      sUp += vUp < 128 ? vUp : 256 - vUp;
    }
    const off = y * (stride + 1);
    // 只有明显更优才换过滤类型，否则按 none 走（省掉一次 memcpy）
    const pick = sUp <= sSub && sUp < stride * 6 ? 2 : sSub < stride * 6 ? 1 : 0;
    out[off] = pick;
    if (pick === 1) out.set(sub, off + 1);
    else if (pick === 2) out.set(up, off + 1);
    else for (let i = 0; i < stride; i++) out[off + 1 + i] = rgba[row + i];
    prev = rgba.subarray(row, row + stride);
  }
  return out;
}
/** RGBA 像素缓冲 -> PNG Buffer */
export function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 大图降到 level 6：1024×1024 用 level 9 要压近 1s，而体积只差几个百分点
  const level = w * h > 262144 ? 6 : 9;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawRgba(w, h, rgba), { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** 最近邻放大（像素画放大后边缘依然硬，适合人眼/模型观察） */
export function encodePngScaled(w, h, rgba, scale = 1) {
  // 放大后总边长封顶 4096：1024 的画板再 ×8 就是 8192²，缓冲直接吃掉 256MB
  const cap = Math.max(1, Math.floor(4096 / Math.max(1, Math.max(w, h))));
  const s = Math.max(1, Math.min(16, cap, Math.round(scale)));
  if (s === 1) return encodePng(w, h, rgba);
  const W = w * s;
  const H = h * s;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / s);
    const srow = sy * w * 4;
    const drow = y * W * 4;
    for (let x = 0; x < W; x++) {
      const si = srow + Math.floor(x / s) * 4;
      const di = drow + x * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return encodePng(W, H, out);
}

// ------------------------------------------------------------- 程序化噪声
// 大画布风景靠「手摆坐标」不可能画出来：山脊、云、雾、水纹是几万到几十万像素，
// 必须让程序生成。这里是一套确定性的 value noise / fbm —— 同一个 seed 永远得到
// 同一座山，所以「看着不对就换 seed/换参数」是可复现的迭代，而不是每改一次
// 整幅画就重掷一次骰子。
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
const smooth = (t) => t * t * (3 - 2 * t);
/** 一维 value noise（地形高度场：每列一个高度） */
export function noise1(x, seed = 1) {
  const i = Math.floor(x);
  const t = smooth(x - i);
  const a = hash1(i, seed);
  return a + (hash1(i + 1, seed) - a) * t;
}
/** 一维分形噪声：octaves 越多细节越丰富；roughness 决定细节占比 */
export function fbm1(x, seed = 1, octaves = 4, roughness = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(x * f, seed + o * 1013) * amp;
    norm += amp;
    amp *= roughness;
    f *= 2;
  }
  return norm ? sum / norm : 0;
}
/** 二维 value noise（云、雾、水纹、岩石纹理） */
export function noise2(x, y, seed = 1) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}
export function fbm2(x, y, seed = 1, octaves = 4, roughness = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * f, y * f, seed + o * 1013) * amp;
    norm += amp;
    amp *= roughness;
    f *= 2;
  }
  return norm ? sum / norm : 0;
}
/** 山脊噪声：1-|2n-1| 出尖峰，再叠加出锯齿，做远山轮廓非常好用 */
export function ridged1(x, seed = 1, octaves = 4, roughness = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = noise1(x * f, seed + o * 1013);
    sum += (1 - Math.abs(2 * n - 1)) * amp;
    norm += amp;
    amp *= roughness;
    f *= 2;
  }
  return norm ? sum / norm : 0;
}
/** 确定性伪随机序列（噪点/抖动用；不依赖 Math.random 才能复现同一张图） */
export function makeRng(seed = 12345) {
  let s = (Math.abs(Math.round(seed)) || 1) % 2147483647;
  return () => {
    s = (Math.imul(s, 48271) % 2147483647 + 2147483647) % 2147483647;
    return s / 2147483647;
  };
}

// ------------------------------------------------------------------ 颜色
const NAMED = {
  black: '#000000', white: '#ffffff', red: '#e74c3c', green: '#2ecc71', blue: '#3498db',
  yellow: '#f1c40f', orange: '#e67e22', purple: '#9b59b6', pink: '#ff9ff3', brown: '#8b5a2b',
  gray: '#95a5a6', grey: '#95a5a6', dark: '#2c3e50', light: '#ecf0f1', cyan: '#1abc9c',
  magenta: '#e91e63', gold: '#f0b429', navy: '#22314e', sand: '#e3d5b0', skin: '#f0c8a0',
  sky: '#8fc6ef', grass: '#5ca24a', wood: '#8b5a2b', steel: '#9fb3c8', blood: '#a32638',
};
export function resolveColor(hex, fallback = '#000000') {
  let h = String(hex ?? '').trim().replace(/^#/, '');
  if (NAMED[h.toLowerCase()]) h = NAMED[h.toLowerCase()].slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    const f = String(fallback).replace(/^#/, '');
    h = /^[0-9a-fA-F]{6}$/.test(f) ? f : '000000';
  }
  return '#' + h.toLowerCase();
}
/**
 * 拆出「带 alpha 的颜色」：#rrggbbaa / #rgba 里的 alpha。
 * 模型很爱写 #00000055 表示半透明阴影，以前会被 resolveColor 当非法值退回成纯黑，
 * 于是「阴影」变成一块死黑 —— 静默画错最难查，所以这里显式支持。
 * 返回 { hex:'#rrggbb', alpha:0..255|null }，不是 8/4 位就 alpha=null。
 */
export function splitAlpha(v) {
  const s = String(v ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{8}$/.test(s)) {
    return { hex: '#' + s.slice(0, 6).toLowerCase(), alpha: parseInt(s.slice(6), 16) };
  }
  if (/^[0-9a-fA-F]{4}$/.test(s)) {
    const [r, g, b, a] = s.toLowerCase().split('');
    return { hex: `#${r}${r}${g}${g}${b}${b}`, alpha: parseInt(a + a, 16) };
  }
  return { hex: resolveColor(v), alpha: null };
}
export function hexToRgb(hex) {
  const h = resolveColor(hex).slice(1);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function toHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
/** k>1 变亮，k<1 变暗 */
export function shade(hex, k) {
  return toHex(hexToRgb(hex).map((v) => v * k));
}
/** 线性混合：t=0 取 a，t=1 取 b */
export function mix(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}
function lum(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
/** RGB(0..255) → HSL（h 0..1, s 0..1, l 0..1） */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}
/** HSL（都是 0..1）→ RGB(0..255) */
export function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
}

// ------------------------------------------------------------------ 画板
export class Canvas {
  constructor(w, h) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
    this.pen = { x: Math.floor(this.w / 2), y: Math.floor(this.h / 2) };
    /** 选区 {x,y,w,h}；null = 全画布。setPx 会自动裁掉区外像素 */
    this.sel = null;
  }
  clone() {
    const c = new Canvas(this.w, this.h);
    c.data.set(this.data);
    c.pen = { ...this.pen };
    c.sel = this.sel ? { ...this.sel } : null;
    return c;
  }
  /** 画点（alpha<255 时按 alpha 混合，便于做阴影/高光） */
  setPx(x, y, hex, alpha = 255, mode = 'auto') {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    // 选区：区外一律不画（选中一块就能安全地改局部）
    if (this.sel) {
      const s = this.sel;
      if (x < s.x || y < s.y || x >= s.x + s.w || y >= s.y + s.h) return;
    }
    const [r, g, b] = hexToRgb(hex);
    const i = (y * this.w + x) * 4;
    const a = Math.max(0, Math.min(255, Math.round(alpha)));
    if (a <= 0) return;
    const da0 = this.data[i + 3] / 255;
    // lighten / darken 都必须先于「alpha=255 直接覆盖」的短路：它们是
    // 「按底色提亮/压暗」，不传 alpha（默认 255）时也得生效。
    // 但底色是透明的（透明像素上画）时没有可调整的颜色，退化成普通绘制，
    // 否则 rgbToHsl(0,0,0) 会把 high 光画成白块、阴影画成黑块。
    const onSolid = da0 > 0.02;
    if (mode === 'lighten' && onSolid) {
      // 用底色自己的色相，只把亮度往上推：高光与渐变同色系、不会突兀。
      // 两处调过：
      //  - 饱和度不能大幅降（紫底 s=0.92 降一半就变灰白，像块脏抹布）；
      //    但也不能完全不动，否则只是「更亮的同色」，看不出是高光。
      //    降 35% 是折中：颜色还认得出是紫的，但明显发白。
      //  - 亮度要推得够狠：底色本来就亮（0.71）时，只推到 0.85 看不出区别。
      const [h0, s0, l0] = rgbToHsl(this.data[i], this.data[i + 1], this.data[i + 2]);
      const amt = (a / 255) * 0.9;
      const nr = Math.min(0.95, l0 + (1 - l0) * amt);
      const [tr, tg, tb] = hslToRgb(h0, s0 * (1 - amt * 0.4), nr);
      this.data[i] = Math.round(tr);
      this.data[i + 1] = Math.round(tg);
      this.data[i + 2] = Math.round(tb);
      this.data[i + 3] = 255;
      return;
    }
    if (mode === 'darken' && onSolid) {
      // lighten 的反操作：按底色压暗。画布褶/金属暗面/坑滑这类「有色阴影」
      // 直接用它，比盖一层半透明黑干净 —— 半透明黑会把浅色主体洗脏
      // （白底 ＃ffffff 叠 30% 黑 → 灰，看着像脏东西而不是阴影）。
      // 饱和度小幅提升（阴影通常比受光面更浓），亮度往下压。
      const [h0, s0, l0] = rgbToHsl(this.data[i], this.data[i + 1], this.data[i + 2]);
      const amt = (a / 255) * 0.85;
      const nr = Math.max(0.04, l0 * (1 - amt));
      const [tr, tg, tb] = hslToRgb(h0, Math.min(1, s0 * (1 + amt * 0.35)), nr);
      this.data[i] = Math.round(tr);
      this.data[i + 1] = Math.round(tg);
      this.data[i + 2] = Math.round(tb);
      this.data[i + 3] = 255;
      return;
    }
    if (a >= 255) {
      this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255;
      return;
    }
    const t = a / 255;
    const da = this.data[i + 3] / 255;
    const oa = t + da * (1 - t);
    if (oa <= 0) return;
    // 半透明叠在已有像素上时，选对混合方式很关键（都是真踩过的坑）：
    //  - 彩色半透明（粉腮红、蓝光晕）→ hue：source-over 会把两个互补色
    //    平均成灰色（粉 #f08fa8@150 叠绿 #34d399 → 163,171,162 灰）。
    //    hue 模式取前景的色相/饱和度 + 底色的亮度，颜色仍是粉的，只是变淡。
    //  - 灰阶半透明（黑阴影/白高光）→ 保留 source-over：阴影本来就该把
    //    底色压暗（黑叠绿 → 暗绿），换成 hue 反而会洗成纯灰。
    // 所以按「前景是不是彩色」自动选，调用方不用管。
    const useHue = mode === 'hue'
      || (mode === 'auto' && da > 0.02 && rgbToHsl(r, g, b)[1] > 0.15);
    if (useHue && da > 0.02) {
      const [h1, s1] = rgbToHsl(r, g, b);
      const [, , l0] = rgbToHsl(this.data[i], this.data[i + 1], this.data[i + 2]);
      const [tr, tg, tb] = hslToRgb(h1, s1, l0);
      const k = t * da; // 只盖在已有像素上
      this.data[i] = Math.round(this.data[i] + (tr - this.data[i]) * k);
      this.data[i + 1] = Math.round(this.data[i + 1] + (tg - this.data[i + 1]) * k);
      this.data[i + 2] = Math.round(this.data[i + 2] + (tb - this.data[i + 2]) * k);
      this.data[i + 3] = Math.round(oa * 255);
      return;
    }
    const blend = (sc, dc) => (sc * t + dc * da * (1 - t)) / oa;
    this.data[i] = blend(r, this.data[i]);
    this.data[i + 1] = blend(g, this.data[i + 1]);
    this.data[i + 2] = blend(b, this.data[i + 2]);
    this.data[i + 3] = Math.round(oa * 255);
  }
  getPx(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return { hex: null, a: 0 };
    const i = (y * this.w + x) * 4;
    return { hex: toHex([this.data[i], this.data[i + 1], this.data[i + 2]]), a: this.data[i + 3] };
  }
  a(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[(y * this.w + x) * 4 + 3];
  }
  pixel(x, y, c, alpha) { this.setPx(x, y, c, alpha); }
  line(x1, y1, x2, y2, c, alpha) {
    x1 = Math.round(x1); y1 = Math.round(y1); x2 = Math.round(x2); y2 = Math.round(y2);
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    let x = x1;
    let y = y1;
    for (let g = 0; g < 100000; g++) {
      this.setPx(x, y, c, alpha);
      if (x === x2 && y === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    this.pen = { x: x2, y: y2 };
  }
  fillRect(x, y, w, h, c, alpha, blend = 'auto') {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.setPx(xx, yy, c, alpha, blend);
  }
  rect(x, y, w, h, c, alpha) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w) - 1;
    const y1 = Math.round(y + h) - 1;
    this.line(x0, y0, x1, y0, c, alpha);
    this.line(x0, y1, x1, y1, c, alpha);
    this.line(x0, y0, x0, y1, c, alpha);
    this.line(x1, y0, x1, y1, c, alpha);
  }
  fillEllipse(cx, cy, rx, ry, c, alpha, blend = 'auto') {
    rx = Math.max(0.5, Math.abs(rx));
    ry = Math.max(0.5, Math.abs(ry));
    // 按扫描行求 x 区间，而不是「逐像素判在不在椭圆里」。
    // 逐像素判定（旧写法）在四个轴向总会丢出孤零零 1px 的凸刺，放大 6 倍
    // 看就像轮廓上扎了根刺；而且相邻行宽度可能跳 2 格，弧线断断续续。
    // 按行算区间每行都是连续的，上下行宽度平滑变化，像素圆的经典做法。
    const y0 = Math.round(cy - ry);
    const y1 = Math.round(cy + ry);
    for (let y = y0; y <= y1; y++) {
      const dy = (y - cy) / ry;
      if (Math.abs(dy) > 1) continue;
      const half = rx * Math.sqrt(1 - dy * dy);
      // 端点那行宽度不到 1 像素：画出来就是孤零零一个点，看着像轮廓上的刺，直接跳过
      if (half < 0.5) continue;
      const x0 = Math.round(cx - half);
      const x1 = Math.round(cx + half);
      if (x1 - x0 < 1) continue;
      for (let x = x0; x <= x1; x++) this.setPx(x, y, c, alpha, blend);
    }
  }
  ellipse(cx, cy, rx, ry, c, alpha) {
    const steps = Math.max(16, Math.ceil((Math.abs(rx) + Math.abs(ry)) * 6));
    let px = null;
    let py = null;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * rx);
      const y = Math.round(cy + Math.sin(a) * ry);
      if (px !== null) this.line(px, py, x, y, c, alpha);
      px = x; py = y;
    }
  }
  fillPoly(pts, c, alpha, blend = 'auto') {
    const P = (pts || []).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.x), Number(p.y)]))
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (P.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of P) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
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
          if (x >= xs[k] - 0.5 && x <= xs[k + 1] + 0.5) this.setPx(x, y, c, alpha, blend);
        }
      }
    }
  }
  floodFill(x, y, c, alpha) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const t = this.getPx(x, y);
    const tr = this.data[(y * this.w + x) * 4];
    const tg = this.data[(y * this.w + x) * 4 + 1];
    const tb = this.data[(y * this.w + x) * 4 + 2];
    const ta = this.data[(y * this.w + x) * 4 + 3];
    const target = resolveColor(c);
    if (t.hex === target && alpha >= 255 && ta > 8) return; // 已经是这个颜色
    const same = (i) => this.data[i] === tr && this.data[i + 1] === tg && this.data[i + 2] === tb && this.data[i + 3] === ta;
    const stack = [[x, y]];
    let guard = 0;
    while (stack.length && guard++ < this.w * this.h * 8) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) continue;
      const i = (cy * this.w + cx) * 4;
      if (!same(i)) continue;
      this.setPx(cx, cy, c, alpha);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }
  /**
   * 内描边：把已画区域的边缘 1px 换成描边色（不改变外轮廓尺寸）
   * minAlpha：只给「够实」的像素描边。半透明的地影/腮红本身是柔和过渡，
   * 描一圈实心边会变成一朵硬黑线（之前就是这个问题），所以默认跳过。
   */
  outlineIn(c, minAlpha = 200) {
    const src = new Uint8ClampedArray(this.data);
    const op = (x, y) => x >= 0 && y >= 0 && x < this.w && y < this.h && src[(y * this.w + x) * 4 + 3] >= minAlpha;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!op(x, y)) continue;
        if (!op(x - 1, y) || !op(x + 1, y) || !op(x, y - 1) || !op(x, y + 1)) this.setPx(x, y, c);
      }
    }
  }
  /** 外描边：在已画区域外面加一圈 1px 描边 */
  outlineOut(c, minAlpha = 200) {
    const src = new Uint8ClampedArray(this.data);
    const op = (x, y) => x >= 0 && y >= 0 && x < this.w && y < this.h && src[(y * this.w + x) * 4 + 3] >= minAlpha;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (op(x, y)) continue;
        if (op(x - 1, y) || op(x + 1, y) || op(x, y - 1) || op(x, y + 1)) this.setPx(x, y, c);
      }
    }
  }
  mirrorX() {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < Math.floor(this.w / 2); x++) {
        const si = (y * this.w + x) * 4;
        const di = (y * this.w + (this.w - 1 - x)) * 4;
        const s = this.data[si + 3] > 8 ? si : this.data[di + 3] > 8 ? di : -1;
        if (s < 0) continue;
        for (let k = 0; k < 4; k++) {
          this.data[si + k] = this.data[s + k];
          this.data[di + k] = this.data[s + k];
        }
      }
    }
  }
  mirrorY() {
    for (let x = 0; x < this.w; x++) {
      for (let y = 0; y < Math.floor(this.h / 2); y++) {
        const si = (y * this.w + x) * 4;
        const di = ((this.h - 1 - y) * this.w + x) * 4;
        const s = this.data[si + 3] > 8 ? si : this.data[di + 3] > 8 ? di : -1;
        if (s < 0) continue;
        for (let k = 0; k < 4; k++) {
          this.data[si + k] = this.data[s + k];
          this.data[di + k] = this.data[s + k];
        }
      }
    }
  }
  /**
   * 径向渐变：从中心（或指定圆心）向外从内色逐渐变成外色。
   * 画球体、光晕、气泡、宝石高光比竖向渐变自然得多。
   */
  gradientRadial(cx, cy, rx, ry, inner, outer, alpha = 255) {
    const RX = Math.max(1e-6, rx);
    const RY = Math.max(1e-6, ry);
    const x0 = Math.max(0, Math.round(cx - RX));
    const x1 = Math.min(this.w - 1, Math.round(cx + RX));
    const y0 = Math.max(0, Math.round(cy - RY));
    const y1 = Math.min(this.h - 1, Math.round(cy + RY));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // 归一化椭圆距离：1 = 边界；平方后当 t，中心过渡缓、外部收得快
        const ndx = (x - cx) / RX;
        const ndy = (y - cy) / RY;
        const d = Math.sqrt(ndx * ndx + ndy * ndy);
        if (d > 1) continue;
        this.setPx(x, y, mix(inner, outer, d * d), alpha);
      }
    }
  }
  /**
   * 有序抖动（Bayer 矩阵）：把两个颜色按棋盘格交错，模拟第三档颜色。
   * 像素画里没法用半透明时（导出成不透明 GIF/图标）靠它做渐变过渡。
   */
  dither(x, y, w, h, c1, c2, strength = 0.5, alpha = 255) {
    // Bayer 4x4 矩阵归一化到 0~1，格子越密过渡越细
    const B = [
      [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
    ];
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    const k = Math.max(0, Math.min(1, strength));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const t = B[yy & 3][xx & 3] / 16; // 0~0.9375
        this.setPx(xx, yy, t < k ? c2 : c1, alpha);
      }
    }
  }
  /**
   * 整体色相偏移：主体颜色整体转一个角度（度），做配色变体（红史莱姆 / 蓝史莱姆）。
   * 只动有饱和度的像素，眼白/描边不会跟着跑色。
   */
  hueRotate(deg = 0) {
    const shiftDeg = ((Number(deg) || 0) % 360 + 360) % 360;
    if (!shiftDeg) return;
    for (let i = 0; i < this.data.length; i += 4) {
      if (this.data[i + 3] <= 8) continue;
      const [h, s, l] = rgbToHsl(this.data[i], this.data[i + 1], this.data[i + 2]);
      if (s < 0.02) continue; // 灰白/黑不动，否则眼白和描边会变色
      const [r, g, b] = hslToRgb(((h + shiftDeg / 360) % 1 + 1) % 1, s, l);
      this.data[i] = Math.round(r);
      this.data[i + 1] = Math.round(g);
      this.data[i + 2] = Math.round(b);
    }
  }
  /**
   * 强制左右对称：取左半边镜像到右边（或反过来）。
   * 手画时总有一边胖一点，这个一步抹平；axis: 'right' 取右半边。
   */
  symmetrize(axis = 'left') {
    const fromRight = String(axis).toLowerCase() === 'right';
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < Math.floor(this.w / 2); x++) {
        const sx = fromRight ? this.w - 1 - x : x; // 源
        const dx2 = fromRight ? x : this.w - 1 - x; // 目标
        const si = (y * this.w + sx) * 4;
        const di = (y * this.w + dx2) * 4;
        for (let k = 0; k < 4; k++) this.data[di + k] = this.data[si + k];
      }
    }
  }
  shift(dx, dy) {
    dx = Math.round(dx); dy = Math.round(dy);
    if (!dx && !dy) return;
    const out = new Uint8ClampedArray(this.data.length);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        const si = (y * this.w + x) * 4;
        const di = (ny * this.w + nx) * 4;
        out[di] = this.data[si];
        out[di + 1] = this.data[si + 1];
        out[di + 2] = this.data[si + 2];
        out[di + 3] = this.data[si + 3];
      }
    }
    this.data = out;
    this.pen = { x: this.pen.x + dx, y: this.pen.y + dy };
  }
  /** 把主体拉回画布内并留 margin 边距（只在不越界的方向上平移） */
  fitMargin(m = 1) {
    const box = this.bbox();
    if (!box) return;
    let dx = 0;
    let dy = 0;
    if (box.minX < m) dx = m - box.minX;
    else if (box.maxX > this.w - 1 - m) dx = this.w - 1 - m - box.maxX;
    if (box.minY < m) dy = m - box.minY;
    else if (box.maxY > this.h - 1 - m) dy = this.h - 1 - m - box.maxY;
    if (dx || dy) this.shift(dx, dy);
  }
  clearRegion(x, y, w, h) {
    for (let yy = Math.round(y); yy < Math.round(y) + Math.round(h); yy++) {
      for (let xx = Math.round(x); xx < Math.round(x) + Math.round(w); xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        this.data[(yy * this.w + xx) * 4 + 3] = 0;
      }
    }
  }
  /**
   * 矩形填充/覆盖（和 clearRegion 的区别：不挖透明，而是用颜色盖住）。
   * 改五官、改高光的时候用它 —— 用 erase 挖透明会在轮廓上留下缺口。
   */
  fillRegion(x, y, w, h, c, alpha) {
    for (let yy = Math.round(y); yy < Math.round(y) + Math.round(h); yy++) {
      for (let xx = Math.round(x); xx < Math.round(x) + Math.round(w); xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        this.setPx(xx, yy, c, alpha);
      }
    }
  }
  clear() { this.data.fill(0); }
  /** 竖向渐变填充（上 bright 下 dark），做天空/金属/圆柱很有用 */
  gradientRect(x, y, w, h, top, bottom, alpha) {
    const y0 = Math.round(y);
    const y1 = Math.round(y + h);
    for (let yy = y0; yy < y1; yy++) {
      const t = y1 - y0 <= 1 ? 0 : (yy - y0) / (y1 - y0 - 1);
      const c = mix(top, bottom, t);
      this.fillRect(x, yy, w, 1, c, alpha);
    }
  }

  // ============================================================ 风景原语
  // 大画布（256~1024）上，靠 ai 手摆 fill_poly 画山/云/水是不可能的：
  // 一幅 1024 风景动辄几十万像素、上百个山脊点。下面这些原语把「程序生成 + 参数化」
  // 交给本机执行，ai 只负责选参数（高度/种子/色阶），然后看图微调。

  /**
   * 快速写像素（RGB 分量直传，不走 hex 字符串解析）。
   * 1024² 的风景是百万级像素，setPx 每像素 parse 一次 hex 会慢到没法用。
   */
  putRgb(x, y, r, g, b, a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (this.sel) {
      const s = this.sel;
      if (x < s.x || y < s.y || x >= s.x + s.w || y >= s.y + s.h) return;
    }
    const i = (y * this.w + x) * 4;
    if (a >= 255) {
      this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255;
      return;
    }
    if (a <= 0) return;
    const t = a / 255;
    const da = this.data[i + 3] / 255;
    const oa = t + da * (1 - t);
    if (oa <= 0) return;
    const k = t / oa;
    this.data[i] = this.data[i] + (r - this.data[i]) * k;
    this.data[i + 1] = this.data[i + 1] + (g - this.data[i + 1]) * k;
    this.data[i + 2] = this.data[i + 2] + (b - this.data[i + 2]) * k;
    this.data[i + 3] = Math.round(oa * 255);
  }

  /**
   * 天空渐变：多段色标（比两色渐变自然得多）。
   * 真实天空的色调变化不均匀 —— 地平线附近暖、头顶冷、天顶偏深，两色一眼假。
   * @param {Array<{t:number,color:string}>} stops 按 t(0..1,从上到下) 升序
   */
  skyGradient(y0, y1, stops, alpha = 255) {
    const list = (stops || []).filter((s) => s && s.color)
      .map((s) => ({ t: Math.max(0, Math.min(1, Number(s.t) || 0)), rgb: hexToRgb(s.color) }))
      .sort((a, b) => a.t - b.t);
    if (!list.length) return;
    const ya = Math.round(Math.min(y0, y1));
    const yb = Math.round(Math.max(y0, y1));
    for (let y = ya; y <= yb; y++) {
      const t = yb - ya <= 0 ? 0 : (y - ya) / (yb - ya);
      let a = list[0];
      let b = list[list.length - 1];
      for (let k = 0; k + 1 < list.length; k++) {
        if (t >= list[k].t && t <= list[k + 1].t) { a = list[k]; b = list[k + 1]; break; }
      }
      const span = b.t - a.t;
      // 用平滑插值而非线性：天空色带之间的过渡更柔
      let f = span <= 1e-6 ? 0 : (t - a.t) / span;
      f = smooth(Math.max(0, Math.min(1, f)));
      const r = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f;
      const g = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f;
      const bl = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f;
      for (let x = 0; x < this.w; x++) this.putRgb(x, y, r, g, bl, alpha);
    }
  }

  /**
   * 程序化山脊/丘陵：按列求高度，从山脊线用渐变色填到山脚。
   * 这是风景的骨架。ridge=true 出锯齿峰（远山/峻岭），false 出圆润丘陵。
   * @param {object} o {x,y,w,h, baseY, height, freq, seed, octaves, roughness,
   *                     top, bottom, ridge, rim, snow, snowLine}
   */
  terrain(o = {}) {
    const x0 = Math.max(0, Math.round(o.x ?? 0));
    const x1 = Math.min(this.w, Math.round((o.x ?? 0) + (o.w ?? this.w)));
    const baseY = Math.round(o.baseY ?? this.h * 0.72);   // 山脚（地平线）
    const peakH = o.height ?? this.h * 0.32;              // 从山脚往上最高多少
    const freq = o.freq ?? 0.008;
    const seed = Math.round(o.seed ?? 1);
    const octaves = Math.max(1, Math.min(8, Math.round(o.octaves ?? 5)));
    const rough = o.roughness ?? 0.5;
    const ridge = o.ridge !== false;
    // 【分辨率自适应】噪声频率一律按 512 参考宽换算。不做这一步的后果很具体：
    // 同一个 freq 在 512 上调好了，拉到 1024 后山体只经历一半噪声周期 ——
    // 山变宽、变糊、失去峰形，看上去就是“一块大色块”。
    const RS = Math.max(0.25, this.w / 512);
    // 【岩体材质】纯渐变的山 = 一块灰板。真实山体有沟壑与碎裂，
    // 竖向拉长的噪声（沟是竖的，不是横的）。rock=0 关掉。
    const rockAmt = o.rock == null ? 0.30 : Number(o.rock);
    const topRgb = hexToRgb(o.top || '#8fa3bd');
    const botRgb = hexToRgb(o.bottom || '#3d4d66');
    const rimRgb = o.rim ? hexToRgb(o.rim) : null;
    const snowRgb = o.snow ? hexToRgb(o.snow) : null;
    const snowLine = o.snowLine ?? 0.35; // 相对峰高：超过这个比例的区域积雪
    const yBottom = Math.min(this.h - 1, Math.round(o.bottomY ?? baseY));
    const alpha = o.alpha == null ? 255 : Number(o.alpha);
    // 山脊线缓存，rim 绘制要用
    const tops = new Float32Array(Math.max(1, x1 - x0));
    for (let x = x0; x < x1; x++) {
      const n = ridge
        ? ridged1((x - x0) * freq * RS, seed, octaves, rough)
        : fbm1((x - x0) * freq * RS, seed, octaves, rough);
      // 双层：整体起伏 + 小尺度抖动，避免轮廓像一条正弦波
      const drift = fbm1((x - x0) * freq * 0.18 * RS, seed + 977, 2, 0.5);
      const hy = baseY - (0.25 + 0.75 * n) * peakH * (0.7 + 0.5 * drift);
      const top = Math.max(0, Math.round(hy));
      tops[x - x0] = top;
      // 【东坡/西坡受光】给山体一个方向光（默认左上）。
      // 【坑·必须用平滑坡度】第一版写成「跟前一列比高→+1 否则-1」的符号光：
      // 山脊逐列都是 1px 级抖动的，于是相邻两列在 +22 和 -22 之间反复跳，
      // 1024 画布上出现一片**密集竖条纹**（看起来像拉丝金属/条形码）。
      // 正确做法：用跨多列的滑动平均求坡度（低频），亮度才会连成起伏的坡面。
      const LOOK = 6;
      let sumAhead = 0, sumBehind = 0;
      for (let d = 1; d <= LOOK; d++) {
        const xi = Math.min(x1 - 1, Math.max(x0, x + d));
        const xj = Math.min(x1 - 1, Math.max(x0, x - d));
        sumAhead += tops[xi - x0];
        sumBehind += tops[xj - x0];
      }
      const grad = (sumBehind - sumAhead) / LOOK; // >0 山脊向右下沉 = 东坡受光
      const slopeLit = Math.max(-1, Math.min(1, grad / 3));
      const span = Math.max(1, yBottom - top);
      for (let y = top; y <= yBottom; y++) {
        const t = (y - top) / span;
        // 山体：上亮下暗，但底部不要压得太死（远景靠明度区分层次）
        const f = t * t * 0.75 + t * 0.25;
        let r = topRgb[0] + (botRgb[0] - topRgb[0]) * f;
        let g = topRgb[1] + (botRgb[1] - topRgb[1]) * f;
        let b = topRgb[2] + (botRgb[2] - topRgb[2]) * f;
        // 侧光：迎光坡提亮、背光坡压暗，幅度随高度递减（山脚被雾盖住）
        const sideAmt = slopeLit * 18 * (1 - t * 0.6);
        r += sideAmt;
        g += sideAmt * 0.98;
        b += sideAmt * 0.95;
        if (snowRgb && (y - top) / (baseY - top + 1) < snowLine) {
          // 积雪：越靠顶越白，边缘是**舌头状**而不是碎斑。
          // （之前用高频 0.09 的 edge，1024 下把雪区打碎成白毛）
          const sn = 1 - (y - top) / Math.max(1, (baseY - top) * snowLine);
          const edge = fbm2(x * 0.018 * RS, y * 0.018 * RS, seed + 31, 3, 0.6);
          const k = Math.max(0, Math.min(1, sn * 1.35 - (edge - 0.5) * 0.55));
          r += (snowRgb[0] - r) * k;
          g += (snowRgb[1] - g) * k;
          b += (snowRgb[2] - b) * k;
        }
        // 岩体沟壑：竖向拉长的噪声（y 频率是 x 的 0.22 倍）
        if (rockAmt) {
          const f2 = 0.055 + 0.09 * t;
          const rn = fbm2(x * f2 * RS, y * f2 * 0.22 * RS, seed + 71, 3, 0.55) - 0.5;
          const amt = rockAmt * 46 * (0.35 + 0.65 * t);
          r += rn * amt;
          g += rn * amt * 0.97;
          b += rn * amt * 0.92;
        }
        this.putRgb(x, y, r, g, b, alpha);
      }
    }
    if (rimRgb) {
      // 山脊受光边：沿轮廓内侧 1~2px 提亮，山一下就「立」起来了
      const wdt = Math.max(1, Math.round(o.rimWidth ?? 1));
      for (let k = 0; k < tops.length; k++) {
        const top = tops[k];
        for (let d = 0; d < wdt; d++) {
          const a = 200 - d * 60;
          if (a > 0) this.putRgb(x0 + k, top + d, rimRgb[0], rimRgb[1], rimRgb[2], a);
        }
      }
    }
    return { tops };
  }

  /**
   * 云层：fbm2 噪声 + 阈值出云，横向拉伸（真实云是横向铺开的）。
   * @param {object} o {x,y,w,h, scale, scaleY, seed, octaves, threshold, soft, color, alpha, density}
   */
  clouds(o = {}) {
    const x0 = Math.max(0, Math.round(o.x ?? 0));
    const y0 = Math.max(0, Math.round(o.y ?? 0));
    const x1 = Math.min(this.w, Math.round((o.x ?? 0) + (o.w ?? this.w)));
    const y1 = Math.min(this.h, Math.round((o.y ?? 0) + (o.h ?? this.h * 0.5)));
    const scale = o.scale ?? 0.006;
    const scaleY = o.scaleY ?? scale * 2.2; // 竖向频率更低 = 云被压扁，横向铺开
    const seed = Math.round(o.seed ?? 7);
    const oct = Math.max(1, Math.min(7, Math.round(o.octaves ?? 5)));
    const thr = o.threshold ?? 0.52;
    const soft = Math.max(0.005, o.soft ?? 0.14);
    const rgb = hexToRgb(o.color || '#ffffff');
    const maxA = o.alpha == null ? 255 : Number(o.alpha);
    const shade = o.shade == null ? 0.16 : Number(o.shade); // 云底压暗，做出体积
    const RS = Math.max(0.25, this.w / 512); // 分辨率自适应
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const n = fbm2(x * scale * RS, y * scaleY * RS, seed, oct, 0.55);
        let k = (n - thr) / soft;
        if (k <= 0) continue;
        k = Math.min(1, k);
        k = k * k * (3 - 2 * k); // smoothstep，避免云边一圈硬像素
        // 越靠云的下沿越暗（受上方光照的错觉）
        const lower = fbm2(x * scale * 1.7 * RS, (y + 3) * scaleY * RS, seed + 5, 3, 0.5);
        const d = 1 - shade * Math.max(0, Math.min(1, (n - lower) * 6));
        this.putRgb(x, y, rgb[0] * d, rgb[1] * d, rgb[2] * d, k * maxA);
      }
    }
  }

  /**
   * 雾带：贴地平线的横向雾，越靠近 centerY 越浓，并带噪声起伏。
   * 风景里「远山发白」全靠它 —— 一层雾就能做出空气透视，画面立刻有纵深。
   */
  fog(o = {}) {
    const x0 = Math.max(0, Math.round(o.x ?? 0));
    const y0 = Math.max(0, Math.round(o.y ?? 0));
    const x1 = Math.min(this.w, Math.round((o.x ?? 0) + (o.w ?? this.w)));
    const y1 = Math.min(this.h, Math.round((o.y ?? 0) + (o.h ?? this.h)));
    const cy = o.cy ?? (y0 + y1) / 2;
    const spread = Math.max(1, o.spread ?? (y1 - y0) / 2);
    const rgb = hexToRgb(o.color || '#dfe9f3');
    const maxA = o.alpha == null ? 150 : Number(o.alpha);
    const scale = o.scale ?? 0.004;
    const seed = Math.round(o.seed ?? 21);
    const RS = Math.max(0.25, this.w / 512); // 分辨率自适应
    for (let y = y0; y < y1; y++) {
      const dy = Math.abs(y - cy) / spread;
      if (dy > 1) continue;
      const band = Math.pow(1 - dy, o.power ?? 1.6);
      for (let x = x0; x < x1; x++) {
        const n = fbm2(x * scale * RS, y * scale * 2.5 * RS, seed, 4, 0.55);
        // 【必预钳制】k 可能 > 1，被 Math.min(maxA,..) 钉成同一个值时，
        // 一整片雾变成实心色块，与山相接处出现一条死硬亮线。
        const k = Math.max(0, Math.min(1, band * (0.55 + 0.75 * n)));
        if (k <= 0.01) continue;
        this.putRgb(x, y, rgb[0], rgb[1], rgb[2], Math.min(maxA, k * maxA));
      }
    }
  }

  /**
   * 水面倒影：把地平线以上的画面垂直翻转贴到水下，并加波纹位移 + 压暗。
   * 这是「河流/湖面」能不能看的分水岭 —— 手动画倒影几乎必歪。
   * @param {object} o {shoreY, depth, strength, ripple, seed, darken, startX, endX}
   */
  waterReflect(o = {}) {
    const shore = Math.round(o.shoreY ?? this.h * 0.7);
    const depth = Math.round(o.depth ?? this.h - shore);
    if (depth <= 0 || shore <= 0) return;
    const x0 = Math.max(0, Math.round(o.startX ?? 0));
    const x1 = Math.min(this.w, Math.round(o.endX ?? this.w));
    const strength = o.strength ?? 1;      // 1 = 精确镜像；<1 只叠半透明倒影
    const darken = o.darken ?? 0.72;       // 水下压暗
    const ripple = o.ripple ?? 2.2;        // 波形横向位移幅度
    const freq = o.freq ?? 0.09;
    const seed = Math.round(o.seed ?? 3);
    const src = new Uint8ClampedArray(this.data);
    const at = (x, y) => {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
      return (y * this.w + x) * 4;
    };
    for (let y = shore; y < Math.min(this.h, shore + depth); y++) {
      const t = (y - shore) / depth;             // 0 = 岸边, 1 = 远端
      // 透视压缩：越靠近观察者的水面反射的景物越高
      const srcY = shore - 1 - Math.round(t * depth * 0.98);
      const wave = Math.sin(y * freq) * ripple + Math.sin(y * freq * 2.7 + 1.3) * ripple * 0.4;
      for (let x = x0; x < x1; x++) {
        const sx = Math.round(x + wave);
        const si = at(sx, srcY);
        if (si < 0 || src[si + 3] <= 8) {
          // 岸上没东西（透明），水就用自己的底色，留一点蓝
          this.putRgb(x, y, 40, 68, 92, 255);
          continue;
        }
        const d = darken + (1 - darken) * (1 - t);
        this.putRgb(x, y, src[si] * d, src[si + 1] * d * 0.98, src[si + 2] * d * 1.04, 255 * strength);
      }
    }
  }

  /**
   * 波光：水面上的横向亮线（每行随机长短的高光段），让水「动」起来。
   */
  waterSparkle(o = {}) {
    const x0 = Math.max(0, Math.round(o.x ?? 0));
    const x1 = Math.min(this.w, Math.round((o.x ?? 0) + (o.w ?? this.w)));
    const y0 = Math.max(0, Math.round(o.y ?? this.h * 0.7));
    const y1 = Math.min(this.h, Math.round((o.y ?? 0) + (o.h ?? this.h)));
    const rgb = hexToRgb(o.color || '#cfeeff');
    const maxA = o.alpha == null ? 120 : Number(o.alpha);
    const density = o.density ?? 0.3;
    const seed = Math.round(o.seed ?? 11);
    const rnd = makeRng(seed);
    for (let y = y0; y < y1; y++) {
      // 越靠近地平线的行越密（远处水面波纹细）
      const near = 1 - (y - y0) / Math.max(1, y1 - y0);
      const n = Math.round((x1 - x0) * density * (0.3 + near) * 0.12);
      for (let i = 0; i < n; i++) {
        const len = 1 + Math.round(rnd() * (2 + near * 6));
        const sx = x0 + Math.round(rnd() * (x1 - x0 - len));
        const a = maxA * (0.35 + rnd() * 0.65) * (0.4 + near * 0.6);
        for (let k = 0; k < len; k++) this.putRgb(sx + k, y, rgb[0], rgb[1], rgb[2], a);
      }
    }
  }

  /**
   * 光柱/耶稣光：从光源点向下散开的光束，带噪声调制（避免死板的几何扇形）。
   * 黄昏/森林场景的关键氛围道具。
   */
  godRays(o = {}) {
    const cx = o.cx ?? this.w / 2;
    const cy = o.cy ?? 0;
    const count = Math.max(1, Math.min(40, Math.round(o.count ?? 7)));
    const spread = (o.spread ?? 70) * Math.PI / 180;
    const start = ((o.angle ?? 90) * Math.PI) / 180 - spread / 2;
    const len = o.length ?? this.h * 1.4;
    const rgb = hexToRgb(o.color || '#fff3c4');
    const maxA = o.alpha == null ? 70 : Number(o.alpha);
    const seed = Math.round(o.seed ?? 5);
    const width = o.width ?? 0.35; // 单条光柱角宽占扇形的比例
    for (let y = Math.max(0, Math.round(cy)); y < Math.min(this.h, Math.round(cy + len)); y++) {
      const dy = y - cy;
      for (let x = 0; x < this.w; x++) {
        const a = Math.atan2(dy, x - cx);
        // 归到扇形范围内并取小数部分，用来判断落在哪条光柱上
        const rel = ((a - start) / spread) * count;
        if (rel < 0 || rel >= count) continue;
        const frac = rel - Math.floor(rel);
        const d = Math.abs(frac - 0.5) / 0.5;
        if (d > width) continue;
        const edge = 1 - d / Math.max(1e-3, width);
        // 沿距离衰减 + 噪声闪烁
        const dist = Math.sqrt(dy * dy + (x - cx) * (x - cx)) / len;
        const fall = Math.max(0, 1 - dist) * (0.6 + 0.6 * fbm2(x * 0.02, y * 0.01, seed, 3, 0.6));
        const k = edge * edge * fall;
        if (k <= 0.01) continue;
        this.putRgb(x, y, rgb[0], rgb[1], rgb[2], Math.min(255, k * maxA));
      }
    }
  }

  /**
   * 太阳/月亮 + 光晕：多层光晕 + 日冕，比单个 gradient_radial 像样。
   */
  sun(o = {}) {
    const cx = o.cx ?? this.w * 0.75;
    const cy = o.cy ?? this.h * 0.2;
    const r = o.r ?? Math.min(this.w, this.h) * 0.05;
    const rgb = hexToRgb(o.color || '#fff6d0');
    const halo = o.halo ? hexToRgb(o.halo) : rgb;
    const haloR = r * (o.haloScale ?? 6);
    const haloA = o.haloAlpha == null ? 60 : Number(o.haloAlpha);
    // 光晕：多层叠加，亮度按距离平方衰减
    for (let y = Math.round(cy - haloR); y <= cy + haloR; y++) {
      for (let x = Math.round(cx - haloR); x <= cx + haloR; x++) {
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / haloR;
        if (d > 1) continue;
        const k = Math.pow(1 - d, 3);
        if (k <= 0.01) continue;
        this.putRgb(x, y, halo[0], halo[1], halo[2], k * haloA);
      }
    }
    for (let y = Math.round(cy - r); y <= cy + r; y++) {
      for (let x = Math.round(cx - r); x <= cx + r; x++) {
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / Math.max(0.6, r);
        if (d > 1) continue;
        const k = 1 - d * d * 0.15;
        this.putRgb(x, y, rgb[0] * k, rgb[1] * k, rgb[2] * k, 255);
      }
    }
  }

  /**
   * 物体接影/投影：在 y 线上画一条横向渐变淡出的椭圆阴影。
   * 风景/场景里「树站不住」多半就是缺这一块。
   */
  groundShade(o = {}) {
    const cx = o.cx ?? this.w / 2;
    const cy = o.cy ?? this.h * 0.75;
    const rx = o.rx ?? this.w * 0.06;
    const ry = o.ry ?? Math.max(1, rx * 0.28);
    const rgb = hexToRgb(o.color || '#000000');
    const maxA = o.alpha == null ? 90 : Number(o.alpha);
    for (let y = Math.round(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.round(cx - rx); x <= cx + rx; x++) {
        const d = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
        if (d > 1) continue;
        this.putRgb(x, y, rgb[0], rgb[1], rgb[2], Math.pow(1 - d, 1.5) * maxA);
      }
    }
  }

  /**
   * 区域纹理：把噪声当明暗调制叠加到底色上（岩石/草地/沙地/墙面）。
   * 平涂的大色块是「看着假」的主要原因，一层纹理就能救。
   */
  texture(o = {}) {
    const x0 = Math.max(0, Math.round(o.x ?? 0));
    const y0 = Math.max(0, Math.round(o.y ?? 0));
    const x1 = Math.min(this.w, Math.round((o.x ?? 0) + (o.w ?? this.w)));
    const y1 = Math.min(this.h, Math.round((o.y ?? 0) + (o.h ?? this.h)));
    const scale = o.scale ?? 0.05;
    const seed = Math.round(o.seed ?? 17);
    const amount = o.amount ?? 0.18;
    const oct = Math.max(1, Math.min(6, Math.round(o.octaves ?? 3)));
    const lightRgb = hexToRgb(o.light || '#ffffff');
    const darkRgb = hexToRgb(o.dark || '#000000');
    const src = new Uint8ClampedArray(this.data);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * this.w + x) * 4;
        if (src[i + 3] <= 8) continue;
        const n = fbm2(x * scale, y * scale, seed, oct, 0.55) - 0.5;
        const k = n * 2 * amount;
        const tgt = k >= 0 ? lightRgb : darkRgb;
        const f = Math.min(1, Math.abs(k));
        this.putRgb(x, y,
          src[i] + (tgt[0] - src[i]) * f,
          src[i + 1] + (tgt[1] - src[i + 1]) * f,
          src[i + 2] + (tgt[2] - src[i + 2]) * f,
          src[i + 3]);
      }
    }
  }

  /** 暗角：四周压暗，把视线收到画面中心（风景/插画氛围常用） */
  vignette(strength = 0.4, color = '#000000') {
    const rgb = hexToRgb(color);
    const cx = (this.w - 1) / 2;
    const cy = (this.h - 1) / 2;
    const maxD = Math.sqrt(cx * cx + cy * cy);
    const amt = Math.max(0, Math.min(1, Number(strength) || 0.4));
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.data[(y * this.w + x) * 4 + 3] <= 8) continue;
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxD;
        const k = Math.pow(Math.max(0, d - 0.45) / 0.55, 2) * amt;
        if (k <= 0.005) continue;
        this.putRgb(x, y, rgb[0], rgb[1], rgb[2], k * 255);
      }
    }
  }

  /**
   * 模糊（box blur，可多遍近似高斯）：做柔光、焦外、雾化。
   * radius 大时对大画布很费，所以只处理不透明区域外接框。
   */
  blur(radius = 2, passes = 2) {
    const r = Math.max(1, Math.round(radius));
    for (let p = 0; p < Math.max(1, passes); p++) {
      const src = new Uint8ClampedArray(this.data);
      const tmp = new Uint8ClampedArray(this.data.length);
      const { w, h } = this;
      // 水平
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
          for (let k = -r; k <= r; k++) {
            const sx = x + k;
            if (sx < 0 || sx >= w) continue;
            const i = (y * w + sx) * 4;
            ar += src[i]; ag += src[i + 1]; ab += src[i + 2]; aa += src[i + 3]; n++;
          }
          const o = (y * w + x) * 4;
          tmp[o] = ar / n; tmp[o + 1] = ag / n; tmp[o + 2] = ab / n; tmp[o + 3] = aa / n;
        }
      }
      // 垂直
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
          for (let k = -r; k <= r; k++) {
            const sy = y + k;
            if (sy < 0 || sy >= h) continue;
            const i = (sy * w + x) * 4;
            ar += tmp[i]; ag += tmp[i + 1]; ab += tmp[i + 2]; aa += tmp[i + 3]; n++;
          }
          const o = (y * w + x) * 4;
          this.data[o] = ar / n; this.data[o + 1] = ag / n; this.data[o + 2] = ab / n; this.data[o + 3] = aa / n;
        }
      }
    }
  }

  /**
   * 色阶量化（可有抖动）：像素画收尾必备。
   * 渐变发雾的画量化成 8~24 色后立刻「像素画」起来，脏色也被抹平。
   */
  posterize(levels = 12, useDither = true) {
    const n = Math.max(2, Math.min(64, Math.round(levels)));
    const step = 255 / (n - 1);
    const B = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        if (this.data[i + 3] <= 8) continue;
        // Bayer 抖动：在量化前把像素值按格子偏一点，色带就不会成块
        const d = useDither ? (B[y & 3][x & 3] / 16 - 0.5) * step * 0.9 : 0;
        for (let k = 0; k < 3; k++) {
          const v = this.data[i + k] + d;
          this.data[i + k] = Math.max(0, Math.min(255, Math.round(Math.round(v / step) * step)));
        }
      }
    }
  }

  /**
   * 重采样画布（最近邻 / 双线性）。
   * 用途：在 512 上快速试构图 → 定稿后放大到 1024 补细节；或者反过来降采样去噪。
   */
  resample(nw, nh, smooth = false) {
    nw = Math.max(1, Math.round(nw));
    nh = Math.max(1, Math.round(nh));
    if (nw === this.w && nh === this.h) return;
    const src = new Uint8ClampedArray(this.data);
    const sw = this.w;
    const sh = this.h;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const sy = (y + 0.5) * (sh / nh) - 0.5;
      for (let x = 0; x < nw; x++) {
        const sx = (x + 0.5) * (sw / nw) - 0.5;
        const di = (y * nw + x) * 4;
        if (!smooth) {
          const px = Math.max(0, Math.min(sw - 1, Math.round(sx)));
          const py = Math.max(0, Math.min(sh - 1, Math.round(sy)));
          const si = (py * sw + px) * 4;
          out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
          continue;
        }
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
        const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const fx = Math.max(0, Math.min(1, sx - x0));
        const fy = Math.max(0, Math.min(1, sy - y0));
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        for (let k = 0; k < 4; k++) {
          const top = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
          const bot = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
          out[di + k] = top + (bot - top) * fy;
        }
      }
    }
    this.w = nw;
    this.h = nh;
    this.data = out;
    this.sel = null;
    this.pen = { x: Math.floor(nw / 2), y: Math.floor(nh / 2) };
  }

  bbox() {
    let minX = this.w, minY = this.h, maxX = -1, maxY = -1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.data[(y * this.w + x) * 4 + 3] <= 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  countOpaque() {
    let n = 0;
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i] > 8) n++;
    return n;
  }
  /** 画布最外一圈有多少比例是不透明的（判断「铺满整张画布」是背景还是主体贴边） */
  borderOpaqueRatio() {
    let hit = 0;
    let n = 0;
    const tap = (x, y) => { n++; if (this.a(x, y) > 8) hit++; };
    for (let x = 0; x < this.w; x++) { tap(x, 0); tap(x, this.h - 1); }
    for (let y = 1; y < this.h - 1; y++) { tap(0, y); tap(this.w - 1, y); }
    return n ? hit / n : 0;
  }
  /** 最外一圈的颜色直方图：用来认出「背景色」，好把它从主体统计里排除掉 */
  borderStats(limit = 4) {
    const map = new Map();
    let total = 0;
    const tap = (x, y) => {
      const i = (y * this.w + x) * 4;
      if (this.data[i + 3] <= 8) return;
      const hex = toHex([this.data[i], this.data[i + 1], this.data[i + 2]]);
      map.set(hex, (map.get(hex) || 0) + 1);
      total++;
    };
    for (let x = 0; x < this.w; x++) { tap(x, 0); tap(x, this.h - 1); }
    for (let y = 1; y < this.h - 1; y++) { tap(0, y); tap(this.w - 1, y); }
    const list = [...map.entries()]
      .map(([hex, count]) => ({ hex, count, pct: total ? count / total : 0 }))
      .sort((a, b) => b.count - a.count);
    return { total, list: list.slice(0, limit) };
  }
  /**
   * 背景掩码：从画布最外一圈的不透明像素出发，沿「与相邻像素颜色相近」漫填，
   * 把整块背景（包括渐变天空、地面）标出来。这样有背景的画不会被诊断成
   * 「主体糊满画布 / 主体贴边」。
   * 只在最外一圈大部分不透明时才认为存在背景 —— 否则那是透明底的精灵图。
   * @returns {Uint8Array|null} 1 = 背景
   */
  bgMask(tol = 20) {
    if (this.borderOpaqueRatio() < 0.6) return null;
    const n = this.w * this.h;
    const mask = new Uint8Array(n);
    const t2 = tol * tol * 3;
    const near = (i, j) => {
      const dr = this.data[i] - this.data[j];
      const dg = this.data[i + 1] - this.data[j + 1];
      const db = this.data[i + 2] - this.data[j + 2];
      return dr * dr + dg * dg + db * db <= t2;
    };
    const stack = [];
    const edgeOfHole = (x, y) => {
      // 贴着「画布内的透明区」的像素不算背景（画布外不算，否则最外一圈永远被判掉）
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        if (this.a(nx, ny) <= 8) return true;
      }
      return false;
    };
    const seed = (x, y) => {
      const i = (y * this.w + x) * 4;
      if (this.data[i + 3] <= 8 || mask[(y * this.w + x)]) return;
      if (edgeOfHole(x, y)) return;
      mask[y * this.w + x] = 1;
      stack.push([x, y]);
    };
    for (let x = 0; x < this.w; x++) { seed(x, 0); seed(x, this.h - 1); }
    for (let y = 1; y < this.h - 1; y++) { seed(0, y); seed(this.w - 1, y); }
    let guard = 0;
    while (stack.length && guard++ < n * 4) {
      const [x, y] = stack.pop();
      const ci = (y * this.w + x) * 4;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        const k = ny * this.w + nx;
        if (mask[k] || this.data[k * 4 + 3] <= 8) continue;
        if (!near(k * 4, ci)) continue;
        mask[k] = 1;
        stack.push([nx, ny]);
      }
    }
    let count = 0;
    for (let k = 0; k < n; k++) count += mask[k];
    return count ? mask : null;
  }
  /** 按掩码取包围盒：mask[i]=1 的像素被排除（用来算「去掉背景后的主体范围」） */
  bboxMasked(mask) {
    let minX = this.w, minY = this.h, maxX = -1, maxY = -1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const k = y * this.w + x;
        if (this.data[k * 4 + 3] <= 8 || mask[k]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  /** 颜色直方图 [{hex,count,pct}]，按占比降序 */
  colorStats(limit = 12) {
    const map = new Map();
    let total = 0;
    for (let i = 0; i < this.data.length; i += 4) {
      if (this.data[i + 3] <= 8) continue;
      const hex = toHex([this.data[i], this.data[i + 1], this.data[i + 2]]);
      map.set(hex, (map.get(hex) || 0) + 1);
      total++;
    }
    const list = [...map.entries()]
      .map(([hex, count]) => ({ hex, count, pct: total ? count / total : 0 }))
      .sort((a, b) => b.count - a.count);
    return { total, unique: list.length, list: list.slice(0, limit) };
  }
  /** 左右对称度 0..1（1 = 完全对称） */
  symmetry() {
    let diff = 0;
    let n = 0;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < Math.floor(this.w / 2); x++) {
        const a = (y * this.w + x) * 4;
        const b = (y * this.w + (this.w - 1 - x)) * 4;
        const ao = this.data[a + 3] > 8;
        const bo = this.data[b + 3] > 8;
        n++;
        if (ao !== bo) { diff++; continue; }
        if (!ao) continue;
        if (this.data[a] !== this.data[b] || this.data[a + 1] !== this.data[b + 1] || this.data[a + 2] !== this.data[b + 2]) diff++;
      }
    }
    return n ? 1 - diff / n : 1;
  }
  /** 孤立像素（四邻域全透明的实心像素）：像素画里通常是噪点 */
  isolated() {
    const out = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.a(x, y) <= 8) continue;
        const near = this.a(x - 1, y) > 8 || this.a(x + 1, y) > 8 || this.a(x, y - 1) > 8 || this.a(x, y + 1) > 8;
        if (!near) out.push([x, y]);
      }
    }
    return out;
  }
  /**
   * 轮廓瑕疵：凹洞（1px 的洞，4 面全被不透明包住）——这是零误报的。
   * 为什么不管「凸点」：一个 1px 的小凸起，跟圆形/弧线顶点的局部像素
   * 长得一模一样，做不出来不误报的判据。嘶狼来了比不报更糟，所以只报凹洞。
   * 返回 [{x, y, type:'凹'}]。
   */
  edgeSpurs(limit = 24) {
    const out = [];
    const A = (x, y) => this.a(x, y) > 8;
    const inBox = (x, y) => x >= 0 && y >= 0 && x < this.w && y < this.h;
    const N4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let y = 1; y < this.h - 1 && out.length < limit; y++) {
      for (let x = 1; x < this.w - 1 && out.length < limit; x++) {
        if (A(x, y)) continue;
        if (!N4.every(([dx, dy]) => A(x + dx, y + dy))) continue;
        out.push({ x, y, type: '凹' });
      }
    }
    return out;
  }
  /** 减色：只保留最常见的 n 种颜色，其余映射到最近色（画完收尾用） */
  reducePalette(n = 16) {
    const { list } = this.colorStats(4096);
    const keep = list.slice(0, Math.max(2, n)).map((c) => c.hex);
    const rgbKeep = keep.map((h) => hexToRgb(h));
    const cache = new Map();
    for (let i = 0; i < this.data.length; i += 4) {
      if (this.data[i + 3] <= 8) continue;
      const hex = toHex([this.data[i], this.data[i + 1], this.data[i + 2]]);
      if (keep.includes(hex)) continue;
      let near = cache.get(hex);
      if (!near) {
        let best = 0;
        let bestD = Infinity;
        for (let k = 0; k < rgbKeep.length; k++) {
          const [r, g, b] = rgbKeep[k];
          const d = (r - this.data[i]) ** 2 + (g - this.data[i + 1]) ** 2 + (b - this.data[i + 2]) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
        near = keep[best];
        cache.set(hex, near);
      }
      const [r, g, b] = hexToRgb(near);
      this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b;
    }
    return keep;
  }

  // ------------------------------------------------------------ 选区
  /**
   * 设置选区（clipping mask）。选区内的像素保留，区外一律置透明。
   * 后续所有绘制只作用于选区（见 applyOp），改局部不再靠 erase 重画。
   */
  select(x, y, w, h) {
    const x0 = Math.max(0, Math.min(this.w - 1, Math.round(x)));
    const y0 = Math.max(0, Math.min(this.h - 1, Math.round(y)));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    this.sel = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    return this.sel;
  }
  selectNone() { this.sel = null; }
  /** 该像素是否在选区内（无选区时永远 true） */
  inSel(x, y) {
    if (!this.sel) return true;
    const s = this.sel;
    return x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h;
  }

  // ------------------------------------------------------------ 变换
  /** 旋转 90 的整数倍（1=90° 顺时针，2=180°，3=270°） */
  rotate(quarters = 1) {
    const q = ((Math.round(quarters) % 4) + 4) % 4;
    if (!q) return;
    const { w, h, data } = this;
    const swap = q % 2 === 1;
    const nw = swap ? h : w;
    const nh = swap ? w : h;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let nx;
        let ny;
        if (q === 1) { nx = h - 1 - y; ny = x; }
        else if (q === 2) { nx = w - 1 - x; ny = h - 1 - y; }
        else { nx = y; ny = w - 1 - x; }
        const si = (y * w + x) * 4;
        const di = (ny * nw + nx) * 4;
        out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
      }
    }
    this.w = nw; this.h = nh; this.data = out; this.sel = null;
  }
  /** 最近邻缩放整体内容（k>1 放大，k<1 缩小），保持画布尺寸 */
  scale(k) {
    const f = Number(k);
    if (!Number.isFinite(f) || f <= 0 || f === 1) return;
    const { w, h, data } = this;
    const out = new Uint8ClampedArray(data.length);
    // 以「内容包围盒中心」为锚点缩放：贴边的画放大时才不会整体飞出画布
    const box = this.bbox();
    const cx = box ? (box.minX + box.maxX) / 2 : (w - 1) / 2;
    const cy = box ? (box.minY + box.maxY) / 2 : (h - 1) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.round(cx + (x - cx) / f);
        const sy = Math.round(cy + (y - cy) / f);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const si = (sy * w + sx) * 4;
        const di = (y * w + x) * 4;
        out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
      }
    }
    this.data = out;
  }
  /** 水平翻转整体内容（真翻转，不是镜像补全） */
  flipH() {
    const { w, h, data } = this;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        const di = (y * w + (w - 1 - x)) * 4;
        for (let k = 0; k < 4; k++) out[di + k] = data[si + k];
      }
    }
    this.data = out;
  }
  /** 垂直翻转整体内容 */
  flipV() {
    const { w, h, data } = this;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        const di = ((h - 1 - y) * w + x) * 4;
        for (let k = 0; k < 4; k++) out[di + k] = data[si + k];
      }
    }
    this.data = out;
  }

  // -------------------------------------------------------- 自动配色
  /**
   * 自动描边：从主体主色推出一个暗色描边，给所有不透明区域加 1px 内描边。
   * 不用 AI 手写 hex，配色一定协调。
   */
  autoOutline(k = 0.28, mode = 'in') {
    const colors = this.subjectColors(3);
    let base = colors[0] || '#3b82f6';
    const [r, g, b] = hexToRgb(base);
    // 保留一点色相，只压亮度（纯黑描边在浅色主体上很脏）
    const kk = Math.max(0.05, Math.min(1, Number(k) || 0.28));
    const dark = `#${[r, g, b].map((v) => Math.max(0, Math.round(v * kk)).toString(16).padStart(2, '0')).join('')}`;
    // 只描实心主体（alpha >= 200）：半透明的地影/腮红是柔和过渡，
    // 描上实心边会变成硬黑线，一看就是「描边画到阴影上了」
    if (mode === 'out') this.outlineOut(dark, 200);
    else this.outlineIn(dark, 200);
    return dark;
  }
  /**
   * 自动明暗：按主体主色做渐变，一步做出体积感。
   * 只改跟主色相近的像素，眼睛/高光这类对比色细节会保留。
   * @param amount 渐变强度（0.05~0.6）
   * @param dir    光源方向：top(默认，上亮下暗) / bottom / left / right /
   *               top-left / top-right / bottom-left / bottom-right
   *               背光角色、侧面受光、俯视角都需要它：以前写死上亮下暗，
   *               画「头顶打光」的人总是得手动再盖一层阴影。
   */
  autoShade(amount = 0.22, dir = 'top') {
    const colors = this.subjectColors(6);
    const base = colors[0] || '#3b82f6';
    const amt = Math.max(0.05, Math.min(0.6, Number(amount) || 0.22));
    const light = mix(base, '#ffffff', amt);
    const dark = mix(base, '#000000', amt);
    const bgm = this.bgMask();
    // 整片都是同一色时 bgMask 会把主体误判成背景，那样这里什么也改不了。
    // 所以「背景」盖住了几乎全部不透明像素时，直接当没有背景处理。
    let opaque = 0;
    let covered = 0;
    if (bgm) {
      for (let i = 0, p = 0; i < this.data.length; i += 4, p++) {
        if (this.data[i + 3] <= 8) continue;
        opaque++;
        if (bgm[p]) covered++;
      }
    }
    const useBg = !!bgm && opaque > 0 && covered / opaque < 0.92;
    const box = useBg ? this.bboxMasked(bgm) : this.bbox();
    if (!box) return { light, dark };
    const [br, bg, bb] = hexToRgb(base);
    const [lr, lg, lb] = hexToRgb(light);
    const [dr, dg, db] = hexToRgb(dark);
    const src = new Uint8ClampedArray(this.data);
    // 光源方向 -> 单位向量（指向「亮面」）。渲染时用像素在包围盒里的
    // 投影位置当渐变参数 t：t=0 在最靠近光源那头（亮），t=1 在最远那头（暗）。
    // 斜角方向要归一化，否则对角线会比正方向暗得慢（差 1.41 倍）。
    const dirs = {
      top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0],
      'top-left': [-0.7071, -0.7071], 'top-right': [0.7071, -0.7071],
      'bottom-left': [-0.7071, 0.7071], 'bottom-right': [0.7071, 0.7071],
    };
    const key = norm(String(dir || 'top'));
    const [lx, ly] = dirs[key] || dirs.top;
    // 包围盒四角在光方向上的投影 -> 把 t 归一化到 0~1
    const proj = (px, py) => (px - box.minX) * lx + (py - box.minY) * ly;
    const pC = proj(box.w - 1, 0);
    const pD = proj(0, box.h - 1);
    const pE = proj(box.w - 1, box.h - 1);
    const pMin = Math.min(0, pC, pD, pE);
    const pMax = Math.max(0, pC, pD, pE);
    const span = Math.max(1e-6, pMax - pMin);
    for (let y = box.minY; y <= box.maxY; y++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        const i = (y * this.w + x) * 4;
        if (src[i + 3] <= 8) continue;
        if (useBg && bgm[y * this.w + x]) continue;
        // t: 0 = 最亮（投影最靠光的那头）, 1 = 最暗；平滑曲线避免硬边。
        // 注意是 pMax - proj：投影值越靠光方向应该越亮，写成 proj - pMin 方向就反了。
        const t = (pMax - proj(x, y)) / span;
        const e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); // easeInOut
        // 只改「跟主色相近」的像素，对比色细节（眼白/瞳孔/高光）保留
        const d0 = src[i] - br;
        const d1 = src[i + 1] - bg;
        const d2 = src[i + 2] - bb;
        const dist = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
        if (dist > 70) continue;
        const fade = 1 - dist / 70; // 越接近主色改得越多，边缘过渡自然
        const tr = src[i] + ((e < 0.5 ? lr : dr) - src[i]) * Math.abs(e - 0.5) * 2 * fade;
        const tg = src[i + 1] + ((e < 0.5 ? lg : dg) - src[i + 1]) * Math.abs(e - 0.5) * 2 * fade;
        const tb = src[i + 2] + ((e < 0.5 ? lb : db) - src[i + 2]) * Math.abs(e - 0.5) * 2 * fade;
        this.data[i] = Math.round(tr);
        this.data[i + 1] = Math.round(tg);
        this.data[i + 2] = Math.round(tb);
      }
    }
    return { light, dark, dir: key };
  }
  /** 主体（排除背景）最常见的几种颜色 */
  subjectColors(limit = 4) {
    const bgm = this.bgMask();
    // bgMask 在「整片同一色」时会把主体当背景 —— 此时忽略它，否则主色会算成空
    let opaque = 0;
    let covered = 0;
    if (bgm) {
      for (let i = 0, p = 0; i < this.data.length; i += 4, p++) {
        if (this.data[i + 3] <= 8) continue;
        opaque++;
        if (bgm[p]) covered++;
      }
    }
    const useBg = !!bgm && opaque > 0 && covered / opaque < 0.92;
    const map = new Map();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        if (this.data[i + 3] <= 8) continue;
        if (useBg && bgm[y * this.w + x]) continue;
        const hex = toHex([this.data[i], this.data[i + 1], this.data[i + 2]]);
        map.set(hex, (map.get(hex) || 0) + 1);
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([h]) => h);
  }
}

/**
 * 裁出一块区域（看细节用：整张 256×256 缩到 288px 后，眼睛只有 1~2 像素看不清）。
 * 坐标自动夹进画布，越界部分按边缘裁掉。
 */
export function cropCanvas(cv, x, y, w, h) {
  const x0 = Math.max(0, Math.min(cv.w - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(cv.h - 1, Math.round(y)));
  const x1 = Math.max(x0 + 1, Math.min(cv.w, Math.round(x + w)));
  const y1 = Math.max(y0 + 1, Math.min(cv.h, Math.round(y + h)));
  const out = new Canvas(x1 - x0, y1 - y0);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const si = (yy * cv.w + xx) * 4;
      const di = ((yy - y0) * out.w + (xx - x0)) * 4;
      out.data[di] = cv.data[si];
      out.data[di + 1] = cv.data[si + 1];
      out.data[di + 2] = cv.data[si + 2];
      out.data[di + 3] = cv.data[si + 3];
    }
  }
  return out;
}

/**
 * 在图上叠加坐标网格（只在导出/预览时用，不改画板）。
 * step 为每隔多少像素画一条线；标尺画在图片外框（不遮主体）。
 */
export function overlayGrid(cv, step = 8, color = '#ff00ff', alpha = 150) {
  const out = new Canvas(cv.w, cv.h);
  out.data.set(cv.data);
  const sa = splitAlpha(color);
  const hexc = sa.hex;
  const a = sa.alpha != null ? sa.alpha : alpha;
  const s = Math.max(2, Math.round(step));
  for (let x = 0; x < cv.w; x += s) {
    for (let y = 0; y < cv.h; y++) out.setPx(x, y, hexc, a);
  }
  for (let y = 0; y < cv.h; y += s) {
    for (let x = 0; x < cv.w; x++) out.setPx(x, y, hexc, a);
  }
  return out;
}
/**
 * 把画布上的一块区域复制到另一个位置（支持水平/垂直翻转）。
 * 常见用法：画好一只耳朵，复制+翻转贴到另一边；或者复刻整块花纹。
 * @returns {boolean} 是否真的复制了（源区为空/越界返回 false）
 */
export function copyRegion(cv, sx, sy, w, h, dx, dy, opts = {}) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  sx = Math.round(sx);
  sy = Math.round(sy);
  // 先把源区拷出来（重叠复制时不会自己盖自己）
  const buf = new Uint8ClampedArray(w * h * 4);
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ox = sx + x;
      const oy = sy + y;
      if (ox < 0 || oy < 0 || ox >= cv.w || oy >= cv.h) continue;
      const si = (oy * cv.w + ox) * 4;
      const di = (y * w + x) * 4;
      buf[di] = cv.data[si];
      buf[di + 1] = cv.data[si + 1];
      buf[di + 2] = cv.data[si + 2];
      buf[di + 3] = cv.data[si + 3];
      if (cv.data[si + 3] > 8) any = true;
    }
  }
  if (!any) return false;
  const flipX = opts.flipX === true;
  const flipY = opts.flipY === true;
  const eraseSrc = opts.eraseSrc === true;
  if (eraseSrc) cv.clearRegion(sx, sy, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = flipX ? w - 1 - x : x;
      const by = flipY ? h - 1 - y : y;
      const si = (by * w + bx) * 4;
      if (buf[si + 3] <= 0) continue;
      const hex = toHex([buf[si], buf[si + 1], buf[si + 2]]);
      cv.setPx(dx + x, dy + y, hex, buf[si + 3]);
    }
  }
  return true;
}

// ------------------------------------------------------------- 操作解释器
const num = (v, f = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};
const norm = (name) => String(name || '').toLowerCase().replace(/[\s-]/g, '_');

/** 全量 op 名（主名 + 别名），报错时告诉模型它能用哪些 */
export const OP_NAMES = [
  'pixel', 'line', 'fill_rect', 'rect', 'fill_ellipse', 'ellipse',
  'fill_poly', 'flood_fill', 'outline_in', 'outline_out', 'gradient', 'gradient_radial',
  'dither', 'hue_rotate', 'symmetrize',
  'mirror_x', 'mirror_y', 'margin', 'shift', 'erase', 'clear',
  'palette', 'spray', 'noise',
  'select', 'select_none', 'copy_region',
  'rotate', 'scale', 'flip_h', 'flip_v',
  'auto_outline', 'auto_shade',
  // 风景原语（大画布必需：靠手摆坐标画不出山/云/雾/水）
  'sky', 'terrain', 'clouds', 'fog', 'water', 'water_sparkle',
  'god_rays', 'sun', 'ground_shade', 'texture', 'vignette', 'blur',
  'posterize', 'resample',
];

/**
 * 执行一条绘图操作。支持「锚点相对坐标」：op 里给 anchor:[x,y]，
 * 则 x/y/cx/cy/pts 都当成相对于该锚点的偏移（省 token，也方便整体挪）。
 */
export function applyOp(cv, op) {
  if (!op || typeof op !== 'object') return false;
  const name = norm(op.op || op.type || op.t);
  const raw = op.color || op.fill || op.c || op.stroke || '#000000';
  // 颜色里自带的 alpha（#rrggbbaa）优先，其次才是 op.alpha —— 模型写阴影时常用前者
  const sp = splitAlpha(raw);
  const c = sp.hex;
  // alpha 两种写法都接受：0~1 的浮点（文档写法）和 0~255 的整数（跟 #rrggbbaa 一致）。
  // 以前只认 0~1，模型写 alpha:40 会被 Math.min(1,..) 默默变成 255 —— 阴影成了死黑，
  // 属于静默出错，比报错难查得多。
  const alpha = sp.alpha != null
    ? sp.alpha
    : op.alpha == null ? 255 : Math.round(Math.max(0, Math.min(255, num(op.alpha, 1) <= 1 ? num(op.alpha, 1) * 255 : num(op.alpha, 0))));
  const ax = Array.isArray(op.anchor) ? num(op.anchor[0]) : 0;
  const ay = Array.isArray(op.anchor) ? num(op.anchor[1]) : 0;
  // blend 模式：auto（默认，按前景是否彩色自动选）/ lighten（高光：按底色提亮）/ hue / over
  const bl = String(op.blend || op.mode || 'auto').toLowerCase();
  const X = (v) => (v == null ? ax : num(v) + ax);
  const Y = (v) => (v == null ? ay : num(v) + ay);
  switch (name) {
    case 'pixel': case 'dot': case 'point':
      cv.pixel(X(op.x), Y(op.y), c, alpha);
      cv.pen = { x: X(op.x), y: Y(op.y) };
      return true;
    case 'line': case 'ln':
      cv.line(X(op.x1), Y(op.y1), X(op.x2), Y(op.y2), c, alpha);
      return true;
    case 'fill_rect': case 'rect_fill': case 'box': case 'fill_box':
      cv.fillRect(X(op.x), Y(op.y), num(op.w, 1), num(op.h, op.w ?? 1), c, alpha, bl);
      return true;
    case 'rect': case 'stroke_rect': case 'outline_rect': case 'frame':
      cv.rect(X(op.x), Y(op.y), num(op.w, 1), num(op.h, op.w ?? 1), c, alpha);
      return true;
    case 'fill_ellipse': case 'ellipse_fill': case 'circle': case 'disc': case 'dot_round':
      cv.fillEllipse(X(op.cx ?? op.x), Y(op.cy ?? op.y), num(op.rx, op.r ?? 1), num(op.ry, op.rx ?? op.r ?? 1), c, alpha, bl);
      return true;
    case 'ellipse': case 'stroke_ellipse': case 'ring': case 'circle_stroke':
      cv.ellipse(X(op.cx ?? op.x), Y(op.cy ?? op.y), num(op.rx, op.r ?? 1), num(op.ry, op.rx ?? op.r ?? 1), c, alpha);
      return true;
    case 'fill_poly': case 'polygon': case 'poly': case 'triangle':
      cv.fillPoly((op.pts || op.points || []).map(([x, y]) => [X(x), Y(y)]), c, alpha, bl);
      return true;
    case 'flood_fill': case 'bucket': case 'fill_region':
      cv.floodFill(X(op.x), Y(op.y), c, alpha);
      return true;
    case 'outline': case 'outline_in': case 'stroke': case 'stroke_in':
      // 手动描边：模型点名要描，半透明也照描（只跳过完全透明的）
      cv.outlineIn(c, 8);
      return true;
    case 'outline_out': case 'stroke_out':
      cv.outlineOut(c, 8);
      return true;
    case 'gradient': case 'gradient_rect': case 'gradient_vertical':
      cv.gradientRect(X(op.x), Y(op.y), num(op.w, cv.w), num(op.h, cv.h), op.top || op.color1 || c, op.bottom || op.color2 || shade(c, 0.6), alpha);
      return true;
    case 'gradient_radial': case 'radial': case 'glow': case 'gradient_round':
      // 径向渐变：画球体/光晕/气泡/宝石比竖向渐变自然。省略 rx/ry 时用画布包围盒的一半。
      cv.gradientRadial(
        X(op.cx ?? op.x ?? cv.w / 2), Y(op.cy ?? op.y ?? cv.h / 2),
        num(op.rx, num(op.r, cv.w / 2)), num(op.ry, num(op.rx, num(op.r, cv.h / 2))),
        op.inner || op.color1 || c, op.outer || op.color2 || shade(c, 0.45), alpha,
      );
      return true;
    case 'dither': case 'checker': case 'ordered_dither':
      // Bayer 有序抖动：用两色格子拼出过渡，不依赖半透明（导出不透明格式时用）
      cv.dither(X(op.x), Y(op.y), num(op.w, cv.w), num(op.h, num(op.w, cv.h)), op.color1 || c, op.color2 || shade(c, 0.5), num(op.strength, 0.5), alpha);
      return true;
    case 'hue_rotate': case 'rotate_hue': case 'recolor': case 'hue_shift':
      // 配色变体：同一条史莱姆换个颜色（灰白/描边不受影响）
      cv.hueRotate(num(op.deg ?? op.angle ?? op.hue, 0));
      return true;
    case 'symmetrize': case 'symmetry': case 'mirror_fix':
      cv.symmetrize(String(op.axis || op.from || 'left'));
      return true;
    case 'mirror_x': case 'flip_x':
      cv.mirrorX();
      return true;
    case 'mirror_y': case 'flip_y':
      cv.mirrorY();
      return true;
    case 'margin': case 'fit_margin':
      cv.fitMargin(num(op.margin, 1));
      return true;
    case 'shift': case 'move':
      cv.shift(num(op.dx ?? op.x), num(op.dy ?? op.y));
      return true;
    case 'erase': case 'clear_region':
      // 给了 color 就是「用颜色盖掉」而不是「挖成透明」——改高光/五官时
      // 用透明擦会把轮廓和描边也擦出缺口（真踩过）。
      if (sp.alpha != null || op.color || op.fill || op.c) {
        cv.fillRegion(X(op.x), Y(op.y), num(op.w, 1), num(op.h, op.w ?? 1), c, alpha);
      } else {
        cv.clearRegion(X(op.x), Y(op.y), num(op.w, 1), num(op.h, op.w ?? 1));
      }
      return true;
    case 'clear': case 'reset':
      cv.clear();
      return true;
    case 'palette': case 'reduce_palette': case 'quantize':
      cv.reducePalette(num(op.colors ?? op.n, 16));
      return true;
    // ---------------------------------------------------------- 选区
    case 'select': case 'region': case 'clip': {
      const s = cv.select(X(op.x), Y(op.y), num(op.w, cv.w), num(op.h, op.w ?? cv.h));
      return !!s;
    }
    case 'select_none': case 'unselect': case 'deselect':
      cv.selectNone();
      return true;
    case 'copy_region': case 'copy': case 'clone_region': case 'stamp_region': {
      // 源区：x/y/w/h；目标：dx/dy；sx/sy 也当源坐标的别名
      const sx = X(op.sx ?? op.fx ?? op.x);
      const sy = Y(op.sy ?? op.fy ?? op.y);
      const rw = num(op.w, num(op.src_w, cv.w - sx));
      const rh = num(op.h, num(op.src_h, cv.h - sy));
      const dx = num(op.dx, num(op.to_x, sx + rw));
      const dy = num(op.dy, num(op.to_y, sy));
      copyRegion(cv, sx, sy, rw, rh, dx, dy, {
        flipX: op.flip_x === true || op.flipX === true,
        flipY: op.flip_y === true || op.flipY === true,
        eraseSrc: op.erase_src === true || op.move === true,
      });
      // 源区是空的也算「op 合法」，只是没东西可复制（不算错误）
      return true;
    }
    // ---------------------------------------------------------- 变换
    case 'rotate': case 'rotate_90': case 'turn': {
      // 接受 90/180/270，也接受 1/2/3（四分之一圈数）
      let deg = num(op.deg ?? op.angle ?? op.times ?? op.n, 1);
      let q;
      if (Math.abs(deg) <= 4 && !op.deg && !op.angle) q = Math.round(deg); // 1/2/3 圈数
      else {
        deg = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
        q = deg / 90;
      }
      cv.rotate(q);
      return true;
    }
    case 'scale': case 'resize_content': case 'zoom': {
      const k = num(op.k ?? op.factor ?? op.by ?? op.n, 1);
      if (!(k > 0)) return false;
      cv.scale(k);
      return true;
    }
    case 'flip_h': case 'flip_horizontal': case 'flip':
      cv.flipH();
      return true;
    case 'flip_v': case 'flip_vertical':
      cv.flipV();
      return true;
    // -------------------------------------------------------- 自动配色
    case 'auto_outline': case 'auto_stroke': {
      const k = op.darkness ?? op.strength ?? op.k;
      cv.autoOutline(k == null ? 0.28 : num(k, 0.28), op.mode === 'out' || op.outer === true ? 'out' : 'in');
      return true;
    }
    case 'auto_shade': case 'shade': {
      // dir 支持八个方向（背光角色/侧面受光/俯视角都需要）
      cv.autoShade(op.amount == null ? 0.22 : num(op.amount, 0.22), String(op.dir || op.light || op.light_dir || 'top'));
      return true;
    }
    case 'bevel': {
      // bevel 以前是 auto_shade 的别名，但 bevel（斜面隆起）和「纵向渐变」
      // 是两件事：这里给它真实语义 —— 左上亮、右下暗的斜向光。
      cv.autoShade(op.amount == null ? 0.28 : num(op.amount, 0.28), String(op.dir || 'top-left'));
      return true;
    }
    case 'spray': case 'noise': {
      // 喷洒/噪点：在半径内随机打点（做草地、星点、材质）
      let seed = Math.abs(Math.round(num(op.seed, 12345))) || 1;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const n = Math.max(1, Math.min(4000, Math.round(num(op.count, 12))));
      const r = num(op.r ?? op.radius, 3);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * r;
        cv.setPx(X(op.cx ?? op.x) + Math.cos(a) * d, Y(op.cy ?? op.y) + Math.sin(a) * d, c, alpha);
      }
      return true;
    }

    // ================================================ 风景原语（大画布）
    case 'sky': case 'sky_gradient': case 'gradient_sky': {
      // 多段色标天空：stops:[{t:0,color:'#...'},{t:1,color:'#...'}]
      // 也接受简写 colors:['#...','#...']（均分）或 top/bottom（两色）
      let stops = op.stops || op.colors || op.bands;
      if (!stops) {
        // 默认给一个通用日落天空 —— op 名本身要算“真 op”（不传参也能执行），
        // 而且这个默认值本身就是可用的起点
        stops = [
          { t: 0, color: op.top || c },
          { t: 0.55, color: mix(op.top || c, op.bottom || shade(c, 0.5), 0.5) },
          { t: 1, color: op.bottom || shade(c, 0.5) },
        ];
      }
      if (Array.isArray(stops) && typeof stops[0] === 'string') {
        const n = stops.length;
        stops = stops.map((col, i) => ({ t: n <= 1 ? 0 : i / (n - 1), color: col }));
      }
      cv.skyGradient(num(op.y, 0), num(op.y, 0) + num(op.h, cv.h), stops, alpha);
      return true;
    }
    case 'terrain': case 'mountain': case 'mountains': case 'hills': case 'ridge': {
      // 程序化山脊：一次铺一层山（远/中/近分三次调用）
      cv.terrain({
        x: op.x == null ? 0 : X(op.x),
        w: num(op.w, cv.w),
        baseY: op.baseY == null ? num(op.base ?? op.y, cv.h * 0.72) : Y(op.baseY),
        height: num(op.height ?? op.h, cv.h * 0.32),
        freq: num(op.freq ?? op.scale, 0.008),
        seed: num(op.seed, 1),
        octaves: num(op.octaves ?? op.oct, 5),
        roughness: num(op.roughness ?? op.rough, 0.5),
        top: op.top || c,
        bottom: op.bottom || shade(op.top || c, 0.62),
        ridge: !(op.smooth === true || op.round === true || String(op.kind || '').includes('hill')),
        rim: op.rim || null,
        rimWidth: num(op.rimWidth, 1),
        snow: op.snow || null,
        snowLine: num(op.snowLine, 0.35),
        bottomY: op.bottomY == null ? undefined : Y(op.bottomY),
        alpha,
      });
      return true;
    }
    case 'clouds': case 'cloud': case 'cloud_layer': {
      cv.clouds({
        x: op.x == null ? 0 : X(op.x),
        y: op.y == null ? 0 : Y(op.y),
        w: num(op.w, cv.w),
        h: num(op.h, cv.h * 0.5),
        scale: num(op.scale ?? op.freq, 0.006),
        scaleY: op.scaleY == null ? undefined : num(op.scaleY, 0.013),
        seed: num(op.seed, 7),
        octaves: num(op.octaves ?? op.oct, 5),
        threshold: num(op.threshold ?? op.thr, 0.52),
        soft: num(op.soft, 0.14),
        color: op.color || op.top || '#ffffff',
        alpha,
        shade: num(op.shade, 0.16),
      });
      return true;
    }
    case 'fog': case 'mist': case 'haze': {
      cv.fog({
        x: op.x == null ? 0 : X(op.x),
        y: op.y == null ? 0 : Y(op.y),
        w: num(op.w, cv.w),
        h: num(op.h, cv.h),
        cy: op.cy == null ? undefined : Y(op.cy),
        spread: num(op.spread, num(op.h, cv.h) / 2),
        color: op.color || '#dfe9f3',
        alpha: op.alpha == null ? 150 : alpha,
        scale: num(op.scale, 0.004),
        seed: num(op.seed, 21),
        power: num(op.power, 1.6),
      });
      return true;
    }
    case 'water': case 'reflect': case 'water_reflect': {
      cv.waterReflect({
        shoreY: op.shoreY == null ? num(op.y, cv.h * 0.7) : Y(op.shoreY),
        depth: num(op.depth, cv.h - num(op.shoreY, cv.h * 0.7)),
        strength: num(op.strength, 1),
        darken: num(op.darken, 0.72),
        ripple: num(op.ripple, 2.2),
        freq: num(op.freq, 0.09),
        seed: num(op.seed, 3),
        startX: op.x == null ? 0 : X(op.x),
        endX: op.endX == null ? num(op.w, cv.w) + (op.x == null ? 0 : X(op.x)) : X(op.endX),
      });
      return true;
    }
    case 'water_sparkle': case 'sparkle': case 'glint': {
      cv.waterSparkle({
        x: op.x == null ? 0 : X(op.x),
        y: op.y == null ? 0 : Y(op.y),
        w: num(op.w, cv.w),
        h: num(op.h, cv.h),
        color: op.color || '#cfeeff',
        alpha: op.alpha == null ? 120 : alpha,
        density: num(op.density, 0.3),
        seed: num(op.seed, 11),
      });
      return true;
    }
    case 'god_rays': case 'godrays': case 'light_shaft': case 'rays': {
      cv.godRays({
        cx: X(op.cx ?? op.x ?? cv.w / 2),
        cy: Y(op.cy ?? op.y ?? 0),
        count: num(op.count, 7),
        spread: num(op.spread, 70),
        angle: num(op.angle, 90),
        length: num(op.length, cv.h * 1.4),
        color: op.color || '#fff3c4',
        alpha: op.alpha == null ? 70 : alpha,
        seed: num(op.seed, 5),
        width: num(op.width, 0.35),
      });
      return true;
    }
    case 'sun': case 'moon': case 'star_body': {
      cv.sun({
        cx: X(op.cx ?? op.x ?? cv.w * 0.75),
        cy: Y(op.cy ?? op.y ?? cv.h * 0.2),
        r: num(op.r ?? op.radius, Math.min(cv.w, cv.h) * 0.05),
        color: op.color || '#fff6d0',
        halo: op.halo || null,
        haloScale: num(op.haloScale, 6),
        haloAlpha: op.haloAlpha == null ? 60 : num(op.haloAlpha, 60),
      });
      return true;
    }
    case 'ground_shade': case 'shadow': case 'cast_shadow': {
      cv.groundShade({
        cx: X(op.cx ?? op.x ?? cv.w / 2),
        cy: Y(op.cy ?? op.y ?? cv.h * 0.75),
        rx: num(op.rx ?? op.w, cv.w * 0.06),
        ry: num(op.ry ?? op.h, Math.max(1, num(op.rx ?? op.w, cv.w * 0.06) * 0.28)),
        color: op.color || '#000000',
        alpha: op.alpha == null ? 90 : alpha,
      });
      return true;
    }
    case 'texture': case 'grain': case 'roughness': {
      cv.texture({
        x: op.x == null ? 0 : X(op.x),
        y: op.y == null ? 0 : Y(op.y),
        w: num(op.w, cv.w),
        h: num(op.h, cv.h),
        scale: num(op.scale ?? op.freq, 0.05),
        seed: num(op.seed, 17),
        amount: num(op.amount ?? op.strength, 0.18),
        octaves: num(op.octaves ?? op.oct, 3),
        light: op.light || '#ffffff',
        dark: op.dark || '#000000',
      });
      return true;
    }
    case 'vignette': case 'darken_edges': {
      cv.vignette(num(op.strength ?? op.amount, 0.4), op.color || '#000000');
      return true;
    }
    case 'blur': case 'soften': case 'gaussian_blur': {
      cv.blur(num(op.r ?? op.radius, 2), num(op.passes ?? op.times, 2));
      return true;
    }
    case 'posterize': case 'levels': case 'color_levels': {
      cv.posterize(num(op.levels ?? op.colors ?? op.n, 12), op.dither !== false);
      return true;
    }
    case 'resample': case 'resize_canvas': case 'canvas_scale': {
      const nw = num(op.w ?? op.width, cv.w);
      const nh = num(op.h ?? op.height, cv.h);
      if (!(nw > 0) || !(nh > 0)) return false;
      cv.resample(nw, nh, op.smooth === true || op.bilinear === true);
      return true;
    }

    default:
      return false;
  }
}

/** 批量执行，返回 { applied, bad } */
export function applyOps(cv, ops) {
  let applied = 0;
  const bad = [];
  for (const op of ops || []) {
    let ok = false;
    try { ok = applyOp(cv, op); } catch { ok = false; }
    if (ok) applied++;
    else bad.push(op);
  }
  return { applied, bad };
}

// ------------------------------------------------------------- ASCII 预览
/**
 * 缩略成最多 maxDim 列，用调色板索引 + '.' 表示透明，快速定位轮廓问题。
 * 颜色超过 16 种时不再一律打成 '?'（渐变背景会把整张预览糊成问号，
 * 那预览就等于没有），而是把相近的颜色聚成一档，保证每个像素都有索引。
 */
export function asciiPreview(cv, maxDim = 48) {
  const dim = Math.max(8, Math.min(maxDim, Math.max(cv.w, cv.h)));
  const stepX = cv.w / dim;
  const stepY = cv.h / dim;
  const hexAt = (x, y) => {
    const sx = Math.min(cv.w - 1, Math.floor(x * stepX));
    const sy = Math.min(cv.h - 1, Math.floor(y * stepY));
    const i = (sy * cv.w + sx) * 4;
    if (cv.data[i + 3] < 8) return null;
    return toHex([cv.data[i], cv.data[i + 1], cv.data[i + 2]]);
  };

  // 先扫一遍采样格，把相近颜色（RGB 距离 < 24）聚成同一档，最多 16 档
  const clusters = [];
  const near = (a, b) => {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return (A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2 < 576;
  };
  const cell = [];
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const hex = hexAt(x, y);
      cell.push(hex);
      if (!hex) continue;
      if (clusters.some((c) => c.hex === hex || near(c.hex, hex))) continue;
      if (clusters.length < 16) clusters.push({ hex, count: 1 });
    }
  }
  const palette = clusters.map((c) => c.hex);
  const idxOf = (hex) => {
    for (let k = 0; k < palette.length; k++) if (palette[k] === hex || near(palette[k], hex)) return k;
    return palette.length - 1;
  };
  const rows = [];
  for (let y = 0; y < dim; y++) {
    let row = '';
    for (let x = 0; x < dim; x++) {
      const hex = cell[y * dim + x];
      row += hex ? (idxOf(hex) & 0xf).toString(16) : '.';
    }
    rows.push(row);
  }
  return { dim, palette, rows };
}

export { lum };
