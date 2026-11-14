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
function rawRgba(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
  }
  return raw;
}
/** RGBA 像素缓冲 -> PNG Buffer */
export function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawRgba(w, h, rgba), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** 最近邻放大（像素画放大后边缘依然硬，适合人眼/模型观察） */
export function encodePngScaled(w, h, rgba, scale = 1) {
  const s = Math.max(1, Math.min(16, Math.round(scale)));
  if (s === 1) return encodePng(w, h, rgba);
  const W = w * s;
  const H = h * s;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / s);
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(x / s);
      const si = (sy * w + sx) * 4;
      const di = (y * W + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return encodePng(W, H, out);
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

// ------------------------------------------------------------------ 画板
export class Canvas {
  constructor(w, h) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
    this.pen = { x: Math.floor(this.w / 2), y: Math.floor(this.h / 2) };
  }
  clone() {
    const c = new Canvas(this.w, this.h);
    c.data.set(this.data);
    c.pen = { ...this.pen };
    return c;
  }
  /** 画点（alpha<255 时按 alpha 混合，便于做阴影/高光） */
  setPx(x, y, hex, alpha = 255) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b] = hexToRgb(hex);
    const i = (y * this.w + x) * 4;
    const a = Math.max(0, Math.min(255, Math.round(alpha)));
    if (a >= 255) {
      this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255;
      return;
    }
    if (a <= 0) return;
    const t = a / 255;
    const da = this.data[i + 3] / 255;
    const oa = t + da * (1 - t);
    if (oa <= 0) return;
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
  fillRect(x, y, w, h, c, alpha) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.setPx(xx, yy, c, alpha);
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
  fillEllipse(cx, cy, rx, ry, c, alpha) {
    rx = Math.max(0.5, Math.abs(rx));
    ry = Math.max(0.5, Math.abs(ry));
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.setPx(x, y, c, alpha);
      }
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
  fillPoly(pts, c, alpha) {
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
          if (x >= xs[k] - 0.5 && x <= xs[k + 1] + 0.5) this.setPx(x, y, c, alpha);
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
  /** 内描边：把已画区域的边缘 1px 换成描边色（不改变外轮廓尺寸） */
  outlineIn(c) {
    const src = new Uint8ClampedArray(this.data);
    const op = (x, y) => x >= 0 && y >= 0 && x < this.w && y < this.h && src[(y * this.w + x) * 4 + 3] > 8;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!op(x, y)) continue;
        if (!op(x - 1, y) || !op(x + 1, y) || !op(x, y - 1) || !op(x, y + 1)) this.setPx(x, y, c);
      }
    }
  }
  /** 外描边：在已画区域外面加一圈 1px 描边 */
  outlineOut(c) {
    const src = new Uint8ClampedArray(this.data);
    const op = (x, y) => x >= 0 && y >= 0 && x < this.w && y < this.h && src[(y * this.w + x) * 4 + 3] > 8;
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

// ------------------------------------------------------------- 操作解释器
const num = (v, f = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};
const norm = (name) => String(name || '').toLowerCase().replace(/[\s-]/g, '_');

/** 全量 op 名（主名 + 别名），报错时告诉模型它能用哪些 */
export const OP_NAMES = [
  'pixel', 'line', 'fill_rect', 'rect', 'fill_ellipse', 'ellipse',
  'fill_poly', 'flood_fill', 'outline_in', 'outline_out', 'gradient',
  'mirror_x', 'mirror_y', 'margin', 'shift', 'erase', 'clear',
  'palette', 'spray',
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
  const alpha = sp.alpha != null
    ? sp.alpha
    : op.alpha == null ? 255 : Math.max(0, Math.min(1, num(op.alpha, 1))) * 255;
  const ax = Array.isArray(op.anchor) ? num(op.anchor[0]) : 0;
  const ay = Array.isArray(op.anchor) ? num(op.anchor[1]) : 0;
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
      cv.fillRect(X(op.x), Y(op.y), num(op.w, 1), num(op.h, op.w ?? 1), c, alpha);
      return true;
    case 'rect': case 'stroke_rect': case 'outline_rect': case 'frame':
      cv.rect(X(op.x), Y(op.y), num(op.w, 1), num(op.h, op.w ?? 1), c, alpha);
      return true;
    case 'fill_ellipse': case 'ellipse_fill': case 'circle': case 'disc': case 'dot_round':
      cv.fillEllipse(X(op.cx ?? op.x), Y(op.cy ?? op.y), num(op.rx, op.r ?? 1), num(op.ry, op.rx ?? op.r ?? 1), c, alpha);
      return true;
    case 'ellipse': case 'stroke_ellipse': case 'ring': case 'circle_stroke':
      cv.ellipse(X(op.cx ?? op.x), Y(op.cy ?? op.y), num(op.rx, op.r ?? 1), num(op.ry, op.rx ?? op.r ?? 1), c, alpha);
      return true;
    case 'fill_poly': case 'polygon': case 'poly': case 'triangle':
      cv.fillPoly((op.pts || op.points || []).map(([x, y]) => [X(x), Y(y)]), c, alpha);
      return true;
    case 'flood_fill': case 'bucket': case 'fill_region':
      cv.floodFill(X(op.x), Y(op.y), c, alpha);
      return true;
    case 'outline': case 'outline_in': case 'stroke': case 'stroke_in':
      cv.outlineIn(c);
      return true;
    case 'outline_out': case 'stroke_out':
      cv.outlineOut(c);
      return true;
    case 'gradient': case 'gradient_rect': case 'gradient_vertical':
      cv.gradientRect(X(op.x), Y(op.y), num(op.w, cv.w), num(op.h, cv.h), op.top || op.color1 || c, op.bottom || op.color2 || shade(c, 0.6), alpha);
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
      cv.clearRegion(X(op.x), Y(op.y), num(op.w, 1), num(op.h, op.w ?? 1));
      return true;
    case 'clear': case 'reset':
      cv.clear();
      return true;
    case 'palette': case 'reduce_palette': case 'quantize':
      cv.reducePalette(num(op.colors ?? op.n, 16));
      return true;
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
