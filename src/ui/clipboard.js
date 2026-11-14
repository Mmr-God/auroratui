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
