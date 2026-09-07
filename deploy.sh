#!/usr/bin/env bash
# HyperProx — Production Deploy
# Usage: bash /opt/hyperprox/deploy.sh

set -euo pipefail
cd /opt/hyperprox

echo "→ Building API..."
cd apps/api && npx tsc -p tsconfig.json
cd /opt/hyperprox

echo "→ Building Frontend..."
cd apps/frontend && npx next build

# next build regenerates .next/standalone from scratch and deliberately does NOT
# include .next/static or public/ — they have to be copied in after every build.
# Skipping this serves HTML that references CSS/JS which 404, i.e. a completely
# unstyled site. The previous version of this block copied the destination onto
# itself, so it never copied anything.
echo "→ Copying static assets into the standalone build..."
STANDALONE=apps/frontend/.next/standalone/apps/frontend
mkdir -p "$STANDALONE/.next"
rm -rf "$STANDALONE/.next/static"
cp -r apps/frontend/.next/static "$STANDALONE/.next/static"
[ -d apps/frontend/public ] && { rm -rf "$STANDALONE/public"; cp -r apps/frontend/public "$STANDALONE/public"; }

# Fail loudly rather than restarting into a broken site.
if [ ! -d "$STANDALONE/.next/static/css" ]; then
  echo "✗ Static assets were not copied — refusing to restart into an unstyled site." >&2
  exit 1
fi

echo "→ Restarting services..."
systemctl restart hyperprox-api hyperprox-frontend

sleep 3
systemctl status hyperprox-api hyperprox-frontend --no-pager | grep -E "Active|Main PID"
echo "✓ Deploy complete"
