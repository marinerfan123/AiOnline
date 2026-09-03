# 19 — G16 Director Stage 设计文档（v3.0）：director 增强层（G13 storyboardPlan 为单一真源）

日期: 2026-09-04
状态: **设计稿 —— director 增强层契约冻结，待实现（G16 当前 NOT_STARTED，见第六/七节审计）**
权威依据:
- `server/modules/script/storyboardPlan.cjs`（`buildStoryboardPlan`，G13 phase-3）—— **beats/shots 单一真源**（代码 + `storyboardPlan.test.cjs` 测试套件，17 用例 / 61 断言，实测 17/17 全绿）
- `server/modules/script/scriptModel.cjs`（6-kind 行模型纯函数）+ `server/db/migrations/0039_script_rows.sql`
- `moling-control/governance/blueprint-v2.0/00_MASTER_BLUEPRINT_V2.0.md` §2.3 / §12 Director Stage / 3D Previz / §27 Gate 列表
- `moling-control/governance/blueprint-v2.0/04_AI_MEDIA_AGENT_SPEC_V2.0.md` §1 Capability Registry / §8 Video Rewrite Intent / §10 Frame-by-frame Analysis / §13 AutoLink / §14 Director Stage / §19 Agent Tool / §21 Approval
- `moling-control/governance/blueprint-v2.0/05_ACCEPTANCE_EXECUTION_SPEC_V2.0.md` G16 验收
- `moling-control/runtime/blueprint-v2/gates/LEDGER.md` G13 / G15 / G16 行

> **v3.0 归一说明**：2026-09-04 审计发现本文 v2.0 与已落代码 `storyboardPlan.cjs` 存在 7 处冲突（beat 切分、镜头基数、durationMs 默认、summary 顺序、id 格式、shots 绑定、shotSize/枚举）。本版以 `storyboardPlan.cjs` 为 **beats/shots 的唯一真源**，本文降级为 **director 增强层**描述：`directorizeRows` 消费 `buildStoryboardPlan(...).beats[]` 输出，做 kind 化、duration/summary 精修、镜头标注等增强。原「零实现」表述一并更正（storyboardPlan 已存在）。

---

## 一、目标与边界

### 1.1 定位

G13 已把剧本落成**行模型**（6-kind 行：`dialogue / action / transition / parenthetical / header / shot_direction`，`server/modules/script/scriptModel.cjs` + 迁移 `0039_script_rows`），并已产出**storyboard 计划**（`server/modules/script/storyboardPlan.cjs::buildStoryboardPlan`：纯函数、无 I/O、确定性、幂等）。行模型是"文本事实"，storyboard 计划是"确定性镜头切分"，二者都不是"可执行的导演级镜头意图"。

G16 Director Stage（本设计文档覆盖的**导演阶段**）在 G13 storyboard 计划之上补一条**增强层**流水线：

```text
script_rows（G13 已落，6-kind 行模型）
      │  ① 校验 + 场景分组（buildStoryboardPlan 内部复用 validateScriptRow / buildSceneRows）
      ▼
beats[]（G13 storyboardPlan.cjs —— 单一真源，已切分，每 beat 默认 2 镜）
      │  ② directorizeRows 消费 beats[] 输出（不重实现切分/基数/id）
      ▼
ShotDirective 增强 IR（kind 化 / duration 精修 / summary 精修 / 镜头标注：intent·action·audio·扩镜）
      │  ③ 字段推导（纯函数，见 §三增强矩阵）
      ▼
shots 落库（复用 0017 + 0022 表结构）→ 画布节点 → Studio Run Engine（G15 已 PASS）执行生成链
```

一句话：**本文冻结「G13 beats[] → director 增强 ShotDirective IR → shots 落库」的增强契约**。上游是 G13 storyboardPlan（已落代码+测试），执行下游是 G15 run 引擎（已 PASS）驱动的真实生成（provider 阶段）。

### 1.2 单一真源声明（beats/shots 边界）

- **beats/shots 的一切结构事实以 `storyboardPlan.cjs` 为准**：beat 切分规则（R1–R4）、每 beat 镜头基数与 intent（S1–S3）、subjectRefs 解析（S4）、durationMs 默认（S5）、camera 默认（S6）、id 合成格式、summary 摘录规则、返回形状（`{beats, totalShots}` 或 `{ok:false, errors}`）。
- 本文 **不重新定义** 上述任何一条；凡本文提出与 G13 不同的取值（如 kind 化 durationMs、扩镜、episodeId 前缀），一律标注 **`override: G13 定义`** 或 **`增强（可选）`**，并落在 director 增强层，不得回写/篡改 storyboardPlan 行为。
- 本文的 IR 字段是 G13 beat/shot 字段的**超集**（新增 `kind`、`action`、`audio`、可选 `episodeId` 前缀等），G13 已有字段的语义不因本文而变。

### 1.3 明确不做的事（Out of Scope）

| 不做 | 理由 / 依据 |
|---|---|
| 真实 AI 导演推理（节拍划分、镜头语言决策、正反打判断、扩镜） | 属 provider / 模型阶段。04 §1 Capability Registry 与 §19 Agent Tool 管辖；推理结果**唯一合法输出形态就是本文 §二 的 IR**，不许绕开 IR 自由发挥（对齐 00 §28「不存在 LLM 自由执行任意代码的后门」）。G13 的 2 镜默认是确定性底线，文学性扩镜只能经 `expandShots` 回填 |
| 重实现 beat 切分 / 镜头基数 / id 合成 | 单一真源在 `storyboardPlan.cjs`；本文只消费其 `beats[]` 输出，禁止在 directorizeRows 内复制 G13 的 R/S 规则（防双真源漂移） |
| 3D Previz 本体：DirectorObject / DirectorCamera / DirectorLight 变换、相机预览、参考渲染 | 属 04 §14 与 00 §12 的 Director Stage Workspace；`director.object.* / director.camera.update / director.light.update` 命令词表已在 envelopes.cjs / collabContract.cjs 冻结（仅词表），UI/实现属后续波次（见 §五） |
| Blender Add-on / scene manifest 传输 | G17 协议已冻结（doc 16），与本文相互独立，仅共享 shot / asset_version 实体契约 |
| 图像/视频生成执行本身 | 生成由 Generation V2 + run 引擎执行；本文只产出**镜头指令**，是生成 reference 的语义前件（reference render 本文**明示不携带**，见 §2.7） |
| 新增数据库迁移 / 修改既有表 | 本文不改任何 schema；0022 shots 扩展字段足以承载 IR 输出（见 §四） |
| 任何 UI 组件（节拍编辑器、镜头列表、previz 面板） | G13 storyboard / G16 编辑器的 UI 均属后续波次（见 §五） |
| 修改任何既有文件 | 本文为纯文档；仓库审计见第七节 |

> 边界原则：本文是一条**薄而确定的增强层契约**——G13 storyboardPlan 提供确定性切分与 2 镜底线，director 层在此之上做 kind 化与字段精修；真实导演判断（文学性的镜头选择）属于 provider。三者通过 §二 IR 单点耦合——provider/director 输出若不满足 IR 校验，不落库。

### 1.4 设计约束（继承既有工程约定）

- **纯函数**：增强与校验函数无 I/O、无 DB、无随机（与 `scriptModel.cjs` / `storyboardPlan.cjs` 同风格，全部确定性、可单测）。
- **稳定 id 引用**：IR 内所有交叉引用使用稳定 id，不内嵌可变对象（见 §2.6 三态桥接）。
- **整数毫秒**：所有时长为非负整数毫秒（0039 迁移注释的项目级约定）。
- **可幂等**：同输入重算 → 同输出 → 落库 upsert 语义友好（对齐 00 §3.6 高成本动作可估价幂等审计、G20）。
- **{ok, errors} 返回约定**：与 codebase 一致（见 budget.cjs / scriptModel.cjs / storyboardPlan.cjs）。

---

## 二、导演 IR 契约

IR 是本文冻结的核心。它定义一层增强结构：在 **G13 beat/shot（单一真源基底）**之上派生 **DirectorBeat（kind 化）** 与 **ShotDirective（镜头指令）**。约定：接口字段名以 camelCase 表达（与既有 JSONB/API 风格一致），落库映射见 §四。

### 2.1 设计原则

1. **单一真源可溯**：每个 DirectorBeat / ShotDirective 都能一路追溯到 G13 的 beatId / shotId 与源 script rows。
2. **G13 是底线，本文是增强**：不重写 G13 结构，只在之上叠加 director 层字段；凡取值与 G13 不同，显式标注 override。
3. **位置即身份**：Beat/Shot 的序号继承 G13 的位置合成 id（2.6），文本编辑产生新位置即新 id，不尝试 diff 保 id。
4. **可空即缺省**：默认值全部显式化，不依赖 `null` 语义（provider 不填也成立）。

### 2.2 单一真源基底：G13 storyboardPlan 输出形状（原文摘录）

`buildStoryboardPlan({ rows, characters, locations })` 返回（成功）：

```ts
{
  beats: [{
    beatId: string;          // 's{sceneIndex}:b{beatIndex}' —— 场景内位置合成，无 episode 前缀
    sceneIndex: number;      // 来源 scene_index（>=0 int）
    beatIndex: number;       // 0 起，场景内连续
    scriptRowIds: string[];  // 该 beat 行的有序引用（row.id，缺失时 'row-{scene}-{n}' 兜底）
    summary: string;         // 一句话摘录：dialogue-first（'SPEAKER: text'），否则首行文本，<=120 字符
    shots: [{
      shotId: string;        // 's{sceneIndex}:b{beatIndex}:k{shotIndex}'
      beatId: string;
      shotIndex: number;     // 0 起，beat 内
      intent: 'dialogue' | 'reaction' | 'action';   // dialogue beat → 主语 dialogue + 反打 reaction；非 dialogue → action
      subjectRefs: SubjectRef[];   // 由 dialogue speaker 匹配 characters 再 locations；无匹配 → []
      camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' };  // 显式默认，无 nil
      durationMs: number;    // 整数毫秒，恒 3000
    }]
  }],
  totalShots: number
}
// 失败形状（codebase {ok,errors} 约定）：{ ok: false, errors: [...] }
```

G13 规则速查（详情见源码注释；本文不重述为规范，仅索引）：

- **Beat 规则（纯位置切分，按场景内源序）**：R1 场景升序分组（`buildSceneRows`，组内序不变）；R2 `shot_direction` 行是镜头边界——关闭当前 beat 并**自成单行 beat**；R3 其余所有 kind（dialogue + action + parenthetical/header/transition）**合流**为最多 4 行一个 content beat；R4 行不丢、不重、不重排，beat 连续切分场景行。
- **Shot 规则（每 beat 默认 2 镜）**：S1 每 beat 默认产 2 镜；S2 dialogue beat → shot0 主语（intent `dialogue`，subjectRefs=首个 speaker）+ shot1 反打（intent `reaction`，subjectRefs=第二个不同 speaker，缺失则 `[]`，绝不虚构听者）；S3 非 dialogue beat → 两镜均 intent `action`、subjectRefs `[]`；S4 subjectRefs 只来自 speaker 串按 name/id 匹配 characters 再 locations，无匹配 → `[]`；S5 durationMs 恒 3000 整数毫秒；S6 camera 恒 `{ medium, static, eye-level }` 显式默认。

### 2.3 DirectorBeat（director 增强层，kind 化）

在 G13 beat 之上派生的增强结构（`directorizeRows` 产出，**不含 G13 已给出的切分/基数逻辑**）：

```ts
interface DirectorBeat {
  // ── 身份 / 溯源（继承 G13，见 2.6 三态桥接）─────────────
  beatId: string;              // = G13 beatId（'s{scene}:b{beat}'），director 层不加 episode 前缀（见 2.6）
  sourceBeat: G13Beat;         // 引用原始 G13 beat（含 scriptRowIds / summary / shots），单一真源锚点
  // ── 位置（继承）─────────────────────────────────────────
  sceneIndex: number;          // 来源 scene_index，>=0 整数
  beatIndex: number;           // 场景内节拍序号，0 起连续
  // ── 语义（继承，可精修）────────────────────────────────
  summary: string;             // 默认 = G13 summary（dialogue-first）；director 层可精修，非空
  scriptRowIds: string[];      // = G13 scriptRowIds，有序引用，覆盖无重叠
  // ── director 增强字段 ───────────────────────────────────
  kind: BeatKind;              // 【增强】由组内行 kind 推导（G13 不产出该字段）
}

type BeatKind = 'dialogue' | 'action' | 'hybrid' | 'transition';
```

`kind` 推导规则（director 层新增，非 G13）：组内含 dialogue 且含 action/shot_direction → `hybrid`；全 dialogue（含 parenthetical）→ `dialogue`；全 action / shot_direction → `action`；transition-only → `transition`。注：G13 的 beat 是「4 行合流」的位置块，天然可能是 hybrid；`kind` 是对该块语义的后置标注，不改变 G13 的切分结果。

### 2.4 ShotDirective（镜头指令）

一次镜头决策的完整结构化描述，**以 G13 shot 为基底派生**（最小契约含 parent 要求的全部字段）：

```ts
interface ShotDirective {
  // ── 身份 / 上游引用（继承 G13）─────────────────────────
  shotId: string;              // = G13 shotId（'s{scene}:b{beat}:k{shot}'），见 2.6 三态桥接
  beatId: string;              // = G13 beatId（stable id）
  shotIndex: number;           // 0 起，beat 内（继承）
  // ── 镜头语义（核心字段）────────────────────────────────
  intent: ShotIntent;          // G13 底线 'dialogue'|'reaction'|'action'；director/provider 可精修为 establish/transition
  action: string;              // 镜头内主体动作 / 调度描述（非空；单行推导见 §三）【增强，G13 不产出】
  subjectRefs: SubjectRef[];   // 主体引用数组（character / prop / location 稳定实体 id），可为空（继承 G13 的 character/location 解析，扩展 prop）
  // ── 摄影（核心字段）────────────────────────────────────
  camera: {
    shotSize: ShotSize;        // 【增强】自定义枚举（G13 恒 'medium'；见 2.5，04 §10 仅自由文本）
    movement: CameraMovement;  // G13 恒 'static'，director/provider 可扩展
    angle: CameraAngle;        // G13 恒 'eye-level'，director/provider 可扩展
  };
  // ── 时长（核心字段）────────────────────────────────────
  durationMs: number;          // 正整数毫秒；G13 恒 3000，director 层 kind 化默认见 §三（override: G13 定义）
  // ── 声音（核心字段，可选）─────────────────────────────
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

枚举说明（对 provider 均开放为可写字段，但必须命中受控词表，校验见 §3.4）：
- `ShotSize` 为**本文自定义受控枚举**：`'extreme-wide' | 'wide' | 'full' | 'medium' | 'close-up' | 'extreme-close-up'`。**注意：04 §10 `VideoAnalysisShot.shotSize` 仅自由文本（非受控词表），故本文枚举不可「直接回填」逆向分析结果，需 adapter 归一化映射**；G13 底线值 `'medium'` 是本枚举成员。
- `ShotIntent` 与 04 §8 `VideoEditIntent` 分域但兼容：本文 intent 描述"拍什么"，`VideoEditIntent` 描述"改什么"；实现期 intent→editIntent 的映射表放 adapter 层。
- `camera` 三字段必填且不许省略——**默认值显式化**（继承 G13 的 medium/static/eye-level），杜绝 nil 语义歧义。
- `subjectRefs` 引用的是**实体稳定 id**（character 库 / environments 表 / prop 引用），不是自由文本；speaker 名字符串 → 实体 id 的解析在 G13 层已完成（S4，character→location），director 层仅扩展 `prop` 类型并通过 `entityIndex` 可选上下文补充绑定（缺省空，见 §三）。

### 2.5 ShotSize 枚举（自定义枚举 + 04 §10 自由文本说明）

| 项 | 说明 |
|---|---|
| 本文枚举 | `extreme-wide / wide / full / medium / close-up / extreme-close-up`（受控词表，校验见 §3.4） |
| G13 底线 | `storyboardPlan.cjs` 恒产 `shotSize: 'medium'`（S6），是本枚举的合法成员 |
| 04 §10 事实 | `VideoAnalysisShot.shotSize` 为**自由文本字段**，不是受控词表，不可作为同域词表回填来源 |
| 归一化 | 逆向分析（04 §10）产出的自由文本 shotSize → 本文枚举，须经 adapter 归一化（词表映射 + 未知值落 `medium` 或 provider 精修），禁止自由文本直灌 IR |

### 2.6 稳定 id 与三态桥接

```text
状态一（G13 真源）：shotId = 's{sceneIndex}:b{beatIndex}:k{shotIndex}'
                    beatId = 's{sceneIndex}:b{beatIndex}'
                    —— storyboardPlan.cjs 合成，场景内位置 id，【无 episode 前缀】
状态二（director 层）：可选 'episodeId:' 前缀（分集上下文），或原样透传（脚本级空前缀）
                    —— 仅 directorizeRows 在 IR 顶层携带 episodeId 时作为命名空间扩展；
                       不加前缀时 shotId 与 G13 字节一致
状态三（落库层）：shots.seq（0017，全片 1 起编号，见 §四）
                    —— 由 (sceneIndex, beatIndex, shotIndex) 排序派生，非 IR 身份字段
```

- **桥接原则**：状态二是状态一的**可选命名空间扩展**，状态三是**落库排序序号**。三者可无损互推：`seq` 由排序派生，G13 shotId 是稳定 upsert 键（`idempotency_key = shotId`），episode 前缀是展示层命名空间。directorizeRows **必须保留 G13 shotId/beatId 作为稳定键**，episode 前缀只许在 IR 顶层存在、不得改写状态一字符串。
- 同一输入（同 rows 顺序 + 同 characters/locations + 同 entityIndex）重算 → 字节级一致 id → 落库幂等 upsert 友好。
- 文本编辑改变位置 = 显式产生新 id；旧 id 的 shots 行按 0023 shot_version 语义版本化，不覆盖（00 §3.3 Asset 永不覆盖精神延伸到指令层）。

### 2.7 reference render 明示不携带

- 本文 IR（DirectorBeat / ShotDirective）**不携带任何 reference render**（无图像/视频/预览帧字段）。它是生成 reference 的**语义前件**：`intent / action / subjectRefs / camera` 为 provider 提供结构化意图，实际参考渲染/相机预览由 04 §14 Director Stage Workspace（空间侧）产出。
- 04 §19 `director.render` 词表已冻结，可作 **dry-run 载体**（不产 IR 字段），不在本文冻结。
- 若未来需要 IR 携带 reference，走 additive 可选字段（如 `reference?: { imageUrl?, previewKey? }`），**不得在 v1 schemaVersion 内新增**（schemaVersion 演进走 00 §21 registry）。

### 2.8 IR 完整示例（G13 基底 → director 增强）

输入经 `buildStoryboardPlan` 得 G13 beats（1 header + 1 action + 2 dialogue + 1 transition + 1 shot_direction 的某场景），`directorizeRows` 增强后：

```json
{
  "episodeId": "ep-01",
  "schemaVersion": 1,
  "beats": [
    { "beatId": "s0:b0", "sceneIndex": 0, "beatIndex": 0, "kind": "action",
      "summary": "林深推门而入。",
      "scriptRowIds": ["row-0001", "row-0002"] },
    { "beatId": "s0:b1", "sceneIndex": 0, "beatIndex": 1, "kind": "dialogue",
      "summary": "阿岚：你终于来了。",
      "scriptRowIds": ["row-0003", "row-0004"] },
    { "beatId": "s0:b2", "sceneIndex": 0, "beatIndex": 2, "kind": "action",
      "summary": "镜头越过林深肩头推向门口阴影。",
      "scriptRowIds": ["row-0005"] }
  ],
  "shotDirectives": [
    { "shotId": "s0:b0:k0", "beatId": "s0:b0", "intent": "action",
      "action": "林深推门而入", "subjectRefs": [{ "entityType": "character", "entityId": "char-linshen", "label": "林深" }],
      "camera": { "shotSize": "wide", "movement": "static", "angle": "eye-level" },
      "durationMs": 2500, "audio": { "music": "低气压氛围", "dialogRefs": [] } },
    { "shotId": "s0:b1:k0", "beatId": "s0:b1", "intent": "dialogue",
      "action": "阿岚开口对白", "subjectRefs": [{ "entityType": "character", "entityId": "char-alan", "label": "阿岚" }],
      "camera": { "shotSize": "close-up", "movement": "static", "angle": "eye-level" },
      "durationMs": 3000, "audio": { "music": "", "dialogRefs": ["row-0004"] } },
    { "shotId": "s0:b1:k1", "beatId": "s0:b1", "intent": "reaction",
      "action": "反打：林深反应", "subjectRefs": [{ "entityType": "character", "entityId": "char-linshen", "label": "林深" }],
      "camera": { "shotSize": "medium", "movement": "static", "angle": "eye-level" },
      "durationMs": 3000, "audio": { "music": "", "dialogRefs": [] } }
  ]
}
```

（上例中 `shotId` 一律为 G13 状态一格式（无 episode 前缀，`episodeId` 仅存于 IR 顶层）；`char-linshen`/`char-alan` 为演示用实体 id；`s0:b1` 展示 G13 的 2 镜底线——主语 `k0` + 反打 `k1`。实际 subjectRefs 由 G13 S4 解析或 entityIndex 注入或留空。）

---

## 三、scriptRows → G13 beats[] → ShotDirectives 增强规则（纯函数契约）

### 3.1 总契约

```ts
// 输入：G13 storyboardPlan 的输出 beats[]（或直接调用 buildStoryboardPlan）+ 可选上下文。
// 输出：导演增强 IR。全程无 I/O。禁止重实现 G13 切分/基数/id。
directorizeRows({ episodeId?, beats, characters?, locations?, entityIndex?, expandShots? })
  → { ok: true, ir: { episodeId?, schemaVersion, beats: DirectorBeat[], shotDirectives: ShotDirective[] } }
  | { ok: false, errors[] }

// beats: 直接复用 buildStoryboardPlan({ rows, characters, locations }).beats —— 单一真源输入。
// entityIndex?: { [speakerOrLabel: string]: { entityType, entityId } }
//   speaker 名 → 实体 id 的场记绑定表（由上游 bible/autoLink 提供）；缺省空。
// expandShots?: { [beatId: string]: ShotDirective[] }  —— 显式扩镜重写（见 3.2 增强矩阵）。
```

不变量（输出必须满足，供测试断言；G13 已保证的前三条不变，director 层不得破坏）：
1. **全行覆盖**：`beats[].scriptRowIds` 的并集 = 输入全部 rows 的 id，无遗漏、无重复、无跨场景混组（由 G13 R4 保证）。
2. **保序**：行序在 beats 间与 beats 内严格保持输入顺序；镜头序 = `(sceneIndex, beatIndex, shotIndex)` 字典序（由 G13 R1/R2/R3 保证）。
3. **确定性**：同输入（含同 entityIndex/expandShots）→ 字节级同输出。
4. **单一真源**：directorizeRows 不得私自改变 beat 数量/边界/shot 基数/id（除非经 expandShots 显式扩镜）；违反即 `{ok:false}` 或直接透传 G13 结构。

### 3.2 增强矩阵（G13 定义 → director 增强，逐维度标注）

| 维度 | G13 `storyboardPlan.cjs` 定义（单一真源） | director 层增强（本文契约） | 标注 |
|---|---|---|---|
| 场景分组 | R1：`buildSceneRows` 场景升序、组内序不变 | 复用，不改 | 引用 G13 |
| beat 切分 | R2 shot_direction 成边界+自成单行 beat；R3 其余 kind 合流 ≤4 行一个 beat；R4 不丢不重不重排 | **不重实现**，直接消费 `beats[]` | 引用 G13 |
| `beat.kind` | 不产出该字段 | 由组内行 kind 推导 `dialogue/action/hybrid/transition` | 增强（新增字段） |
| 镜头基数 | S1：每 beat 默认 **2 镜**；S2 dialogue→主语+反打；S3 非 dialogue→2 action | 默认保持 G13 2 镜底线；`expandShots` 显式扩镜（N>1 指令列表，按 beatId 覆盖） | override 扩展（默认不变） |
| `intent` | S2/S3：`dialogue`/`reaction`（dialogue beat）或 `action`（非 dialogue） | 继承底线；provider/director 可精修为 `establish`/`transition` 等 | 增强 |
| `durationMs` | S5：**恒 3000** 整数毫秒 | kind 化默认：dialogue→3000；action→2500；transition→1000；hybrid→3000（仅当调用方开启 `kindDurations` 时） | **override: G13 定义**（默认仍 3000） |
| `summary` | dialogue-first：`SPEAKER: text`，否则首行文本，≤120 字符 | 默认透传 G13 summary；director 层可精修（非空） | 增强（可选，默认不变） |
| `camera` | S6：恒 `{ medium, static, eye-level }` 显式默认 | 受控枚举扩展（自定义 ShotSize 枚举，2.5）；movement/angle 可扩展 | 增强（默认值不变） |
| `subjectRefs` | S4：speaker 匹配 characters→locations，无匹配 `[]`，不发明 | 扩展 `prop` 类型 + `entityIndex` 补充绑定；未命中仍 `[]` | 增强 |
| `shotId`/`beatId` | `s{scene}:b{beat}` / `...:k{shot}`，**无 episode 前缀** | 可选 episodeId 前缀（仅 IR 顶层命名空间，不改状态一字符串） | 三态桥接（2.6） |
| `action` / `audio` | 不产出 | 新增 `action`（动作/调度描述）、`audio`（music + dialogRefs） | 增强（新增字段） |

> 矩阵读法：**「引用 G13」= 本文不重复定义；「增强」= 在 G13 之上叠加字段/精修，默认值与 G13 一致；「override: G13 定义」= 本文有意改变 G13 默认，须显式标注且默认仍回退 G13**。任何未在矩阵中列出的 G13 行为，本文一律不做变更。

### 3.3 字段映射表（来源 → ShotDirective 字段）

| 来源 | 目标字段 | 推导规则 |
|---|---|---|
| G13 shot | `shotId` / `beatId` / `shotIndex` | 透传（三态桥接 2.6） |
| G13 beat.kind（director 推导） | `intent` | dialogue→`dialogue`；action（含 shot_direction 独立 beat）→`action`；transition→`transition`；hybrid→组内含 action 行取 `action`，否则 `dialogue`；`establish`/更细 intent 属 provider 精修 |
| G13 `summary`（可精修） | `action` | 摘要全文（语义即动作/调度描述）；`shot_direction` 行文本经 `> ` 前缀剥离后作 `action` |
| dialogue 行（speaker+text） | `audio.dialogRefs` | 组内全部 dialogue 行的 `id`（按行序） |
| speaker 名 / `entityIndex` | `subjectRefs` | 优先 G13 S4 解析结果；`entityIndex[speaker]` 命中则注入 `{entityType, entityId, label: speaker}`；未命中 → 空数组（不猜测、不发明实体 id） |
| 行 `timing_ms` | `durationMs` | 仅当 beat 恰由 1 行组成且该行给定时使用；否则按 kind 取默认值（下表） |
| —（缺省） | `durationMs` | **override: G13 定义**：G13 恒 3000；director 层（开启 `kindDurations`）dialogue→3000；action→2500；transition→1000；hybrid→3000（显式正整数毫秒） |
| —（缺省） | `camera` | 继承 G13 `{ shotSize:'medium', movement:'static', angle:'eye-level' }`；director/provider 可在受控枚举内精修，恒显式无 nil |
| transition 行文本 | `intent` + `audio.music` | intent=transition；music 不填（转场不配乐由 provider 定） |

> 本表的本质：**只做"可无歧义推导的搬运、标注与缺省"，不做文学性创造**。所有灰色决策点（镜别/运镜/机位/情绪）落到 G13 显式缺省或 provider 精修，保证纯函数可行。

### 3.4 校验纯函数契约（与 scriptModel / storyboardPlan 同风格）

```ts
validateDirectorBeat(beat)                    → { ok, errors }
validateShotDirective(d, { beats })           → { ok, errors }
validateDirectorIR(ir, { sourceRows })        → { ok, errors }
```

关键规则（每条均可单测）：
- Beat：`sceneIndex`/`beatIndex` 非负整数；`summary` 非空；`scriptRowIds` 非空、无重复、指向同一 scene；`kind` 在枚举内。
- Directive：`durationMs` 正整数；`intent`/`shotSize`/`movement`/`angle` 命中受控词表；`camera` 三字段齐全；`beatId` 在 beats 中存在；`audio.dialogRefs` 每个元素必须是 `dialogue` kind 的行 id（跨层引用完整，防"引用对白却配动作行"）。
- IR 总校验：全行覆盖不变量 + 保序不变量 + id 唯一性 + **单一真源不变量**（beat 边界/shot 基数/id 与 G13 输入一致，除非 expandShots 显式扩镜）。

### 3.5 稳定性与幂等语义

- 重算（同输入）产物字节一致 → 落库层可做 `idempotency_key = shotId` 的 upsert（对齐 0015 `idempotency_key UNIQUE(canvas_id, idempotency_key)` 先例；0017 shots 无此列，见 §四绑定缺口）。
- IR 的 `schemaVersion` 固定为 1；演进走 00 §21 schema versioning registry 模式（与 doc 16 的 `migrateDirectorScene` 同策略），不在 IR 层自创迁移。
- 增强层不得漂移 G13：若 `storyboardPlan.cjs` 规则演进，本文增强矩阵须同步，禁止在本层固化一份 G13 规则副本。

---

## 四、shots 落库绑定

IR 不是终态——终态是 shots 表中的可执行镜头行 + run 引擎消费的画布节点。本文冻结绑定契约，**不改表、不加迁移**。

### 4.1 复用 0017 + 0022 shots 表结构（映射表）

shots 基表（0017：`episode_id / canvas_node_id / seq / asset_id / duration_seconds / note`）+ W1-09 扩展（0022：`title / story_intent / cinematography / context / generation_meta / output / commerce`，全部 JSONB 带默认 `{}`）。映射：

| ShotDirective 字段 | shots 列 | 说明 |
|---|---|---|
| `shotId`（序） | `seq` | 全片按 `(sceneIndex, beatIndex, shotIndex)` 排序后 1 起编号（约束 seq>=1；三态桥接 2.6 状态三） |
| `shotId`（稳定键） | （upsert 键） | `idempotency_key = shotId`（G13 状态一字符串，无 episode 前缀）作为幂等键 |
| `beatId` / `episodeId` | `context.story.structure` | JSONB：`{ sceneIndex, beatIndex, shotIndex, beatId }`，保留溯源 |
| `beatId` + `beatKind` + `intent` + `scriptRowIds` | `story_intent` | JSONB：拍什么。脚本行引用全程携带 |
| `action` | `title`（截断 200）+ `note` | title 给人看，note 保留全文 |
| `camera.{shotSize,movement,angle}` | `cinematography.camera` | JSONB 子结构；`camera` 受控枚举直落（含自定义 ShotSize 枚举） |
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
| 0017/0022 无 `source_beat_id / source_directive_id` 追溯列 | 溯源只能经 `story_intent`/`context` JSONB（含 G13 shotId/beatId） | 如需列级追溯，作为 additive 迁移候选（走 0022 先例的 ADD COLUMN 模式），不在本文冻结 |
| 0017 `duration_seconds` INT 与 ms 精度 | IR 用 ms，shots 用秒 | 已知限制；timeline（0034，ms）消费 IR/版本化 shots 时以 ms 为准 |
| beats 无独立表 | 不建表，beat 语义冗余进 shots JSONB（G13 beats 亦无表） | 若未来需要 beat 级操作，单独 additive 迁移 |

---

## 五、与 G13 / G16 UI 边界

### 5.1 与 G13 的关系

- 上游：G13 行模型（`scriptModel.cjs` 校验/拆分/分组纯函数 + 0039 落库）**已 IN_PROGRESS**；G13 phase-3 `storyboardPlan.cjs`（`buildStoryboardPlan` 纯函数 + 17 测试）**已存在**（`G13_acceptance.json`：rowModel + pureModel + storyboardPlan 已落；**CRUD API / storyboard 批量绑定 / UI 未落**）。
- 本文消费其**beats[] 输出与纯函数**，不依赖 G13 的 UI/API 是否存在——增强契约与编辑器解耦。
- 本文产出的 shots（分镜意图）是 G13 storyboard 批量绑定与批量视频的输入；G13 收口时以本文 §四 映射为准，避免"storyboard 绑定"与"director IR 落库"双写同一批镜头（doc 08 引导式 meta 的双写问题见 5.4）。

### 5.2 与 G16 本体（3D Previz 导演台）的关系

- Blueprint §12 / 04 §14 的 G16 本体 = DirectorStage Workspace：`DirectorObject / DirectorCamera / DirectorLight` 变换、相机预览、参考渲染、generation reference。这部分**命令词表已冻结**（envelopes.cjs：`director.object.create/update/delete`、`director.camera.update`、`director.light.update`；collabContract.cjs：update=LWW、create/delete=reject-409），实现为零。
- 关系定位：本文 IR 是"**文本侧导演层**"（从 G13 beats 到镜头指令增强），04 §14 是"**空间侧导演层**"（从镜头指令到 3D 场景/相机/灯光）。两者在 **camera intent / generation reference** 处汇合：
  - 本文 `ShotDirective.camera`（受控枚举）→ 04 §14 Director 输出 camera intent / normalized prompt hints 的语义前件；
  - provider 有 structured camera control 时直接映射，否则由 adapter 转 prompt + reference render（04 §14 原文语义；reference render 本文不携带，见 2.7）。
- 时间上本文先行（文本→镜头指令是 previz 的输入），空间侧 previz 属后续波次；两者不互相阻塞（与 doc 16 G17 同款"协议先行、实现并行"纪律）。

### 5.3 UI 波次规划（本文一律不实现）

| 波次 | 内容 | 消费契约 |
|---|---|---|
| 0（本文） | 增强层契约冻结 + 纯函数增强/校验 | 无 UI |
| 1 | Beat / 镜头指令列表编辑（只读 IR + 覆盖 expandShots 重写 + 重算预览） | §二 §三 |
| 2 | Director Stage 3D previz 面板（object/camera/light + preview + reference render） | 04 §14 + doc 16 协议 |
| 3 | 引导式流程接入（doc 08 13 阶段模型：storyboard 步进） | §四 shots 行 + doc 08 |

### 5.4 与 doc 08 引导式流程的关系（防双写）

- doc 08 阶段模型在 `story` 阶段已有 `beats[]`（大纲节拍）、在 `storyboard` 阶段有每 scene `[{desc, framing, duration}]`（meta JSON，G1/G8 一期不建表）。
- 对齐规则：doc 08 的 storyboard **meta** 与本文的导演 IR **不应并存两套事实**。实现期二选一：doc 08 storyboard meta 作为 IR 的轻量快照展示层（读 IR），或直接废弃该 meta 改读 shots（写路径唯一 = 本文 §四）。本设计文档立场：**写路径唯一化，读路径可多投影**（00 §3.4 Node 不等于业务实体精神的延伸）。
- G13 `storyboardPlan.cjs` 已产出 `beats[]`（大纲级节拍的结构化下游），与 doc 08 story 阶段 beats 同源；绑定以 storyboardPlan 输出为准，避免三套 beats 事实。

---

## 六、实现状态

### 6.1 当前状态（如实）

**G16 本体（3D Previz + director 增强层落库）当前未实现**；但 **G13 storyboardPlan 已存在**，是本文的单一真源。治理台账证据：

| 证据 | 内容 |
|---|---|
| `LEDGER.md` G16 行 | `NOT_STARTED`；审计备注："无 director/beat/shot-list 模块(仅 envelopes 词表)"；nextGate 链 G15→G16 |
| `storyboardPlan.cjs`（G13 phase-3） | **已存在**：`buildStoryboardPlan` 纯函数（258 行），R1–R4 beat 切分 + S1–S6 shot 规则；`sceneRowsToPlan` 别名 |
| `storyboardPlan.test.cjs` | **已存在**：17 测试 / 61 断言，实测 17/17 全绿（node --test 验证） |
| 仓库审计（本文第七节） | director 精确词 20 行 / 7 文件，全部为词表/文档/辅助模块级；director 增强层无转换、无落库、无 UI |
| 数据库 | migrations 0001–0039 无 director 表；0039 唯一 `beat` 痕迹是 `script_rows.beat TEXT` 预留列（未启用） |

与本文相邻的既有件（真实存在，本文只引用不修改）：
- G13 上游：`server/modules/script/scriptModel.cjs`（6-kind 行模型纯函数，19 测试）+ `server/modules/script/storyboardPlan.cjs`（storyboard 计划纯函数，17 测试）+ 0039 迁移；
- G15 执行链：`server/modules/project-foundation/studioRunEngine.cjs`（M05-D1，0015）+ `studioRunGraph.cjs` + `studioRunExecutors.cjs` + `studioShotApi.cjs`（0017/0022 读写）+ `studioNodeRegistry.cjs`（`script` SOURCE 节点）；
- 词表：`studio-contracts/envelopes.cjs` + `collabContract.cjs`（director.* 命令并发语义已冻结）；
- 相邻辅助：`modelhub/projectDirector.cjs`（W4-14 "AI Director" 建议器，纯函数 proposeActions，与本文无耦合）；
- 关联协议：`docs/product-v2/16-blender-protocol-v2.0.md`（G17 冻结，互不依赖）。

### 6.2 本文冻结内容清单（实现 Gate 的对照基线）

1. 单一真源声明：beats/shots 以 `storyboardPlan.cjs` 为准（§1.2）；
2. DirectorBeat / ShotDirective 增强 IR、自定义 ShotSize 枚举、三态 id 桥接、reference render 不携带声明（§二）；
3. `directorizeRows` 纯函数增强契约：增强矩阵（G13 定义 → director 增强，override 标注）、字段映射表（§三）；
4. `validateDirectorBeat / validateShotDirective / validateDirectorIR` 校验契约（§三）；
5. IR → shots 落库映射表与执行链路指向（§四）；
6. 与 G13/G16 UI、doc 08 的边界（§五）；
7. 实现前验收清单（§八）。

### 6.3 G16 验收对照（05 spec G16：object/camera/light、preview、generation reference）

| 05 spec G16 验收项 | 本文对应 | 实现期待办（未做，如实列出） |
|---|---|---|
| object / camera / light | §2.4 camera 受控枚举（语义前件）；04 §14 对象结构 | 3D previz 面板 + `director.object/camera/light` 命令落地（波次 2） |
| preview | §4.2 run 渲染链路指向 | 相机预览渲染接入 director-stage 节点（波次 2） |
| generation reference | §2 IR（intent/action/subjectRefs/camera）→ §4 story_intent/cinematography 落库；reference render 明示不携带（§2.7） | shots → 生成节点 reference bindings 接线（波次 1 收口） |

### 6.4 Gate 纪律

- 00 §27：不能跳 Gate 宣称完成。本文是**设计稿，不是 PASS 声明**；G16 排在 G13 收口之后（LEDGER：G13 IN_PROGRESS 余 CRUD API + storyboard 绑定 + UI；G15 PASS nextGate=G16）。
- 实现期按 00 §28 硬规则输出 CURRENT STATE / TARGET CONTRACT / GAP / FILES / DB IMPACT / API IMPACT / TEST PLAN / ROLLBACK PLAN；结束以 JSON 结论汇报，禁止"功能基本完成"式结论。
- 测试纪律：增强/校验函数为纯函数 → vitest/node:test 直接断言不变量（§3.1 四条 + §3.4 规则），对照 G13 storyboardPlan 17/17 与 G15 runEngine 10/10 的既有测试标准。

---

## 七、仓库现状审计（director / storyboardPlan 痕迹）

### 7.1 审计范围与命令

范围：`/mnt/c/Users/Administrator/github_ai_online` 的 `server/ src/ docs/` 三区。命令：

```bash
grep -rIwni 'director' server/ src/ docs/     # 精确词（-w，排除 directory 伪命中）
grep -rIwni 'beat'     server/ src/ docs/
grep -rIi 'shot.list'  server/ src/ docs/
grep -rIlni 'shot'     server/ src/ docs/     # 通用镜头词（子串）
ls server/modules | grep -Ei 'director|beat|stage'   # 模块目录
ls server/db/migrations/                               # 迁移文件
ls server/modules/script/                              # G13 脚本模块（storyboardPlan 所在地）
```

### 7.2 统计

| 词 | 文件数 | 行数 | 语义判断 |
|---|---|---|---|
| `director`（精确词） | **7** | **20** | 全部词表/文档/命名相邻辅助，见 7.3 |
| `beat`（精确词） | 5 | 6 | **含 `storyboardPlan.cjs` 的 beat 规则与 beats[] 结构（真实存在，G13 phase-3）**；其余为 0039 预留列 + 注释/测试字符串，见 7.3 |
| `storyboardPlan` | 2 | — | `storyboardPlan.cjs`（实现）+ `storyboardPlan.test.cjs`（17 测试）—— **G13 已落代码，beats/shots 单一真源** |
| `shot list` / `shotList` | 0 | 0 | 不存在"镜头清单"模块 |
| `shot`（子串，镜头/分镜通用词） | 124 | 800 | 既有镜头基础设施（shots 表族/API/timeline/测试），与"导演指令 IR"不同层，是本文落库目标与下游 |
| director/beat/stage 模块目录 | 0 | — | `server/modules` 下无任何 director/beat/stage 目录（storyboardPlan 在 `server/modules/script/` 内） |
| director 相关 migration | 0 | — | 0001–0039 无 director_* 表；0039 `beat` 列为预留 |

### 7.3 director / beat / storyboardPlan 痕迹分类明细

**A. 契约词表（token 级冻结，非实现）—— 5 文件 / 17 行**
- `server/modules/studio-contracts/envelopes.cjs`：`NODE_TYPES_MOLING` 含 `'director-stage'`；`COMMAND_TYPES` 含 `director.object.create/update/delete`、`director.camera.update`、`director.light.update`；`FORMAT_REGISTRY` 含 `directorScene: 1`。
- `server/modules/studio-contracts/envelopes.test.cjs`：`isKnownNodeType('director-stage') === true` 断言（词表守卫测试）。
- `server/modules/studio-contracts/collabContract.cjs`：director.* 更新类命令并发策略（update=LWW、create/delete=reject-409）。
- `server/modules/studio-contracts/collabContract.test.cjs`：上述策略的守卫测试。

**B. G13 storyboard 计划（真实实现，beats/shots 单一真源）—— 2 文件**
- `server/modules/script/storyboardPlan.cjs`：`buildStoryboardPlan`（别名 `sceneRowsToPlan`）纯函数——R1–R4 beat 切分、S1–S6 shot 规则、`{beats, totalShots}` 输出。**本文 §二基底 + §三增强矩阵直接引用此实现，不再自述切分规则。**
- `server/modules/script/storyboardPlan.test.cjs`：17 测试 / 61 断言，实测 17/17 全绿。

**C. 命名相邻的辅助模块 —— 1 文件 / 2 行**
- `server/modules/modelhub/projectDirector.cjs`：W4-14 "AI Director" project-context facade（纯函数 `proposeActions`，建议 CREATE_STRUCTURE_SHOT_LEAF / APPLY_CONTINUITY / SEED_SHOTS）。语义是"按当前产品上下文的确定性建议器"，与 3D previz / 镜头指令 IR 无耦合，仅命名域相邻。

**D. 文档引用 —— 2 文件 / 8 行**
- `docs/product-v2/16-blender-protocol-v2.0.md`（G17）：Director Stage 作为协议上下文、`moling-director-scene` manifest 格式、G16 主链与协议的独立性声明。
- `docs/product-v2/18-collaboration-g22-audit.md`：COMMAND_TYPES 33 种中 director.* 词表审计记录。

**E. beat 痕迹（除 storyboardPlan 外，其余非 IR 结构）—— 4 行 / 4 文件**
- `server/db/migrations/0039_script_rows.sql`：`script_rows.beat TEXT` 预留列（G13 phase-1 未启用）。
- `server/modules/script/scriptModel.cjs` 注释（"action beat" 措辞）；`scriptModel.test.cjs` 的 `(beat)` parenthetical 用例（剧本格式测试串）；`server/tests/integration/studio-run-engine.test.cjs` 注释（"may beat BOTH creates" 英文动词）。

**F. "directory" 伪命中（不计入精确词统计）**
`server.js`、`src/shared/state/queryClient.ts`、`ProjectsPage.tsx`、`BACKUP.md`、`disaster-recovery.test.cjs`、`ai-control-provider.test.cjs`、`COMMERCIAL_SINGLE_NODE_GAP_MATRIX.md` 等命中均来自单词 "directory" 的子串 `director`。

### 7.4 审计结论

1. G16 Director Stage **本体（3D Previz + director 增强层落库）当前无实现**：无 director IR 转换/校验函数、无 shots 绑定、无 previz UI、无专属 migration——与治理台账 `LEDGER.md` G16 = NOT_STARTED 的审计结论一致。
2. **beats/shots 已非「零实现」**：G13 phase-3 `storyboardPlan.cjs`（+ 17 测试）已落，提供确定性 beat 切分与每 beat 2 镜默认——是本文单一真源。本文增强层（directorizeRows）尚未实现，属 G16 范畴。
3. 既有 director 痕迹分三层且互不构成 G16 实现：**词表层**（envelopes/collabContract，director.* 命令名与并发语义已冻结，可供后续实现直接消费）、**相邻辅助**（projectDirector 建议器）、**文档层**（doc 16/18 的引用与边界声明）。
4. 本文是**纯契约文档**：未创建/修改任何 server/src/docs 既有文件，未执行 git 操作；后续实现对照 05 spec G16 验收与本文 §二～§四 冻结契约交付即可。

---

## 八、实现前验收清单（pre-implementation acceptance checklist）

实现 G16 增强层前，逐项核对（全部满足方可动工；本清单是 §6.4 Gate 纪律的前置闸口）：

### 8.1 单一真源核对

- [ ] `directorizeRows` 直接消费 `buildStoryboardPlan(...).beats[]`，**未在层内重实现** beat 切分 / 镜头基数 / id 合成 / summary 摘录。
- [ ] 未复制任何一份 G13 R1–R4 / S1–S6 规则文本进实现代码（只引用 `storyboardPlan.cjs`）。
- [ ] 与 G13 不同的取值（durationMs kind 化、扩镜、episode 前缀）均标注 `override: G13 定义` 或 `增强（可选）`，且默认值回退 G13。

### 8.2 冲突消解逐条核对（7 冲突 → 单一真源）

- [ ] 冲突 1（beat 切分）：本文不再自述「按 kind 拆 dialogue/action 连续段」；改引用 G13 R2/R3（shot_direction 边界 + ≤4 行合流）。
- [ ] 冲突 2（镜头基数）：本文默认 2 镜（主语 + 反打）对齐 G13 S1–S3；扩镜仅经 `expandShots`。
- [ ] 冲突 3（durationMs 默认）：G13 恒 3000；kind 化 2500/1000/3000 标注 override 且默认关闭。
- [ ] 冲突 4（summary 顺序）：G13 dialogue-first；本文不再主张 action-first，仅作可选精修。
- [ ] 冲突 5（id 格式）：G13 `s{scene}:b{beat}[:k{shot}]` 无 episode 前缀；director 层 episode 前缀仅为 IR 顶层命名空间（三态桥接 2.6）。
- [ ] 冲突 6（shots 与 storyboard 绑定）：shots 嵌套于 G13 `beats[].shots[]`；director 层拍平为 `shotDirectives[]` 时保留 `beatId` 引用。
- [ ] 冲突 7（shotSize 枚举 / reference render / shot id）：shotSize 为自定义枚举（04 §10 仅自由文本）；reference render 明示不携带；shot id 三态桥接声明成立。

### 8.3 契约/测试核对

- [ ] 新增 `validateDirectorBeat / validateShotDirective / validateDirectorIR`，断言 §3.1 四条不变量 + §3.4 规则。
- [ ] 单一真源不变量有专门测试：directorizeRows 不改变 G13 beat 边界/基数/id（除非 expandShots）。
- [ ] 三态桥接测试：G13 shotId ↔ director（episode 前缀可选）↔ DB seq 可无损互推。
- [ ] 对照既有测试标准：G13 storyboardPlan 17/17、G15 runEngine 10/10；增强层新增测试覆盖 §3.2 增强矩阵每行。

### 8.4 落库/边界核对

- [ ] `idempotency_key = shotId`（G13 状态一字符串）upsert 语义成立。
- [ ] shots 落库映射表（§4.1）字段逐一有来源；无 orphan 字段。
- [ ] 不与 G13 storyboard 批量绑定双写同一批镜头（§5.1/5.4 防双写规则）。
- [ ] 05 spec G16 验收项（object/camera/light、preview、generation reference）对照表（§6.3）无遗漏。
- [ ] 无新增迁移、无改动既有文件（纯函数增强层 + 测试）。
