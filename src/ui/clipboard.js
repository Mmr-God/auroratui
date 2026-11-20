// Clipboard access for the TUI (paste from / copy to the system clipboard).
//
// Windows: PowerShell's Get-Clipboard / Set-Clipboard (conhost has no OSC 52).
// macOS:   pbpaste / pbcopy.  Linux: wl-paste|wl-copy, xclip or xsel.
// Everything degrades gracefully: when no helper exists we fall back to OSC 52
// (works in Windows Terminal, iTerm2, kitty, …) and report `ok:false` for reads.
//
// 图片：终端画不出图片，所以 readClipboardImage() 只负责把剪贴板里的截图存成
// 临时 PNG 并把路径交出来；调用方（app.js）把路径填进输入框，模型用 read 看图。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function run(cmd, args, { input, timeout = 6000, env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (e) {
      return finish({ ok: false, out, err: e.message });
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, out, err: 'timeout' });
    }, timeout);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, out, err });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(input, 'utf8');
      child.stdin.end();
    }
  });
}

/** Read plain text from the OS clipboard. Returns { ok, text, err }. */
export async function readClipboard() {
  // test hook: never touch the real clipboard when stubbed
  if (process.env.AGENT_CLIPBOARD_STUB) {
    return { ok: true, text: process.env.AGENT_CLIPBOARD_STUB === '1' ? '' : process.env.AGENT_CLIPBOARD_STUB, stub: true };
  }
  if (WIN) {
    const r = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw',
    ]);
    if (r.ok) return { ok: true, text: r.out.replace(/\r\n/g, '\n') };
    return { ok: false, text: '', err: r.err || 'powershell 读取剪贴板失败' };
  }
  if (MAC) {
    const r = await run('pbpaste', []);
    if (r.ok) return { ok: true, text: r.out };
    return { ok: false, text: '', err: r.err };
  }
  for (const [cmd, args] of [
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']],
  ]) {
    const r = await run(cmd, args);
    if (r.ok) return { ok: true, text: r.out };
  }
  return { ok: false, text: '', err: '没有找到 wl-paste / xclip / xsel' };
}

// ---------------------------------------------------------------- 剪贴板图片
// 终端画不出图片，所以策略是：截图 -> 存成临时 PNG -> 把路径贴进输入框，
// 交给 agent 的 read 工具去看（read 支持 png/jpg/gif/webp/bmp）。

/** 把 stdio 直接重定向到文件（二进制安全，wl-paste/xclip 输出的是图片字节）。 */
function runToFile(cmd, args, file, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let err = '';
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let fd;
    let child;
    try {
      fd = fs.openSync(file, 'w');
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', fd, 'pipe'] });
    } catch (e) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {}
      return finish({ ok: false, err: e.message });
    }
    try {
      fs.closeSync(fd);
    } catch {}
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, err: 'timeout' });
    }, timeout);
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, err });
    });
  });
}

function fileHasBytes(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// Windows：Get-Clipboard -Raw 读不到图像，只能用 WinForms 的 Clipboard.GetImage()
// （powershell.exe 默认 STA，GetImage 可用）。顺便识别“复制了图片文件”的情况。
const WIN_PS = `param([string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $img) {
  $img.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  [Console]::Out.Write('IMAGE')
  exit 0
}
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($null -ne $files -and $files.Count -gt 0) {
  foreach ($f in $files) { [Console]::Out.WriteLine('FILE:' + $f) }
  exit 0
}
[Console]::Out.Write('NONE')
`;

async function imageWindows(out) {
  const ps1 = path.join(os.tmpdir(), `agent-clip-${process.pid}-${Date.now()}.ps1`);
  try {
    fs.writeFileSync(ps1, WIN_PS, 'utf8');
    const r = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Out', out],
      { timeout: 15000 }
    );
    if (!r.ok) return { ok: false, err: (r.err || '').trim() || 'powershell 读取剪贴板图片失败' };
    const stdout = r.out || '';
    if (stdout.includes('NONE')) return { ok: false, err: '剪贴板里没有图片' };
    if (stdout.includes('IMAGE'))
      return fileHasBytes(out) ? { ok: true, path: out } : { ok: false, err: '剪贴板图片保存后是 0 字节' };
    const files = stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith('FILE:'))
      .map((l) => l.slice(5).trim())
      .filter((f) => IMG_EXT.test(f));
    if (files.length) return { ok: true, path: files[0], paths: files };
    return { ok: false, err: '剪贴板里没有图片' };
  } catch (e) {
    return { ok: false, err: e.message };
  } finally {
    try {
      fs.unlinkSync(ps1);
    } catch {}
  }
}

async function imageMac(out) {
  const direct = await run('pngpaste', [out], { timeout: 8000 });
  if (direct.ok && fileHasBytes(out)) return { ok: true, path: out };
  const q = out.replace(/"/g, '\\"');
  const script = `try
  set pngData to the clipboard as «class PNGf»
  set fh to open for access POSIX file "${q}" with write permission
  set eof of fh to 0
  write pngData to fh
  close access fh
  return "IMAGE"
on error
  return "NONE"
end try`;
  const r = await run('osascript', ['-e', script], { timeout: 10000 });
  if (r.ok && (r.out || '').includes('IMAGE') && fileHasBytes(out)) return { ok: true, path: out };
  return { ok: false, err: '剪贴板里没有图片' };
}

async function imageLinux(out) {
  const wayland = Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
  const tries = [
    ['wl-paste', ['--no-newline', '--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  if (!wayland) tries.reverse();
  let err = '';
  for (const [cmd, args] of tries) {
    const r = await runToFile(cmd, args, out);
    if (r.ok && fileHasBytes(out)) return { ok: true, path: out };
    if (!r.ok) err = r.err || err;
  }
  return { ok: false, err: err || '剪贴板里没有图片' };
}

/**
 * 剪贴板里如果是图片（截图），存成临时 PNG 并返回它的路径。
 * Returns { ok, path, paths?, err }.
 */
export async function readClipboardImage({ dir, name } = {}) {
  // test hook：跟 readClipboard 一样，测试时不碰真剪贴板
  const stub = process.env.AGENT_CLIPBOARD_IMAGE_STUB;
  if (stub !== undefined) {
    if (!stub || stub === '1') return { ok: false, path: '', err: '剪贴板里没有图片', stub: true };
    return { ok: true, path: stub, stub: true };
  }
  const out = path.join(
    dir || os.tmpdir(),
    name || `agent-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  const res = WIN ? await imageWindows(out) : MAC ? await imageMac(out) : await imageLinux(out);
  if (res.ok) return res;
  try {
    fs.unlinkSync(out);
  } catch {}
  return { ok: false, path: '', err: res.err || '剪贴板里没有图片' };
}

/** 路径里有空格/引号时补上引号，方便直接贴进输入框。 */
export function quotePath(p) {
  const s = String(p || '');
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
}

// ------------------------------------------------- 非文本剪贴板（文件 / 图片 / 其它）
// 终端里粘贴什么都得变成「能写进输入框的字符」。文本就直接贴；
// 复制的是文件、截图、或者别的什么二进制，就把**路径**贴进去 ——
// 这样不管剪贴板里是什么东西，模型都能用 read 工具拿到（read 支持图片与二进制提示）。
//
// 优先级：文本 > 文件（资源管理器里 Ctrl+C 复制的文件）> 图片（截图）> 其它可落盘的东西。
// 文本优先级最高是故意的：复制一段文字时绝不能因为系统同时挂了图片格式就贴成路径。

/** 文件扩展名 → 写临时文件时用的后缀（没有合适的就用 .bin）。 */
function extOf(name, mime) {
  const e = path.extname(String(name || '')).toLowerCase();
  if (e) return e;
  if (/^image\/png/.test(mime)) return '.png';
  if (/^image\/jpe?g/.test(mime)) return '.jpg';
  if (/^image\/gif/.test(mime)) return '.gif';
  if (/^image\/webp/.test(mime)) return '.webp';
  if (/^image\/bmp/.test(mime)) return '.bmp';
  if (/pdf/.test(mime)) return '.pdf';
  if (/zip/.test(mime)) return '.zip';
  return '.bin';
}

// Windows：一次性问出「文本 / 文件列表 / 有没有图 / 有没有其它格式」。
// Get-Clipboard -Raw 读文本，GetFileDropList 读资源管理器复制的文件，
// GetDataObject().GetFormats() 告诉你还有没有别的（比如 Excel 的嵌套对象）。
const WIN_ANY = `param([string]$Out)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$txt = [System.Windows.Forms.Clipboard]::GetText()
if ($null -ne $txt -and $txt.Length -gt 0) {
  [Console]::Out.Write('TEXT:' + $txt)
  exit 0
}
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($null -ne $files -and $files.Count -gt 0) {
  foreach ($f in $files) { [Console]::Out.WriteLine('FILE:' + $f) }
  exit 0
}
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $img) {
  $img.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  [Console]::Out.Write('IMAGE')
  exit 0
}
$fmts = [System.Windows.Forms.Clipboard]::GetDataObject().GetFormats()
if ($null -ne $fmts -and $fmts.Count -gt 0) {
  [Console]::Out.Write('FORMATS:' + ($fmts -join '|'))
  exit 0
}
[Console]::Out.Write('NONE')
`;

/** 把一个二进制格式名变成能落盘的临时文件（尽量从剪贴板里抽出真实字节）。 */
const WIN_SAVE_PS = `param([string]$Fmt, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$d = [System.Windows.Forms.Clipboard]::GetDataObject()
$v = $d.GetData($Fmt)
if ($v -is [System.IO.Stream]) {
  $fs = [System.IO.File]::Create($Out)
  $v.Position = 0
  $v.CopyTo($fs)
  $fs.Close()
  [Console]::Out.Write('SAVED')
  exit 0
}
if ($v -is [byte[]]) {
  [System.IO.File]::WriteAllBytes($Out, $v)
  [Console]::Out.Write('SAVED')
  exit 0
}
if ($v -is [string]) {
  [System.IO.File]::WriteAllText($Out, $v, [Text.Encoding]::UTF8)
  [Console]::Out.Write('SAVED')
  exit 0
}
[Console]::Out.Write('SKIP')
`;

/** macOS/Linux：列出剪贴板里可用的 MIME 类型。 */
async function mimeList() {
  if (MAC) {
    const r = await run('osascript', ['-e', 'clipboard info']);
    if (r.ok) {
      const mimes = [];
      if (/«class PNGf»/.test(r.out)) mimes.push('image/png');
      if (/«class furl».*|text\/uri-list/.test(r.out)) mimes.push('text/uri-list');
      if (/«class TIFF»/.test(r.out)) mimes.push('image/tiff');
      return { ok: true, mimes };
    }
    return { ok: false, mimes: [] };
  }
  const r = await run('wl-paste', ['--list-types']);
  if (r.ok) return { ok: true, mimes: r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
  const x = await run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
  if (x.ok) return { ok: true, mimes: x.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
  return { ok: false, mimes: [] };
}

/** Linux/macOS：把 text/uri-list 里的 file:// URI 转成本地路径。 */
async function uriListPaths() {
  if (WIN) return [];
  let raw = '';
  if (MAC) {
    // macOS 的「复制文件」不是 uri-list，而是 set the clipboard to {«class furl»}: 用 AppleScript 取
    const r = await run('osascript', ['-e', 'try\nset theFiles to the clipboard as «class furl»\nreturn POSIX path of theFiles\non error\nreturn ""\nend try'], { timeout: 6000 });
    if (r.ok && r.out.trim()) return [r.out.trim()];
    return [];
  }
  const r = await run('wl-paste', ['--no-newline', '--type', 'text/uri-list'], { timeout: 4000 });
  if (!r.ok) {
    const x = await run('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o'], { timeout: 4000 });
    if (x.ok) raw = x.out;
  } else raw = r.out;
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!/^file:\/\//i.test(l)) continue;
    try {
      // file:///home/a b/c.txt → /home/a b/c.txt
      out.push(decodeURIComponent(l.replace(/^file:\/\/\/(?=[A-Za-z]:)/i, '').replace(/^file:\/\//i, '/')));
    } catch {}
  }
  return out;
}

/**
 * 读剪贴板，**不管里面是什么都给出一份能粘进输入框的内容**。
 *
 * @returns {{ok:boolean, kind:'text'|'files'|'image'|'blob'|'empty', text:string,
 *            paths:string[], note:string, err?:string}}
 *   kind='text' 时 text 是原文；其余种类 text 是已经拼好的路径串（带引号，空格安全）。
 */
export async function readClipboardAny({ dir, name } = {}) {
  const outDir = dir || os.tmpdir();
  const mkOut = (ext) =>
    path.join(outDir, name || `agent-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || '.bin'}`);

  // ---- 测试钩子 1：整块结果直接注入（最灵活，可以造任何 kind）
  const stub = process.env.AGENT_CLIPBOARD_ANY_STUB;
  if (stub !== undefined) {
    try {
      return { ok: true, kind: 'empty', text: '', paths: [], note: '', stub: true, ...JSON.parse(stub) };
    } catch {
      return { ok: true, kind: 'empty', text: '', paths: [], note: '', stub: true };
    }
  }

  // ---- 测试钩子 2：沿用旧的三个单点 stub（文本 / 图片 / 文件）。
  // 只要设了其中任何一个，就**完全不碰真实剪贴板**——测试绝不能依赖开发者当时复制了什么。
  // 优先级和真实路径一致：文本 > 文件 > 图片。
  const textStub = process.env.AGENT_CLIPBOARD_STUB;
  const imgStub = process.env.AGENT_CLIPBOARD_IMAGE_STUB;
  const fileStub = process.env.AGENT_CLIPBOARD_FILE_STUB;
  if (textStub !== undefined || imgStub !== undefined || fileStub !== undefined) {
    if (textStub && textStub !== '1') {
      return { ok: true, kind: 'text', text: textStub, paths: [], note: '', stub: true };
    }
    if (fileStub) {
      let files = [];
      try {
        const parsed = JSON.parse(fileStub);
        files = Array.isArray(parsed) ? parsed : [String(parsed)];
      } catch {
        files = fileStub.split('|').map((s) => s.trim()).filter(Boolean);
      }
      if (files.length) {
        return { ok: true, kind: 'files', text: files.map(quotePath).join(' '), paths: files, note: `复制了 ${files.length} 个文件，已改成路径`, stub: true };
      }
    }
    if (imgStub && imgStub !== '1') {
      return { ok: true, kind: 'image', text: quotePath(imgStub), paths: [imgStub], note: '剪贴板里是图片，已存成临时文件', stub: true };
    }
    return { ok: false, kind: 'empty', text: '', paths: [], note: '', err: '剪贴板是空的（文本 / 文件 / 图片都没有）', stub: true };
  }

  // ---- 1) 文本（最高优先级）
  const t = await readClipboard();
  if (t.ok && t.text && t.text.trim()) {
    return { ok: true, kind: 'text', text: t.text, paths: [], note: '' };
  }

  // ---- 2/3/4) 非文本：文件 / 图片 / 其它
  if (WIN) {
    const ps1 = path.join(os.tmpdir(), `agent-clip-any-${process.pid}-${Date.now()}.ps1`);
    const imgOut = mkOut('.png');
    try {
      fs.writeFileSync(ps1, WIN_ANY, 'utf8');
      const r = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Out', imgOut],
        { timeout: 15000 }
      );
      const out = r.out || '';
      if (out.startsWith('FILE:')) {
        const files = out
          .split(/\r?\n/)
          .filter((l) => l.startsWith('FILE:'))
          .map((l) => l.slice(5).trim())
          .filter(Boolean);
        if (files.length) {
          return { ok: true, kind: 'files', text: files.map(quotePath).join(' '), paths: files, note: `复制了 ${files.length} 个文件，已改成路径` };
        }
      }
      if (out.includes('IMAGE')) {
        if (fileHasBytes(imgOut)) {
          return { ok: true, kind: 'image', text: quotePath(imgOut), paths: [imgOut], note: '剪贴板里是图片，已存成临时文件' };
        }
        return { ok: false, kind: 'empty', text: '', paths: [], note: '', err: '剪贴板图片是 0 字节' };
      }
      const fm = /FORMATS:([^\r\n]*)/.exec(out);
      if (fm) {
        // 有格式但没有文本/文件/图：挑一个能落盘的试试（Excel 单元格、HTML 片段等）
        const fmts = fm[1].split('|').map((s) => s.trim()).filter(Boolean);
        const pick = fmts.find((f) => /FileGroupDescriptor|Bitmap|DIB|PNG|HTML|Text/i.test(f)) || fmts[0];
        if (pick) {
          const blobOut = mkOut(extOf('', pick));
          const ps2 = path.join(os.tmpdir(), `agent-clip-save-${process.pid}-${Date.now()}.ps1`);
          try {
            fs.writeFileSync(ps2, WIN_SAVE_PS, 'utf8');
            const r2 = await run(
              'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps2, '-Fmt', pick, '-Out', blobOut],
              { timeout: 15000 }
            );
            if ((r2.out || '').includes('SAVED') && fileHasBytes(blobOut)) {
              return {
                ok: true,
                kind: 'blob',
                text: quotePath(blobOut),
                paths: [blobOut],
                note: `剪贴板里是「${pick}」，已存成临时文件并贴入路径`,
              };
            }
          } finally {
            try {
              fs.unlinkSync(ps2);
            } catch {}
          }
          return {
            ok: false,
            kind: 'empty',
            text: '',
            paths: [],
            err: `剪贴板里只有「${pick}」这种格式，读不出可用的字节（可以先把内容存成文件再复制文件）`,
          };
        }
      }
    } catch (e) {
      return { ok: false, kind: 'empty', text: '', paths: [], err: e.message };
    } finally {
      try {
        fs.unlinkSync(ps1);
      } catch {}
      // 没被用上的临时图删掉，别在 tmp 里堆垃圾
      try {
        if (!fileHasBytes(imgOut) || (t.ok && t.text && t.text.trim())) fs.unlinkSync(imgOut);
      } catch {}
    }
  } else {
    // macOS / Linux：先看有没有 file:// 列表（资源管理器复制文件走这条）
    const uris = await uriListPaths();
    if (uris.length) {
      return { ok: true, kind: 'files', text: uris.map(quotePath).join(' '), paths: uris, note: `复制了 ${uris.length} 个文件，已改成路径` };
    }
    // 再试图片
    const img = await readClipboardImage({ dir: outDir });
    if (img.ok && (img.path || img.paths?.length)) {
      const paths = img.paths && img.paths.length ? img.paths : [img.path];
      return { ok: true, kind: 'image', text: paths.map(quotePath).join(' '), paths, note: '剪贴板里是图片，已存成临时文件' };
    }
    // 最后看看有没有我们认得的二进制格式
    const { ok: hasList, mimes } = await mimeList();
    if (hasList && mimes.length) {
      const bin = mimes.find((m) => !/^text\/plain$|^UTF8_STRING$|^STRING$|^TARGETS$/i.test(m));
      if (bin) {
        const blobOut = mkOut(extOf('', bin));
        const cmdList = MAC
          ? [['osascript', ['-e', `try\nset d to the clipboard as «class ${/png/i.test(bin) ? 'PNGf' : 'TIFF'}»\nset fh to open for access POSIX file "${blobOut.replace(/"/g, '\\"')}" with write permission\nwrite d to fh\nclose access fh\nreturn "SAVED"\non error\nreturn "SKIP"\nend try`]]]
          : [['wl-paste', ['--no-newline', '--type', bin]], ['xclip', ['-selection', 'clipboard', '-t', bin, '-o']]];
        for (const [cmd, args] of cmdList) {
          const rr = MAC ? await run(cmd, args, { timeout: 8000 }) : await runToFile(cmd, args, blobOut);
          const good = MAC ? (rr.out || '').includes('SAVED') && fileHasBytes(blobOut) : rr.ok && fileHasBytes(blobOut);
          if (good) {
            return { ok: true, kind: 'blob', text: quotePath(blobOut), paths: [blobOut], note: `剪贴板里是「${bin}」，已存成临时文件并贴入路径` };
          }
        }
      }
    }
  }

  return {
    ok: false,
    kind: 'empty',
    text: '',
    paths: [],
    err: t.ok ? '剪贴板是空的' : t.err || '剪贴板不可用',
  };
}

/**
 * Put text on the OS clipboard.
 * `fallback` (optional) receives an OSC 52 byte sequence to write to the tty when
 * no clipboard helper is available.
 */
export async function writeClipboard(text, fallback) {
  if (process.env.AGENT_CLIPBOARD_STUB) {
    if (process.env.AGENT_CLIPBOARD_STUB_FILE) {
      try {
        fs.appendFileSync(process.env.AGENT_CLIPBOARD_STUB_FILE, JSON.stringify({ text }) + '\n');
      } catch {}
    }
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), stub: true, text };
  }
  const data = String(text ?? '');
  let ok = false;
  let err = '';
  if (WIN) {
    const tmp = path.join(os.tmpdir(), `agent-clip-${process.pid}-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmp, data, 'utf8');
      const r = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -Value ([IO.File]::ReadAllText('${tmp.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`,
      ]);
      ok = r.ok;
      err = r.err;
    } catch (e) {
      err = e.message;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  } else if (MAC) {
    const r = await run('pbcopy', [], { input: data });
    ok = r.ok;
    err = r.err;
  } else {
    for (const [cmd, args] of [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ]) {
      const r = await run(cmd, args, { input: data });
      if (r.ok) {
        ok = true;
        break;
      }
      err = r.err;
    }
  }
  if (!ok && typeof fallback === 'function') {
    try {
      fallback(`\x1b]52;c;${Buffer.from(data, 'utf8').toString('base64')}\x07`);
      ok = true;
      err = '系统剪贴板不可用，已尝试 OSC 52（仅 Windows Terminal 等终端支持）';
    } catch (e) {
      err = e.message;
    }
  }
  return { ok, err, bytes: Buffer.byteLength(data, 'utf8') };
}
