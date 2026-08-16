#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/dev/restart.sh — 前后端重启 + 清理缓存 + 清理 Redis（一键）
#
# 流程：
#   1) 确保 PG 容器运行（项目 DB 在 huabu-pg；Redis 由 workaigc-redis:6379 提供）。
#   2) 按端口杀掉旧 后端(3001) / 前端(5173) 进程树（Windows taskkill）。
#   3) 清理 Vite 缓存（node_modules/.vite）。
#   3.5) 清理 Redis 缓存（flushall，仅缓存/限流用途）。
#   4) npm run dev 后台拉起（vite + node server.js 并行，日志 logs/restart.log）。
#   5) 校验 端口监听 + /api/healthz。
#
# 用法：bash scripts/dev/restart.sh
# 说明：脚本在 Windows + Git Bash 下运行；后台 npm 进程在终端关闭后可能被回收，
#       长期常驻请在保持终端打开的情况下运行，或用 Windows 服务 / pm2 托管。
# ─────────────────────────────────────────────────────────────────────────────
set -u
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

log "════════ 墨灵AI 重启（前后端 + 清缓存） ════════"

require_cmd node  || exit 1
require_cmd npm   || exit 1

# 1) 确保 PG（项目 DB）。Redis 由 workaigc-redis(6379) 提供，无需启 huabu-redis。
ensure_container huabu-pg || warn "huabu-pg 未自动启动，请确认 PG 可达后重试"

# 2) 杀旧进程（后端 + 前端）
old_bpid="$(find_pids_on_port "$BACKEND_PORT")"
[ -n "$old_bpid" ] && log "重启前后端 PID=$old_bpid（将尝试杀掉并拉起新进程）"
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"
# 等待端口释放（TIME_WAIT）
sleep 2

# 3) 清 Vite 缓存
clear_vite_cache

# 3.5) 清 Redis 缓存（flushall，仅缓存/限流用途）
flush_redis

# 4) 启动 npm run dev（vite + node server.js 并行）
cd "$REPO_ROOT" || { err "无法进入仓库根目录 $REPO_ROOT"; exit 1; }
LOG="$LOG_DIR/restart.log"
log "启动 npm run dev → 日志 $LOG"
nohup npm run dev > "$LOG" 2>&1 &
echo $! > "$LOG_DIR/dev.pid"
ok "已发起 npm run dev（pidfile=$LOG_DIR/dev.pid），等待服务拉起..."

# 5) 校验
sleep 3
wait_port "$BACKEND_PORT" 40
rc1=$?
wait_port "$FRONTEND_PORT" 40
rc2=$?
wait_healthz 40
rc3=$?

if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$rc3" -eq 0 ]; then
  # 校验：后端必须是「新」进程（防止旧进程未被杀掉却仍应答 healthz 的假成功）
  new_bpid="$(find_pids_on_port "$BACKEND_PORT")"
  if [ -n "$old_bpid" ] && [ "$new_bpid" = "$old_bpid" ]; then
    warn "端口 $BACKEND_PORT 仍是旧进程 PID=$old_bpid（taskkill 可能未生效），服务虽在响应但并未真正重启。"
    warn "请在拥有足够权限的终端（或管理员 Git Bash）重新运行本脚本；必要时先手动结束该进程。"
  else
    ok "════════ 重启成功：前后端已就绪（新后端 PID=${new_bpid:-?}） ════════"
  fi
else
  err "════════ 重启未完成，请查看 $LOG ════════"
fi
