# 16 — G17 Blender Bridge 协议冻结文档（v2.0）

日期: 2026-09-03
状态: **协议冻结草案 —— 等待实现（当前仓库零实现，见第七节审计）**
权威依据: `moling-control/governance/blueprint-v2.0/00_MASTER_BLUEPRINT_V2.0.md` §2.3 / §12 Director Stage / §13 Blender Bridge；`04_AI_MEDIA_AGENT_SPEC_V2.0.md` §15；`05_ACCEPTANCE_EXECUTION_SPEC_V2.0.md` G17 验收。

> 本文只冻结契约，不实现。依据 Blueprint §13："V2.0 不要求第一 Gate 就完成 Blender Add-on，但协议必须冻结。" 后续实现 Gate 时以本文为冻结契约，逐条对照第五份 spec 的 G17 验收项交付。

---

## 一、范围与目标

### 1.1 目标

Blender Bridge 是 Moling Director Stage（3D Previz）与 Blender 资产管道之间的**命令式协议**。Blender 作为导演舞台的场景装配/相机预览/参考渲染工具，通过本协议与 Moling 生产事实层交换**引用与结果**，全程不触碰核心数据库。

协议覆盖的导出边界（来自 Blueprint §12 必须支持清单的协议可达子集）：

- Object transform / Character / Prop placement
- Camera transform + focal length + camera preview
- 基础 light
- render reference（单帧参考渲染）
- scene manifest import/export（`moling-director-scene`）

Bridge 流向（Blueprint §13 原文）：

```text
Blender
 → Export Manifest + Preview
 → Moling Import
 → DirectorScene
 → AI Generation
```

### 1.2 明确不做的事（Out of Scope）

| 不做 | 理由 / 依据 |
|---|---|
| Add-on 直写核心数据库 | Blueprint §13："未来 Add-on 只做协议适配，不修改核心数据库。" |
| 通过协议做全功能 Blender 控制（材质、几何体编辑、动画曲线细调等） | 只覆盖 §12 必须支持清单中的场景/相机/灯光/预览/参考渲染子集，其余属 Blender 本地操作 |
| 帧级渲染批量流水线 / 视频合成 | 合成与 timeline 属 G18（05 spec），本协议只出单帧参考 |
| send-to-image/video 自动生成链 | 属 G16 DirectorStage 的 Moling 侧能力，结果经 Asset Finalize 后由产品主链消费，不走本协议 |
| 实时多人 / 双向绑定同步 | 预留位在 G22，见 00 §门列表 |
| 任何"凭视觉猜"的坐标换算 | 04 spec §15："坐标转换必须显式定义……不得凭视觉猜转换。" 协议层只传送坐标并显式声明坐标系（见 4.3） |

> 边界原则：本协议是 **Blender ⇄ Moling 的薄命令层**。实体数据不进出协议（见第四节），Blender 不替代 Moling 的生成主链，Moling 不代理 Blender 的内部场景操作。

---

## 二、传输层

### 2.1 传输形态

- **HTTP POST + JSON 单文件批次**：一次请求 = 一个命令 = 一个 JSON body（单文件），不做 multipart 多文件批、不做多命令流水线批。一期不引入 WebSocket / 长连接。
- 单入口端点（实现期落地，路径为契约的一部分）：
  - `POST {base}/v1/command` — 提交命令（命令在 body 内，见白名单安全 §5）
  - `GET {base}/v1/jobs/{jobId}` — 轮询状态（get_status 命令的 HTTP 等价物，参考仓库 `/api/generate/status/:taskId` 先例，docs/product-v2/09-api-map.md）
  - `POST {base}/v1/events` — 执行方回调完成事件（见 3.6）
  - `GET {base}/healthz` — 存活检查（与仓库 `/api/healthz` 命名一致）

### 2.2 信封（Envelope）

所有命令共用信封，`payload` 内容按命令类型定义：

```json
{
  "protocolVersion": 1,
  "command": "import_shot",
  "commandId": "uuid-v4",
  "idempotencyKey": "uuid-v4",
  "issuedAtMs": 1756800000000,
  "payload": {}
}
```

### 2.3 幂等（冻结依据：仓库已有幂等模式）

Blueprint 硬规则（00 §3.6）：高成本动作必须走 `Validate → … → Reserve → Idempotency Check → Queue → Execute → Settle`；00 §28 禁止"无幂等的计费型 POST"。

**本协议冻结：凡创建作业的命令（import_shot / export_frame）必带 `idempotencyKey`**，服务端以其为去重键。语义对齐仓库三处既有实现：

1. Generation V2 intake：`ON CONFLICT (user_id, idempotency_key) DO NOTHING`（证据：docs/architecture/COMMERCIAL_SINGLE_NODE_GAP_MATRIX.md SN-15）→ 重复提交不产生第二个作业。
2. Studio run engine：`idempotencyKey` 作用域 = 实体 + key，幂等重试返回**同一个 run**，重复完成回调同样幂等（证据：server/tests/integration/studio-run-engine.test.cjs，`idempotent retry returns the SAME run (no second row)` / `duplicate completion is idempotent`）→ 本协议幂等重试返回同一个 `jobId`。
3. Upload finalize：按 `media.id` / `pendingId` 幂等更新（证据：server/uploadQueue.cjs，崩溃恢复把 processing 退回 queued 靠 finalize 内部幂等重传；`assetFinalize.finalizeUrl` 契约见 docs/product-v2/M04S_REALITY_AUDIT.md）→ 作业结果落库按稳定 id 幂等 upsert，允许结果事件重放。

### 2.4 服务端校验

- 请求入口先校验再入队：`protocolVersion` 支持值、`command` 白名单、`idempotencyKey`/`commandId` 格式、整数字段类型与边界、枚举值、载荷大小上限（冻结：body ≤ 10 MiB）。
- 校验失败返回 **422** + 结构化错误（字段级），**不产生作业、不消费幂等键**。
- 未知命令 / 未知版本 → 422（fail-closed，见 §5/§6）。

### 2.5 超时与重试

- 客户端 HTTP 超时冻结为 30 s；**请求超时 ≠ 作业失败**——作业在服务端继续执行。
- 网络错误、超时、5xx 可重试：**重试必须复用同一 `idempotencyKey`**，服务端据此去重，返回原 `jobId`（对齐 2.3 仓库语义）。
- 4xx（422 校验类）不重试，属调用方缺陷。
- 服务端侧执行超时由作业状态机表达（`running` → `failed` + `error`），不通过 HTTP 层表达。

---

## 三、命令集

命令白名单（v1 全集，安全边界见 §5）。状态机取值：`queued | claimed | running | succeeded | failed | canceled`（对齐 M05-D run engine / 产品作业状态，见 15-infinite-canvas-v2-decision.md D5-D7 的 queued/claimed/running/done/failed/canceled 映射）。

| 命令 | 方向 | 创建作业 | 摘要 |
|---|---|---|---|
| `ping` | 双向 | 否 | 存活 + 能力自述 |
| `import_shot` | Moling → Blender | 是 | 把权威 Shot 装配进 Blender，绑定不可变资产源 |
| `export_frame` | Moling → Blender | 是 | 以 frame/time_ms + 相机参数渲染单帧参考 |
| `get_status` | 双向 | 否 | 按 `jobId` 查作业状态与结果摘要 |
| 回调完成事件 | Blender → Moling | 否 | 作业完成/失败的异步上报 |

### 3.1 ping / health

```json
{ "protocolVersion": 1, "command": "ping", "commandId": "uuid" }
```

响应：

```json
{
  "ok": true,
  "protocolVersion": 1,
  "capabilities": ["import_shot", "export_frame"],
  "coordinateSystem": { "units": "meter", "handedness": "right-handed", "upAxis": "+Z", "eulerOrder": "XYZ" },
  "engine": "blender-4.x",
  "serverTimeMs": 1756800000000
}
```

用于配对握手：双方在首个 import/export 前互 ping，确认坐标系声明一致（见 4.3），不一致即拒绝作业。

### 3.2 import_shot —— 场景装配（绑定不可变源）

```json
{
  "protocolVersion": 1,
  "command": "import_shot",
  "commandId": "uuid-v4",
  "idempotencyKey": "uuid-v4",
  "issuedAtMs": 1756800000000,
  "payload": {
    "shot_id": "shot-…",                 // 只引用 stable id，见 4.2
    "asset_version": "av-…",             // 绑定不可变 Asset 版本，见 4.2
    "options": {
      "include": ["objects", "cameras", "lights", "previewAsset"]
    }
  }
}
```

语义：

- `shot_id` + `asset_version` 唯一确定一个**不可变源**（Blueprint §3.3 Asset 永不覆盖：每个输出都是新 Asset，版本不可变）。服务端按该版本快照生成 `moling-director-scene` manifest 交给 Blender 装配；后续该 shot 的任何新版本不影响本次装配。
- 装配即解析 manifest（对象/相机/灯光/坐标系声明），**不复制实体数据**（4.2）。结果只在 Blender 会话内，落库唯一入口是 3.6 回调指向的 Asset Finalize。
- 同名 `idempotencyKey` 重放 → 返回原 `jobId`。
- 响应：`{ "ok": true, "jobId": "job-…", "status": "queued" }`。
- 无 `asset_version` 时按 shot 当前已就绪版本装配（等价于显式传该版本 id），响应中回显实际绑定的 `asset_version`。

### 3.3 export_frame —— 单帧导出

```json
{
  "protocolVersion": 1,
  "command": "export_frame",
  "commandId": "uuid-v4",
  "idempotencyKey": "uuid-v4",
  "issuedAtMs": 1756800000000,
  "payload": {
    "shot_id": "shot-…",
    "frame_index": 128,          // 帧号（整数，≥0），与 time_ms 二选一或同给（须一致）
    "time_ms": 5333,             // 整数毫秒，与 frame_index 二选一或同给（须一致）
    "camera": {                   // 相机参数（覆盖当前取景；Blueprint §12: camera transform + focal length）
      "position": [0, 1.6, -4.0],
      "rotation_euler_xyz": [0, 0, 0],
      "focal_length_mm": 35.0,
      "look_at": [0, 1.2, 0]     // 可选：与 rotation 二选一，给出则相机朝向该点
    },
    "output": {
      "width": 1920,             // 整数像素
      "height": 1080,
      "file_format": "png"
    }
  }
}
```

语义：

- 帧寻址冻结为**整数帧号 与 整数毫秒**双轨（见 4.1），由 Moling 侧时间轴语义换算后传入；同给时服务端校验二者对同一源一致，不一致 422。
- `camera` 全部字段可选；不传 = 沿用 import_shot 装配的当前相机。传了即本次渲染覆盖，不影响 Blender 会话内对象。
- 输出 = 新 Asset（Blueprint §3.3 永不覆盖），经 Asset Finalize 幂等落库（2.3③），结果在回调与 `get_status` 中给出 `asset_version`。
- 响应：`{ "ok": true, "jobId": "job-…", "status": "queued" }`。

### 3.4 get_status

```json
{ "protocolVersion": 1, "command": "get_status", "commandId": "uuid-v4",
  "payload": { "jobId": "job-…" } }
```

响应：

```json
{
  "ok": true,
  "jobId": "job-…",
  "command": "export_frame",
  "status": "running",
  "progress": 0.6,               // 0..1，可选
  "result": null,                // succeeded 时: { "asset_version": "av-…" } 或摘要
  "error": null,                 // failed 时: { "code": "RENDER_TIMEOUT", "message": "…" }
  "updatedAtMs": 1756800001000
}
```

状态只在冻结集 `queued | claimed | running | succeeded | failed | canceled` 内取值。HTTP 等价物：`GET {base}/v1/jobs/{jobId}` 返回同构 JSON。

### 3.5 回调完成事件（执行方 → 请求方）

执行方在作业终态（succeeded / failed / canceled）时向请求方回调一次；**重放安全**（对齐 2.3②"duplicate completion is idempotent"）：

```json
{
  "protocolVersion": 1,
  "event": "job.completed",
  "jobId": "job-…",
  "commandId": "uuid-v4",
  "status": "succeeded",
  "result": { "asset_version": "av-…" },
  "error": null,
  "completedAtMs": 1756800002000
}
```

- 事件去重键 = `jobId`；重复事件按稳定 id 幂等 upsert，不产生副作用（2.3③ 语义）。
- 事件投递失败由请求方按 `get_status` 兜底轮询恢复，不要求事件通道可靠投递保证。

### 3.6 回调完成事件与结果落库

Moling 侧收到 succeeded 回调后，产物走产品既有 Asset Finalize 链（`assetFinalize.finalizeUrl` / `upload-finalize.finalizeUploadedItem`，按稳定 id 幂等，见 M04S_REALITY_AUDIT.md）成为新 AssetVersion 并绑定到 shot；此后的生成/引用流程全部在 Moling 主链内，协议不参与。

---

## 四、数据契约

### 4.1 整数字段：ms / 帧号

冻结：**时间一律整数毫秒（`*_ms`，int64，UTC epoch 或源内相对时间由字段定义声明）；帧一律整数帧号（≥0，相对所绑定源）**。禁止浮点秒、禁止小数帧进入协议。同一时间在协议中出现的合法形态仅两种：`time_ms`（毫秒）或 `frame_index`（帧号），二者对同一源必须可互相换算且一致（换算由 Moling 侧按源 fps 完成，协议层不做隐式 fps 猜测）。

### 4.2 实体只引用 stable id，绝不复制实体数据（Blueprint 硬规则）

- Blueprint §3.4 "Node 不等于业务实体"：业务对象只能以 `entityRef` 被引用，删 Node 不删业务对象，**引用 ≠ 复制**。
- 产品权威：Shot / Character / Scene / Asset / AssetVersion 是权威实体（DB 表），任何视图/节点/协议消息只携带 stable id（15-infinite-canvas-v2-decision.md D1：不复制实体数据进节点）。
- 因此：协议消息中的实体只出现 `shot_id` / `asset_version` 等 **stable id**。字符（台词）、参考图、角色属性、Bible 内容等实体数据**永不进入协议载荷**；Blender 侧需要内容时，由服务端按 id 出不可变快照（manifest）或经授权拉取，Add-on 不缓存为第二事实源。
- 违反此条的命令载荷直接 422：载荷里出现实体数据字段（如内联台词、内联角色参数）即非法。

### 4.3 坐标与场景清单（冻结，来源：Blueprint §13 manifest + 04 spec §15）

- manifest 格式名 `moling-director-scene`，`schemaVersion: 1`（03 spec §28：所有 JSON payload 必须含 schemaVersion；迁移走 `migrateDirectorScene` registry 模式，不在协议层自创迁移）。
- 坐标系**必须在每个含坐标的载荷中显式声明**，v1 冻结值（Blender 原生约定）：
  - `units: "meter"`
  - `coordinateSystem: "right-handed"`（Blueprint §13 字段）
  - `upAxis: "+Z"`
  - `eulerOrder: "XYZ"`
- 04 spec §15 要求 units / handedness / Euler order / up axis 显式定义且**不得凭视觉猜转换**：换算只发生在双方各自适配层，每一侧都以对方声明值为准做确定性换算；协议层不隐含任何"自动猜测"。

### 4.4 数字与字符串纪律

- 所有 id：服务端生成的稳定 id（现有 DB 主键形态），长度/字符集按仓库现有 id 规范，协议不发明新 id 规则。
- 价格/成本不上协议（计费留在 Moling 侧，对齐 00 §3.6 与 shop.cjs reserve/commit/release 模式，server/shop.cjs）。

---

## 五、安全

| # | 冻结规则 |
|---|---|
| 5.1 | **白名单命令**：单入口 `/v1/command`，只接受 §三 表格内的命令名；未知命令 → 422，不产生副作用。命令处理用显式分发表，禁止反射/动态分发。 |
| 5.2 | **参数校验**：所有字段按类型/schema 校验（2.4），载荷大小上限 10 MiB；拒绝未知业务字段出现（防语义漂移，4.2）。 |
| 5.3 | **无任意路径写**：协议载荷**不接受任何文件系统路径**（无 `path`/`filename`/`dir` 字段）；所有产物由服务端存储层按生成的稳定 id 落盘（对齐仓库 upload/OSS 流程，Add-on 无写库与写盘路径）。回调结果同样只带 id，不带路径。 |
| 5.4 | **鉴权**：HTTP Bearer 鉴权 + 项目级授权（请求必须落在调用方有权访问的 shot）；握手（ping）不要求项目权限，import/export 命令要求。 |
| 5.5 | **Fail-closed**：未知版本、未知命令、缺 idempotencyKey 的建作业命令、坐标系声明不一致（3.1）一律拒绝，不降级执行。 |
| 5.6 | **Add-on 无特权**：Blueprint §13——Add-on 只做协议适配，不修改核心数据库；本协议不给 Add-on 任何越过产品主链写数据的能力。 |

---

## 六、版本化

- 信封必带 `protocolVersion`，**v1 冻结值 = 1**（integer）。
- **变更走 additive**：v1 冻结期内，允许（a）新增白名单命令、（b）新增可选字段（带默认语义，旧实现忽略后行为仍正确）、（c）扩大枚举值（状态/格式）。任何 additive 变更不影响已冻结语义与幂等键作用域。
- **破坏性变更**（字段改名/删除、语义改变、命令删除、坐标约定改变）必须 bump `protocolVersion`，新旧版本并存迁移期；v1 接收端对 `protocolVersion > 1` 一律 422（fail-closed，5.5），直到实现该版本。
- 协议的 additive 演进与实体层无关：实体 schema 演进走产品 migration registry（含 `migrateDirectorScene`），不进协议版本号。

---

## 七、实现状态（如实审计）

### 7.1 仓库 Blender 痕迹审计（2026-09-03）

对仓库 `github_ai_online` 全量 grep（大小写不敏感，覆盖 `server/ src/ docs/ deploy/ shared/ contracts/ scripts/` 及仓库其余顶层目录，排除 node_modules 依赖产物）：

- **Blender 相关痕迹数量：0（零）**。`docs/`、`server/`、`src/`、`deploy/` 及全部被审计目录中不存在任何 blender 代码、文档段落、配置或端点。

结论：本门当前为**纯契约冻结**，无实现、无 add-on、无 bridge 端点、无协议相关测试。本文第七节之前的全部内容都是对蓝图约束的转写与冻结，不是对现有代码的描述。

### 7.2 交付边界

- **Add-on 不属于本门必交**：Blueprint §13 明文"V2.0 不要求第一 Gate 就完成 Blender Add-on，但协议必须冻结"；05 spec G17 验收项仅两条：`manifest import/export`、`coordinate tests`。
- 本文冻结的是**契约本身 + 验收锚**：后续实现 G17 时，以本文 §三命令集、§四数据契约为准，对照 G17 验收项证明：
  - manifest import/export → `import_shot`（导入/装配）与 `export_frame` + 回调结果（产物导出为不可变 Asset 版本）全链路跑通；
  - coordinate tests → 按 4.3 声明的坐标系做往返/换算确定性测试（含 Euler order、up axis、units 不一致时 422 的拒绝用例）。
- 实现 Gate 顺序约束（00 §27）：不能跳 Gate 宣称完成；G17 冻结先行，实现可并行于已冻结公共契约的互不依赖模块（本协议与 G16 DirectorStage 主链实现相互独立，仅依赖 shot/asset_version 实体契约）。

### 7.3 依赖的前置实体契约（实现前提，非本门交付）

`shot_id`、`asset_version` 指向的 Shot / AssetVersion 权威实体与不可变版本机制（00 §3.3、§3.4；M05/W4 已建生成作业与 asset version 链）为前置依赖；若实现时上述实体契约与本文件字段假设不一致，属前置变更，不修改本协议（走 4.2 引用规则与 additive 演进）。

### 7.4 本文件冻结决定一览

| 编号 | 决定 |
|---|---|
| D1 | 单命令单 JSON 文件批次；POST /v1/command + GET /v1/jobs/{jobId} + POST /v1/events |
| D2 | 建作业命令强制幂等键；重试复用同键返回同 jobId（对齐仓库 intake/run-engine/finalize 三处先例） |
| D3 | 命令白名单 = §三 全集：ping、import_shot、export_frame、get_status、job.completed 回调 |
| D4 | 时间只走整数毫秒 / 整数帧号双轨；实体只引用 stable id、绝不携带实体数据 |
| D5 | 坐标冻结：meter / right-handed / +Z up / Euler XYZ，显式声明、禁止猜测换算 |
| D6 | 无任何路径字段；鉴权 + 参数校验 + 白名单 + fail-closed |
| D7 | protocolVersion = 1；变更走 additive，破坏性变更必须升版 |
| D8 | 零实现如实记录；Add-on 非本门必交；后续实现以本文为冻结契约 |
