# 10 — Permission Map

日期: 2026-08-27
原则: 前端权限 = UX 层 (隐藏入口/禁用按钮); 后端授权 = 最终安全边界 (每个 API 独立校验, 不变)。

## 1. 角色
- anonymous: 无 session
- user: 已登录 (users.role='user')
- admin: users.role='admin' (含 user 全部权限)

## 2. Route Permission (路由级)

| 路由组 | anonymous | user | admin |
|---|---|---|---|
| /, /login, /register, /setup, /help, /privacy, /about | ✓ | ✓ | ✓ |
| /models (目录) | ✓ | ✓ | ✓ |
| /dashboard /create /assets /characters /tasks /account /billing /settings | ✗ | ✓ | ✓ |
| /projects* /studio* | ✗ | ✓ (owner 项目) | ✓ |
| /admin/* (全部 22) | ✗ | ✗ | ✓ |
| 旧 /user/:id /shop/* | — | 一期下线 | — |

实现: RequireAuth / RequireAdmin 路由守卫 (现状保留), owner 校验 (项目) 前端按 me.id 比对, 后端 PATCH/DELETE 已校验 owner。

## 3. Navigation Permission (导航可见性)
- User Shell 导航: 全 user 可见; admin 额外见 "管理后台" 入口 (现 navigationDockConfigs 已有该逻辑, V2 沿用数据驱动注册表 config/adminRegistry.ts)
- Admin Shell 分组: 一期 admin 全见; 预留 group-level permission key (后端未来细分角色时前端按 nav items 的 `perm` 字段过滤, 缺省 'admin')
- 被锁/建设中: V2 移除 moduleLocks 的 comingSoon 占位, 导航注册表带 `status: live` 字段, 非 live 项显示 badge 且可点击 (不硬锁)

## 4. Action Permission (操作级)

| 操作 | 允许角色 | 后端校验点 |
|---|---|---|
| 生成/取消/重试 | user (owner 任务) | generate 路由 owner 比对 + 积分 |
| 资产增删改 | user (owner) | media owner |
| 角色/项目 CRUD | user (owner) | characters/studio owner |
| 提交参考样式/反馈/举报 | user | session |
| 技能试跑 (扣积分) | user | /api/skill/run |
| Provider/Key/Model/Binding/Price 写 | admin | admin 角色 (handleAdmin 分界) |
| 手动充值/改用户积分/重置密码/删用户 | admin | admin + 审计日志 |
| 清日志/清错误归档 | admin | admin |
| 路由冷却/禁用 | admin | admin |
| 支付 webhook | 系统 (签名) | payments webhook 校验 |
| V2 观测读 | admin | admin (G3 只读) |

前端体现: 按钮级 can(action) 工具 (读 role + owner), 无权限 = 不渲染 (非 disabled), 防止误点; 表格行操作同。

## 5. Admin Permission 细分 (预留)
一期单 admin 角色。数据模型预留: adminRegistry 每项 `perm: 'admin'` (未来 'finance'/'supply' 等细分时, 前端过滤 + 后端按 perm 校验)。当前不实现细分, 避免前端自造权限。

## 6. 数据级权限
- 所有用户数据查询带 owner 过滤 (media/characters/projects/me.*) — 后端现状已保证, 前端不做数据级过滤
- admin 全量视图仅经 /api/admin/* 获得
- 凭据类: API key 永远 mask (后端), 前端不回显明文; Provider baseUrl 可见
