# DSH 上下文管理系统设计文档

异步 Compartment 压缩 + project_memory 记忆系统。整体思路受 OpenCode Magic Context 启发，但基于 DSH/Cordis API 独立实现，不是其源码或行为的一比一移植。它替换内置的同步摘要压缩（`dsh-compaction-basic`），作为一个自定义 `CompactionEngine` 插件挂载在 agent preset 中。

## 1. 目标

1. **压缩异步化**：摘要生成不阻塞 agent loop；阈值到达时落地只是投影替换（秒级）。
2. **细粒度、可召回**：压缩产物按 Compartment 切分，原始信息永远可从会话日志召回。
3. **长期记忆**：`<project_memory>` 记忆库，在同一 workspace scope 内跨会话/跨压缩保留重要事实；`PREFERENCES` 可跨 workspace。

## 2. 架构总览

```
                    ┌────────────────────────────────────────────────┐
                    │            dsh-magic-context                  │
                    │  (agent preset: context-compact)               │
                    │                                                │
  agent loop ──────►│  [引擎] CompartmentEngine 子类                  │
                    │    ├ 65% 触发后台整理者（摘要+提memory）         │
                    │    ├ 80% 落地事务（compaction/* 事件契约）       │
                    │    └ ctx_reduce 跳过段落                        │
                    │                                                │
  请求组装 ────────►│  [注入层] 段落号 §N§ + <project_memory> 块        │
   (deriveMessages)│   (视图层包装, 不进 session 日志)                 │
                    │                                                │
  工具调用 ────────►│  [工具] ctx_reduce / ctx_expand / memory       │
                    │                                                │
                    └───────────────┬────────────────────────────────┘
                                    │
                    ┌───────────────▼────────────────────────────────┐
                    │  SQLite (node:sqlite + allowExtension)          │
                    │  memories / memories_fts / memories_vec(vec0)   │
                    │  paragraphs / skip_marks / compartments         │
                    └────────────────────────────────────────────────┘
```

## 3. 子系统 A：异步 Compartment 压缩

### 3.1 触发与生命周期

```
surface 增长
   │
   ├─ 65%（生成阈值）: step/end 或 turn/end 时检查 tokenMeter，
   │     totalTokens ≥ 0.65 × contextWindow 且当前无 in-flight 生成
   │     → 后台启动整理者（不阻塞回合）
   │
   ├─ 整理者: 对 [最后一个 checkpoint 之后 … 最近 N 个段落之前] 的段落
   │     ① 生成 Compartment 摘要（排除 Skip 段落）
   │     ② 提取重要事实 → 写入 session_facts（status=pending，
   │        是否提升为正式记忆由 Dreamer 决定，见 §4.7）
   │     → compartments 表 status=ready，可 append log-only 事件
   │
   └─ 80%（落地阈值）: agent/pre-step 检查（继承自 basic 的钩子）
         → compactIfNeeded → 选段 = 就绪 Compartment 的固化范围
         → compactRegion 事务 → summarize() 返回预存摘要
```

Compartment 状态机：`generating → ready → landed`；`generating → failed`（可重试）。

- **覆盖范围固化**：Compartment 在 65% 生成时刻确定 `start_seq..end_seq`（保留最近 N 个有 paragraph number 的 model-visible 消息，并在 tool pairing 安全边界截断）。落地时替换**就是**这个固化范围，绝不外扩。
- **保留尾**：生成时刻的最近 N 个段落 + 生成之后所有新增内容，全部原文保留。
- **链式多代**：每代 checkpoint 节点永久留在 surface：`[C1][C2]…[Ck] + 原文尾`。下一代只摘要上一代落地点之后的新内容，**不对旧 checkpoint 二次摘要**（避免信息损失）。后续单独设计"重整"机制（数据库按代次/覆盖 seqs/段落号区间建立索引，为重整预留）。
- **落地后**：若 surface 仍高于 65%（极端保留尾过大），立即进入下一代生成循环，自洽无需特殊处理。
- **Dreamer 归档**：旧 checkpoint 节点由 Dreamer 标记、代码逻辑真实归档（§4.7），归档会从 surface 移除 checkpoint 节点并更新预算——这是落地之外唯一允许的 surface 变更。

### 3.1.1 整理者输入与 flat XML 摘要

当前版本暂不实现 Magic Context 的 P1-P4 衰减层，而是先采用一份结构化 flat XML 摘要。每次整理的当前 raw conversation 是唯一事实来源；整理者另外收到两个有界参考块：

1. `<project_memory>`：当前 Git worktree scope 可见的 project memories（包含全局 `PREFERENCES`），用于去重、命名和识别长期约束。
2. `<session_references>`：同一 session 最近最多 6 个未归档 Compartment，用于判断当前工作是否延续旧目标。参考摘要不是本次覆盖范围，也不能覆盖当前 raw evidence。

整理者输出一个 XML `<output>`，包含一个 flat `<compartment>` 和 `<facts>`：

```xml
<output>
  <compartments>
    <compartment title="..." episode_type="feature">
      <objective>...</objective>
      <continuity>...</continuity>
      <work_completed><item>...</item></work_completed>
      <decisions><decision>...</decision></decisions>
      <current_state><item>...</item></current_state>
      <verification><check status="passed">...</check></verification>
      <open_items><none/></open_items>
      <user_constraints><constraint>...</constraint></user_constraints>
      <anchors><file>...</file><commit>...</commit></anchors>
    </compartment>
  </compartments>
  <facts><fact importance="8">...</fact></facts>
</output>
```

固定区段让摘要同时保留工作目标、连续性、结果、决策、当前状态、验证结果、未完成项、用户纠正和可搜索锚点。`<facts>` 仍然先进入 `session_facts`，由 Dreamer 决定是否提升为正式 memory。当前落地协议仍将整个 `<compartment>` XML 作为一份 flat summary 存储；未来可以在不改变输入参考模型的情况下增加 `p1`-`p4`。

落地前会先进行 XML token/标签栈校验和 schema 校验，包括根节点、区段顺序、必填节点、属性枚举、fact importance 和 XML 转义。校验失败时，Organizer 会收到带有具体路径和错误原因的 `<validation_errors>`，并最多重新生成一次。修复仍失败时 Compartment 标记为 `failed`，不会写入无效 summary 或 session fact。

### 3.2 段落号系统（§N§）

- **分配**：每个 model-visible 消息（user 输出 / assistant 输出 / tool 结果）首次进入主请求组装时，从 `paragraphs` 表分配全局递增号（按 session 绑定，持久化，永不复用）。
- **注入**：`deriveMessages()` 包装层，对每个消息第一个 text block 加 `§N§ ` 前缀。纯视图层，**不写入 session 日志**。
- **排除规则**（不分配号）：
  - 辅助 LLM 调用（摘要、标题等）——它们不走 `deriveMessages`，天然排除（实现时验证所有调用点）。
  - `ctx_reduce` / `ctx_expand` 工具调用自身：assistant 节点若含对应 tool-call 跳过；对应的 tool/result 通过 callId 回溯 `tool/call` 的 name 判断跳过。
- **失效**：落地后 checkpoint 节点占一个新号；旧号保留在库中但不可见。`ctx_reduce` 对不可见号返回 `rejected`，不写入 `skip_marks`；`ctx_expand` 仍可从 session log 回查旧号。
- **系统提示词**（注册 systemPrompt 段）：说明 §N§ 格式、编号单调递增、落地后旧号行为、ctx_reduce 和 ctx_expand 用法。
- **token 计量偏差**：tokenMeter 计价不含 §N§ 前缀（每消息约 +5~15 token），阈值判定偏差可接受；如需精确可在配置中加 offset。

### 3.2.1 Composer 占用明细

输入框下方的 Context Compact 行只统计当前 model-visible window 中真实存在的内容：

- `Compartments`：当前 surface 中实际存在的 Compartment checkpoint 节点及其 token-meter token。
- `Memories`：session 开始或 Compartment 落地后注入的 memory block；它是常驻请求前缀，因此一经选中就持续计入，直到下一次重选替换它。`ctx_memory` 后续检索不计入。
- generating、ready、archived、已从 surface 移除的 Compartment 都显示为不占用；没有可注入 memory 时 `Memories` 为 0。

### 3.2.2 原生 ContextMeter 面板中的两行

发送按钮旁的圆环面板（宿主 `ContextMeter`）只展示启发式的 `contextBreakdown`：`系统提示词` / `工具` / `对话消息`。这个组成对本插件有两处盲区：

- **Memories 完全缺失**：`contextBreakdown` 的消息数字重放 `surface-fold`，按单个 **surface 事件**计价（`deriveEventMessage`）。而 `<project_memory>` 前缀是 `deriveMessages()` 包装层注入的 head，不是 surface 事件，因此从不计入。它却真实随每次请求发送，也被 provider 锚定的 `projectedTokens` 计入。
- **Compartments 被折叠**：checkpoint 本身就是 surface 上的 `user/message`，已经包含在 `对话消息` 里。

因此 `lib/client.js` 向该面板补两行：`项目记忆`（独立项）和 `↳ Compartment`（标为 `对话消息` 的小计，避免读者把行相加）。两行只进图例，**不加进色条**——色条按 `breakdownTotal` 归一，塞入不在该分母里的数字会歪曲比例。

实现约束（`tests/dsh-context-meter-rows-smoke.mjs` 锁定）：

- 宿主把 `ContextMeter` 内联渲染，面板内部**没有 slot**，所以两行靠 DOM 注入。**不得**修改已安装的 `@deepseek-ai/dsh-client-ui-conversation` bundle：那是部署产物，升级即丢，且曾因此把 endpoint 卡在废弃的 `/context/usage` 上而静默失效。
- 选择器只匹配 CSS Module 类名**后缀**（`_panel`、`_rows`、`_row`、`_swatch`）。哈希前缀每次上游构建都会变，后缀不变。
- 行从一条活的原生行 `cloneNode` 而来，样式/间距/主题变量全部继承；Memories 的色块靠内联 `--meter-tint` 取得独立颜色。
- `↳ Compartment` 作为小计**不带色块**——它的 token 已计入 `对话消息` 的颜色，再给一个色块会暗示它是独立分段。行级 `padding-left: 28px` 兼顾两件事：补偿被去掉的色块占位（8px 宽 + 6px `margin-right`），再加 14px 层级缩进，使标签正好比父行标签右移一档。宿主行是 `display:flex` + `justify-content:space-between`，左侧 padding 只推动标签一侧，右侧数值仍右对齐。
- 组件挂在 `conversation.input.right`（`scope: "session"`）上，只为借用 session 域的生命周期与 `sessionId`；它自身渲染 `null`。轮询仅在面板打开时进行，卸载时移除自己注入的行。

> 客户端半边的注册条件：`dsh-client-modules` 用 `require.resolve(\`${entryName}/package.json\`)` 解析 loader 条目名，因此只有名字**恰为包名**的条目才会注册 client bundle。`dsh-magic-context/settings`、`/notice` 这类子路径条目会以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 静默跳过。裸名条目由 agent preset（`agent.cordis.yml`）提供，所以面板两行在首个 context-compact agent 加载后才出现，而不是进程启动时。

### 3.3 落地事务（事件契约，与内置一致）

`compaction/start`（锁）→ `compaction/summary`（含代次、覆盖范围、shadowedSeqs、摘要）→ `user/message`（`surfaceOp:{op:"replace",start,end}` + `compactCheckpointSource(compactionId)` + `sourceEventSeqs`）→ `compaction/end`。复用 `BasicCompactionEngine` 的事务、稳定性断言、`/compact`（`compactNow` → `runMaintenance`）。

### 3.4 ctx_reduce / ctx_expand 工具

- `ctx_reduce` schema：`{paragraphs: string}`，格式 `"1-2,5,11-12"`。
- `ctx_reduce` handler：解析区间 → 校验在可见范围内 → 写入 `skip_marks`（seq + paragraph_no）→ 返回标记结果。
- `ctx_expand` schema：`{paragraph: number}`，传入一个段落号。
- `ctx_expand` handler：通过 `paragraphs(session_id, paragraph_no) -> seq` 回查 session log，返回原始 role 和 content；不要求段落仍在当前 surface，因此可恢复已被 checkpoint 替换的历史内容。
- 生效：整理者生成摘要时从输入中过滤 Skip 段落。
- 召回：Skip 只影响摘要输入；原文永远在日志中可通过 `ctx_expand` 召回。

### 3.5 降级策略

- 65% 自动生成：优先保留配置的 `retainRounds` 个段落；如果可见段落不足，则降级到短历史策略，至少保留最近一个段落并压缩更早内容。长 tool-heavy turn 因此也能生成 Compartment。
- 落地时 Compartment 未就绪（仍在生成/失败）→ 等待在途生成（限时 60s）→ 仍失败则**跳过本次落地**，日志告警，等待下一轮触发。不阻塞回合。
- `context-window-exceeded` 溢出恢复：优先用就绪 Compartment；没有则**同步生成**（溢出时必须立刻释放空间，允许阻塞）。
- `/compact` 手动：有就绪 Compartment 则落地；否则同步生成（用户预期立即生效）。历史少于 `retainRounds` 时，手动/溢出路径会降低保留尾部但至少保留最近一个段落；候选范围还必须大于固定 checkpoint framing，否则直接跳过，不发起必然失败的摘要请求。

### 3.6 辅助调用韧性（重试、失败可见性、本地 XML 修复）

整理者与 Dreamer 都走 `ctx.llm.stream()` 的**辅助调用**：它们不带 agent loop 的请求标记，因此宿主的请求重试插件（挂在 `agent/request-error`、以 `isAgentLoopRequest` 为守卫）看不到它们，`LlmRuntime.stream()` 自身也不重试。主 Agent 能扛过网关抖动，靠的正是那层重试；辅助调用曾经只有一次机会，网关一次 `429 Rate limit exceeded: tpm (InputTokens)`、nginx `504`、流提前中断或空响应，就让整代 Compartment 永久 `failed`。

- **重试**：`lib/aux-llm.js` 的 `streamAux()` 为辅助调用提供有界重试（默认 3 次），指数退避 + 抖动，并优先采用 provider 给出的 `providerRetryAfterMs`。可重试类与主 Agent 一致：`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`（外加 `STREAM_CLOSED`）。`AUTH`、`INVALID_REQUEST`、`MAX_TOKENS` 以及用户中止一律不重试，失败立即上抛。整理者与 Dreamer 每轮都经由它发起请求。
- **失败可见性**：`compartments` 增加 `error` 列（迁移式添加）。失败时 `setCompartmentStatus(id, "failed", reason)` 落库原因，成功写摘要时清空；同时发一条 `Compartment generation failed: generation N` 的 UI 通知，包含原因、源区间 token 数、连续失败次数与下次尝试的推迟时长。此前失败只有一行进程日志，UI 上仍停在 "generation started"。
- **失败冷却**：每次生成都会重发整个区间（实测 56k–133k input tokens），因此每个 step 边界无节制重试会把一次限流放大成持续洪流。连续失败按 `2^n` 退避（起步 120s，上限 15min）记在 `generateFailures`，冷却期内 `_maybeGenerate` 直接返回；一次成功即清空，会话销毁时一并清理。
- **本地 XML 修复**：模型偶尔在 text-only 叶子里写出未转义的裸标签（如 `<name>`、`<plugin>`、`<system-reminder>`）。`sanitizeOrganizerOutput()` 在**校验失败之后**做一次 schema 感知的重判：元素名集合是封闭的，凡不在集合内的标签只能是文本；叶子按 schema 是 text-only，因此叶子内唯一合法的标记是它自己的结束标签；此外还会剥掉 markdown 围栏/前后散文（`extractOutputDocument`）。修复结果必须通过**未改动的严格校验器**才会被采用，否则照旧走模型 repair。它从不补标签、不改树形，因此只能把被拒绝的输出变成合法输出，不会放宽契约——纯转义错误因此不再多花一次全量模型调用。

#### 3.6.1 输出预算：截断按"长大"恢复，不按重试恢复

`MAX_TOKENS` 与限流不同：同一个 cap 上重试必然再次截断，所以它不在可重试类里。真正的修法是把 cap 调大。

- **思考也吃这份预算**。推理模型先思考再作答，而 Anthropic 的 `max_tokens` 同时覆盖 thinking 与正文。因此"按文档长度"估的 cap 在大区间上会在正文开始之前就被思考耗尽——表现为 `stop_reason: max_tokens` 且**一个字都没输出**，且每次必然复现。实测：某会话在 158–370 段（约 90k tokens 源区间）上以 8192 的 cap 连续失败 8 次，`compartments.error` 全部是 `auxiliary model output truncated at the token cap`。
- **默认值与收敛**：整理者默认 `summarizationMaxTokens: 32768`，Dreamer 默认 `dreamerMaxTokens: 16384`，两者都会被 `resolveAuxMaxTokens()`（`ctx.llm.resolveModelInfo` 的 `defaultMaxTokens`）收敛到目标模型自己的上限，因此把整理者指到只有 4k–8k 输出的旧模型也不会发出非法请求。
- **一次性增长**：`streamAux` 在 `MAX_TOKENS` 上把 cap 乘以 `growFactor`（默认 2、上限 `growAttempts: 1` 次）后立即重发，不退避——没有人在限流我们。增长同样受模型上限收敛；已经到顶就直接失败。
- **配置降档更省**：整理者不继承会话的 `reasoningEffort`（会话是 `max` 时尤其不该继承）。把 3.7 的推理档位设为 `off`/`minimal` 能同时消掉思考开销与截断风险。

##### 3.6.1.0 "cap 只算输出、不算思考"能否做到：分三种路线

这个问题没有统一答案，取决于目标路由如何把思考预算映射到线上参数。三种情形都已核对，其中第三种为实测：

| 路线 | 线上行为 | 我们的 cap 是否＝输出预算 |
| --- | --- | --- |
| pi-ai **预算式** thinking（无 `compat.forceAdaptiveThinking`，如 Sonnet 4.5、Opus 4.1） | `adjustMaxTokensForThinking()` 把思考预算**加在**调用方 cap 之上：`max_tokens = min(ours + budget, modelMax)`，`budget_tokens = min(budget, max_tokens - 1024)`；阶梯为 minimal 1024 / low 2048 / medium 8192 / high·xhigh·max 16384 | **是，已经是**。传 32768 + `high` → 线上 `max_tokens: 49152`、`budget_tokens: 16384` |
| pi-ai **自适应** thinking（`compat.forceAdaptiveThinking: true`，如 Opus 4.6–5、Sonnet 4.6/5） | `thinking: {type: "adaptive"}` + `output_config: {effort}`，cap 原样进 `max_tokens`；Anthropic 在自适应模式下**不提供**独立思考预算 | **否，且无法做到**——这是 API 的限制，不是 DSH 的 |
| `deepseek-official` adapter | `max_tokens` 原样下发，另附 `thinking.type` 与 `reasoning_effort`；CoT 与正文共享同一预算 | **否**，只能用 `off` 把整份预算让给输出 |

DeepSeek 那行的实测（`deepseek-v4-flash`，`max_tokens: 200`）：

- `reasoning_effort: high` → `finish_reason: length`、`completion_tokens: 200`、`reasoning_tokens: 200`、`content` **长度 0**。预算被 CoT 吃光，正文一个字都没开始——正是 3.6.1 描述的确定性截断。
- `thinking: {type: "disabled"}` → `completion_tokens: 200`、无 `reasoning_tokens`、`content` 469 字符。整份预算归输出。

因此想让 `summarizationMaxTokens` 在**任意**路由上都等于"输出预算"，唯一无歧义的开关是把 `summarizationReasoningEffort` 设为 `off`：pi-ai 侧 `off` 折成"不传 reasoning"（`thinkingEnabled: false`），DeepSeek 侧折成 `thinking: {type: "disabled"}`。整理者做的是对给定文本的结构化抽取而非推理，所以这是它本就该用的档位。`off` 是否合法由模型的 `thinkingLevelMap` 决定（Opus 5 允许，`claude-fable-5` 明确禁止），而设置面板只列出该模型自己声明的档位，因此选不出非法值。Dreamer 做的是判断性工作（核验记忆与事实），保留思考档位是合理的。

#### 3.6.1.1 图片内容不得阻断纯文本整理者

整理者处理的是它无法选择的固定区间：会话里只要贴过一张截图，纯文本路由就会以 `UNSUPPORTED_CONTENT` 拒收整个请求（实测 `The DeepSeek chat-completions adapter does not support image content.`），于是这个会话**永久无法压缩**——把整理者换成便宜模型反而制造了新的确定性失败。

`stripImageContent()` 因此把 image block 换成占位文本 `[image omitted: the summarization model accepts text only]`，保留消息的位置与角色（摘要需要的是叙事结构，不是像素）。两条路径：

- **提前剥离**：`resolveAuxImageSupport()` 读 `resolveModelInfo().inputModalities`；明确不含 `image`（如 `deepseek-official` 声明 `["text"]`）就在发请求前剥离，连一次失败都不浪费。
- **拒收后兜底**：`inputModalities` 缺失表示"未知"，此时照常带图发送；若路由以 `UNSUPPORTED_CONTENT` 拒收，则剥离后**重试一次**。剥离后已无 image block，因此不会形成循环；与图片无关的拒收（如 `INVALID_REQUEST`）照旧立即失败。

#### 3.6.2 失败文本必须先变惰性再落地

provider/网关的失败不一定是 JSON：网关前的 WAF 会返回**整页 HTML**（含 `<script>`）。这种文本绝不能原样进通知——通知是**持久的会话内容**，它会随后续每次请求发送，于是：下一次整理调用把自己的错误页当输入重发，而错误页里的脚本标签本身可能正是触发拦截的东西，失败便自我延续，且每失败一次再追加一份。

`describeAuxFailure()` 因此在入库与通知前把失败文本压成单行诊断：识别出 HTML 后只保留状态码与 `<title>`（如 `HTTP 405; provider returned an HTML error page`），其余文本折叠空白并截到 `MAX_AUX_REASON_CHARS`（240）。`compartments.error`、Compartment 失败通知、Dreamer 失败通知与手动压缩的失败文本都走它。

#### 3.6.3 手动 `/compact` 的失败必须说实话

`compactNow()` 曾把 `runMaintenance` 里的**任何**异常都改写成 `ManualCompactionError("busy")`，于是一次整理者截断在 UI 上显示为"进程有活跃压缩，或 agent 不空闲"——把确定性的摘要失败伪装成瞬时忙碌，用户只会反复重试。现在以"任务体是否已开始执行"区分：未开始 = 真忙（`busy`）；已开始则按中止（`cancelled`）或摘要失败（`summary`，附归一化原因）上报。

### 3.7 整理者 / Dreamer 的独立模型选择

整理者与 Dreamer 默认跟随会话路由（`routedTarget(session)`），但两者的工作性质与对话完全不同：它们是结构化抽取，不需要对话模型的推理强度，却每次都要重发整个区间。把它们指到更便宜的路由，既省钱也能让它们不再和主 Agent 抢同一个 provider 的 tpm 配额（这正是限流失败的来源）。

配置直接复用宿主已有的 Provider 系统，而不是另建一套模型清单：

- **目录来源**：`settings.js` 的 `buildModelCatalog()` 调用 `llm.listProviders()` / `llm.listModels(provider)` / `llm.resolveModelInfo(provider, model)`——与宿主自己的 `llm.models`、`session.models` 完全同源，因此下拉框里只会出现这台 DSH 真的能派发的路由，并带上每个精确模型的 adapter 推理档位。它由 `GET /magic-context/models/catalog` 暴露；该路由挂在对 `llm` 的内层 inject 上，宿主没有该服务时路由不存在，面板自动退回手填。
- **目录是建议性的**：某个 provider 列不出模型时它进 `failures`（面板只列出 id），其余分组照常可用；已保存但目录未收录的 `provider/model` 仍保留为选中项（标记 `saved`）并继续派发——网关隐藏模型清单不会阻断配置。选择「自定义 provider/model…」可随时手填。
- **推理档位**：`summarizationReasoningEffort` / `dreamerReasoningEffort` 独立于 provider/model，因此**沿用会话模型时也能单独降档**（如整理者用 `off`）。档位 id 属于某个精确模型，所以切换目标时会清空；模型不接受该 id 时按 `INVALID_REQUEST` 快速失败（不重试），原因落到 `compartments.error` 与失败通知。

两组键完全独立：整理者读 `summarizationProvider` / `summarizationModel` / `summarizationReasoningEffort`，Dreamer 读 `dreamerProvider` / `dreamerModel` / `dreamerReasoningEffort`；provider 与 model 必须同时非空才算覆盖，否则回落到会话路由。

## 4. 子系统 B：project_memory

### 4.1 数据模型（SQLite DDL）

```sql
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL CHECK(category IN
                ('ARCHITECTURE','CONSTRAINTS','CONVENTIONS','PREFERENCES','ENVIRONMENT')),
  scope_path  TEXT,                 -- canonical Git worktree root; NULL for global preferences/legacy rows
   summary     TEXT NOT NULL,        -- 简短总结（注入用）
  content     TEXT NOT NULL,        -- 详细内容（召回用）
  importance  REAL NOT NULL DEFAULT 5,   -- I₀，ctx_memory 时 LLM 给定 (0~10)
  hits        INTEGER NOT NULL DEFAULT 0, -- k
  created_at  INTEGER NOT NULL,     -- epoch ms
  last_hit_at INTEGER NOT NULL,     -- 写入或最后命中时间（Δt 基准）
  verified_at INTEGER,              -- Dreamer 校验时间；NULL = 未校验（新写/已修正）
  archived    INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT,           -- 原始来源 session（可选）
  source_compartment_id INTEGER,    -- 原始来源 compartment（可选）
  source_start_seq INTEGER,         -- 原始来源事件起点（可选）
  source_end_seq INTEGER,           -- 原始来源事件终点（可选）
  embedding   BLOB                  -- float32 向量（可选，配置 embedding 模型后启用）
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(summary, content, content='memories', content_rowid='id');

-- 可选（配置 embeddingModel 后创建）:
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[<dim>]);

CREATE TABLE IF NOT EXISTS paragraphs (
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,     -- session 事件 seq
  paragraph_no INTEGER NOT NULL,     -- 全局递增
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, paragraph_no)
);

CREATE TABLE IF NOT EXISTS skip_marks (
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  paragraph_no INTEGER NOT NULL,
  marked_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS compartments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  scope_path   TEXT,                 -- Git worktree root of the source session
   generation   INTEGER NOT NULL,
  start_seq    INTEGER NOT NULL,
  end_seq      INTEGER NOT NULL,
  start_para   INTEGER NOT NULL,
  end_para     INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  memory_ids   TEXT,                 -- 整理者提取的 memory 列表 (JSON)
  status       TEXT NOT NULL,        -- generating / ready / landed / failed
  created_at   INTEGER NOT NULL,
  landed_at    INTEGER,
  has_promoted_facts INTEGER NOT NULL DEFAULT 0,  -- Dreamer 已萃取 facts
  importance   REAL,                 -- Dreamer 重整时评分（归档排序用）
  archive_flagged INTEGER NOT NULL DEFAULT 0,     -- Dreamer 标记待归档
  archived     INTEGER NOT NULL DEFAULT 0,
  archived_at  INTEGER,
  UNIQUE (session_id, generation)
);

-- 整理者的原始产物：Compartment 生成时提取的重要事实。
-- 不是正式记忆——由 Dreamer 决定提升(promoted)或丢弃(discarded)。
CREATE TABLE IF NOT EXISTS session_facts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  scope_path   TEXT,                 -- Git worktree root of the source session
   compartment_id INTEGER,           -- 来源 Compartment；可为 NULL
  fact         TEXT NOT NULL,       -- 事实内容（面向 Dreamer，可带上下文引用）
  importance   REAL NOT NULL DEFAULT 5,  -- 整理者初步评分（Dreamer 可覆盖）
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending / promoted / discarded
  created_at   INTEGER NOT NULL,
  promoted_memory_id INTEGER        -- 提升后对应的 memories.id
);
```

### 4.1.1 Scope 规则

- session 的绝对 `cwd` 解析为 canonical Git worktree root；非 Git workspace 使用 canonical cwd。
- `PREFERENCES` 的 `scope_path` 永远为 NULL，跨 workspace 共享。
- `ARCHITECTURE`、`CONSTRAINTS`、`CONVENTIONS`、`ENVIRONMENT` 必须匹配当前 Git root 才能注入或被 `ctx_search` 返回。
- 当前 scope 未知时只允许全局偏好；旧数据库中没有 `scope_path` 的非偏好记忆不会自动注入，避免跨项目泄漏。
- 同一 scope 下的 FTS、vector、Dreamer verification、fact promotion 都使用同一过滤规则。

### 4.2 重要性时间衰减 S(t)

```
S(t) = I₀ · (1 + α·ln(1+k)) · exp(−(ln2/τ_eff)·Δt)
τ_eff = τ / (1 + β·k)
```

- α = 0.4，β = 0.2（可配置）。β 含义：每命中一次，有效半衰期缩短为 1/(1+βk)。
- 半衰期 τ 按类别：ARCHITECTURE / CONSTRAINTS / ENVIRONMENT = **∞**（exp 因子恒 1，实现用 flag 跳过）；CONVENTIONS = 30 天；PREFERENCES = 14 天。
- Δt = now − `last_hit_at`（写入或最后命中时间，LRU 式：被使用的记忆不衰减）。
- 硬上限：S(t) 钳制到 10。
- 命中（注入选中 或 ctx_search 选中）：k+1 且 `last_hit_at = now`。
- 归档：S < 0.15 → `archived=1`，不再进入注入候选。ctx_search **仍可搜到**；命中后重算 S ≥ 0.15 → 解除归档。归档只影响注入池。

### 4.3 注入

- 时机：**新对话开始**（session 创建首轮，含 resume 时重建）+ **Compartment 落地后**。这是唯一两个允许重选的时刻；每次刷新都重选当前可注入 memories 并直接替换 deriveMessages 的首条 memory block。
- **稳定前缀**：block 一经注入就常驻于此后每一次 model request，直到下一次重选替换它。它不是"用完即弃"的一次性消息——单个 step 结束不会撤回它。"一次性"只描述**不按轮重复注入**：按轮重选会不断改写请求前缀，使 provider prompt cache 整体失效。
- 内容：按 S(t) 从高到低选，直到 token 预算（默认 4000 tokens，用 tokenMeter.estimateMessage 计量）或选完。只给 summary，不给 content。
- 格式（注入在 system 之后、历史之前，视图层拼接，不进 session 日志——内容本身已持久化于数据库，可审计性由数据库保证）：

```
<project_memory>
[ARCHITECTURE] JWT 认证设计：30 天过期，refresh token 轮换
[CONSTRAINTS] 生产环境禁止直接改数据库
</project_memory>
```

- 命中计数：重算注入集合时，对选中条目一次性 k+1（避免每轮请求重复计数）。

### 4.4 召回（ctx_search）

1. **双通路**：FTS5 全文（`memories_fts MATCH`）top-K；向量检索（`memories_vec MATCH` + k，配置 embedding 后启用）top-K。
2. **向量语义**：写入向量只对 `summary` embedding；sqlite-vec 返回 memory rowid 后再回查完整 `content`。
3. **最低匹配度**：向量统一单位化，sqlite-vec L2 distance 换算为 cosine similarity；低于 `vecMinScore`（默认 `0.35`）的 vector 结果在进入 RRF 前丢弃。
4. **RRF 合并**：`RRF(d) = Σ 1/(60 + rank_i(d))`，两通路排序合并。
5. **rerank**（配置模型后启用）：RRF 合并后的 top-K′ 与查询原文及完整 memory content 送入 rerank 模型，选出最相关 5 条。
6. 命中的结果 k+1；`ctx_search` 返回完整 `content`。
7. 无 embedding/rerank 配置时自动降级为纯 FTS5 检索。

### 4.5 ctx_memory 工具

- `{action: "write", category, summary, content, importance}`：写入新记忆（I₀ 由 LLM 给定，0~10）。
- `{action: "delete", id}`：按 id 删除（LLM 需先 ctx_search 获取 id）。
- 更新语义：按 id 更新不支持（写入即新条目）；重复膨胀靠 ctx_search 先查后写缓解，后续可加"按 id 更新" action。
- Agent 直接写入的记忆 `verified_at = NULL`，等待 Dreamer 校验。

### 4.6 Session Facts（整理者的原始产物）

- 整理者（Compartment 生成器）**不再直接写记忆**，只产生 Session Facts（`session_facts.status = 'pending'`），事实内容面向 Dreamer（可带代码/文件引用）。
- 状态机：`pending → promoted`（Dreamer 提升为正式记忆，记 `promoted_memory_id`）/ `discarded`（Dreamer 判断不构成项目记忆，如一次性琐事）。
- 注意：Session Facts 不是记忆——不参与注入、不进 ctx_search 主检索（仅 Dreamer 消费）。

### 4.7 Dreamer（后台记忆整理者）

一个低频率的后台 LLM 循环，负责把散落的会话产物沉淀为项目级记忆。

**职责**

1. **校验记忆 vs 代码库**：携带待校验记忆（30 天校验周期）扫描代码库（只读），核对是否符合事实；不符 → 修正 summary/content/importance，或注销（archived）过时记忆；校验后更新 `verified_at`。
2. **提升 Session Facts**：把 pending facts 评估为正式记忆（Dreamer 定 category / importance / summary 措辞），并**合并**重复记忆（多会话产生的相同事实 → 合并到一条，更新 hits/内容）。
3. **Compartment 重整**：评估旧 Compartments 的重要度（写 `importance`），标记待归档（`archive_flagged`）。Dreamer 只打标记——**真实归档由代码逻辑执行**。

**启动输入**（三个查询打包为初始消息；字段可按实现调整）

```sql
-- 1. 未处理的新素材
SELECT id, session_id, compartment_id, fact, importance, created_at
FROM session_facts WHERE status = 'pending' ORDER BY created_at;

-- 2. 等待校验的记忆（30 天校验周期）
SELECT id, category, summary, content, importance, hits, created_at, last_hit_at
FROM memories
WHERE archived = 0 AND (verified_at IS NULL OR verified_at < (now_ms - 30*86400e3));

-- 3. 未萃取的 Compartments
SELECT id, session_id, generation, summary, importance, created_at
FROM compartments WHERE has_promoted_facts = 0 ORDER BY created_at;
```

**工具集**（自建轻量 agent loop 内的只读/专用工具）

| 工具 | 作用 |
|---|---|
| `sql_query` | 只读 SQL（校验必须以 SELECT 开头），进一步检索数据库 |
| `fs_list` / `fs_read` / `fs_grep` | 只读扫描代码库（根 = 配置的 workspaceRoot，**无写工具**） |
| `session_context` | 按来源 session/compartment 有界读取原始事件（scope 校验、事件数和字符数上限） |
| `memory_write` | 直接写记忆（合并时用） |
| `memory_update` | 修正已有记忆（id + 字段） |
| `memory_archive` | 注销过时记忆 |
| `promote_fact` | fact id → 提升为记忆（Dreamer 定 category/importance/summary），facts 置 promoted |
| `compartment_mark` | compartments id → 设 archive_flagged / importance |

主 Agent 的 `context-tool-guidance` system-prompt section 明确指导：不需要或过时的段落用 `ctx_reduce`，重要持久信息用 `ctx_memory`，需要记忆全文时用 `ctx_search`，需要段落原文时用 `ctx_expand`。

**循环实现**：插件内自建轻量 loop（不走 DSH agent/deriveMessages，不占段落号）：system（角色 + schema + 工具说明）+ 素材初始消息 → `ctx.llm.stream` → 解析 tool_calls → 执行 → 结果回填 → 直到无 tool_calls 或轮次上限（默认 20）/总超时（默认 10 分钟）。进程级 single-flight（同时只跑一个 Dreamer）。Dreamer 是辅助 LLM 调用，路由默认跟随会话（或配置 provider/model）。

**来源上下文**：Organizer 首次读取原始会话后，facts/compartments 保留来源 session 与事件范围；直接通过 `ctx_memory` 写入的 memory 也保存当前 session/turn 来源。Dreamer 可用 `session_context` 在当前 workspace scope 内有界读取这些原始事件，用于判断用户明确指令和事实证据；来源 session 不可用时回退到已持久化的 fact/summary，不猜测缺失 provenance。

**触发**

1. **会话空闲**：`session/event` 监听重置计时器，会话 15 分钟（可配）无新事件且存在 pending 素材/待校验记忆 → 触发该会话的 Dreamer run。同一交互轮次只触发一次；Dreamer 通知等后台事件不会重新安排运行，直到下一次 `turn/start`。

当前暂不启用全局定时触发；Dreamer 只在有活动会话进入 idle 后运行。

**真实归档（Dreamer 结束后，代码逻辑）**

- 预算：所有 `archived = 0` 的 Compartments 的 summary 估算 token 总和，上限默认 **40K**（可配置）。超预算 → 按优先级逐个归档直到预算足够。
- 优先级（高→低）：① `has_promoted_facts = 1`（已提炼成记忆，信息已沉淀）② `importance` 低（NULL 按低处理）③ 时间/代次衰减（`created_at` 旧 / `generation` 小优先）。
- 归档动作：`archived = 1` + `archived_at` + **surface 移除 checkpoint 节点**（`compaction/prune` 协议：log-only prune 事件 + 紧跟 `user/message` replace，replacement 为最小空文本占位消息，`sourceEventSeqs` 记录被移除节点）。数据库记录保留（可审计），不再参与 surface 与预算。

**安全约束**：只读代码库（无写/执行工具）；SQL 只读；轮次/超时上限；single-flight；归档仅通过代码例程执行（Dreamer 无法直接改 surface）。

## 5. 与 DSH 的接缝映射

| 组件 | 接缝 |
|---|---|
| 引擎 | `class ContextEngine extends BasicCompactionEngine`；覆盖 `summarize()`（返回预存 Compartment）与 `compactIfNeeded()`（选段 = 固化范围；继承 pre-step/溢出/compactNow 框架） |
| 65% 触发 | `ctx.on("session/event")` 在 `step/end`/`turn/end` 低频检查 tokenMeter（single-flight 防重） |
| 段落号+memory 注入 | 包装 `session.deriveMessages()`（agent/session-start 时对 session 实例包装；闭包捕获 ctx 拿 tokenMeter/数据库） |
| 工具 | `ctx.tools.register()`：ctx_reduce / ctx_expand / ctx_memory / ctx_search（含 presentResult） |
| 系统提示词 | `ctx.systemPrompt` 注册两个 section（段落号说明、memory 说明） |
| Dreamer loop | 自建轻量工具循环（`ctx.llm.stream` 多轮），辅助调用不占段落号；空闲触发 = `session/event` 计时器；single-flight |
| 数据库 | `node:sqlite` + `{allowExtension:true}` + `sqlite-vec`（`sqlite-vec` + `sqlite-vec-linux-x64` npm 包）；FTS5 原生 |
| 挂载 | 安装 `dsh-magic-context` bundle 提供 host settings/client；若启动提示 preset 缺失，运行 `dsh plugin --profile web exec dsh-magic-context-install-preset` 将随包的 `context-compact` 安装到 `~/.dsh/.agent-presets/`；它不会修改 default，preset 内保留 `command-compact`、`tool-result-pruner`，host 侧插件需重启 |

**已知权衡**：
- 段落号 + memory 块是视图层注入，违反"model-visible 必须走日志通道"原则（memory 有数据库兜底；段落号是纯展示）。落地 checkpoint 走正式事件契约不受影响。
- 落地替换范围 = Compartment 固化范围，可能略小于"80% 处可压缩范围"（保留尾可能 > 20%），换取异步与稳定性。

## 6. 配置（插件 Config schema）

```yaml
# ContextEngine 当前接收扁平配置；未列出的字段使用插件默认值。
thresholdRatio: 0.8            # 落地阈值（BasicCompactionEngine）
generateThreshold: 0.65         # 后台生成阈值
retainRounds: 20               # 最近 N 个段落（生成时刻锁定）
waitReadyTimeoutMs: 60000      # 落地时等待在途摘要上限
alpha: 0.4
beta: 0.2
injectBudgetTokens: 4000
archiveThreshold: 0.15
halfLives:
  CONVENTIONS: 30
  PREFERENCES: 14              # 其他类别省略 = 永不衰减
ftsTopK: 20
vecTopK: 20
rrfK: 60
embeddingPreset: ''             # bge-m3 = 本地 BGE-M3，自动下载到 $DSH_HOME/magic-context/.cache
rerankPreset: ''                # bge-reranker-v2-m3 = 本地 rerank，独立下载到同一缓存
rerankTopN: 5
rerankInputTopK: 20
embeddingModel: ''             # 空 = 关闭向量通路
embeddingBaseUrl: ''
embeddingApiKeyEnv: ''
embeddingDim: 1024
rerankModel: ''                # 空 = 关闭 rerank
rerankBaseUrl: ''
rerankApiKeyEnv: ''
dreamerIdleMinutes: 15          # 会话空闲触发
dreamerMaxRounds: 20            # 工具循环轮次上限
dreamerTimeoutMs: 600000        # 总超时
verifyIntervalDays: 30          # 记忆校验周期
compartmentBudgetTokens: 40000  # 未归档 Compartments 总预算
dreamerProvider: ''             # 空 = 跟随会话路由
dreamerModel: ''
dreamerReasoningEffort: ''      # 空 = adapter 默认档位
summarizationProvider: ''       # 空 = 跟随会话路由（provider 与 model 必须同时填）
summarizationModel: ''
summarizationReasoningEffort: ''
summarizationMaxTokens: 32768    # 整理者输出预算（含思考），收敛到模型上限
dreamerMaxTokens: 16384          # Dreamer 单轮输出预算
```

`embeddingPreset: bge-m3` 和 `rerankPreset: bge-reranker-v2-m3` 分别使用 `Xenova/bge-m3` 与 `onnx-community/bge-reranker-v2-m3-ONNX` 的 q8 ONNX 权重；每个预设独立由 Web host 后台下载，模型缓存位于 `$DSH_HOME/magic-context/.cache`。

## 7. 用户命令

ContextEngine 为当前 agent 注册用户侧命令：

```text
/ctx-search <query> [--limit N]
```

它复用 `ctx_search` 的 FTS/vector/RRF/rerank 路径、结果格式和 memory hit 记录；`N` 范围为 1-10，默认 5。

```text
/dream
```

立即对当前 session 运行一次 Dreamer 整合；无参数，执行结果会返回本次轮数和待处理 material 数量。已有 Dreamer 运行时会返回 busy，无 provider/model route 时会返回跳过原因。

```text
/inject-memory
```

重新选择当前 workspace 下的可注入 Memories，并将一个完整的 `<project_memory>` block **追加**到下一次模型请求。它不会改写 deriveMessages 首部已有的 Memory block，因此不会让原有请求前缀整体失效；没有可注入 Memory 时返回成功但不排队消息。

## 8. UI 展示

状态汇报走 **activity row**：`notifications.js` 直接向 session 追加一对 `command/run` + `command/done`，Web 客户端把它们按 `commandId` 配对成一张可折叠的 `GenericCommandCard`——`command/done` 到达前显示为运行中，`kind: "error"` 显示为红色失败态。Host bridge 使用 `/magic-context/config`、`/magic-context/usage` 和 `/magic-context/models/*` 路径。

**展示内容**

| Activity row | 内容 |
|---|---|
| `Context: project memory injection` | 选中的 project memory 数量；自动 landing 通过 deriveMessages 动态注入，`/inject-memory` 则将完整 block 追加到下一次请求 |
| `Context: compartment generation N landed` | Compartment 代次、覆盖段落区间、替换的历史项数量和估算 token 数 |
| `Context: compartment generation N` | 生成开始时开启（运行中），成功后落为 Compartment id、捕获范围与抽取的 project facts 数量，失败则落为红色行：归一化原因、源范围 token 数、连续失败次数和冷却秒数 |
| `Context: Dreamer maintenance pass` | Dreamer 启动时开启（运行中），完成后落为本批 pending facts / 待校验 memories / 待整理 compartments 数量、完成轮数、维护动作摘要和归档 Compartment 数量；失败落为红色行 |

一次生成对应**一行**，而不是"started"和"ready"两条独立通知；完整 checkpoint 摘要仍由内置 compaction 行渲染。

### 8.1 为什么状态汇报不用 context notice

早期实现用 `agent.inject(createUserMessage(...))` + `form: "notice"` 渲染 `ContextInjectionRow`。这条路有两个无法接受的代价：

- **模型可见**。surface-eligible 的事件类型只有 `user/message`、`assistant/message`、`tool/result` 三种，且 `deriveEventMessage` 无条件投影它们，所以任何占据 transcript 位置的行必然进入模型上下文。写给人看的 "Dreamer started" 会永久占据每一次后续请求的前缀。
- **多一次 LLM 请求**。`agent.inject()` 等价于 `send(message, "next-step", false)`，落进 `inbox.nextStep`；而 agent loop 的收尾条件是 `if (turnEnds && this.inbox.nextStep.length === 0) break`。落在 turn 边界上的状态通知因此强制多跑一个 step——为一句人类可读的状态文本，付一次整窗口的模型请求。

反过来 `command/run` / `command/done` 是纯日志追加：没有 turn 包裹它们，不进 inbox，且两者都不是 surface-eligible。

自定义事件类型（例如 `magic-context/notice`）不可行：`Session.append()` 只接受 `sourceEventSeqs` 和 `surfaceOp`，插件无法设置 envelope 的 `ignorable` 标记，而 `dsh-session-persistence` 会拒绝解析任何含未知类型且未标记 `ignorable` 的日志——一条这样的通知就会让整个 session 打不开。上游明确写着该注册面"deferred until such a consumer exists"。

`createContextNotice()` 保留给**真正面向模型**的内容：`/inject-memory` 有意把 memory 正文摆到模型面前，那属于 context message 而不是状态汇报。`tests/dsh-context-notifications-smoke.mjs` 用源码级断言守住这条边界（引擎不得出现 `.inject(`）。

## 9. 实现阶段

1. **数据层**：node:sqlite 封装（allowExtension、DDL、迁移、vec0 绑定坑：整数 rowid 用 exec/bigint）
2. **段落号系统**：paragraphs 表、deriveMessages 包装、排除规则、§N§ 提示词段
3. **异步引擎**：ContextEngine 子类、65% 后台整理者、固化范围落地、降级策略
4. **ctx_reduce / ctx_expand**：工具注册、skip_marks、历史段落过滤与原文回查
5. **project_memory**：S(t)、注入（时机/预算/命中）、ctx_memory/ctx_search、FTS5
6. **向量 + rerank**（可选配置）：sqlite-vec、embedding 客户端、RRF、rerank 客户端
7. **整理者产生 session_facts**：摘要时抽取事实写入 session_facts（pending）
8. **挂载与测试**：dsh-magic-context bundle、context-compact preset、patch、烟雾测试（真实 GUI 验证）
9. **Dreamer**：只读工具集（sql_query/fs_read/memory_*/promote_fact/compartment_mark）、轻量 loop、会话空闲触发、归档例程（compaction/prune 协议 + 预算 + 优先级）
10. **UI 展示**：状态汇报走 `command/run` + `command/done` activity row（模型不可见、不进 agent inbox），覆盖 memory injection、compartment landing、compartment generation 和 Dreamer 四类；`createContextNotice()` 仅保留给 `/inject-memory` 这类面向模型的注入
