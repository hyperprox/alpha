#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # the check strings, which read these variables, are run by eval
# The .env lock every writer takes: install.sh, bootstrap.sh (in the container) and bin/hyperprox-config carry the
# same env_lock/env_unlock, and apps/setup/env-file.js uses the same file the same way, so a shell writer and the
# API exclude each other; a dead writer's lock is taken over; a lock is only ever removed by its owner.
#
#   bash scripts/test-env-lock.sh        (needs node)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }
block() { sed -n '/^# ── hpx-env-lock begin/,/^# ── hpx-env-lock end/p' "$1"; }

block "${here}/install.sh" > "${tmp}/i"
block "${here}/bootstrap.sh" > "${tmp}/b"
block "${here}/bin/hyperprox-config" > "${tmp}/c"
check "install.sh carries the lock block"                     '[[ -s "${tmp}/i" ]] && grep -q "^env_lock()" "${tmp}/i"'
check "bootstrap.sh and hyperprox-config carry the same block" 'cmp -s "${tmp}/i" "${tmp}/b" && cmp -s "${tmp}/i" "${tmp}/c"'
check "bootstrap's in-container writer takes it"              'grep -q "ENV_SET_KV=\"\$(declare -f env_lock env_unlock)\"" "${here}/bootstrap.sh" && grep -q "set_kv() { local t; env_lock" "${here}/bootstrap.sh"'
check "install.sh set_env_line and hyperprox-config take it"   'sed -n "/^set_env_line() {/,/^}/p" "${here}/install.sh" | grep -q env_lock && sed -n "/^cfg_set() {/,/^}/p;/^cfg_drop() {/,/^}/p" "${here}/bin/hyperprox-config" | grep -c env_lock | grep -qx 2'

# shellcheck source=/dev/null
. "${tmp}/i"
env="${tmp}/.env"; printf 'A=1\n' > "$env"
js="${here}/apps/setup/env-file.js"

env_lock "$env"
check "the shell's lock holds its token"                      '[[ "$(cat "$env.lock")" == "$HPX_ENV_LOCK_TOKEN" ]]'
out="$(node -e "try { require('$js').updateEnvFile('$env', t => t + 'B=2\n'); console.log('wrote') } catch (e) { console.log('waited: ' + e.message) }")"
check "  and the API's writer waits for it, writing nothing"   '[[ "$out" == waited:* ]] && ! grep -q "^B=" "$env"'
env_unlock "$env"
check "  released by its owner"                               '[[ ! -e "$env.lock" ]]'

# A lock the API holds: the shell waits, then gives up, and never removes it.
node -e "const m = require('$js'); process.stdout.write(m.takeLock('$env.lock'))" > "${tmp}/tok"
start=$SECONDS
( env_lock "$env" ) 2>/dev/null; rc=$?
check "a lock the API holds makes the shell wait, then give up" '[[ $rc -ne 0 && $((SECONDS - start)) -ge 3 ]]'
HPX_ENV_LOCK_TOKEN="someone-else"; env_unlock "$env"
check "  and env_unlock never removes a lock that is not its own" '[[ "$(cat "$env.lock")" == "$(cat "${tmp}/tok")" ]]'

# Dead writers: a lock older than 30 s is taken over, by either side.
touch -d '-2 minutes' "$env.lock"
env_lock "$env"
check "the shell takes over a dead writer's lock"             '[[ "$(cat "$env.lock")" == "$HPX_ENV_LOCK_TOKEN" ]] && ! ls "$env".lock.stale-* >/dev/null 2>&1'
touch -d '-2 minutes' "$env.lock"
out="$(node -e "console.log(require('$js').updateEnvFile('$env', t => t + 'C=3\n'))")"
check "  and so does the API's writer, and releases it"        '[[ "$out" == true ]] && grep -q "^C=3$" "$env" && [[ ! -e "$env.lock" ]]'
check ".env stays owner-only"                                   '[[ "$(stat -c %a "$env")" == 600 ]]'

exit "$fail"
