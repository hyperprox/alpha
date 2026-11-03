#!/usr/bin/env bash
# The monitoring stack as docker-compose.yml defines it, end to end: Prometheus and Grafana bound to
# loopback only, Grafana reading Prometheus on 127.0.0.1, and nginx letting a browser reach Grafana at
# /grafana/ only with a real HyperProx session (the real gate and auth routes, on an in-memory vault),
# including the embedded dashboard URL the Monitoring page uses, a query, and the Grafana Live WebSocket.
#
# Runs beside a real install without touching it: compose project abtest-mon (containers abtest-mon-*),
# Prometheus on 127.0.0.1:19090, Grafana on 127.0.0.1:13003, the API on 127.0.0.1:18392 and nginx on
# 127.0.0.1:18380/18343. Everything is removed afterwards. Needs docker, node (with the api's deps), curl, jq.
#
#   bash scripts/test-monitoring-front.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
api_pid=""
P=abtest-mon
cleanup() {
  [[ -n "${api_pid}" ]] && kill "${api_pid}" 2>/dev/null || true
  docker rm -f "${P}-nginx" >/dev/null 2>&1 || true
  (cd "${tmp}" && docker compose -p "${P}" down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "${tmp}"
}
trap cleanup EXIT

# ── The compose file as shipped, moved to test ports and names ────────────────
sed -e "s/container_name: hyperprox-/container_name: ${P}-/" \
    -e 's/127\.0\.0\.1:9090/127.0.0.1:19090/g' \
    -e 's/GF_SERVER_HTTP_PORT=3003/GF_SERVER_HTTP_PORT=13003/' \
    "${here}/docker-compose.yml" > "${tmp}/docker-compose.yml"
grep -q 'web.listen-address=127.0.0.1:19090' "${tmp}/docker-compose.yml" || { echo "could not retarget Prometheus"; exit 1; }
grep -q 'GF_SERVER_HTTP_PORT=13003' "${tmp}/docker-compose.yml"          || { echo "could not retarget Grafana"; exit 1; }
mkdir -p "${tmp}/config/prometheus/rules" "${tmp}/config/prometheus/targets" "${tmp}/config/prometheus/secrets" "${tmp}/data/prometheus"
chmod 777 "${tmp}/data/prometheus"
cp -r "${here}/config/grafana" "${tmp}/config/grafana"
sed -i 's|http://127.0.0.1:9090|http://127.0.0.1:19090|' "${tmp}/config/grafana/provisioning/datasources/prometheus.yml"
grep -q 19090 "${tmp}/config/grafana/provisioning/datasources/prometheus.yml" || { echo "could not retarget the datasource"; exit 1; }
# Prometheus scrapes only itself here (the shipped config also scrapes the API on :3002, the real one).
cat > "${tmp}/config/prometheus/prometheus.yml" <<'EOF'
global: { scrape_interval: 2s }
scrape_configs:
  - job_name: prometheus
    static_configs: [{ targets: ['127.0.0.1:19090'] }]
EOF
cat > "${tmp}/.env" <<'EOF'
POSTGRES_USER=u
POSTGRES_PASSWORD=p
POSTGRES_DB=d
GRAFANA_ADMIN_PASSWORD=abtest-admin-pw
GRAFANA_SECRET_KEY=abtest-secret-key
GRAFANA_ROOT_URL=https://127.0.0.1:18343/grafana/
GRAFANA_SERVE_FROM_SUB_PATH=true
COMPOSE_PROFILES=monitoring
EOF
(cd "${tmp}" && docker compose -p "${P}" up -d --no-deps prometheus grafana >/dev/null)

# ── The real gate on an in-memory vault ───────────────────────────────────────
(cd "${here}/apps/api" && PORT=18392 exec node --import tsx test/fakes/gate-server.ts > "${tmp}/api.log" 2>&1) & api_pid=$!

# ── nginx with the shipped config, on test ports and upstreams ────────────────
cp -r "${here}/config/nginx" "${tmp}/nginx"
sed -i \
  -e 's/listen 80 default_server/listen 127.0.0.1:18380 default_server/' \
  -e 's/listen 443 ssl default_server/listen 127.0.0.1:18343 ssl default_server/' \
  -e 's/127\.0\.0\.1:3000;/127.0.0.1:18391;/' \
  -e 's/127\.0\.0\.1:3002;/127.0.0.1:18392;/' \
  -e 's/127\.0\.0\.1:3001;/127.0.0.1:18393;/' \
  -e 's/127\.0\.0\.1:3003;/127.0.0.1:13003;/' \
  "${tmp}/nginx/conf.d/hyperprox.conf"
mkdir -p "${tmp}/certs" "${tmp}/trusted"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=test \
  -keyout "${tmp}/certs/key.pem" -out "${tmp}/certs/cert.pem" >/dev/null 2>&1
docker run -d --name "${P}-nginx" --network host \
  -v "${tmp}/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" -v "${tmp}/nginx/conf.d:/etc/nginx/conf.d:ro" \
  -v "${tmp}/certs:/etc/nginx/certs:ro" -v "${tmp}/trusted:/etc/nginx/trusted-proxies:ro" nginx:alpine >/dev/null

S=https://127.0.0.1:18343
up=false
for _ in $(seq 1 180); do   # a fresh Grafana runs its database migrations first: up to a minute or two
  if curl -sf -o /dev/null http://127.0.0.1:13003/grafana/api/health && curl -sf -o /dev/null http://127.0.0.1:19090/-/ready \
     && grep -q ready "${tmp}/api.log" && curl -s -o /dev/null http://127.0.0.1:18380/nginx-health; then up=true; break; fi
  sleep 1
done
if [[ "$up" != true ]]; then
  echo "FAIL  the stack did not come up"; docker logs "${P}-grafana" 2>&1 | tail -15; tail -5 "${tmp}/api.log"; exit 1
fi

fail=0
ok()  { echo "ok    $1"; }
bad() { echo "FAIL  $1"; [[ $# -gt 1 ]] && echo "      $(head -c 400 <<<"$2")"; fail=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
J="${tmp}/jar"

# ── Bindings ──────────────────────────────────────────────────────────────────
lan="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"
listeners="$(ss -ltnH)"
check "Prometheus listens on 127.0.0.1 only"              '[[ "$listeners" == *"127.0.0.1:19090 "* && "$listeners" != *"*:19090 "* && "$listeners" != *"0.0.0.0:19090 "* && "$listeners" != *"[::]:19090 "* ]]'
check "Grafana listens on 127.0.0.1 only"                 '[[ "$listeners" == *"127.0.0.1:13003 "* && "$listeners" != *"*:13003 "* && "$listeners" != *"0.0.0.0:13003 "* && "$listeners" != *"[::]:13003 "* ]]'
check "Prometheus is not reachable on the LAN address"    '! curl -s -o /dev/null --max-time 2 "http://${lan}:19090/-/ready"'
check "Grafana is not reachable on the LAN address"       '! curl -s -o /dev/null --max-time 2 "http://${lan}:13003/grafana/api/health"'

# ── No session ────────────────────────────────────────────────────────────────
code="$(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' "${S}/grafana/api/health")"
check "no session: /grafana/ sends the browser to sign in" '[[ "$code" == "302 "*"/login?next=%2Fmonitoring" ]]' "$code"

# ── A real session ────────────────────────────────────────────────────────────
signin="$(curl -sk -c "$J" -H 'Content-Type: application/json' \
  -d '{"email":"viewer@example.com","password":"viewer master password","code":"123456"}' "${S}/api/auth/sign-in")"
check "a viewer signs in through nginx"                   '[[ "$(jq -r .ok <<<"$signin")" == true ]]' "$signin"

h="$(curl -sk -b "$J" "${S}/grafana/api/health")"
check "signed in: Grafana answers at /grafana/"           '[[ "$(jq -r .database <<<"$h" 2>/dev/null)" == ok ]]' "$h"

page="$(curl -sk -b "$J" -w '\n%{http_code}' "${S}/grafana/d/hyperprox-cluster?orgId=1&refresh=30s&kiosk&theme=dark&")"
code="${page##*$'\n'}"; html="${page%$'\n'*}"
check "the Monitoring page's embed URL renders, served from the sub-path" \
  '[[ "$code" == 200 && "$html" =~ \"appSubUrl\":\"/grafana\" ]]' "$code $(grep -o '"appSubUrl":"[^"]*"' <<<"$html" | head -1) $(grep -o '<base [^>]*>' <<<"$html" | head -1)"

dash="$(curl -sk -b "$J" "${S}/grafana/api/dashboards/uid/hyperprox-cluster")"
check "the provisioned dashboard is there for the anonymous viewer" '[[ "$(jq -r .dashboard.uid <<<"$dash" 2>/dev/null)" == hyperprox-cluster ]]' "$dash"

settings="$(curl -sk -b "$J" "${S}/grafana/api/frontend/settings")"
ds_uid="$(jq -r '.datasources | to_entries[] | select(.value.type=="prometheus") | .value.uid' <<<"$settings" 2>/dev/null | head -1)"
check "the Prometheus datasource is provisioned"          '[[ -n "$ds_uid" && "$ds_uid" != null ]]' "$(head -c 300 <<<"$settings")"

q=""; for _ in $(seq 1 30); do
  q="$(curl -sk -b "$J" -H 'Content-Type: application/json' \
    -d "{\"queries\":[{\"refId\":\"A\",\"datasource\":{\"type\":\"prometheus\",\"uid\":\"${ds_uid}\"},\"expr\":\"up{job=\\\"prometheus\\\"}\",\"instant\":true}],\"from\":\"now-5m\",\"to\":\"now\"}" \
    "${S}/grafana/api/ds/query")"
  [[ "$(jq -r '.results.A.frames | length' <<<"$q" 2>/dev/null)" -gt 0 ]] 2>/dev/null && break
  sleep 1
done
check "a dashboard query through nginx reaches Prometheus on loopback" '[[ "$(jq -r ".results.A.frames[0].data.values[1][0]" <<<"$q" 2>/dev/null)" == 1 ]]' "$q"

ws="$(curl -sk -b "$J" --http1.1 -D - -o /dev/null --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: ${S}" "${S}/grafana/api/live/ws" || true)"
check "Grafana Live: the WebSocket upgrades through nginx with a session" '[[ "$ws" == *"101 Switching Protocols"* ]]' "$ws"
ws0="$(curl -sk --http1.1 -D - -o /dev/null --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: ${S}" "${S}/grafana/api/live/ws" || true)"
check "Grafana Live: refused without a session"            '[[ "$ws0" == *" 302"* && "$ws0" != *"101 Switching"* ]]' "$ws0"

# ── Locked ────────────────────────────────────────────────────────────────────
curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:18392/api/auth/lock   # as `hyperprox lock` does
code="$(curl -sk -b "$J" -o /dev/null -w '%{http_code}' "${S}/grafana/api/health")"
check "locked: the same session is refused"                '[[ "$code" == 302 ]]' "$code"

if [[ "${fail}" -ne 0 ]]; then
  echo; echo "--- nginx"; docker logs "${P}-nginx" 2>&1 | tail -15
  echo "--- grafana"; docker logs "${P}-grafana" 2>&1 | tail -10
  echo "--- api"; tail -10 "${tmp}/api.log"
fi
exit "${fail}"
