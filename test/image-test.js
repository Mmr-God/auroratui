// 图片读取测试：read 工具能把图片交给模型（识图）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-img-'));
const NL = String.fromCharCode(10);
const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const TMP = path.join(cwd, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const log = (m = '') => process.stdout.write(m + NL);
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}

// ---- 造几张测试图片（纯手写，无依赖）-------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w || 0;
      raw[o + 1] = (y * 255) / h || 0;
      raw[o + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const pngBig = makePng(800, 600);
const pngSmall = makePng(1, 1);
fs.writeFileSync(path.join(TMP, 'big.png'), pngBig);
fs.writeFileSync(path.join(TMP, 'small.png'), pngSmall);
// GIF 89a 1x1
fs.writeFileSync(path.join(TMP, 'dot.gif'), Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.alloc(20)]));
// BMP 4x2
const bmp = Buffer.alloc(70);
bmp.write('BM', 0, 'ascii');
bmp.writeInt32LE(4, 18);
bmp.writeInt32LE(2, 22);
fs.writeFileSync(path.join(TMP, 'tiny.bmp'), bmp);
fs.writeFileSync(path.join(TMP, 'note.txt'), 'hello 文本');

const { readTool, imageSize } = await import('../src/tools/fs.js');
const { ContextEngine } = await import('../src/context/engine.js');
const { streamChat } = await import('../src/llm.js');

// ---- 尺寸解析 -------------------------------------------------------------
check('PNG 尺寸解析', (() => {
  const s = imageSize(pngBig);
  return s && s.width === 800 && s.height === 600;
})(), JSON.stringify(imageSize(pngBig)));
check('GIF 尺寸解析', (() => {
  const s = imageSize(fs.readFileSync(path.join(TMP, 'dot.gif')));
  return s && s.width === 1 && s.height === 1;
})());
check('BMP 尺寸解析', (() => {
  const s = imageSize(fs.readFileSync(path.join(TMP, 'tiny.bmp')));
  return s && s.width === 4 && s.height === 2;
})(), JSON.stringify(imageSize(fs.readFileSync(path.join(TMP, 'tiny.bmp')))));
check('普通文本不误判', imageSize(Buffer.from('hello world')) === null);

// ---- read 工具读图片 ------------------------------------------------------
const r1 = await readTool.execute({ path: path.join(TMP, 'big.png') }, { cwd });
check('read 图片不报二进制错误', !r1.isError, r1.content.slice(0, 60));
check('read 返回 image meta', r1.meta?.kind === 'image');
check('read 带上 mime 与 base64', r1.meta.images?.[0]?.mime === 'image/png' && r1.meta.images[0].base64.length > 100);
check('base64 是真 PNG', Buffer.from(r1.meta.images[0].base64, 'base64').slice(0, 4).toString('hex') === '89504e47');
check('read 文案提到尺寸', /800x600/.test(r1.content), r1.content);
check('read 文案提示模型能看', /你可以看到它/.test(r1.content));

const r2 = await readTool.execute({ path: path.join(TMP, 'dot.gif') }, { cwd });
check('gif 也能读', !r2.isError && r2.meta.images[0].mime === 'image/gif');

const r3 = await readTool.execute({ path: path.join(TMP, 'note.txt') }, { cwd });
check('文本文件仍是文本', !r3.isError && r3.meta?.kind !== 'image' && /hello 文本/.test(r3.content));

const r4 = await readTool.execute({ path: path.join(TMP, 'nope.png') }, { cwd });
check('不存在的图片给出错误', r4.isError);

// 超大图片：写一个假的 7MB png 头
const huge = Buffer.concat([pngSmall, Buffer.alloc(7 * 1024 * 1024)]);
fs.writeFileSync(path.join(TMP, 'huge.png'), huge);
const r5 = await readTool.execute({ path: path.join(TMP, 'huge.png') }, { cwd });
check('超大图片提示缩小', r5.isError && /上限/.test(r5.content), r5.content.split(NL)[0]);

// ---- ContextEngine：图片挂在 tool 消息上 ---------------------------------
const eng = new ContextEngine({ maxTokens: 200000 });
eng.addUser('看下这张截图');
eng.addAssistant({ content: '', toolCalls: [{ id: 'call_img', name: 'read', input: { path: 'big.png' } }] });
eng.addToolResult({ toolCallId: 'call_img', name: 'read', content: r1.content, meta: r1.meta });
const rendered = eng.render();
const toolMsg = rendered.find((m) => m.role === 'tool');
check('render 保留 images', toolMsg?.images?.[0]?.mime === 'image/png');
check('token 估算计入图片', eng.tokens() > 1000, String(eng.tokens()));

// ---- 有线格式：OpenAI（图片另起一条 user 消息）----------------------------
async function captureBody(opts) {
  let captured = null;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        captured = JSON.parse(body);
      } catch {}
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const gen = streamChat({ ...opts, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' });
  for await (const ev of gen) {
    if (ev.type === 'text' || ev.type === 'stop') break;
  }
  await new Promise((r) => setTimeout(r, 30));
  srv.close();
  return captured;
}

const oa = await captureBody({
  provider: 'custom',
  model: 'vision-test',
  messages: rendered,
  settings: { thinking: 'off', maxTokens: 100 },
});
const oaStr = JSON.stringify(oa);
check('OpenAI 请求体里有 image_url', !!oa && oaStr.includes('image_url'), oa ? '' : '没抓到请求体');
check('OpenAI 图片是 data URL', oaStr.includes('data:image/png;base64,'));
check('OpenAI tool 消息保留文字', oa.messages.some((m) => m.role === 'tool' && /图片/.test(m.content || '')));
check('OpenAI 图片走 user 消息', oa.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')));

const an = await captureBody({
  provider: 'anthropic',
  model: 'vision-test',
  messages: rendered,
  settings: { thinking: 'off', maxTokens: 100 },
});
const anStr = JSON.stringify(an);
check('Anthropic tool_result 里带 image', !!an && anStr.includes('"type":"image"') && anStr.includes('"media_type":"image/png"'), an ? '' : '没抓到请求体');
check('Anthropic 图片是 base64 source', anStr.includes('"source":{"type":"base64"'));

log('');
log(failed ? `FAILED ${failed} check(s)` : 'ALL IMAGE CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
