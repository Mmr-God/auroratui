// Config: ~/.agent/config.json (0600), env-var fallbacks, first-run defaults.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, getProvider, registerCustomProviders, upsertCustomProvider, removeCustomProvider, providerList } from './providers.js';

// AGENT_HOME lets tests / portable installs point at another config dir.
// Resolved lazily (per call, not at import time) so a test that sets the env var
// right after importing this module can never touch the user's real ~/.agent.
export function agentDir() {
  return process.env.AGENT_HOME ? path.resolve(process.env.AGENT_HOME) : path.join(os.homedir(), '.agent');
}
export const AGENT_DIR = agentDir();
export const CONFIG_PATH = path.join(AGENT_DIR, 'config.json');
export const SESSIONS_DIR = path.join(AGENT_DIR, 'sessions');
export const LOG_DIR = path.join(AGENT_DIR, 'logs');

const DEFAULTS = {
  version: 1,
  active: { provider: 'deepseek', model: 'deepseek-flash' },
  providers: {},
  settings: {
    thinking: 'off',
    temperature: 0.3,
    maxTokens: 32000,
    maxSteps: 0, // 每轮最大工具调用步数；0 = 不限（想限制就填正数，例如 60）
    showThinking: true,
    verbose: false,
    autoCompact: true,
    compactAt: 0.72,
    shellPath: null,
    theme: 'midnight',
    allowOutsideCwd: false, // 全权模式：允许在工作区之外读写（/trust 手动开启）
    checkpoints: true, // 写文件前自动快照，/undo 可回滚
    // --- 子代理 / 团队（默认全关：会额外消耗 token，必须玩家手动开启）
    subagents: false, // 允许 agent 用 subagent 工具派生独立上下文的助手（/subagents on）
    team: false, // 允许 agent 用 team 工具组队并行开发（/team on）
    subagentDepth: 1, // 子代理还能不能再派子代理（1 = 只有主代理能派）
    subagentMaxSteps: 40, // 单个子代理最多走多少步（防止跑飞）
    subagentTimeout: 600, // 单个子代理超时（秒）；到点先让它收尾交代，再硬断
    teamConcurrency: 2, // 团队成员同时跑几个（越大越快也越烧 token）
    teamMaxMembers: 10, // 一支团队最多几个成员
    teamMemberTimeout: 1800, // 团队成员的时间上限（秒）——比子代理宽松得多，成员要真的把活干完
    plugins: true, // 启动时自动加载 plugins/ 下的插件（draw 画板等）；false = 全关
    progress: true, // 浏览器团队面板（用到子代理/团队时自动开，绑定 127.0.0.1）
    progressPort: 7870, // 面板端口（被占用时自动往后找）
  },
  hooks: { preToolUse: [], postToolUse: [] },
  customProviders: {},
  modelCache: {},
  recent: [],
};

function ensureDirs() {
  const dir = agentDir();
  for (const d of [dir, path.join(dir, 'sessions'), path.join(dir, 'logs')]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {}
  }
}

export class Config {
  constructor() {
    ensureDirs();
    this.data = structuredClone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(path.join(agentDir(), 'config.json'), 'utf8');
      const parsed = JSON.parse(raw);
      this.data = deepMerge(structuredClone(DEFAULTS), parsed);
    } catch {
      /* first run */
    }
    registerCustomProviders(this.data.customProviders || {});
  }

  save() {
    try {
      ensureDirs();
      const file = path.join(agentDir(), 'config.json');
      fs.writeFileSync(file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {}
    } catch (e) {
      console.error('无法写入配置: ' + e.message);
    }
  }

  // --- provider credentials ------------------------------------------------
  get apiKey() {
    const id = this.data.active.provider;
    const p = getProvider(id);
    const cred = this.data.providers?.[id] || {};
    if (cred.apiKey) return cred.apiKey;
    for (const env of p?.env || []) {
      if (process.env[env]) return process.env[env];
    }
    return '';
  }

  get isConfigured() {
    const p = getProvider(this.data.active.provider);
    if (!p) return false;
    if (p.noKey && !this.keyRequiredForCurrent) return true;
    return !!this.apiKey;
  }

  get keyRequiredForCurrent() {
    return !getProvider(this.data.active.provider)?.noKey;
  }

  baseUrl(providerId = this.data.active.provider) {
    const p = getProvider(providerId);
    const over = this.data.providers?.[providerId]?.baseUrl;
    return (over || p?.baseUrl || '').replace(/\/+$/, '');
  }

  setApiKey(providerId, key) {
    this.data.providers[providerId] = { ...(this.data.providers[providerId] || {}), apiKey: key };
    this.save();
  }

  // --- user defined providers ---------------------------------------------
  addProvider({ id, name, baseUrl, api, models, note }) {
    const spec = {
      id,
      name: name || id,
      baseUrl: (baseUrl || '').replace(/\/+$/, ''),
      api: api === 'anthropic' ? 'anthropic' : 'openai',
      note: note || '自定义服务商',
      models: (models || []).map((m) => (typeof m === 'string' ? { id: m, name: m, ctx: 200000, maxOut: 32000, cost: { in: 0, out: 0 } } : m)),
    };
    this.data.customProviders[id] = { ...(this.data.customProviders[id] || {}), ...spec };
    upsertCustomProvider(this.data.customProviders[id]);
    this.save();
    return getProvider(id);
  }

  removeProvider(id) {
    delete this.data.customProviders[id];
    delete this.data.providers[id];
    removeCustomProvider(id);
    this.save();
  }

  addProviderModel(id, modelId, extra = {}) {
    const spec = this.data.customProviders[id];
    if (!spec) return null;
    spec.models = spec.models || [];
    const norm = (m) => (typeof m === 'string' ? { id: m, name: m, ctx: 200000, maxOut: 32000, cost: { in: 0, out: 0 } } : m);
    spec.models = spec.models.map(norm);
    if (!spec.models.some((m) => m.id === modelId)) spec.models.push({ id: modelId, name: modelId, ctx: extra.ctx || 200000, maxOut: extra.maxOut || 32000, cost: { in: 0, out: 0 } });
    upsertCustomProvider({ ...spec, models: spec.models });
    this.save();
    return getProvider(id);
  }

  get customProviders() {
    return providerList().filter((p) => p.custom);
  }

  setBaseUrl(providerId, url) {
    this.data.providers[providerId] = { ...(this.data.providers[providerId] || {}), baseUrl: url };
    this.save();
  }

  hasKey(providerId) {
    const p = getProvider(providerId);
    if (!p) return false;
    if (p.noKey) return true;
    if (this.data.providers?.[providerId]?.apiKey) return true;
    return (p.env || []).some((e) => !!process.env[e]);
  }

  // --- active model --------------------------------------------------------
  setActive(providerId, modelId) {
    this.data.active = { provider: providerId, model: modelId };
    const recent = this.data.recent.filter((r) => !(r.provider === providerId && r.model === modelId));
    recent.unshift({ provider: providerId, model: modelId, ts: Date.now() });
    this.data.recent = recent.slice(0, 12);
    this.save();
  }

  get settings() {
    return this.data.settings;
  }

  get hooks() {
    const h = this.data.hooks || {};
    return { preToolUse: h.preToolUse || [], postToolUse: h.postToolUse || [] };
  }

  setHooks(hooks) {
    this.data.hooks = { preToolUse: hooks?.preToolUse || [], postToolUse: hooks?.postToolUse || [] };
    this.save();
    return this.hooks;
  }

  get allowOutsideCwd() {
    return !!this.data.settings?.allowOutsideCwd;
  }

  // --- 子代理 / 团队开关（玩家手动开启，避免 AI 自己偷偷烧 token）-----------
  get subagentsEnabled() {
    return !!this.data.settings?.subagents;
  }

  get teamEnabled() {
    return !!this.data.settings?.team;
  }

  setSubagents(v) {
    this.data.settings.subagents = !!v;
    this.save();
    return this.data.settings.subagents;
  }

  setTeamEnabled(v) {
    this.data.settings.team = !!v;
    this.save();
    return this.data.settings.team;
  }

  setProgress(v) {
    this.data.settings.progress = !!v;
    this.save();
    return this.data.settings.progress;
  }

  setAllowOutside(v) {
    this.data.settings.allowOutsideCwd = !!v;
    this.save();
    return this.data.settings.allowOutsideCwd;
  }


  get active() {
    return this.data.active;
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  /** API key for a specific provider (active or not). */
  apiKeyFor(providerId) {
    const p = getProvider(providerId);
    const cred = this.data.providers?.[providerId] || {};
    if (cred.apiKey) return cred.apiKey;
    for (const env of p?.env || []) {
      if (process.env[env]) return process.env[env];
    }
    return '';
  }

  cacheModels(providerId, ids) {
    this.data.modelCache[providerId] = { ts: Date.now(), ids };
    this.save();
  }

  cachedModels(providerId) {
    return this.data.modelCache?.[providerId]?.ids || [];
  }
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base === 'object' && base && typeof extra === 'object' && extra) {
    const out = { ...base };
    for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
    return out;
  }
  return extra === undefined ? base : extra;
}

export function detectShell() {
  const custom = new Config().data.settings.shellPath;
  if (custom) return custom;
  if (process.platform === 'win32') {
    const candidates = [
      'D:/Program Files/Git/bin/bash.exe',
      'C:/Program Files/Git/bin/bash.exe',
      'C:/Program Files (x86)/Git/bin/bash.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe'),
    ];
    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c)) return c;
      } catch {}
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      for (const name of ['bash.exe', 'bash']) {
        const full = path.join(dir, name);
        try {
          if (fs.existsSync(full)) return full;
        } catch {}
      }
    }
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

export { PROVIDERS };
