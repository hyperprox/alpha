#!/usr/bin/env bash
# Exercises config/nginx as shipped: http->https redirect, the X-Forwarded-Proto exemption, TLS, every
# route reaching the right upstream, and the WebSocket upgrade the terminal and live updates need.
#
# Runs a throwaway nginx (container abtest-setup-nginx) with the repo's config, changed in one way only:
# it listens on 127.0.0.1:18280/18243 and its upstreams are labelled stub servers on 127.0.0.1:18291-18295,
# so it can run beside a real install without touching it. Needs docker, node, curl, openssl.
#
#   bash scripts/test-nginx-front.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name=abtest-setup-nginx
tmp="$(mktemp -d)"
stub_pid=""
cleanup() {
  docker rm -f "${name}" >/dev/null 2>&1 || true
  [[ -n "${stub_pid}" ]] && kill "${stub_pid}" 2>/dev/null || true
  rm -rf "${tmp}"
}
trap cleanup EXIT

# ── The config under test, on test ports ──────────────────────────────────────
cp -r "${here}/config/nginx" "${tmp}/nginx"
sed -i \
  -e 's/listen 80 default_server/listen 127.0.0.1:18280 default_server/' \
  -e 's/listen 443 ssl default_server/listen 127.0.0.1:18243 ssl default_server/' \
  -e 's/127\.0\.0\.1:3000;/127.0.0.1:18291;/' \
  -e 's/127\.0\.0\.1:3002;/127.0.0.1:18292;/' \
  -e 's/127\.0\.0\.1:3001;/127.0.0.1:18293;/' \
  -e 's/127\.0\.0\.1:3003;/127.0.0.1:18294;/' \
  -e 's/127\.0\.0\.1:9090;/127.0.0.1:18295;/' \
  "${tmp}/nginx/conf.d/hyperprox.conf"
grep -q 18243 "${tmp}/nginx/conf.d/hyperprox.conf" || { echo "could not retarget the config"; exit 1; }

mkdir -p "${tmp}/certs"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=test \
  -keyout "${tmp}/certs/key.pem" -out "${tmp}/certs/cert.pem" >/dev/null 2>&1

# ── Stub upstreams: answer "<label> <path> proto=<X-Forwarded-Proto>", and accept WebSocket upgrades ──
cat > "${tmp}/stub.js" <<'EOF'
const http = require('http'), crypto = require('crypto')
const labels = { 18291: 'frontend', 18292: 'api', 18293: 'setup', 18294: 'grafana', 18295: 'prometheus' }
for (const [port, label] of Object.entries(labels)) {
  const s = http.createServer((req, res) => res.end(`${label} ${req.url} proto=${req.headers['x-forwarded-proto'] || '-'}\n`))
  s.on('upgrade', (req, sock) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Stub: ${label}\r\n\r\n`)
  })
  s.listen(Number(port), '127.0.0.1')
}
EOF
node "${tmp}/stub.js" & stub_pid=$!

docker rm -f "${name}" >/dev/null 2>&1 || true
docker run -d --name "${name}" --network host \
  -v "${tmp}/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "${tmp}/nginx/conf.d:/etc/nginx/conf.d:ro" \
  -v "${tmp}/certs:/etc/nginx/certs:ro" \
  nginx:alpine >/dev/null
for _ in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:18280/nginx-health && break; sleep 0.2; done

fail=0
expect() {  # expect <name> <expected substring> <curl args...>
  local what="$1" want="$2"; shift 2
  local got; got="$(curl -sk --max-time 5 "$@" 2>&1 || true)"
  if [[ "${got}" == *"${want}"* ]]; then echo "ok    ${what}"
  else echo "FAIL  ${what}"; echo "      wanted: ${want}"; echo "      got:    $(head -c 300 <<<"${got}")"; fail=1; fi
}

H=http://127.0.0.1:18280
S=https://127.0.0.1:18243
expect "http redirects to https, keeping path and query"  "Location: https://127.0.0.1/login?next=%2F" -D - -o /dev/null "${H}/login?next=%2F"
expect "the redirect is a 301"                             "HTTP/1.1 301"                            -D - -o /dev/null "${H}/"
expect "http health check is not redirected"               "ok"                                      "${H}/nginx-health"
expect "behind a TLS proxy (X-Forwarded-Proto: https): served on :80, no loop" "frontend / proto=https" -H 'X-Forwarded-Proto: https' "${H}/"
expect "https: the frontend, told the scheme"              "frontend /dashboard proto=https"         "${S}/dashboard"
expect "https: the TLS handshake completes"                             "SSL connection using TLSv1."             -v -o /dev/null "${S}/nginx-health"
expect "https: /api goes to the API"                       "api /api/health proto=https"             "${S}/api/health"
expect "https: the wizard page goes to the setup server"   "setup /setup?k=abc proto=https"          "${S}/setup?k=abc"
expect "https: the wizard API goes to the setup server, not the API" "setup /api/setup/state"        "${S}/api/setup/state"
expect "https: grafana, prefix stripped"                   "grafana /d/x"                            "${S}/grafana/d/x"
expect "https: prometheus from loopback is allowed"        "prometheus /-/healthy"                   "${S}/prometheus/-/healthy"
expect "wss: live updates upgrade on /ws"                  "X-Stub: api"                             --http1.1 -D - -o /dev/null \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${S}/ws"
expect "wss: the terminal upgrades on /ws/terminal/term"   "101 Switching Protocols"                 --http1.1 -D - -o /dev/null \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${S}/ws/terminal/term?x=1"

if [[ "${fail}" -ne 0 ]]; then echo; docker logs "${name}" 2>&1 | tail -20; fi
exit "${fail}"
