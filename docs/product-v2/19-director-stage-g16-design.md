# 19 — G16 Director Stage 设计文档（v2.0）：导演 IR 与镜头指令契约

日期: 2026-09-03
状态: **设计稿 —— 导演 IR 契约冻结，待实现（G16 当前 NOT_STARTED，见第七节审计）**
权威依据:
- `moling-control/governance/blueprint-v2.0/00_MASTER_BLUEPRINT_V2.0.md` §2.3 / §12 Director Stage / 3D Previz / §27 Gate 列表
- `moling-control/governance/blueprint-v2.0/04_AI_MEDIA_AGENT_SPEC_V2.0.md` §1 Capability Registry / §8 Video Rewrite Intent / §10 Frame-by-frame Analysis / §13 AutoLink / **§14 Director Stage** / §19 Agent Tool（`director.get/update/render`）/ §21 Approval
- `moling-control/governance/blueprint-v2.0/05_ACCEPTANCE_EXECUTION_SPEC_V2.0.md` G16 验收
- `moling-control/runtime/blueprint-v2/gates/LEDGER.md` G13 / G15 / G16 行，`G13_acceptance.json` / `G15_acceptance.json`

> 本文只冻结**导演中间表示（IR）与转换/落库契约**，不实现。G16 在治理台账中为 NOT_STARTED：仓库现存 director 痕迹全部是词表/文档级（见第七节），无任何实现可破坏。后续实现 Gate 以本文为冻结契约，逐条对照 05 spec 的 G16 验收项（object/camera/light、preview、generation reference）交付。

---

## 一、目标与边界

### 1.1 定位

G13 已把剧本落成**行模型**（6-kind 行：`dialogue / action / transition / parenthetical / header / shot_direction`，`server/modules/script/scriptModel.cjs` + 迁移 `0039_script_rows`）。行模型是"文本事实"，还不是"可执行的镜头意图"。

G16 Director Stage（本设计文档所覆盖的**导演阶段**）在行模型之上补一条确定性流水线：

```text
script_rows（G13 已落，6-kind 行模型）
      │  ① 场景分组（复用 buildSceneRows）
      ▼
  导演节拍 Beat（语义块，引用 scriptRowIds）
      │  ② 节拍划分规则（纯函数）
      ▼
  镜头指令 ShotDirective（分镜意图：intent / action / subjectRefs / camera / durationMs / audio）
      │  ③ 每 beat 默认 1 镜起步 + 字段推导（纯函数）
      ▼
  shots 落库（复用 0017 + 0022 表结构）→ 画布节点 → Studio Run Engine（G15 已 PASS）执行生成链
```

一句话：**本文冻结「script rows → 导演节拍 → 镜头指令 → shots 落库」的确定性契约**。上游是 G13 行模型（已落），执行下游是 G15 run 引擎（已 PASS）驱动的真实生成（provider 阶段）。

### 1.2 明确不做的事（Out of Scope）

| 不做 | 理由 / 依据 |
|---|---|
| 真实 AI 导演推理（节拍划分、镜头语言决策、正反打判断） | 属 provider / 模型阶段。04 §1 Capability Registry 与 §19 Agent Tool 管辖；推理结果**唯一合法输出形态就是本文 §二 的 IR**，不许绕开 IR 自由发挥（对齐 00 §28「不存在 LLM 自由执行任意代码的后门」） |
| 3D Previz 本体：DirectorObject / DirectorCamera / DirectorLight 的变换操作、相机预览、参考渲染 | 属 04 §14 与 00 §12 的 Director Stage Workspace；`director.object.* / director.camera.update / director.light.update` 命令词表已在 envelopes.cjs / collabContract.cjs 冻结（仅词表），UI/实现属后续波次（见 §五） |
| Blender Add-on / scene manifest 传输 | G17 协议已冻结（doc 16），与本文相互独立，仅共享 shot / asset_version 实体契约 |
| 图像/视频生成执行本身 | 生成由 Generation V2 + run 引擎执行；本文只产出**镜头指令**，是生成 reference 的语义前件 |
| 新增数据库迁移 / 修改既有表 | 本文不改任何 schema；0022 shots 扩展字段足以承载 IR 输出（见 §四） |
| 任何 UI 组件（节拍编辑器、镜头列表、previz 面板） | G13 storyboard / G16 编辑器的 UI 均属后续波次（见 §五） |
| 修改任何既有文件 | 本文为纯新文档；仓库 audit 见第七节 |

> 边界原则：本文是一条**薄而确定的文本→镜头指令契约层**。真实导演判断（文学性的镜头选择）属于 provider；确定性拆分与落库属于本文。两者通过 §二 IR 单点耦合——provider 输出若不满足 IR 校验，不落库。

### 1.3 设计约束（继承既有工程约定）

- **纯函数**：转换与校验函数无 I/O、无 DB、无随机（与 `scriptModel.cjs` 同风格，全部确定性、可单测）。
- **稳定 id 引用**：IR 内所有交叉引用使用稳定 id，不内嵌可变对象（见 2.4）。
- **整数毫秒**：所有时长为非负整数毫秒（0039 迁移注释的项目级约定）。
- **可幂等**：同输入重算 → 同输出 → 落库 upsert 语义友好（对齐 00 §3.6 高成本动作可估价幂等审计、G20）。
- **{ok, errors} 返回约定**：与 codebase 一致（见 budget.cjs / scriptModel.cjs）。

---

## 二、导演 IR 契约

IR 是本文冻结的核心。它定义两层结构：**Beat（导演节拍）**与**ShotDirective（镜头指令）**。约定：接口字段名以 camelCase 表达（与既有 JSONB/API 风格一致），落库映射见 §四。

### 2.1 设计原则

1. **文本可溯**：每个 Beat 引用一段有序 script rows；每个 ShotDirective 引用一个 Beat——从镜头指令能一路追溯到源行。
2. **语义完整但最小**：不表达"文学选择"（那属 provider），只表达"一次镜头决策所需的全部结构化信息"。
3. **位置即身份**：Beat/Shot 的序号是场景内稳定序号，id 由位置合成（2.4），文本编辑产生新位置即新 id，不尝试 diff 保 id。
4. **可空即缺省**：默认值全部显式化，不依赖 `null` 语义（provider 不填也成立）。

### 2.2 Beat（导演节拍）

Beat 是"一场戏内的一个语义块"：一段连续的对话回合、一段动作、或一条镜头指示（`shot_direction` 行天然独立成 beat）。最小契约（含 parent 要求的核心字段）：

```ts
interface DirectorBeat {
  // ── 身份（2.4）────────────────────────────────
  beatId: string;              // 稳定 id，如 "ep-01:s1:b2"
  episodeId?: string;          // 集引用（脚本级为空时省略；单集/自由脚本不填）
  // ── 位置（核心字段）───────────────────────────
  sceneIndex: number;          // 来源 scene_index（G13，缺省 0），>=0 整数
  beatIndex: number;           // 场景内节拍序号，0 起连续
  // ── 语义（核心字段）───────────────────────────
  summary: string;             // 节拍一句话语义（非空；来源行文本摘录，见 3.2）
  scriptRowIds: string[];      // 有序引用 script_rows.id，非空，覆盖无重叠
  // ── 派生信息 ──────────────────────────────────
  kind: BeatKind;              // 见下，由组内行 kind 推导
}

type BeatKind = 'dialogue' | 'action' | 'hybrid' | 'transition';
```

`kind` 推导规则：组内含 dialogue 且含 action/shot_direction → `hybrid`；全 dialogue（含 parenthetical）→ `dialogue`；全 action / shot_direction → `action`；transition-only → `transition`。

### 2.3 ShotDirective（镜头指令）

一次镜头决策的完整结构化描述（最小契约含 parent 要求的全部字段）：

```ts
interface ShotDirective {
  // ── 身份 / 上游引用 ──────────────────────────
  shotId: string;              // 稳定 id，如 "ep-01:s1:b2:k0"
  beatId: string;              // 引用 DirectorBeat.beatId（stable id）
  // ── 镜头语义（核心字段）───────────────────────
  intent: ShotIntent;          // 'establish' | 'dialogue' | 'action' | 'reaction' | 'transition'
  action: string;              // 镜头内主体动作 / 调度描述（非空；单行推导见 3.3）
  subjectRefs: SubjectRef[];   // 主体引用数组（character / prop / location 稳定实体 id），可为空
  // ── 摄影（核心字段）───────────────────────────
  camera: {
    shotSize: ShotSize;        // 'extreme-wide' | 'wide' | 'full' | 'medium' | 'close-up' | 'extreme-close-up'
    movement: CameraMovement;  // 'static' | 'push-in' | 'pull-out' | 'pan' | 'tilt' | 'track' | 'crane' | 'handheld'
    angle: CameraAngle;        // 'eye-level' | 'high-angle' | 'low-angle' | 'over-shoulder' | 'top-down' | 'dutch'
  };
  // ── 时长（核心字段）───────────────────────────
  durationMs: number;          // 正整数毫秒，默认推导见 3.3
  // ── 声音（核心字段，可选）─────────────────────
  audio?: {
    music?: string;            // 音乐情绪/曲风自由文本提示
    dialogRefs: string[];      // 本镜头下对白行（dialogue kind）的 script_rows.id 引用
  };
}

interface SubjectRef {
  entityType: 'character' | 'prop' | 'location';   // 对齐 04 §13 ReferenceBinding.entityType
  entityId: string;                                  // 稳定实体 id（bible / characters / environments 表 id）
  label?: string;                                    // 展示名（冗余，供 UI/日志）
}
```

枚举说明（对 provider 均开放为可写字段，但必须命中受控词表，校验见 3.5）：
- `ShotSize` 与 04 §10 `VideoAnalysisShot.shotSize` 对齐（同域词表，逆向分析出的 shotSize 可直接回填）。
- `ShotIntent` 与 04 §8 `VideoEditIntent` 分域但兼容：本文 intent 描述"拍什么"，`VideoEditIntent` 描述"改什么"；实现期 intent→editIntent 的映射表放 adapter 层。
- `camera` 三字段必填且不许省略——**默认值显式化**（static / medium / eye-level），杜绝 nil 语义歧义（00 §12 要求 camera preview / focal 支持的语义前件在此层以受控枚举表达）。
- `subjectRefs` 引用的是**实体稳定 id**（character 库 / environments 表 / prop 引用），不是自由文本；speaker 名字符串 → 实体 id 的解析属"场记绑定"，通过 3.3 的 `entityIndex` 可选上下文注入（缺省为空数组，见 3.3）。

### 2.4 稳定 id 命名规则

```text
beatId :  [episodeId ':'] 's' {sceneIndex} ':b' {beatIndex}
shotId :  [episodeId ':'] 's' {sceneIndex} ':b' {beatIndex} ':k' {shotOrdinalInBeat}
```

- `episodeId` 缺省段 = 脚本级（非分集）；`episodeId` 为空时省略前缀。
- `sceneIndex` / `beatIndex` / `shotOrdinalInBeat` 全部 0 起。
- 同一输入（同 episode + 同 rows 顺序）重算 → 字节级一致 id → 落库幂等 upsert 友好。
- 文本编辑改变位置 = 显式产生新 id；旧 id 的 shots 行按 0023 shot_version 语义版本化，不覆盖（00 §3.3 Asset 永不覆盖精神延伸到指令层）。

### 2.5 IR 完整示例

一个场景（1 header + 1 action + 2 dialogue + 1 transition + 1 shot_direction）的推导结果：

```json
{
  "episodeId": "ep-01",
  "schemaVersion": 1,
  "beats": [
    { "beatId": "ep-01:s0:b0", "episodeId": "ep-01", "sceneIndex": 0, "beatIndex": 0,
      "kind": "action", "summary": "夜晚，废弃厂房。林深推门而入。",
      "scriptRowIds": ["row-0001", "row-0002"] },
    { "beatId": "ep-01:s0:b1", "episodeId": "ep-01", "sceneIndex": 0, "beatIndex": 1,
      "kind": "dialogue", "summary": "阿岚：你终于来了。",
      "scriptRowIds": ["row-0003", "row-0004"] },
    { "beatId": "ep-01:s0:b2", "episodeId": "ep-01", "sceneIndex": 0, "beatIndex": 2,
      "kind": "action", "summary": "镜头越过林深肩头推向门口阴影。",
      "scriptRowIds": ["row-0005"] }
  ],
  "shotDirectives": [
    { "shotId": "ep-01:s0:b0:k0", "beatId": "ep-01:s0:b0", "intent": "action",
      "action": "林深推门而入", "subjectRefs": [{ "entityType": "character", "entityId": "char-linshen", "label": "林深" }],
      "camera": { "shotSize": "wide", "movement": "static", "angle": "eye-level" },
      "durationMs": 2500, "audio": { "music": "低气压氛围", "dialogRefs": [] } },
    { "shotId": "ep-01:s0:b1:k0", "beatId": "ep-01:s0:b1", "intent": "dialogue",
      "action": "阿岚开口对白", "subjectRefs": [{ "entityType": "character", "entityId": "char-alan", "label": "阿岚" }],
      "camera": { "shotSize": "close-up", "movement": "static", "angle": "eye-level" },
      "durationMs": 3000, "audio": { "music": "", "dialogRefs": ["row-0004"] } },
    { "shotId": "ep-01:s0:b2:k0", "beatId": "ep-01:s0:b2", "intent": "reaction",
      "action": "过肩推近门口阴影", "subjectRefs": [],
      "camera": { "shotSize": "medium", "movement": "push-in", "angle": "over-shoulder" },
      "durationMs": 2000, "audio": { "music": "紧张节奏渐起", "dialogRefs": [] } }
  ]
}
```

（上例中 `char-linshen`/`char-alan` 为演示用实体 id；实际由 `entityIndex` 上下文注入或留空。）

---

## 三、scriptRows → Beats → ShotDirectives 转换规则（纯函数契约）

### 3.1 总契约

```ts
// 输入：已按 scriptModel 校验/拆分的行 + 可选上下文。输出：导演 IR。全程无 I/O。
directorizeRows({ episodeId, rows, entityIndex? }) 
  → { ok: true, ir: { episodeId, schemaVersion, beats[], shotDirectives[] } }
  | { ok: false, errors[] }

// entityIndex?: { [speakerOrLabel: string]: { entityType, entityId } }
//   speaker 名 → 实体 id 的场记绑定表（由上游 bible/autoLink 提供）；缺省空。
```

不变量（输出必须满足，供测试断言）：
1. **全行覆盖**：`beats[].scriptRowIds` 的并集 = 输入全部 rows 的 id，无遗漏、无重复、无跨场景混组。
2. **保序**：行序在 beats 间与 beats 内严格保持输入顺序；镜头序 = `(sceneIndex, beatIndex, shotOrdinal)` 字典序。
3. **确定性**：同输入（含同 entityIndex）→ 字节级同输出。

### 3.2 阶段 P1：场景分组 → 节拍

前置：按 `scriptModel.buildSceneRows` 做场景分组（scene_index 升序、组内行序不变）。组内再按下列**优先级序**切分为节拍：

| 优先级 | 触发行（kind） | 切分规则 |
|---|---|---|
| 1 | `shot_direction`（`>` 开头行） | **独立成 1 个 beat**（kind=action）。镜头指示行天然是"镜头边界"，文本进 summary/action（3.3） |
| 2 | `action` | 连续 action 行为 1 个 beat（被打断即切分） |
| 3 | `dialogue` | 连续对话段（含往返）为 1 个 beat；被 action/header/shot_direction 打断即切分。parenthetical 跟随其所属 dialogue |
| 4 | `transition` | **不独立成 beat**：归属其前一个 beat 尾部作为结束标记；若为场景首行，归属其后第一个 beat 头部 |
| 5 | `header` | **不独立成 beat**：归属其后第一个非 header 组作为"开场上下文"；若后无组，归属本场景最后一个 beat |

归属兜底规则保证全行覆盖：任何行最终必属一个 beat；仅含 header 的空场景产出 1 个 summary beat（kind=action，text=header）。

`beatIndex` 在场景内 0 起连续。`summary` 推导：取组内第一条 action 行全文；无 action 则取第一条 dialogue 的 `"SPEAKER: 文本摘录"`（截断 120 字符）；transition-only 取 transition 文本。

### 3.3 阶段 P2：节拍 → 镜头指令

基数规则（**默认 1 镜起步**）：

| 规则 | 说明 |
|---|---|
| R1 默认基数 | 每个 beat 产出 **1 个** ShotDirective（1:1 起步） |
| R2 显式扩镜 | 仅当调用方传入 `expandShots` 重写映射（按 beatId 给出 N>1 的指令列表）时产生多镜；默认契约不自动扩镜 |
| R3 正反打等文学性拆分 | 明确**不做**——属真实导演决策（provider 阶段），其输出必须以 `expandShots` 形式回填并经 IR 校验 |

> R2/R3 的取舍依据：连续对话往返拆成"正反打多镜"是文学判断而非文本事实，纯规则无法无歧义完成（04 §14 Director 输出含 camera intent，由 provider 产出）。本文冻结的确定性契约保证"默认可跑"，同时 IR 结构（`shotOrdinalInBeat`）原生支持 provider 扩镜。

`shotOrdinalInBeat`：beat 内镜头序号，0 起；全片镜头总序 = 落库层按 `(sceneIndex, beatIndex, shotOrdinal)` 排序（§四 seq）。

### 3.4 字段映射表（来源 → ShotDirective 字段）

| 来源 | 目标字段 | 推导规则 |
|---|---|---|
| beat 上下文 | `shotId` / `beatId` | 2.4 id 规则 |
| beat.kind | `intent` | dialogue→`dialogue`；action（含 shot_direction 独立 beat）→`action`；transition→`transition`；hybrid→组内含 action 行取 `action`，否则 `dialogue` |
| beat.summary | `action` | 摘要全文（语义即动作/调度描述）；`establish`/`reaction` 等更细 intent 属 provider 精修 |
| dialogue 行（speaker+text） | `audio.dialogRefs` | 组内全部 dialogue 行的 `id`（按行序） |
| speaker 名 | `subjectRefs` | 查 `entityIndex[speaker]`，命中则注入 `{entityType, entityId, label: speaker}`；未命中或未提供 entityIndex → 空数组（不猜测、不发明实体 id） |
| `shot_direction` 行文本 | `action` | 文本经 `> ` 前缀剥离后作为动作/调度描述 |
| 行 `timing_ms` | `durationMs` | 仅当 beat 恰由 1 行组成且该行给定时使用；否则按 kind 取默认值（下表） |
| —（缺省） | `durationMs` | dialogue→`3000`；action→`2500`；hybrid→`3000`；transition→`1000`（显式正整数毫秒） |
| —（缺省） | `camera` | 恒为 `{ shotSize:'medium', movement:'static', angle:'eye-level' }` —— 全部显式，无 nil |
| transition 行文本 | `intent` + `audio.music` | intent=transition；music 不填（转场不配乐由 provider 定） |

> 本表的本质：**只做"可无歧义推导的搬运与缺省"，不做文学性创造**。所有灰色决策点（镜别/运镜/机位/情绪）落到显式缺省或 provider 精修，保证纯函数可行。

### 3.5 校验纯函数契约（与 scriptModel 同风格）

```ts
validateBeat(beat)                    → { ok, errors }
validateShotDirective(d, { beats })   → { ok, errors }
validateDirectorIR(ir, { sourceRows })→ { ok, errors }
```

关键规则（每条均可单测）：
- Beat：`sceneIndex`/`beatIndex` 非负整数；`summary` 非空；`scriptRowIds` 非空、无重复、指向同一 scene；`kind` 在枚举内。
- Directive：`durationMs` 正整数；`intent`/`shotSize`/`movement`/`angle` 命中受控词表；`camera` 三字段齐全；`beatId` 在 beats 中存在；`audio.dialogRefs` 每个元素必须是 `dialogue` kind 的行 id（跨层引用完整，防"引用对白却配动作行"）。
- IR 总校验：全行覆盖不变量 + 保序不变量 + id 唯一性。

### 3.6 稳定性与幂等语义

- 重算（同输入）产物字节一致 → 落库层可做 `idempotency_key = shotId` 的 upsert（对齐 0015 `idempotency_key UNIQUE(canvas_id, idempotency_key)` 先例；0017 shots 无此列，见 §四绑定缺口）。
- IR 的 `schemaVersion` 固定为 1；演进走 00 §21 schema versioning registry 模式（与 doc 16 的 `migrateDirectorScene` 同策略），不在 IR 层自创迁移。

---

## 四、shots 落库绑定

IR 不是终态——终态是 shots 表中的可执行镜头行 + run 引擎消费的画布节点。本文冻结绑定契约，**不改表、不加迁移**。

### 4.1 复用 0017 + 0022 shots 表结构（映射表）

shots 基表（0017：`episode_id / canvas_node_id / seq / asset_id / duration_seconds / note`）+ W1-09 扩展（0022：`title / story_intent / cinematography / context / generation_meta / output / commerce`，全部 JSONB 带默认 `{}`）。映射：

| ShotDirective 字段 | shots 列 | 说明 |
|---|---|---|
| `shotId`（序） | `seq` | 全片按 `(sceneIndex, beatIndex, shotOrdinal)` 排序后 1 起编号（约束 seq>=1） |
| `beatId` / `episodeId` | `context.story.structure` | JSONB：`{ sceneIndex, beatIndex, shotOrdinal, beatId }`，保留溯源 |
| `beatId` + `beatKind` + `intent` + `scriptRowIds` | `story_intent` | JSONB：拍什么。脚本行引用全程携带 |
| `action` | `title`（截断 200）+ `note` | title 给人看，note 保留全文 |
| `camera.{shotSize,movement,angle}` | `cinematography.camera` | JSONB 子结构；`camera` 受控枚举直落 |
| `subjectRefs` | `context.subjects` | JSONB；实体稳定 id 保留 |
| `durationMs` | `duration_seconds` | `max(1, round(durationMs/1000))`（0017 为秒列；**毫秒精度损失为已知限制**，高精度计时归 timeline 0034 的 ms 语义） |
| `audio.music` / `audio.dialogRefs` | `cinematography.audio` 或 `note` | 一期无独立音轨实体，自由文本进 note，dialogue 引用随 story_intent |
| — | `canvas_node_id` | 见 4.2 绑定缺口；0017 NOT NULL |

### 4.2 run 引擎执行链路（引用 G15 已 PASS）

落库后的执行不属本文实现，但契约必须指向既有链路（治理台账证据：`LEDGER.md` G15 行 PASS，`G15_acceptance.json` status=PASS，`G15` nextGate=G16）：

```text
shots 行 → 画布节点（storyboard / director-stage 节点族）
  → compileStudioGraph（studioRunGraph.cjs：读画布 revision 快照，编译 DAG）
  → studio_runs / studio_run_nodes（0015：QUEUED→…→COMPLETED 状态机，租约/幂等/并发安全）
  → 确定性 executor（studioRunExecutors.cjs，node registry：studioNodeRegistry.cjs）
  → Generation V2 / Asset Finalize（不可变 asset + version）
```

- run 引擎节点注册表已含 `script` 节点（`executionKind: 'SOURCE'`，输出端口 `script`/`text`）——**本文 IR 可直接作为 script SOURCE 的派生产物进入同一 DAG**，无需新执行器。
- 每镜头 1 段视频的批量语义与 doc 08 阶段模型（storyboard → keyframe → video_shot）一致：一个 run = 一组镜头节点；G13 余项的"storyboard 批量绑定"消费本文输出的 shots 行。
- 04 §21 审批：**Agent 修改大量 shot 必须走批准**——IR 重算/批量扩镜属于此类，调用方需先 dry-run（04 §19 `director.render` 可作 dry-run 载体，词表已冻结）。

### 4.3 绑定缺口（诚实记录，本文不承诺解决）

| 缺口 | 现状 | 后续处置 |
|---|---|---|
| `shots.canvas_node_id` NOT NULL，而 IR 自身不含画布节点 id | IR 是"逻辑镜头"，画布绑定（storyboard 节点/子节点）由落库层完成，属实现期工作 | 实现时在画布契约内解析，不新增 IR 字段 |
| 0017/0022 无 `source_beat_id / source_directive_id` 追溯列 | 溯源只能经 `story_intent`/`context` JSONB | 如需列级追溯，作为 additive 迁移候选（走 0022 先例的 ADD COLUMN 模式），不在本文冻结 |
| 0017 `duration_seconds` INT 与 ms 精度 | IR 用 ms，shots 用秒 | 已知限制；timeline（0034，ms）消费 IR/版本化 shots 时以 ms 为准 |
| beats 无独立表 | 不建表，beat 语义冗余进 shots JSONB | 若未来需要 beat 级操作，单独 additive 迁移 |

---

## 五、与 G13 / G16 UI 边界

### 5.1 与 G13 的关系

- 上游：G13 行模型（`scriptModel.cjs` 校验/拆分/分组纯函数 + 0039 落库）已 IN_PROGRESS phase-1（`G13_acceptance.json`：rowModel + pureModel 已落；**CRUD API / storyboard 批量绑定 / UI 未落**）。
- 本文消费其**行数据与纯函数**，不依赖 G13 的 UI/API 是否存在——转换契约与编辑器解耦。
- 本文产出的 shots（分镜意图）是 G13 storyboard 批量绑定与批量视频的输入；G13 收口时以本文 §四 映射为准，避免"storyboard 绑定"与"director IR 落库"双写同一批镜头（doc 08 引导式 meta 的双写问题见 5.4）。

### 5.2 与 G16 本体（3D Previz 导演台）的关系

- Blueprint §12 / 04 §14 的 G16 本体 = DirectorStage Workspace：`DirectorObject / DirectorCamera / DirectorLight` 变换、相机预览、参考渲染、generation reference。这部分**命令词表已冻结**（envelopes.cjs：`director.object.create/update/delete`、`director.camera.update`、`director.light.update`；collabContract.cjs：update=LWW、create/delete=reject-409），实现为零。
- 关系定位：本文 IR 是"**文本侧导演层**"（从剧本到镜头指令），04 §14 是"**空间侧导演层**"（从镜头指令到 3D 场景/相机/灯光）。两者在 **camera intent / generation reference** 处汇合：
  - 本文 `ShotDirective.camera`（受控枚举）→ 04 §14 Director 输出 camera intent / normalized prompt hints 的语义前件；
  - provider 有 structured camera control 时直接映射，否则由 adapter 转 prompt + reference render（04 §14 原文语义）。
- 时间上本文先行（文本→镜头指令是 previz 的输入），空间侧 previz 属后续波次；两者不互相阻塞（与 doc 16 G17 同款"协议先行、实现并行"纪律）。

### 5.3 UI 波次规划（本文一律不实现）

| 波次 | 内容 | 消费契约 |
|---|---|---|
| 0（本文） | IR 冻结 + 纯函数转换/校验 | 无 UI |
| 1 | Beat / 镜头指令列表编辑（只读 IR + 覆盖 expandShots 重写 + 重算预览） | §二 §三 |
| 2 | Director Stage 3D previz 面板（object/camera/light + preview + reference render） | 04 §14 + doc 16 协议 |
| 3 | 引导式流程接入（doc 08 13 阶段模型：storyboard 步进） | §四 shots 行 + doc 08 |

### 5.4 与 doc 08 引导式流程的关系（防双写）

- doc 08 阶段模型在 `story` 阶段已有 `beats[]`（大纲节拍）、在 `storyboard` 阶段有每 scene `[{desc, framing, duration}]`（meta JSON，G1/G8 一期不建表）。
- 对齐规则：doc 08 的 storyboard **meta** 与本文的导演 IR **不应并存两套事实**。实现期二选一：doc 08 storyboard meta 作为 IR 的轻量快照展示层（读 IR），或直接废弃该 meta 改读 shots（写路径唯一 = 本文 §四）。本设计文档立场：**写路径唯一化，读路径可多投影**（00 §3.4 Node 不等于业务实体精神的延伸）。

---

## 六、实现状态

### 6.1 当前状态（如实）

**G16 当前零实现。** 治理台账证据：

| 证据 | 内容 |
|---|---|
| `LEDGER.md` G16 行 | `NOT_STARTED`；审计备注："无 director/beat/shot-list 模块(仅 envelopes 词表)"；nextGate 链 G15→G16 |
| 仓库审计（本文第七节） | director 精确词 20 行 / 7 文件，全部为词表/文档/辅助模块级；无 IR、无转换、无落库、无 UI |
| 数据库 | migrations 0001–0039 无 director 表；0039 唯一 `beat` 痕迹是 `script_rows.beat TEXT` 预留列（未启用） |

与本文相邻的既有件（真实存在，本文只引用不修改）：
- G13 上游：`server/modules/script/scriptModel.cjs`（6-kind 行模型纯函数）+ 0039 迁移；
- G15 执行链：`server/modules/project-foundation/studioRunEngine.cjs`（M05-D1，0015）+ `studioRunGraph.cjs` + `studioRunExecutors.cjs` + `studioShotApi.cjs`（0017/0022 读写）+ `studioNodeRegistry.cjs`（`script` SOURCE 节点）；
- 词表：`studio-contracts/envelopes.cjs` + `collabContract.cjs`（director.* 命令并发语义已冻结）；
- 相邻辅助：`modelhub/projectDirector.cjs`（W4-14 "AI Director" 建议器，纯函数 proposeActions，与本文无耦合）；
- 关联协议：`docs/product-v2/16-blender-protocol-v2.0.md`（G17 冻结，互不依赖）。

### 6.2 本文冻结内容清单（实现 Gate 的对照基线）

1. Beat / ShotDirective IR 结构、枚举、稳定 id 规则（§二）；
2. `directorizeRows` 纯函数转换契约：切分规则表、扩镜规则、字段映射表（§三）；
3. `validateBeat / validateShotDirective / validateDirectorIR` 校验契约（§三）；
4. IR → shots 落库映射表与执行链路指向（§四）；
5. 与 G13/G16 UI、doc 08 的边界（§五）。

### 6.3 G16 验收对照（05 spec G16：object/camera/light、preview、generation reference）

| 05 spec G16 验收项 | 本文对应 | 实现期待办（未做，如实列出） |
|---|---|---|
| object / camera / light | §2.3 camera 受控枚举（语义前件）；04 §14 对象结构 | 3D previz 面板 + `director.object/camera/light` 命令落地（波次 2） |
| preview | §4.2 run 渲染链路指向 | 相机预览渲染接入 director-stage 节点（波次 2） |
| generation reference | §2 IR（intent/action/subjectRefs/camera）→ §4 story_intent/cinematography 落库 | shots → 生成节点 reference bindings 接线（波次 1 收口） |

### 6.4 Gate 纪律

- 00 §27：不能跳 Gate 宣称完成。本文是**设计稿，不是 PASS 声明**；G16 排在 G13 收口之后（LEDGER：G13 IN_PROGRESS 余 CRUD API + storyboard 绑定 + UI；G15 PASS nextGate=G16）。
- 实现期按 00 §28 硬规则输出 CURRENT STATE / TARGET CONTRACT / GAP / FILES / DB IMPACT / API IMPACT / TEST PLAN / ROLLBACK PLAN；结束以 JSON 结论汇报，禁止"功能基本完成"式结论。
- 测试纪律：转换/校验函数为纯函数 → vitest/node:test 直接断言不变量（3.1 三条 + 3.5 规则），对照 G13 scriptModel 19/19 与 G15 runEngine 10/10 的既有测试标准。

---

## 七、仓库现状审计（director 痕迹）

### 7.1 审计范围与命令

范围：`/mnt/c/Users/Administrator/github_ai_online` 的 `server/ src/ docs/` 三区。命令：

```bash
grep -rIwni 'director' server/ src/ docs/     # 精确词（-w，排除 directory 伪命中）
grep -rIwni 'beat'     server/ src/ docs/
grep -rIi 'shot.list'  server/ src/ docs/
grep -rIlni 'shot'     server/ src/ docs/     # 通用镜头词（子串）
ls server/modules | grep -Ei 'director|beat|stage'   # 模块目录
ls server/db/migrations/                               # 迁移文件
```

### 7.2 统计

| 词 | 文件数 | 行数 | 语义判断 |
|---|---|---|---|
| `director`（精确词） | **7** | **20** | 全部词表/文档/命名相邻辅助，见 7.3 |
| `beat`（精确词） | 4 | 5 | 无节拍 IR 结构（0039 预留列 + 注释/测试字符串），见 7.3 |
| `shot list` / `shotList` | 0 | 0 | 不存在"镜头清单"模块 |
| `shot`（子串，镜头/分镜通用词） | 124 | 800 | 既有镜头基础设施（shots 表族/API/timeline/测试），与"导演指令 IR"不同层，是本文落库目标与下游 |
| director/beat/stage 模块目录 | 0 | — | `server/modules` 下无任何 director/beat/stage 目录 |
| director 相关 migration | 0 | — | 0001–0039 无 director_* 表；0039 `beat` 列为预留 |

### 7.3 director / beat 痕迹分类明细

**A. 契约词表（token 级冻结，非实现）—— 5 文件 / 17 行**
- `server/modules/studio-contracts/envelopes.cjs`：`NODE_TYPES_MOLING` 含 `'director-stage'`；`COMMAND_TYPES` 含 `director.object.create/update/delete`、`director.camera.update`、`director.light.update`；`FORMAT_REGISTRY` 含 `directorScene: 1`。
- `server/modules/studio-contracts/envelopes.test.cjs`：`isKnownNodeType('director-stage') === true` 断言（词表守卫测试）。
- `server/modules/studio-contracts/collabContract.cjs`：director.* 更新类命令并发策略（update=LWW、create/delete=reject-409）。
- `server/modules/studio-contracts/collabContract.test.cjs`：上述策略的守卫测试。

**B. 命名相邻的辅助模块 —— 1 文件 / 2 行**
- `server/modules/modelhub/projectDirector.cjs`：W4-14 "AI Director" project-context facade（纯函数 `proposeActions`，建议 CREATE_STRUCTURE_SHOT_LEAF / APPLY_CONTINUITY / SEED_SHOTS）。语义是"按当前产品上下文的确定性建议器"，与 3D previz / 镜头指令 IR 无耦合，仅命名域相邻。

**C. 文档引用 —— 2 文件 / 8 行**
- `docs/product-v2/16-blender-protocol-v2.0.md`（G17）：Director Stage 作为协议上下文、`moling-director-scene` manifest 格式、G16 主链与协议的独立性声明。
- `docs/product-v2/18-collaboration-g22-audit.md`：COMMAND_TYPES 33 种中 director.* 词表审计记录。

**D. beat 痕迹 —— 5 行 / 4 文件（全部非 IR 结构）**
- `server/db/migrations/0039_script_rows.sql`：`script_rows.beat TEXT` 预留列（G13 phase-1 未启用）。
- `server/modules/script/scriptModel.cjs` 注释（"action beat" 措辞）；`scriptModel.test.cjs` 的 `(beat)` parenthetical 用例（剧本格式测试串）；`server/tests/integration/studio-run-engine.test.cjs` 注释（"may beat BOTH creates" 英文动词）。

**E. "directory" 伪命中（不计入精确词统计）**
`server.js`、`src/shared/state/queryClient.ts`、`ProjectsPage.tsx`、`BACKUP.md`、`disaster-recovery.test.cjs`、`ai-control-provider.test.cjs`、`COMMERCIAL_SINGLE_NODE_GAP_MATRIX.md` 等命中均来自单词 "directory" 的子串 `director`。

### 7.4 审计结论

1. G16 Director Stage **当前无任何实现**：无 IR 结构、无转换/校验函数、无 shots 绑定、无 previz UI、无专属 migration——与治理台账 `LEDGER.md` G16 = NOT_STARTED 的审计结论一致。
2. 既有痕迹分三层且互不构成实现：**词表层**（envelopes/collabContract，director.* 命令名与并发语义已冻结，可供后续实现直接消费）、**相邻辅助**（projectDirector 建议器）、**文档层**（doc 16/18 的引用与边界声明）。
3. 本文是**纯新契约文档**：未创建/修改任何 server/src/docs 既有文件，未执行 git 操作；后续实现对照 05 spec G16 验收与本文 §二～§四 冻结契约交付即可。
