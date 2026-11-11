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

# Per-install settings this version expects (METRICS_TOKEN, pve.yml, Grafana behind /grafana/, no npm
# profile). Idempotent, restarts nothing, and runs before the build because NEXT_PUBLIC_* is baked in.
echo "→ Bringing this install's configuration up to date..."
bash bin/hyperprox-config

# The front door is https through hyperprox-nginx, which shares the host network and reads certs/. An
# install from before that has no certificate yet: make the same self-signed one the installer makes
# (kept from then on; replace certs/*.pem with your own any time). Then check the config with the real
# mounts here, before anything is built, so a bad config stops the deploy with the running nginx left
# alone. The swap itself happens after the API restart below, because the new config sends /grafana/
# through an API check that only the new API has. The swap is a second or two on :80/:443.
echo "→ Checking the nginx front door..."
mkdir -p certs data/nginx/trusted-proxies   # the second: proxies whose X-Forwarded-Proto is believed
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

# Migrations last, after everything that can still fail: a type error, a failed build or missing assets
# stop the deploy with the live database untouched, so the running API keeps the schema it expects. The new
# code is only started after this (below). apps/api/test/deploy-order.test.ts checks the order.
echo "→ Applying database migrations..."
# DATABASE_URL stays in .env (the database is needed before the vault is unlocked).
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
if [ -z "$DATABASE_URL" ]; then
  echo "✗ DATABASE_URL is not in .env; migrations not applied." >&2
  exit 1
fi
(cd apps/api && DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy --schema ./prisma/schema.prisma)

# The keyholder holds the unlocked vault state, so the API restart below does not lock HyperProx. It is
# installed or started if needed and otherwise left alone; restarted only when its own program changed
# (which locks HyperProx, and bin/install-keyholder says so). Never restarted just because this is a deploy.
echo "→ Checking the keyholder..."
bash bin/install-keyholder

# Units from before the nginx front door bind every interface; a drop-in pins both to loopback. It only
# reloads systemd (when it changed something): the restart below is the one there always was.
echo "→ Keeping the API and frontend on loopback..."
bash bin/hyperprox-bind

echo "→ Restarting services..."
systemctl restart hyperprox-api hyperprox-frontend

# compose recreates the container only when its definition changed; the files under config/nginx are
# bind mounts, so a changed config needs the reload (graceful: open connections finish on the old one).
echo "→ Swapping in the checked nginx config..."
docker compose up -d --no-deps nginx >/dev/null
docker exec hyperprox-nginx nginx -s reload >/dev/null

# A reload that nginx rejects leaves the old config running, and the old /grafana/ had no session check.
# So prove the gate is there before Grafana is (re)created: no cookie must get a 302 to /login. If not,
# hyperprox-gate-check stops Grafana and the deploy ends here, without claiming it completed.
echo "→ Checking that /grafana/ is gated..."
if ! bash bin/hyperprox-gate-check; then
  echo "✗ Deploy stopped: nginx is not serving the gated config. The API and frontend are already updated." >&2
  exit 1
fi

# Prometheus listens on 127.0.0.1:9090 and Grafana on 127.0.0.1:3003 (host network, reached only through
# nginx at /grafana/). Compose recreates each container once, the first time its settings differ, and
# leaves it alone on every deploy after that. Its data is in data/prometheus and the grafana_data volume.
if [[ ",$(grep -m1 '^COMPOSE_PROFILES=' .env | cut -d= -f2- | tr -d "\"' "),"  == *",monitoring,"* ]] \
   || docker ps -a --format '{{.Names}}' | grep -qxE 'hyperprox-(prometheus|grafana)'; then
  echo "→ Applying the monitoring containers' settings..."
  docker compose up -d --no-deps prometheus grafana
  # A container left alone keeps the alert rules it read at start: ask it to read config/prometheus/rules again.
  if curl -fsS -m 10 -X POST http://127.0.0.1:9090/-/reload >/dev/null 2>&1; then
    echo "→ Prometheus re-read its alert rules"
  else
    echo "! Prometheus did not re-read its alert rules (not running yet?); they apply at its next restart" >&2
  fi
fi

sleep 3
systemctl status hyperprox-api hyperprox-frontend --no-pager | grep -E "Active|Main PID"
echo "✓ Deploy complete"
