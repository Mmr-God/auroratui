// The terminal UI: alt-screen renderer, input editor, pickers, streaming view.
import readline from 'node:readline';
import os from 'node:os';

function logDbg(msg) {
  if (!process.env.AGENT_DEBUG) return;
  try {
    const dir = path.join(os.homedir(), '.agent', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'launch.log'), `[ui] ${msg}
`);
  } catch {}
}
import fs from 'node:fs';
import path from 'node:path';
import { T, glyphs, spinnerFrame, fg256 } from './theme.js';
import { renderMarkdown, previewLines } from './markdown.js';
import { KeyParser } from './keys.js';
import { Agent } from '../agent.js';
import { PROVIDERS, providerList, getProvider, resolveModel } from '../providers.js';
import {
  stripAnsi,
  strWidth,
  padToWidth,
  truncToWidth,
  wrapWords,
  charWidth,
  fmtNum,
  fmtMoney,
  fmtDuration,
  fmtBytes,
  shortPath,
  clamp,
  cutAnsi,
  timeAgo,
  estimateTokens,
} from '../util.js';
import { SESSIONS_DIR, AGENT_DIR } from '../config.js';
import { readClipboard, writeClipboard, readClipboardImage, quotePath } from './clipboard.js';
import { Checkpoints } from '../checkpoint.js';
import { listSkills } from '../tools/skill.js';
import { ensureHub, resetHub, openInBrowser } from '../progress.js';
import { getActiveTeam, lastTeamSnapshot } from '../team.js';
import { describeTool } from './toolview.js';
import { disposeShell } from '../tools/shell.js';
import { describeHooks } from '../tools/hooks.js';
import { findBrowser } from '../tools/browser.js';

const VERSION = '2.1.0';
const APP_NAME = 'AuroraTui';

const WELCOME = [
  `${T.accentBold('◆ ' + APP_NAME)} ${T.dimmer('· 终端里的 AI 编程代理')}`,
  '',
  `${T.dim('基础')}  ${T.text('read')} ${T.dimmer('·')} ${T.text('write')} ${T.dimmer('·')} ${T.text('edit')} ${T.dimmer('·')} ${T.text('shell')}`,
  `${T.dim('进阶')}  ${T.text('glob')} ${T.dimmer('·')} ${T.text('grep')} ${T.dimmer('·')} ${T.text('ls')} ${T.dimmer('·')} ${T.text('think')} ${T.dimmer('·')} ${T.text('ask')} ${T.dimmer('·')} ${T.text('web_search')} ${T.dimmer('·')} ${T.text('web_fetch')} ${T.dimmer('·')} ${T.text('browser')} ${T.dimmer('·')} ${T.text('http_request')}`,
  `${T.dim('记忆')}  ${T.text('todo')} ${T.dimmer('·')} ${T.text('memory')} ${T.dimmer('·')} ${T.text('skill')} ${T.dimmer('·')} ${T.text('git')} ${T.dimmer('·')} ${T.text('context')} ${T.dimmer('（billion-context）')}`,
  `${T.dim('命令')}  ${T.text('/model')} ${T.dimmer('切换模型  ')}${T.text('/history')} ${T.dimmer('历史对话  ')}${T.text('/trust')} ${T.dimmer('全权模式  ')}${T.text('/help')} ${T.dimmer('全部命令')}`,
  `${T.dim('鼠标')}  ${T.dimmer('拖选复制 ')}${T.dimmer('·')} ${T.dimmer('右键/Ctrl+V 粘贴 ')}${T.dimmer('·')} ${T.dimmer('滚轮滚动 ')}${T.dimmer('·')} ${T.dimmer('点块头折叠')}`,
];

// “Aurora” 点阵 logo（figlet standard，纯 ASCII，conhost 字体都能显示）
const LOGO = [
  '     _     _   _ ____   ___  ____      _    ',
  '    / \\   | | | |  _ \\ / _ \\|  _ \\    / \\   ',
  '   / _ \\  | | | | |_) | | | | |_) |  / _ \\  ',
  '  / ___ \\ | |_| |  _ <| |_| |  _ <  / ___ \\ ',
  ' /_/   \\_\\ \\___/|_| \\_\\ \\___/|_| \\_\\ /_/   \\_\\',
];
const LOGO_COLORS = [fg256(213), fg256(177), fg256(141), fg256(111), fg256(75)];

/** 把一条任务压成一行标题：去换行、限长。 */
function compressTitle(text) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > 42 ? one.slice(0, 42) + '…' : one;
}

/**
 * 整句就是这个样子的话，它十有八九是 API key，不该进对话：
 * 没有空白、不像路径/代码、长度 ≥ 20 且字母数字混排（sk-xxx、gsk-xxx、sk-ant-xxx 等）。
 */
function detectApiKey(text) {
  const s = String(text || '').trim();
  if (!s || /\s/.test(s) || s.length < 20 || s.length > 200) return '';
  if (s.startsWith('/') || s.startsWith('.') || /[\\/]/.test(s)) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return '';
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return '';
  const prefixed = /^(sk|pk|rk|ak|gsk|xai|api|key|token)[-_]/i.test(s);
  return prefixed || s.length >= 28 ? s : '';
}

// Slash-command metadata: drives the completion popup and the argument hints.
const COMMANDS = [
  { name: '/model', args: '[筛选|provider/model]', desc: '切换模型（打开选择器）' },
  { name: '/provider', args: '[add|rm|key|model|models|list]', desc: '自定义服务商管理' },
  { name: '/key', args: '[provider] [key]', desc: '配置 API key' },
  { name: '/think', args: '<off|low|medium|high|max>', desc: '思考强度（越低越快）' },
  { name: '/new', args: '', desc: '开新会话（清空上下文）' },
  { name: '/clear', args: '', desc: '清屏但保留上下文' },
  { name: '/compact', args: '', desc: '手动压缩早期上下文' },
  { name: '/expand', args: '<ref|区间>', desc: '展开压缩块原文' },
  { name: '/ctx', args: '', desc: '上下文占用与压缩块' },
  { name: '/cost', args: '', desc: 'token 与花费' },
  { name: '/tools', args: '', desc: '工具清单' },
  { name: '/subagents', args: '[on|off]', desc: '子代理开关（AI 可派生助手）' },
  { name: '/team', args: '[on|off]', desc: '团队协作开关（AI 可组队并行）' },
  { name: '/progress', args: '[open]', desc: '团队面板（浏览器看进度）' },
  { name: '/shell', args: '[open]', desc: 'Shell 后端（看/终止 AI 跑过的命令）' },
  { name: '/spawn', args: '', desc: '在浏览器里手动组队/派子代理' },
  { name: '/queue', args: '[clear|drop n]', desc: '待发队列（AI 干活时 Tab 排队；Enter 直接插话）' },
  { name: '/todo', args: '[list|set|clear]', desc: '查看/维护待办' },
  { name: '/memory', args: '[list|set|forget]', desc: '查看/维护长期记忆' },
  { name: '/verbose', args: '', desc: '工具输出预览 详细/精简' },
  { name: '/sessions', args: '', desc: '已保存会话' },
  { name: '/resume', args: '<n>', desc: '恢复会话' },
  { name: '/history', args: '[筛选]', desc: '历史对话（选择后恢复）' },
  { name: '/trust', args: '[on|off]', desc: '全权模式（可改工作区外文件）' },
  { name: '/undo', args: '[n]', desc: '回滚上一次文件改动' },
  { name: '/paste', args: '', desc: '从系统剪贴板粘贴（图片则填入图片路径）' },
  { name: '/copy', args: '[n]', desc: '复制上一条回答' },
  { name: '/native', args: '', desc: '切换原生鼠标选择/复制' },
  { name: '/skill', args: '[list|load]', desc: '技能清单' },
  { name: '/hooks', args: '', desc: '查看已启用 hooks' },
  { name: '/help', args: '', desc: '帮助' },
  { name: '/quit', args: '', desc: '退出' },
];

const HELP = [
  '/model [筛选]        切换模型（也可 /model provider/model 直接切换）',
  '/provider <id>       切换服务商',
  '/key [provider] [key] 配置 / 更新 API key',
  '/think <off|low|medium|high|max>  调整思考强度',
  '/new                 开新会话（清空上下文）',
  '/clear               只清屏，保留上下文',
  '/compact             手动压缩早期上下文（billion-context）',
  '/expand <ref>        展开某个压缩块 / 区间的原文',
  '/ctx                 查看上下文占用与压缩块',
  '/cost                查看本会话 token 与花费',
  '/tools               查看工具清单',
  '/subagents [on|off]  子代理：允许 AI 派独立上下文的助手干活（默认关，会多花 token）',
  '/team [on|off]       团队协作：允许 AI 组队并行开发（默认关，token 消耗成倍）',
  '/progress [open]     打开团队面板（浏览器看子代理/团队成员实时进度）',
  '/shell [open]        Shell 后端：AI 跑过的每条命令、实时输出、手动终止',
  '/spawn               在浏览器里手动组队或派一个子代理（玩家亲自开工）',
  '/queue [clear|drop n] 待发队列：AI 干活时按 Tab 排队，收工后自动发送（最多 5 条）；直接 Enter 是插话，当前步骤结束后生效',
  '/verbose             切换工具输出预览（详细/精简）',
  '/sessions            查看已保存会话     /resume <n>  恢复',
  '/history             历史对话列表（↑↓ 选择，Enter 恢复）',
  '/trust [on|off]      全权模式：允许读写工作区之外的文件（默认关闭）',
  '/undo [n]            回滚写文件前的自动快照（checkpoint）',
  '/paste               从系统剪贴板粘贴到输入框（也可 Ctrl+V / 右键）',
  '                      （剪贴板里是截图时自动存成临时 PNG，填入图片路径，read 工具能看图）',
  '/copy [n]            复制上一条（或倒数第 n 条）回答到剪贴板',
  '/native              原生鼠标模式：可用鼠标拖选并用终端自己的复制',
  '/skill [list|load]   技能清单（.agent/skills/*.md）',
  '/hooks               查看配置的 hooks',
  '/help                显示本帮助          /quit  退出',
];

// 标签色调：技能是暖色、billion-context 是紫色，其余工具走暗色小字
const TAG_STYLE = {
  skill: (s) => T.accent3(s),
  memory: (s) => T.accent2(s),
  info: (s) => T.dimmer(s),
  dim: (s) => T.dim(s),
  warn: (s) => T.warn(s),
  ok: (s) => T.ok(s),
};

export class App {
  constructor({ config, cwd = process.cwd(), resume = false } = {}) {
    this.config = config;
    this.cwd = cwd;
    this.agent = new Agent({ config, cwd });
    this.width = process.stdout.columns || 100;
    this.height = process.stdout.rows || 30;
    this.prevLines = [];
    this.items = [];
    this.input = { text: '', cursor: 0 };
    this.history = [];
    this.histIdx = -1;
    this.scroll = 0;
    // 跟随模式：null = 视口跟着最新内容走；数字 = 玩家自己滚上去了，
    // 视口钉在这个「绝对行号」上，AI 继续输出也不会把视线拽回底部。
    this.followAnchor = null;
    this.state = 'idle';
    this.stateDetail = '';
    this.usage = { input: 0, output: 0, cost: 0 };
    this.context = { tokens: 0, maxTokens: 128000, used: 0 };
    this.showThinking = config.settings.showThinking !== false;
    this.verbose = !!config.settings.verbose;
    this.picker = null;
    this.prompt = null;
    this.askState = null; // AI 用 ask 工具提问时，等玩家选择的弹层
    this.spin = 0;
    this.dirty = true;
    this.running = false;
    this.quit = false;
    this.title = ''; // 会话名（首个任务，/history 用它区分）
    this.taskTitle = ''; // 当前任务标题，每个新任务都换
    this.demo = false;
    this.toolCount = 0;
    this.taskT0 = 0; // 本次任务开始时间（状态栏实时用时）
    this.lastElapsed = null; // 上一次任务总用时
    // 流式速度（tok/s）与帧差分
    this.speed = 0;
    this.lastSpeed = null;
    this._gen = { t0: 0, tok: 0 };
    this._painted = null;
    this.pastes = [];
    /** 待发队列：AI 干活时玩家按 Tab 附加的话，最多 5 条，本轮结束后自动逐条发送。 */
    this.pending = [];
    this.maxPending = 5; // 大段粘贴折叠：⟦粘贴#1:12345⟧ → 原文，发送时展开
    // selection / clipboard / history / checkpoints
    this.sel = null; // {a:{row,col}, b:{row,col}} in screen coordinates
    this.selDragging = false;
    this.selFlash = 0; // 高亮闪烁计数，复制后短暂高亮
    this.nativeMouse = false;
    this.histOverlay = null; // {items:[], sel:0, filter:''}
    this.lastFrameRaw = [];
    this.lastFrameH = 20;
    this.checkpoints = new Checkpoints(path.join(AGENT_DIR, 'checkpoints', stamp()));
    this.agent.checkpoints = this.checkpoints;
    this.bindAgent();
    this.done = new Promise((r) => (this._done = r));
    if (resume) this.loadLatestSession();
  }

  // ------------------------------------------------------------- lifecycle
  /** 面板起来后，把「浏览器手动开工」接到 spawnFromBrowser。 */
  bindSpawn(hub = null) {
    const attach = (h) => {
      if (!h) return;
      h.onSpawn = async (payload) => {
        const { spawnFromBrowser } = await import('../spawn.js');
        return spawnFromBrowser(
          {
            config: this.config,
            cwd: this.cwd,
            checkpoints: this.checkpoints,
            emit: (item) => this.push(item),
          },
          payload,
        );
      };
    };
    if (hub) return attach(hub);
    ensureHub(this.config).then(attach).catch(() => {});
    return undefined;
  }

  async start() {
    const out = process.stdout;
    if (!out.isTTY) {
      throw new Error('当前终端不是交互式 TTY。请在 Windows Terminal / cmd.exe / PowerShell 中运行（见 README）。');
    }
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    this.blockRows = 0;
    this.lastRow = 1;
    logDbg(`start ${out.columns}x${out.rows}`);
    // Alternate screen: conhost keeps a ~9001-line scrollback, so painting into the
    // normal buffer drifts out of alignment as soon as the frame is a full page.
    // The alt buffer is exactly one viewport, so absolute cursor addressing is exact.
    out.write('\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[1;1H\x1b[2J');
    this.needClear = false;
    this.drawnRows = 0;
    // 测试/截图用：先把一段文字放进输入框
    if (process.env.AGENT_PREFILL) {
      this.input = { text: process.env.AGENT_PREFILL, cursor: process.env.AGENT_PREFILL.length };
    }

    this.parser = new KeyParser();
    this.onData = (chunk) => {
      this.lastInputAt = Date.now();
      for (const ev of this.parser.push(chunk)) this.handleKey(ev);
    };
    process.stdin.on('data', this.onData);
    this.onResize = () => {
      const w = out.columns || 100;
      const h = out.rows || 30;
      if (w === this.width && h === this.height) return;
      this.width = w;
      this.height = h;
      this.prevLines = [];
      logDbg(`resize ${w}x${h}`);
      this.needClear = true;
      this.render(true);
    };
    out.on('resize', this.onResize);

    this.pushWelcome();
    this.bindSpawn();
    this.render(true);
    // console size sometimes settles a moment after the window is created
    setTimeout(() => {
      if (this.quit) return;
      this.render(true);
    }, 250).unref?.();

    this.timer = setInterval(() => {
      // 半截转义序列/卡住的粘贴必须有超时兜底，否则表现就是“输入彻底失灵”
      if (this.parser) {
        const late = this.parser.tick();
        for (const ev of late) this.handleKey(ev);
      }
      this._ticks = (this._ticks || 0) + 1;
      if (this.running) {
        this.spin++; // 也让"用时 12.3s"跳动
        // 运行中不再每 33ms 全屏重绘（30fps 的全屏重画会打断输入法组合串，
        // 键盘事件也会被压在重绘后面），计时数字 100ms 刷一次足够
        if (this._ticks % 3 === 0 && Date.now() - (this.lastInputAt || 0) > 120) this.dirty = true;
      }
      if (this.dirty && !(this.running && Date.now() - (this.lastInputAt || 0) < 120)) this.render();
    }, 33);

    return this.done;
  }

  teardown() {
    clearInterval(this.timer);
    try {
      process.stdin.off('data', this.onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    } catch {}
    process.stdout.off('resize', this.onResize);
    let text = '';
    try {
      text = this.buildFrame()
        .map((l) => stripAnsi(l).replace(/\s+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } catch {}
    process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l');
    // Leave a plain copy of the screen behind so the scrollback keeps context.
    if (text) process.stdout.write(text + '\n');
  }

  exit(code = 0) {
    if (this.quit) return;
    this.quit = true;
    this.saveSession();
    this.teardown();
    this._done(code);
  }

  /**
   * 中断当前任务。第一次先请 agent 优雅中止（工具能收尾、保留上下文）；
   * 3 秒内再按一次就直接杀掉 shell 子进程并退出，避免“按了 ESC 什么也不发生”。
   */
  requestCancel(how = 'esc') {
    if (!this.running) return;
    const now = Date.now();
    const again = now - (this.cancelAt || 0) < 3000;
    if (again) {
      this.push({ kind: 'note', text: `再次收到中断（${how}）：强制终止任务并退出` });
      try {
        disposeShell();
      } catch {}
      this.agent.cancel();
      this.teardown();
      this._done(130);
      return;
    }
    this.cancelAt = now;
    this.agent.cancel();
    this.push({ kind: 'note', text: '已发送中断信号（3 秒内再按 ESC 强制结束）' });
    this.dirty = true;
    this.render(true);
  }

  /** Seed a rich sample transcript (used by `agent --demo` and screenshots). */
  seedDemo() {
    this.items = [];
    this.items.push({ kind: 'banner', lines: WELCOME, ver: 1 });
    const code = ['const m = /^(-?\\d+):(.*)$/.exec(tail.trim());', 'if (m) { this.lastCode = Number(m[1]); this.cwd = m[2]; }'].join('\n');
    const items = [
      { kind: 'user', text: '帮我把 src/tools/shell.js 的 marker 解析修一下，然后跑测试确认' },
      {
        kind: 'assistant',
        think: '先定位 marker 解析逻辑，再跑测试。',
        text: [
          '先确认 marker 的输出格式与解析正则：',
          '',
          '- 命令末尾 `printf` 打印 `__M__:<退出码>:<cwd>`',
          '- 用正则 `^(-?\\d+):(.*)$` 解析，顺手把 `$?` 被覆盖的坑修掉',
          '',
          '```js',
          code,
          '```',
        ].join('\n'),
      },
      {
        kind: 'tool',
        name: 'read',
        input: { path: 'src/tools/shell.js' },
        status: 'ok',
        dur: 12,
        content: ['   1→import { spawn } from "node:child_process";', ' 140→  _flush() {', ' 141→    const m = /^(?::)?(-?\\d+):(.*)$/.exec(tail.trim());'].join('\n'),
      },
      {
        kind: 'tool',
        name: 'edit',
        input: { path: 'src/tools/shell.js' },
        status: 'ok',
        dur: 8,
        content: ['@@ -140,3 +140,4 @@', '-    const m = /^:(-?\\d+):(.*)$/.exec(tail.trim());', '+    const m = /^(-?\\d+):(.*)$/.exec(tail.trim());', '+    if (!m) return;'].join('\n'),
      },
      {
        kind: 'tool',
        name: 'shell',
        input: { command: 'node --test test/' },
        status: 'ok',
        dur: 1640,
        content: ['√ marker 解析 (12ms)', '√ 输出截断 (3ms)', 'i pass 2', 'i fail 0'].join('\n'),
      },
      {
        kind: 'assistant',
        text: [
          '改好了，`test/` 全绿。要点：',
          '',
          '1. marker 正则去掉了多余的冒号',
          '2. `$?` 先存到临时变量，避免被后续命令覆盖',
          '',
          '下一步建议：补一个「命令超时后自动重启会话」的用例。',
        ].join('\n'),
      },
      { kind: 'compacted', text: '已折叠为 b1（shell 工具调试）· 上下文降到 31.4%' },
    ];
    for (const it of items) this.items.push({ ...it, ver: 1 });
    this.usage = { input: 8421, output: 2130, cost: 0.0047 };
    this.context = { tokens: 10552, maxTokens: 1000000, used: 0.0106 };
    this.toolCount = 3;
    this.demo = true;
    this.title = '示例会话（--demo）';
    this.dirty = true;
    if (process.env.AGENT_PREFILL) {
      this.input = { text: process.env.AGENT_PREFILL, cursor: process.env.AGENT_PREFILL.length };
    }
  }

  // ------------------------------------------------------------- transcript
  push(item) {
    item.ver = 1;
    this.items.push(item);
    // 新任务/用户发言才把视口拉回最新；工具块这种流式刷新的东西不该打断阅读
    if (item.kind === 'user') {
      this.scroll = 0;
      this.followAnchor = null;
    }
    this.dirty = true;
    return item;
  }

  pushWelcome() {
    this.items.push({ kind: 'banner', lines: this.logoLines(this.width || 80), ver: 1 });
    this.items.push({ kind: 'banner', lines: WELCOME, ver: 1 });
    const t = this.agent.target();
    if (!this.config.hasKey(t.providerId)) {
      this.push({
        kind: 'warn',
        text: `未检测到 ${t.provider.name} 的 API key。输入 /key 配置，或用 /model 换一个已配置的服务商。`,
      });
      this.push({ kind: 'note', text: `密钥获取：${t.provider.site}   文档：${t.provider.docs}` });
    }
  }

  /** Aurora Welcome! —— 点阵 logo 的大字欢迎屏（窄窗口退化成文字版）。 */
  logoLines(W) {
    const w = W || 80;
    const out = [''];
    if (w >= 52) {
      LOGO.forEach((ln, i) => out.push(LOGO_COLORS[i % LOGO_COLORS.length](ln)));
    } else {
      out.push(`  ${T.accentBold('AURORATUI')} ${T.dimmer('终端里的 AI 编程代理')}`);
    }
    out.push('');
    out.push(`${T.accent2(APP_NAME)} ${T.dimmer('· 你的终端 AI 编程代理')}`);
    out.push(T.dimmer('直接说话就行；/model 选模型，/help 看全部命令。'));
    out.push('');
    return out;
  }

  /** Flush a frame right away when streaming, but never more than ~45 fps. */
  paintNow() {
    this.dirty = true;
    const now = Date.now();
    if (now - (this._lastPaint || 0) < 16) return;
    // 刚敲完键盘/输入法刚上屏时先别抢刷新：整屏重绘会冲掉输入法的组合串（conhost 下尤其明显）
    if (now - (this.lastInputAt || 0) < 90) return;
    this._lastPaint = now;
    this.render();
  }

  // ----------------------------------------------------------------- render
  render(force = false) {
    if (this.quit) return;
    // Trust the live terminal size every frame: `mode con` / window drags can
    // change it without firing a resize event.
    const sw = process.stdout.columns;
    const sh = process.stdout.rows;
    if ((sw && sw !== this.width) || (sh && sh !== this.height)) {
      this.width = sw || this.width;
      this.height = sh || this.height;
      this.needClear = true;
    }
    const frame = this.buildFrame();
    const H = frame.length;
    const cur = this.cursorPos;
    const out = ['\x1b[?7l'];
    const fullRepaint = force || this.needClear || !this._painted || this._paintedH !== H;
    if (this.needClear) {
      out.push('\x1b[1;1H\x1b[2J');
      this.needClear = false;
      this.drawnRows = 0;
    }
    // 帧差分：只重写变化的行。流式时每帧通常只有最后几行在变，
    // 整屏重绘是闪烁和卡顿的主因。
    const next = new Array(H);
    for (let i = 0; i < H; i++) {
      const line = frame[i] || '';
      next[i] = line;
      if (!fullRepaint && this._painted[i] === line) continue;
      out.push(`\x1b[${i + 1};1H\x1b[2K`);
      if (line) out.push(line);
      out.push('\x1b[0K');
    }
    // Clear everything below the frame, including the spare row: conhost keeps
    // stale cells there after a resize.
    const clearTo = Math.max(this.drawnRows || 0, H + 1);
    for (let i = H; i < clearTo; i++) out.push(`\x1b[${i + 1};1H\x1b[2K`);
    this._painted = next;
    this._paintedH = H;
    this.drawnRows = H + 1;
    this.blockRows = H;
    this.lastRow = H;
    if (cur && !this.quit) {
      const row = Math.min(Math.max(cur.row, 1), H);
      const col = Math.max(cur.col, 1);
      out.push(`\x1b[${row};${col}H`);
      out.push('\x1b[?25h');
      this.lastRow = row;
    } else {
      out.push('\x1b[?25l');
    }
    out.push('\x1b[?7h');
    logDbg(`paint size=${this.width}x${this.height} rows=${process.stdout.rows} cols=${process.stdout.columns} frame=${frame.length}`);
    if (process.env.AGENT_DEBUG) {
      try {
        const dump = frame.map((l) => stripAnsi(l)).join('\n');
        fs.writeFileSync(path.join(os.homedir(), '.agent', 'logs', 'frame.txt'), dump);
      } catch {}
    }
    process.stdout.write(out.join(''));
    this.dirty = false;
  }

  buildFrame() {
    if (process.env.AGENT_TESTPATTERN) {
      const W2 = this.width;
      const H2 = this.height - 1;
      const rows2 = [];
      for (let i = 1; i <= H2; i++) {
        rows2.push((`ROW${i}` + ' ' + '·'.repeat(Math.max(0, W2 - 12))).slice(0, W2));
      }
      return rows2;
    }
    // Lay out one column narrower than the window: conhost force-wraps a row that
    // exactly fills the last column (double-width CJK at the margin), and that wrap
    // scrolls the whole screen by one row. Keeping a spare column kills the drift.
    const W = Math.max(20, this.width - 2);
    // Keep one spare row at the bottom: if any row ever force-wraps, conhost scrolls
    // by one line — with a spare row that costs us an empty line instead of the header.
    const H = Math.max(10, this.height - 1);
    const rows = [];
    rows.push(this.headerLine(W));

    const box = this.inputBoxLines(W);
    const status = this.statusBarLine(W);
    const popup = this.compPopupLines(W);
    const hint = this.argHintLines(W);
    const extra = popup.length + hint.length;
    const transcriptH = Math.max(3, H - 1 - box.length - 1 - extra);
    const tlines = this.transcriptLines(W);

    const total = tlines.length;
    const maxScroll = Math.max(0, total - transcriptH);
    if (this.followAnchor != null) {
      // 玩家滚上去过：按绝对行号定位，AI 边写边加行也不会移动视口
      const startWant = clamp(this.followAnchor, 0, Math.max(0, total - transcriptH));
      this.scroll = clamp(total - (startWant + transcriptH), 0, maxScroll);
    } else {
      this.scroll = clamp(this.scroll, 0, maxScroll);
    }
    const end = total - this.scroll;
    const start = Math.max(0, end - transcriptH);
    // 记住这一帧的顶部行号：只要不在底部，就算「暂停跟随」
    this.followAnchor = this.scroll > 0 ? start : null;
    const view = tlines.slice(start, end);
    // 内容不满一屏时补在下方（像普通终端那样从顶部开始长），
    // 而不是把内容压到底部、上面留一大片空。
    while (view.length < transcriptH) view.push('');

    rows.push(...view);
    // 记下每一项落在屏幕的哪几行：点击折叠/展开、拖动滚动条都靠它
    const spans = this._itemSpans || [];
    this.rowMap = spans
      .filter((sp) => sp.end >= start && sp.start < end)
      .map((sp) => ({ from: 2 + (sp.start - start), to: 2 + (sp.end - start), item: sp.item }));
    this.viewInfo = { total, start, end, viewH: transcriptH };
    if (total > transcriptH) this.drawScrollbar(rows, W, transcriptH, total, start);
    if (hint.length) rows.push(...hint);
    if (popup.length) rows.push(...popup);
    rows.push(...box);
    rows.push(status);
    if (this.picker) this.composeOverlay(rows, W, H, 1, transcriptH);
    if (this.histOverlay) this.composeHistoryOverlay(rows, W, H, transcriptH);
    if (this.askState) this.composeAskOverlay(rows, W, H, transcriptH);
    this.cursorPos = this.computeCursor(W, rows.length, transcriptH, box);
    const raw = rows.slice(0, H);
    this.lastFrameRaw = raw;
    this.lastFrameH = raw.length;
    const painted = this.sel && this.selActive() ? this.applySelection(raw) : raw;
    // Safety net: never let a row exceed the viewport (autowrap is off, but a
    // too-wide row would still corrupt neighbouring cells).
    return painted.map((line) => {
      const w = strWidth(stripAnsi(line));
      if (w <= W) return line;
      return truncToWidth(line, W);
    });
  }

  /** 右侧滑块：轨道用 │，拇指用 ║，可用鼠标拖着磨。 */
  drawScrollbar(rows, W, viewH, total, start) {
    const maxScroll = Math.max(1, total - viewH);
    const thumbH = Math.max(1, Math.min(viewH, Math.round((viewH * viewH) / total)));
    const pos = Math.round(((maxScroll - clamp(this.scroll, 0, maxScroll)) / maxScroll) * (viewH - thumbH));
    for (let i = 0; i < viewH; i++) {
      const idx = 1 + i;
      if (idx >= rows.length) break;
      const inThumb = i >= pos && i < pos + thumbH;
      const glyph = inThumb ? T.accent(glyphs.thumb) : T.dimmer(glyphs.track);
      rows[idx] = padToWidth(truncToWidth(rows[idx] || '', W - 1), W - 1) + glyph;
    }
    this.sbInfo = { viewH, total, maxScroll, thumbH, pos };
  }

  /** 滚动条拖动 / 点击轨道：把 y 映射回 scroll 值。 */
  scrollbarTo(y) {
    const info = this.sbInfo;
    if (!info) return;
    const rel = clamp(y - 1, 0, Math.max(1, info.viewH - 1));
    const frac = rel / Math.max(1, info.viewH - 1);
    const wantStart = Math.round(frac * info.maxScroll);
    this.scroll = clamp(info.maxScroll - wantStart, 0, info.maxScroll);
    this.sel = null;
    this.dirty = true;
  }

  toggleItem(item) {
    if (!item || !item.collapsible) return;
    item.collapsed = !item.collapsed;
    item.ver++;
    this.dirty = true;
    this.render(true);
  }

  /** Ctrl+O：展开/收起最后一个可折叠块。 */
  toggleLastCollapsible() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.collapsible) return this.toggleItem(it);
    }
  }

  headerLine(W) {
    const t = this.agent.target();
    const trust = this.config.allowOutsideCwd;
    const mode = trust ? T.badge('全权', 131) : T.badge('工作区', 238, 250);
    const left = ` ${T.accentBold('◆ AuroraTui')} ${T.dimmer('v' + VERSION)} ${T.dimmer('│')} ${T.text(t.provider.name)} ${T.dimmer('│')}${mode} ${T.accent(prettyCwd(this.cwd))}`;
    const marks = [];
    // 当前任务标题：每给一个新任务就换一次（会话名仍用首个任务，方便 /history 区分）
    if (this.taskTitle) marks.push(T.accent2('\u201c' + truncToWidth(this.taskTitle, Math.max(10, Math.floor(W / 4))) + '\u201d'));
    if (this.scroll > 0) marks.push(T.warn('↕' + this.scroll + (this.followAnchor != null ? ' 暂停跟随' : '')));
    if (this.nativeMouse) marks.push(T.dimmer('原生鼠标'));
    if (this.histOverlay) marks.push(T.accent2('历史'));
    const right = marks.length ? `${marks.join(' ')} ` : ' ';
    return paintRow(left, right, W, 236);
  }

  // ------------------------------------------------------- custom providers
  providerLine(p) {
    const marks = [];
    if (p.custom) marks.push(T.dim('★自定义'));
    if (this.config.hasKey(p.id)) marks.push(T.ok('key √'));
    if (this.config.active.provider === p.id) marks.push(T.accent('当前'));
    const models = (p.models || []).map((m) => m.id).join(', ');
    const tail = models ? T.dimmer(` · ${models}`) : T.dimmer(' · 无模型，用 /provider model ' + p.id + ' <模型id>');
    return `  ${T.accent(p.id.padEnd(12))}${T.dim(p.name)}${marks.length ? '  ' + marks.join(' ') : ''}${tail}`;
  }

  handleProvider(rest, arg) {
    const sub = (rest[0] || '').toLowerCase();
    const listCmd = () =>
      this.push({
        kind: 'multi',
        lines: [
          T.headerLine(' 服务商 '),
          ...providerList().map((x) => this.providerLine(x)),
          '',
          T.dim('用法：/provider add <id> <baseUrl> [名称]  ·  /provider key <id> <key>  ·  /provider model <id> <模型id…>  ·  /provider models <id>  ·  /provider rm <id>')
        ],
      });

    if (!sub || sub === 'list') return listCmd();

    if (sub === 'add') {
      const [, id, baseUrl, ...nameParts] = rest;
      if (!id || !baseUrl) return this.push({ kind: 'warn', text: '用法：/provider add <id> <baseUrl> [名称]   例如 /provider add mygw http://127.0.0.1:8000/v1 我的网关' });
      if (!/^https?:\/\//.test(baseUrl)) return this.push({ kind: 'warn', text: 'baseUrl 需要以 http:// 或 https:// 开头（通常以 /v1 结尾）。' });
      const name = nameParts.join(' ') || id;
      this.config.addProvider({ id, name, baseUrl });
      this.push({ kind: 'note', text: `已添加服务商 ${id}（${name}）→ ${baseUrl}` });
      this.push({ kind: 'note', text: `下一步：/provider key ${id} <key>，再 /provider model ${id} <模型id>，或用 /provider models ${id} 自动拉取` });
      return;
    }

    if (sub === 'rm' || sub === 'remove' || sub === 'del') {
      const id = rest[1];
      if (!id) return this.push({ kind: 'warn', text: '用法：/provider rm <id>' });
      if (!getProvider(id)?.custom) return this.push({ kind: 'warn', text: `${id} 不是自定义服务商，无法删除。` });
      this.config.removeProvider(id);
      if (this.config.active.provider === id) this.config.setActive('deepseek', 'deepseek-flash');
      return this.push({ kind: 'note', text: `已删除服务商 ${id}。` });
    }

    if (sub === 'key') {
      const id = rest[1];
      if (!id) return this.push({ kind: 'warn', text: '用法：/provider key <id> <key>' });
      const key = rest.slice(2).join(' ');
      const p = getProvider(id);
      if (!p) return this.push({ kind: 'warn', text: `没有服务商 ${id}。` });
      if (key) {
        this.config.setApiKey(id, key);
        return this.push({ kind: 'note', text: `${p.name} 的 API key 已保存。` });
      }
      return this.askLine(`粘贴 ${p.name} 的 API key`, (val) => {
        if (!val) return;
        this.config.setApiKey(id, val);
        this.push({ kind: 'note', text: `${p.name} 的 API key 已保存。` });
      }, { secret: true });
    }

    if (sub === 'model' || sub === 'models-add') {
      const [, id, ...ids] = rest;
      const p = getProvider(id);
      if (!p) return this.push({ kind: 'warn', text: `没有服务商 ${id}。先用 /provider add ${id} <baseUrl> 添加。` });
      if (!ids.length) return this.push({ kind: 'warn', text: `用法：/provider model ${id} <模型id> [更多…]` });
      if (!p.custom) return this.push({ kind: 'warn', text: `${id} 是内置服务商，模型列表固定；请添加自定义服务商来挂载自定义模型。` });
      for (const mid of ids) this.config.addProviderModel(id, mid);
      this.push({ kind: 'note', text: `${id} 已加入模型：${ids.join(', ')}（用 /model 选择）` });
      if (this.config.active.provider === id) this.applyModel(id, ids[0]);
      return;
    }

    if (sub === 'models') {
      const id = rest[1];
      const p = getProvider(id);
      if (!p) return this.push({ kind: 'warn', text: `没有服务商 ${id}。` });
      const shown = (p.models || []).map((m) => `  ${m.id}`);
      const cached = this.config.cachedModels(id) || [];
      if (cached.length) shown.push(...cached.filter((m) => !(p.models || []).some((x) => x.id === m)).map((m) => `  ${T.dim(m)}  (端点)`));
      this.push({ kind: 'multi', lines: [T.headerLine(` ${p.name} 的模型 `), ...(shown.length ? shown : ['  （暂无，用 /provider model 添加或点开 /model）'])] });
      this.listRemoteModels(id);
      return;
    }

    return listCmd();
  }

  /** Ask the endpoint for /v1/models and cache the ids. */
  async listRemoteModels(pid) {
    const p = getProvider(pid);
    if (!p) return;
    const key = this.config.apiKeyFor(pid);
    if (!key && !p.noKey) return;
    try {
      const { listProviderModels } = await import('../llm.js');
      const ids = await listProviderModels({ provider: pid, apiKey: key, baseUrl: this.config.baseUrl(pid) });
      if (!ids || !ids.length) return;
      this.config.cacheModels(pid, ids);
      this.push({ kind: 'note', text: `端点返回 ${ids.length} 个模型：${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ' …' : ''}` });
    } catch (e) {
      this.push({ kind: 'warn', text: `拉取模型列表失败：${e.message}` });
    }
  }

  /** Command completion popup (shown while the input looks like "/cmd"). */
  compPopupLines(W) {
    if (!this.compOpen) return [];
    const items = this.compItems();
    const max = Math.min(items.length, 8);
    const inner = W - 4;
    const rows = [];
    const nameW = Math.min(12, Math.max(...items.map((c) => c.name.length)) + 1);
    // keep the selection in the visible window
    const sel = Math.min(this.compIndex, items.length - 1);
    const start = Math.max(0, Math.min(sel - max + 1, items.length - max));
    rows.push(T.dimmer(`  ╭─ ${items.length} 个命令 · ↑↓ 选择 · Tab 补全 · Esc 关闭 `.padEnd(inner, '─') + '╮'));
    for (let i = start; i < start + max; i++) {
      const c = items[i];
      const on = i === sel;
      const name = c.name.padEnd(nameW);
      const args = (c.args || '').padEnd(20);
      let body = `${on ? T.accent('→') : ' '} ${on ? T.accentBold(name) : T.accent(name)} ${T.dim(args)} ${T.dimmer(c.desc)}`;
      body = truncToWidth(body, inner);
      const padded = padToWidth(body, inner);
      rows.push(on ? `  \x1b[48;5;238m${padded}\x1b[0m` : `  ${padded}`);
    }
    rows.push(T.dimmer(`  ╰${'─'.repeat(inner)}╯`));
    return rows;
  }

  /** Usage hint for a command that is already typed (e.g. "/key "). */
  argHintLines(W) {
    const text = this.input.text;
    if (!text.startsWith('/')) return [];
    const [head, ...rest] = text.trimStart().split(/\s+/);
    const cmd = COMMANDS.find((c) => c.name === head);
    if (!cmd || !cmd.args) return [];
    if (!text.includes(' ')) return [];
    const line = `  ${T.dimmer('用法')} ${T.accent(cmd.name)} ${T.dim(cmd.args)} ${T.dimmer('· ' + cmd.desc)}`;
    return [padToWidth(truncToWidth(line, W - 1), W - 1)];
  }

  statusBarLine(W) {
    const t = this.agent.target();
    let glyph = glyphs.bullet;
    let label = '就绪';
    let col = T.ok;
    if (this.askState) {
      glyph = glyphs.arrow;
      col = T.warn;
      label = '等你回答';
    } else if (this.running) {
      glyph = spinnerFrame(this.spin);
      col = T.accent2;
      label = this.stateDetail || '思考中';
    } else if (this.state === 'error') {
      glyph = glyphs.cross;
      col = T.err;
      label = '出错';
    }
    const segs = [col(`${glyph} ${label}`)];
    // 实时总用时：跑着的时候每帧心跳，停下来后固定显示本次用时
    if (this.running && this.taskT0) {
      segs.push(T.accent2('用时 ' + fmtDuration(Date.now() - this.taskT0)));
    } else if (this.lastElapsed != null) {
      segs.push(T.dim('用时 ' + fmtDuration(this.lastElapsed)));
    }
    const ctxPct = Math.round((this.context.used || 0) * 100);
    const ctxCol = ctxPct > 85 ? T.err : ctxPct > 65 ? T.warn : T.dim;
    segs.push(ctxCol(`ctx ${ctxPct}%`));
    if (this.usage.input || this.usage.output) {
      segs.push(T.dim(`↑${fmtNum(this.usage.input)} ↓${fmtNum(this.usage.output)}`));
      segs.push(T.dim(fmtMoney(this.usage.cost)));
    }
    if (this.toolCount) segs.push(T.dim(`* ${this.toolCount}`));
    // token 速度：流式时实时估算，收到 usage 后用真实输出 token 校正
    const speed = this.running ? this.speed : this.lastSpeed;
    if (speed > 0) segs.push(this.running ? T.accent2(`⚡${Math.round(speed)} tok/s`) : T.dim(`⚡${Math.round(speed)} tok/s`));
    const left = ' ' + segs.join(T.dimmer('  ·  '));
    const think = this.config.settings.thinking || 'medium';
    // Right side: provider · model · think, dropped piece by piece when narrow.
    const room = W - 6 - strWidth(stripAnsi(left));
    let right;
    const full = `${T.dim(t.provider.name + ' · ')}${T.accentBold(t.modelId)} ${T.dimmer('· ' + think)} `;
    const mid = `${T.accentBold(t.modelId)} ${T.dimmer('· ' + think)} `;
    const bare = `${T.accentBold(t.modelId)} `;
    if (strWidth(stripAnsi(full)) <= room) right = full;
    else if (strWidth(stripAnsi(mid)) <= room) right = mid;
    else if (strWidth(stripAnsi(bare)) <= room) right = bare;
    else right = truncToWidth(T.accentBold(t.modelId), Math.max(8, room - 2)) + ' ';
    return paintRow(left, right, W, 235);
  }

  // ---------------------------------------------------------------- input UI
  wrapInput(avail) {
    const chars = Array.from(this.input.text);
    const rows = [{ text: '' }];
    const cursor = this.input.cursor;
    let cursorRow = 0;
    let cursorCol = 0;
    let unit = 0;
    let cw = 0;
    let cur = [];
    if (cursor === 0) {
      cursorRow = 0;
      cursorCol = 0;
    }
    for (const ch of chars) {
      if (ch === '\n') {
        rows[rows.length - 1].text = cur.join('');
        cur = [];
        cw = 0;
        unit += 1;
        rows.push({ text: '' });
        if (unit === cursor) {
          cursorRow = rows.length - 1;
          cursorCol = 0;
        }
        continue;
      }
      const w = charWidth(ch);
      if (cw + w > avail && cur.length) {
        rows[rows.length - 1].text = cur.join('');
        cur = [];
        cw = 0;
        rows.push({ text: '' });
      }
      cur.push(ch);
      cw += w;
      unit += ch.length;
      if (unit === cursor) {
        cursorRow = rows.length - 1;
        cursorCol = cw;
      }
    }
    rows[rows.length - 1].text = cur.join('');
    return { rows, cursorRow, cursorCol };
  }

  inputBoxLines(W) {
    const busy = this.running;
    const cancelling = busy && Date.now() - (this.cancelAt || 0) < 3000;
    const label = this.prompt
      ? ` ${T.accent2(this.prompt.question)} `
      : cancelling
        ? ` ${T.warn('中断中…')} ${T.dimmer('· 再按 ESC 强制结束')} `
        : busy
          ? ` ${T.warn('ESC 中断')} ${T.dimmer('· Enter 插话 · Tab 排队 · Ctrl+O 思考')}${this.pending.length ? T.accent2(` · 待发 ${this.pending.length}/${this.maxPending} `) : ''} `
          : ` ${T.dim('Enter 发送')} ${T.dimmer('· 拖选复制 · Ctrl+V 粘贴 · Ctrl+J 换行 · / 命令 · Ctrl+C 退出')} `;
    const labelW = strWidth(stripAnsi(label));
    const top = T.dimmer('╭─') + label + T.dimmer('─'.repeat(Math.max(0, W - 4 - labelW)) + '╮');

    const avail = W - 6;
    const { rows, cursorRow, cursorCol } = this.wrapInput(avail);
    const maxInner = 6;
    const inner = clamp(rows.length, 1, maxInner);
    let offset = 0;
    if (rows.length > maxInner) offset = clamp(cursorRow - maxInner + 1, 0, rows.length - maxInner);

    const out = [top];
    const secret = !!this.prompt?.secret;
    for (let i = 0; i < inner; i++) {
      const r = rows[offset + i];
      const first = offset + i === 0;
      const promptStr = first ? T.accentBold('> ') : '  ';
      // 密码/API key 类输入不把内容画到屏幕上（只留等长的点）
      const body = r ? (secret ? '\u2022'.repeat(strWidth(stripAnsi(r.text))) : r.text) : '';
      const padded = body + ' '.repeat(Math.max(0, avail - strWidth(body)));
      out.push(`${T.dimmer('│')} ${promptStr}${T.plain(padded)} ${T.dimmer('│')}`);
    }
    out.push(T.dimmer('╰' + '─'.repeat(W - 2) + '╯'));
    if (this.pending.length) {
      const tag = T.accent2(` ⏳ 待发 ${this.pending.length}/${this.maxPending} `);
      const room = Math.max(0, W - strWidth(stripAnsi(tag)) - 2);
      const listText = this.pending
        .map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, ' ').trim()}`)
        .join('   ');
      out.unshift(T.plain(' ') + tag + T.dimmer(truncToWidth(listText, room)));
    }
    this.inputView = { rows, cursorRow, cursorCol, inner, offset, avail };
    return out;
  }

  /** Draw the model picker as a centred floating box over the transcript. */
  composeOverlay(frame, W, H, top, transcriptH) {
    const p = this.picker;
    const boxW = Math.min(W - 4, 78);
    const inner = boxW - 4;
    const entries = p.items;
    const maxRows = Math.max(5, transcriptH - 2);
    const rowH = Math.max(5, Math.min(maxRows, entries.length + 4));
    const visible = Math.max(1, rowH - 4);
    if (p.index < (p.offset || 0)) p.offset = p.index;
    if (p.index >= (p.offset || 0) + visible) p.offset = p.index - visible + 1;
    p.offset = clamp(p.offset || 0, 0, Math.max(0, entries.length - visible));

    const lines = [];
    const title = ` ${T.accentBold('选择模型')} ${T.dimmer('输入即筛选 · Enter 选择 · ESC 取消')} `;
    const titleW = strWidth(stripAnsi(title));
    lines.push(T.dimmer('╭─') + title + T.dimmer('─'.repeat(Math.max(0, boxW - 4 - titleW)) + '╮'));
    const filterText = p.filter ? T.white(p.filter) : T.dimmer('输入关键词筛选服务商 / 模型');
    lines.push(`${T.dimmer('│')} ${T.accent2('/')} ${padToWidth(truncToWidth(filterText, inner - 2), inner - 2)} ${T.dimmer('│')}`);
    lines.push(T.dimmer('├' + '─'.repeat(boxW - 2) + '┤'));

    for (let i = 0; i < visible; i++) {
      const idx = p.offset + i;
      const it = entries[idx];
      if (!it) {
        lines.push(`${T.dimmer('│')}${' '.repeat(boxW - 2)}${T.dimmer('│')}`);
        continue;
      }
      const selected = idx === p.index;
      let body = '';
      if (it.type === 'header') {
        body = T.accent2(it.provider.name) + T.dimmer(`  ${it.provider.id}${it.keyed ? ' √' : ' · 未配置 key'}`);
      } else if (it.type === 'custom') {
        body = T.dimmer('＋ 输入自定义模型 ID…');
      } else {
        const m = it.model;
        const ctx = m.ctx ? `${fmtNum(m.ctx)} ctx` : '';
        const price = m.cost ? `$${m.cost.in} / $${m.cost.out}` : '';
        const isActive = this.config.active.provider === it.provider.id && this.config.active.model === m.id;
        const tag = isActive ? T.ok('●') : m.reasoning ? T.accent2('◆') : ' ';
        const namePart = isActive ? T.accentBold(m.id) : T.white(m.id);
        body = `${tag} ${namePart} ${T.dimmer([m.name !== m.id ? m.name : '', ctx, price].filter(Boolean).join(' · '))}`;
      }
      if (selected) {
        const seg = padToWidth(truncToWidth(body, inner), inner);
        lines.push(`${T.dimmer('│')}\x1b[48;5;238m${T.accent('→')}${seg} \x1b[0m${T.dimmer('│')}`);
      } else {
        lines.push(`${T.dimmer('│')} ${padToWidth(truncToWidth(body, inner), inner)} ${T.dimmer('│')}`);
      }
    }
    lines.push(T.dimmer('╰' + '─'.repeat(boxW - 2) + '╯'));

    const startRow = top + Math.max(0, Math.floor((transcriptH - lines.length) / 2));
    const padL = Math.max(0, Math.floor((W - boxW) / 2));
    const padR = Math.max(0, W - boxW - padL);
    lines.forEach((ln, i) => {
      const r = startRow + i;
      if (r >= 0 && r < frame.length) frame[r] = ' '.repeat(padL) + padToWidth(ln, boxW) + ' '.repeat(padR);
    });
  }

  // ------------------------------------------------- selection & clipboard
  selActive() {
    if (!this.sel) return false;
    const { a, b } = this.sel;
    return !(a.row === b.row && a.col === b.col);
  }

  selNorm() {
    const { a, b } = this.sel;
    const forward = a.row < b.row || (a.row === b.row && a.col <= b.col);
    return forward
      ? { r0: a.row, c0: a.col, r1: b.row, c1: b.col }
      : { r0: b.row, c0: b.col, r1: a.row, c1: a.col };
  }

  shiftSel(delta) {
    if (!this.sel) return;
    const H = Math.max(1, this.lastFrameH);
    for (const k of ['a', 'b']) {
      this.sel[k].row = clamp(this.sel[k].row + delta, 1, H);
    }
  }

  /** Slice plain text by display columns (CJK = 2 columns). */
  sliceCols(plain, c0, c1) {
    let col = 0;
    let out = '';
    for (const ch of plain) {
      const w = charWidth(ch);
      if (col + w > c0 && col < c1) out += ch;
      col += w;
      if (col >= c1) break;
    }
    return out;
  }

  /** Reverse-video the selected screen cells. */
  applySelection(rows) {
    const { r0, c0, r1, c1 } = this.selNorm();
    const out = rows.slice();
    for (let r = r0; r <= r1; r++) {
      const i = r - 1;
      if (i < 0 || i >= rows.length) continue;
      const line = rows[i];
      const w = strWidth(stripAnsi(line));
      const s = r === r0 ? Math.min(c0 - 1, w) : 0;
      const e = r === r1 ? Math.min(c1 - 1, w) : w;
      if (e <= s) continue;
      const [head, rest] = cutAnsi(line, s);
      const [mid, tail] = cutAnsi(rest, e - s);
      if (!mid) continue;
      const rev = mid.split('\x1b[0m').join('\x1b[0m\x1b[48;5;238m\x1b[97m');
      out[i] = `${head}\x1b[48;5;238m\x1b[97m${rev}\x1b[0m${tail}`;
    }
    return out;
  }

  handleMouse(ev) {
    const k = ev.key;
    if (k === 'wheel-up') {
      this.sel = null;
      return this.scrollBy(3);
    }
    if (k === 'wheel-down') {
      this.sel = null;
      return this.scrollBy(-3);
    }
    if (this.nativeMouse) return;
    const H = Math.max(1, this.lastFrameH);
    const W = Math.max(20, this.width - 2);
    const y = clamp(ev.y, 1, H);
    const x = Math.max(1, ev.x);
    const onBar = x >= W && y >= 2 && y <= (this.viewInfo?.viewH ?? 1) + 1;

    if (k === 'mouse-down') {
      if (ev.button === 2) return this.pasteFromClipboard(); // 右键 = 粘贴（同 conhost）
      if (ev.button !== 0) {
        this.sel = null;
        this.dirty = true;
        return;
      }
      if (onBar) {
        this.sbDrag = true;
        this.sel = null;
        return this.scrollbarTo(y);
      }
      this.sel = { a: { row: y, col: x }, b: { row: y, col: x } };
      this.selDragging = true;
      this.dirty = true;
      return;
    }
    if (k === 'mouse-drag') {
      if (this.sbDrag) return this.scrollbarTo(y);
      if (!this.selDragging || !this.sel) return;
      this.sel.b = { row: y, col: x };
      // 拖到边缘自动滚动
      if (ev.y <= 1) {
        this.scroll += 1;
        this.shiftSel(1);
      } else if (ev.y >= H) {
        this.scroll = Math.max(0, this.scroll - 1);
        this.shiftSel(-1);
      }
      this.dirty = true;
      return;
    }
    if (k === 'mouse-up') {
      if (this.sbDrag) {
        this.sbDrag = false;
        this.dirty = true;
        return;
      }
      if (!this.selDragging) return;
      this.selDragging = false;
      if (this.selActive()) return this.copySelection();
      // 单击（没拖出选区）：点在可折叠块上就展开/收起
      const hit = (this.rowMap || []).find((r) => r.item?.collapsible && y >= r.from && y <= r.to);
      this.sel = null;
      this.dirty = true;
      if (hit) this.toggleItem(hit.item);
      return;
    }
  }

  async copySelection() {
    if (!this.selActive()) return;
    const { r0, c0, r1, c1 } = this.selNorm();
    const rows = this.lastFrameRaw || [];
    const parts = [];
    for (let r = r0; r <= r1; r++) {
      const plain = stripAnsi(rows[r - 1] || '');
      const w = strWidth(plain);
      const s = r === r0 ? Math.min(c0 - 1, w) : 0;
      const e = r === r1 ? Math.min(c1 - 1, w) : w;
      parts.push(this.sliceCols(plain, s, Math.max(s, e)).replace(/\s+$/, ''));
    }
    const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    this.sel = null;
    if (!text) {
      this.dirty = true;
      return;
    }
    await this.copyText(text, '选区');
  }

  async copyText(text, label = '文本') {
    const res = await writeClipboard(text, (s) => process.stdout.write(`\x1b]52;c;${Buffer.from(s, 'utf8').toString('base64')}\x07`));
    if (res.ok) this.push({ kind: 'note', text: `已复制${label} ${text.length} 字符到剪贴板`, inline: true });
    else this.push({ kind: 'warn', text: `复制失败：${res.err || '剪贴板不可用'}` });
    this.dirty = true;
    this.render(true);
  }

  async pasteFromClipboard() {
    const res = await readClipboard();
    let text = (res.text || '').replace(/\r?\n/g, '\n').replace(/\t/g, '  ');
    if (!text.trim()) {
      // 剪贴板里是截图？终端画不出图片，就把图片存成临时 PNG、把路径填进输入框，
      // 发送后模型用 read 工具就能看到这张图。
      const img = await readClipboardImage();
      if (img.ok) {
        const paths = (img.paths && img.paths.length ? img.paths : [img.path]).map(quotePath).join(' ');
        if (this.running) {
          this.agent.queue(paths);
          this.push({ kind: 'note', text: `剪贴板里是图片，已插话图片路径（当前步骤结束后生效）`, inline: true });
          this.dirty = true;
          return this.render(true);
        }
        this.insertText(paths);
        this.push({
          kind: 'note',
          text: `剪贴板里是图片，已存成 ${img.path} 并填入输入框（回车发送，我就能看图）`,
          inline: true,
        });
        this.dirty = true;
        return this.render(true);
      }
      if (!res.ok) {
        this.push({ kind: 'warn', text: `读取剪贴板失败：${res.err || '剪贴板不可用'}（可用 /native 开原生鼠标，再用终端自带的粘贴）` });
        this.dirty = true;
        return this.render(true);
      }
      this.push({ kind: 'note', text: '剪贴板是空的（文本和图片都没读到）', inline: true });
      this.dirty = true;
      return this.render(true);
    }
    const long = text.length > 200000;
    if (long) text = text.slice(0, 200000);
    if (this.running) {
      this.agent.queue(text.trim());
      this.push({ kind: 'note', text: `已插话 ${text.length} 字符（当前步骤结束后生效）`, inline: true });
      this.dirty = true;
      return this.render(true);
    }
    this.insertPasted(text);
    this.push({ kind: 'note', text: `已粘贴 ${text.length} 字符${long ? '（超长已截断）' : ''}${text.length >= 1200 ? '，折叠成占位符' : ''}`, inline: true });
    this.dirty = true;
    this.render(true);
  }

  copyLastReply(n = 1) {
    const replies = this.items.filter((i) => i.kind === 'assistant' && i.text && i.text.trim());
    if (!replies.length) {
      this.push({ kind: 'note', text: '还没有可复制的回答', inline: true });
      this.dirty = true;
      return this.render(true);
    }
    const it = replies[Math.min(replies.length, Math.max(1, n)) - 1];
    const idx = replies.length - Math.min(replies.length, Math.max(1, n)) + 1;
    void idx;
    return this.copyText(it.text, '回答');
  }

  toggleNativeMouse() {
    this.nativeMouse = !this.nativeMouse;
    this.sel = null;
    process.stdout.write(
      this.nativeMouse ? '\x1b[?1006l\x1b[?1002l\x1b[?1000l' : '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
    );
    this.push({
      kind: 'note',
      text: this.nativeMouse
        ? '已切到原生鼠标：现在可以用鼠标拖选，并用终端自己的复制（右键 / Ctrl+Shift+C）。注意：应用内的滚轮滚动会失效，再执行 /native 切回'
        : '已切回应用内鼠标：可以拖选复制（松手自动进剪贴板）、右键粘贴、滚轮滚动、Ctrl+V 粘贴',
    });
    this.dirty = true;
    this.render(true);
  }

  // -------------------------------------------------------------- history
  filterHistItems() {
    const h = this.histOverlay;
    if (!h) return [];
    const f = (h.filter || '').toLowerCase();
    if (!f) return h.items;
    return h.items.filter((s) => `${s.title} ${s.id} ${s.model} ${s.cwd || ''}`.toLowerCase().includes(f));
  }

  openHistory(filter = '') {
    const list = this.listSessions();
    if (!list.length) {
      this.push({ kind: 'note', text: '还没有历史会话（每轮结束会自动保存到 ~/.agent/sessions）' });
      this.dirty = true;
      return this.render(true);
    }
    this.histOverlay = { items: list, sel: 0, offset: 0, filter: String(filter || '') };
    this.dirty = true;
    this.render(true);
  }

  handleHistoryKey(ev) {
    const h = this.histOverlay;
    const k = ev.key;
    const list = this.filterHistItems();
    this.dirty = true;
    if (k === 'esc') {
      this.histOverlay = null;
      return;
    }
    if (k === 'up' || k === 'ctrl+p' || k === 'shift-tab') {
      h.sel = (h.sel - 1 + list.length) % Math.max(1, list.length);
      return;
    }
    if (k === 'down' || k === 'ctrl+n' || k === 'tab') {
      h.sel = (h.sel + 1) % Math.max(1, list.length);
      return;
    }
    if (k === 'enter') {
      const it = list[h.sel];
      if (!it) return;
      this.histOverlay = null;
      this.loadSessionFile(it.file);
      return;
    }
    if (k === 'd' || k === 'delete') {
      const it = list[h.sel];
      if (!it) return;
      try {
        fs.unlinkSync(it.file);
      } catch {}
      h.items = this.listSessions();
      h.sel = clamp(h.sel, 0, Math.max(0, h.items.length - 1));
      return;
    }
    if (k === 'backspace') {
      h.filter = h.filter.slice(0, -1);
      h.sel = 0;
      return;
    }
    if (k === 'text' || k === 'space') {
      h.filter += k === 'space' ? ' ' : ev.text;
      h.sel = 0;
      return;
    }
    if (k === 'ctrl+c') {
      this.histOverlay = null;
    }
  }

  composeHistoryOverlay(frame, W, H, transcriptH) {
    const h = this.histOverlay;
    const list = this.filterHistItems();
    const boxW = Math.min(W - 4, 88);
    const inner = boxW - 4;
    const maxRows = Math.max(8, transcriptH + 2);
    const visible = Math.max(1, Math.min(maxRows - 4, list.length || 1));
    if (h.sel < (h.offset || 0)) h.offset = h.sel;
    if (h.sel >= (h.offset || 0) + visible) h.offset = h.sel - visible + 1;
    h.offset = clamp(h.offset || 0, 0, Math.max(0, list.length - visible));

    const lines = [];
    const title = ` ${T.accentBold('历史对话')} ${T.dimmer('↑↓ 选择 · Enter 恢复 · d 删除 · ESC 关闭')} `;
    const titleW = strWidth(stripAnsi(title));
    lines.push(T.dimmer('╭─') + title + T.dimmer('─'.repeat(Math.max(0, boxW - 4 - titleW)) + '╮'));
    lines.push(`${T.dimmer('│')} ${T.accent2('/')} ${padToWidth(truncToWidth(h.filter ? T.white(h.filter) : T.dimmer('输入关键词筛选（标题 / 模型 / 目录）'), inner - 2), inner - 2)} ${T.dimmer('│')}`);
    lines.push(T.dimmer('├' + '─'.repeat(boxW - 2) + '┤'));

    for (let i = 0; i < visible; i++) {
      const idx = h.offset + i;
      const s = list[idx];
      if (!s) {
        lines.push(`${T.dimmer('│')}${' '.repeat(boxW - 2)}${T.dimmer('│')}`);
        continue;
      }
      const when = timeAgo(s.updated);
      const dir = s.cwd ? path.basename(s.cwd) : '';
      const tail = [String(s.msgs) + ' 条', dir ? truncToWidth(dir, 14) : '', truncToWidth(String(s.model || ''), 16)].filter(Boolean).join(' · ');
      const body = `${T.dimmer(when.padEnd(9))} ${T.white(truncToWidth(s.title || '(无标题)', Math.max(10, inner - 46)))} ${T.dimmer(tail)}`;
      if (idx === h.sel) {
        const seg = padToWidth(truncToWidth(body, inner), inner);
        lines.push(`${T.dimmer('│')}\x1b[48;5;238m${T.accent('→')}${seg} \x1b[0m${T.dimmer('│')}`);
      } else {
        lines.push(`${T.dimmer('│')} ${padToWidth(truncToWidth(body, inner), inner)} ${T.dimmer('│')}`);
      }
    }
    lines.push(T.dimmer('╰' + '─'.repeat(boxW - 2) + '╯'));
    const startRow = Math.max(0, Math.floor((H - lines.length) / 2));
    const padL = Math.max(0, Math.floor((W - boxW) / 2));
    const padR = Math.max(0, W - boxW - padL);
    lines.forEach((ln, i) => {
      const r = startRow + i;
      if (r >= 0 && r < frame.length) frame[r] = ' '.repeat(padL) + padToWidth(ln, boxW) + ' '.repeat(padR);
    });
  }

  loadSessionFile(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.agent.setSession(data);
      this.agent.sessionId = data.id;
      this.title = data.title || '';
      if (Array.isArray(data.items) && data.items.length) this.items = data.items.map((it) => ({ ...it }));
      if (data.provider && data.model) {
        try {
          this.config.setActive(data.provider, data.model);
          this.agent.setActive(data.provider, data.model);
        } catch {}
      }
      this.scroll = 0;
      this.sel = null;
      const st = this.agent.engine?.stats;
      if (st) this.context = { tokens: st.tokens || 0, maxTokens: st.maxTokens || 128000, used: st.used || 0 };
      this.push({ kind: 'note', text: `已恢复会话 ${data.id} · ${this.items.length} 条记录` });
    } catch (e) {
      this.push({ kind: 'error', text: `恢复失败: ${e.message}` });
    }
    this.dirty = true;
    this.render(true);
  }

  // -------------------------------------------------------- trust / undo
  setTrust(arg) {
    const cur = this.config.allowOutsideCwd;
    const want = arg === 'on' ? true : arg === 'off' ? false : !cur;
    const v = this.config.setAllowOutside(want);
    this.push({
      kind: v ? 'warn' : 'note',
      text: v
        ? '全权模式已开启：AI 可以读写工作区之外的文件（谨慎，用 /trust off 关闭）'
        : '已切回工作区模式：工作区之外的写入会被拒绝',
    });
    this.dirty = true;
    this.render(true);
  }

  undoCheckpoint(n) {
    const steps = this.checkpoints.list();
    if (!steps.length) {
      this.push({ kind: 'note', text: '没有可回滚的快照（每次 write/edit 前会自动快照）' });
      this.dirty = true;
      return this.render(true);
    }
    const res = this.checkpoints.restore(n ? Number(n) : undefined);
    if (!res.ok) this.push({ kind: 'warn', text: res.error || '回滚失败' });
    else
      this.push({
        kind: 'note',
        text: `已回滚检查点 #${res.step}：${res.restored.length} 个文件恢复${res.missing.length ? `，${res.missing.length} 个失败` : ''}`,
      });
    this.dirty = true;
    this.render(true);
  }

  computeCursor(W, totalRows, transcriptH, box) {
    if (this.picker || this.histOverlay || this.askState) return null;
    const v = this.inputView;
    if (!v) return null;
    const insideRow = clamp(v.cursorRow - v.offset, 0, v.inner - 1);
    // 1 行 header + transcriptH 行正文 + 1 行输入框上边框(label 行)，光标在输入行
    const row = 1 + transcriptH + 2 + insideRow; // 1-based
    const col = clamp(2 + 2 + v.cursorCol + 1, 1, W);
    return { row: clamp(row, 1, totalRows), col };
  }

  // -------------------------------------------------------------- transcript
  transcriptLines(W) {
    const width = W - 2;
    const out = [];
    const spans = [];
    for (const item of this.items) {
      // 运行中的思考/工具块要每帧重算（计时和 spinner 在动），不进缓存
      const live = item.status === 'running' || (item.kind === 'think' && !item.done);
      let lines;
      if (!live && item._cache && item._cacheW === W && item._cacheVer === item.ver) {
        lines = item._cache;
      } else {
        lines = this.renderItem(item, width);
        if (!live) {
          item._cache = lines;
          item._cacheW = W;
          item._cacheVer = item.ver;
        }
      }
      spans.push({ item, start: out.length, end: out.length + lines.length - 1 });
      out.push(...lines);
    }
    this._itemSpans = spans;
    return out;
  }

  renderItem(item, width) {
    const out = [];
    switch (item.kind) {
      case 'banner': {
        out.push('');
        for (const l of item.lines) out.push('  ' + l);
        out.push('');
        break;
      }
      case 'user': {
        const text = item.text.replace(/\n$/, '');
        const lines = wrapWords(T.bold(T.white(text)), width - 4, { prefix: '', hang: 2 });
        lines.forEach((ln, i) => {
          out.push(i === 0 ? `  ${T.accent('│')} ${ln}` : `    ${ln}`);
        });
        out.push('');
        break;
      }
      case 'assistant': {
        if (item.text && item.text.trim()) {
          const body = renderMarkdown(item.text, width, {
            streaming: !!item.streaming,
            maxLines: item.collapsed ? 24 : this.verbose ? 200 : 90,
          });
          const limit = this.verbose ? 40 : 16;
          if (item.collapsible && item.collapsed && body.length > limit) {
            out.push(...body.slice(0, limit - 2));
            out.push(`  ${T.dimmer(`${glyphs.arrowDown} 还有 ${body.length - limit + 2} 行 · 点击或 Ctrl+O 展开`)}`);
          } else {
            out.push(...body);
            if (item.collapsible && item.collapsed === false && body.length > limit) {
              out.push(`  ${T.dimmer(`${glyphs.arrowUp} 点击或 Ctrl+O 收起`)}`);
            }
          }
          out.push('');
        }
        break;
      }
      case 'think': {
        // 思考块：流式时黄色高亮 + 计时，结束后收起为 "Thought for Xs"
        const ms = item.done ? item.dur || 0 : Date.now() - (item.t0 || Date.now());
        const secs = (ms / 1000).toFixed(1) + 's';
        const open = item.done ? !item.collapsed : true;
        if (item.done) {
          // 收工后保持和 “Thinking…” 同一套黄色高亮，别突然褪成灰色
          const arrow = open ? glyphs.arrowUp : glyphs.arrowDown;
          const label = T.bold(T.warn(`Thought for ${secs}`));
          out.push(`  ${T.warn(arrow)} ${label}${open ? '' : T.warn(' · 点击展开')}`);
        } else {
          out.push(`  ${T.warn(spinnerFrame(this.spin))} ${T.bold(T.warn(`Thinking\u2026 ${secs}`))}`);
        }
        const body = item.text ? wrapWords(T.italic(T.think(item.text.trim())), width - 6, { prefix: '', hang: 2 }) : [];
        if (open && body.length) {
          // 流式时只画最后几行，像文字在往上涌；停下后展开就是全文
          const cap = item.done ? body.length : 8;
          const shown = body.slice(Math.max(0, body.length - cap));
          if (shown.length < body.length) out.push(`    ${T.dimmer(`\u2026 前面 ${body.length - shown.length} 行也收着`)}`);
          for (const ln of shown) out.push('    ' + T.dimmer(ln));
        } else if (!item.done) {
          out.push(`    ${T.dimmer('\u2026')}`);
        }
        out.push('');
        break;
      }
      case 'tool': {
        // 工具块封装：主标签（技能名 / 块 id / 工具名）+ 「· 标签 · 标签」小字，
        // 收起时用 meta.summary 或首行做摘要，展开时末尾补一句注脚。
        const view = describeTool(item);
        const label = truncToWidth(view.label, Math.max(12, Math.floor(width * 0.4)));
        const hintStr = view.hint ? ' ' + T.dim(truncToWidth(view.hint, Math.max(10, width - 26))) : '';
        const tagStr = view.tags.length ? ' ' + view.tags.map((t) => (TAG_STYLE[t.s] || TAG_STYLE.info)(t.t)).join(T.dimmer(' · ')) : '';
        const labelStyle = view.tone === 'memory' ? T.accent2 : T.accent;
        // 图片被 read 工具读进来了：标一下尺寸，让玩家知道模型确实「看到了」
        const img = item.meta?.kind === 'image' ? item.meta.images?.[0] : null;
        const imgTag = img
          ? ' ' + T.accent2('[图片' + (img.width ? ' ' + img.width + 'x' + img.height : '') + ' · ' + fmtBytes(item.meta.bytes || 0) + ']')
          : '';
        const open = item.status === 'running' ? true : !item.collapsed;
        const arrow = item.status === 'running' ? glyphs.dot : open ? glyphs.arrowUp : glyphs.arrowDown;
        if (item.status === 'running') {
          out.push(`  ${T.accent2(spinnerFrame(this.spin))} ${arrow}${T.bold(labelStyle(label))}${hintStr}${tagStr}`);
        } else if (item.status === 'error' || item.isError) {
          out.push(`  ${T.err(glyphs.cross)} ${T.bold(labelStyle(label))}${hintStr}${tagStr}${imgTag} ${T.err('失败')} ${T.dimmer(fmtDuration(item.dur || 0))}`);
        } else {
          out.push(`  ${T.ok(glyphs.check)} ${T.dimmer(arrow)} ${T.bold(labelStyle(label))}${hintStr}${tagStr}${imgTag} ${T.dimmer(fmtDuration(item.dur || 0))}`);
        }
        if (img && item.status !== 'running') {
          // 图片块只留一行摘要：说清画的是什么 + 模型确实看见了
          const sum = (view.summary || '').trim();
          const line = sum ? `${sum} · 图片已附进对话，模型能直接看到` : '图片已附进对话，模型能直接看到';
          out.push(`    ${T.dimmer(truncToWidth(line, Math.max(10, width - 16)))}`);
          out.push('');
          break;
        }
        if (item.status !== 'running' && item.content && item.meta?.silent !== true) {
          if (open) {
            const max = item.isError ? 20 : this.verbose ? 40 : 8;
            const p = previewLines(item.content, width - 2, max);
            for (const ln of p) out.push(`    ${item.isError ? T.err(ln) : T.dim(ln)}`);
            if (view.note && !item.isError) out.push(`    ${T.dimmer(`… ${view.note}`)}`);
          } else {
            const all = item.content.split(String.fromCharCode(10));
            const first = (view.summary || all.find((l) => l.trim()) || '').trim();
            if (first) out.push(`    ${T.dimmer(truncToWidth(first, Math.max(10, width - 16)))}`);
            if (all.length > 1) out.push(`    ${T.dimmer(`${glyphs.arrowDown} ${all.length} 行 · 点击展开`)}`);
          }
        }
        out.push('');
        break;
      }
      case 'note': {
        const lines = wrapWords(T.dim(item.text), width - 6, { prefix: '', hang: 2 });
        lines.forEach((ln, i) => out.push(i === 0 ? `  ${T.dimmer('·')} ${ln}` : `    ${ln}`));
        if (!item.inline) out.push('');
        break;
      }
      case 'warn': {
        const lines = wrapWords(T.warn(item.text), width - 6, { prefix: '', hang: 2 });
        lines.forEach((ln, i) => out.push(i === 0 ? `  ${T.warn('!')} ${ln}` : `    ${ln}`));
        out.push('');
        break;
      }
      case 'error': {
        const lines = wrapWords(T.err(item.text), width - 6, { prefix: '', hang: 2 });
        lines.forEach((ln, i) => out.push(i === 0 ? `  ${T.err(glyphs.cross)} ${ln}` : `    ${ln}`));
        out.push('');
        break;
      }
      case 'compacted': {
        out.push(`  ${T.accent2('~')} ${T.accent2(item.text)}`);
        out.push('');
        break;
      }
      case 'multi': {
        for (const l of item.lines) out.push('  ' + l);
        out.push('');
        break;
      }
      default: {
        out.push('  ' + String(item.text || ''));
        out.push('');
      }
    }
    return out;
  }

  // ---------------------------------------------------------- ask（AI 提问）
  /** 把 agent 的 ask 工具接到界面上：工具会一直挂着，直到玩家选完。 */
  bindAgent() {
    this.agent.setAskHandler((payload) => this.askPlayer(payload));
    // 子代理 / 团队工具把进度推回界面：成员开工、完成、失败都会变成一条 note
    this.agent.setEventSink((item) => {
      if (item && typeof item === 'object') this.push(item);
    });
  }

  askPlayer(payload) {
    const options = (payload?.options || []).map((o) => (typeof o === 'string' ? { label: o, desc: '' } : o));
    return new Promise((resolve) => {
      this.askState = {
        question: String(payload?.question || '').trim(),
        options,
        multi: !!payload?.multi,
        def: payload?.default || '',
        sel: 0,
        picked: new Set(),
        other: '',
        cur: 0, // 自定义输入的光标位置（可左右移动、能在中间插入粘贴）
        resolve,
      };
      this.input = { text: '', cursor: 0 };
      this.dirty = true;
      this.render(true);
    });
  }

  finishAsk(result) {
    const st = this.askState;
    if (!st) return;
    this.askState = null;
    st.resolve?.(result);
    this.dirty = true;
    if (!this.quit) this.render(true);
  }

  togglePick(idx) {
    const st = this.askState;
    if (!st) return;
    if (st.picked.has(idx)) st.picked.delete(idx);
    else st.picked.add(idx);
  }

  submitAsk() {
    const st = this.askState;
    if (!st) return;
    const other = st.other.trim();
    if (other) {
      this.push({ kind: 'note', text: `你的回答：${other}` });
      return this.finishAsk({ answer: other });
    }
    if (st.multi && st.picked.size) {
      const labels = st.options.filter((_, i) => st.picked.has(i)).map((o) => o.label);
      this.push({ kind: 'note', text: `你的选择：${labels.join(' / ')}` });
      return this.finishAsk({ selections: labels });
    }
    const opt = st.options[st.sel];
    if (!opt) return this.finishAsk(null);
    this.push({ kind: 'note', text: `你的选择：${opt.label}` });
    return this.finishAsk({ answer: opt.label });
  }

  handleAskKey(ev) {
    const st = this.askState;
    const k = ev.key;
    this.dirty = true;
    const n = st.options.length || 1;
    if (k === 'esc' || k === 'ctrl+c') {
      this.push({ kind: 'note', text: '已跳过 AI 的提问（让它自己拿主意继续）' });
      return this.finishAsk(null);
    }
    if (k === 'up' || k === 'shift-tab') {
      st.sel = (st.sel - 1 + n) % n;
      return;
    }
    if (k === 'down' || k === 'tab') {
      st.sel = (st.sel + 1) % n;
      return;
    }
    if (k === 'enter') return this.submitAsk();
    // 自定义输入的光标编辑（粘贴一长串之后要能改中间的字）
    if (k === 'left' || k === 'ctrl+b') {
      st.cur = Math.max(0, this.askCursor() - 1);
      return;
    }
    if (k === 'right' || k === 'ctrl+f') {
      st.cur = Math.min(st.other.length, this.askCursor() + 1);
      return;
    }
    if (k === 'home' || k === 'ctrl+a') {
      st.cur = 0;
      return;
    }
    if (k === 'end' || k === 'ctrl+e') {
      st.cur = st.other.length;
      return;
    }
    if (k === 'delete' || k === 'ctrl+d') {
      const c = this.askCursor();
      st.other = st.other.slice(0, c) + st.other.slice(c + 1);
      st.cur = c;
      return;
    }
    if (k === 'ctrl+u') {
      // 删掉光标前的全部内容（终端里清一整段粘贴的快捷手法）
      st.other = st.other.slice(this.askCursor());
      st.cur = 0;
      return;
    }
    if (k === 'ctrl+k') {
      st.other = st.other.slice(0, this.askCursor());
      st.cur = st.other.length;
      return;
    }
    if (k === 'ctrl+w') {
      // 删掉光标前的一个词
      const c = this.askCursor();
      const head = st.other.slice(0, c).replace(/[\w.\-~/\\]*$/, '');
      st.other = head + st.other.slice(c);
      st.cur = head.length;
      return;
    }
    if (k === 'backspace') {
      const c = this.askCursor();
      if (c > 0) {
        st.other = st.other.slice(0, c - 1) + st.other.slice(c);
        st.cur = c - 1;
      }
      return;
    }
    // 粘贴三条路都要通：
    //  - bracketed paste（终端自己的 Ctrl+Shift+V / 右键菜单）会带 ev.text，直接用
    //  - Ctrl+V / Ctrl+Shift+V 交给系统剪贴板（Windows 走 PowerShell Get-Clipboard）
    //  - 鼠标右键 = 粘贴（和输入框一致）。只认 mouse-down：Windows 上按下+抬起
    //    会各来一个事件，两边都贴就会贴两遍
    if (k === 'paste') return this.pasteIntoAsk(ev.text);
    if (k === 'ctrl+v' || k === 'ctrl+shift+v') return this.pasteIntoAsk();
    if (k === 'mouse-down' && ev.button === 2) return this.pasteIntoAsk();
    // 弹层里的其它鼠标/滚轮事件不处理，但别让它们掉进文本分支
    if (/^(mouse|wheel)/.test(k)) return;
    if (k === 'text') {
      const t = ev.text;
      if (t === ' ' && st.multi && !st.other) return this.togglePick(st.sel);
      // 还没开始打字时，数字键 = 直接选第 n 项
      if (!st.other && /^[1-9]$/.test(t) && Number(t) <= st.options.length) {
        const idx = Number(t) - 1;
        st.sel = idx;
        if (st.multi) return this.togglePick(idx);
        return this.submitAsk();
      }
      this.askInsert(t);
    }
  }

  /** ask 自定义输入的光标（老状态没有 cur 时按末尾算） */
  askCursor() {
    const st = this.askState;
    if (!st) return 0;
    const c = Number(st.cur);
    return Number.isFinite(c) ? Math.max(0, Math.min(st.other.length, c)) : st.other.length;
  }

  /** 在光标处插入文本（粘贴和打字都走这里） */
  askInsert(text) {
    const st = this.askState;
    if (!st || !text) return;
    const c = this.askCursor();
    st.other = st.other.slice(0, c) + text + st.other.slice(c);
    st.cur = c + text.length;
  }

  /**
   * AI 提问弹层里的粘贴：三种入口都走这里。
   *  - text 有值 = 终端给的 bracketed paste 内容（Windows Terminal 的 Ctrl+Shift+V、
   *    conhost 右键菜单、iTerm2 的 Cmd+V 都是这条路），直接用它，不碰剪贴板
   *  - text 为空 = Ctrl+V / 右键，自己去读系统剪贴板
   *  - 剪贴板里没有文字但有截图 = 存成临时 PNG，把路径填进去（模型能 read 看图）
   * 换行压成空格，因为弹层里的自定义输入是单行。
   */
  async pasteIntoAsk(raw) {
    const st = this.askState;
    if (!st) return;
    let text = typeof raw === 'string' ? raw : '';
    let fromClipboard = false;
    if (!text) {
      fromClipboard = true;
      try {
        const res = await readClipboard();
        text = res.text || '';
        if (!text.trim()) {
          // 剪贴板里是截图：终端画不出图，就把图片路径给出去，模型用 read 能看
          const img = await readClipboardImage();
          if (img.ok && (img.path || img.paths?.length)) {
            const paths = (img.paths && img.paths.length ? img.paths : [img.path]).map(quotePath).join(' ');
            this.askInsert(paths);
            this.push({ kind: 'note', text: '剪贴板里是图片，已把图片路径填入答案（回车发给 AI 前可再补充文字）', inline: true });
            this.dirty = true;
            return this.render(true);
          }
        }
      } catch { text = ''; }
    }
    text = String(text || '').replace(/\r\n?/g, '\n').replace(/\n/g, ' ').replace(/\t/g, '  ');
    if (!text.trim()) {
      this.push({
        kind: 'note',
        text: fromClipboard ? '剪贴板里没有文本可粘贴（可以先用终端自己的 Ctrl+Shift+V / 右键菜单）' : '没有可粘贴的内容',
        inline: true,
      });
      this.dirty = true;
      return this.render(true);
    }
    const long = text.length > 20000;
    if (long) text = text.slice(0, 20000);
    this.askInsert(text);
    this.push({ kind: 'note', text: `已粘贴 ${text.length} 字符到自定义输入${long ? '（超长已截断）' : ''}`, inline: true });
    this.dirty = true;
    this.render(true);
  }

  /** AI 提问的浮层：题目 + 选项 + 自定义输入行。 */
  composeAskOverlay(frame, W, H, transcriptH) {
    const st = this.askState;
    const boxW = Math.min(W - 4, 86);
    const inner = boxW - 4;
    const lines = [];
    const hint = st.multi
      ? '· 可多选 · ↑↓ 空格/数字 勾选 · ←→ 改答案 · Enter 确认 · 可粘贴(Ctrl+V/右键) · ESC 跳过'
      : '· 单选 · ↑↓ 数字直选 · ←→ 改答案 · Enter 确认 · 可粘贴(Ctrl+V/右键) · ESC 跳过';
    const title = ` ${T.accentBold('AI 需要确认')} ${T.dimmer(hint)} `;
    const titleW = strWidth(stripAnsi(title));
    lines.push(T.dimmer('╭─') + title + T.dimmer('─'.repeat(Math.max(0, boxW - 4 - titleW)) + '╮'));

    const qAll = wrapWords(st.question || '（没有问题正文）', Math.max(10, inner - 2));
    const q = qAll.slice(0, 6);
    if (qAll.length > q.length) q[5] = truncToWidth(q[5] + ' …', inner - 4);
    for (const l of q) lines.push(`${T.dimmer('│')} ${padToWidth(T.white(l), inner - 2)} ${T.dimmer('│')}`);
    if (st.def) lines.push(`${T.dimmer('│')} ${padToWidth(T.dimmer(`不选时默认：${st.def}`), inner - 2)} ${T.dimmer('│')}`);
    lines.push(T.dimmer('├' + '─'.repeat(boxW - 2) + '┤'));

    // 选项正文按盒宽自动换行：长选项不再挤成一行被截断，说明文字也换行显示。
    // 选项太多时只滚动窗口（跟着选中项走），并提示上下还藏了几项。
    const textW = Math.max(12, inner - 4);
    const bg = String.fromCharCode(27) + '[48;5;238m';
    const reset = String.fromCharCode(27) + '[0m';
    const blocks = st.options.map((o, i) => {
      const rec = o.recommended ? '（推荐）' : '';
      const labelLines = wrapWords(`${i + 1}. ${o.label}${rec}`, textW)
        .map((l) => l.replace(/ +$/, ''))
        .filter((l, idx, arr) => l || arr.length === 1);
      const descLines = o.desc
        ? wrapWords(o.desc, textW)
            .map((l) => l.replace(/ +$/, ''))
            .filter((l, idx, arr) => l || arr.length === 1)
        : [];
      return { labelLines: labelLines.length ? labelLines : [''], descLines };
    });
    const optRows = (b) => b.labelLines.length + b.descLines.length;
    const budget = Math.max(3, transcriptH - lines.length - 3 - 2);
    let start = st.sel;
    let used = optRows(blocks[start] || { labelLines: [''], descLines: [] });
    while (start > 0 && used + optRows(blocks[start - 1]) <= budget) {
      start--;
      used += optRows(blocks[start]);
    }
    let end = start;
    let fill = 0;
    while (end < blocks.length && fill + optRows(blocks[end]) <= budget) {
      fill += optRows(blocks[end]);
      end++;
    }
    if (end <= start) end = Math.min(blocks.length, start + 1);
    if (start > 0) {
      lines.push(`${T.dimmer('│')} ${padToWidth(T.dimmer(`… 上面还有 ${start} 项`), inner)} ${T.dimmer('│')}`);
    }
    for (let i = start; i < end; i++) {
      const b = blocks[i];
      const sel = i === st.sel;
      const mark = st.multi ? (st.picked.has(i) ? T.ok('[x]') : T.dimmer('[ ]')) : sel ? T.accent('(●)') : T.dimmer('( )');
      const rows = [];
      b.labelLines.forEach((l, li) => {
        const txt = sel ? T.accentBold(l) : T.white(l);
        rows.push(li === 0 ? `${mark} ${txt}` : `    ${txt}`);
      });
      for (const d of b.descLines) rows.push(`    ${T.dimmer(d)}`);
      const shown = rows.length > budget ? [...rows.slice(0, Math.max(1, budget - 1)), `    ${T.dimmer('…')}`] : rows;
      shown.forEach((body, ri) => {
        if (sel) {
          const seg = padToWidth(truncToWidth(body, inner + 1), inner + 1);
          const bullet = ri === 0 ? T.accent('→') : ' ';
          lines.push(`${T.dimmer('│')}${bg}${bullet}${seg}${reset}${T.dimmer('│')}`);
        } else {
          lines.push(`${T.dimmer('│')} ${padToWidth(truncToWidth(body, inner), inner)} ${T.dimmer('│')}`);
        }
      });
    }
    if (end < blocks.length) {
      lines.push(`${T.dimmer('│')} ${padToWidth(T.dimmer(`… 下面还有 ${blocks.length - end} 项`), inner)} ${T.dimmer('│')}`);
    }
    lines.push(T.dimmer('├' + '─'.repeat(boxW - 2) + '┤'));
    // 自定义输入行：带光标（粘贴一长串后要能看出光标在哪、能在中间接着输），
    // 文本超宽时窗口跟着光标走，不会把正在改的地方截掉。
    // 宽度对齐：'│ ' + '> ' + room + ' │' 要等于上面各行的 '│ ' + inner-2 + ' │'
    const room = Math.max(6, inner - 4);
    if (!st.other) {
      const ph = T.dimmer(truncToWidth('直接打字，或 Ctrl+V / 右键粘贴，输入你要的答案', room));
      lines.push(`${T.dimmer('│')} ${T.accent2('>')} ${'\x1b[7m \x1b[0m'}${padToWidth(' ' + ph, room)} ${T.dimmer('│')}`);
    } else {
      // st.cur 是 code-unit 下标（和 slice 一致），显示时按字符宽度排
      const cur = this.askCursor();
      const before = st.other.slice(0, cur);
      const after = st.other.slice(cur);
      // 前面放不下就从左边裁（保证光标在可见区），并在左端标个 ‹
      const budget = Math.max(2, room - 2);
      const bChars = Array.from(before);
      let w = 0;
      let cut = bChars.length;
      for (let i = bChars.length - 1; i >= 0; i--) {
        const cw = charWidth(bChars[i]);
        if (w + cw > budget) break;
        w += cw;
        cut = i;
      }
      const leftCut = cut > 0;
      const head = leftCut ? '\x1b[7m‹\x1b[0m' + bChars.slice(cut).join('') : bChars.join('');
      const used = w + (leftCut ? 1 : 0);
      const aChars = Array.from(after);
      let atChar = aChars[0] ?? null;
      if (atChar === '\n') atChar = ' ';
      const curMark = atChar ? `\x1b[7m${atChar}\x1b[0m` : '\x1b[7m \x1b[0m';
      const curW = atChar ? charWidth(atChar) : 1;
      let tail = '';
      let tw = 0;
      for (let i = atChar ? 1 : 0; i < aChars.length; i++) {
        const cw = charWidth(aChars[i]);
        if (used + curW + tw + cw > room - 1) {
          tail += '…'; // 省略号也占一列，留出位置才不会把右边框顶出去
          tw += 1;
          break;
        }
        tail += aChars[i] === '\n' ? ' ' : aChars[i];
        tw += cw;
      }
      const total = Math.min(room, used + curW + tw);
      lines.push(`${T.dimmer('│')} ${T.accent2('>')} ${T.white(head + curMark + tail)}${' '.repeat(Math.max(0, room - total))} ${T.dimmer('│')}`);
    }
    lines.push(T.dimmer('╰' + '─'.repeat(boxW - 2) + '╯'));

    const startRow = 1 + Math.max(0, Math.floor((transcriptH - lines.length) / 2));
    const padL = Math.max(0, Math.floor((W - boxW) / 2));
    const padR = Math.max(0, W - boxW - padL);
    lines.forEach((ln, i) => {
      const r = startRow + i;
      if (r >= 1 && r < frame.length) frame[r] = ' '.repeat(padL) + padToWidth(ln, boxW) + ' '.repeat(padR);
    });
  }

  // ------------------------------------------------------------------- keys
  handleKey(ev) {
    if (this.askState) return this.handleAskKey(ev);
    if (this.histOverlay) return this.handleHistoryKey(ev);
    if (this.picker) return this.handlePickerKey(ev);
    if (this.prompt) return this.handlePromptKey(ev);
    const k = ev.key;
    this.dirty = true;

    if (k === 'wheel-up' || k === 'wheel-down' || k === 'mouse-down' || k === 'mouse-drag' || k === 'mouse-up' || k === 'mouse-move') {
      return this.handleMouse(ev);
    }
    if (k === 'pageup') return this.scrollBy(Math.floor(this.height / 2));
    if (k === 'pagedown') return this.scrollBy(-Math.floor(this.height / 2));
    // 跳转对话头尾用 Ctrl+Home / Ctrl+End（Home/End 留给输入框的光标）
    if (k === 'ctrl+end') return this.scrollToBottom();
    if (k === 'ctrl+home') return this.scrollToTop();
    if (k === 'ctrl+l') {
      this.prevLines = [];
      process.stdout.write('\x1b[2J');
      return this.render(true);
    }
    if (k === 'ctrl+c') {
      if (this.running) return this.requestCancel('Ctrl+C');
      if (this.input.text) {
        this.input = { text: '', cursor: 0 };
        return;
      }
      return this.exit(0);
    }
    if (k === 'ctrl+d' && !this.input.text) return this.exit(0);
    if (k === 'ctrl+o') {
      // Ctrl+O = 展开/收起最后一个思考或工具块（和 pi 一致）
      return this.toggleLastCollapsible();
    }
    if (k === 'ctrl+t') {
      this.showThinking = !this.showThinking;
      for (const it of this.items) it.ver++;
      return;
    }
    if (k === 'esc') {
      if (this.running) return this.requestCancel('ESC');
      if (this.input.text) this.input = { text: '', cursor: 0 };
      return;
    }
    if (this.compOpen) {
      if (k === 'up' || k === 'ctrl+p' || k === 'shift-tab') return this.compMove(-1);
      if (k === 'down' || k === 'ctrl+n') return this.compMove(1);
      if (k === 'tab') return this.complete();
      if (k === 'enter') {
        if (this.imeJustCommitted()) return;
        const sel = this.compSelected();
        if (sel && sel.name !== this.input.text.trim()) return this.complete();
        return this.submit();
      }
      if (k === 'esc') {
        this.compHidden = true;
        this.dirty = true;
        return;
      }
    }
    if (k === 'enter') {
      if (this.imeJustCommitted()) return;
      return this.submit();
    }
    if (k === 'ctrl+j' || k === 'alt+enter') return this.insertText('\n');
    if (k === 'tab') {
      const t = this.input.text.trim();
      if (this.running && t && !t.startsWith('/')) return this.addPending();
      return this.complete();
    }
    if (k === 'backspace') return this.deleteBack();
    if (k === 'delete') return this.deleteForward();
    if (k === 'left') return (this.input.cursor = Math.max(0, this.input.cursor - 1));
    if (k === 'right') return (this.input.cursor = Math.min(this.input.text.length, this.input.cursor + 1));
    if (k === 'ctrl+left' || k === 'alt+b') return this.moveWord(-1);
    if (k === 'ctrl+right' || k === 'alt+f') return this.moveWord(1);
    if (k === 'home' || k === 'ctrl+a') {
      const before = this.input.text.slice(0, this.input.cursor);
      const nl = before.lastIndexOf('\n');
      this.input.cursor = nl < 0 ? 0 : nl + 1;
      return;
    }
    if (k === 'end' || k === 'ctrl+e') {
      const after = this.input.text.indexOf('\n', this.input.cursor);
      this.input.cursor = after < 0 ? this.input.text.length : after;
      return;
    }
    if (k === 'ctrl+u') {
      this.input.text = this.input.text.slice(this.input.cursor);
      this.input.cursor = 0;
      return;
    }
    if (k === 'ctrl+k') {
      this.input.text = this.input.text.slice(0, this.input.cursor);
      return;
    }
    if (k === 'ctrl+w') {
      const before = this.input.text.slice(0, this.input.cursor).replace(/[\w.-]+$/, '');
      this.input.text = before + this.input.text.slice(this.input.cursor);
      this.input.cursor = before.length;
      return;
    }
    if (k === 'up' || k === 'ctrl+p') return this.historyPrev();
    if (k === 'down' || k === 'ctrl+n') return this.historyNext();
    if (k === 'paste') {
      let text = ev.text.replace(/\r?\n/g, '\n').replace(/\t/g, '  ');
      if (this.running) {
        // 跑着的时候粘贴只放进输入框：Enter 直接插话，Tab 进待发队列
        this.insertPasted(text);
        this.push({ kind: 'note', text: '已粘贴到输入框：Enter 插话，Tab 加入待发队列', inline: true });
        return this.render(true);
      }
      this.insertPasted(text);
      const folded = text.length >= 1200;
      this.push({ kind: 'note', text: folded ? `已粘贴 ${(text.length / 1024).toFixed(1)}KB，折叠成占位符（发送时自动展开）` : `已粘贴 ${text.length} 字符`, inline: true });
      return this.render(true);
    }
    if (k === 'ctrl+v') return this.pasteFromClipboard();
    if (k === 'text') {
      // 输入法上屏时一次到达多个字符；紧跟其后的回车属于"上屏"，不该触发发送。
      if (ev.text.length >= 2 && /[^\x00-\x7F]/.test(ev.text)) this._imeTick = Date.now();
      this.compIndex = 0;
      this.compHidden = false;
      return this.insertText(ev.text);
    }
    if (k === 'space') return this.insertText(' ');
  }

  handlePickerKey(ev) {
    const p = this.picker;
    const k = ev.key;
    this.dirty = true;
    if (k === 'esc') {
      this.picker = null;
      return;
    }
    if (k === 'enter') return this.pickerSelect();
    if (k === 'up' || k === 'ctrl+p' || k === 'shift-tab') return this.pickerMove(-1);
    if (k === 'down' || k === 'ctrl+n' || k === 'tab') return this.pickerMove(1);
    if (k === 'pageup') return this.pickerMove(-5);
    if (k === 'pagedown') return this.pickerMove(5);
    if (k === 'backspace') {
      p.filter = p.filter.slice(0, -1);
      p.index = 0;
      return this.rebuildPicker();
    }
    if (k === 'text') {
      p.filter += ev.text;
      p.index = 0;
      return this.rebuildPicker();
    }
    if (k === 'space') {
      p.filter += ' ';
      p.index = 0;
      return this.rebuildPicker();
    }
    if (k === 'ctrl+c') {
      this.picker = null;
      return;
    }
  }

  handlePromptKey(ev) {
    const p = this.prompt;
    const k = ev.key;
    this.dirty = true;
    if (k === 'esc') {
      this.prompt = null;
      return;
    }
    if (k === 'enter') {
      const val = p.buffer.trim();
      this.prompt = null;
      p.onDone?.(val);
      return;
    }
    if (k === 'backspace') {
      p.buffer = p.buffer.slice(0, -1);
      this.syncPromptInput();
      return;
    }
    if (k === 'text') {
      p.buffer += ev.text;
      this.syncPromptInput();
      return;
    }
    // 粘贴四条路都要通（以前只接了 bracketed paste，Ctrl+V / 右键在这里是死路）：
    //  - bracketed paste（终端自带 Ctrl+Shift+V / 右键菜单）带 ev.text
    //  - Ctrl+V / Ctrl+Shift+V / 鼠标右键 → 自己去读系统剪贴板
    if (k === 'ctrl+v' || k === 'ctrl+shift+v') return this.pasteIntoPrompt();
    if ((k === 'mouse-down' || k === 'mouse-up') && ev.button === 2) return this.pasteIntoPrompt();
    if (/^(mouse|wheel)/.test(k)) return;
    if (k === 'paste') return this.pasteIntoPrompt(ev.text);
  }

  /**
   * 自定义输入行（/key、/model 之类）的粘贴。以前只有 bracketed paste 一条路，
   * 在 conhost 里按 Ctrl+V / 右键会掉进主输入框（还会把 key 当成任务发出去）。
   * secret 模式下只收单行、去掉所有空白；普通模式换行压成空格。
   */
  async pasteIntoPrompt(raw) {
    const p = this.prompt;
    if (!p) return;
    let text = typeof raw === 'string' ? raw : '';
    let fromClipboard = false;
    if (!text) {
      fromClipboard = true;
      try {
        const res = await readClipboard();
        text = res.text || '';
      } catch {
        text = '';
      }
    }
    text = String(text || '').replace(/\r\n?/g, '\n');
    text = p.secret ? text.replace(/\s+/g, '') : text.replace(/\n/g, ' ').replace(/\t/g, '  ').trim();
    if (!text.trim()) {
      this.push({
        kind: 'note',
        text: fromClipboard ? '剪贴板里没有文本（可以先用终端自己的 Ctrl+Shift+V / 右键菜单）' : '没有可粘贴的内容',
        inline: true,
      });
      this.dirty = true;
      return this.render(true);
    }
    if (text.length > 20000) text = text.slice(0, 20000);
    p.buffer = p.secret ? p.buffer.replace(/\s+/g, '') + text : p.buffer + text;
    this.syncPromptInput();
    this.push({
      kind: 'note',
      text: p.secret ? `已粘贴 ${text.length} 个字符（内容隐藏）` : `已粘贴 ${text.length} 字符`,
      inline: true,
    });
    this.dirty = true;
    this.render(true);
  }

  syncPromptInput() {
    this.input = { text: this.prompt.buffer, cursor: this.prompt.buffer.length };
  }

  insertText(text) {
    const { text: cur, cursor } = this.input;
    // 光标在中间插入时，后半段必须保留（否则在中间补字会把后面的内容吃掉）
    this.input = { text: cur.slice(0, cursor) + text + cur.slice(cursor), cursor: cursor + text.length };
    this.compIndex = 0;
    this.compHidden = false;
    this.dirty = true;
  }

  /** 按词移动光标（Ctrl+←/→、Alt+B/F），排版常用。 */
  moveWord(dir) {
    const s = this.input.text;
    let i = this.input.cursor;
    if (dir < 0) {
      while (i > 0 && /\s/.test(s[i - 1])) i--;
      while (i > 0 && !/\s/.test(s[i - 1])) i--;
    } else {
      while (i < s.length && !/\s/.test(s[i])) i++;
      while (i < s.length && /\s/.test(s[i])) i++;
    }
    this.input.cursor = i;
    this.dirty = true;
  }

  deleteBack() {
    const { text, cursor } = this.input;
    if (!cursor) return;
    this.input = { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
  }

  deleteForward() {
    const { text, cursor } = this.input;
    if (cursor >= text.length) return;
    this.input = { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
  }

  historyPrev() {
    if (!this.history.length) return;
    if (this.histIdx < 0) this.histIdx = this.history.length;
    if (this.histIdx > 0) this.histIdx--;
    const t = this.history[this.histIdx] || '';
    this.input = { text: t, cursor: t.length };
  }

  historyNext() {
    if (this.histIdx < 0) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1;
      this.input = { text: '', cursor: 0 };
      return;
    }
    const t = this.history[this.histIdx];
    this.input = { text: t, cursor: t.length };
  }

  /** 输入法刚上屏（多字符文本事件）后 120ms 内的回车不算发送，避免中文回车即发送。 */
  imeJustCommitted(ms = 120) {
    return !!this._imeTick && Date.now() - this._imeTick < ms;
  }

  /** The "/word" being typed on the cursor line, if any. */
  compContext() {
    const { text, cursor } = this.input;
    const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
    const nlx = text.indexOf('\n', cursor);
    const lineEnd = nlx < 0 ? text.length : nlx;
    const line = text.slice(lineStart, cursor);
    if (!line.startsWith('/') || /\s/.test(line)) return null;
    return { lineStart, lineEnd, line };
  }

  /** Slash-command matches for the current input (popup + Tab). */
  compItems() {
    const ctx = this.compContext();
    if (!ctx) return [];
    const q = ctx.line.toLowerCase();
    return COMMANDS.filter((c) => c.name.startsWith(q));
  }

  get compOpen() {
    return !this.picker && !this.compHidden && this.compItems().length > 0;
  }

  compSelected() {
    const items = this.compItems();
    if (!items.length) return null;
    return items[Math.min(this.compIndex, items.length - 1)];
  }

  compMove(delta) {
    const items = this.compItems();
    if (!items.length) return;
    this.compIndex = (this.compIndex + delta + items.length) % items.length;
    this.dirty = true;
  }

  /** Fill the selected command into the input (keeps editing, does not send). */
  complete() {
    const pick = this.compSelected() || this.compItems()[0];
    const ctx = this.compContext();
    if (!pick || !ctx) return;
    const before = this.input.text.slice(0, ctx.lineStart);
    const after = this.input.text.slice(ctx.lineEnd);
    const filled = pick.name + ' ';
    this.input = { text: before + filled + after, cursor: before.length + filled.length };
    this.compIndex = 0;
    this.compHidden = true;
    this.dirty = true;
  }

  scrollBy(n) {
    const total = this.transcriptLines(this.width).length;
    const boxLen = this.inputBoxLines(this.width).length;
    const viewH = Math.max(3, this.height - 1 - boxLen - 1);
    const max = Math.max(0, total - viewH);
    // 先把「锚点行号」换算回 scroll，再加减，最后重算锚点
    let scroll = this.scroll;
    if (this.followAnchor != null) scroll = clamp(total - (this.followAnchor + viewH), 0, max);
    this.scroll = clamp(scroll + n, 0, max);
    // 差一点点就到底时直接吸底，免得“滚回去了但还在暂停跟随”
    if (this.scroll <= 2) this.scroll = 0;
    this.followAnchor = this.scroll > 0 ? Math.max(0, total - this.scroll - viewH) : null;
    this.dirty = true;
  }

  /** 跳到底部 = 恢复跟随最新输出。 */
  scrollToBottom() {
    this.scroll = 0;
    this.followAnchor = null;
    this.dirty = true;
  }

  /** 跳到最顶部（继续暂停跟随）。 */
  scrollToTop() {
    const total = this.transcriptLines(this.width).length;
    const boxLen = this.inputBoxLines(this.width).length;
    const viewH = Math.max(3, this.height - 1 - boxLen - 1);
    this.scroll = Math.max(0, total - viewH);
    this.followAnchor = 0;
    this.dirty = true;
  }

  // ------------------------------------------------------------------ submit
  submit() {
    const raw = this.input.text.trim();
    if (this.prompt) return;
    if (!raw) return;
    const text = this.expandPastes(raw);
    // 整句就是一个 key 的时候拦下来直接存配置：既省得白跑一轮，也避免把密钥发给网关
    const key = detectApiKey(raw);
    if (key) return this.saveLooseKey(key);
    this.history.push(raw);
    this.histIdx = -1;
    this.input = { text: '', cursor: 0 };
    this.scroll = 0;
    this.followAnchor = null;
    if (raw.startsWith('/')) return this.command(text);
    if (this.running) {
      // 普通发送 = 插话：不等本轮结束，AI 下一步就能看到并调整方向
      this.agent.queue(text);
      this.push({ kind: 'note', text: `已插话（本轮当前步骤结束后生效）：${text.replace(/\s+/g, ' ').slice(0, 60)}`, inline: true });
      this.dirty = true;
      this.render(true);
      return;
    }
    this.runTurn(text);
  }

  /** 玩家直接把 key 粘进对话框时：存进当前服务商，不发给模型。 */
  saveLooseKey(key) {
    const p = this.agent.target().provider;
    this.input = { text: '', cursor: 0 };
    this.config.setApiKey(p.id, key);
    this.push({ kind: 'note', text: `这段看起来是 API key（${key.slice(0, 4)}…${key.slice(-4)}），已直接存给 ${p.name}，没发给模型。` });
    this.push({ kind: 'note', text: `  要存到别的服务商：/key <provider>（然后把 key 粘到弹出那一行，Ctrl+V 已经能用了）` });
    this.dirty = true;
    this.render(true);
  }

  // --------------------------------------------------------------- commands
  async command(raw) {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch ((cmd || '').toLowerCase()) {
      case 'help':
        return this.push({ kind: 'multi', lines: HELP });
      case 'quit':
      case 'exit':
        return this.exit(0);
      case 'clear':
        this.items = [];
        this.prevLines = [];
        process.stdout.write('\x1b[2J');
        this.pushWelcome();
        return;
      case 'new':
        this.agent = new Agent({ config: this.config, cwd: this.cwd });
        this.bindAgent();
        this.title = '';
        this.demo = false;
        this.items = [];
        this.prevLines = [];
        this.usage = { input: 0, output: 0, cost: 0 };
        this.context = { tokens: 0, maxTokens: this.agent.target().model?.ctx || 128000, used: 0 };
        process.stdout.write('\x1b[2J');
        this.pushWelcome();
        this.push({ kind: 'note', text: '已开始新会话。' });
        return;
      case 'model':
        if (arg) {
          const hit = this.findModel(arg);
          if (hit) return this.applyModel(hit.provider, hit.model);
          this.push({ kind: 'warn', text: `没找到模型 “${arg}”，打开选择器。` });
        }
        return this.openModelPicker();
      case 'provider':
        return this.handleProvider(rest, arg);
      case 'key': {
        const [maybeProvider, ...keyParts] = rest;
        const pid = getProvider(maybeProvider) ? maybeProvider : this.config.active.provider;
        const key = getProvider(maybeProvider) ? keyParts.join(' ') : rest.join(' ');
        if (key) {
          this.config.setApiKey(pid, key);
          this.push({ kind: 'note', text: `${getProvider(pid).name} 的 API key 已保存（~/.agent/config.json）。` });
          return;
        }
        const p = getProvider(pid);
        return this.askLine(`粘贴 ${p.name} 的 API key（${p.site}）`, (val) => {
          if (!val) return;
          this.config.setApiKey(pid, val);
          this.push({ kind: 'note', text: `${p.name} 的 API key 已保存。` });
        }, { secret: true });
      }
      case 'think': {
        const lvl = (arg || '').trim().toLowerCase();
        const allowed = ['off', 'low', 'medium', 'high', 'max'];
        if (!allowed.includes(lvl)) {
          const s = this.config.settings;
          return this.push({ kind: 'note', text: `当前思考强度 ${s.thinking}。用法：/think off|low|medium|high|max` });
        }
        this.config.setSettings({ thinking: lvl });
        return this.push({ kind: 'note', text: `思考强度 → ${lvl}` });
      }
      case 'verbose':
        this.verbose = !this.verbose;
        this.config.setSettings({ verbose: this.verbose });
        for (const it of this.items) it.ver++;
        return this.push({ kind: 'note', text: `工具输出预览：${this.verbose ? '详细' : '精简'}` });
      case 'tools': {
        // 一屏能看完：按用途分组，一行一个类别（长终端会换行，短终端也不会把开头挤掉）
        const row = (label, body) => `  ${T.dim(label)}${' '.repeat(Math.max(2, 8 - strWidth(label)))}${body}`;
        const onOff = (v) => (v ? T.ok('已开') : T.dim('已关'));
        const t = (...names) => names.map((n) => T.accent(n)).join(' · ');
        const lines = [
          T.headerLine(' 工具 '),
          row('基础', t('read', 'write', 'edit', 'shell')),
          row('源码', t('glob', 'grep', 'ls', 'git', 'think')),
          row('联网', t('web_search', 'web_fetch', 'browser', 'http_request')),
          row('记忆', t('todo', 'memory', 'skill')),
          row('上下文', `${T.accent('context')} ${T.dim('billion-context：压缩 / 检索 / 展开历史')}`),
          T.headerLine(' 协作（默认关闭，会多花 token） '),
          row('subagent', `${onOff(this.config.subagentsEnabled)} 派子代理干子任务`),
          row('team', `${onOff(this.config.teamEnabled)} 组队并行开发（浏览器看进度）`),
          `  ${T.dim('开启：/subagents on · /team on　　团队面板：/progress')}`,
          T.headerLine(' 权限与工具链 '),
          `  工作区 ${T.accent(prettyCwd(this.cwd))}   ${this.config.allowOutsideCwd ? T.warn('全权模式已开') : T.dim('只能改工作区内文件')}`,
          `  ${T.dim('写文件前自动快照，可用 /undo 回滚；hooks 可用 /hooks 查看')}`,
        ];
        return this.push({ kind: 'multi', lines });
      }
      case 'ctx': {
        const s = this.agent.engine.stats;
        const lines = [
          `上下文占用  ${T.bold(String(s.tokens))} / ${s.maxTokens} tokens  (${(s.used * 100).toFixed(1)}%)`,
          `实际发送    ${s.wire} / ${s.budget} tokens${s.wire >= s.budget * 0.8 ? T.warn('（接近压缩线）') : ''}`,
          `活跃消息 ${s.messages}  压缩块 ${s.blocks}  已折叠 ${s.foldedMessages} 条`,
        ];
        for (const n of this.agent.engine.nodes.filter((x) => x.kind === 'block')) {
          lines.push(`  ${T.accent2(n.id)} [${n.from}-${n.to}] ${n.topic || ''} · ${n.count} 条`);
        }
        return this.push({ kind: 'multi', lines });
      }
      case 'cost': {
        const u = this.agent.usageTotal;
        return this.push({
          kind: 'multi',
          lines: [
            `本会话用量  ↑${fmtNum(u.input)} ↓${fmtNum(u.output)} tokens · 缓存命中 ${fmtNum(u.cacheRead)}`,
            `估算花费    ${fmtMoney(u.cost)}`,
          ],
        });
      }
      case 'compact': {
        if (this.running) return this.push({ kind: 'warn', text: '正在运行中，稍后再压缩。' });
        return this.manualCompact();
      }
      case 'expand': {
        if (!arg) return this.push({ kind: 'warn', text: '用法：/expand b1 或 /expand m00010-m00030' });
        const r = this.agent.engine.textOf(arg.trim());
        if (!r) return this.push({ kind: 'error', text: `找不到 ref: ${arg}` });
        return this.push({ kind: 'multi', lines: [`${T.accent2(r.ref)} ${r.range} (${r.chars} 字符)`, '', ...r.text.split('\n').slice(0, 400)] });
      }
      case 'sessions': {
        const list = this.listSessions();
        if (!list.length) return this.push({ kind: 'note', text: '还没有保存的会话。' });
        return this.push({
          kind: 'multi',
          lines: ['已保存会话（/resume <序号>，或 /history 打开选择器）:', ...list.map((s, i) => `  ${String(i + 1).padStart(2)}. ${T.text(String(s.title).slice(0, 40))} ${T.dimmer(`· ${s.provider}/${s.model} · ${s.msgs} 条`)}`)],
        });
      }
      case 'history':
      case 'hist':
        return this.openHistory(arg);
      case 'trust': {
        return this.setTrust(arg.trim().toLowerCase());
      }
      case 'undo':
        return this.undoCheckpoint(arg.trim());
      case 'paste':
        return this.pasteFromClipboard();
      case 'copy':
        return this.copyLastReply(Number(arg) || 1);
      case 'native':
        return this.toggleNativeMouse();
      case 'skill': {
        const all = listSkills(this.cwd);
        if (!all.length)
          return this.push({
            kind: 'multi',
            lines: [
              T.headerLine(' 技能 '),
              `  还没有技能。在 ${T.accent(shortPath(this.cwd + '/.agent/skills', 48))}/<名字>.md 写一份 markdown（可选 front matter: name/description），`,
              '  或放到 ~/.agent/skills/。模型会看到技能清单，需要时用 skill 工具 load。',
            ],
          });
        return this.push({
          kind: 'multi',
          lines: [T.headerLine(` 技能（${all.length}）`), ...all.map((s) => `  ${T.accent(s.name.padEnd(16))} ${T.dim(s.scope)} ${T.dimmer(s.description || '')}`)],
        });
      }
      case 'subagents': {
        const v = String(arg || '').trim().toLowerCase();
        if (!v || v === 'status') {
          const on = this.config.subagentsEnabled;
          return this.push({
            kind: 'multi',
            lines: [
              `子代理  ${on ? T.ok('已开启') : T.dim('未开启')}`,
              T.dim('  开启后 AI 可以调 subagent 派一个独立上下文的助手去干子任务，干完只把结论带回来。'),
              T.dim('  代价：额外 token（子代理自己跑一整套模型调用）。建议步数设置 subagentMaxSteps=40。'),
              T.dim('  用法：/subagents on | off'),
            ],
          });
        }
        if (!['on', 'off'].includes(v)) return this.push({ kind: 'warn', text: '用法：/subagents on | off（不带参数查看状态）' });
        this.config.setSubagents(v === 'on');
        return this.push({
          kind: 'note',
          text:
            v === 'on'
              ? '子代理已开启（工具 subagent 已下发给模型）。额外消耗 token —— 只在你明确让他用/任务真的值得拆时才会用。'
              : '子代理已关闭（subagent 工具已从模型工具清单中移除）。',
        });
      }
      case 'team': {
        const v = String(arg || '').trim().toLowerCase();
        if (!v || v === 'status') {
          const on = this.config.teamEnabled;
          const t = getActiveTeam();
          const snap = t ? t.snapshot() : lastTeamSnapshot(this.cwd);
          const lines = [
            `团队协作  ${on ? T.ok('已开启') : T.dim('未开启')}`,
            T.dim('  开启后 AI 可以组一支小队并行开发：每个成员一个角色 + 一份任务，共享同一个工作区。'),
            T.dim('  代价：每个成员各自一套模型调用，token 成倍。并发默认 settings.teamConcurrency=2。'),
            T.dim('  用法：/team on | off · 团队面板 /progress'),
          ];
          if (snap) {
            const tot = snap.totals || {};
            lines.push(T.headerLine(` 最近一支：${snap.name} `));
            lines.push(
              `  ${tot.done || 0}/${tot.members || 0} 完成 · ${tot.tokens || 0} tok · ${fmtMoney(tot.cost || 0)} · ${t ? (t.running ? T.accent('在跑') : '已收工') : '历史记录'}`,
            );
            for (const m of snap.members || []) lines.push(T.dim(`   · ${m.name}（${m.role}）${m.status} ${m.steps} 步`));
          }
          return this.push({ kind: 'multi', lines });
        }
        if (!['on', 'off'].includes(v)) return this.push({ kind: 'warn', text: '用法：/team on | off（不带参数查看状态）' });
        this.config.setTeamEnabled(v === 'on');
        return this.push({
          kind: 'note',
          text:
            v === 'on'
              ? '团队协作已开启（工具 team 已下发给模型）。成员会各自烧 token，让他先报计划再开工更稳。'
              : '团队协作已关闭（team 工具已从模型工具清单中移除；已在跑的团队不受影响）。',
        });
      }
      case 'progress': {
        const v = String(arg || '').trim().toLowerCase();
        if (v === 'off') {
          this.config.setProgress(false);
          resetHub();
          return this.push({ kind: 'note', text: '团队面板已关闭（settings.progress=false）。' });
        }
        const hub = await ensureHub(this.config);
        if (!hub) return this.push({ kind: 'warn', text: '团队面板没起来：检查 settings.progress / progressPort（默认 7870）。' });
        this.bindSpawn(hub);
        if (v === 'open') openInBrowser(hub.url);
        return this.push({
          kind: 'multi',
          lines: [
            `团队面板  ${T.accent(hub.url)}`,
            T.dim('  团队面板：左边选成员，右边看他这一路的完整对话（含工具输出与思考），还能直接在下面给他传话。'),
            T.dim('  Shell 任务 /shell · 手动开工 /spawn（浏览器里直接组队或派子代理）。'),
            T.dim('  只监听 127.0.0.1，关掉终端就停。输入 /progress open 自动开浏览器。'),
          ],
        });
      }
      case 'shell': {
        const hub = await ensureHub(this.config);
        if (!hub) return this.push({ kind: 'warn', text: '后端没起来：检查 settings.progress / progressPort（默认 7870）。' });
        this.bindSpawn(hub);
        const url = hub.url.replace(/\/$/, '') + '/shell';
        if (String(arg || '').trim().toLowerCase() === 'open') openInBrowser(url);
        return this.push({
          kind: 'multi',
          lines: [
            `Shell 任务  ${T.accent(url)}`,
            T.dim('  主代理 / 子代理跑过的每条 shell 都在这里：实时输出、耗时、退出码，可手动终止或清空。'),
            T.dim('  输入 /shell open 自动开浏览器。'),
          ],
        });
      }
      case 'spawn': {
        const hub = await ensureHub(this.config);
        if (!hub) return this.push({ kind: 'warn', text: '后端没起来：检查 settings.progress / progressPort（默认 7870）。' });
        this.bindSpawn(hub);
        const url = hub.url.replace(/\/$/, '') + '/spawn';
        if (String(arg || '').trim().toLowerCase() === 'open') openInBrowser(url);
        this.push({
          kind: 'multi',
          lines: [
            `手动开工  ${T.accent(url)}`,
            T.dim('  浏览器里填目标/成员就能组队，或单独派一个子代理；进度实时回面板与终端。'),
            T.dim('  输入 /spawn open 自动开浏览器。'),
          ],
        });
        return;
      }
      case 'queue': {
        const v = String(arg || '').trim().toLowerCase();
        if (v === 'clear') {
          const n = this.pending.length;
          this.pending = [];
          return this.push({ kind: 'note', text: n ? `已清空待发队列（${n} 条）。` : '待发队列本来就是空的。' });
        }
        const m = /^drop\s+(\d+)$/.exec(v);
        if (m) {
          const i = Number(m[1]) - 1;
          if (i < 0 || i >= this.pending.length) return this.push({ kind: 'warn', text: `没有第 ${m[1]} 条。` });
          const [gone] = this.pending.splice(i, 1);
          return this.push({ kind: 'note', text: `已删除待发：${gone.slice(0, 60)}` });
        }
        if (!this.pending.length) {
          return this.push({
            kind: 'note',
            text: this.running ? '待发队列是空的。AI 干活时输入内容，按 Tab 就能附加（最多 5 条）。' : '待发队列是空的。',
          });
        }
        return this.push({
          kind: 'multi',
          lines: [
            `待发队列 ${this.pending.length}/${this.maxPending}${this.running ? T.dim('（AI 收工后自动逐条发送）') : T.dim('（等待发送）')}`,
            ...this.pending.map((t, i) => `  ${T.accent2(String(i + 1))} ${truncToWidth(t.replace(/\s+/g, ' '), Math.max(20, this.width - 8))}`),
            T.dim('  /queue drop <n> 删一条 · /queue clear 清空'),
          ],
        });
      }
      case 'hooks': {
        const rows = describeHooks(this.config.hooks);
        return this.push({
          kind: 'multi',
          lines: rows.length
            ? [T.headerLine(` hooks（${rows.length}）`), ...rows.map((h) => `  ${T.accent2(h.kind.padEnd(11))} ${T.text(h.match.padEnd(12))} ${T.dim(h.command)}${h.block && h.kind === 'preToolUse' ? T.warn(' 可拦截') : ''}`)]
            : [
                T.headerLine(' hooks '),
                '  未配置。在 ~/.agent/config.json 里写：',
                T.dim('  "hooks": { "preToolUse": [{ "match": "shell", "command": "node .agent/hooks/guard.js", "block": true }],'),
                T.dim('             "postToolUse": [{ "match": "write|edit", "command": "npx prettier --write" }] }'),
              ],
        });
      }
      case 'resume': {
        const list = this.listSessions();
        const n = Number(arg) - 1;
        if (!list[n]) return this.push({ kind: 'warn', text: '序号无效，先 /sessions 查看。' });
        const data = JSON.parse(fs.readFileSync(list[n].file, 'utf8'));
        this.agent.setSession(data);
        this.items = [];
        this.prevLines = [];
        process.stdout.write('\x1b[2J');
        this.pushWelcome();
        this.push({ kind: 'note', text: `已恢复会话：${data.title}（${data.context?.nodes?.length || 0} 条节点）` });
        this.dirty = true;
        return this.render(true);
      }
      case 'todo': {
        const { readTodo, formatTodo } = await import('../tools/todo.js');
        const t = readTodo(this.cwd);
        return this.push({ kind: 'multi', lines: [T.headerLine(' 待办 '), ...formatTodo(t).split(/\r?\n/)] });
      }
      case 'memory': {
        const { memoryList } = await import('../tools/todo.js');
        const lines = memoryList().map(([k, v]) => `  ${T.accent(k)} = ${v}`);
        return this.push({ kind: 'multi', lines: [T.headerLine(' 长期记忆 ~/.agent/memory.json '), ...(lines.length ? lines : ['  （记忆为空，模型可用 memory 工具写入）'])] });
      }
      default:
        return this.push({ kind: 'warn', text: `未知命令 /${cmd}，输入 /help 查看。` });
    }
  }

  askLine(question, onDone, opts = {}) {
    this.prompt = { question, buffer: '', onDone, secret: !!opts.secret };
    this.input = { text: '', cursor: 0 };
  }

  findModel(query) {
    const q = query.toLowerCase();
    if (q.includes('/')) {
      const [pid, ...m] = q.split('/');
      const mid = m.join('/');
      const p = getProvider(pid);
      if (p && resolveModel(pid, mid)) return { provider: pid, model: resolveModel(pid, mid) };
      if (p) return { provider: pid, model: mid };
    }
    for (const p of providerList()) {
      const m = p.models.find((x) => x.id.toLowerCase() === q || x.name.toLowerCase().includes(q));
      if (m) return { provider: p.id, model: m.id };
    }
    return null;
  }

  applyModel(providerId, modelId) {
    const t = this.agent.setActive(providerId, modelId);
    this.toolCount = 0;
    this.context = { ...this.agent.engine.stats };
    this.dirty = true;
    const keyed = this.config.hasKey(providerId);
    this.push({
      kind: 'note',
      text: `模型 → ${t.provider.name} / ${t.modelId}${t.model?.ctx ? ` (${fmtNum(t.model.ctx)} ctx)` : ''}${keyed ? '' : '  · 该服务商还没配 key，用 /key 配置'}`,
    });
  }

  openModelPicker() {
    this.picker = { kind: 'model', filter: '', index: 0, items: [], offset: 0 };
    this.rebuildPicker();
  }

  rebuildPicker() {
    const p = this.picker;
    const filter = p.filter.toLowerCase().trim();
    const items = [];
    for (const prov of providerList()) {
      const keyed = this.config.hasKey(prov.id);
      const models = prov.models.filter((m) => {
        if (!filter) return true;
        return m.id.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter) || prov.id.includes(filter) || prov.name.toLowerCase().includes(filter);
      });
      if (!models.length) continue;
      items.push({ type: 'header', provider: prov, keyed });
      for (const m of models) items.push({ type: 'model', provider: prov, model: m, keyed });
    }
    items.push({ type: 'custom', provider: this.agent.target().provider });
    p.items = items;
    if (!items[p.index]) p.index = 0;
    while (p.index < items.length && items[p.index].type === 'header') p.index++;
    if (p.index >= items.length) p.index = Math.max(0, items.length - 1);
  }

  pickerMove(delta) {
    const p = this.picker;
    let i = p.index;
    for (let n = 0; n < Math.abs(delta); n++) {
      let step = delta > 0 ? 1 : -1;
      let k = i + step;
      while (k >= 0 && k < p.items.length && p.items[k].type === 'header') k += step;
      if (k < 0 || k >= p.items.length) break;
      i = k;
    }
    p.index = i;
  }

  pickerSelect() {
    const p = this.picker;
    const item = p.items[p.index];
    if (!item) {
      this.picker = null;
      return;
    }
    if (item.type === 'custom') {
      this.picker = null;
      return this.askLine('输入模型 ID（provider/model 或直接模型名）', (val) => {
        if (!val) return;
        const hit = this.findModel(val) || { provider: this.agent.target().providerId, model: val };
        this.applyModel(hit.provider, hit.model);
      });
    }
    this.picker = null;
    this.applyModel(item.provider.id, item.model.id);
  }

  /** 流式速度的实时估算（真实值在 usage 事件里校正）。 */
  tickSpeed() {
    const secs = (Date.now() - this._gen.t0) / 1000;
    if (secs < 0.35) return;
    this.speed = this._gen.tok / secs;
  }

  /** 大段粘贴折叠成占位符，发送时再展开；输入区保持轻快。 */
  insertPasted(text) {
    const s = String(text || '');
    if (s.length < 1200) return this.insertText(s);
    // 占位符过长会撑破输入框，这里只保留编号和大小
    const id = this.pastes.push(s);
    const kb = (s.length / 1024).toFixed(1);
    this.insertText(`⟦粘贴#${id}:${kb}KB⟧`);
    return id;
  }

  expandPastes(text) {
    return String(text || '').replace(/⟦粘贴#(\d+):[\d.]+KB⟧/g, (m, id) => this.pastes[Number(id) - 1] ?? m);
  }

  // --------------------------------------------------------------- agent run
  async runTurn(text) {
    this.running = true;
    this.cancelAt = 0; // 新一轮开始，重置“再按一次强制结束”的计时
    this.state = 'working';
    this.stateDetail = '思考中';
    this.toolCount = 0;
    this.taskT0 = Date.now();
    this.lastElapsed = null;
    this.speed = 0;
    this.lastSpeed = null;
    this._gen = { t0: Date.now(), tok: 0 };
    if (!this.title) this.title = text.slice(0, 60);
    // 每给一个新任务，标题就换成新任务（demo 用固定名）
    if (!this.demo) this.taskTitle = compressTitle(text);
    this.push({ kind: 'user', text });
    let assistant = null;
    let think = null;
    let toolItems = new Map();

    const finishThink = () => {
      if (!think) return;
      think.done = true;
      think.dur = Date.now() - (think.t0 || Date.now());
      think.collapsed = true;
      think.ver++;
      think = null;
    };

    const ensureAssistant = () => {
      if (!assistant) {
        finishThink();
        assistant = this.push({ kind: 'assistant', text: '', streaming: true, collapsible: true, collapsed: false });
      }
      return assistant;
    };

    try {
      for await (const ev of this.agent.run(text)) {
        this.paintNow();
        switch (ev.type) {
          case 'text': {
            /* streaming text: paint immediately for a responsive feel */
            const a = ensureAssistant();
            a.text += ev.delta;
            a.ver++;
            this._gen.tok += estimateTokens(ev.delta);
            this.tickSpeed();
            this.stateDetail = '输出中';
            break;
          }
          case 'reasoning': {
            if (!think) {
              if (assistant) {
                assistant.streaming = false;
                assistant.ver++;
                assistant = null;
              }
              think = this.push({ kind: 'think', text: '', t0: Date.now(), done: false, collapsed: false, collapsible: true });
            }
            think.text += ev.delta;
            think.ver++;
            this._gen.tok += estimateTokens(ev.delta);
            this.tickSpeed();
            this.stateDetail = '思考中';
            break;
          }
          case 'tool_start': {
            finishThink();
            if (assistant) {
              assistant.streaming = false;
              assistant.ver++;
              assistant = null;
            }
            this.toolCount++;
            const item = this.push({
              kind: 'tool',
              id: ev.id,
              name: ev.name,
              input: ev.input,
              status: 'running',
              content: '',
              t0: Date.now(),
              collapsible: true,
              collapsed: false,
            });
            toolItems.set(ev.id, item);
            this.stateDetail =
              ev.name === 'skill' && String(ev.input?.action || '').toLowerCase() === 'load'
                ? `Call Skill: ${ev.input.name || ''}`.trim()
                : ev.name;
            break;
          }
          case 'tool_end': {
            const item = toolItems.get(ev.id);
            if (item) {
              item.status = ev.isError ? 'error' : 'ok';
              item.isError = ev.isError;
              item.content = ev.content || '';
              item.dur = ev.dur;
              item.meta = ev.meta;
              // 成功的工具块自动收起（只留一行摘要），失败的保持展开
              item.collapsed = !ev.isError;
              item.ver++;
            }
            break;
          }
          case 'step': {
            this._gen = { t0: Date.now(), tok: 0 };
            break;
          }
          case 'usage': {
            this.usage = ev.total;
            this.context = ev.context || this.context;
            // 用真实输出 token 校正速度（这比按字符估准）
            const secs = (Date.now() - this._gen.t0) / 1000;
            if (secs > 0.25 && ev.usage?.output > 0) {
              this.speed = ev.usage.output / secs;
              this.lastSpeed = this.speed;
            }
            break;
          }
          case 'compact_start':
            this.push({ kind: 'compacted', text: `压缩上下文（${ev.nodes} 条记录，约 ${fmtNum(ev.tokens)} tokens）…` });
            this.stateDetail = '压缩上下文';
            break;
          case 'compact_end':
            this.push({
              kind: 'compacted',
              text: `已折叠为 ${ev.block}（${ev.topic}）· 上下文降到 ${(ev.context.used * 100).toFixed(1)}%（可用 /expand ${ev.block} 取回原文）`,
            });
            this.context = ev.context;
            break;
          case 'retry':
            this.push({ kind: 'warn', text: `请求失败（${ev.message}），${Math.round(ev.wait / 1000)}s 后重试 (${ev.attempt}/3)` });
            break;
          case 'error':
            this.state = 'error';
            this.push({ kind: 'error', text: ev.message });
            break;
          case 'need_key':
            this.push({ kind: 'error', text: `缺少 ${getProvider(ev.provider)?.name || ev.provider} 的 API key，用 /key 配置。` });
            break;
          case 'aborted':
            this.push({ kind: 'note', text: '已中断。' });
            break;
          case 'steering':
            this.push({ kind: 'user', text: ev.text });
            break;
          case 'truncated':
            if (ev.continuing) {
              this.push({ kind: 'note', text: `已达单次输出上限，自动续写（第 ${ev.round} 次）…` });
            } else {
              this.push({ kind: 'warn', text: '输出被长度上限截断，可再说「继续」或调大 maxTokens。' });
            }
            break;
          case 'max_steps':
            this.push({ kind: 'warn', text: '已达到最大工具调用步数（maxSteps 限制；设为 0 即不限，见 ~/.agent/config.json）。' });
            break;
          default:
            break;
        }
        this.dirty = true;
      }
    } catch (e) {
      this.state = 'error';
      this.push({ kind: 'error', text: `运行异常: ${e.message}` });
    } finally {
      finishThink();
      if (assistant) {
        assistant.streaming = false;
        // 很长的回答默认折叠成前 14 行，点一下就能展开
        if (!this.verbose && assistant.text.split(String.fromCharCode(10)).length > 40) {
          assistant.collapsed = true;
        }
        assistant.ver++;
      }
      this.running = false;
      this.state = this.state === 'error' ? 'error' : 'idle';
      this.stateDetail = '';
      if (this.taskT0) {
        this.lastElapsed = Date.now() - this.taskT0;
        this.taskT0 = 0;
        this.push({ kind: 'note', text: `用时 ${fmtDuration(this.lastElapsed)} · ${this.agent.usageTotal?.steps || 0} 步` });
      }
      this.dirty = true;
      this.saveSession();
      // 玩家在干活期间附加的消息：本轮收工后自动接着发（最多 5 条，逐条发）
      this.drainPending();
    }
  }

  /** 本轮收工后取一条待发消息开新的一轮；返回是否还有得发。 */
  drainPending() {
    if (this.running || this.quit || !this.pending.length) return false;
    const next = this.pending.shift();
    this.push({
      kind: 'note',
      text: `继续处理附加消息（还剩 ${this.pending.length} 条）：${next.slice(0, 60)}`,
    });
    this.dirty = true;
    setTimeout(() => {
      if (!this.running && !this.quit) this.runTurn(next);
    }, 40);
    return true;
  }

  /** 把输入框里的话附加到待发队列（AI 干活时按 Tab / Enter）。 */
  addPending(text = null) {
    const raw = String(text ?? this.input.text ?? '').trim();
    if (!raw) return;
    if (this.pending.length >= this.maxPending) {
      this.push({ kind: 'warn', text: `待发队列最多 ${this.maxPending} 条，先等 AI 处理完，或用 /queue drop <n> 删一条。` });
      this.dirty = true;
      return;
    }
    const msg = this.expandPastes(raw);
    this.pending.push(msg);
    this.input = { text: '', cursor: 0 };
    this.push({
      kind: 'note',
      text: `已附加待发 ${this.pending.length}/${this.maxPending}（本轮收工后自动发送）：${msg.replace(/\s+/g, ' ').slice(0, 60)}`,
      inline: true,
    });
    this.dirty = true;
    this.render(true);
  }

  async manualCompact() {
    this.running = true;
    try {
      for await (const ev of this.agent.compactInline(undefined)) {
        if (ev.type === 'compact_start') this.push({ kind: 'compacted', text: `压缩中（${ev.nodes} 条）…` });
        if (ev.type === 'compact_end') {
          this.context = ev.context;
          this.push({ kind: 'compacted', text: `已折叠为 ${ev.block}（${ev.topic}）· 现在 ${(ev.context.used * 100).toFixed(1)}%` });
        }
      }
    } catch (e) {
      this.push({ kind: 'error', text: `压缩失败: ${e.message}` });
    } finally {
      this.running = false;
      this.dirty = true;
    }
  }

  // ---------------------------------------------------------------- sessions
  saveSession() {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      if (!this.title) this.title = this.deriveTitle();
      const snap = this.agent.snapshot(this.title);
      if (!snap.context?.nodes?.length) return;
      snap.cwd = this.cwd;
      snap.items = this.serializeItems();
      fs.writeFileSync(path.join(SESSIONS_DIR, `${snap.id}.json`), JSON.stringify(snap, null, 1));
    } catch {}
  }

  /** 会话标题：demo 用固定名，否则取本会话第一条玩家输入，避免多个会话标题相同。 */
  deriveTitle() {
    if (this.demo) return '示例会话（--demo）';
    const first = this.items.find((it) => it.kind === 'user' && typeof it.text === 'string' && it.text.trim());
    const t = first ? first.text.replace(/\s+/g, ' ').trim() : '';
    return t ? t.slice(0, 60) : '新会话';
  }

  /** Items are mostly plain data; trim the big fields so sessions stay small. */
  serializeItems() {
    return this.items.slice(-400).map((it) => {
      const o = { ...it };
      delete o._cache;
      if (typeof o.content === 'string' && o.content.length > 20000) o.content = o.content.slice(0, 20000) + '\n…（历史记录已截断）';
      if (typeof o.text === 'string' && o.text.length > 40000) o.text = o.text.slice(0, 40000);
      return o;
    });
  }

  listSessions() {
    try {
      return fs
        .readdirSync(SESSIONS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const file = path.join(SESSIONS_DIR, f);
          try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            return { file, id: j.id || '', title: j.title || '(无标题)', cwd: j.cwd || '', provider: j.provider, model: j.model, msgs: j.context?.nodes?.length || 0, updated: j.updated || 0 };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 20);
    } catch {
      return [];
    }
  }

  loadLatestSession() {
    const list = this.listSessions();
    if (!list.length) return;
    try {
      const data = JSON.parse(fs.readFileSync(list[0].file, 'utf8'));
      this.agent.setSession(data);
      this.agent.sessionId = data.id;
      this.title = data.title;
    } catch {}
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function prettyCwd(cwd) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  let p = cwd;
  if (home && (cwd === home || cwd.toLowerCase().startsWith(home.toLowerCase()))) p = '~' + cwd.slice(home.length);
  return p.replace(/\\/g, '/');
}

function paintRow(left, right, width, bg) {
  const lw = strWidth(stripAnsi(left));
  const rw = strWidth(stripAnsi(right));
  const bgOpen = `\x1b[48;5;${bg}m`;
  const pad = (n) => ' '.repeat(Math.max(0, n));
  if (lw + rw <= width) return `${bgOpen}${left}${pad(width - lw - rw)}${right}\x1b[0m`;
  if (rw + 10 < width) {
    // Not enough room: shrink the left block, keep the right block intact.
    const l = truncToWidth(left, width - rw);
    const used = strWidth(stripAnsi(l));
    return `${bgOpen}${l}${pad(width - used - rw)}${right}\x1b[0m`;
  }
  return `${bgOpen}${truncToWidth(left, width)}\x1b[0m`;
}
