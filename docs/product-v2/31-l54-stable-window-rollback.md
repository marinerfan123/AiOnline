# L54 — 稳定窗口观测 + 回滚预案顾问（Phase-10 就绪前准备）

> 纯函数、零副作用、无 I/O。仅作为观测/预案数据来源，**不翻转任何旗标、不改运行时行为**。

## 代码位置

- `server/modules/generation-v2/observability.cjs` — 新增两个导出：
  - `assessStableWindow(observations, opts)`
  - `planRollback(scope, currentState?)`
- `server/modules/generation-v2/observability.test.cjs` — 覆盖新增函数的单元测试。
- `collectV2Metrics` / `evaluateV2Readiness` 保持字节级兼容，未改动。

## 1. assessStableWindow — 稳定窗口观测

```
assessStableWindow(observations, opts) ->
  { stable:boolean, mode:'stable'|'observing'|'unstable', reason?:string, windowLength:number }
```

- `observations`：快照数组，每项可为
  - readiness 形态 `{ ready, reasons[], oldestQueueSeconds? }`
  - 或 `collectV2Metrics` 全量形态（无 `ready`，仅贡献队龄信号）
- `opts`：
  - `requiredConsecutive`（默认 1，<1 视为 1）
  - `maxQueueAgeSec`（缺省 = 无队龄界限）
  - `graceFailures`（默认 0，容忍 N 次失败不重置窗口）

**语义决策（确定性，永不 throw）：**

| 情形 | 结果 |
| --- | --- |
| 当前连续达标尾长 >= requiredConsecutive | `stable` |
| 尾长 > 0 但 < requiredConsecutive | `observing` |
| 尾长 = 0 | `unstable` |
| `ready:false` 或超队龄（有 bound 时） | 断窗（按 grace 容忍后硬重置） |
| 纯指标形态（无 `ready`） | 视为 `ready=true`，仅受队龄约束 |
| 队龄缺失/非有限且有 bound | fail-closed 视为超龄 |
| 非法输入（非数组 / 空数组） | `unstable` + `reason`，不 throw |

## 2. planRollback — 回滚预案顾问（纯数据）

```
planRollback(scope, currentState?) -> [{ step:number, action:string, guard:string }]
```

- `scope`：`'video_runtime'`（11 步）或 `'full'`（15 步）；未知 scope 返回 `[]`（fail-closed）。
- 每步含确定性 `action` 与 `guard`（前置条件描述字符串）。**不执行任何副作用。**

**video_runtime 步骤概要（有序）：**

1. 关闭 8 个 `VIDEO_*` 旗标（`FF_<NAME>=0`），首步即 `VIDEO_DURABLE_EVENTS`（同时 gate outbox relay）：
   `VIDEO_DURABLE_EVENTS`、`VIDEO_NEW_ROUTER`、`VIDEO_NEW_DRIVER_RUNTIME`、`VIDEO_WORKFLOW_RUNTIME`、
   `VIDEO_OPERATION_REGISTRY`、`VIDEO_SCHEMA_RUNTIME`、`VIDEO_CANVAS_RUNTIME`、`VIDEO_SCHEMA_UI`
2. 停止 outbox relay 消费面（`dispatcher.runGenerationRelayTick`）
3. 缩减/终止 video runtime runner 工作进程
4. 回退 dispatcher 到 legacy 路由（`driveGenerateTask` 直投）
5. 重新启用 legacy fire-and-forget 分发
6. 恢复旗标默认值（Phase-1 全 OFF / fail-closed）
7. 观测确认队列回稳（`oldestQueueSeconds` 有界、`expiredLeases===0`、`outboxPending===0`）

**full 额外步骤（4 步）：** 版本整体回退（server.js/dispatcher/reconciler）、确认无新 schema 依赖、优雅重启、回滚后冒烟测试。

## 验证结果

- `node --check server/modules/generation-v2/observability.cjs` → SYNTAX OK
- `node --test server/modules/generation-v2/observability.test.cjs` → 16 通过 / 0 失败
