// The agent loop: LLM ↔ tools, with billion-context auto-compaction.
import { streamChat, LLMError, estimateCost } from './llm.js';
import { ContextEngine, flattenNodes } from './context/engine.js';
import { toolSchemas, planBatches, runTool, allTools, enabledTools } from './tools/index.js';
import { getProvider, resolveModel } from './providers.js';
import { memoryPrompt, projectMemory, readTodo, formatTodo } from './tools/todo.js';
import { skillsPrompt } from './tools/skill.js';
import { describeHooks } from './tools/hooks.js';
import { describeShell } from './tools/shell.js';

const MAX_RETRIES = 3;
// 续写提示：只让模型从断点接着说，避免重复或重新解释
const CONTINUE_PROMPT =
  '（上一条回复因单次输出长度上限被截断。请从中断处直接接着写，不要重复已写内容，不要重新开头，也不要解释。）';

export class Agent {
  constructor({ config, cwd = process.cwd(), session, role = '', tools = null, depth = 0, writeScope = null } = {}) {
    this.config = config;
    this.cwd = cwd;
    // 子代理用：role = 角色提示；tools = 受限工具集；depth = 嵌套层数（主代理 0）
    this.role = role;
    this.depth = depth;
    this.tools = Array.isArray(tools) && tools.length ? tools : null;
    // 团队成员用：只允许写自己负责的文件（fs 工具的 guardWrite 会真的拦下来）
    this.writeScope = Array.isArray(writeScope) && writeScope.length ? writeScope.map(String) : null;
    // 进度回传：宿主注入一个 push({kind,text}) 之类的回调（TUI 用）
    this.eventSink = null;
    this.sessionId = session?.id || `s${Date.now().toString(36)}`;
    this.listeners = new Set();
    this.queued = [];
    this.abort = null;
    this.usageTotal = { input: 0, output: 0, cacheRead: 0, cost: 0, steps: 0 };
    const target = this.target();
    this.engine = new ContextEngine({ maxTokens: target.model?.ctx || 128000, compactAt: config.settings.compactAt });
    this.applyEngineLimits(target);
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
    this.applyEngineLimits(t);
    return t;
  }

  /** 把窗口 / 压缩阈值 / 输出预留同步给上下文引擎。 */
  applyEngineLimits(t = this.target()) {
    const ctx = t.model?.ctx || 128000;
    this.engine.maxTokens = ctx;
    this.engine.compactAt = this.config.settings.compactAt;
    const out = Number(this.config.settings.maxTokens) || 0;
    // 输出预留：最多 20% 窗口，且不超过玩家配置的单次输出上限；至少 4k。
    // 这样输入永远不会把窗口塞死，模型总有地方把话说完。
    this.engine.reserveTokens = Math.min(out || 0, Math.max(4096, Math.floor(ctx * 0.2)));
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
    this.applyEngineLimits();
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
    // 工作记忆：待办 + 会话脉络。长对话被压缩后，模型靠这块不至于“忘掉前面”。
    const todo = readTodo(this.cwd);
    const todoText = todo.items.length ? formatTodo(todo) : '';
    const brief = this.engine.brief();
    const workBlock = todoText || brief
      ? `

# 工作记忆（系统自动维护，长对话防遗忘）
${todoText ? `## 当前待办（用 todo 工具更新）\n${todoText}\n` : ''}${brief ? `## 会话脉络（最近的请求与压缩块）\n${brief}\n` : ''}旧细节被压缩后，先用 context 工具 search，再 expand；不要凭印象编造。`
      : '';
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
          ? '- `subagent`：把「边界清晰、能独立完成、而且会读一堆文件」的子任务丢给子代理（例：补测试、查报错根因、把 A 模块按 B 接口改造）。任务描述必须自包含：目标、相关路径、约束、验收标准。它在自己的上下文里干活，只把结论带回来，主对话更干净。\n' +
            '  · **一定要填 `verify`（验收命令）**：它交完活我会亲手跑一遍，失败就自动给它一轮修正，返回值末尾会附一段「核实账」（改了哪些文件、验收跑没跑过、卡在哪）。不填的话它说「测过了」你也无法证伪。\n'
          : '') +
        (st.team
          ? '- `team`：需要**并行**推进时用。先写清总目标，再给每个成员一个明确角色与只属于他的任务；成员共享同一个工作区，所以要按文件/目录拆开，避免互相覆盖。\n' +
            '  · **create 时必须填 briefing**：把你这轮已经查清的事实（项目结构、关键文件 path:line、接口约定、构建/测试命令、已知坑）写成要点，成员拿它当已知条件用，才不会各自把项目从零读一遍（那是团队最大的浪费）。\n' +
            '  · **有先后关系的活用 `depends` 排出依赖**：成员里写 `depends:["接口定稿"]`，他就会等那个人完工再起跑，并自动拿到那人的产出当已知条件。像「先定接口再实现」「先改 schema 再写查询」这类活**必须**这么拆——否则两人同时摸同一个接口，一定打架。互相不依赖的才能真并行。\n' +
            '  · **一定要填全队 `verify`（验收命令）**：各成员自己的 verify 只验他自己那块；两个人都自测通过、合起来炸（接口不匹配、公共逻辑冲突）只能靠这道全队验收发现，跑完会把失败输出交给你。\n' +
            '  · 可以用 `budget` 给个成本上限（美元），超出就自动停发新活。成员卡住（反复读同一个文件 / 工具连续失败）时会自动提醒一次，这个不用你管。\n' +
            '  · `team create` 立即返回、成员在后台并行跑。**返回后不要 team wait 干等**——立刻去做你手上属于队长的那部分（集成、公共文件、验证脚本、文档），或先跑构建/测试。\n' +
            '  · 看进度用 `team status`（秒回），要汇总用 `team report`（含核实账：改动 / 卡住 / 风险 / 验收 + 全队验收结果）；只有你确实无事可做时才 `team wait`，并给短超时（60-180s）。\n'
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
   要用 edit 反复碰壁时（old_string 不唯一、缩进对不上、分散在多处的改动），改用 **patch** 工具喂 unified diff：一次可以改多个文件多个位置，而且要么全成要么全不动。
3. 小步验证：改完代码后运行相关测试、构建或最小复现命令验证；失败时读报错、修正、重跑，不要空口宣称成功。
   改完一批文件先用 **diagnostics** 跑一遍静态检查（自动挑 tsc/eslint/go vet/ruff/cargo），它直接告诉你「文件:行:列 什么错」，比肉眼看几百行 stdout 靠谱；要跑测试用 shell。
4. 绝不臆造：命令输出、文件内容、API 结果都必须来自真实工具返回。不确定就查（web_search / web_fetch）。
   长命令别硬卡：起 dev server、watch 模式、十几分钟的构建，用 shell 的 background=true，拿到 jobId 后先干别的，回头用 jobs 的 tail 看输出；收工前记得 jobs kill，否则下一条前台命令会排队等它。
5. 危险操作（删除大量文件、git push --force、安装全局包）先说明理由；除非用户要求，不要提交 git。
6. 需要最新信息、库文档、报错原因时用 web_search，再用 web_fetch 读正文；引用了网页请在回答里给出链接。
7. 上下文很长时系统会自动压缩早期历史成 <compressed_history> 块。需要早前细节时用 context 工具: search → expand。
7.5 web_fetch 拿到空白页（页面靠 JS 渲染）时，改用 http_request 直接打它后端接口；实在拿不到就让玩家自己贴内容，不要臆造。
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
- 结尾可以给一句“下一步建议”，但不要长篇罗列。
- 先给结论/正在做什么（一两句），再给细节；中途不要重复已经说过的内容。
- 长任务每完成一步就用 todo update 标记；发现新的长期偏好/约束立刻 memory set，不要等玩家提醒。${memoryBlock}${workBlock}${subagentBlock}`;
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
      // 团队成员的文件范围（fs 工具写保护用）
      writeScope: this.writeScope,
      // 子代理 / 团队工具把进度推到界面上
      emit: (item) => {
        try {
          this.eventSink?.(item);
        } catch {
          /* 界面出错不影响干活 */
        }
      },
      // 让工具能感知用户按了 ESC（长命令/爬网页能及时收尾）
      signal: this.abort?.signal,
      ask: this.askHandler ? (payload) => this.askHandler(payload) : null,
    };
  }

  /** Main loop. Async generator of UI events. */
  async *run(text, { signal } = {}) {
    const settings = this.config.settings;
    const t0 = this.target();
    this.applyEngineLimits(t0);
    this.engine.addUser(text);
    this.busy = true;
    // 玩家的话已经进上下文了：先通知宿主落盘，中途崩溃 / 断电也不会丢这一轮
    yield { type: 'turn_start' };
    const controller = new AbortController();
    this.abort = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort);

    try {
      let cont = 0; // 输出被长度上限截断时的自动续写次数
      let ctxRetries = 0; // 服务端报“上下文超长”时强制压缩重试的次数
      // maxSteps <= 0 / 未设置 / 非法值 => 不限步数（只在用户显式配了正数时才限制）
      const maxStepLimit = Number(settings.maxSteps);
      const stepLimit = Number.isFinite(maxStepLimit) && maxStepLimit > 0 ? Math.floor(maxStepLimit) : 0;
      for (let step = 1; !stepLimit || step <= stepLimit; step++) {
        if (controller.signal.aborted) {
          yield { type: 'aborted' };
          return;
        }
        if (this.engine.needsCompact()) {
          yield* this.compactUntil(controller.signal);
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
            // 服务端说“上下文太长/超过窗口”：不是普通错误，压缩后重来，别直接停下。
            if (ctxRetries < 2 && isContextOverflow(e)) {
              ctxRetries++;
              yield { type: 'retry', attempt, wait: 0, message: '上下文超出模型窗口，正在强制压缩历史后重试…', context_overflow: true };
              yield* this.compactUntil(controller.signal, { force: true });
              attempt = Math.max(1, attempt - 1); // 这次不算普通失败次数
              continue;
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
  async *compactInline(signal, { tail = null } = {}) {
    const plan = tail == null ? this.engine.planFold() : this.engine.planFold({ tail });
    if (!plan) return false;
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
    return true;
  }

  /**
   * 一次把上下文压到阈值以下：正常从 tail=8 开始，不够就折得更狠（4/2/1）。
   * force=true 时不看 needsCompact（服务端已经报超长），必须动手。
   */
  async *compactUntil(signal, { force = false } = {}) {
    const tails = [this.engine.tail, 4, 2, 1];
    let did = false;
    for (const tail of tails) {
      for (let guard = 0; guard < 4; guard++) {
        if (!force && !this.engine.needsCompact()) return;
        const before = this.engine.wireTokens();
        const ok = yield* this.compactInline(signal, { tail });
        if (!ok) break;
        did = true;
        force = false;
        if (this.engine.wireTokens() >= before) break; // 没缩小就换更狠的策略
      }
    }
    if (this.engine.critical()) {
      // 最后一道保险：老图片最贵，只留最近两张；再不行渲染层会压缩工具输出。
      const dropped = this.engine.trimImages(2);
      if (dropped) yield { type: 'note', text: `上下文仍偏紧，已省略 ${dropped} 张旧图片（需要时可重新 read）` };
    }
    if (!did && force) {
      // 已经没有可折的中间段了：至少把渲染预算压到最低，避免硬撞服务端上限。
      this.engine.toolResultBudget = 1400;
    }
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

/** 服务端的“上下文超长”类错误：这类错误要用压缩解决，而不是重试等待。 */
export function isContextOverflow(e) {
  if (!e) return false;
  const s = `${e.message || ''} ${e.body || ''} ${e.code || ''}`.toLowerCase();
  if (/context[_ ]length|maximum context|context window|prompt is too long|too many tokens|reduce the length|token limit|input is too long/.test(s)) return true;
  // 有些兼容层只返回 400 + “tokens”，且能确定是输入过长
  return (e.status === 400 || e.status === 413) && /(token|context|length|too long|exceed)/.test(s);
}
