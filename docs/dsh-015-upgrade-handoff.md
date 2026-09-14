# DSH 0.1.5 升级交接（2026-09-14）

> **状态（2026-09-14 晚）：本文档的 A、B 两项与 §3 的 1/2 已全部实现并验证；C（system head 不可替换）在随后的会话里修完。本文件现为历史记录。**
> - **A**：`lib/session-compat.js` 的 `replaceSurfaceOp()` 探针 + `landing.js`/`engine.js` 两处写入改用；landing 冒烟测试改为用 host 校验器断言产出形状。
> - **B**：`lib/coordinates.js`（回放重建 + 纪元 + 退掉不可达 ready）+ `db.js` 的 `session_epochs`/`stale` + `agent/session-start` 触发 + landing `assertSpanInCurrentLog` 守卫 + `scripts/rebuild-coordinates.mjs`（VACUUM INTO 备份、截断保护）。
> - **C**：0.1.5 把系统提示词做成 surface node 0 的 `system/message`，host 折叠拒绝用 `user/message` 覆盖它（`surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node`）。`range.js` 的选段从第一个非 system 节点起（并仍跳过其后的 checkpoint 链）；`landing.js` 对仍指向 system head / 被后续 prompt 更新换掉的旧 head 的历史 ready 行做同样的裁剪。`paragraphs.js` 不再给 `system/message` 编号。
> - **线上结果**：三个已迁移会话已离线重建（`078919ac` 1558→818、`c71b3623` 4273→2142、`390452a4` 2326→1205，`mismatched=0`/`missingSeqs=0`），并退掉两个 span 已不可达的 ready compartment（429、438）。备份 `$DSH_HOME/magic-context/backups/context-1789374520096.db`。
> - **仍需一次重启**：插件在进程启动时装载。重启后 `agent/session-start` 会对任何纪元不是 v3 的会话自动重建，C 的选段/落地裁剪也才会进正在跑的进程。
> - **新发现（未修）**：0.1.5 把 layout 服务的 `openDetails`/`closeDetails` 改名为 `openRightbar`/`closeRightbar`，`dsh-plugin-mobile` 的 details 覆盖层在 0.1.5 上不再生效（有守卫所以不崩），`tests/dsh-mobile-smoke.mjs` 的宿主断言也随 bundle 改名而失败。需要单独处理。
>
> 用途：本会话上下文将满且**压缩功能当前不可用**（原因见 §2），需要在新会话继续。
> 新会话开工前请先读本文件 + `docs/session-repair.md` + 记忆 647 / 894 / 862。

---

## 0. 一句话现状

DSH 已从 0.1.2-rc.1 升到 **0.1.5-rc.1** 并在 pm2 下正常运行；会话日志全库已归一化。
**但 landing（检查点落地）当前失败**，两个互相独立的原因都已用真实数据定位、**都还没修**：

| # | 症状（真实报错） | 根因 | 影响面 |
| --- | --- | --- | --- |
| **A** | `session event "user/message" carries an invalid replace surfaceOp` | 0.1.5 把 replace 操作数从 `{op,start,end}` 改名为 `{op,startSeq,endSeq}`，我们仍在写旧形状 | 所有 landing（即使坐标正确） |
| **B** | `landing: the stored span is no longer a valid replacement target` | v3 日志把事件坐标系换了（不再有 assistant/chunk 事件），magic-context 按 seq 存的 DB 行落在一套已不存在的坐标里 | 升级前生成的 compartment / 段落查找 |

---

## 1. 本轮已完成（不要重做）

### 1.1 会话日志归一化（released-v0 schema → 可迁移）
- `plugins/dsh-plugin-session-repair/lib/normalize.js`（新）：五类违规的审计与改写，**不重排事件序号**。
  1. `command/run.source {kind:"plugin",...}` → `{kind:"user"}`（本插件旧活动行写的）
  2. `command/done.source` 删除
  3. `model/selection` 去掉 `maxTokens` 等未声明成员（0.1.2 host 的 `resolveCallConfig` 结果被原样写入）
  4. `subagent/descriptor` version 2 → 3（仅当其余成员已符合 v3）
  5. `session/title.messageSeqs` / `session/title-llm-request`：必须指向更早的**人类** `user/message`；0.1.2 标题写入器记对了文本却写偏了 seq → 按该行自身记录的文本回正
- `lib/index.js`：`scanSessionFile` 增 `legacyShapes/legacyShapeSample/legacyUnfixable/migrationReady`；`scanWorkspaces` 增 `legacyShapedCount/needsNormalization`；`repairLogFile` 把归一化并入同一次写入（`.bak-<unix-ms>` 备份 + 写后复验）。
- `lib/cli.mjs` 增 `normalize-all [--dry-run] [--skip <id>]... [--min-age-seconds <n>]`；`--min-age-seconds` + 「扫描后 stat 变化就跳过」的乐观锁保护正在被写入的日志。
- 线上结果：**383 会话 / damaged 0 / legacyShaped 0**（可迁移）。原始拒绝是 309/380。
- 前向修复（防复发）：`dsh-magic-context/lib/notifications.js` 活动行改用 `{kind:"user"}`；`lib/dreamer-session.js` 的 `selectionOf()` 与 `dsh-plugin-scheduler` 把路由投影到声明的 `model/selection` 成员；通知冒烟测试交叉校验本插件的扫描器。
- 预演（`~/.dsh-015` 副本 + `~/dsh-015-test` 0.1.5 安装）实测 **378/380 可迁移**；两个永久例外：
  - `session-01f47341…`：5 事件的废弃分叉，头部 `seedLength: 481`，`inheritedEventCount` 确实超事件数 → 只能归档/删除
  - `session-dc85e119…`：一个 0.1.2 时代 landing 的 `shadowedRange.end` 与 300 条 `shadowedSeqs` 中 64 条指向被 v1→v2 吞掉的 `assistant/chunk` 槽位 → 迁移拒绝裁剪，故意不动

### 1.2 升级执行
- 脚本 `~/dsh-upgrade.sh`（脱离式；任何校验失败自动 `npm i -g @deepseek-ai/dsh@0.1.2-rc.1` 回滚并重启，实测未触发）；全过程日志 `/tmp/dsh-upgrade.log`
- 顺序：`pm2 stop` → 停服窗口扫完剩余日志 → `npm i -g @deepseek-ai/dsh@0.1.5-rc.1` → `--dump-config`(172 行) → `pm2 restart`
- 结果：`dsh --version = 0.1.5-rc.1`，pm2 online，`:3080` 401（无 token）/303（带 token），`/magic-context/usage` 200
- 新增断链仅 `node-addon-landlock-run`（上游已移除，预期内）；`dsh-session/./surface` 等我们依赖的子路径仍在
- 新入口 URL 写在 **`~/.dsh/last-launch-url.txt`**（旧标签页会 401）

### 1.3 记忆
- 647（session-repair 五类日志问题，含 0.1.5 迁移闸门）、894（升级/预演资产与包/槽位/导出兼容结论）已更新；862（精确 token 计账）为本轮更早的成果。

---

## 2. 必须修的两个问题（含证据与修法）

### A. replace surfaceOp 键名改名 —— 小改动、收益最大，建议先做

**证据**
- host 校验：`@deepseek-ai/dsh-session/lib/index.js:262-264`
  ```js
  function isReplaceOp(value) {
    return Object.keys(op).length === 3 && Object.hasOwn(op,"op")
      && Object.hasOwn(op,"startSeq") && Object.hasOwn(op,"endSeq") && op.op === "replace" && ...
  }
  ```
  报错文本见同文件 `:279`。
- 我们仍在写旧形状：`plugins/dsh-magic-context/lib/landing.js:169`
  ```js
  surfaceOp: { op: "replace", start: compartment.start_seq, end: compartment.end_seq },
  ```
  （同文件 `:162/:183` 的 `shadowedRange: {start,end}` **不用改**——实测 v3 里 `compaction/summary.shadowedRange` 仍是 `{start,end}`）
- 受害会话：`session-078919ac-…`（blackhand-rewrite），gen7 范围 `1988-2008`（**实时坐标**），因此纯粹被键名挡住
- 探针已验证可行（host 自己的校验器可判别两种形状）：
  ```js
  const surface = await import("@deepseek-ai/dsh-session/surface");  // 注意是 ./surface 子路径
  surface.validateSurfaceMetadata({ type: "user/message", seq: 5, surfaceOp: { op:"replace", startSeq:3, endSeq:3 } }) // 通过
  surface.validateSurfaceMetadata({ type: "user/message", seq: 5, surfaceOp: { op:"replace", start:3, end:3 } })     // throws "invalid replace surfaceOp"
  ```

**修法**
1. `plugins/dsh-magic-context/lib/session-compat.js` 增 `replaceSurfaceOp(start, end)`：memoized 探针（上面两条各试一次）决定形状；探针不可用时的兜底请保守（0.1.2 时代用 `start/end`，可用安装的 dsh-session 版本号兜底）。
2. `landing.js` 改用它。
3. 测试：`tests/dsh-context-landing-smoke.mjs` 断言「产出的 surfaceOp 能被 host 自己的校验器接受」，这样下次 host 改名会直接挂测试。
4. 验证：mirror 后用 `session-078919ac`（实时坐标的 gen7）实盘落地成功即通过。

### B. v3 事件坐标系变化 —— 用户已批准的「坐标重建」

**证据（实测，本次会话 `session-390452a4`）**
| | v0（升级前） | v3（升级后） |
| --- | --- | --- |
| 存储行 | 18,331 | 2,965 |
| 事件数（seq 空间） | **439,338** | **2,965**（连续 0..2964） |
| assistant/chunk 事件 | 有（reasoning/text/tool-call chunks + chunk 行） | **完全不存在** |
| 新增事件类型 | — | `system/message`、`request/header`、`request/context`（每轮各一） |

- 迁移插入了 `system/message`（id 前缀 `v2-to-v3-system-`），所以新序号 ≠ 旧序号±常数，而是一次**过滤（去 chunk）+ 插入**的重新编号。
- 受害：本会话 gen5 `compartments` 行（id 438）range `342402-419750` 是 v0 坐标 → `landing.js:122 validateRange` 抛错（报错见 §0.B）。
- 影响面：`paragraphs` 2292 行中 **1176 行** seq 落在实时窗口内（→ `paragraphFor()` 错误命中，§N§ 前缀会挂错消息），另 1114 行是纯 miss（走 `range.js` 的 `fallbackParagraph`，安全）；`compartments` 5/5 `end_seq` 越界；`memories.source_start_seq/source_end_seq` 同样是旧坐标。
- 注意 `range.js` 是走 `session.surface.nodes` 的（DB 只做优化），所以**新生成**的 compartment 范围是实时坐标 ✓（078919ac gen7 = 1988-2008 即证据）。也就是说：只修 A，活跃会话就能靠新 compartment 继续压缩；B 影响的是历史行的正确性与旧 compartment 的落地。

**修法（设计已定）**
1. 新 `plugins/dsh-magic-context/lib/coordinates.js`：
   - `replayParagraphs(session)`：按**实时事件流**回放段落分配器（复用 `paragraphs.js` 的跳过规则：`tool/call`、全为排除工具的 assistant message、配套排除工具的 tool/result）→ `[(seq, paragraphNo)]`
   - `rebuildSessionCoordinates(cdb, session, {formatVersion})`：先由旧行与新回放算出 `paragraph_no → (oldSeq, newSeq)` 映射；再在一个事务里重写 `paragraphs`、按段落号平移 `skip_marks.seq`、用段落号把 `compartments.start_seq/end_seq` 与 `memories.source_start_seq/source_end_seq` 映射过去；最后写纪元标记
2. `db.js`：新表 `session_epochs(session_id PRIMARY KEY, format_version, events, rebuilt_at)` + 读写函数（幂等靠它；已在正确坐标的会话直接打标记返回）
3. 引擎：`agent/session-start`（resume）时若纪元 ≠ 实时格式版本 → 重建；`session/created` 直接打标记
4. 离线入口：`plugins/dsh-magic-context/scripts/rebuild-coordinates.mjs`（处理已迁移的 3 个会话：`390452a4`、`c71b3623`、`078919ac`），写前 **`VACUUM INTO $DSH_HOME/magic-context/backups/context-<ts>.db`**
5. landing 自愈：`validateRange` 失败且 compartment 有 `start_para/end_para` 时，用当前段落表重推 span 并更新该行后重试一次（让升级前生成的 ready compartment 也能落地）
6. 测试：`tests/dsh-context-*.mjs` 补「v0 行 → v3 回放后 seq 对齐」「映射后 compartment 仍能 validateRange」「幂等（第二次调用不动数据）」

---

## 3. 用户已批准、尚未开工的其他项

1. `dsh-plugin-usage`（`lib/collect.js` / `lib/index.js`）：改读**最高世代** `session.vN.jsonl.zstd`，否则迁移过的会话仪表盘读到冻结的 v0 文件
2. `tests/dsh-session-repair-smoke.mjs`：`dsh-session` 的 `decodeStorageRecord` 在 0.1.5 **已移除**（同包仍导出 `foldSurface`/`decodeSeqRanges`，`./surface` 子路径仍在）→ 换成本插件自己的展开逻辑；顺带给 `dsh-plugin-session-repair` 的 **v0 专属规则加版本门控**（v3 日志没有 chunk、`surfaceOp` 用 `startSeq/endSeq`，`shiftRow` 需要同时处理两种形状）
3. （用户未选）npm 拦截的 5 个安装脚本：`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`@google/genai`、`protobufjs`；需要时 `npm i -g --allow-scripts=...`（会再要一次重启）。目前 bash 等均正常。

---

## 4. 操作约束（本轮踩过的坑，务必遵守）

- **agent 自身跑在 pm2 的 dsh 进程里**：任何 `pm2 stop/restart dsh` 都会杀死 agent 自己的 bash 调用。需要停服的多步操作必须写成**脱离脚本**（`setsid nohup bash -c 'trap "" TERM HUP INT QUIT; ...' &` + 输出重定向到文件），否则会留下停摆的服务。范例见 `~/dsh-upgrade.sh`。
- **DB 写入前必须备份**：`VACUUM INTO $DSH_HOME/magic-context/backups/…`。
- **`plugins/` 是唯一真源**：改完 `rsync -a --delete --exclude 'node_modules/' plugins/<p>/ ~/.dsh/profiles/node_modules/<p>/`，测试读安装副本。
- **会话日志只许经 `dsh-plugin-session-repair` 改写**（routes 或 CLI），它自带 `.bak-<unix-ms>` 与写后复验；手工 `zstd -f` 正是单帧事故的来源。
- 重启：`pm2 restart dsh`（用户本轮已明确授权升级+重启；平时仍需先问）。
- 归一化/扫描线上库时用 `--min-age-seconds`（活跃会话会被跳过，停服窗口再补扫）。

---

## 5. 环境速查

```
DSH 0.1.5-rc.1          /home/mon3tr/.local/bin/dsh（npm prefix -g = /home/mon3tr/.local）
pm2 app                 dsh（:3080，`pm2 restart dsh`）；脚本 /home/mon3tr/dsh-upgrade.sh
新入口 URL              ~/.dsh/last-launch-url.txt
DSH_HOME                /home/mon3tr/.dsh
会话日志                 $DSH_HOME/sessions/<project-key>/<session-id>/session{.v3,}.jsonl.zstd
上下文 DB               $DSH_HOME/magic-context/context.db（备份目录同层 backups/）
工作区（真源）           /home/mon3tr/dev/dsh-dotfile
运行副本                 ~/.dsh/profiles/node_modules/dsh-*
预演资产                 ~/.dsh-015（DSH_HOME 副本）、~/dsh-015-test（0.1.5 安装）、探头脚本 probe-migrate*.mjs
升级日志                 /tmp/dsh-upgrade.log（+ /tmp/live-*.json、/tmp/dsh-links-{before,after}.txt）
当前受害会话             session-390452a4（本会话，坐标断裂）、session-078919ac（键名问题）
```

---

## 6. 建议的开工顺序

1. **先修 A**（~30 行 + 测试）：`session-compat.js` 探针 + `landing.js` 形状 + landing smoke 断言 → mirror → 用 `session-078919ac` 的 gen7 实盘落地验证。
2. **再修 B**（坐标重建 + 自愈 + 离线脚本 + 幂等标记），先离线跑 3 个已迁移会话（含本会话），再接入 resume 自动触发。
3. **收尾**：§3 的 usage 世代读取 + session-repair 版本门控/测试修复；跑全量 context 套件（`node tests/dsh-context-*.mjs`）与 `dsh-session-repair-smoke`。
4. 期间如需结论性证据，可用 `~/.dsh-015` 里的 378 对 v0/v3 双份文件做批量统计（不要碰线上）。
