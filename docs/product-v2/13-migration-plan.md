# 13 — Migration Plan (旧 UI → V2, 生产切换)

日期: 2026-08-27
生产: tv.moling.fun (commercial v1, nginx → moling-v1-api-01/02:18001/18002)。本阶段禁改生产。

## 1. 分支与发布模型
- 开发分支 feat/moling-product-ui-v2 (当前), 自 release tag 1515c05
- 每 Phase 合并前: 本地 verify (tsc 0 错 + vite build PASS + 现有 vitest 51 用例不回归)
- 前端部署 = 静态资源替换 (沿用部署铁律: vite build → staging → docker cp /app/dist/build2 → 孤儿 chunk 白名单清理 → 线上 hash 校验)
- 后端小改 (G1/G2/G3 只读 API) 单独分支 feat/v2-readonly-apis, 独立评审, 与 UI 解耦发布; 不触碰认证核心文件

## 2. 数据库
- V2 前端不建新表; G1/G8 用 studio_projects.meta (JSONB 现状) — 零 schema 变更
- G3 只读 API 读既有 *_v2 表 — 零 schema 变更
- 无需迁移; 回滚无数据风险

## 3. 切换步骤 (Phase I)
1. 备份: 当前 /app/dist/build2 tar + 线上 index.html 快照 → /opt/moling-backups/pre-ui-v2-TS/
2. 预检: 本地 staging (127.0.0.1:5433/16379 隔离 PG/Redis) 跑 UAT 全脚本
3. 部署: docker cp 新 dist 进两个 api 容器 (共享静态目录则一次) → hash 校验 → 清孤儿 chunk
4. 301 重定向验证: 02 §5 全表 curl 一遍
5. 观察 30min: 5xx=0, 登录/注册/生成/画布保存 各 1 次真实验证, SSE 正常
6. 回滚预案: 恢复备份 dist (5min 内), 旧 UI 功能全保留 (后端 API 未变)

## 4. 用户影响
- 已登录用户: JWT 不变, 会话跨切换存活
- 收藏/书签: 旧路由 301 到新路由 (02 §5)
- 数据: 零变更 (资产/项目/角色/账务原样)
- 功能空窗: /shop 与 /user/:id 下线 — 提前 3 天落地页公告 (一期不做站内公告, 邮件/GAP G5)
- Studio 解锁: 旧 moduleLocks 软锁在 V2 构建中移除 — 属功能上线, 非中断

## 5. 灰度策略
- 前端静态无法按用户灰度 → 采用 "时间窗灰度": 先 24h 观察 (生产账号自测+监控), 无异常即视为全量 (单版本)
- 如需双版本并存: 可经 nginx location 给 admin 邮箱临时指旧版 — 一期不做, 直接切换+快速回滚

## 6. 依赖顺序 (阻塞关系)
- A → B → C → D → E (E 依赖 D 画布)
- F 依赖 A; F 的 Attempts/Workers 页依赖 G3 后端 API (无 API 时先占位 "数据源建设中", 不阻塞 F 其余 20 页)
- G 依赖 F; H 贯穿; I 最后
- 后端 G1 (画布持久化) 必须早于 D 合并生产; G2 早于 B; G3 可并行
