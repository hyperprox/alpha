#!/usr/bin/env bash
# =============================================================================
#  Fetches the three typefaces the HyperProx frontend uses (Barlow Condensed, Barlow,
#  IBM Plex Mono; SIL Open Font License) from the npm registry, once, into
#  apps/frontend/public/demo-fonts/, so the demo build serves them itself instead of
#  asking a font service. Run it before building the demo frontend. Without it the
#  demo still works, in the system fonts.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/apps/frontend/public/demo-fonts"
WORK="$(mktemp -d)"
cleanup() { find "$WORK" -mindepth 1 -delete; rmdir "$WORK"; }
trap cleanup EXIT
declare -A WEIGHTS=([barlow-condensed]="500 600 700" [barlow]="400 500 600" [ibm-plex-mono]="400 500")
for pkg in barlow-condensed barlow ibm-plex-mono; do
  (cd "$WORK" && npm pack --silent "@fontsource/$pkg@5" >/dev/null)
  mkdir -p "$WORK/$pkg"
  tar -xzf "$WORK"/fontsource-"$pkg"-*.tgz -C "$WORK/$pkg"
  for w in ${WEIGHTS[$pkg]}; do
    cp "$WORK/$pkg/package/files/$pkg-latin-$w-normal.woff2" "$OUT/"
  done
  if [ -f "$WORK/$pkg/package/LICENSE" ]; then cp "$WORK/$pkg/package/LICENSE" "$OUT/LICENSE-$pkg"; fi
done
echo "[demo] fonts in $OUT"
