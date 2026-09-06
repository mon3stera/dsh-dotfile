# 事故报告：单帧容器日志导致 dsh 全 profile 启动失败（2026-09-06）

> 范围：`~/.dsh` 会话存储 + `dsh-dotfile` 仓库的 `dsh-plugin-session-repair`。
> 状态：已修复并验证。本报告供与开发该插件的 Agent 讨论使用。

## 0. 摘要

dsh 启动崩溃与之前修复的「backward seq gap」是**两种不同的损坏**。本次是**容器格式**问题：
一个会话日志被整体压缩成了**单个 zstd frame**，而 dsh 每次启动会对 `~/.dsh/sessions` 下
每一个 `session.jsonl.zstd` 校验「第一个 frame 解压后必须恰好是 header 一行」。一个坏文件
就让**所有 profile 启动失败**（fail-closed）。

修复方式：把该文件内容**字节级**重编码为合规两帧容器（frame1 = header 行，frame2 = 全部事件），
内容零改动；已用原启动命令实测通过。

## 1. 现象

启动命令（21:20 失败现场）：

```bash
dsh --profile web --port 3080 --trusted-host arch-265k.tailaaabe9.ts.net --no-open
```

报错链（已精简）：

```
dsh: plugin tree failed to load: ... workspace (@deepseek-ai/dsh-workspace):
  corrupt Zstandard session log: first frame is not exactly one header line
    at assertZstdHeaderFrame (dsh-session-persistence-jsonl/lib/index.js:792)
    at Proxy.readFirstZstdLine (...:1374)
    at Proxy.listArtifacts (...:1143)
    at Proxy.list (...:1103)
    at [cordis.init] (dsh-workspace/lib/index.js:324)
```

## 2. 根因机制

dsh 的 workspace 服务在启动初始化时调用 `sessionPersistence.list()`，它会遍历
`~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` 的**每一个**日志：

1. 只解**第一个 frame**（`readFirstZstdLine`）；
2. `assertZstdHeaderFrame` 断言其解压结果**恰好是一行 header + `\n`**（无第二个换行）；
3. 任何文件不满足 → 整个 boot 中止。

事故文件（全库 249 个日志中唯一失败者）：

```
~/.dsh/sessions/--home-mon3tr-dev-dsh-dotfile--/
  session-dc85e119-5659-4d0c-9c68-82eb5c519e47/session.jsonl.zstd
```

它整份日志（17,256 行 / 6,745,730 B）被压成 **1 个 frame** → 第一个 frame 解出来是
整个多行日志，而非 header 一行 → 触发上面的断言。日志**内容本身是健康**的（见 §3）。

## 3. 证据

### 3.1 目录内三个文件对照

| 文件 | size | frames | 解压 | seq 扫描 | 判定 |
|---|---|---|---|---|---|
| `session.jsonl.zstd`（修复前） | 1,009,095 B | **1** | 6,745,730 B / 17,256 行 | ok（133,765 events，`turn/end` 收尾） | 内容=最新修复版；**容器坏** |
| `session.jsonl.zstd.bak-broken-surfaceop` | 1,007,162 B | 2 | 同上（少两处 surfaceOp 修正） | ok | 20:40 修复版；**容器对** |
| `session.jsonl.zstd.bak-1788698447233` | 3,557,045 B | 2 | 17,259 行 | **坏**（row 6344：expected 53419, got 53413） | 原始 seq-gap 损坏日志 |

内容差异（`bak-broken-surfaceop` → 修复前 `session.jsonl.zstd`，恰为 commit `b955ebc`
「shift landed surfaceOp replace ranges」的改动）：

- line 10361：`surfaceOp {"op":"replace","start":9,"end":64979}` → `"end":64982`
- line 14154：`surfaceOp {"op":"replace","start":83501,"end":83501}` → `"start":83504`

即：当前文件是 surfaceOp 已平移的**最终修复版**，仅容器被写坏。

### 3.2 写入方判定

- 插件备份命名恒为 `.bak-<unix-ms>`（`index.js:268`）；`.bak-broken-surfaceop` 不是插件产物。
- 全仓库 grep 无任何代码/脚本生成该名字或执行「整文件单帧压缩」。
- 结论：20:50 的写入是**仓库外的手工操作**（zstd CLI 一次性整文件压缩），绕过了插件
  `compressLog` 的两帧编码（`index.js:67-91`，注释即引用 `assertZstdHeaderFrame`）。

### 3.3 为何“修好了”却没被发现

- dsh 只在**启动**时做全量 list（首帧校验）；已运行中的实例不会重扫 → 20:50 写入后，
  若进程未重启则无感，下次 boot 才炸（21:20）。
- 插件 `scanSessionFile` 的 `corrupted = !scan.ok` 只看 **seq 连续**；本文件 seq 健康
  → 插件的扫描/修复 UI 会把它判为 healthy，`repair` 路由返回 409（拒绝处理）。

## 4. 时间线

| 时间 | 事件 |
|---|---|
| 15:48 / 15:56 | 插件创建；`df5d6b0` 提交「repair six seq-corrupted session logs」 |
| 20:40:47 | `handleRepair` 备份原始损坏日志 → `.bak-1788698447233`，写出 2-frame 修复版 |
| 20:48 | `repair.js` 更新（commit `b955ebc`：surfaceOp replace 区间随 renumber 平移） |
| 20:50:54 | **仓库外手工重写**：旧修复版 → `bak-broken-surfaceop`；新写 `session.jsonl.zstd`（含 surfaceOp 平移，但整文件单帧） |
| 21:18–21:20 | 其他 dsh 会话正常写入（`session-baf7fef5`、`session-69c96f7a`），说明运行中的实例无感 |
| 21:20 | 用户启动 web profile → workspace 初始化读到此文件 → 崩溃 |
| 21:23–21:25 | 排查、修复、验证（§5） |

## 5. 修复与验证

1. 原单帧文件完整备份 → `session.jsonl.zstd.bak-singleframe-1788701134692`（1,009,095 B）。
2. **字节级重编码**（不解析/重写 JSON）：按第一个 `\n` 切分 →
   - frame1 = 198 B header 行（压缩）
   - frame2 = 其余 6,745,532 B（压缩）
   - 两帧拼接，同目录 staging + rename（原子替换）。
3. 验证：
   - 重编码后解压内容与修复前**逐字节一致**（6,745,730 B）；
   - seq 扫描 `ok=true`（133,765 events）；
   - 全库 249 个日志首帧校验 **0 失败**；
   - 用原命令真实启动：**成功**（`dsh web: http://127.0.0.1:3080/…`），随后已关停测试实例。

当前目录文件清单：

```
session.jsonl.zstd                             1007166 B  2 frames（合规，修复后）
session.jsonl.zstd.bak-singleframe-1788701134692  1009095 B  1 frame（修复前原样）
session.jsonl.zstd.bak-broken-surfaceop        1007162 B  2 frames（20:40 修复版，surfaceOp 未平移）
session.jsonl.zstd.bak-1788698447233           3557045 B  2 frames（原始 seq-gap 损坏）
```

## 6. 与 Agent 的讨论要点

### 已有基础（HEAD 已具备，无需重做）

- `compressLog` 正确输出两帧（frame1=header + frame2=事件），注释引用 DSH 的首帧断言。
- smoke test 已有容器回归断言：
  - `verifyFrameLayout`（`tests/dsh-session-repair-smoke.mjs:63-90`）：frame1 必须恰为
    header 行、各 frame 拼接须完整还原 JSONL；
  - `check("repaired file keeps the header-frame container layout", ...)`（:334）；
  - 单帧写入 helper `writeLog`（:92）已存在，可直接用于新用例的 fixture。

### 盲区 1：扫描/修复只认 seq gap，看不见「容器坏、seq 健康」的日志

`scanSessionFile`（`index.js:134`）的 `corrupted` 仅由 seq 连续决定；本次事故文件 seq 健康，
会被报告为 **healthy**，`repair` 返回 **409**——即插件自己的 UI 无法发现、也无法修复
本次这类 boot-brick 文件（即使 dsh 能启动）。

建议：

- `scanSessionFile` 增加容器校验（复用 smoke test 的 `verifyFrameLayout` 逻辑：首帧 == header 行），
  以独立字段标记（如 `corrupted: true` + `reason: "container"`，或新增 `containerBroken`），
  保持向后兼容；
- `repair` 对「容器坏、seq 健康」的日志提供 **re-containerize**（重编码，不动事件内容），
  而非 409 拒绝；
- smoke test 增加用例：`writeLog` 生成的**单帧健康日志** → scan 应标记、repair 应能修复为两帧。

### 盲区 2：post-write verification 只扫 seq

`handleRepair` 的写后验证是 `scanRows(...)`（`index.js` 的 verify 段），不含容器结构校验。
若 `compressLog` 未来回归，坏容器要等到**下次 dsh 启动**才爆炸。建议验证叠加
frame-layout 检查（即 `verifyFrameLayout` 的语义）。

### 盲区 3：修复工具跑在 dsh 进程内，boot-brick 日志让它不可达（死锁）

`/session-repair/*` 路由依赖 dsh 启动完成，而 workspace 初始化对坏容器 fail-closed。
可选方向：

- (a) 给插件增加**可脱离 dsh 运行的 CLI 入口**（如 `node lib/cli.mjs scan|repair <logPath>`），
  复用手工修复时的两帧重编码逻辑——本次修复即是该原型的雏形；
- (b) 上游 dsh（`dsh-session-persistence-jsonl` / `dsh-workspace`）把启动 list 改为
  **隔离/跳过坏文件 + 告警**，而非整个 boot 失败（对 UI 工具而言，一个坏日志拖垮全部
  profile 值得商榷）；超出插件范围，可考虑提 issue。

### 盲区 4：写入路径纪律与可追溯性

20:50 的写入绕过了插件代码路径，备份命名也不符 `.bak-<ts>` 约定，事后无法从仓库追溯
「谁、用什么命令、改了什么」。建议：

- 所有日志重写只走插件唯一代码路径（或明确入仓库的脚本），保持 `.bak-<ts>` 命名；
- 将「离线手工修复配方」（两帧重编码）补进 `docs/session-repair.md`，避免再次出现
  「zstd 整文件压缩」类手工操作；
- 本次事故文件的 20:40 备份（seq-gap 原始现场）可作回归测试 fixture 素材。

### 备注

- 本次文件并非 seq-gap 事故复发，而是修复流程暴露的**第二类损坏**（容器）。
- 21:20 崩溃前的运行中实例不受影响——这解释了为何「修完没重启就一直没事，一重启就炸」。

## 7. 附录：巡检/复现要点

独立巡检 = 遍历 `~/.dsh/sessions/**/session.jsonl.zstd`，按 zstd magic
（`28 b5 2f fd`）定位各 frame 边界，只解**第一个 frame**，断言解压结果恰好是
`header 行 + \n`（与 `assertZstdHeaderFrame` 同语义）。本次全库 249 个文件仅
`session-dc85e119` 一个失败。该逻辑已等价存在于 smoke test 的 `verifyFrameLayout`，
可直接提升为 `scanSessionFile` 的容器校验。
