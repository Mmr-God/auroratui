// LLM transport: streaming SSE for OpenAI-compatible and Anthropic protocols.
import { PROVIDERS, getProvider } from './providers.js';

export class LLMError extends Error {
  constructor(message, { status, body, retryable } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.body = body;
    this.retryable = retryable ?? (status === 429 || (status >= 500 && status < 600));
  }
}

function headersFor(provider, apiKey) {
  const p = getProvider(provider);
  if (p.api === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      ...(p.headers || {}),
    };
  }
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(p.headers || {}),
  };
}

// --- message conversion ---------------------------------------------------
function toOpenAIMessages(systemPrompt, messages, providerId) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  const keepReasoning = ['deepseek', 'workbuddy', 'custom', 'siliconflow'].includes(providerId);
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant' };
      msg.content = m.text ?? '';
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        }));
      }
      if (keepReasoning && m.thinking) msg.reasoning_content = m.thinking;
      if (!msg.content && !msg.tool_calls) msg.content = '';
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' });
      // OpenAI 的 tool 消息不能带图：图片单独补一条 user 消息，vision 模型就能直接看
      for (const img of m.images || []) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: `（这是上一步「${m.name || '工具'}」返回的图片：${img.path || '图片'}）` },
            { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } },
          ],
        });
      }
    } else if (m.role === 'context') {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

function toAnthropicMessages(systemPrompt, messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'context') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.thinking && m.thinkingSignature) {
        blocks.push({ type: 'thinking', thinking: m.thinking, signature: m.thinkingSignature });
      }
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '…' });
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const img of m.images || []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
      }
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: content.length === 1 && content[0].type === 'text' ? m.content ?? '' : content,
      };
      if (m.isError) block.is_error = true;
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last._toolResults) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block], _toolResults: true });
      }
    }
  }
  for (const m of out) delete m._toolResults;
  return { system: systemPrompt, messages: out };
}

function toolSchemas(tools, api) {
  if (api === 'anthropic') {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// --- SSE ----------------------------------------------------------------
async function* sseEvents(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          /* partial json, ignore */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
    void signal;
  }
}

// --- public API ---------------------------------------------------------
/**
 * Stream a chat completion. Yields events:
 *  {type:'text',text} {type:'reasoning',text} {type:'tool_use',id,name,input}
 *  {type:'usage',usage} {type:'stop',reason}
 */
export async function* streamChat(opts) {
  const {
    provider,
    model,
    messages,
    systemPrompt,
    tools = [],
    apiKey,
    baseUrl,
    settings = {},
    maxTokens,
    signal,
    temperature,
  } = opts;
  const p = getProvider(provider);
  if (!p) throw new LLMError(`未知 provider: ${provider}`);
  const url = `${(baseUrl || p.baseUrl).replace(/\/+$/, '')}${p.api === 'anthropic' ? '/messages' : '/chat/completions'}`;
  const effort = settings.thinking || 'medium';
  const thinkParams = p.thinking ? p.thinking(effort) : {};
  const cleanThink = Object.fromEntries(Object.entries(thinkParams || {}).filter(([, v]) => v !== null && v !== undefined));

  let body;
  if (p.api === 'anthropic') {
    const { system, messages: msgs } = toAnthropicMessages(systemPrompt, messages);
    body = {
      model,
      system,
      messages: msgs,
      max_tokens: maxTokens || settings.maxTokens || 8000,
      stream: true,
      ...(tools.length ? { tools: toolSchemas(tools, 'anthropic') } : {}),
      ...(cleanThink.thinking ? { thinking: { type: 'enabled', budget_tokens: Math.max(1024, Math.min(24000, (maxTokens || 8000) - 1024)) } } : {}),
    };
    if (temperature != null && !cleanThink.thinking) body.temperature = temperature;
  } else {
    body = {
      model,
      messages: toOpenAIMessages(systemPrompt, messages, provider),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools: toolSchemas(tools, 'openai'), tool_choice: 'auto' } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...simpleThink(cleanThink, provider),
    };
    if (temperature != null && !cleanThink.thinking && !cleanThink.reasoning_effort) body.temperature = temperature;
  }
  if (p.api === 'openai' && provider === 'custom') body.max_tokens = maxTokens || settings.maxTokens;

  const res = await fetch(url, {
    method: 'POST',
    headers: headersFor(provider, apiKey),
    body: JSON.stringify(body),
    signal,
  }).catch((e) => {
    if (e.name === 'AbortError') throw e;
    throw new LLMError(`网络错误: ${e.message}`, { retryable: true });
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.message || j.error || msg;
      if (typeof msg === 'object') msg = JSON.stringify(msg);
    } catch {
      if (text) msg = `${msg}: ${text.slice(0, 400)}`;
    }
    throw new LLMError(msg, { status: res.status, body: text });
  }

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const toolBuf = new Map();
  let stopReason = null;

  if (p.api === 'anthropic') {
    let curTool = null;
    let thinkingText = '';
    let thinkingSig = '';
    for await (const ev of sseEvents(res, signal)) {
      switch (ev.type) {
        case 'message_start':
          if (ev.message?.usage) {
            usage.input = ev.message.usage.input_tokens || 0;
            usage.cacheRead = ev.message.usage.cache_read_input_tokens || 0;
            usage.cacheWrite = ev.message.usage.cache_creation_input_tokens || 0;
          }
          break;
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            curTool = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
          }
          break;
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'text_delta') yield { type: 'text', text: d.text };
          else if (d.type === 'thinking_delta') {
            thinkingText += d.thinking || '';
            yield { type: 'reasoning', text: d.thinking || '' };
          } else if (d.type === 'signature_delta') thinkingSig += d.signature || '';
          else if (d.type === 'input_json_delta' && curTool) curTool.json += d.partial_json || '';
          break;
        }
        case 'content_block_stop':
          if (curTool) {
            let input = {};
            try {
              input = curTool.json ? JSON.parse(curTool.json) : {};
            } catch {
              input = { _raw: curTool.json };
            }
            yield { type: 'tool_use', id: curTool.id, name: curTool.name, input };
            toolBuf.set(curTool.id, input);
            curTool = null;
          }
          break;
        case 'message_delta':
          if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          break;
        case 'error':
          throw new LLMError(ev.error?.message || 'stream error', { retryable: false });
        default:
          break;
      }
    }
    if (thinkingText) yield { type: 'thinking_signature', signature: thinkingSig };
  } else {
    for await (const ev of sseEvents(res, signal)) {
      if (ev.usage) {
        usage.input = ev.usage.prompt_tokens ?? usage.input;
        usage.output = ev.usage.completion_tokens ?? usage.output;
        const cr = ev.usage.prompt_tokens_details?.cached_tokens ?? ev.usage.prompt_cache_hit_tokens;
        if (cr) usage.cacheRead = cr;
      }
      if (ev.error) throw new LLMError(ev.error.message || JSON.stringify(ev.error), { retryable: false });
      const choice = ev.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      const r = d.reasoning_content ?? d.reasoning;
      if (r) yield { type: 'reasoning', text: r };
      if (d.content) yield { type: 'text', text: d.content };
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? 0;
        const cur = toolBuf.get(idx) || { id: tc.id || `call_${idx}`, name: '', json: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.json += tc.function.arguments;
        toolBuf.set(idx, cur);
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
    for (const [idx, t] of toolBuf) {
      if (!t.name) continue;
      let input = {};
      try {
        input = t.json ? JSON.parse(t.json) : {};
      } catch {
        input = { _raw: t.json };
      }
      yield { type: 'tool_use', id: t.id || `call_${idx}_${Date.now()}`, name: t.name, input };
    }
  }

  yield { type: 'usage', usage };
  yield { type: 'stop', reason: stopReason };
}

function simpleThink(params, provider) {
  const out = { ...params };
  if (out.reasoning_effort === undefined && out.thinking === undefined) return {};
  if (provider === 'openai' && out.reasoning_effort) return { reasoning_effort: out.reasoning_effort };
  return out;
}

// --- model discovery -----------------------------------------------------
export async function listProviderModels({ provider, apiKey, baseUrl, timeoutMs = 12000 }) {
  const p = getProvider(provider);
  if (!p) throw new LLMError('unknown provider');
  const base = (baseUrl || p.baseUrl).replace(/\/+$/, '');
  const url = p.api === 'anthropic' ? `${base}/models?limit=100` : `${base}/models`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: headersFor(provider, apiKey), signal: ctl.signal });
    if (!res.ok) throw new LLMError(`HTTP ${res.status}`, { status: res.status });
    const j = await res.json();
    const arr = j.data || j.models || [];
    return arr.map((m) => m.id || m.name).filter(Boolean);
  } finally {
    clearTimeout(t);
  }
}

export function estimateCost(model, usage) {
  const c = model?.cost;
  if (!c) return 0;
  const mc = (usage.cacheRead || 0) / 1e6;
  const uncached = Math.max(0, (usage.input || 0) - (usage.cacheRead || 0)) / 1e6;
  const mo = (usage.output || 0) / 1e6;
  return uncached * (c.in || 0) + mc * (c.cacheRead ?? c.in ?? 0) + mo * (c.out || 0);
}

export { PROVIDERS };
