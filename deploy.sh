#!/usr/bin/env bash
# HyperProx — Production Deploy
# Usage: bash /opt/hyperprox/deploy.sh

set -euo pipefail
cd /opt/hyperprox

# Since the vault gate, the API cannot run without the bundled vault: an install that predates it would
# restart into a HyperProx that stays locked forever. Re-running the installer adds the vault and keeps
# all existing data and settings.
if ! grep -q '^VAULT_ADMIN_TOKEN_HASH=' .env 2>/dev/null || [ ! -s config/vault-tls/cert.pem ] \
   || ! grep -q 'wait-for-vault' /etc/systemd/system/hyperprox-api.service 2>/dev/null; then
  echo "✗ This install has no vault yet. Run: bash /opt/hyperprox/install.sh  (safe to re-run; keeps your data)" >&2
  exit 1
fi
docker compose up -d --no-deps vault >/dev/null
chmod 600 .env

echo "→ Installing dependencies..."
pnpm install --frozen-lockfile >/dev/null
(cd apps/api && npx prisma generate --schema ./prisma/schema.prisma >/dev/null)

echo "→ Building API..."
cd apps/api && npx tsc -p tsconfig.json
cd /opt/hyperprox

echo "→ Building Frontend..."
cd apps/frontend && npx next build
cd /opt/hyperprox   # next build leaves us in apps/frontend; every path below is repo-relative

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
