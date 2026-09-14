# 27 — Browser E2E 验证环境（2026-09-04 建立）

## 拓扑
- 前端产物：大机 8.217.12.36 `/opt/moling-client`（node20 npmmirror tar、npm ci
  后须 `npm i @rolldown/binding-linux-x64-gnu` 否则 vite8/rolldown 缺 native binding；
  `npx vite build --outDir dist` 出 8.9M——896M 测试机 OOM 已解）
- 静态+同源代理：`/opt/e2e-host.js`（node http，nohup）——dist 静态 + `/api/*` 代理到
  测试机 47.122.107.24:13001（api 容器 3001→0.0.0.0:13001，公网可达，未登录 401）
- 外网 8080 未放行（安全组）→ 本机 SSH 隧道：`ssh -L 18080:127.0.0.1:8080 root@8.217.12.36`
- 浏览器入口：http://127.0.0.1:18080/

## 已实测全流程（2026-09-04, browser-exec chromium）
1. 首启初始化向导（DB 无 admin）→ 创建管理员 admin@e2e.moling.test
2. 完成初始化 → 登录页 → 登录成功 → 首页（墨灵AI 流水线营销/导航/素材库）
3. 进入工作台 /workspace：素材库（全部/图片/视频/角色/场景/道具…）、生图面板
   （提示词/模型/比例/参考图/并发）、余额展示 1000.0/0.0

## 边界（诚实）
- 生图真执行需 provider API key（未配，初始化时跳过服务商步）→ 只验 UI/流程，不假造产物
- /studio 画布工作台 Phase-4 骨架（导航可见，未列入本次 flow）
- 素材库配额显示 1000.0/0.0（存储容量口径，未见换算说明）——前端 parity 观察项

## 用途
G23/G24 验收跑单、UI parity 审计、V2.0 must-pass UI 层（导入向导/编辑直达/lock 视觉）实测底座。
