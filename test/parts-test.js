// 部件库测试：AI 画 1~2px 的细节时不该手算坐标，改用 part 拼装。
// 覆盖：每个部件都能画、别名、variant、换色、flip、anchor、坏部件报错、以及
// 「贴上去真的落在画板对应位置」这个定位契约。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-parts-'));
process.env.AGENT_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-parts-ws-'));

const { drawTool } = await import('../plugins/draw/index.js');
const { PARTS, PART_KEYS, findPart, drawPartInto, partKeys } = await import('../plugins/draw/parts.js');
const { Canvas, applyOps } = await import('../plugins/draw/core.js');

let failed = 0;
const log = (m = '') => fs.writeSync(1, m + '\n');
function check(name, ok, detail = '') {
  if (ok) return log(`√ ${name}${detail ? ` — ${detail}` : ''}`);
  failed++;
  log(`× ${name}${detail ? ` — ${detail}` : ''}`);
}

const run = (input) => drawTool.execute({ name: 'p', size: 64, ...input }, { cwd: WS });
const opaque = (cv) => cv.countOpaque();

// ------------------------------------------------------- 部件清单与别名
check('部件数量 ≥ 17', PARTS.length >= 17, String(PARTS.length));
check('每个部件都有 key/label/hint', PARTS.every((r) => r.key && r.label && r.hint));
check('部件 key 唯一', new Set(PART_KEYS).size === PART_KEYS.length);
check('别名 eye → eyes', findPart('eye')?.key === 'eyes');
check('别名 wing → wings', findPart('wing')?.key === 'wings');
check('大小写不敏感', findPart('EYES')?.key === 'eyes');
check('未知部件返回 null', findPart('unicorn') === null);
check(
  'partKeys 带 variant 列表',
  partKeys().find((r) => r.key === 'eyes').variants.includes('round') && partKeys().find((r) => r.key === 'crown').variants.length === 0,
);

// -------------------------------------------------- 每个部件都能画出像素
{
  const empty = [];
  for (const rec of PARTS) {
    const cv = new Canvas(64, 64);
    drawPartInto(cv, rec.key, { size: 40 });
    if (!opaque(cv)) empty.push(rec.key);
  }
  check('所有部件都能画出不透明像素', empty.length === 0, empty.join(','));
}

// ---------------------------------------------------- 每个 variant 都不为空
{
  const empty = [];
  for (const rec of PARTS) {
    for (const v of rec.variants || []) {
      const cv = new Canvas(64, 64);
      drawPartInto(cv, rec.key, { size: 40, variant: v });
      if (!opaque(cv)) empty.push(`${rec.key}:${v}`);
    }
  }
  check('所有 variant 都能画出像素', empty.length === 0, empty.join(','));
}

// -------------------------------------------------- 定位：x/y 落在画板对应位置
{
  const cv = new Canvas(64, 64);
  drawPartInto(cv, 'crown', { x: 10, y: 4, size: 20, origin: 'top-left' });
  const box = cv.bbox();
  check('part 传 origin:top-left 时按左上角定位', box.minX >= 10 && box.minX <= 13 && box.minY >= 4 && box.minY <= 7, JSON.stringify(box));
  check('part 尺寸受 size 限制', box.maxX - box.minX <= 21 && box.maxY - box.minY <= 21, `${box.w}x${box.h}`);
  // 默认：x/y 是部件中心点（眼睛这种细节对齐最直觉）
  const cvC = new Canvas(64, 64);
  drawPartInto(cvC, 'crown', { x: 32, y: 32, size: 20 });
  const bc = cvC.bbox();
  const ccx = (bc.minX + bc.maxX) / 2, ccy = (bc.minY + bc.maxY) / 2;
  check('part 默认把 x/y 当中心点', Math.abs(ccx - 32) <= 2 && Math.abs(ccy - 32) <= 2, `实际中心 ${ccx},${ccy}`);
}

// ------------------------------------------------------------- 镜像语义
{
  const cv = new Canvas(64, 64);
  drawPartInto(cv, 'ears', { size: 64 });
  const box = cv.bbox();
  check('对称部件左右铺开（有两只耳）', box.minX < 16 && box.maxX > 47, `${box.minX}~${box.maxX}`);
  check('对称部件左右基本对称', cv.symmetry() > 0.95, cv.symmetry().toFixed(2));
}
{
  const cv = new Canvas(64, 64);
  drawPartInto(cv, 'tail', { size: 64 });
  const box = cv.bbox();
  check('不对称部件（tail）只贴一边', box.maxX > box.minX + 10 && box.minX < 64 * 0.5, `${box.minX}~${box.maxX}`);
}
{
  // flip 应该把 tail 翻到另一侧
  const a = new Canvas(64, 64);
  const b = new Canvas(64, 64);
  drawPartInto(a, 'tail', { size: 64 });
  drawPartInto(b, 'tail', { size: 64, flip: true });
  const ba = a.bbox();
  const bb = b.bbox();
  check('flip 把不对称部件翻到另一侧', bb.minX > ba.minX + 3, `${ba.minX} → ${bb.minX}`);
}
{
  // wink 是左开右闭，不能被镜像拉成两个睁眼
  const cv = new Canvas(64, 64);
  drawPartInto(cv, 'eyes', { size: 64, variant: 'wink' });
  check('wink 拒绝镜像（左右不对称）', cv.symmetry() < 0.95, cv.symmetry().toFixed(2));
}

// --------------------------------------------------------------- 换色生效
{
  const red = new Canvas(32, 32);
  drawPartInto(red, 'crown', { size: 32, color: '#ff0000' });
  let reds = 0;
  for (let i = 0; i < red.data.length; i += 4) {
    if (red.data[i + 3] > 8 && red.data[i] > 200 && red.data[i + 1] < 60) reds++;
  }
  check('color 覆盖主色', reds > 20, String(reds));
}

// ------------------------------------------------ 走工具：part op 全链路
{
  const r = await run({ name: 'chain', ops: [{ op: 'part', part: 'crown', x: 10, y: 6, size: 40 }] });
  check('part op 被计入 applied', /应用 1 条 op/.test(r.content), r.content.split('\n')[0]);
  check('part op 产出图片', Array.isArray(r.meta.images));
}
{
  const r = await run({ name: 'alias', ops: [{ op: 'part', part: 'eye', size: 30 }] });
  check('part op 支持别名', /应用 1 条 op/.test(r.content), r.content.split('\n')[0]);
}
{
  const r = await run({ name: 'anchor', ops: [{ op: 'part', part: 'crown', anchor: [20, 10], x: 0, y: 0, size: 16, origin: 'top-left' }] });
  check('part 支持 anchor 相对坐标', /应用 1 条 op/.test(r.content));
  const board = JSON.parse(fs.readFileSync(path.join(HOME, 'draw', 'anchor.json'), 'utf8'));
  const cv = new Canvas(board.w, board.h);
  // 存档格式已改成 deflate 压缩的 z 字段（大画布裸 base64 太大），
  // 测试必须同时兼容 z / 旧的 data，否则这里 Buffer.from(undefined) 直接抛错。
  cv.data.set(board.z ? zlib.inflateSync(Buffer.from(board.z, 'base64')) : Buffer.from(board.data, 'base64'));
  const box = cv.bbox();
  check('anchor + x/y 生效（落点右移）', box.minX >= 19 && box.minX <= 21, JSON.stringify(box));
}
{
  const r = await run({ name: 'bad', ops: [{ op: 'part', part: 'unicorn' }] });
  check('未知部件报错并列出可用部件', /未知部件 unicorn/.test(r.content) && /eyes/.test(r.content), r.content.split('\n').find((l) => /未知部件/.test(l)) || '');
}
{
  // attach 是 part 的别名
  const r = await run({ name: 'attach', ops: [{ op: 'attach', part: 'halo', size: 24 }] });
  check('attach 是 part 的别名', /应用 1 条 op/.test(r.content));
}
{
  // 一次贴多个部件
  const r = await run({
    name: 'multi',
    ops: [
      { op: 'part', part: 'wings', size: 50 },
      { op: 'part', part: 'eyes', variant: 'round', x: 20, y: 24, size: 24 },
      { op: 'part', part: 'mouth', variant: 'cat', x: 24, y: 36, size: 16 },
    ],
  });
  check('一轮贴多个部件', /应用 3 条 op/.test(r.content), r.content.split('\n')[0]);
}

// ------------------------------------------- 工具说明里列出部件（模型看得到）
check('工具说明含 part op 用法', /"op":"part"/.test(drawTool.description));
check('工具说明列出了全部部件名', PART_KEYS.every((k) => drawTool.description.includes(k)));

// ------------------------------------------- 自动贴位置：不传 x/y 就按部件性格落位
{
  // 一个「头大身子小」的主体：眼睛应该落在上半部，而不是画布正中
  const mk = () => {
    const cv = new Canvas(64, 64);
    applyOps(cv, [{ op: 'fill_ellipse', cx: 32, cy: 40, rx: 20, ry: 20, color: '#3b82f6' }]);
    return cv;
  };
  const subj = { minX: 12, minY: 20, maxX: 51, maxY: 59 };

  // 只量「部件画上去的那部分」：先记下快照，贴完只看变化过的像素
  const hitBox = (before, after) => {
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < after.h; y++) {
      for (let x = 0; x < after.w; x++) {
        const i = (y * after.w + x) * 4;
        const same = before.data[i] === after.data[i] && before.data[i + 3] === after.data[i + 3];
        if (same) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };
  const snap = (cv) => cv.clone();

  const cvE = mk();
  const snapE = snap(cvE);
  drawPartInto(cvE, 'eyes', { size: 16 });
  const be = hitBox(snapE, cvE);
  check('eyes 不传 x/y 时落在主体上半部（不是画布正中）', be.minY < 40 && be.maxY < 50, JSON.stringify(be));
  check('eyes 不传 x/y 时水平居中', Math.abs((be.minX + be.maxX) / 2 - 32) <= 3, `${(be.minX + be.maxX) / 2}`);

  const cvM = mk();
  const snapM = snap(cvM);
  drawPartInto(cvM, 'mouth', { size: 12 });
  const bm = hitBox(snapM, cvM);
  check('mouth 不传 x/y 时落在眼下（主体 68% 高度附近）', (bm.minY + bm.maxY) / 2 > 45, `${(bm.minY + bm.maxY) / 2}`);

  // 帽子靠 hang:bottom 贴在主体头顶外，而不是盖在脸上
  const cvH = new Canvas(64, 64);
  applyOps(cvH, [{ op: 'fill_rect', x: 20, y: 24, w: 24, h: 30, color: '#3b82f6' }]);
  const snapH = snap(cvH);
  drawPartInto(cvH, 'hat', { size: 32, variant: 'top' });
  const bh = hitBox(snapH, cvH);
  check('hat 不传 x/y 时戴在主体头顶（不压脸）', bh.minY < 24, `${bh.minY}~${bh.maxY}`);

  // 显式给 x/y 时仍然以它为准，不被 auto 覆盖
  const cvX = mk();
  const snapX = snap(cvX);
  drawPartInto(cvX, 'eyes', { size: 10, x: 20, y: 50 });
  const bx = hitBox(snapX, cvX);
  check('显式 x/y 优先于 auto 自动落位', Math.abs((bx.minX + bx.maxX) / 2 - 20) <= 3, `${(bx.minX + bx.maxX) / 2}`);

  // 头顶堆叠两件（耳朵 + 皇冠）：不能都贴主体顶，不然完全重叠
  const cvS = new Canvas(64, 64);
  applyOps(cvS, [{ op: 'fill_rect', x: 20, y: 26, w: 24, h: 28, color: '#4ade80' }]);
  drawPartInto(cvS, 'ears', { size: 20, variant: 'cat' });
  const snap1 = cvS.clone();
  drawPartInto(cvS, 'crown', { size: 16 });
  const bcrown = hitBox(snap1, cvS);
  check('头顶已有东西时，第二件继续往上堆而不是重叠', bcrown.maxY < 26, `${bcrown.minY}~${bcrown.maxY}`);

  // 空画板时 auto 不能报错，退回画布中心
  const cvEmpty = new Canvas(64, 64);
  const okEmpty = drawPartInto(cvEmpty, 'eyes', { size: 12 });
  check('空画板贴部件不报错（auto 退回中心）', okEmpty === true && cvEmpty.countOpaque() > 0);

  void subj;
}

log(failed ? `\n${failed} check(s) failed` : '\nALL PARTS CHECKS PASSED');
process.exit(failed ? 1 : 0);
