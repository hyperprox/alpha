#!/usr/bin/env bash
# =============================================================================
#  HyperProx demo: the real frontend in front of the demo API (apps/api/src/demo).
#
#  Every page shows invented data; every change, reveal, Send, terminal and live
#  shell is refused by the demo API. Nothing here reads a database, the vault, a
#  credential store or a .env file, and both processes start from an empty
#  environment (env -i), so no setting from a real install can reach them.
#
#    pnpm demo                                build (first run) and start on http://127.0.0.1:3100
#    HYPERPROX_DEMO_HOST=0.0.0.0 pnpm demo    listen on every address (for a screenshot machine)
#    HYPERPROX_DEMO_REBUILD=1 pnpm demo       rebuild the demo frontend and API first
#
#  Both halves are production builds: the frontend into apps/frontend/.next-demo (never the
#  real .next), the API into apps/api/dist-demo. Both processes refuse every outbound
#  connection (apps/api/src/demo/no-outbound.ts). The public, open-internet setup is in
#  docs/demo.md.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PORT="${HYPERPROX_DEMO_PORT:-3100}"
API_PORT="${HYPERPROX_DEMO_API_PORT:-3102}"
HOST="${HYPERPROX_DEMO_HOST:-127.0.0.1}"
DATA="${HYPERPROX_DEMO_DATA:-${TMPDIR:-/tmp}/hyperprox-demo-$(id -u)}"
DIST=".next-demo"

for p in "$WEB_PORT" "$API_PORT"; do
  if [ "$p" = 3000 ] || [ "$p" = 3002 ]; then echo "[demo] port $p belongs to the real HyperProx; pick another." >&2; exit 2; fi
done

# The only variables either process gets.
CLEAN=(env -i "PATH=$PATH" "HOME=${HOME:-/tmp}" "LANG=C.UTF-8" "NEXT_TELEMETRY_DISABLED=1")

if [ ! -f "$ROOT/apps/frontend/$DIST/BUILD_ID" ] || [ -n "${HYPERPROX_DEMO_REBUILD:-}" ]; then
  echo "[demo] building the demo frontend into apps/frontend/$DIST (once)"
  (cd "$ROOT/apps/frontend" && "${CLEAN[@]}" NODE_ENV=production NEXT_PUBLIC_HYPERPROX_DEMO=1 HYPERPROX_NEXT_DIST="$DIST" HYPERPROX_API_PORT="$API_PORT" ./node_modules/.bin/next build)
  # next build rewrites the tracked next-env.d.ts to point at the demo folder; put it back so the checkout stays
  # clean (an update refuses a tree with local changes). Not a git checkout: nothing to restore.
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" checkout -- apps/frontend/next-env.d.ts 2>/dev/null || true
  fi
fi
if [ ! -f "$ROOT/apps/api/dist-demo/demo/main.js" ] || [ -n "${HYPERPROX_DEMO_REBUILD:-}" ]; then
  echo "[demo] building the demo API into apps/api/dist-demo"
  (cd "$ROOT/apps/api" && "${CLEAN[@]}" ./node_modules/.bin/tsc -p tsconfig.demo.json)
fi
GUARD="$ROOT/apps/api/dist-demo/demo/no-outbound-register.js"

cleanup() { kill "${API_PID:-}" "${WEB_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd "$ROOT/apps/api" && exec "${CLEAN[@]}" NODE_ENV=production HYPERPROX_DEMO=1 HYPERPROX_DEMO_API_PORT="$API_PORT" HYPERPROX_DEMO_DATA="$DATA" \
  node dist-demo/demo/main.js) &
API_PID=$!

(cd "$ROOT/apps/frontend" && exec "${CLEAN[@]}" NODE_ENV=production NODE_OPTIONS="--require $GUARD" HYPERPROX_NEXT_DIST="$DIST" HYPERPROX_API_PORT="$API_PORT" \
  ./node_modules/.bin/next start -p "$WEB_PORT" -H "$HOST") &
WEB_PID=$!

echo "[demo] HyperProx demo on http://$HOST:$WEB_PORT  (it opens on the dashboard; Ctrl-C stops it)"
wait -n "$API_PID" "$WEB_PID"
