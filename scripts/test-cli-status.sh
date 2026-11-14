#!/usr/bin/env bash
# shellcheck disable=SC2034  # the variables are read inside check strings, which eval runs
# `hyperprox status` against stand-in docker, curl and systemctl: a container stuck restarting, unhealthy, or
# restarted again and again in the last minutes is named as crash-looping (and the exit status is 1); a stopped
# one is named; all running is one line.
#
#   bash scripts/test-cli-status.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }

mkdir -p "${tmp}/bin"
cat > "${tmp}/bin/curl" <<'EOF'
#!/bin/bash
for a in "$@"; do case "$a" in */api/auth/status) echo '{"locked":false,"bootstrapped":true}'; exit 0;; esac; done; exit 0
EOF
cat > "${tmp}/bin/systemctl" <<'EOF'
#!/bin/bash
exit 0
EOF
# docker ps lists the names in $FAKE_PS; docker inspect prints "status count health startedAt" from $FAKE_<name>.
cat > "${tmp}/bin/docker" <<'EOF'
#!/bin/bash
case "$1" in
  ps) tr ' ' '\n' <<< "$FAKE_PS";;
  inspect) v="FAKE_${!#//-/_}"; echo "${!v}";;
esac
EOF
chmod +x "${tmp}/bin/"*
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; old="$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%SZ)"
st() { env PATH="${tmp}/bin:$PATH" HYPERPROX_DIR="${tmp}" "$@" bash "${here}/bin/hyperprox" status 2>&1; }

out="$(st FAKE_PS="hyperprox-api hyperprox-prometheus" FAKE_hyperprox_api="running 0 healthy ${old}" FAKE_hyperprox_prometheus="restarting 37 - ${now}")" && rc=0 || rc=$?
check "a restarting container is named as crash-looping"    '[[ "$out" == *"hyperprox-prometheus CRASH-LOOPING (restarting, restarted 37 times"* ]]'
check "  with the command that shows why"                   '[[ "$out" == *"docker logs --tail 30 hyperprox-prometheus"* ]]'
check "  and the status fails"                              '[[ "$rc" -ne 0 ]]'
out="$(st FAKE_PS="hyperprox-prometheus" FAKE_hyperprox_prometheus="running 5 - ${now}")" || true
check "running again, but restarted 5 times just now: crash-looping" '[[ "$out" == *"CRASH-LOOPING"* ]]'
out="$(st FAKE_PS="hyperprox-prometheus" FAKE_hyperprox_prometheus="running 5 - ${old}")" || true
check "restarts long ago, up for hours: fine"               '[[ "$out" == *"containers: all 1 running"* ]]'
out="$(st FAKE_PS="hyperprox-grafana" FAKE_hyperprox_grafana="running 0 unhealthy ${old}")" || true
check "an unhealthy container is named"                     '[[ "$out" == *"hyperprox-grafana CRASH-LOOPING"* ]]'
out="$(st FAKE_PS="hyperprox-redis" FAKE_hyperprox_redis="exited 0 - ${old}")" || true
check "a stopped container is named"                        '[[ "$out" == *"hyperprox-redis EXITED"* ]]'
exit "${fail}"
