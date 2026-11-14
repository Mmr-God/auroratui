// Provider registry — real endpoints (verified against vendor docs).
// `api`: wire protocol -> 'openai' (chat/completions) or 'anthropic' (messages).

export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEY'],
    site: 'https://platform.deepseek.com/api_keys',
    docs: 'https://api-docs.deepseek.com',
    accent: '#4d6bfe',
    note: '1M 上下文 · 推理模式 · 工具调用',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', ctx: 1000000, maxOut: 384000, reasoning: true, cost: { in: 0.3, out: 1.2, cacheRead: 0.006 } },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', ctx: 1000000, maxOut: 384000, reasoning: true, cost: { in: 1.32, out: 3.96, cacheRead: 0.044 } },
    ],
    thinking: (eff) =>
      eff === 'off' ? { thinking: { type: 'disabled' }, reasoning_effort: null } : { thinking: { type: 'enabled' }, reasoning_effort: eff === 'max' ? 'max' : eff },
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    site: 'https://platform.openai.com/api-keys',
    docs: 'https://developers.openai.com/api/docs',
    accent: '#10a37f',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', ctx: 400000, maxOut: 128000, reasoning: true, cost: { in: 1.25, out: 10 } },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', ctx: 400000, maxOut: 128000, reasoning: true, cost: { in: 0.25, out: 2 } },
      { id: 'gpt-5.1', name: 'GPT-5.1', ctx: 400000, maxOut: 128000, reasoning: true, cost: { in: 1.25, out: 10 } },
    ],
    thinking: (eff) => (eff === 'off' ? {} : { reasoning_effort: eff === 'max' ? 'high' : eff }),
  },

  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    env: ['ANTHROPIC_API_KEY'],
    site: 'https://platform.claude.com/settings/keys',
    docs: 'https://platform.claude.com/docs',
    accent: '#d97757',
    models: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', ctx: 1000000, maxOut: 128000, reasoning: true, cost: { in: 2, out: 10 } },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', ctx: 1000000, maxOut: 128000, reasoning: true, cost: { in: 4, out: 20 } },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', ctx: 1000000, maxOut: 128000, reasoning: true, cost: { in: 0.1, out: 0.5 } },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', ctx: 1000000, maxOut: 128000, reasoning: true, cost: { in: 10, out: 50 } },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', ctx: 1000000, maxOut: 128000, reasoning: true, cost: { in: 5, out: 25 } },
    ],
    thinking: (eff) => (eff === 'off' ? {} : { thinking: { type: 'enabled' }, reasoningEffort: eff === 'max' ? 'max' : eff }),
  },

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    api: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    site: 'https://aistudio.google.com/apikey',
    docs: 'https://ai.google.dev/gemini-api/docs',
    accent: '#4285f4',
    note: 'OpenAI 兼容端点',
    models: [
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', ctx: 1000000, maxOut: 65536, reasoning: true, cost: { in: 2, out: 12 } },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', ctx: 1048576, maxOut: 65536, reasoning: true, cost: { in: 1.25, out: 10 } },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', ctx: 1048576, maxOut: 65536, reasoning: true, cost: { in: 0.3, out: 2.5 } },
    ],
  },

  moonshot: {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    api: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    altBaseUrls: ['https://api.moonshot.ai/v1'],
    env: ['MOONSHOT_API_KEY'],
    site: 'https://platform.moonshot.cn/console/api-keys',
    docs: 'https://platform.kimi.com/docs/api/overview',
    accent: '#1b1b1b',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', ctx: 262144, maxOut: 32768, reasoning: true, cost: { in: 0.6, out: 2.5 } },
      { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo', ctx: 262144, maxOut: 32768, cost: { in: 0.4, out: 1.6 } },
      { id: 'moonshot-v1-128k', name: 'Moonshot 128K', ctx: 131072, maxOut: 8192, cost: { in: 0.28, out: 0.28 } },
    ],
  },

  zhipu: {
    id: 'zhipu',
    name: '智谱 GLM',
    api: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    altBaseUrls: ['https://api.z.ai/api/paas/v4'],
    env: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    site: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docs: 'https://docs.bigmodel.cn',
    accent: '#3859ff',
    models: [
      { id: 'glm-4.6', name: 'GLM-4.6', ctx: 204800, maxOut: 131072, reasoning: true, cost: { in: 0.6, out: 2.2 } },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air', ctx: 131072, maxOut: 16384, reasoning: true, cost: { in: 0.2, out: 1.1 } },
    ],
    thinking: (eff) => (eff === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' } }),
  },

  qwen: {
    id: 'qwen',
    name: '阿里通义千问',
    api: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    env: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    site: 'https://bailian.console.aliyun.com/?apiKey=1',
    docs: 'https://help.aliyun.com/zh/model-studio/',
    accent: '#615ced',
    note: 'OpenAI 兼容模式',
    models: [
      { id: 'qwen3-max', name: 'Qwen3 Max', ctx: 262144, maxOut: 32768, cost: { in: 0.86, out: 3.44 } },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', ctx: 1000000, maxOut: 65536, reasoning: true, cost: { in: 0.4, out: 1.2 } },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', ctx: 1000000, maxOut: 65536, cost: { in: 0.6, out: 2.4 } },
    ],
  },

  xai: {
    id: 'xai',
    name: 'xAI Grok',
    api: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    env: ['XAI_API_KEY'],
    site: 'https://console.x.ai',
    docs: 'https://docs.x.ai',
    accent: '#9a9a9a',
    models: [
      { id: 'grok-4.7', name: 'Grok 4.7', ctx: 2000000, maxOut: 32768, reasoning: true, cost: { in: 3, out: 15 } },
      { id: 'grok-4-fast', name: 'Grok 4 Fast', ctx: 2000000, maxOut: 32768, reasoning: true, cost: { in: 0.2, out: 0.5 } },
    ],
  },

  groq: {
    id: 'groq',
    name: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEY'],
    site: 'https://console.groq.com/keys',
    docs: 'https://console.groq.com/docs',
    accent: '#f55036',
    note: '超低延迟推理',
    models: [
      { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 (Groq)', ctx: 131072, maxOut: 16384, cost: { in: 1, out: 3 } },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', ctx: 131072, maxOut: 32768, cost: { in: 0.59, out: 0.79 } },
      { id: 'openai/gpt-oss-120b', name: 'gpt-oss-120b', ctx: 131072, maxOut: 32768, reasoning: true, cost: { in: 0.15, out: 0.75 } },
    ],
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    site: 'https://openrouter.ai/keys',
    docs: 'https://openrouter.ai/docs',
    accent: '#8b5cf6',
    note: '一个 Key 聚合数百模型',
    headers: { 'HTTP-Referer': 'https://github.com/agent-tui', 'X-Title': 'agent-tui' },
    models: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', ctx: 163840, maxOut: 32768, cost: { in: 0.3, out: 1.2 } },
      { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', ctx: 1000000, maxOut: 128000, cost: { in: 2, out: 10 } },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', ctx: 400000, maxOut: 128000, cost: { in: 1.25, out: 10 } },
      { id: 'qwen/qwen3-coder-plus', name: 'Qwen3 Coder Plus', ctx: 1000000, maxOut: 65536, cost: { in: 0.6, out: 2.4 } },
      { id: '~openai/gpt-latest', name: 'gpt-latest (alias)', ctx: 400000, maxOut: 128000, cost: { in: 1.25, out: 10 } },
    ],
  },

  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    api: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    env: ['SILICONFLOW_API_KEY'],
    site: 'https://cloud.siliconflow.cn/account/ak',
    docs: 'https://docs.siliconflow.cn',
    accent: '#7c3aed',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', ctx: 163840, maxOut: 65536, cost: { in: 0.27, out: 1.1 } },
      { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen3 Coder 480B', ctx: 262144, maxOut: 65536, cost: { in: 0.3, out: 1.4 } },
      { id: 'moonshotai/Kimi-K2-Instruct-0905', name: 'Kimi K2 0905', ctx: 262144, maxOut: 65536, cost: { in: 0.6, out: 2.5 } },
    ],
  },

  ollama: {
    id: 'ollama',
    name: 'Ollama (本地)',
    api: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    env: [],
    noKey: true,
    site: 'https://ollama.com/download',
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    accent: '#22d3ee',
    note: '本地运行，无需 Key',
    models: [
      { id: 'qwen3-coder:30b', name: 'Qwen3 Coder 30B', ctx: 262144, maxOut: 32768, cost: { in: 0, out: 0 } },
      { id: 'gpt-oss:20b', name: 'gpt-oss 20B', ctx: 131072, maxOut: 32768, reasoning: true, cost: { in: 0, out: 0 } },
    ],
  },

  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (本地)',
    api: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    env: [],
    noKey: true,
    site: 'https://lmstudio.ai',
    docs: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    accent: '#38bdf8',
    note: '本地运行，无需 Key',
    models: [],
  },

  custom: {
    id: 'custom',
    name: '自定义 (OpenAI 兼容)',
    api: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    env: ['CUSTOM_API_KEY'],
    noKey: true,
    allowEmptyKey: true,
    site: '',
    docs: '',
    accent: '#a3a3a3',
    note: '任意 OpenAI 兼容端点，例如 vLLM / one-api / new-api',
    models: [],
  },
};

// Providers added at runtime by the user (/provider add …). They live in
// ~/.agent/config.json and are re-registered whenever the config loads.
export const CUSTOM = new Map();

export function registerCustomProviders(specs = {}) {
  CUSTOM.clear();
  for (const [id, spec] of Object.entries(specs || {})) {
    const models = (spec.models || []).map((m) => (typeof m === 'string' ? { id: m, name: m, ctx: 200000, maxOut: 32000, cost: { in: 0, out: 0 } } : m));
    CUSTOM.set(id, {
      id,
      name: spec.name || id,
      api: spec.api === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: spec.baseUrl || '',
      env: spec.env || [],
      custom: true,
      noKey: spec.noKey !== false,
      allowEmptyKey: true,
      site: spec.site || '',
      docs: spec.docs || '',
      accent: spec.accent || '#8ab4f8',
      note: spec.note || '自定义服务商',
      models,
      thinking: null,
      ...(spec.api === 'anthropic' ? {} : {}),
    });
  }
  return CUSTOM;
}

export function upsertCustomProvider(spec) {
  const models = (spec.models || []).map((m) => (typeof m === 'string' ? { id: m, name: m, ctx: 200000, maxOut: 32000, cost: { in: 0, out: 0 } } : m));
  const p = {
    id: spec.id,
    name: spec.name || spec.id,
    api: spec.api === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: spec.baseUrl || '',
    env: spec.env || [],
    custom: true,
    noKey: spec.noKey !== false,
    allowEmptyKey: true,
    site: spec.site || '',
    docs: spec.docs || '',
    accent: spec.accent || '#8ab4f8',
    note: spec.note || '自定义服务商',
    models,
    thinking: null,
  };
  CUSTOM.set(p.id, p);
  return p;
}

export function removeCustomProvider(id) {
  return CUSTOM.delete(id);
}

export const providerList = () => [...Object.values(PROVIDERS), ...CUSTOM.values()];

export function getProvider(id) {
  return CUSTOM.get(id) || PROVIDERS[id] || null;
}

// Resolve a model entry (search provider model tables, then fall back to an
// ad-hoc descriptor so custom/unlisted ids still work).
export function resolveModel(providerId, modelId) {
  const p = getProvider(providerId);
  if (!p) return null;
  const hit = (p.models || []).find((m) => m.id === modelId);
  if (hit) return { ...hit, provider: p.id };
  return { id: modelId, name: modelId, ctx: 128000, maxOut: 16384, cost: { in: 0, out: 0 }, provider: p.id };
}

export function providerModels(providerId, cache) {
  const p = getProvider(providerId);
  if (!p) return [];
  const out = [...(p.models || [])];
  const seen = new Set(out.map((m) => m.id));
  for (const m of (cache || []).slice().sort()) {
    if (!seen.has(m)) {
      out.push({ id: m, name: m, ctx: 128000, maxOut: 16384, cost: { in: 0, out: 0 }, dynamic: true });
      seen.add(m);
    }
  }
  return out;
}
