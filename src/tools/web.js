// web-access: search + fetch with multiple backends and an HTML→Markdown reader.
import { fmtBytes } from '../util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cache = new Map();
const CACHE_TTL = 5 * 60_000;

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.value);
  return fn().then((value) => {
    cache.set(key, { ts: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  });
}

async function httpFetch(url, { timeout = 20000, headers = {}, method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ok: res.ok, headers: res.headers, text: buf.toString('utf8'), bytes: buf.length, url: res.url };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- html → md
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', laquo: '«',
  raquo: '»', euro: '€', pound: '£', yen: '¥', rarr: '→', larr: '←', uarr: '↑', darr: '↓', '#39': "'",
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp < 0x110000) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    const v = ENTITIES[e.toLowerCase()];
    if (v !== undefined) return v;
    if (e.toLowerCase() === 'nbsp') return ' ';
    return m;
  });
}

function tidyText(s) {
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToMarkdown(html, baseUrl = '') {
  let title = '';
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (tm) title = decodeEntities(tm[1]).trim();

  let h = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|canvas|template|iframe|form|nav|footer|aside|button)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|hr)\s*\/?>/gi, (m) => (m.toLowerCase().includes('br') ? '\n' : '\n\n---\n\n'));

  // prefer main content region
  const main =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(h) ||
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(h) ||
    /<div[^>]+(?:id|class)="[^"]*(?:content|article|post|markdown|doc)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*$/i.exec(h) ||
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(h);
  h = main ? main[1] : h;

  // code blocks first (protect whitespace)
  const codeBlocks = [];
  h = h.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => {
    const langM = /(?:class|data-language|lang)="[^"]*?(?:language-|lang-)([\w+#.-]+)/i.exec(m);
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
    codeBlocks.push('```' + (langM ? langM[1] : '') + '\n' + text + '\n```');
    return `\n\n@@CODE${codeBlocks.length - 1}@@\n\n`;
  });
  const inlineCodes = [];
  h = h.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, inner) => {
    inlineCodes.push(decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' '));
    return `@@IC${inlineCodes.length - 1}@@`;
  });

  h = h
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${strip(inner)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, inner) => `\n- ${strip(inner).trim()}`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inner) =>
      '\n\n' + strip(inner).split('\n').map((l) => `> ${l}`).join('\n') + '\n\n')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const t = strip(inner).trim();
      if (!t) return '';
      const abs = absUrl(href, baseUrl);
      return abs && !abs.startsWith('javascript') && t !== abs ? `[${t}](${abs})` : t;
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, inner) => `**${strip(inner).trim()}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, inner) => `*${strip(inner).trim()}*`)
    .replace(/<img[^>]+alt="([^"]*)"[^>]*>/gi, (m, alt) => (alt ? `![${alt}]` : ''))
    .replace(/<img[^>]*>/gi, '')
    .replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<\/tr>/gi, ' |\n')
    .replace(/<hr[^>]*>/gi, '\n\n---\n\n')
    .replace(/<(p|div|section|article|main|header|tr|table|figure)[^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|section|article|main|header|figure|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  h = decodeEntities(h);
  h = h.replace(/@@CODE(\d+)@@/g, (m, i) => '\n\n' + codeBlocks[Number(i)] + '\n\n');
  h = h.replace(/@@IC(\d+)@@/g, (m, i) => '`' + inlineCodes[Number(i)] + '`');
  h = tidyText(h);
  return { title, markdown: h };
}

function strip(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ');
}

function absUrl(href, base) {
  try {
    return new URL(href, base || 'https://example.com').href;
  } catch {
    return href;
  }
}

// ------------------------------------------------------------------ search
async function searchDeepSeek(query, count, apiKey) {
  const r = await httpFetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, count, need_content: false }),
    timeout: 25000,
  });
  if (!r.ok) throw new Error(`deepseek search HTTP ${r.status}`);
  const j = JSON.parse(r.text);
  return (j.results || []).map((x) => ({
    title: x.title,
    url: x.url,
    snippet: x.summary || x.snippet || '',
    date: x.date,
    source: x.site_name,
  }));
}

async function searchTavily(query, count, apiKey) {
  const r = await httpFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: count, include_answer: false, search_depth: 'advanced' }),
  });
  if (!r.ok) throw new Error(`tavily HTTP ${r.status}`);
  const j = JSON.parse(r.text);
  return (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '', source: 'tavily' }));
}

async function searchBrave(query, count, apiKey) {
  const r = await httpFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { 'x-subscription-token': apiKey, accept: 'application/json' } },
  );
  if (!r.ok) throw new Error(`brave HTTP ${r.status}`);
  const j = JSON.parse(r.text);
  return (j.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: strip(x.description || ''), source: 'brave' }));
}

async function searchExa(query, count, apiKey) {
  const r = await httpFetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: 600 } } }),
  });
  if (!r.ok) throw new Error(`exa HTTP ${r.status}`);
  const j = JSON.parse(r.text);
  return (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: (x.text || '').slice(0, 500), source: 'exa' }));
}

async function searchSearxng(query, count, base) {
  const r = await httpFetch(`${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`searxng HTTP ${r.status}`);
  const j = JSON.parse(r.text);
  return (j.results || []).slice(0, count).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '', source: 'searxng' }));
}

async function searchDuckDuckGo(query, count) {
  const r = await httpFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://html.duckduckgo.com/' },
    body: `q=${encodeURIComponent(query)}&kl=wt-wt`,
  });
  if (!r.ok || !r.text.includes('result__a')) throw new Error(`ddg HTTP ${r.status}`);
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(r.text)) && out.length < count) {
    let url = decodeEntities(m[1]);
    const u = /uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]);
    out.push({ title: strip(m[2]), url, snippet: m[3] ? strip(m[3]) : '', source: 'duckduckgo' });
  }
  if (!out.length) throw new Error('ddg 无结果');
  return out;
}

async function searchBing(query, count) {
  const r = await httpFetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, {});
  if (!r.ok) throw new Error(`bing HTTP ${r.status}`);
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(r.text)) && out.length < count) {
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3]);
    out.push({ title: strip(m[2]), url: decodeEntities(m[1]), snippet: snip ? strip(snip[1]) : '', source: 'bing' });
  }
  if (!out.length) throw new Error('bing 无结果');
  return out;
}

export async function webSearch({ query, count = 6, apiKey, providerId, env = process.env }) {
  if (!query || !String(query).trim()) throw new Error('缺少 query');
  count = Math.max(1, Math.min(20, Number(count) || 6));
  const attempts = [];
  const add = (name, fn) => attempts.push({ name, fn });

  if (env.TAVILY_API_KEY) add('tavily', () => searchTavily(query, count, env.TAVILY_API_KEY));
  if (env.BRAVE_API_KEY) add('brave', () => searchBrave(query, count, env.BRAVE_API_KEY));
  if (env.EXA_API_KEY) add('exa', () => searchExa(query, count, env.EXA_API_KEY));
  if (apiKey && providerId === 'deepseek') add('deepseek', () => searchDeepSeek(query, count, apiKey));
  if (env.DEEPSEEK_API_KEY) add('deepseek', () => searchDeepSeek(query, count, env.DEEPSEEK_API_KEY));
  if (env.SEARXNG_URL) add('searxng', () => searchSearxng(query, count, env.SEARXNG_URL));
  add('duckduckgo', () => searchDuckDuckGo(query, count));
  add('bing', () => searchBing(query, count));

  const errors = [];
  for (const a of attempts) {
    try {
      const results = await a.fn();
      if (results?.length) return { results, engine: a.name, errors };
    } catch (e) {
      errors.push(`${a.name}: ${e.message}`);
    }
  }
  throw new Error(`所有搜索后端均失败:\n${errors.join('\n')}`);
}

// ------------------------------------------------------------------- fetch
export async function webFetch({ url, maxChars = 24000, apiKey, providerId, env = process.env }) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('url 必须以 http(s):// 开头');
  return cached(`fetch:${url}:${maxChars}`, async () => {
    let r;
    try {
      r = await httpFetch(url, { timeout: 25000 });
    } catch (e) {
      r = { status: 0, ok: false, text: '', bytes: 0, headers: new Map(), error: e.message };
    }
    const ct = (r.headers?.get?.('content-type') || '').toLowerCase();
    let title = '';
    let content = '';
    let kind = 'text';
    if (r.ok && /json/.test(ct)) {
      kind = 'json';
      try {
        content = JSON.stringify(JSON.parse(r.text), null, 2);
      } catch {
        content = r.text;
      }
    } else if (r.ok && (/html|xml/.test(ct) || /^\s*<(!doctype|html)/i.test(r.text))) {
      const md = htmlToMarkdown(r.text, url);
      title = md.title;
      content = md.markdown;
      kind = 'html';
      if (content.length < 200) {
        // probably JS-rendered or blocked → try vendor reader
        const alt = await vendorFetch(url, { apiKey, providerId, env });
        if (alt && alt.length > content.length) {
          content = alt;
          kind = 'html+reader';
        }
      }
    } else if (r.ok) {
      content = r.text;
    }

    if (!content || content.length < 80) {
      const alt = await vendorFetch(url, { apiKey, providerId, env });
      if (alt && alt.length > (content?.length || 0)) {
        content = alt;
        kind = 'reader';
      }
    }
    if (!content) {
      throw new Error(`抓取失败 HTTP ${r.status || 'network'} ${r.error || ''} ${url}`);
    }
    const truncated = content.length > maxChars;
    return {
      url,
      title,
      kind,
      status: r.status,
      bytes: r.bytes,
      content: truncated ? content.slice(0, maxChars) + '\n\n…(内容已截断)' : content,
      truncated,
      totalChars: content.length,
    };
  });
}

async function vendorFetch(url, { apiKey, providerId, env }) {
  const key = providerId === 'deepseek' && apiKey ? apiKey : env.DEEPSEEK_API_KEY;
  const runners = [];
  if (key) {
    runners.push(async () => {
      const r = await httpFetch('https://api.deepseek.com/v1/tools/fetch', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        timeout: 30000,
      });
      if (!r.ok) return null;
      const j = JSON.parse(r.text);
      return j.content || null;
    });
  }
  if (env.TAVILY_API_KEY) {
    runners.push(async () => {
      const r = await httpFetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TAVILY_API_KEY}` },
        body: JSON.stringify({ urls: [url] }),
      });
      if (!r.ok) return null;
      const j = JSON.parse(r.text);
      return j.results?.[0]?.raw_content || null;
    });
  }
  for (const run of runners) {
    try {
      const c = await run();
      if (c && c.length > 200) return c;
    } catch {}
  }
  return null;
}

// -------------------------------------------------------------------- tools
export const webSearchTool = {
  name: 'web_search',
  label: 'WebSearch',
  readOnly: true,
  description:
    '联网搜索（返回标题/链接/摘要）。支持 site: 等运算符。用于获取最新信息、文档、报错解决方案。' +
    '拿到结果后建议对关键链接调用 web_fetch 读取正文。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（可含 site: 等运算符）' },
      count: { type: 'number', description: '返回结果数量，默认 6，最多 20' },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const { results, engine, errors } = await webSearch({
      query: input.query,
      count: input.count,
      apiKey: ctx.apiKey,
      providerId: ctx.providerId,
    });
    const lines = results.map((r, i) => {
      const meta = [r.source, r.date?.slice(0, 10)].filter(Boolean).join(' · ');
      return `${i + 1}. ${r.title}\n   ${r.url}${meta ? `\n   ${meta}` : ''}\n   ${(r.snippet || '').replace(/\s+/g, ' ').slice(0, 400)}`;
    });
    return {
      content: `搜索: ${input.query}  (engine: ${engine})\n\n${lines.join('\n\n')}${errors.length ? `\n\n[部分后端失败: ${errors.join('; ')}]` : ''}`,
      meta: { kind: 'search', query: input.query, engine, count: results.length, results },
    };
  },
};

export const webFetchTool = {
  name: 'web_fetch',
  label: 'WebFetch',
  readOnly: true,
  description:
    '抓取网页并转换为 Markdown 正文（自动去导航/脚本）。用于阅读文档、issue、博客。支持按行数截断。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 URL' },
      maxChars: { type: 'number', description: '最多返回字符数，默认 24000' },
    },
    required: ['url'],
  },
  async execute(input, ctx) {
    const r = await webFetch({
      url: input.url,
      maxChars: Math.max(1000, Math.min(120000, Number(input.maxChars) || 24000)),
      apiKey: ctx.apiKey,
      providerId: ctx.providerId,
    });
    const head = `# ${r.title || r.url}\nURL: ${r.url}\n(${r.kind}, HTTP ${r.status}, ${fmtBytes(r.bytes)}, ${r.totalChars} 字符${r.truncated ? ', 已截断' : ''})\n\n`;
    return {
      content: head + r.content,
      meta: { kind: 'fetch', url: r.url, title: r.title, chars: r.totalChars, truncated: r.truncated, body: r.content },
    };
  },
};
