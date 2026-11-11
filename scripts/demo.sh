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
#    HYPERPROX_DEMO_REBUILD=1 pnpm demo       rebuild the demo frontend first
#
#  The demo frontend builds into apps/frontend/.next-demo, never the real .next.
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
  (cd "$ROOT/apps/frontend" && "${CLEAN[@]}" NODE_ENV=production HYPERPROX_NEXT_DIST="$DIST" HYPERPROX_API_PORT="$API_PORT" ./node_modules/.bin/next build)
fi

cleanup() { kill "${API_PID:-}" "${WEB_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd "$ROOT/apps/api" && exec "${CLEAN[@]}" NODE_ENV=production HYPERPROX_DEMO=1 HYPERPROX_DEMO_API_PORT="$API_PORT" HYPERPROX_DEMO_DATA="$DATA" \
  ./node_modules/.bin/tsx src/demo/main.ts) &
API_PID=$!

(cd "$ROOT/apps/frontend" && exec "${CLEAN[@]}" NODE_ENV=production HYPERPROX_NEXT_DIST="$DIST" HYPERPROX_API_PORT="$API_PORT" \
  ./node_modules/.bin/next start -p "$WEB_PORT" -H "$HOST") &
WEB_PID=$!

echo "[demo] HyperProx demo on http://$HOST:$WEB_PORT  (sign in with anything; Ctrl-C stops it)"
wait -n "$API_PID" "$WEB_PID"
