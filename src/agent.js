// The agent loop: LLM ↔ tools, with billion-context auto-compaction.
import { streamChat, LLMError, estimateCost } from './llm.js';
import { ContextEngine, flattenNodes } from './context/engine.js';
import { toolSchemas, planBatches, runTool, allTools, enabledTools } from './tools/index.js';
import { getProvider, resolveModel } from './providers.js';
import { memoryPrompt, projectMemory } from './tools/todo.js';
import { skillsPrompt } from './tools/skill.js';
import { describeHooks } from './tools/hooks.js';
import { describeShell } from './tools/shell.js';

const MAX_RETRIES = 3;
// 续写提示：只让模型从断点接着说，避免重复或重新解释
const CONTINUE_PROMPT =
  '（上一条回复因单次输出长度上限被截断。请从中断处直接接着写，不要重复已写内容，不要重新开头，也不要解释。）';

export class Agent {
  constructor({ config, cwd = process.cwd(), session, role = '', tools = null, depth = 0 } = {}) {
    this.config = config;
    this.cwd = cwd;
    // 子代理用：role = 角色提示；tools = 受限工具集；depth = 嵌套层数（主代理 0）
    this.role = role;
    this.depth = depth;
    this.tools = Array.isArray(tools) && tools.length ? tools : null;
    // 进度回传：宿主注入一个 push({kind,text}) 之类的回调（TUI 用）
    this.eventSink = null;
    this.sessionId = session?.id || `s${Date.now().toString(36)}`;
    this.listeners = new Set();
    this.queued = [];
    this.abort = null;
    this.usageTotal = { input: 0, output: 0, cacheRead: 0, cost: 0, steps: 0 };
    const target = this.target();
    this.engine = new ContextEngine({ maxTokens: target.model?.ctx || 128000, compactAt: config.settings.compactAt });
    this.lastError = null;
    this.busy = false;
    // 交互提问回调：由宿主（TUI / --plain）注入，ask 工具靠它等玩家回答。
    this.askHandler = null;
  }

  setAskHandler(fn) {
    this.askHandler = typeof fn === 'function' ? fn : null;
  }

  /** 宿主注入的进度回调：子代理 / 团队工具用它把进度推到界面上。 */
  setEventSink(fn) {
    this.eventSink = typeof fn === 'function' ? fn : null;
  }

  /** 本轮可用工具（子代理用受限集；主代理按玩家开关过滤）。 */
  toolList() {
    return this.tools || enabledTools(this.config);
  }

  target() {
    const { provider: pid, model: mid } = this.config.active;
    const provider = getProvider(pid) || getProvider('deepseek');
    const model = resolveModel(pid, mid) || provider.models[0];
    return { provider, model, providerId: pid, modelId: model.id };
  }

  setActive(providerId, modelId) {
    this.config.setActive(providerId, modelId);
    const t = this.target();
    this.engine.maxTokens = t.model?.ctx || 128000;
    return t;
  }

  queue(text) {
    this.queued.push(text);
  }

  cancel() {
    this.abort?.abort();
  }

  setSession(session) {
    this.sessionId = session.id;
    this.engine = ContextEngine.deserialize(session.context, {
      maxTokens: this.target().model?.ctx || 128000,
      compactAt: this.config.settings.compactAt,
    });
  }

  systemPrompt() {
    const t = this.target();
    const mem = memoryPrompt() || '';
    const proj = projectMemory(this.cwd) || '';
    const skills = skillsPrompt(this.cwd) || '';
    const hookList = describeHooks(this.config.hooks);
    const hookBlock = hookList.length
      ? '\n\n# 已启用的 hooks（命中时自动执行）\n' +
        hookList
          .map((h) => '- ' + h.kind + ' ' + h.match + ': ' + h.command + (h.block && h.kind === 'preToolUse' ? '（可拦截）' : ''))
          .join('\n')
      : '';
    const memoryBlock = [mem ? `

# 长期记忆（memory 工具维护）
${mem}` : '', proj ? `

# 项目记忆（MEMORY.md）
${proj}` : '', skills ? `

# ${skills}` : ''].join('') + hookBlock;
    const st = this.config.settings || {};
    const caps = [];
    if (st.subagents) caps.push('subagent');
    if (st.team) caps.push('team');
    const subagentBlock = (caps.length
      ? `

# 子代理与团队（玩家已手动开启 · 会额外消耗 token）
工具: ${caps.join(' / ')}
` +
        (st.subagents
          ? '- `subagent`：把「边界清晰、能独立完成、而且会读一堆文件」的子任务丢给子代理（例：补测试、查报错根因、把 A 模块按 B 接口改造）。任务描述必须自包含：目标、相关路径、约束、验收标准。它在自己的上下文里干活，只把结论带回来，主对话更干净。\n'
          : '') +
        (st.team
          ? '- `team`：需要**并行**推进时用。先写清总目标，再给每个成员一个明确角色与只属于他的任务；成员共享同一个工作区，所以要按文件/目录拆开，避免互相覆盖。`team create` 立即返回、成员在后台跑，用 `team status` 看进度、`team wait` 等结果、`team report` 拿每人交代；成员进度能在浏览器团队面板实时看到。\n'
          : '') +
        '- 纪律：简单任务自己做更快，别硬拆；用了就说明哪个成员做了什么；成员交回来的东西要自己复核（读回文件 / 跑测试）再向玩家汇报。'
      : `
- 子代理（subagent）与团队协作（team）本程序里支持，但**当前未开启**（会额外消耗 token，只能由玩家手动开启：/subagents on、/team on）。玩家让你并行/分担时，先提醒他开启，不要假装用过。`);
    const p = t.provider;
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const os = process.platform === 'win32' ? 'Windows' : process.platform;
    const shellInfoBlock = (() => {
      try {
        const s = describeShell();
        return `\n${s.text}`;
      } catch {
        return '';
      }
    })();
    return `你是 agent，一个运行在用户终端里的 AI 编程助手（模型 ${p.name} / ${t.model.name}）。${this.role ? `\n\n# 你的角色\n${this.role}` : ''}

# 环境
- 日期: ${date}
- 操作系统: ${os} ${process.arch}
- 工作目录: ${this.cwd}
- 工作区: ${this.cwd}${this.config.allowOutsideCwd ? '（全权模式已开启：可读写工作区之外的文件）' : '（工作区模式：只能读写工作区内的文件，越界会被拒绝，需要用户 /trust 开启全权）'}
- 工具: ${this.toolList().map((t) => t.name).join(' / ')}${shellInfoBlock}

# 工作方式
1. 先理解再动手：不知道文件在哪先用 glob；不知道符号在哪用 grep；想看结构用 ls；再 read 精读。不要凭猜测编辑文件。复杂取舍先写 think。
   看截图/设计稿/报错图片时，直接用 read 读图片文件（png/jpg/gif/webp/bmp）——图片会附进对话，你能直接看到内容。
2. 改动要小而准确：修改已有文件优先用 edit（old_string 必须与文件内容逐字符一致，含缩进；多处相同请带上下文或用 edits 批量）；新建文件或多处大改写用 write。
3. 小步验证：改完代码后运行相关测试、构建或最小复现命令验证；失败时读报错、修正、重跑，不要空口宣称成功。
4. 绝不臆造：命令输出、文件内容、API 结果都必须来自真实工具返回。不确定就查（web_search / web_fetch）。
5. 危险操作（删除大量文件、git push --force、安装全局包）先说明理由；除非用户要求，不要提交 git。
6. 需要最新信息、库文档、报错原因时用 web_search，再用 web_fetch 读正文；引用了网页请在回答里给出链接。
7. 上下文很长时系统会自动压缩早期历史成 <compressed_history> 块。需要早前细节时用 context 工具: search → expand。
7.5 需要 JS 渲染的页面、或 web_fetch 拿到空白内容时，改用 browser（action=open 取正文，action=screenshot 看画面）。
7.6 如果系统提示里列出了相关技能，先用 skill load 读该技能再动手，按里面的步骤与约定执行。
7.7 拿不准用户想要什么时，别猜：用 ask 工具问（2-5 个具体选项；多个方案可同时选时设 multi=true）。典型场景：有多种合理改法、要动/删别人的文件、信息缺失（路径、库、风格）、改动范围不清楚。一次只问一件事，问完按玩家的选择继续；玩家自己输入的答案优先于选项。
7.8 要画图（图标、像素画、素材、贴图）且没有图像生成模型时，用 draw 工具：输出绘图 op，PNG 会直接附在工具结果里让你亲眼看见，然后反复 画→看→改。细节见 skill load draw。
8. 超过 3 步的活儿：开工前用 todo 工具把计划写成 3-8 条，做完一条就 update 状态，收尾时全部标 done。
9. 用户提到长期偏好/项目约定（语言、风格、命令、路径规则）时，用 memory set 记下来；下次会话会自动带上。
10. 插件系统：你可以用 plugin 工具给自己写插件（create 传入 JS 源码，default 导出 { name, description, tools: [...] }），运行时立即动态加载、reload 热更新、unload 卸载，无需重启本程序。插件工具会出现在你的可用工具列表中，直接像普通工具一样调用。需要新能力（如操作某软件）时优先考虑写成插件而不是重复写脚本。

# 回答风格
- 硬性要求：一律用简体中文回答（代码、命令、路径、专有名词保持原样），即使用户用其他语言提问也默认中文；只有用户明确要求换语言时才换。
- 简洁、直接、可执行。
- 不用空洞开场与总结套话；不重复用户已知的信息。
- 代码引用写成 \`path/file.js:12\`。改动后简短说明改了什么、验证了什么。
- 结尾可以给一句“下一步建议”，但不要长篇罗列。${memoryBlock}${subagentBlock}`;
  }

  ctx() {
    const t = this.target();
    return {
      cwd: this.cwd,
      engine: this.engine,
      apiKey: this.config.apiKeyFor(t.providerId),
      providerId: t.providerId,
      modelId: t.modelId,
      allowOutside: this.config.allowOutsideCwd,
      hooks: this.config.hooks,
      checkpoints: this.checkpoints,
      sessionId: this.session?.id || '',
      config: this.config,
      // 子代理：嵌套层数 + 允许的工具集（runTool 会拦越权调用）
      depth: this.depth || 0,
      allowedTools: this.tools ? new Set(this.tools.map((x) => x.name)) : null,
      // 子代理 / 团队工具把进度推到界面上
      emit: (item) => {
        try {
          this.eventSink?.(item);
        } catch {
          /* 界面出错不影响干活 */
        }
      },
      // 让工具能感知用户按了 ESC（长命令/爬网页/浏览器自动化能及时收尾）
      signal: this.abort?.signal,
      ask: this.askHandler ? (payload) => this.askHandler(payload) : null,
    };
  }

  /** Main loop. Async generator of UI events. */
  async *run(text, { signal } = {}) {
    const settings = this.config.settings;
    const t0 = this.target();
    this.engine.maxTokens = t0.model?.ctx || 128000;
    this.engine.compactAt = settings.compactAt;
    this.engine.addUser(text);
    this.busy = true;
    const controller = new AbortController();
    this.abort = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort);

    try {
      let cont = 0; // 输出被长度上限截断时的自动续写次数
      // maxSteps <= 0 / 未设置 / 非法值 => 不限步数（只在用户显式配了正数时才限制）
      const maxStepLimit = Number(settings.maxSteps);
      const stepLimit = Number.isFinite(maxStepLimit) && maxStepLimit > 0 ? Math.floor(maxStepLimit) : 0;
      for (let step = 1; !stepLimit || step <= stepLimit; step++) {
        if (controller.signal.aborted) {
          yield { type: 'aborted' };
          return;
        }
        if (this.engine.needsCompact()) {
          yield* this.compactInline(controller.signal);
        }
        const t = this.target();
        if (!this.config.hasKey(t.providerId)) {
          yield { type: 'need_key', provider: t.providerId };
          return;
        }
        yield { type: 'step', step };

        let content = '';
        let thinking = '';
        let signature;
        let toolCalls = [];
        let usage = null;
        let failed = null;
        let stopReason = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          content = '';
          thinking = '';
          signature = undefined;
          toolCalls = [];
          usage = null;
          failed = null;
          try {
            const stream = streamChat({
              provider: t.providerId,
              model: t.modelId,
              messages: this.engine.render(),
              systemPrompt: this.systemPrompt(),
              tools: toolSchemas(this.toolList(), { plugins: !this.tools }),
              apiKey: this.config.apiKeyFor(t.providerId),
              baseUrl: this.config.baseUrl(t.providerId),
              settings,
              maxTokens: settings.maxTokens,
              temperature: settings.temperature,
              signal: controller.signal,
            });
            for await (const ev of stream) {
              if (ev.type === 'text') {
                content += ev.text;
                yield { type: 'text', delta: ev.text };
              } else if (ev.type === 'reasoning') {
                thinking += ev.text;
                yield { type: 'reasoning', delta: ev.text };
              } else if (ev.type === 'tool_use') {
                toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
                yield { type: 'tool_call', id: ev.id, name: ev.name, input: ev.input };
              } else if (ev.type === 'thinking_signature') {
                signature = ev.signature;
              } else if (ev.type === 'usage') {
                usage = ev.usage;
              } else if (ev.type === 'stop') {
                stopReason = ev.reason;
              }
            }
          } catch (e) {
            failed = e;
            if (e.name === 'AbortError' || controller.signal.aborted) {
              yield { type: 'aborted' };
              return;
            }
            const retryable = e instanceof LLMError ? e.retryable : true;
            if (!retryable || attempt === MAX_RETRIES) break;
            const wait = 800 * 2 ** (attempt - 1);
            yield { type: 'retry', attempt, wait, message: e.message };
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          break;
        }

        if (failed) {
          this.lastError = failed;
          yield { type: 'error', message: failed.message, status: failed.status };
          return;
        }

        if (usage) {
          const cost = estimateCost(t.model, usage);
          this.usageTotal.input += usage.input || 0;
          this.usageTotal.output += usage.output || 0;
          this.usageTotal.cacheRead += usage.cacheRead || 0;
          this.usageTotal.cost += cost;
          this.usageTotal.steps = step;
          yield {
            type: 'usage',
            usage,
            cost,
            total: { ...this.usageTotal },
            context: this.engine.stats,
          };
        }

        this.engine.addAssistant({ content, reasoning: thinking, thinkingSignature: signature, toolCalls });
        yield { type: 'assistant_done', text: content, thinking, toolCalls };

        // 撞到单次输出上限：把已写部分留在上下文里，自动让模型接着写（最多 4 次）
        if (stopReason === 'length' && cont < 4) {
          cont++;
          this.engine.addUser(CONTINUE_PROMPT);
          yield { type: 'truncated', what: 'output', continuing: true, round: cont };
          continue;
        }
        if (stopReason === 'length') {
          yield { type: 'truncated', what: 'output', continuing: false };
        }

        if (!toolCalls.length) {
          yield { type: 'done', text: content };
          return;
        }

        const batches = planBatches(toolCalls);
        for (const batch of batches) {
          if (controller.signal.aborted) {
            yield { type: 'aborted' };
            return;
          }
          for (const call of batch.calls) yield { type: 'tool_start', id: call.id, name: call.name, input: call.input };
          const results = batch.readOnly
            ? await Promise.all(batch.calls.map((c) => runTool(c, this.ctx())))
            : [await runTool(batch.calls[0], this.ctx())];
          for (const r of results) {
            this.engine.addToolResult({
              toolCallId: r.id,
              name: r.name,
              content: r.content,
              isError: r.isError,
              meta: r.meta,
              images: r.meta?.images,
            });
            yield { type: 'tool_end', id: r.id, name: r.name, isError: r.isError, content: r.content, meta: r.meta, dur: r.dur };
          }
        }

        while (this.queued.length) {
          const q = this.queued.shift();
          this.engine.addUser(q);
          yield { type: 'steering', text: q };
        }
      }
      yield { type: 'max_steps' };
    } finally {
      this.busy = false;
      this.abort = null;
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** Fold the oldest slice of history; model-written summary when possible. */
  async *compactInline(signal) {
    const plan = this.engine.planFold();
    if (!plan) return;
    yield { type: 'compact_start', nodes: plan.nodes.length, tokens: plan.tokens };
    let summary = null;
    try {
      summary = await this.summarize(plan.nodes, signal);
    } catch {
      summary = null;
    }
    const topic = guessTopic(plan.nodes);
    const block = this.engine.fold(plan.start, plan.end, summary || this.engine.mechanicalSummary(plan.nodes), topic);
    yield { type: 'compact_end', block: block.id, topic, summary: block.summary, context: this.engine.stats };
  }

  async summarize(nodes, signal) {
    const t = this.target();
    const body = flattenNodes(nodes);
    const clipped = body.length > 90000 ? body.slice(0, 60000) + '\n…\n' + body.slice(-30000) : body;
    let out = '';
    const stream = streamChat({
      provider: t.providerId,
      model: t.modelId,
      systemPrompt:
        '你是上下文压缩器。把给定的 agent 对话历史压缩成一份高保真摘要，供模型在后续对话中继续工作使用。' +
        '要求：1) 保留用户的目标、约束、偏好；2) 保留已做出的决定与原因；3) 保留关键文件路径、函数名、命令、错误信息、结论（逐字保留代码/路径/数字）；' +
        '4) 记录已完成与未完成的步骤；5) 用紧凑的分点 Markdown 中文输出，不要寒暄，不要编造。',
      messages: [{ role: 'user', content: `请压缩以下历史（${nodes.length} 条记录）:\n\n${clipped}` }],
      tools: [],
      apiKey: this.config.apiKeyFor(t.providerId),
      baseUrl: this.config.baseUrl(t.providerId),
      settings: { ...this.config.settings, thinking: 'off' },
      maxTokens: 2400,
      signal,
    });
    for await (const ev of stream) {
      if (ev.type === 'text') out += ev.text;
      if (ev.type === 'usage') {
        this.usageTotal.input += ev.usage.input || 0;
        this.usageTotal.output += ev.usage.output || 0;
      }
    }
    if (!out.trim()) throw new Error('empty summary');
    return out.trim();
  }

  /** Session snapshot (for persistence / resume). */
  snapshot(firstUserText = '') {
    return {
      id: this.sessionId,
      title: firstUserText || this.title || '新会话',
      provider: this.config.active.provider,
      model: this.config.active.model,
      cwd: this.cwd,
      context: this.engine.serialize(),
      usage: this.usageTotal,
      updated: Date.now(),
    };
  }
}

function guessTopic(nodes) {
  const users = nodes.filter((n) => n.kind === 'message' && n.message.role === 'user').map((n) => String(n.message.content || ''));
  if (!users.length) return '历史片段';
  const last = users[users.length - 1].replace(/\s+/g, ' ').trim();
  return last.length > 40 ? last.slice(0, 40) + '…' : last;
}
