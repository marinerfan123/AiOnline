# Phase 0 多阶段构建 — 应用镜像
# 构建阶段产出 dist/build2；运行阶段仅含生产依赖 + server + 静态产物

# ── 构建阶段 ──
FROM node:22-alpine AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ── 运行阶段 ──
FROM node:22-alpine AS runtime
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY
WORKDIR /app
ENV NODE_ENV=production
# 仅安装生产依赖（pg / ioredis / dotenv）
# 注：用 npm install 而非 npm ci —— 本仓库 package-lock.json 在部分 registry 镜像上
# 存在版本漂移，npm install 会按 package.json 补齐缺失项并复用已锁版本，更稳健。
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
# Media normalization jobs (G06): ffprobe/ffmpeg for probe/thumbnail/proxy/waveform.
# Alpine repo mirror is parameterized (CN boxes: dl-cdn unreachable → aliyun/tuna).
ARG ALPINE_BASE=https://dl-cdn.alpinelinux.org/alpine
RUN printf '%s/v3.24/main\n%s/v3.24/community\n' "$ALPINE_BASE" "$ALPINE_BASE" > /etc/apk/repositories && apk add --no-cache ffmpeg
COPY server ./server
# 公共静态资源（如客服群二维码），支持容器内直接替换，无需重新构建
COPY public ./public
# 注意：dist 已被 .dockerignore 排除，必须从构建阶段拷贝已编译产物（输出在 dist/build2）
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "server/server.js"]
