#!/usr/bin/env bash
# bin/hyperprox-config is what install.sh and deploy.sh run to bring an install's own configuration up to
# date. These run it against throwaway install directories and check what it leaves behind, and that a
# second run changes nothing. Then they check that install.sh and deploy.sh call it where it has to run,
# and that docker-compose.yml binds Prometheus and Grafana to loopback and has no npm service.
#
#   bash scripts/test-install-config.sh        (as root, for the chown checks; needs docker for the last part)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cfg="${here}/bin/hyperprox-config"
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
fail=0
ok()   { echo "ok    $1"; }
bad()  { echo "FAIL  $1${2:+ ($2)}"; fail=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "$2"; fi; }   # check <name> <bash condition>

mkinstall() {  # mkinstall <.env contents> -> prints the new install dir
  local d; d="$(mktemp -d "${tmp}/install.XXXX")"
  mkdir -p "${d}/config/prometheus/secrets" "${d}/apps/frontend"
  printf '%s\n' "$1" > "${d}/.env"; chmod 644 "${d}/.env"
  echo "$d"
}
run() { HYPERPROX_DIR="$1" bash "$cfg" 2>&1; }
envval() { grep -m1 "^$2=" "$1/.env" | cut -d= -f2-; }
digest() { find "$1" -type f -print0 | sort -z | xargs -0 sha256sum; find "$1" -printf '%p %m %U\n' | sort; }

# ── METRICS_TOKEN ─────────────────────────────────────────────────────────────
d="$(mkinstall 'HOST_IP=192.0.2.10
COMPOSE_PROFILES=monitoring')"
out="$(run "$d")"
tok="$(envval "$d" METRICS_TOKEN)"
check "a missing METRICS_TOKEN is generated into .env"            '[[ "$tok" =~ ^[0-9a-f]{64}$ ]]'
check "Prometheus gets the same token in secrets/metrics_token"   '[[ "$(cat "$d/config/prometheus/secrets/metrics_token")" == "$tok" ]]'
check "metrics_token is mode 0600"                                '[[ "$(stat -c %a "$d/config/prometheus/secrets/metrics_token")" == 600 ]]'
check "metrics_token is owned by the Prometheus user (65534)"     '[[ "$(stat -c %u "$d/config/prometheus/secrets/metrics_token")" == 65534 ]]'
check ".env is left mode 0600"                                    '[[ "$(stat -c %a "$d/.env")" == 600 ]]'
check "the generation is logged, the token is not"                '[[ "$out" == *"METRICS_TOKEN: generated"* && "$out" != *"$tok"* ]]'

before="$(digest "$d")"
out2="$(run "$d")"
check "a second run changes nothing (no rotation)"                '[[ "$(digest "$d")" == "$before" ]]'
check "a second run prints nothing"                               '[[ -z "$out2" ]]'

d="$(mkinstall 'METRICS_TOKEN=keep-this-one')"
run "$d" >/dev/null
check "an existing METRICS_TOKEN is kept"                          '[[ "$(envval "$d" METRICS_TOKEN)" == keep-this-one ]]'
check "and written for Prometheus"                                 '[[ "$(cat "$d/config/prometheus/secrets/metrics_token")" == keep-this-one ]]'

d="$(mkinstall 'NODE_ENV=production')"
printf 'from-the-old-readme\n' > "$d/config/prometheus/secrets/metrics_token"
out="$(run "$d")"
check "a token only Prometheus has is adopted into .env, not replaced" '[[ "$(envval "$d" METRICS_TOKEN)" == from-the-old-readme ]]'
check "and its file is left holding the same token"                    '[[ "$(cat "$d/config/prometheus/secrets/metrics_token")" == from-the-old-readme ]]'

d="$(mkinstall 'METRICS_TOKEN=the-api-uses-this')"
printf 'stale' > "$d/config/prometheus/secrets/metrics_token"
out="$(run "$d")"
check "a secret file that disagrees with .env is rewritten from .env" '[[ "$(cat "$d/config/prometheus/secrets/metrics_token")" == the-api-uses-this ]]'
check "and that is logged"                                             '[[ "$out" == *"rewritten to match"* ]]'

d="$(mkinstall 'METRICS_TOKEN=')"
run "$d" >/dev/null
check "an empty METRICS_TOKEN= line is filled in place, not duplicated" '[[ "$(grep -c "^METRICS_TOKEN=" "$d/.env")" == 1 && -n "$(envval "$d" METRICS_TOKEN)" ]]'

# ── pve-exporter config ───────────────────────────────────────────────────────
d="$(mkinstall 'METRICS_TOKEN=x')"
run "$d" >/dev/null
f="$d/config/pve-exporter/pve.yml"
check "pve.yml is created when missing"                            '[[ -f "$f" ]] && grep -q "token_value" "$f"'
check "pve.yml is mode 0600"                                       '[[ "$(stat -c %a "$f")" == 600 ]]'
check "pve.yml is owned by the exporter user (101)"                '[[ "$(stat -c %u "$f")" == 101 ]]'

d="$(mkinstall 'METRICS_TOKEN=x')"
mkdir -p "$d/config/pve-exporter/pve.yml"
out="$(run "$d")"
check "a pve.yml directory (Docker artefact) is replaced by the file" '[[ -f "$d/config/pve-exporter/pve.yml" && "$out" == *"removed a directory"* ]]'

d="$(mkinstall 'METRICS_TOKEN=x')"
mkdir -p "$d/config/pve-exporter"
printf 'default:\n  user: someone@pve\n  token_name: mine\n  token_value: "s3cret"\n' > "$d/config/pve-exporter/pve.yml"
chmod 644 "$d/config/pve-exporter/pve.yml"
run "$d" >/dev/null
check "an existing pve.yml keeps its token"                         'grep -q "s3cret" "$d/config/pve-exporter/pve.yml"'
check "and is tightened to 0600"                                    '[[ "$(stat -c %a "$d/config/pve-exporter/pve.yml")" == 600 ]]'

# ── npm profile ───────────────────────────────────────────────────────────────
for case in 'monitoring,npm|monitoring' 'npm,monitoring|monitoring' 'npm|' 'monitoring, npm ,ai|monitoring,ai' '"monitoring,npm"|monitoring'; do
  in="${case%%|*}"; want="${case#*|}"
  d="$(mkinstall "METRICS_TOKEN=x
COMPOSE_PROFILES=${in}")"
  out="$(run "$d")"
  check "COMPOSE_PROFILES=${in} becomes '${want}', with a log line" '[[ "$(envval "$d" COMPOSE_PROFILES)" == "$want" && "$out" == *"dropped '"'"'npm'"'"'"* ]]'
done
for in in 'monitoring' 'monitoring,ai' '' 'npmx'; do
  d="$(mkinstall "METRICS_TOKEN=x
COMPOSE_PROFILES=${in}")"
  out="$(run "$d")"
  check "COMPOSE_PROFILES=${in:-(empty)} is left alone"  '[[ "$(envval "$d" COMPOSE_PROFILES)" == "$in" && "$out" != *npm* ]]'
done
d="$(mkinstall 'METRICS_TOKEN=x')"
run "$d" >/dev/null
check "no COMPOSE_PROFILES line stays no line"            '! grep -q "^COMPOSE_PROFILES=" "$d/.env"'

# ── Grafana behind nginx ──────────────────────────────────────────────────────
d="$(mkinstall 'METRICS_TOKEN=x
HOST_IP=192.0.2.10
NEXT_PUBLIC_GRAFANA_URL=http://192.0.2.10:3003')"
printf 'NEXT_PUBLIC_API_URL=https://192.0.2.10/api\nNEXT_PUBLIC_GRAFANA_URL=http://192.0.2.10:3003\n' > "$d/apps/frontend/.env.production"
out="$(run "$d")"
check "an embed from :3003 moves to /grafana"              '[[ "$(envval "$d" NEXT_PUBLIC_GRAFANA_URL)" == /grafana ]]'
check "the frontend build copy moves with it"              'grep -qx "NEXT_PUBLIC_GRAFANA_URL=/grafana" "$d/apps/frontend/.env.production" && grep -q "^NEXT_PUBLIC_API_URL=" "$d/apps/frontend/.env.production"'
check "Grafana is told to serve from the sub-path"         '[[ "$(envval "$d" GRAFANA_SERVE_FROM_SUB_PATH)" == true ]]'
check "GRAFANA_ROOT_URL is derived from HOST_IP"           '[[ "$(envval "$d" GRAFANA_ROOT_URL)" == https://192.0.2.10/grafana/ ]]'
before="$(digest "$d")"
check "and a second run changes nothing"                   '[[ -z "$(run "$d")" && "$(digest "$d")" == "$before" ]]'

d="$(mkinstall 'METRICS_TOKEN=x
HYPERPROX_PUBLIC_URL=https://hyperprox.example.com/
NEXT_PUBLIC_GRAFANA_URL=http://192.0.2.10:3003/')"
run "$d" >/dev/null
check "GRAFANA_ROOT_URL prefers HYPERPROX_PUBLIC_URL"      '[[ "$(envval "$d" GRAFANA_ROOT_URL)" == https://hyperprox.example.com/grafana/ ]]'

d="$(mkinstall 'METRICS_TOKEN=x
NEXT_PUBLIC_GRAFANA_URL=/grafana
GRAFANA_ROOT_URL=https://192.0.2.10/grafana/
GRAFANA_SERVE_FROM_SUB_PATH=true')"
before="$(grep GRAFANA "$d/.env")"
out="$(run "$d")"
check "a fresh install's Grafana settings are left as they are" '[[ "$out" != *GRAFANA* && "$(grep GRAFANA "$d/.env")" == "$before" ]]'

d="$(mkinstall 'METRICS_TOKEN=x
NEXT_PUBLIC_GRAFANA_URL=https://grafana.example.com')"
run "$d" >/dev/null
check "a Grafana of your own elsewhere is not touched"     '[[ "$(envval "$d" NEXT_PUBLIC_GRAFANA_URL)" == https://grafana.example.com ]] && ! grep -q "^GRAFANA_ROOT_URL=" "$d/.env"'

# ── Where install.sh and deploy.sh run it ─────────────────────────────────────
line() { grep -n -m1 -E "$2" "$1" | cut -d: -f1; }
dc="$(line "${here}/deploy.sh" 'bin/hyperprox-config')"
check "deploy.sh runs bin/hyperprox-config"                '[[ -n "$dc" ]]'
check "  before it builds the frontend (NEXT_PUBLIC_* is baked in)" '[[ "$dc" -lt "$(line "${here}/deploy.sh" "next build")" ]]'
check "  before it restarts the API (which reads METRICS_TOKEN)"    '[[ "$dc" -lt "$(line "${here}/deploy.sh" "systemctl restart hyperprox-api")" ]]'
check "deploy.sh restarts the API exactly as before, once"  '[[ "$(grep -c "systemctl restart hyperprox-api" "${here}/deploy.sh")" == 1 ]]'
check "deploy.sh recreates Prometheus and Grafana onto their new bindings" 'grep -qE "docker compose up -d --no-deps prometheus grafana" "${here}/deploy.sh"'
ic="$(grep -n 'apply_install_config$' "${here}/install.sh" | tail -1 | cut -d: -f1)"
check "install.sh runs it (main calls apply_install_config)" '[[ -n "$ic" ]] && grep -q "bin/hyperprox-config" "${here}/install.sh"'
check "  before it builds"                                 '[[ "$ic" -lt "$(grep -n "^  build_app$" "${here}/install.sh" | cut -d: -f1)" ]]'
check "install.sh no longer maps INSTALL_NPM to a profile" '! grep -q "INSTALL_NPM=true" "${here}/install.sh"'

# ── docker-compose.yml ────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  cp "${here}/docker-compose.yml" "${tmp}/docker-compose.yml"
  printf 'POSTGRES_USER=u\nPOSTGRES_PASSWORD=p\nPOSTGRES_DB=d\nGRAFANA_ADMIN_PASSWORD=x\nGRAFANA_SECRET_KEY=y\nCOMPOSE_PROFILES=monitoring\n' > "${tmp}/.env"
  json="$(cd "${tmp}" && docker compose --profile monitoring --profile ai config --format json 2>/dev/null)"
  check "compose: Prometheus listens on 127.0.0.1:9090 only" 'jq -e ".services.prometheus.command | index(\"--web.listen-address=127.0.0.1:9090\")" <<<"$json" >/dev/null'
  check "compose: Prometheus's healthcheck uses 127.0.0.1"   'jq -e ".services.prometheus.healthcheck.test | join(\" \") | test(\"127.0.0.1:9090\")" <<<"$json" >/dev/null'
  check "compose: Grafana on the host network, bound to 127.0.0.1:3003" \
    'jq -e ".services.grafana.network_mode == \"host\" and .services.grafana.environment.GF_SERVER_HTTP_ADDR == \"127.0.0.1\" and .services.grafana.environment.GF_SERVER_HTTP_PORT == \"3003\"" <<<"$json" >/dev/null'
  check "compose: Grafana publishes no ports"               'jq -e ".services.grafana.ports == null" <<<"$json" >/dev/null'
  check "compose: no Nginx Proxy Manager service"           'jq -e "[.services[] | .image] | map(test(\"nginx-proxy-manager\")) | any | not" <<<"$json" >/dev/null'
  check "compose: no service publishes on a non-loopback address" \
    'jq -e "[.services[] | (.ports // [])[] | .host_ip] | all(. == \"127.0.0.1\")" <<<"$json" >/dev/null'
  check "Grafana's datasource is Prometheus on 127.0.0.1:9090" 'grep -q "url: http://127.0.0.1:9090" "${here}/config/grafana/provisioning/datasources/prometheus.yml"'
  check "Prometheus scrapes itself on 127.0.0.1 (localhost can be ::1)" '! grep -q "localhost:9090" "${here}/config/prometheus/prometheus.yml"'
else
  echo "skip  docker-compose.yml checks (no docker compose)"
fi

exit "${fail}"
