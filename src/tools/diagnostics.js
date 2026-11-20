// diagnostics 工具 — 把「跑一下检查」变成结构化结果。
//
// 为什么要有：子代理/团队的 verify 已经能实跑命令，但失败时交给模型的是原始
// stdout，500 行里只有一行是 `src/a.ts:42:7 - error TS2304: Cannot find name 'foo'`。
// 模型得自己肉眼解析，还经常漏。这里按项目类型自动挑工具、跑它、把输出解析成
// {file, line, col, severity, message, rule}，模型就能直接照着修。
//
// 设计取舍：
//  · 只读、不做自动修复（--fix 之类的会改文件，那该由模型显式调 shell 做）。
//  · 探测不到任何检查工具时**明确报错**，不要静默返回「没问题」——静默通过是最
//    危险的谎话，模型会以为代码真的干净。
//  · 每种检查器都有超时，tsc 在中等项目上也要几十秒。
//  · 用一次性进程（不是持久 shell）：检查命令不该把用户的 cwd/env 搞乱，也不该
//    被后台任务排到后面等。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectShell } from '../config.js';

const MAX_ITEMS = 200;
const DEFAULT_TIMEOUT = 180_000;
const MAX_RAW = 64 * 1024;

/** shellPath → 一次性命令的 argv（cmd.exe 不支持 -c，得走 /c）。 */
function shellArgv(shellPath, command) {
  const base = path.basename(String(shellPath || '')).toLowerCase();
  if (base.includes('bash') || base.includes('sh') || base.includes('zsh')) return ['-c', command];
  if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo', '-NoProfile', '-Command', command];
  return ['/d', '/s', '/c', command]; // cmd.exe
}

/** 跑一条一次性命令，拿 {code, out}。用和 shell 工具同一个 shell，语法才一致。 */
function runOnce(command, { cwd, timeout }) {
  const shellPath = detectShell();
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: out.slice(-MAX_RAW) });
    };
    let child;
    try {
      child = spawn(shellPath, shellArgv(shellPath, command), {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: process.env.CI || '1', GIT_PAGER: 'cat', PAGER: 'cat' },
      });
    } catch (e) {
      out = `无法启动检查命令: ${e.message}`;
      return finish(127);
    }
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.on('error', (e) => {
      out += `\n无法启动检查命令: ${e.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 0));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      out += `\n[检查超时 ${Math.round(timeout / 1000)}s，已终止]`;
      finish(124);
    }, timeout);
  });
}

/** severity 归一：不同工具的叫法统一成 error / warning / info。 */
function normSeverity(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'error' || v === 'err' || v === '2' || v === 'e') return 'error';
  if (v === 'warning' || v === 'warn' || v === '1' || v === 'w') return 'warning';
  return 'info';
}

/** 相对路径 + 行号，模型最需要的就是这个。 */
function loc(file, line, col) {
  const f = String(file || '').replace(/\\/g, '/');
  const rel = f.startsWith('/') || /^[A-Za-z]:/.test(f) ? f : f;
  return `${rel}${line ? `:${line}${col ? `:${col}` : ''}` : ''}`;
}

// ---------------------------------------------------------------- 解析器
// 每个解析器吃「原始输出」，吐 [{file, line, col, severity, message, rule}]

/** tsc --pretty false：`src/a.ts(42,7): error TS2304: Cannot find name 'foo'.` */
export function parseTsc(out) {
  const items = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+)?:?\s*(.*)$/gm;
  let m;
  while ((m = re.exec(out))) {
    items.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: normSeverity(m[4]), rule: m[5] || '', message: m[6].trim() });
  }
  return items;
}

/** eslint -f unix：`/abs/a.js:42:7: Cannot find name 'foo'. [Error/no-undef]` */
export function parseEslintUnix(out) {
  const items = [];
  const re = /^(.+?):(\d+):(\d+):\s+(.*?)(?:\s+\[(Error|Warning|Info)\/(.+?)\])?$/gm;
  let m;
  while ((m = re.exec(out))) {
    const msg = (m[4] || '').trim();
    if (!msg) continue;
    items.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      severity: normSeverity(m[5] || (/error/i.test(msg) ? 'error' : 'warning')),
      rule: m[6] || '',
      message: msg,
    });
  }
  return items;
}

/** go vet / gcc / clippy 的经典格式：`./main.go:12:4: undefined: foo` */
export function parseColon(out) {
  const items = [];
  const re = /^(.+?):(\d+)(?::(\d+))?:\s*(?:(error|warning|note)\s*:?\s*)?(.+)$/gm;
  let m;
  while ((m = re.exec(out))) {
    const file = m[1];
    // 排除 `npm ERR!` 之类不是路径的行
    if (!/\.\w+$/.test(file)) continue;
    items.push({
      file,
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : 0,
      severity: normSeverity(m[4] || 'error'),
      rule: '',
      message: m[5].trim(),
    });
  }
  return items;
}

/** ruff check --output-format concise：`src/a.py:42:7: F821 Undefined name 'foo'` */
export function parseRuff(out) {
  const items = [];
  const re = /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.+)$/gm;
  let m;
  while ((m = re.exec(out))) {
    items.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: 'error', rule: m[4], message: m[5].trim() });
  }
  return items;
}

// ---------------------------------------------------------------- 探测
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 项目里装了某个可执行文件吗（node_modules/.bin 也看）。 */
function hasBin(cwd, name) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return exists(path.join(cwd, 'node_modules', '.bin', name + ext)) || exists(path.join(cwd, 'node_modules', '.bin', name));
}

/**
 * 探测该跑什么。返回 {kind, command, parser, why} 或 null。
 * 顺序有讲究：类型检查优先（最能反映「改坏了」），其次 lint。
 */
export function detectChecks(cwd) {
  const checks = [];
  const pkgPath = path.join(cwd, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(readText(pkgPath) || 'null');
  } catch {}

  // ---- TypeScript / JavaScript
  const hasTsconfig = exists(path.join(cwd, 'tsconfig.json'));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (hasTsconfig || deps.typescript) {
    const bin = hasBin(cwd, 'tsc') ? 'npx tsc' : 'npx --yes tsc';
    checks.push({
      name: 'tsc',
      parser: parseTsc,
      command: `${bin} --noEmit --pretty false`,
      why: hasTsconfig.then ? '' : '项目依赖里有 typescript',
    });
  }
  if (exists(path.join(cwd, 'eslint.config.js')) || exists(path.join(cwd, 'eslint.config.mjs')) || exists(path.join(cwd, '.eslintrc')) || exists(path.join(cwd, '.eslintrc.json')) || exists(path.join(cwd, '.eslintrc.js')) || deps.eslint) {
    const bin = hasBin(cwd, 'eslint') ? 'npx eslint' : 'npx --yes eslint';
    checks.push({ name: 'eslint', parser: parseEslintUnix, command: `${bin} . -f unix --no-error-on-unmatched-pattern`, why: '找到 eslint 配置' });
  }

  // ---- Go
  if (exists(path.join(cwd, 'go.mod'))) {
    checks.push({ name: 'go vet', parser: parseColon, command: 'go vet ./...', why: '找到 go.mod' });
  }

  // ---- Python
  if (exists(path.join(cwd, 'pyproject.toml')) || exists(path.join(cwd, 'setup.py')) || exists(path.join(cwd, 'requirements.txt'))) {
    checks.push({ name: 'ruff', parser: parseRuff, command: 'ruff check --output-format concise .', why: '找到 Python 项目文件' });
  }

  // ---- Rust
  if (exists(path.join(cwd, 'Cargo.toml'))) {
    checks.push({ name: 'cargo check', parser: parseColon, command: 'cargo check --message-format short', why: '找到 Cargo.toml' });
  }

  return checks;
}

const SEV_ICON = { error: '✗', warning: '!', info: '·' };

function formatItems(items, { checks, cwd }) {
  if (!items.length) {
    return `${checks.map((c) => c.name).join(' / ')} 跑完了：没有问题。`;
  }
  const errors = items.filter((i) => i.severity === 'error').length;
  const warns = items.filter((i) => i.severity === 'warning').length;
  const lines = [`${errors} 个错误${warns ? ` · ${warns} 个警告` : ''}（来自 ${checks.map((c) => c.name).join(' / ')}）：`];
  for (const it of items.slice(0, MAX_ITEMS)) {
    const where = loc(path.isAbsolute(it.file) ? path.relative(cwd, it.file) : it.file, it.line, it.col);
    const rule = it.rule ? ` [${it.rule}]` : '';
    lines.push(`${SEV_ICON[it.severity] || '·'} ${where} ${it.message}${rule}`);
  }
  if (items.length > MAX_ITEMS) lines.push(`…（还有 ${items.length - MAX_ITEMS} 条，已截断）`);
  return lines.join('\n');
}

export const diagnosticsTool = {
  name: 'diagnostics',
  label: 'Diagnostics',
  readOnly: true,
  description:
    '跑项目的静态检查，把结果解析成「文件:行:列 错误信息」的清单。改完代码用它确认没改坏东西，比肉眼从几百行 stdout 里找报错可靠得多。\n' +
    '自动探测：tsconfig/依赖有 typescript → tsc --noEmit；有 eslint 配置 → eslint；go.mod → go vet；pyproject/requirements → ruff；Cargo.toml → cargo check。\n' +
    '可以指定 check 只跑某一种（如 check="tsc"），或传 command 跑任意自定义检查命令。\n' +
    '这是只读的，不会自动修复——需要 --fix 就用 shell 自己跑。',
  parameters: {
    type: 'object',
    properties: {
      check: { type: 'string', description: '只跑某一种检查：tsc / eslint / go vet / ruff / cargo check。省略 = 全跑' },
      command: { type: 'string', description: '自定义检查命令（覆盖自动探测），它的输出会按通用格式解析' },
      timeout: { type: 'integer', description: '单条检查的超时毫秒数（默认 180000）' },
      limit: { type: 'integer', description: '最多返回多少条问题（默认 200）' },
    },
  },
  async execute(input, ctx) {
    const cwd = ctx.cwd || process.cwd();
    const timeout = Math.max(10_000, Math.min(600_000, Number(input.timeout) || DEFAULT_TIMEOUT));
    const limit = Math.max(1, Math.min(1000, Number(input.limit) || MAX_ITEMS));

    let checks;
    if (input.command) {
      checks = [{ name: '自定义命令', parser: parseColon, command: String(input.command), why: '由调用方指定' }];
    } else {
      checks = detectChecks(cwd);
      if (input.check) {
        const want = String(input.check).toLowerCase();
        checks = checks.filter((c) => c.name.toLowerCase() === want || c.name.toLowerCase().includes(want));
        if (!checks.length) {
          return {
            isError: true,
            content:
              `没有找到可用的检查器「${input.check}」。探测到的有：` +
              `${detectChecks(cwd).map((c) => c.name).join(', ') || '（无）'}。\n` +
              '要么换个 check，要么用 command 参数指定一条自定义检查命令。',
          };
        }
      }
      if (!checks.length) {
        return {
          isError: true,
          content:
            `在 ${cwd} 没探测到任何已知的静态检查工具（找过 tsconfig.json / eslint 配置 / go.mod / pyproject.toml / Cargo.toml）。\n` +
            '这不是「代码没问题」，只是没有检查器可跑。可以用 command 参数传一条自定义检查命令（例如 "npx my-lint ."），' +
            '或者直接跑项目的 test 脚本。',
        };
      }
    }

    const results = [];
    const all = [];
    for (const c of checks) {
      const r = await runOnce(c.command, { cwd, timeout });
      const out = `${r.out || ''}`;
      // 工具没装 / 命令不存在：别当成「0 个问题」
      if (r.code === 127 || /command not found|不是内部或外部命令|is not recognized/i.test(out)) {
        results.push({ name: c.name, command: c.command, skipped: true, reason: '命令不存在（没安装？）', code: r.code });
        continue;
      }
      const items = c.parser(out).map((it) => ({ ...it, check: c.name }));
      // 解析不出任何问题，但命令以非 0 退出 → 说明输出格式没被识别，把原文带回去
      if (!items.length && r.code !== 0) {
        results.push({ name: c.name, command: c.command, unparsed: true, code: r.code, raw: out.slice(-4000) });
        continue;
      }
      results.push({ name: c.name, command: c.command, code: r.code, count: items.length });
      all.push(...items);
    }

    const skipped = results.filter((r) => r.skipped);
    const unparsed = results.filter((r) => r.unparsed);
    const ran = results.filter((r) => !r.skipped && !r.unparsed);

    if (!ran.length && !unparsed.length) {
      return {
        isError: true,
        content:
          `探测到 ${checks.map((c) => c.name).join(', ')}，但都跑不起来：\n` +
          skipped.map((s) => `- ${s.name}：${s.reason}`).join('\n') +
          '\n这不是「代码没问题」。要么装上它，要么用 command 参数指定别的检查。',
      };
    }

    const parts = [];
    if (ran.length) parts.push(formatItems(all.slice(0, limit), { checks: ran, cwd }));
    for (const u of unparsed) {
      parts.push(`\n【${u.name}】退出码 ${u.code}，但输出格式没认出来，原文末尾：\n${u.raw}`);
    }
    for (const s of skipped) parts.push(`\n（${s.name} 跳过：${s.reason}）`);

    const errorCount = all.filter((i) => i.severity === 'error').length;
    return {
      isError: errorCount > 0 || unparsed.length > 0,
      content: parts.join('\n'),
      meta: {
        kind: 'diagnostics',
        checks: ran.map((r) => r.name),
        errors: errorCount,
        warnings: all.filter((i) => i.severity === 'warning').length,
        total: all.length,
        items: all.slice(0, 40),
      },
    };
  },
};
