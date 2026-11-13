#!/usr/bin/env bash
# HyperProx diagnostics: collects what is needed to work out why an install is not (fully) working.
# Read-only: it changes nothing. Passwords, tokens, keys and secrets are blanked before anything is written.
#
#   curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/scripts/diagnose.sh | sudo bash
#   (or, from an install: sudo bash /opt/hyperprox/scripts/diagnose.sh)
#
# The report is saved to /tmp/hyperprox-diagnose-<time>.txt. Read it before sharing it.
set -u
DIR=${HYPERPROX_DIR:-/opt/hyperprox}
OUT=/tmp/hyperprox-diagnose-$(date -u +%Y%m%dT%H%M%SZ).txt

# On a Proxmox host with no install here: find the container(s) HyperProx was installed into and run inside them.
if [ ! -d "$DIR" ] && command -v pct >/dev/null 2>&1 && [ -z "${HPX_DIAG_INNER:-}" ]; then
  self=$(readlink -f "$0" 2>/dev/null); found=0
  for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    st=$(pct status "$id" 2>/dev/null | awk '{print $2}')
    if [ "$st" = running ] && pct exec "$id" -- test -d "$DIR" 2>/dev/null; then
      found=1; echo "HyperProx found in container $id: running the diagnostics inside it..."
      if [ -f "$self" ]; then pct push "$id" "$self" /tmp/hyperprox-diagnose.sh >/dev/null
      else curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/scripts/diagnose.sh -o /tmp/hpx-diag.sh && pct push "$id" /tmp/hpx-diag.sh /tmp/hyperprox-diagnose.sh && rm -f /tmp/hpx-diag.sh; fi
      pct exec "$id" -- env HPX_DIAG_INNER=1 bash /tmp/hyperprox-diagnose.sh | tail -3
      f=$(pct exec "$id" -- sh -c 'ls -t /tmp/hyperprox-diagnose-*.txt 2>/dev/null | head -1')
      [ -n "$f" ] && pct pull "$id" "$f" "/tmp/ct$id-$(basename "$f")" && chmod 600 "/tmp/ct$id-$(basename "$f")" && echo "Copied to this host: /tmp/ct$id-$(basename "$f")"
    elif [ "$st" != running ]; then
      echo "container $id is $st (not checked)"
    fi
  done
  [ "$found" = 1 ] && exit 0
  echo "No running container on this host has $DIR. Continuing with host checks only."
fi
T=6   # seconds per network probe

redact() {
  sed -E \
    -e 's/((PASSWORD|PASSWD|SECRET|TOKEN|KEY|PASS|AUTH|CREDENTIAL|SALT|HASH)[A-Z_]*[=:][[:space:]]*)[^[:space:]"'"'"']+/\1<redacted>/Ig' \
    -e 's#(Bearer|Basic)[[:space:]]+[A-Za-z0-9._~+/=-]+#\1 <redacted>#Ig' \
    -e 's#(://[^/:@[:space:]]+:)[^@/[:space:]]+@#\1<redacted>@#g' \
    -e 's#(postgres(ql)?://[^:]+:)[^@]+@#\1<redacted>@#g' \
    -e 's#(PVEAPIToken=[^=]+=)[A-Za-z0-9-]+#\1<redacted>#g' \
    -e 's#-----BEGIN [A-Z ]*PRIVATE KEY-----.*#<private key redacted>#g'
}
sec() { printf '\n===== %s =====\n' "$*"; }
run() { printf '$ %s\n' "$*"; timeout 30 bash -c "$*" 2>&1 | head -n "${LINES_MAX:-80}"; }
have() { command -v "$1" >/dev/null 2>&1; }

{
sec "Summary"
echo "time (UTC): $(date -u -Is)"
echo "running as: $(id -un) (uid $(id -u))"
[ "$(id -u)" -ne 0 ] && echo "NOTE: not root - some checks below will be incomplete. Re-run with sudo."
echo "install dir: $DIR $( [ -d "$DIR" ] && echo present || echo MISSING )"

sec "System"
run 'cat /etc/os-release | grep -E "^(PRETTY_NAME|VERSION_ID)="'
run 'uname -r; (systemd-detect-virt 2>/dev/null || echo virt: unknown)'
run 'nproc; free -h | head -2; df -h / /var /opt 2>/dev/null | sort -u'
run 'timedatectl 2>/dev/null | grep -E "synchronized|NTP|Time zone" || date'
run 'cat /proc/1/environ 2>/dev/null | tr "\0" "\n" | grep -E "^container=" || echo "not an LXC container (or no access)"'
run 'grep -E "^(lxc|features)" /proc/self/mountinfo >/dev/null 2>&1; [ -e /dev/fuse ] && echo /dev/fuse present; [ -e /dev/net/tun ] && echo /dev/net/tun present; aa-status --enabled 2>/dev/null && echo apparmor: enabled || echo apparmor: off/unknown; (getenforce 2>/dev/null || true)'

sec "HyperProx code"
if [ -d "$DIR/.git" ]; then
  run "git -C '$DIR' log --oneline -3; git -C '$DIR' branch --show-current; git -C '$DIR' remote -v | head -2"
  run "git -C '$DIR' status --short | head -20"
else echo "no git checkout at $DIR"; fi
if [ -f "$DIR/.env" ]; then
  echo "--- .env (names; values hidden except a few safe ones)"
  grep -E '^[A-Z_]+=' "$DIR/.env" | while IFS='=' read -r k v; do
    case "$k" in
      NODE_ENV|PROXMOX_PORT|*_PORT|NEXT_PUBLIC_API_URL|NEXT_PUBLIC_WS_URL|HYPERPROX_PUBLIC_URL|NEXT_PUBLIC_GRAFANA_URL|GRAFANA_ROOT_URL|VAULT_PUBLIC_URL|PROXMOX_HOST|PROXMOX_USER|NPM_URL)
        echo "$k=$v" ;;
      *) [ -n "$v" ] && echo "$k=<set>" || echo "$k=<EMPTY>" ;;
    esac
  done
else echo "no .env at $DIR/.env"; fi

sec "Services"
for u in hyperprox-api hyperprox-frontend hyperprox-setup hyperprox-keyholder docker nginx; do
  a=$(systemctl is-active "$u" 2>/dev/null); e=$(systemctl is-enabled "$u" 2>/dev/null)
  printf '%-22s %s / %s\n' "$u" "${a:-missing}" "${e:-not installed}"
done
for u in hyperprox-api hyperprox-frontend hyperprox-setup; do
  systemctl cat "$u" >/dev/null 2>&1 || continue
  echo "--- journal: $u (last 40 lines)"
  journalctl -u "$u" -n 40 --no-pager 2>&1 | grep -viE "incoming request|request completed|reqId|\"(method|url|hostname|remoteAddress|remotePort|statusCode)\"|^\s*[{}]" | tail -25
done

sec "Docker"
if have docker; then
  run 'docker version --format "client {{.Client.Version}} / server {{.Server.Version}}"'
  LINES_MAX=40 run 'docker ps -a --format "{{.Names}}\t{{.Status}}\t{{.Image}}"'
  for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^hyperprox-'); do
    st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
    case "$st" in running\ healthy|running\ ) continue ;; esac
    echo "--- $c is: $st (last 25 log lines)"
    docker logs --tail 25 "$c" 2>&1
  done
  run "cd '$DIR' 2>/dev/null && docker compose config --services 2>&1 | head -20"
else echo "docker not installed"; fi

sec "Listening ports"
run 'ss -ltnp 2>/dev/null | grep -E ":(80|443|3000|3002|5432|6379|8006|8080|8200|9090|3001) " || ss -ltn'

sec "Local health"
run 'curl -s -o /dev/null -m 5 -w "api /health: %{http_code}\n" http://127.0.0.1:3002/health'
run 'curl -s -m 5 http://127.0.0.1:3002/health | head -c 300; echo'
run 'curl -s -o /dev/null -m 5 -w "frontend /login: %{http_code}\n" http://127.0.0.1:3000/login'
run 'curl -sk -o /dev/null -m 5 -w "nginx https /login: %{http_code}\n" https://127.0.0.1/login'
run 'curl -s -o /dev/null -m 5 -w "nginx http /: %{http_code} -> %{redirect_url}\n" http://127.0.0.1/'

sec "Network: proxy, DNS, routes"
env | grep -iE '^(https?|no|all)_proxy=' || echo "no proxy variables in this shell"
grep -rhiE '^\s*(Acquire::https?::Proxy|proxy)' /etc/apt/apt.conf /etc/apt/apt.conf.d 2>/dev/null | head -5
[ -f /etc/systemd/system/docker.service.d/http-proxy.conf ] && { echo "--- docker proxy drop-in"; cat /etc/systemd/system/docker.service.d/http-proxy.conf; }
[ -f /root/.docker/config.json ] && grep -i -A3 proxies /root/.docker/config.json
run 'cat /etc/resolv.conf | grep -vE "^#"'
run 'ip -br addr; ip route | head -5'
for h in github.com raw.githubusercontent.com codeload.github.com objects.githubusercontent.com registry-1.docker.io auth.docker.io production.cloudflare.docker.com ghcr.io registry.npmjs.org deb.nodesource.com deb.debian.org hyperprox.dev; do
  a=$(getent ahostsv4 "$h" 2>/dev/null | awk 'NR==1{print $1}')
  c=$(curl -s -o /dev/null -m $T -w '%{http_code} %{time_total}s' "https://$h/" 2>&1 || true)
  printf '%-36s dns=%-16s https=%s\n' "$h" "${a:-FAIL}" "${c:-FAIL}"
done

sec "TLS interception check"
for h in github.com registry-1.docker.io registry.npmjs.org; do
  iss=$(echo | timeout $T openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
  echo "$h: ${iss:-no certificate (blocked or no openssl)}"
done
echo "(An issuer naming your company, a firewall or a proxy vendor means HTTPS is being intercepted; Docker, npm and git then need that CA installed.)"

sec "Proxmox reachability"
if [ -f "$DIR/.env" ]; then
  ph=$(grep -E '^PROXMOX_HOST=' "$DIR/.env" | cut -d= -f2- | tr -d '"'); pp=$(grep -E '^PROXMOX_PORT=' "$DIR/.env" | cut -d= -f2- | tr -d '"'); pp=${pp:-8006}
  if [ -n "$ph" ]; then
    run "curl -sk -o /dev/null -m $T -w 'GET https://$ph:$pp/api2/json/version -> %{http_code} in %{time_total}s\n' https://$ph:$pp/api2/json/version"
    run "echo | timeout $T openssl s_client -connect $ph:$pp 2>/dev/null | openssl x509 -noout -subject -issuer -enddate"
  else echo "PROXMOX_HOST not set in .env"; fi
fi

sec "Firewall"
run 'ufw status 2>/dev/null | head -10'
LINES_MAX=40 run 'nft list ruleset 2>/dev/null | grep -E "chain|policy|drop|reject" | head -40 || iptables -S 2>/dev/null | head -40'

sec "Install and deploy logs"
for f in /var/log/hyperprox-install.log /root/deploy*.log "$DIR"/logs/*.log; do
  [ -f "$f" ] || continue
  echo "--- $f (errors and last 40 lines)"
  grep -niE "error|fail|denied|refused|timed out|certificate|x509|EAI_AGAIN|ENOTFOUND|ECONN|unauthor" "$f" | tail -30
  echo "..."
  tail -40 "$f"
done
} 2>&1 | redact > "$OUT"

chmod 600 "$OUT"
echo
echo "Saved: $OUT ($(wc -l < "$OUT") lines)"
echo "Passwords, tokens and keys are replaced with <redacted>. Read the file before you share it."
