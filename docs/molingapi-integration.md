# AiOnline 接入墨灵中转站

AiOnline 继续负责登录、积分、媒体和 OSS；`molingapi` 负责 provider、密钥池、模型目录、路由和上游任务。浏览器只访问 AiOnline 的 `/api/*`，内部令牌、用户签名和 provider key 永远不下发到浏览器。

## 开关

在 AiOnline 服务端 `.env` 配置：

```dotenv
MODEL_RELAY_ENABLED=false
MODEL_RELAY_BASE_URL=http://127.0.0.1:3010
MODEL_RELAY_INTERNAL_TOKEN=
MODEL_RELAY_USER_SIGNING_KEY=
MODEL_RELAY_TIMEOUT_MS=10000
MODEL_RELAY_POLL_INTERVAL_MS=2000
MODEL_RELAY_MAX_POLLS=2700
```

令牌值只从已部署的 molingapi 服务端配置复制到 AiOnline 服务端配置，不写入仓库、前端环境变量或日志。`MODEL_RELAY_ENABLED=false` 是回滚开关。

## 生成流程

1. AiOnline 校验登录用户、解析本地计费价并 `reserve` 一次积分。
2. AiOnline 服务端以 HMAC 签名的 `x-user-id` 调用 `POST /v1/generations`。
3. AiOnline 将 relay task 映射到本地 `generation_tasks`，后台轮询 molingapi。
4. relay 成功后只 `commit` 一次，并把 provider URL 放入现有 OSS 上传队列；失败/取消只 `release` 一次。
5. 现有 `/api/generate/status/:taskId`、SSE 和 cancel 接口继续服务前端，前端无需直连 molingapi。

`finalizing` 是 AiOnline 内部不可取消的结算/上传临时状态，对外映射为 `running`；只有上传队列完成后才向浏览器发送 `done`。

## 灰度与回滚

先在单独的 AiOnline 实例设置 `MODEL_RELAY_ENABLED=true`，使用无费用测试 provider 验证：模型目录、余额 reserve/commit、失败 release、SSE、刷新恢复和 cancel。观察无误后再切换生产实例。

出现异常时将 `MODEL_RELAY_ENABLED=false` 并重启 AiOnline，新的请求立即回到原 dispatcher；不要删除 `model_relay` schema 或 AiOnline 原有 provider/model 表。已提交的 relay 任务仍应保留可取消/恢复所需的服务端令牌。
