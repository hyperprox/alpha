#!/usr/bin/env bash
# shellcheck disable=SC2034  # the variables are read inside check strings, which eval runs
# install.sh's own checks, lifted out and run against stand-ins: which containers count as not running properly
# (so a crash-looping Prometheus fails the install instead of passing it), the Prometheus retention size for the
# free disk, and the advice for keeping a container's address (it is never written inside the container).
#
#   bash scripts/test-install-checks.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }
for f in compose_rows container_problems prometheus_size lxc_static_advice; do
  eval "$(sed -n "/^${f}() {/,/^}/p" "${here}/install.sh")"
  declare -F "$f" >/dev/null || { echo "FAIL  ${f} not found in install.sh"; exit 1; }
done
warn() { echo "WARN $*"; }; info() { echo "INFO $*"; }

mkdir -p "${tmp}/bin"
cat > "${tmp}/bin/docker" <<'EOF'
#!/bin/bash
case "$1" in
  compose) tr ' ' '\n' <<< "${FAKE_SERVICES-api prometheus grafana redis old}";;
  ps) printf '%s\n' "${FAKE_PS}" | tr '|' '\n';;
esac
EOF
chmod +x "${tmp}/bin/docker"
cp() { :; }
ps_with() { FAKE_PS="$1" HYPERPROX_DIR="${tmp}" PATH="${tmp}/bin:$PATH" bash -c "$(declare -f compose_rows container_problems); container_problems"; }

out="$(ps_with 'api hyperprox-api running Up 2 minutes|prometheus hyperprox-prometheus restarting Restarting (1) 3 seconds ago|grafana hyperprox-grafana running Up 1 minute (unhealthy)|redis hyperprox-redis running Up 1 minute (healthy)|old hyperprox-old exited Exited (1) 5 minutes ago')"
check "a restarting container is a problem"     'grep -qx "hyperprox-prometheus restarting" <<< "$out"'
check "an unhealthy one too"                    'grep -qx "hyperprox-grafana unhealthy" <<< "$out"'
check "an exited one too"                       'grep -qx "hyperprox-old exited" <<< "$out"'
check "running and healthy ones are not"        '! grep -qE "hyperprox-(api|redis)" <<< "$out"'
check "all well: nothing"                       '[[ -z "$(ps_with "api hyperprox-api running Up 2 minutes (healthy)")" ]]'
check "a profile that is off: its stopped container is not counted" '[[ -z "$(FAKE_SERVICES=api ps_with "api hyperprox-api running Up 2 minutes|ollama hyperprox-ollama exited Exited (0) 1 day ago")" ]]'

check "retention: a quarter of the free disk"   '[[ "$(prometheus_size 100)" == 25 ]]'
check "  at most 40 GB"                         '[[ "$(prometheus_size 900)" == 40 ]]'
check "  at least 2 GB"                         '[[ "$(prometheus_size 3)" == 2 ]]'

mkdir -p "${tmp}/sys"
out="$(lxc_static_advice eth0 192.0.2.50/24 192.0.2.1)"
check "address advice: the exact pct set line"  'grep -q "pct set <ID> --net0 name=eth0,bridge=vmbr0,hwaddr=.*,ip=192.0.2.50/24,gw=192.0.2.1" <<< "$out"'
check "install.sh writes no /etc/network/interfaces any more" '! grep -q "> /etc/network/interfaces" "${here}/install.sh"'
exit "${fail}"
