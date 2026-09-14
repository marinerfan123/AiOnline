#!/usr/bin/env bash
# M00 version audit — read-only, against npm registry (no install).
# Records what M00 foundations were built on. Re-run before adding new deps.
set -u
cd "$(dirname "$0")/.."

PKGS="react react-dom react-router-dom typescript vite
@tanstack/react-query zustand zod vaul
@radix-ui/react-slot @radix-ui/react-select @radix-ui/react-dialog @radix-ui/react-tooltip
openapi-typescript @storybook/react-vite storybook @playwright/test"

echo "== M00 version audit — $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
echo "== policy: latest dist-tag, stable only (no beta/rc/canary) =="
for p in $PKGS; do
  latest=$(npm view "$p" dist-tags.latest 2>/dev/null || echo "NOT_FOUND")
  local_v=$(node -e "const j=require('./package.json');const d={...j.dependencies,...j.devDependencies};process.stdout.write(d['$p']||'-')" 2>/dev/null)
  echo "$p local=$local_v registry_latest=$latest"
done
