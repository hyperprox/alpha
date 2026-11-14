#!/usr/bin/env bash
# Exercises config/nginx as shipped: http->https redirect, the X-Forwarded-Proto exemption, TLS, every
# route reaching the right upstream, the WebSocket upgrade the terminal and live updates need, and the
# session check in front of /grafana/ (the stub API's /api/auth/check stands in for the real one, which
# apps/api/test/auth-check.test.ts covers; scripts/test-monitoring-front.sh runs the real one end to end).
#
# Runs a throwaway nginx (container abtest-setup-nginx) with the repo's config, changed in one way only:
# it listens on 127.0.0.1:18280/18243 and its upstreams are labelled stub servers on 127.0.0.1:18291-18294,
# so it can run beside a real install without touching it. Needs docker, node, curl, openssl.
#
#   bash scripts/test-nginx-front.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name=abtest-setup-nginx
tmp="$(mktemp -d)"
stub_pid=""
cleanup() {
  docker rm -f "${name}" abtest-gate-grafana >/dev/null 2>&1 || true
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
  "${tmp}/nginx/conf.d/hyperprox.conf"
grep -q 18243 "${tmp}/nginx/conf.d/hyperprox.conf" || { echo "could not retarget the config"; exit 1; }

# A trusted proxy for the test: 127.0.0.3. Requests sent from 127.0.0.2 stand in for any other client.
mkdir -p "${tmp}/trusted"
echo '127.0.0.3 1;' > "${tmp}/trusted/proxies.conf"

mkdir -p "${tmp}/certs"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=test \
  -keyout "${tmp}/certs/key.pem" -out "${tmp}/certs/cert.pem" >/dev/null 2>&1

# ── Stub upstreams: answer "<label> <path> proto=<X-Forwarded-Proto>", and accept WebSocket upgrades ──
cat > "${tmp}/stub.js" <<'EOF'
const http = require('http'), crypto = require('crypto')
const labels = { 18291: 'frontend', 18292: 'api', 18293: 'setup', 18294: 'grafana' }
// The stub API's session check, accepting what the real one accepts (lib/auth.ts extractToken): the
// hyperprox_token cookie (name trimmed, first one wins) or a Bearer session JWT ("good" here). 204 for
// "good", 403 for an API token (Bearer hpx_...), 503 for "down" (the API failing), no answer at all for
// "hang", 401 otherwise. It refuses anything but a bodiless GET with no Upgrade header, so a check that
// leaked the browser's method, body or upgrade would show up as a failure.
function sessionCheck(req, res) {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.method !== 'GET' || body || req.headers['content-length'] || req.headers.upgrade) { res.statusCode = 400; return res.end() }
    const auth = req.headers.authorization || ''
    if (/^Bearer hpx_/.test(auth)) { res.statusCode = 403; return res.end() }
    let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
    if (token === null) for (const part of (req.headers.cookie || '').split(';')) {
      const eq = part.indexOf('=')
      if (eq !== -1 && part.slice(0, eq).trim() === 'hyperprox_token') { token = part.slice(eq + 1).trim(); break }
    }
    if (token === 'hang') return
    if (token === 'down') { res.statusCode = 503; return res.end() }
    res.statusCode = token === 'good' ? 204 : 401
    res.end()
  })
}
for (const [port, label] of Object.entries(labels)) {
  const s = http.createServer((req, res) => {
    if (label === 'api' && req.url === '/api/auth/check') return sessionCheck(req, res)
    // The wizard after setup is gone: the connection drops, as with nothing listening on its port.
    if (label === 'setup' && req.url.startsWith('/setup-gone')) return req.socket.destroy()
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => res.end(`${label} ${req.method} ${req.url} proto=${req.headers['x-forwarded-proto'] || '-'}` +
      (label === 'grafana' ? ` cookie=[${req.headers.cookie || ''}] auth=[${req.headers.authorization || ''}] body=[${body}]` : '') + '\n'))
  })
  s.on('upgrade', (req, sock) => {
    if (label === 'api' && req.url === '/api/auth/check') { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
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
  -v "${tmp}/trusted:/etc/nginx/trusted-proxies:ro" \
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
expect "behind a TLS proxy on loopback (X-Forwarded-Proto: https): served on :80, no loop" "frontend GET / proto=https" -H 'X-Forwarded-Proto: https' "${H}/"
expect "behind a listed trusted proxy: served on :80, no loop" "frontend GET / proto=https" --interface 127.0.0.3 -H 'X-Forwarded-Proto: https' "${H}/"
expect "any other client claiming X-Forwarded-Proto: https is still redirected" "HTTP/1.1 301" --interface 127.0.0.2 -H 'X-Forwarded-Proto: https' -D - -o /dev/null "${H}/"
expect "a client's own X-Forwarded-Proto is replaced on the way to the app" "frontend GET / proto=https" --interface 127.0.0.2 -H 'X-Forwarded-Proto: http' "${S}/"
expect "https: the frontend, told the scheme"              "frontend GET /dashboard proto=https"         "${S}/dashboard"
expect "https: the TLS handshake completes"                             "SSL connection using TLSv1."             -v -o /dev/null "${S}/nginx-health"
expect "https: /api goes to the API"                       "api GET /api/health proto=https"             "${S}/api/health"
expect "https: the wizard page goes to the setup server"   "setup GET /setup?k=abc proto=https"          "${S}/setup?k=abc"
expect "https: the wizard API goes to the setup server, not the API" "setup GET /api/setup/state"        "${S}/api/setup/state"
expect "after setup, an old setup link is a redirect, not a 502" "302" -o /dev/null -w '%{http_code}' "${S}/setup-gone"
expect "  to the sign-in page with a note"                        "/login?from=setup" -o /dev/null -w '%{redirect_url}' "${S}/setup-gone"
G='hyperprox_token=good'
WS=(--http1.1 -D - -o /dev/null -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
expect "grafana: no session is sent to sign in"            "/login?next=%2Fmonitoring"              --http1.1 -D - -o /dev/null "${S}/grafana/d/x"
expect "grafana: a bad session is sent to sign in"         "HTTP/1.1 302"                            --http1.1 -D - -o /dev/null -b 'hyperprox_token=nope' "${S}/grafana/d/x"
expect "grafana: a session, sub-path passed through whole" "grafana GET /grafana/d/x?orgId=1&kiosk" -b "${G}" "${S}/grafana/d/x?orgId=1&kiosk"
expect "grafana: a query POST reaches Grafana with its body (the check itself is a bodiless GET)" \
  'grafana POST /grafana/api/ds/query proto=https cookie=[] auth=[] body=[{"queries":[]}]' -b "${G}" -H 'Content-Type: application/json' -d '{"queries":[]}' "${S}/grafana/api/ds/query"
expect "grafana: no cookie at all reaches Grafana, the session's or any other" \
  "cookie=[] auth=[]"                                      -H "Cookie: grafana_session=g1; ${G}; theme=dark" "${S}/grafana/api/user"
expect "grafana: a duplicated session cookie is not passed on" "cookie=[] auth=[]"                -H "Cookie: ${G}; ${G}" "${S}/grafana/x"
expect "grafana: a session cookie with a space before = is not passed on" "cookie=[] auth=[]"     -H "Cookie: hyperprox_token =good" "${S}/grafana/x"
expect "grafana: a Bearer session passes the check but its header is not passed on" "cookie=[] auth=[]" -H "Authorization: Bearer good" "${S}/grafana/x"
start=$(date +%s)
expect "grafana: an API that never answers is a 500 within seconds" "HTTP/1.1 500"               --http1.1 --max-time 20 -D - -o /dev/null -b 'hyperprox_token=hang' "${S}/grafana/d/x"
took=$(( $(date +%s) - start ))
if [[ "$took" -le 8 ]]; then echo "ok    grafana: ...in ${took}s (check timeout 2s connect, 5s read)"; else echo "FAIL  grafana: the hanging check took ${took}s"; fail=1; fi
expect "grafana: the datasource proxy is refused even with a session" "HTTP/1.1 403"             --http1.1 -D - -o /dev/null -b "${G}" "${S}/grafana/api/datasources/proxy/uid/x/api/v1/status/config"
expect "grafana: ...also spelled with an encoded letter"   "HTTP/1.1 403"                            --http1.1 -D - -o /dev/null -b "${G}" "${S}/grafana/api/datasources/%70roxy/1/api/v1/targets"
expect "grafana: the datasource list is refused even with a session" "HTTP/1.1 403"             --http1.1 -D - -o /dev/null -b "${G}" "${S}/grafana/api/datasources"
expect "grafana: other datasource routes still reach Grafana" "grafana GET /grafana/api/datasources/uid/x/resources/api/v1/labels" -b "${G}" "${S}/grafana/api/datasources/uid/x/resources/api/v1/labels"
expect "grafana: an API token gets 403"                    "HTTP/1.1 403"                            --http1.1 -D - -o /dev/null -H 'Authorization: Bearer hpx_x' "${S}/grafana/d/x"
expect "grafana: the API failing is a 500, never a pass"   "HTTP/1.1 500"                            --http1.1 -D - -o /dev/null -b 'hyperprox_token=down' "${S}/grafana/d/x"
expect "grafana: the check location is not reachable from outside" "HTTP/1.1 404"                    --http1.1 -D - -o /dev/null -b "${G}" "${S}/_hpx/session"
expect "grafana: live WebSocket upgrades with a session"   "X-Stub: grafana"                         "${WS[@]}" -b "${G}" "${S}/grafana/api/live/ws"
expect "grafana: live WebSocket without a session is refused" "HTTP/1.1 302"                         "${WS[@]}" "${S}/grafana/api/live/ws"
expect "grafana: on :80 behind a trusted TLS proxy, still gated" "HTTP/1.1 302"                     -D - -o /dev/null -H 'X-Forwarded-Proto: https' "${H}/grafana/d/x"
expect "https: /prometheus/ is not proxied (no upstream, falls to the app)" "frontend GET /prometheus/-/quit" "${S}/prometheus/-/quit"
expect "wss: live updates upgrade on /ws"                  "X-Stub: api"                             --http1.1 -D - -o /dev/null \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${S}/ws"
expect "wss: the terminal upgrades on /ws/terminal/term"   "101 Switching Protocols"                 --http1.1 -D - -o /dev/null \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${S}/ws/terminal/term?x=1"

# ── bin/hyperprox-gate-check, which deploy.sh runs after reloading nginx ─────────
docker run -d --name abtest-gate-grafana --network none nginx:alpine >/dev/null
if out="$(HPX_GATE_URL="${S}/grafana/api/health" GRAFANA_CONTAINER=abtest-gate-grafana bash "${here}/bin/hyperprox-gate-check" 2>&1)"; then
  echo "ok    gate-check: passes against the gated config"
else echo "FAIL  gate-check: refused the gated config: ${out}"; fail=1; fi
# The previous (ungated) /grafana/ answers like Grafana itself: here, the stub Grafana straight.
if out="$(HPX_GATE_URL="http://127.0.0.1:18294/grafana/api/health" GRAFANA_CONTAINER=abtest-gate-grafana bash "${here}/bin/hyperprox-gate-check" 2>&1)"; then
  echo "FAIL  gate-check: passed an ungated /grafana/"; fail=1
else
  if [[ "$(docker inspect -f '{{.State.Running}}' abtest-gate-grafana)" == false && "$out" == *"is not gated"* && "$out" == *"Stopped abtest-gate-grafana"* ]]; then
    echo "ok    gate-check: an ungated /grafana/ fails it, says why, and stops Grafana"
  else echo "FAIL  gate-check: ungated, but Grafana was not stopped or the reason not given: ${out}"; fail=1; fi
fi

if [[ "${fail}" -ne 0 ]]; then echo; docker logs "${name}" 2>&1 | tail -20; fi
exit "${fail}"
