#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/dev/common.sh — 重启 / 检查 / 修复 三脚本共享函数库
#
# 设计前提（Windows + Git Bash 环境）：
#   - 进程是 Windows-native，不能用 bash 内建 kill -9（MSYS PID 命名空间隔离，
#     杀不掉 Windows 进程）。按端口查杀必须走 Windows 原生命令 taskkill。
#   - 端口探测走 netstat -ano（Git Bash 自带），解析最后一列 PID。
#   - 健康检查用 curl（Git Bash 自带）。
#   - DB 操作统一走 dbtool.cjs（node server/scripts/dbtool.cjs ...）。
#
# 本文件只定义函数与常量，被 source 后不会自行执行。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# ── 路径常量（以仓库根目录为基准） ──
# DEV_DIR 用 POSIX 风格（供 bash source 自身用）；REPO_ROOT 用 Windows 风格
# （pwd -W → E:/code），因为脚本内的 node / docker 等 Windows 原生程序无法
# 正确解析 Git Bash 的 POSIX 路径 /e/code（会被误读为 E:\e\code）。
DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEV_DIR/../.." && pwd -W)"
LOG_DIR="$REPO_ROOT/logs"
DEV_LOG="$LOG_DIR/dev.log"
mkdir -p "$LOG_DIR"

# 端口
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
HEALTHZ_URL="http://localhost:${BACKEND_PORT}/api/healthz"

# 安全线（分钟），与 dbtool.cjs / 项目超时铁律保持一致
export SAFETY_MINUTES="${SAFETY_MINUTES:-90}"

# ── 日志 ──
log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] $*"
  echo "[$ts] $*" >> "$DEV_LOG"
}
ok()  { log "✅ $*"; }
warn(){ log "⚠️  $*"; }
err() { log "❌ $*"; }

# ── 命令可用性 ──
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "缺少命令：$1（请在 Git Bash / 已装 Docker·Node 的环境运行）"
    return 1
  fi
  return 0
}

# ── 端口 → PID 列表（Windows netstat 解析） ──
# 返回监听该端口的 PID（可能多个，空格分隔）。
find_pids_on_port() {
  local port="$1"
  netstat -ano 2>/dev/null \
    | awk -v port=":$port" '$4=="LISTENING" && $2 ~ (port "$") {print $5}' \
    | sort -u
}

# ── 按端口杀进程树（Windows taskkill） ──
# 写日志并返回杀掉的 PID 数。
kill_port() {
  local port="$1"
  local pids killed=0
  pids="$(find_pids_on_port "$port")"
  if [ -z "$pids" ]; then
    log "端口 $port 无监听进程，无需杀。"
    return 0
  fi
  for pid in $pids; do
    log "杀掉端口 $port 上的进程 PID=$pid (taskkill /F /T)"
    # Windows 原生命令；Git Bash 下 /F /T /PID 非路径，原样传给 taskkill。
    taskkill /F /T /PID "$pid" >/dev/null 2>&1 && killed=$((killed+1)) \
      || warn "taskkill PID=$pid 失败（可能已退出或无权限）"
  done
  echo "$killed"
}

# ── 等待端口监听 ──
wait_port() {
  local port="$1" timeout="${2:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if [ -n "$(find_pids_on_port "$port")" ]; then
      ok "端口 $port 已监听"
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  err "等待端口 $port 超时（${timeout}s）"
  return 1
}

# ── 等待 healthz 返回 200 ──
wait_healthz() {
  local timeout="${1:-40}" i=0 http_code
  while [ "$i" -lt "$timeout" ]; do
    http_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTHZ_URL" 2>/dev/null)"
    if [ "$http_code" = "200" ]; then
      ok "后端健康检查通过：$HEALTHZ_URL (200)"
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  err "等待 healthz 超时（${timeout}s），最后 http_code=$http_code"
  return 1
}

# ── 等待 PG 就绪（复用 dbtool ping 的退出码） ──
wait_pg_ready() {
  local timeout="${1:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if node "$REPO_ROOT/server/scripts/dbtool.cjs" ping >/dev/null 2>&1; then
      ok "PostgreSQL 连接就绪"
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  err "等待 PostgreSQL 就绪超时（${timeout}s）"
  return 1
}

# ── dbtool 包装：运行 dbtool.cjs 并过滤 dotenvx 调试噪声行 ──
# dotenvx 每次运行都会往 stdout 打一行 "◇ injected env ..."，对诊断无用，过滤掉。
dbtool() {
  node "$REPO_ROOT/server/scripts/dbtool.cjs" "$@" 2>&1 | grep -v 'injected env'
}

# ── 确保 Docker 容器运行 ──
ensure_container() {
  local name="$1"
  if ! require_cmd docker >/dev/null 2>&1; then
    warn "docker 不可用，跳过容器 $name 检查（请确认 PG 已由其他方式提供）"
    return 0
  fi
  local state
  state="$(docker ps -a --filter "name=^${name}$" --format '{{.Status}}' 2>/dev/null | head -1)"
  if [ -z "$state" ]; then
    warn "未找到容器 $name（可能不在本机），跳过。"
    return 0
  fi
  if echo "$state" | grep -qi 'Up'; then
    ok "容器 $name 已在运行 ($state)"
    return 0
  fi
  log "容器 $name 状态：$state，尝试 docker start ..."
  if docker start "$name" >/dev/null 2>&1; then
    ok "已启动容器 $name"
    return 0
  else
    err "docker start $name 失败，请手动检查。"
    return 1
  fi
}

# ── 清 Vite 缓存 ──
clear_vite_cache() {
  local cache_dir="$REPO_ROOT/node_modules/.vite"
  if [ -d "$cache_dir" ]; then
    log "清理 Vite 缓存：$cache_dir"
    rm -rf "$cache_dir"
    ok "Vite 缓存已清理"
  else
    log "Vite 缓存目录不存在，跳过。"
  fi
}

# ── 清理 Redis（仅缓存/限流用途，flushall 安全） ──
# 优先 redis-cli；不可用则回退到项目自带的 ioredis 脚本（redis_flush.cjs）。
flush_redis() {
  log "清理 Redis 缓存（flushall）..."
  # 优先尝试 redis-cli
  if command -v redis-cli >/dev/null 2>&1; then
    local host="${REDIS_HOST:-localhost}" port="${REDIS_PORT:-6379}" pw=""
    [ -n "${REDIS_PASSWORD:-}" ] && pw="-a $REDIS_PASSWORD"
    if redis-cli -h "$host" -p "$port" $pw flushall >/dev/null 2>&1; then
      ok "Redis 已清空（redis-cli: $host:$port）"
      return 0
    else
      warn "redis-cli flushall 失败，尝试 ioredis 回退..."
    fi
  fi
  # 回退：node + 项目 ioredis（读取 .env 中的 REDIS_*）
  if node "$DEV_DIR/redis_flush.cjs" 2>&1; then
    ok "Redis 已清空（ioredis 回退）"
    return 0
  else
    warn "Redis 清理失败（可能服务未启动或非缓存用途）；已跳过，不影响前后端重启。"
    return 0
  fi
}
