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

# The front door is https through hyperprox-nginx, which shares the host network and reads certs/. An
# install from before that has no certificate yet: make the same self-signed one the installer makes
# (kept from then on; replace certs/*.pem with your own any time). Then check the config with the real
# mounts before swapping containers, so a bad config leaves the running nginx alone instead of taking
# the site down. The swap is the only interruption: a second or two on :80/:443.
echo "→ Checking the nginx front door..."
mkdir -p certs
if [ ! -s certs/cert.pem ] || [ ! -s certs/key.pem ]; then
  HOST_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"
  SAN="DNS:$(hostname),DNS:localhost,IP:127.0.0.1"
  [ -n "$HOST_IP" ] && SAN="IP:${HOST_IP},${SAN}"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=$(hostname)" -addext "subjectAltName=${SAN}" \
    -keyout certs/key.pem -out certs/cert.pem 2>/dev/null
  echo "  generated a self-signed certificate in certs/ (${SAN})"
fi
chmod 644 certs/cert.pem; chmod 600 certs/key.pem
if ! NGINX_T="$(docker compose run --rm --no-deps -T nginx nginx -t -q 2>&1)"; then
  printf '%s\n' "$NGINX_T" | tail -20 >&2
  echo "✗ The nginx config does not pass nginx -t; the running nginx was left as it was." >&2
  exit 1
fi
docker compose up -d --no-deps nginx >/dev/null

echo "→ Installing dependencies..."
pnpm install --frozen-lockfile >/dev/null
(cd apps/api && npx prisma generate --schema ./prisma/schema.prisma >/dev/null)

echo "→ Applying database migrations..."
# DATABASE_URL stays in .env (the database is needed before the vault is unlocked).
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
if [ -z "$DATABASE_URL" ]; then
  echo "✗ DATABASE_URL is not in .env; migrations not applied." >&2
  exit 1
fi
(cd apps/api && DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy --schema ./prisma/schema.prisma)

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
