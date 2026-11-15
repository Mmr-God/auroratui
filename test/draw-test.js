// draw 插件测试：AI 不会画图也能画 —— 输出 op → 本地栅格化 → PNG → 图片直接进对话。
// 覆盖：图元/别名/锚点/镜像/擦除/调色板、配方 stamp、画板持久化、undo、
//       PNG 是合法 PNG、工具结果里挂着 meta.images（模型能直接看见）、save/scale/诊断。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-draw-'));
process.env.AGENT_HOME = HOME;
const NL = String.fromCharCode(10);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-draw-ws-'));

let failed = 0;
const log = (m = '') => fs.writeSync(1, m + NL);
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}

const { drawTool } = await import('../plugins/draw/index.js');
const { Canvas, applyOps, encodePng, asciiPreview, resolveColor, OP_NAMES, splitAlpha, cropCanvas } = await import('../plugins/draw/core.js');
const { drawRecipeInto, recipeKeys, SUBJECT_RECIPES } = await import('../plugins/draw/recipes.js');

const ctx = { cwd: WS };
const run = (input) => drawTool.execute(input, ctx);
const px = (cv, x, y) => {
  const i = (y * cv.w + x) * 4;
  return [cv.data[i], cv.data[i + 1], cv.data[i + 2], cv.data[i + 3]];
};

// ------------------------------------------------------------- 内核图元
{
  const cv = new Canvas(16, 16);
  check('新画布是透明的', cv.data.every((v) => v === 0));

  cv.pixel(3, 4, '#ff0000');
  check('pixel 落在正确的像素上', px(cv, 3, 4).join() === '255,0,0,255', px(cv, 3, 4).join());

  const r = applyOps(cv, [{ op: 'pixel', x: 1, y: 1, color: 'red' }, { op: 'bogus_op' }]);
  check('未知 op 被记为 bad', r.applied === 1 && r.bad.length === 1, JSON.stringify(r));

  check('OP_NAMES 里都是真 op', OP_NAMES.every((n) => applyOps(new Canvas(8, 8), [{ op: n }]).bad.length === 0), OP_NAMES.join(','));

  const cv2 = new Canvas(16, 16);
  applyOps(cv2, [{ op: 'rectangle', x: 2, y: 2, w: 5, h: 5, color: 'blue' }]); // 拼错的别名
  check('拼错的 op 名不会被悄悄执行', cv2.countOpaque() === 0);
}

// --------------------------------------------------------- 别名/锚点/镜像
{
  const a = new Canvas(20, 20);
  applyOps(a, [{ op: 'circle', cx: 10, cy: 10, r: 4, color: '#00ff00' }]); // fill_ellipse 别名
  check('circle 别名画成实心圆', a.countOpaque() > 30, String(a.countOpaque()));

  const b = new Canvas(20, 20);
  applyOps(b, [{ op: 'fill_rect', anchor: [5, 5], x: 0, y: 0, w: 3, h: 3, color: '#f00' }]);
  check('anchor 相对坐标生效', px(b, 5, 5)[3] === 255 && px(b, 0, 0)[3] === 0);

  const c = new Canvas(21, 21);
  applyOps(c, [{ op: 'fill_rect', x: 0, y: 0, w: 10, h: 21, color: '#0f0' }, { op: 'mirror_x' }]);
  check('mirror_x 把左边映到右边', px(c, 0, 5)[3] === 255 && px(c, 20, 5)[3] === 255, `${px(c, 0, 5)[3]}/${px(c, 20, 5)[3]}`);
  check('mirror_x 后左右对称度 100%', Math.round(c.symmetry() * 100) === 100, String(c.symmetry()));

  const d = new Canvas(10, 10);
  applyOps(d, [{ op: 'fill_rect', x: 0, y: 0, w: 10, h: 10, color: 'white' }]);
  check('全白后再 erase 变透明', (applyOps(d, [{ op: 'erase', x: 0, y: 0, w: 5, h: 10 }]), d.countOpaque() === 50), String(d.countOpaque()));

  const e = new Canvas(8, 8);
  applyOps(e, [{ op: 'fill_rect', x: 0, y: 0, w: 8, h: 8, color: '#123456' }, { op: 'palette', colors: 2 }]);
  check('palette 量化不炸', e.countOpaque() === 64);

  const f = new Canvas(9, 9);
  applyOps(f, [{ op: 'fill_rect', x: 0, y: 0, w: 3, h: 3, color: '#f00' }, { op: 'margin' }]);
  const box = f.bbox();
  check('margin 把贴边主体推进来留 1px', !!box && box.minX === 1 && box.minY === 1, JSON.stringify(box));
  check('margin 不会动本来就有留白的主体', (() => {
    const g = new Canvas(9, 9);
    applyOps(g, [{ op: 'fill_rect', x: 3, y: 3, w: 3, h: 3, color: '#f00' }, { op: 'margin' }]);
    const b = g.bbox();
    return b.minX === 3 && b.minY === 3;
  })());

  const g = new Canvas(9, 9);
  applyOps(g, [{ op: 'fill_rect', x: 0, y: 0, w: 2, h: 2, color: '#f00' }, { op: 'shift', dx: 3, dy: 3 }]);
  check('shift 平移整块', px(g, 3, 3)[3] === 255 && px(g, 0, 0)[3] === 0);

  const h = new Canvas(10, 10);
  applyOps(h, [{ op: 'fill_rect', x: 0, y: 0, w: 10, h: 10, color: '#fff' }, { op: 'outline_in', color: '#000' }]);
  check('outline_in 给内容描内边', px(h, 0, 0).slice(0, 3).join() === '0,0,0');
}

// -------------------------------------------------------------- 颜色工具
check('resolveColor 支持速记名', resolveColor('sky') !== resolveColor('nope') && /^#[0-9a-f]{6}$/i.test(resolveColor('sky')));
check('resolveColor 透传 #rrggbb', resolveColor('#a855f7') === '#a855f7');

// ------------------------------------------------ 8 位 alpha（#rrggbbaa）
{
  const a = splitAlpha('#00000055');
  check('splitAlpha 拆出 rrggbb + alpha', a.hex === '#000000' && a.alpha === 85, JSON.stringify(a));
  const b = splitAlpha('#f00a');
  check('splitAlpha 支持 4 位 #rgba', b.hex === '#ff0000' && b.alpha === 170, JSON.stringify(b));
  check('splitAlpha 对 6 位颜色返回 alpha=null', splitAlpha('#ff0000').alpha === null);
  const cv = new Canvas(8, 8);
  applyOps(cv, [{ op: 'fill_rect', x: 0, y: 0, w: 8, h: 8, color: '#00000055' }]);
  check('半透明色真的写成半透明（不是死黑）', px(cv, 2, 2)[3] === 85, String(px(cv, 2, 2)[3]));
}

// ------------------------------------------------------- crop 局部裁剪
{
  const cv = new Canvas(16, 16);
  applyOps(cv, [{ op: 'pixel', x: 3, y: 4, color: '#ff0000' }]);
  const c = cropCanvas(cv, 2, 3, 4, 4);
  check('cropCanvas 尺寸正确', c.w === 4 && c.h === 4, `${c.w}x${c.h}`);
  check('cropCanvas 平移了像素', px(c, 1, 1).join() === '255,0,0,255', px(c, 1, 1).join());
  const oob = cropCanvas(cv, -5, -5, 4, 4);
  check('cropCanvas 越界自动夹紧', oob.w >= 1 && oob.h >= 1, `${oob.w}x${oob.h}`);
}

// ------------------------------------------------------------------ PNG
{
  const cv = new Canvas(4, 4);
  applyOps(cv, [{ op: 'fill_rect', x: 0, y: 0, w: 4, h: 4, color: '#3b82f6' }]);
  const png = encodePng(4, 4, cv.data);
  check('PNG 魔数正确', png.slice(0, 4).toString('hex') === '89504e47');
  check('PNG 尺寸写在 IHDR 里', png.readUInt32BE(16) === 4 && png.readUInt32BE(20) === 4);
  const ihdr = png.slice(8, 8 + 4 + 4 + 13);
  check('PNG 是 8bit RGBA', ihdr[8 + 8] === 8 && ihdr[8 + 9] === 6, `${ihdr[8 + 8]}bit type ${ihdr[8 + 9]}`);
  check('PNG 以 IEND 结尾', png.slice(-8, -4).toString('ascii') === 'IEND');
}

// ------------------------------------------------------------------ 配方
check('配方数量 >= 18', recipeKeys().length >= 18, String(recipeKeys().length));
{
  const cv = new Canvas(32, 32);
  check('stamp penguin 成功', drawRecipeInto(cv, 'penguin'));
  check('stamp 后有不透明像素', cv.countOpaque() > 100, String(cv.countOpaque()));
  check('未知配方返回 false', drawRecipeInto(new Canvas(32, 32), 'not-a-recipe') === false);
  const cv2 = new Canvas(32, 32);
  drawRecipeInto(cv2, 'slime', { main: '#a855f7' });
  const hasPurple = Array.from({ length: 32 * 32 }, (_, i) => {
    const o = i * 4;
    return cv2.data[o + 3] > 200 && cv2.data[o] > 130 && cv2.data[o + 2] > 200;
  }).some(Boolean);
  check('配方支持换主色', hasPurple);
}

// ------------------------------------------------------- ASCII 预览可用
{
  const cv = new Canvas(16, 16);
  applyOps(cv, [{ op: 'fill_rect', x: 4, y: 4, w: 8, h: 8, color: '#ffffff' }]);
  const pv = asciiPreview(cv, 16);
  check('ASCII 预览行列数正确', pv.rows.length === 16 && pv.rows.every((r) => r.length === 16));
  check('透明处是 .', pv.rows[0][0] === '.', pv.rows[0]);
  check('画过的地方是调色板索引', /[0-9a-f]/.test(pv.rows[8][8]), pv.rows[8]);
}

// ------------------------------------------------- 工具层：画 + 直接给图
let r = await run({ name: 'smoke', size: 32, ops: [{ op: 'stamp', recipe: 'penguin' }] });
check('draw 返回对象（带 content/meta）', r && typeof r.content === 'string' && r.meta, typeof r);
check('PNG 落盘到 <cwd>/drawings', fs.existsSync(path.join(WS, 'drawings', 'smoke.png')));
check('工具结果挂着图片（模型能直接看见）', Array.isArray(r.meta.images) && r.meta.images[0].mime === 'image/png');
check('挂的 base64 是真 PNG', Buffer.from(r.meta.images[0].base64, 'base64').slice(0, 4).toString('hex') === '89504e47');
check('meta.kind = image（界面标 [图片]）', r.meta.kind === 'image');
check('报告里有包围盒与配色', /包围盒/.test(r.content) && /配色/.test(r.content));
check('默认不返回 ASCII 预览（省字符）', !/ASCII 预览/.test(r.content), String(r.content.length));
const withAscii = await run({ name: 'smoke', view: true, ascii: true });
check('ascii:true 时才给 ASCII 预览', /ASCII 预览/.test(withAscii.content));

// ------------------------------------------------ 同名画板接着改 + undo
const before = r.meta.bytes;
r = await run({ name: 'smoke', ops: [{ op: 'fill_rect', x: 0, y: 0, w: 6, h: 6, color: '#ff0000' }] });
check('同名画板沿用上次画面', /沿用 32×32/.test(r.content), r.content.split(NL)[0]);
check('继续画会改变画面', r.meta.bytes !== before || /应用 1 条 op/.test(r.content));

r = await run({ name: 'smoke', undo: 1 });
check('undo 能回退', /回退|沿用/.test(r.content), r.content.split(NL).slice(0, 3).join(' | '));

// --------------------------------------------------------- view / scale / save
const viewOnly = await run({ name: 'smoke', view: true });
check('view 不改画面但给图', viewOnly.meta.images?.[0] && /沿用/.test(viewOnly.content));

const scaled = await run({ name: 'smoke', view: true, scale: 4 });
check('scale 放大导出', scaled.meta.images[0].width === 32 * 4 && scaled.meta.images[0].height === 32 * 4, `${scaled.meta.images[0].width}`);

const saved = await run({ name: 'smoke', view: true, save: 'assets/out.png' });
check('save 另存一份', fs.existsSync(path.join(WS, 'assets', 'out.png')));

// ------------------------------------------------- crop 只导出局部、不动画板
{
  const full = await run({ name: 'zoom', size: 32, ops: [{ op: 'fill_rect', x: 0, y: 0, w: 32, h: 32, color: '#123456' }, { op: 'pixel', x: 16, y: 16, color: '#ffffff' }], view: true });
  const zn = await run({ name: 'zoom', view: true, crop: { x: 14, y: 14, w: 6, h: 6 }, scale: 8 });
  check('crop 导出的图是裁剪块 × scale', zn.meta.images[0].width === 48 && zn.meta.images[0].height === 48, `${zn.meta.images[0].width}x${zn.meta.images[0].height}`);
  check('crop 的文件名带 _cropWxH', fs.existsSync(path.join(WS, 'drawings', 'zoom_crop6x6.png')));
  check('crop 报告说明是局部放大', /局部放大/.test(zn.content), zn.content.split(NL).find((l) => /局部/.test(l)) || '');
  check('crop 不改画板（meta 仍是原画板尺寸）', /^zoom 32×32/.test(zn.meta.summary), zn.meta.summary);
  check('crop 后全图导出依旧 32×32', full.meta.images[0].width === 32, String(full.meta.images[0].width));
}

// ------------------------------------------------------------- 尺寸边界
const tiny = await run({ name: 'tiny', size: 4 });
check('size 被夹到下限 8', /8×8/.test(tiny.content), tiny.content.split(NL)[0]);
const huge = await run({ name: 'huge', size: 9999 });
check('size 被夹到上限 256', /256×256/.test(huge.content), huge.content.split(NL)[0]);

// ------------------------------------------------------- 坏 op 给出可读提示
const badOp = await run({ name: 'bad', ops: [{ op: 'fill_rectt', x: 1, y: 1, w: 2, h: 2 }] });
check('坏 op 报错并列出可用 op 名', /没执行/.test(badOp.content) && /可用的 op 名/.test(badOp.content), badOp.content.split(NL).find((l) => /没执行/.test(l)) || '');
const badStamp = await run({ name: 'bad', ops: [{ op: 'stamp', recipe: 'dragon' }] });
check('坏配方名列出全部配方', /未知配方 dragon/.test(badStamp.content), badStamp.content.split(NL).find((l) => /未知配方/.test(l)) || '');

// ------------------------------------------------- 画板文件可跨进程读回
const saved2 = JSON.parse(fs.readFileSync(path.join(HOME, 'draw', 'smoke.json'), 'utf8'));
check('画板存成 json（含像素与历史）', saved2.w === 32 && typeof saved2.data === 'string' && Array.isArray(saved2.history));
check('画板 base64 长度匹配像素数', Buffer.from(saved2.data, 'base64').length === 32 * 32 * 4);

// --------------------------------------------------------- 诊断会点出问题
const empty = await run({ name: 'empty', view: true });
check('空画板给出提示', /空的/.test(empty.content), empty.content.split(NL).find((l) => /空的/.test(l)) || '');

// --------------------------------- 有背景时不误报「主体贴边 / 配色脏」
{
  const bg = await run({
    name: 'bgscene',
    size: 64,
    ops: [
      { op: 'gradient', x: 0, y: 0, w: 64, h: 64, top: '#7dd3fc', bottom: '#1e3a8a' },
      { op: 'stamp', recipe: 'slime', size: 28, x: 18, y: 22 },
    ],
    view: true,
    ascii: true,
  });
  check('识别出背景并单独算主体', /检测到底色\/背景/.test(bg.content) && /主体包围盒/.test(bg.content), bg.content.split(NL).find((l) => /背景/.test(l)) || '');
  check('有背景时不喊「主体贴到画布边缘」', !/主体贴到画布边缘/.test(bg.content));
  check('有背景时配色阈值放宽到 64 色', !/超过 16 色会显得脏/.test(bg.content));
  check('ASCII 预览不出现 ? 号', !/\?/.test(bg.content.split('ASCII 预览')[1] || ''));
}

// --------------------------------------------------------- 配方全都能 stamp
{
  const bad = [];
  for (const rec of SUBJECT_RECIPES) {
    const cv = new Canvas(48, 48);
    if (!drawRecipeInto(cv, rec.key) || cv.countOpaque() === 0) bad.push(rec.key);
  }
  check('所有配方都能画出东西', bad.length === 0, bad.join(','));
}

// ------------------------------------------- 选区 select / 区域复制 copy_region
{
  const cv = new Canvas(16, 16);
  applyOps(cv, [{ op: 'fill_rect', x: 0, y: 0, w: 16, h: 16, color: '#111111' }]);
  applyOps(cv, [{ op: 'select', x: 4, y: 4, w: 6, h: 6 }]);
  applyOps(cv, [{ op: 'fill_rect', x: 0, y: 0, w: 16, h: 16, color: '#ff0000' }]);
  check('选中后只有选区内被画到', px(cv, 5, 5).join() === '255,0,0,255' && px(cv, 1, 1).join() === '17,17,17,255', `${px(cv, 5, 5)} / ${px(cv, 1, 1)}`);
  applyOps(cv, [{ op: 'select_none' }]);
  applyOps(cv, [{ op: 'fill_rect', x: 0, y: 0, w: 2, h: 2, color: '#00ff00' }]);
  check('取消选区后恢复全画布可画', px(cv, 1, 1).join() === '0,255,0,255', px(cv, 1, 1).join());

  const cv2 = new Canvas(16, 16);
  applyOps(cv2, [
    { op: 'fill_rect', x: 2, y: 2, w: 4, h: 4, color: '#0000ff' },
    { op: 'copy_region', sx: 2, sy: 2, w: 4, h: 4, dx: 9, dy: 9 },
  ]);
  check('copy_region 把块复制到新位置', px(cv2, 10, 10).join() === '0,0,255,255' && px(cv2, 3, 3).join() === '0,0,255,255');
  const cv3 = new Canvas(16, 16);
  applyOps(cv3, [
    { op: 'fill_rect', x: 0, y: 4, w: 3, h: 4, color: '#ffffff' },
    { op: 'copy_region', sx: 0, sy: 4, w: 3, h: 4, dx: 9, dy: 4, flip_x: true },
  ]);
  check('copy_region 支持 flip_x', px(cv3, 9, 4).join() === '255,255,255,255' && px(cv3, 11, 4).join() === '255,255,255,255');
}

// ----------------------------------------------- 自动配色 auto_outline/auto_shade
{
  const cv = new Canvas(32, 32);
  applyOps(cv, [{ op: 'fill_ellipse', cx: 16, cy: 16, rx: 12, ry: 12, color: '#3b82f6' }]);
  const dark = cv.autoOutline(0.3);
  check('auto_outline 由主色推出更暗的描边色', resolveColor(dark) !== '#3b82f6' && /^#[0-9a-f]{6}$/.test(dark), dark);
  const edge = px(cv, 16, 4);
  check('auto_outline 真的把边缘换成描边色', `#${edge.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}` === dark, edge.join());

  const cv2 = new Canvas(32, 32);
  applyOps(cv2, [{ op: 'fill_rect', x: 0, y: 0, w: 32, h: 32, color: '#3b82f6' }]);
  cv2.autoShade(0.3);
  const top = px(cv2, 16, 1);
  const bot = px(cv2, 16, 30);
  check('auto_shade 上亮下暗', top[0] + top[1] + top[2] > bot[0] + bot[1] + bot[2], `${top} vs ${bot}`);

  // 细节不该被 auto_shade 洗掉
  const cv3 = new Canvas(32, 32);
  applyOps(cv3, [
    { op: 'fill_rect', x: 0, y: 0, w: 32, h: 32, color: '#3b82f6' },
    { op: 'fill_rect', x: 14, y: 14, w: 4, h: 4, color: '#ffffff' },
  ]);
  cv3.autoShade(0.4);
  check('auto_shade 保留对比色细节（白点仍是白的）', px(cv3, 15, 15).join() === '255,255,255,255', px(cv3, 15, 15).join());
}

// ------------------------------------------------------ 变换 rotate/scale/flip
{
  const cv = new Canvas(8, 4);
  applyOps(cv, [{ op: 'fill_rect', x: 0, y: 0, w: 2, h: 1, color: '#ff0000' }]);
  applyOps(cv, [{ op: 'rotate', deg: 90 }]);
  check('rotate 90 交换长宽', cv.w === 4 && cv.h === 8, `${cv.w}x${cv.h}`);
  check('rotate 90 后左上角的块跑到右上角', px(cv, 3, 0).join() === '255,0,0,255', px(cv, 3, 0).join());

  const cv2 = new Canvas(8, 4);
  applyOps(cv2, [{ op: 'fill_rect', x: 0, y: 0, w: 2, h: 1, color: '#ff0000' }]);
  applyOps(cv2, [{ op: 'flip_h' }]);
  check('flip_h 左右翻转', px(cv2, 7, 0).join() === '255,0,0,255' && px(cv2, 0, 0).join() !== '255,0,0,255');

  const cv3 = new Canvas(8, 8);
  applyOps(cv3, [{ op: 'fill_rect', x: 2, y: 2, w: 2, h: 2, color: '#00ff00' }]);
  const before3 = cv3.countOpaque();
  applyOps(cv3, [{ op: 'scale', k: 2 }]);
  check('scale 2× 后内容面积变大（以内容为中心缩放）', cv3.countOpaque() > before3 && cv3.countOpaque() >= before3 * 3, `${before3} → ${cv3.countOpaque()}`);
}

// ------------------------------------------------------------ grid 导出坐标网格
{
  const g = await run({ name: 'gridtest', size: 16, ops: [{ op: 'pixel', x: 0, y: 0, color: '#ffffff' }], view: true, grid: 4 });
  check('grid 导出文件名带 _grid', fs.existsSync(path.join(WS, 'drawings', 'gridtest_grid.png')), g.meta.path);
  check('grid 不改画板（meta 尺寸不变）', /^gridtest 16×16/.test(g.meta.summary), g.meta.summary);
  const nogrid = await run({ name: 'gridtest', view: true });
  check('不传 grid 时文件名不带 _grid', !/_grid/.test(nogrid.meta.path), nogrid.meta.path);
  check('grid 覆盖的像素不污染画板存档', (() => {
    const b = JSON.parse(fs.readFileSync(path.join(HOME, 'draw', 'gridtest.json'), 'utf8'));
    const buf = Buffer.from(b.data, 'base64');
    return buf[3] === 255 && buf[4] === 0; // 只有 (0,0) 那一个白点，没有品红
  })());
}

// ------------------------------------------------ noise 与 spray 同义
{
  const a = new Canvas(32, 32);
  const b = new Canvas(32, 32);
  applyOps(a, [{ op: 'spray', cx: 16, cy: 16, r: 8, count: 20, seed: 7, color: '#ffffff' }]);
  applyOps(b, [{ op: 'noise', cx: 16, cy: 16, r: 8, count: 20, seed: 7, color: '#ffffff' }]);
  check('noise 是 spray 的别名（同 seed 结果一致）', a.countOpaque() === b.countOpaque() && a.countOpaque() > 0, `${a.countOpaque()} vs ${b.countOpaque()}`);
  const c = new Canvas(32, 32);
  applyOps(c, [{ op: 'noise', cx: 16, cy: 16, r: 8, count: 20, seed: 7, color: '#ffffff' }]);
  check('同 seed 的 noise 结果确定', c.countOpaque() === b.countOpaque());
}

log(failed ? `\n${failed} 项失败` : '\nALL DRAW CHECKS PASSED');
process.exit(failed ? 1 : 0);
