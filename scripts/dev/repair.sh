#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/dev/repair.sh — 数据库级修复脚本（幂等，可重复运行）
#
# 修复两项历史死链根因：
#   1) 删除 media 中 status∈(failed,success) 且三列 URL 全空的「死链占位」
#      （来源：failed 占位 / done 缺 mediaId 被回退转正的 success 占位）。
#   2) 将 generation_tasks 中超过安全线仍 running 的「僵尸任务」标为 timeout
#      （防僵尸安全线，非失败、不退积分，符合项目超时铁律）。
#
# 用法：
#   bash scripts/dev/repair.sh            # 真实执行删除 + 标记
#   bash scripts/dev/repair.sh --dry-run  # 仅统计，不改动
#
# 退出码：0=完成；非0=PG 连接失败或执行异常。
# ─────────────────────────────────────────────────────────────────────────────
set -u
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DRY=""
if [ "${1:-}" = "--dry-run" ]; then DRY="--dry-run"; fi

log "════════ 墨灵AI 数据库修复 ════════"
[ -n "$DRY" ] && warn "DRY-RUN 模式：仅统计，不改动任何数据"

# 确保 PG 可达
require_cmd node >/dev/null 2>&1 || { err "node 不可用"; exit 1; }
if ! wait_pg_ready 30; then
  err "PostgreSQL 不可达，修复中止。"
  exit 1
fi

log "── 步骤1：清理死链占位 ──"
dbtool clean-deadlinks $DRY 2>&1 | while read -r line; do log "  $line"; done

log "── 步骤2：僵尸任务标 timeout ──"
dbtool timeout-zombies $DRY 2>&1 | while read -r line; do log "  $line"; done

log "── 修复后复检 ──"
dbtool stats 2>&1 | while read -r line; do log "  $line"; done

log "════════ 修复结束 ════════"
