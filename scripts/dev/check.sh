#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/dev/check.sh — 只读健康检查脚本（不修改任何状态）
#
# 用途：每次手动巡检前后端 / 容器 / 数据库死链 / 僵尸任务。
# 用法：bash scripts/dev/check.sh
# 输出：人类可读诊断 + 退出码（0=健康，非0=需关注/异常）
# ─────────────────────────────────────────────────────────────────────────────
set -u
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

log "════════ 墨灵AI 健康检查 ════════"

# 1) 进程端口
bpid="$(find_pids_on_port "$BACKEND_PORT")"
fpid="$(find_pids_on_port "$FRONTEND_PORT")"
if [ -n "$bpid" ]; then ok "后端  : 端口 $BACKEND_PORT LISTENING (PID=$bpid)"; else warn "后端  : 端口 $BACKEND_PORT 未监听"; fi
if [ -n "$fpid" ]; then ok "前端  : 端口 $FRONTEND_PORT LISTENING (PID=$fpid)"; else warn "前端  : 端口 $FRONTEND_PORT 未监听（Vite 未运行）"; fi

# 2) 健康检查
http_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTHZ_URL" 2>/dev/null)"
if [ "$http_code" = "200" ]; then ok "healthz: $HEALTHZ_URL -> 200"; else warn "healthz: $HEALTHZ_URL -> ${http_code:-无响应}"; fi

# 3) Docker 容器
if require_cmd docker >/dev/null 2>&1; then
  for c in huabu-pg huabu-redis workaigc-redis; do
    st="$(docker ps -a --filter "name=^${c}$" --format '{{.Status}}' 2>/dev/null | head -1)"
    if echo "$st" | grep -qi 'Up'; then ok "容器 $c: Up"; else warn "容器 $c: ${st:-未找到}"; fi
  done
else
  warn "docker 不可用，跳过容器检查"
fi

# 4) DB 诊断（死链 / 僵尸任务）
log "── DB 诊断 ──"
dbtool stats 2>&1 | while read -r line; do log "  $line"; done

# 5) 汇总退出码
rc=0
[ -z "$bpid" ] && rc=1
[ -z "$fpid" ] && rc=1
[ "$http_code" != "200" ] && rc=1
log "════════ 检查结束（退出码 $rc） ════════"
exit $rc
