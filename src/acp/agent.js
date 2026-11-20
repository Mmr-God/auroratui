// ACP Agent —— 把 AuroraTui 的 Agent 接到 Agent Client Protocol v1 上。
//
// 协议文档：https://agentclientprotocol.com/protocol/v1/overview
// 传输：src/acp/server.js（换行分隔 JSON-RPC 2.0）
//
// 核心映射关系：
//   Agent.run() 的 async generator 事件  →  session/update 通知
//     text        → agent_message_chunk
//     reasoning   → agent_thought_chunk
//     tool_start  → tool_call        (status: in_progress)
//     tool_end    → tool_call_update (status: completed / failed)
//   ctx.ask()   → session/request_permission（客户端弹选项）
//   session/cancel → AbortController.abort()

import { RpcConnection, RpcError, Err } from './server.js';
import { Agent } from '../agent.js';
import { Config } from '../config.js';

const PROTOCOL_VERSION = 1;
const AGENT_NAME = 'AuroraTui';
const AGENT_VERSION = '2.1.0';

// 工具名 → ACP ToolKind（决定客户端用什么图标 / 怎么展示）
const TOOL_KIND = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  patch: 'edit',
  delete: 'delete',
  move: 'move',
  glob: 'search',
  grep: 'search',
  ls: 'search',
  shell: 'execute',
  diagnostics: 'execute',
  jobs: 'execute',
  think: 'think',
  ask: 'other',
  web_search: 'fetch',
  web_fetch: 'fetch',
  http_request: 'fetch',
  git: 'read',
  todo: 'other',
  memory: 'other',
  skill: 'read',
  context: 'other',
  plugin: 'other',
  subagent: 'other',
  team: 'other',
};

function toolKind(name) {
  return TOOL_KIND[String(name || '').toLowerCase()] || 'other';
}

/** 给工具调用生成一句人类可读的标题（客户端列表里显示这行）。 */
function toolTitle(name, input) {
  const i = input || {};
  const short = (v, n = 80) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  switch (String(name || '').toLowerCase()) {
    case 'read':
      return `读 ${short(i.path || i.file || '', 120)}`;
    case 'write':
      return `写 ${short(i.path || i.file || '', 120)}`;
    case 'edit':
      return `改 ${short(i.path || i.file || '', 120)}`;
    case 'patch':
      return `打补丁`;
    case 'shell':
      return `执行 ${short(i.command || '', 120)}`;
    case 'glob':
      return `找文件 ${short(i.pattern || '', 80)}`;
    case 'grep':
      return `搜 ${short(i.pattern || '', 80)}`;
    case 'ls':
      return `列目录 ${short(i.path || '.', 80)}`;
    case 'web_search':
      return `搜索 ${short(i.query || '', 80)}`;
    case 'web_fetch':
      return `抓网页 ${short(i.url || '', 100)}`;
    case 'think':
      return '思考';
    case 'ask':
      return `提问：${short(i.question || '', 100)}`;
    case 'todo':
      return `待办 ${short(i.action || '', 40)}`;
    case 'subagent':
      return `子代理 ${short(i.name || i.role || '', 60)}`;
    case 'team':
      return `团队 ${short(i.action || '', 40)}`;
    default:
      return short(name || 'tool', 60);
  }
}

/** 工具结果 → ACP ToolCallContent[] */
function toolContent(result) {
  const out = [];
  const text = typeof result === 'string' ? result : result?.content;
  if (typeof text === 'string' && text.length) {
    out.push({ type: 'content', content: { type: 'text', text } });
  }
  return out;
}

/** 把 ACP prompt 的 content blocks 拼成一段给模型的文本。 */
function promptToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      parts.push(String(b.text ?? ''));
    } else if (b.type === 'resource_link') {
      // 基线能力：resource_link 必须支持
      const uri = b.uri || '';
      const name = b.name || uri;
      parts.push(`[附件] ${name}${uri && uri !== name ? ` (${uri})` : ''}`);
    } else if (b.type === 'resource') {
      const r = b.resource || {};
      const uri = r.uri || '';
      const text = r.text ?? (r.blob ? `[二进制 ${r.mimeType || ''}，${String(r.blob).length} bytes]` : '');
      parts.push(`[文件 ${uri}]\n${text}`);
    } else if (b.type === 'image') {
      parts.push('[图片：当前 agent 不支持视觉输入]');
    } else if (b.type === 'audio') {
      parts.push('[音频：当前 agent 不支持音频输入]');
    }
  }
  return parts.join('\n\n').trim();
}

export class AcpAgent {
  constructor({ input = process.stdin, output = process.stdout, log = () => {} } = {}) {
    this.log = log;
    this.sessions = new Map();   // sessionId -> { id, agent, cwd, abort, busy }
    this.initialized = false;
    this.clientCapabilities = {};
    this.conn = new RpcConnection({ input, output, log });
    this.conn.onClose = () => {
      // 客户端没了，把还在跑的 turn 全停掉
      for (const s of this.sessions.values()) {
        try { s.abort?.abort(); } catch {}
      }
    };
    this._register();
  }

  _register() {
    this.conn.handleAll({
      initialize: (p) => this.onInitialize(p),
      authenticate: () => ({}),
      'session/new': (p) => this.onNewSession(p),
      'session/load': (p) => this.onLoadSession(p),
      'session/prompt': (p) => this.onPrompt(p),
      'session/cancel': (p) => this.onCancel(p),
      'session/set_mode': (p) => this.onSetMode(p),
      'session/set_config_option': (p) => ({}),
      // 客户端不该发这些，但别让它们把连接搞崩
      'session/update': () => null,
    });
  }

  /** 除了 initialize，其他请求必须先初始化 */
  _requireInit() {
    if (!this.initialized) {
      throw new RpcError(Err.INVALID_REQUEST, 'Not initialized: send `initialize` first');
    }
  }

  _session(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new RpcError(Err.NOT_FOUND, `Unknown session: ${sessionId}`, { sessionId });
    }
    return s;
  }

  // ------------------------------------------------------------------ methods

  onInitialize(params) {
    const clientVersion = Number(params?.protocolVersion ?? PROTOCOL_VERSION);
    this.clientCapabilities = params?.clientCapabilities || {};
    this.initialized = true;
    this.log(`initialize: client=${params?.clientInfo?.name || '?'}@${params?.clientInfo?.version || '?'} v=${clientVersion}`);

    return {
      protocolVersion: Math.min(clientVersion, PROTOCOL_VERSION) || 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,          // 模型侧暂无视觉输入通道
          audio: false,
          embeddedContext: true, // 支持 resource 内联内容
        },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
        auth: {},
      },
      authMethods: [],
      agentInfo: {
        name: AGENT_NAME,
        title: 'AuroraTui (ACP)',
        version: AGENT_VERSION,
      },
    };
  }

  onNewSession(params) {
    this._requireInit();
    const cwd = String(params?.cwd || process.cwd());
    const config = new Config();
    config.load();

    const agent = new Agent({ config, cwd });

    const id = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const session = { id, agent, cwd, abort: null, busy: false, config };
    this.sessions.set(id, session);
    this.log(`session/new ${id} cwd=${cwd}`);

    // 让 ask 工具能通过客户端弹选项
    agent.setAskHandler((payload) => this._ask(session, payload));

    const t = agent.target();
    return {
      sessionId: id,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: '默认', description: '正常执行，工具调用前会征求同意' },
        ],
      },
      _meta: { provider: t.providerId, model: t.modelId },
    };
  }

  onLoadSession(params) {
    // 没声明 loadSession 能力，按规范应回方法未找到 / 不支持
    throw new RpcError(Err.METHOD_NOT_FOUND, 'session/load is not supported');
  }

  onSetMode(params) {
    this._requireInit();
    const s = this._session(params?.sessionId);
    const modeId = String(params?.modeId || '');
    if (modeId && modeId !== 'default') {
      throw new RpcError(Err.INVALID_PARAMS, `Unknown mode: ${modeId}`);
    }
    return { currentModeId: s.modeId || 'default' };
  }

  onCancel(params) {
    const sessionId = params?.sessionId;
    const s = this.sessions.get(sessionId);
    this.log(`session/cancel ${sessionId}`);
    if (s) {
      s.cancelled = true;
      try { s.abort?.abort(); } catch {}
      // 挂着的权限请求也必须立刻以 cancelled 收尾
      this._cancelPendingPermission(s);
    }
    return {};
  }

  async onPrompt(params) {
    this._requireInit();
    const s = this._session(params?.sessionId);
    const text = promptToText(params?.prompt);

    if (!text) {
      throw new RpcError(Err.INVALID_PARAMS, 'Prompt contains no usable content');
    }
    if (s.busy) {
      throw new RpcError(Err.INVALID_REQUEST, 'This session is already processing a prompt');
    }

    s.busy = true;
    s.cancelled = false;
    const controller = new AbortController();
    s.abort = controller;

    try {
      for await (const ev of s.agent.run(text, { signal: controller.signal })) {
        const stop = this._emit(s, ev);
        if (stop) return stop;
      }
      return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
    } catch (e) {
      this.log(`prompt error: ${e?.stack || e?.message || e}`);
      if (s.cancelled || controller.signal.aborted) return { stopReason: 'cancelled' };
      throw new RpcError(Err.INTERNAL, e?.message || 'Agent run failed');
    } finally {
      s.busy = false;
      s.abort = null;
      this._cancelPendingPermission(s);
    }
  }

  /**
   * 把一个 Agent 事件翻成 ACP 通知。
   * 返回非 null 表示这一轮该结束了（返回 PromptResponse）。
   */
  _emit(session, ev) {
    const update = (u) => this.conn.notify('session/update', { sessionId: session.id, update: u });

    switch (ev.type) {
      case 'turn_start':
        return null;

      case 'step':
      case 'assistant_done':
      case 'usage':
      case 'compacted':
      case 'compact_start':
      case 'compact_end':
      case 'steering':
        return null;

      case 'text':
        if (ev.delta) {
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ev.delta } });
        }
        return null;

      case 'reasoning':
        if (ev.delta) {
          update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ev.delta } });
        }
        return null;

      case 'tool_call':
      case 'tool_start':
        // Agent 会先 yield tool_call（模型刚返回），再 yield tool_start（真正执行）。
        // 两者是同一个 toolCallId，只能发一次 tool_call 通知，否则客户端会显示重复条目。
        {
          const id = String(ev.id ?? `call-${Date.now()}`);
          session.announcedCalls ??= new Set();
          if (session.announcedCalls.has(id)) return null;
          session.announcedCalls.add(id);
          update({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: toolTitle(ev.name, ev.input),
            name: ev.name,
            kind: toolKind(ev.name),
            status: 'in_progress',
            rawInput: ev.input ?? null,
          });
        }
        return null;

      case 'tool_end':
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: String(ev.id ?? ''),
          status: ev.isError ? 'failed' : 'completed',
          content: toolContent(ev),
        });
        return null;

      case 'retry':
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n[重试 ${ev.attempt}] ${ev.message || ''}\n` },
        });
        return null;

      case 'truncated':
        if (ev.continuing === false) {
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '\n[输出达到长度上限]\n' },
          });
        }
        return null;

      case 'aborted':
        return { stopReason: 'cancelled' };

      case 'error':
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n[错误] ${ev.message}\n` },
        });
        return { stopReason: 'refusal' };

      case 'need_key':
        update({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `\n[缺少 ${ev.provider} 的 API key] 先在终端跑一次 auroratui，用 /key 配置。\n`,
          },
        });
        return { stopReason: 'refusal' };

      case 'max_steps':
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '\n[达到单轮步数上限]\n' },
        });
        return { stopReason: 'max_turn_requests' };

      case 'done':
        return { stopReason: 'end_turn' };

      default:
        return null;
    }
  }

  // --------------------------------------------------------------- 权限请求

  /**
   * ask 工具落到这里：用 ACP 的 session/request_permission 让客户端弹选项。
   * 客户端回 { outcome: { outcome: 'selected', optionId } } 或 { outcome: 'cancelled' }
   */
  async _ask(session, payload) {
    const question = String(payload?.question || '需要你确认');
    const rawOptions = Array.isArray(payload?.options) ? payload.options : [];
    const options = rawOptions.map((o, i) => {
      const label = typeof o === 'string' ? o : String(o?.label ?? o?.name ?? `选项 ${i + 1}`);
      const desc = typeof o === 'object' && o ? (o.desc || o.description || '') : '';
      return { label, desc, recommended: !!o?.recommended };
    });

    const acpOptions = [
      ...options.map((o, i) => ({
        optionId: `opt-${i}`,
        // 名字里带上说明，客户端列表里能看全
        name: o.desc ? `${o.label} — ${o.desc}` : o.label,
        kind: 'allow_once',
      })),
      { optionId: 'reject', name: '算了，你自己决定', kind: 'reject_once' },
    ];

    const reqPromise = this.conn.request('session/request_permission', {
      sessionId: session.id,
      toolCall: {
        toolCallId: `ask-${Date.now().toString(36)}`,
        title: question,
        kind: 'other',
        status: 'pending',
        rawInput: { question, options: options.map((o) => o.label) },
      },
      options: acpOptions,
    });

    // 客户端可能永远不回应（或直接取消这一轮）。用 race 保证不会挂死：
    // session/cancel 触发 _cancelPendingPermission() 时立刻以 cancelled 收尾。
    const cancelled = new Promise((resolve) => {
      session._resolvePermissionCancelled = () => resolve({ outcome: { outcome: 'cancelled' } });
    });
    session.pendingPermission = true;

    let res;
    try {
      res = await Promise.race([reqPromise.catch(() => null), cancelled]);
    } finally {
      session.pendingPermission = false;
      session._resolvePermissionCancelled = null;
    }

    if (session.cancelled) return null;

    const outcome = res?.outcome;
    if (!outcome || outcome.outcome === 'cancelled') return null;
    const optionId = String(outcome.optionId ?? '');
    if (optionId === 'reject') return null;
    const idx = options.findIndex((_, i) => `opt-${i}` === optionId);
    if (idx < 0) return null;
    return { answer: options[idx].label };
  }

  _cancelPendingPermission(session) {
    if (session.pendingPermission) {
      try { session._resolvePermissionCancelled?.(); } catch {}
      session.pendingPermission = false;
    }
  }

  start() {
    this.conn.handleAll({});
  }
}

/** 从 stdin/stdout 起一个 ACP agent。绝不往 stdout 打业务日志。 */
export function serveAcp({ log } = {}) {
  const logger =
    log ||
    ((m) => {
      try { process.stderr.write(`[acp] ${m}\n`); } catch {}
    });

  const agent = new AcpAgent({ log: logger });
  process.stderr.write(`[acp] ${AGENT_NAME} ${AGENT_VERSION} listening on stdio (protocol v${PROTOCOL_VERSION})\n`);
  return agent;
}
