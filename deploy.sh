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

echo "→ Copying static assets..."
mkdir -p apps/frontend/.next/standalone/apps/frontend/.next
cp -r apps/frontend/.next/standalone/apps/frontend/.next/static apps/frontend/.next/standalone/apps/frontend/.next/static
cp -r apps/frontend/public 2>/dev/null || true # apps/frontend/.next/standalone/apps/frontend/public 2>/dev/null || true

echo "→ Restarting services..."
systemctl restart hyperprox-api hyperprox-frontend

sleep 3
systemctl status hyperprox-api hyperprox-frontend --no-pager | grep -E "Active|Main PID"
echo "✓ Deploy complete"
