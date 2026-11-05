#!/usr/bin/env bash
# GRAFANA_ADMIN_PASSWORD leaves .env after the first owner sign-in (it moves to the vault). This proves a
# Grafana recreated without it keeps working and keeps the admin password it was set up with, and that
# `grafana cli admin reset-admin-password --password-from-stdin` (what the reset route runs) sets a new one.
# It uses the image docker-compose.yml pins, in a throwaway container and volume. Basic auth is turned on
# here only so the test can see which password works; HyperProx's Grafana has it off.
#
#   bash scripts/test-grafana-admin-absent.sh     (needs Docker)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="$(grep -oP 'image: \Kgrafana/grafana:\S+' "${here}/docker-compose.yml" | head -1)"
name="hpx-grafana-test-$$"; vol="${name}-data"
fail=0
ok()  { echo "ok    $1"; }
bad() { echo "FAIL  $1"; fail=1; }
cleanup() { docker rm -f "$name" >/dev/null 2>&1; docker volume rm "$vol" >/dev/null 2>&1; }
trap cleanup EXIT

start() {   # start <admin password value, possibly empty>
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" -v "$vol:/var/lib/grafana" -e "GF_SECURITY_ADMIN_PASSWORD=$1" \
    -e GF_AUTH_BASIC_ENABLED=true -e GF_AUTH_DISABLE_LOGIN_FORM=true "$image" >/dev/null || return 1
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
  for _ in $(seq 1 300); do curl -fsS "http://$ip:3000/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
as() { curl -s -o /dev/null -w '%{http_code}' -u "admin:$1" "http://$ip:3000/api/user"; }

docker volume create "$vol" >/dev/null
start "first-password-1" && ok "Grafana sets up its database with the password from .env" || bad "first start"
[ "$(as first-password-1)" = 200 ] && ok "  and admin signs in with it" || bad "first sign-in"
start "" && ok "recreated with GRAFANA_ADMIN_PASSWORD absent (empty, as compose passes it), Grafana starts" || bad "recreate without the password"
[ "$(as first-password-1)" = 200 ] && ok "  and keeps the admin password it was set up with" || bad "password kept"
[ "$(as '')" = 401 ] && ok "  an empty password does not become the admin password" || bad "empty password refused"
printf 'second-password-2\n' | docker exec -i "$name" grafana cli admin reset-admin-password --password-from-stdin >/dev/null 2>&1 \
  && ok "grafana cli resets it with the password on stdin" || bad "reset from stdin"
[ "$(as second-password-2)" = 200 ] && [ "$(as first-password-1)" = 401 ] && ok "  the new password works and the old one does not" || bad "after reset"
# A new database with the variable absent (a volume reset after the password moved to the vault) starts
# with Grafana's default admin/admin. HyperProx sets the vault's password at the next owner or admin
# sign-in, through the same stdin reset; this shows the default is gone after it.
docker rm -f "$name" >/dev/null 2>&1; docker volume rm "$vol" >/dev/null 2>&1; docker volume create "$vol" >/dev/null
start "" && ok "a new database without the password starts" || bad "fresh start without the password"
printf 'from-the-vault-3\n' | docker exec -i "$name" grafana cli admin reset-admin-password --password-from-stdin >/dev/null 2>&1
[ "$(as admin)" = 401 ] && [ "$(as from-the-vault-3)" = 200 ] && ok "  after HyperProx applies the vault password, admin/admin no longer works" || bad "default left in place"
exit "$fail"
