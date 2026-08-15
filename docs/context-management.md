# DSH 上下文管理系统设计文档

异步 Compartment 压缩 + project_memory 记忆系统。替换内置的同步摘要压缩（`dsh-compaction-basic`），作为一个自定义 `CompactionEngine` 插件挂载在 agent preset 中。

## 1. 目标

1. **压缩异步化**：摘要生成不阻塞 agent loop；阈值到达时落地只是投影替换（秒级）。
2. **细粒度、可召回**：压缩产物按 Compartment 切分，原始信息永远可从会话日志召回。
3. **长期记忆**：`<project_memory>` 记忆库，跨会话/跨压缩保留重要事实。

## 2. 架构总览

```
                    ┌────────────────────────────────────────────────┐
                    │            dsh-plugin-context                  │
                    │  (agent preset: my-compact)                    │
                    │                                                │
  agent loop ──────►│  [引擎] CompartmentEngine 子类                  │
                    │    ├ 65% 触发后台整理者（摘要+提memory）         │
                    │    ├ 80% 落地事务（compaction/* 事件契约）       │
                    │    └ ctx_reduce 跳过段落                        │
                    │                                                │
  请求组装 ────────►│  [注入层] 段落号 §N§ + <project_memory> 块        │
   (deriveMessages)│   (视图层包装, 不进 session 日志)                 │
                    │                                                │
  工具调用 ────────►│  [工具] ctx_reduce / ctx_memory / ctx_search     │
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
   ├─ 整理者: 对 [最后一个 checkpoint 之后 … 最近 N 轮之前] 的轮次
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

- **覆盖范围固化**：Compartment 在 65% 生成时刻确定 `start_seq..end_seq`（end = 最近 N 轮起点的轮次边界，即 turn 边界，天然平衡切割）。落地时替换**就是**这个固化范围，绝不外扩。
- **保留尾**：生成时刻的最近 N 轮 + 生成之后所有新增轮次，全部原文保留。
- **链式多代**：每代 checkpoint 节点永久留在 surface：`[C1][C2]…[Ck] + 原文尾`。下一代只摘要上一代落地点之后的新内容，**不对旧 checkpoint 二次摘要**（避免信息损失）。后续单独设计"重整"机制（数据库按代次/覆盖 seqs/段落号区间建立索引，为重整预留）。
- **落地后**：若 surface 仍高于 65%（极端保留尾过大），立即进入下一代生成循环，自洽无需特殊处理。
- **Dreamer 归档**：旧 checkpoint 节点由 Dreamer 标记、代码逻辑真实归档（§4.7），归档会从 surface 移除 checkpoint 节点并更新预算——这是落地之外唯一允许的 surface 变更。

### 3.2 段落号系统（§N§）

- **分配**：每个 model-visible 消息（user 输出 / assistant 输出 / tool 结果）首次进入主请求组装时，从 `paragraphs` 表分配全局递增号（按 session 绑定，持久化，永不复用）。
- **注入**：`deriveMessages()` 包装层，对每个消息第一个 text block 加 `§N§ ` 前缀。纯视图层，**不写入 session 日志**。
- **排除规则**（不分配号）：
  - 辅助 LLM 调用（摘要、标题等）——它们不走 `deriveMessages`，天然排除（实现时验证所有调用点）。
  - `ctx_reduce` 工具调用自身：assistant 节点若含 `ctx_reduce` tool-call 跳过；对应的 tool/result 通过 callId 回溯 `tool/call` 的 name 判断跳过。
- **失效**：落地后 checkpoint 节点占一个新号；旧号保留在库中但不可见。`ctx_reduce` 引用不可见号 → 返回错误"段落 X 不在当前上下文"，不静默。
- **系统提示词**（注册 systemPrompt 段）：说明 §N§ 格式、编号单调递增、落地后旧号失效、ctx_reduce 用法。
- **token 计量偏差**：tokenMeter 计价不含 §N§ 前缀（每消息约 +5~15 token），阈值判定偏差可接受；如需精确可在配置中加 offset。

### 3.3 落地事务（事件契约，与内置一致）

`compaction/start`（锁）→ `compaction/summary`（含代次、覆盖范围、shadowedSeqs、摘要）→ `user/message`（`surfaceOp:{op:"replace",start,end}` + `compactCheckpointSource(compactionId)` + `sourceEventSeqs`）→ `compaction/end`。复用 `BasicCompactionEngine` 的事务、稳定性断言、`/compact`（`compactNow` → `runMaintenance`）。

### 3.4 ctx_reduce 工具

- schema：`{paragraphs: string}`，格式 `"1-2,5,11-12"`。
- handler：解析区间 → 校验在可见范围内 → 写入 `skip_marks`（seq + paragraph_no）→ 返回标记结果。
- 生效：整理者生成摘要时从输入中过滤 Skip 段落。
- 召回：Skip 只影响摘要输入；原文永远在日志中可召回。

### 3.5 降级策略

- 落地时 Compartment 未就绪（仍在生成/失败）→ 等待在途生成（限时 60s）→ 仍失败则**跳过本次落地**，日志告警，等待下一轮触发。不阻塞回合。
- `context-window-exceeded` 溢出恢复：优先用就绪 Compartment；没有则**同步生成**（溢出时必须立刻释放空间，允许阻塞）。
- `/compact` 手动：有就绪 Compartment 则落地；否则同步生成（用户预期立即生效）。

## 4. 子系统 B：project_memory

### 4.1 数据模型（SQLite DDL）

```sql
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL CHECK(category IN
                ('ARCHITECTURE','CONSTRAINTS','CONVENTIONS','PREFERENCES','ENVIRONMENT')),
  summary     TEXT NOT NULL,        -- 简短总结（注入用）
  content     TEXT NOT NULL,        -- 详细内容（召回用）
  importance  REAL NOT NULL DEFAULT 5,   -- I₀，ctx_memory 时 LLM 给定 (0~10)
  hits        INTEGER NOT NULL DEFAULT 0, -- k
  created_at  INTEGER NOT NULL,     -- epoch ms
  last_hit_at INTEGER NOT NULL,     -- 写入或最后命中时间（Δt 基准）
  verified_at INTEGER,              -- Dreamer 校验时间；NULL = 未校验（新写/已修正）
  archived    INTEGER NOT NULL DEFAULT 0,
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
  compartment_id INTEGER,           -- 来源 Compartment；可为 NULL
  fact         TEXT NOT NULL,       -- 事实内容（面向 Dreamer，可带上下文引用）
  importance   REAL NOT NULL DEFAULT 5,  -- 整理者初步评分（Dreamer 可覆盖）
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending / promoted / discarded
  created_at   INTEGER NOT NULL,
  promoted_memory_id INTEGER        -- 提升后对应的 memories.id
);
```

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

- 时机：**新对话开始**（session 创建首轮）+ **Compartment 落地后**。期间注入集合缓存、静态（前缀稳定）。
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
2. **RRF 合并**：`RRF(d) = Σ 1/(60 + rank_i(d))`，两通路排序合并。
3. **rerank**（配置模型后启用）：RRF 合并后的 top-K′ 与查询原文送入 rerank 模型，选出最相关 5 条。
4. 命中的 5 条 k+1。
5. 无 embedding/rerank 配置时自动降级为纯 FTS5 检索。

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
| `fs_read` / `fs_grep` / `fs_glob` | 只读扫描代码库（根 = 配置的 workspaceRoot，**无写工具**） |
| `memory_write` | 直接写记忆（合并时用） |
| `memory_update` | 修正已有记忆（id + 字段） |
| `memory_archive` | 注销过时记忆 |
| `promote_fact` | fact id → 提升为记忆（Dreamer 定 category/importance/summary），facts 置 promoted |
| `compartment_mark` | compartments id → 设 archive_flagged / importance |

**循环实现**：插件内自建轻量 loop（不走 DSH agent/deriveMessages，不占段落号）：system（角色 + schema + 工具说明）+ 素材初始消息 → `ctx.llm.stream` → 解析 tool_calls → 执行 → 结果回填 → 直到无 tool_calls 或轮次上限（默认 20）/总超时（默认 10 分钟）。进程级 single-flight（同时只跑一个 Dreamer）。Dreamer 是辅助 LLM 调用，路由默认跟随会话（或配置 provider/model）。

**触发**

1. **会话空闲**：`session/event` 监听重置计时器，会话 15 分钟（可配）无新事件且存在 pending 素材/待校验记忆 → 触发该会话的 Dreamer run。
2. **定时**：每 24 小时（可配，cordis timer）→ 全局一次，汇总所有会话的素材处理。

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
| 工具 | `ctx.tools.register()`：ctx_reduce / ctx_memory / ctx_search（含 presentResult） |
| 系统提示词 | `ctx.systemPrompt` 注册两个 section（段落号说明、memory 说明） |
| Dreamer loop | 自建轻量工具循环（`ctx.llm.stream` 多轮），辅助调用不占段落号；空闲触发 = `session/event` 计时器，定时 = cordis timer；single-flight |
| 数据库 | `node:sqlite` + `{allowExtension:true}` + `sqlite-vec`（`sqlite-vec` + `sqlite-vec-linux-x64` npm 包）；FTS5 原生 |
| 挂载 | `~/.dsh/.agent-presets/my-compact/agent.cordis.yml` 替换 `compaction-basic` 行（保留 command-compact、tool-result-pruner），`cordis.patch.yml` 设 default；host 侧插件需重启 |

**已知权衡**：
- 段落号 + memory 块是视图层注入，违反"model-visible 必须走日志通道"原则（memory 有数据库兜底；段落号是纯展示）。落地 checkpoint 走正式事件契约不受影响。
- 落地替换范围 = Compartment 固化范围，可能略小于"80% 处可压缩范围"（保留尾可能 > 20%），换取异步与稳定性。

## 6. 配置（插件 Config schema）

```yaml
engine:
  generateThreshold: 0.65     # 生成阈值
  landThreshold: 0.8          # 落地阈值（= basic thresholdRatio）
  retainRounds: 20            # 最近 N 轮（生成时刻锁定）
  waitReadyTimeoutMs: 60000   # 落地时等待在途摘要上限
memory:
  injectBudgetTokens: 4000
  alpha: 0.4
  beta: 0.2
  halfLives: { ARCHITECTURE: null, CONSTRAINTS: null, ENVIRONMENT: null,
               CONVENTIONS: 30, PREFERENCES: 14 }   # null = ∞（天）
  archiveThreshold: 0.15
  ftsTopK: 20
  vecTopK: 20
  rrfK: 60
  rerankTopN: 5
  embeddingModel: ''          # 空 = 关闭向量通路
  embeddingDim: 1024
  rerankModel: ''             # 空 = 关闭 rerank
dreamer:
  idleMinutes: 15             # 会话空闲触发
  intervalHours: 24           # 定时触发
  maxRounds: 20               # 工具循环轮次上限
  timeoutMs: 600000           # 总超时
  verifyIntervalDays: 30      # 记忆校验周期
  compartmentBudgetTokens: 40000   # 未归档 Compartments 总预算
  workspaceRoot: ''           # 代码库扫描根；空 = 跟随会话 cwd
  provider: ''                # 空 = 跟随会话路由
  model: ''
```

## 7. UI 展示

系统事件需要在会话界面中可见（不污染 session 日志——展示事件为 log-only ignorable，记忆注入内容本身不入日志的设计不变）。

**展示内容**

| 事件 | 内容 |
|---|---|
| Inject Memories | 本次注入的记忆列表（`[ARCHITECTURE] 摘要…`，可展开看类别/重要性），注入时机：新对话首轮 + Compartment 落地后 |
| Inject Compartments | 落地/就绪的 Compartment：代次、覆盖段落区间、摘要预览、保留尾轮数 |
| Dreamer | 启动（原因：空闲 15min / 定时 24h）、阶段（校验/提升/合并/归档）、结果统计（校验 N 条、提升 M 条、归档 K 个） |

**机制**（Phase 8 调研 dsh-client-ui-conversation 的消息插槽后定稿）

- host 侧：事件写入数据库（已有）+ append log-only session 事件（ignorable，如 `context/memory-injected {memoryIds}`、`context/compartment-landed {compartmentId}`、`context/dreamer {phase, detail}`）+ 提供 `GET /context/events?sessionId&since` route 供客户端拉取。
- client 侧：读取事件 → 在会话流渲染系统消息卡片；若 conversation 无消息插槽，退化为会话头部状态条（类似 stats strip 的位置）。

## 8. 实现阶段

1. **数据层**：node:sqlite 封装（allowExtension、DDL、迁移、vec0 绑定坑：整数 rowid 用 exec/bigint）
2. **段落号系统**：paragraphs 表、deriveMessages 包装、排除规则、§N§ 提示词段
3. **异步引擎**：ContextEngine 子类、65% 后台整理者、固化范围落地、降级策略
4. **ctx_reduce**：工具注册、skip_marks、摘要输入过滤
5. **project_memory**：S(t)、注入（时机/预算/命中）、ctx_memory/ctx_search、FTS5
6. **向量 + rerank**（可选配置）：sqlite-vec、embedding 客户端、RRF、rerank 客户端
7. **整理者产生 session_facts**：摘要时抽取事实写入 session_facts（pending）
8. **挂载与测试**：my-compact preset、patch、烟雾测试（真实 GUI 验证）
9. **Dreamer**：只读工具集（sql_query/fs_read/memory_*/promote_fact/compartment_mark）、轻量 loop、空闲+定时触发、归档例程（compaction/prune 协议 + 预算 + 优先级）
10. **UI 展示**：log-only 事件 + `/context/events` route；调研 conversation 消息插槽 → 渲染 Inject Memories / Inject Compartments / Dreamer 卡片（无插槽则退化为会话头部状态条）；client.js + 挂载
