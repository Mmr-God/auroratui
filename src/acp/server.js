// JSON-RPC 2.0 over stdio —— ACP 的传输层。
//
// 规范要点（docs/protocol/v1/transports.mdx）：
//   · 消息是 UTF-8 JSON，**用 \n 分隔**，消息体内不许有裸换行
//   · agent 的 stdout **只能**写 ACP 消息，日志一律走 stderr
//   · 客户端发来的也只会是合法 ACP 消息
//
// 这里刻意不引第三方库：AIAgent 是零依赖项目。

const JSONRPC = '2.0';

// ACP 保留 + JSON-RPC 标准错误码
export const Err = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
  NOT_FOUND: -32002,
};

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message || '');
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * 帧解析：按 \n 切分。返回一批已解析的完整对象。
 * 不完整的尾段留在 buffer 里等下一块数据。
 */
export class LineFramer {
  constructor(onMessage, onError) {
    this.buf = '';
    this.onMessage = onMessage;
    this.onError = onError;
  }

  push(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (e) {
        this.onError?.(new RpcError(Err.PARSE, `Cannot parse JSON: ${e.message}`));
        continue;
      }
      this.onMessage?.(msg);
    }
  }
}

/**
 * 双向 JSON-RPC 连接。
 *  - 收请求：注册 method handler，自动回响应
 *  - 发请求：拿回 Promise，等对方响应
 *  - 发通知：单向，不等响应
 */
export class RpcConnection {
  constructor({ input, output, log = () => {} }) {
    this.input = input;
    this.output = output;
    this.log = log;

    this.handlers = new Map();      // method -> async (params, ctx) => result
    this.pending = new Map();       // id -> { resolve, reject, method }
    this.nextId = 1;
    this.closed = false;
    this.onClose = null;

    this.framer = new LineFramer(
      (msg) => this._dispatch(msg),
      (err) => this._sendRaw({ jsonrpc: JSONRPC, id: null, error: { code: err.code, message: err.message } })
    );

    this._wireInput();
  }

  _wireInput() {
    const { input } = this;
    if (!input) return;
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => this.framer.push(chunk));
    input.on('end', () => this._shutdown('input closed'));
    input.on('error', (e) => this._shutdown(`input error: ${e.message}`));
  }

  _shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.log(`connection closed: ${reason}`);
    // 未完成的请求统统失败，避免调用方永久挂起
    for (const [id, p] of this.pending) {
      p.reject(new RpcError(Err.CANCELLED, `Connection closed while waiting for ${p.method}`));
      this.pending.delete(id);
    }
    try { this.onClose?.(reason); } catch {}
  }

  /** 注册一个方法的处理函数。返回值会被包成 result。 */
  handle(method, fn) {
    this.handlers.set(method, fn);
    return this;
  }

  /** 批量注册：{ 'session/new': fn, ... } */
  handleAll(map) {
    for (const [k, v] of Object.entries(map)) this.handle(k, v);
    return this;
  }

  _sendRaw(obj) {
    if (this.closed) return false;
    try {
      // 关键：必须压成单行。JSON.stringify 本身不产生裸换行，
      // 但字符串字面量里的 \n 会被转义成 \\n，所以这里是安全的。
      this.output.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (e) {
      this.log(`write failed: ${e.message}`);
      return false;
    }
  }

  async _dispatch(msg) {
    if (!msg || typeof msg !== 'object') {
      this._sendRaw({ jsonrpc: JSONRPC, id: null, error: { code: Err.INVALID_REQUEST, message: 'Invalid request' } });
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
    const isResponse = !msg.method && (hasId || msg.error);

    // ---- 对方回给我们的响应 ----
    if (isResponse) {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.log(`response for unknown id ${msg.id}`);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // ---- 对方发来的请求 / 通知 ----
    const method = msg.method;
    if (typeof method !== 'string') {
      if (hasId) {
        this._sendRaw({ jsonrpc: JSONRPC, id: msg.id, error: { code: Err.INVALID_REQUEST, message: 'Missing method' } });
      }
      return;
    }

    const fn = this.handlers.get(method);
    if (!fn) {
      if (hasId) {
        this._sendRaw({
          jsonrpc: JSONRPC,
          id: msg.id,
          error: { code: Err.METHOD_NOT_FOUND, message: `Method not found: ${method}` },
        });
      }
      // 通知（无 id）不认识就静默丢弃，符合 JSON-RPC 语义
      return;
    }

    try {
      const result = await fn(msg.params ?? {}, { id: msg.id, isNotification: !hasId });
      if (hasId) this._sendRaw({ jsonrpc: JSONRPC, id: msg.id, result: result ?? null });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : Err.INTERNAL;
      const data = e instanceof RpcError ? e.data : undefined;
      this.log(`handler ${method} failed: ${e?.stack || e?.message || e}`);
      if (hasId) {
        const error = { code, message: e?.message || 'Internal error' };
        if (data !== undefined) error.data = data;
        this._sendRaw({ jsonrpc: JSONRPC, id: msg.id, error });
      }
    }
  }

  /** 发请求，等响应。 */
  request(method, params) {
    if (this.closed) return Promise.reject(new RpcError(Err.CANCELLED, 'Connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const ok = this._sendRaw({ jsonrpc: JSONRPC, id, method, params: params ?? {} });
      if (!ok) {
        this.pending.delete(id);
        reject(new RpcError(Err.INTERNAL, 'Failed to write request'));
      }
    });
  }

  /** 发通知，不等响应。 */
  notify(method, params) {
    this._sendRaw({ jsonrpc: JSONRPC, method, params: params ?? {} });
  }

  close() {
    this._shutdown('closed by us');
  }
}
