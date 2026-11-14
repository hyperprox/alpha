#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2016  # variables are read by install.sh functions and by check strings eval runs
# install.sh --ref and HYPERPROX_REPO_URL: a branch ref is checked out as that branch (not renamed to main), a tag
# or commit puts main at it, and the update source (.env HYPERPROX_UPDATE_REPO / HYPERPROX_UPDATE_BRANCH) follows
# what was installed. Runs install.sh's own checkout_ref and configure_update_source against a throwaway repo.
#
#   bash scripts/test-install-ref.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
fail=0
ok()   { :; }
step() { :; }
warn() { echo "warn: $*"; }
die()  { echo "die: $*"; return 1; }
pass() { echo "ok    $1"; }
bad()  { echo "FAIL  $1${2:+ ($2)}"; fail=1; }
check() { if eval "$2"; then pass "$1"; else bad "$1" "$2"; fi; }
for f in env_lock env_unlock checkout_ref set_env_line configure_update_source clone_repo; do
  eval "$(sed -n "/^${f}() {/,/^}/p" "${here}/install.sh")"
  declare -F "$f" >/dev/null || { echo "FAIL  ${f} not found in install.sh"; exit 1; }
done
LOG_FILE="${tmp}/log"

# An upstream with main, a feature branch and a tag.
up="${tmp}/up.git"; git init -q --bare -b main "$up"
w="${tmp}/w"; git clone -q "$up" "$w" 2>/dev/null
g() { git -C "$w" -c user.name=t -c user.email=t@example.com "$@"; }
g commit -q --allow-empty -m one; g tag v1.0.0; g push -q origin main v1.0.0
g checkout -q -b feat/x; g commit -q --allow-empty -m two; g push -q origin feat/x
feat_sha="$(g rev-parse HEAD)"; tag_sha="$(g rev-parse v1.0.0)"

install_with() {  # install_with <ref> [repo url env] -> a fresh clone in $HYPERPROX_DIR with .env
  HYPERPROX_DIR="${tmp}/i.$RANDOM"; git clone -q "$up" "$HYPERPROX_DIR"
  ENV_FILE="${HYPERPROX_DIR}/.env"; printf 'HOST_IP=192.0.2.10\n' > "$ENV_FILE"
  INSTALL_REF="$1"; HYPERPROX_REF="$1"; INSTALL_BRANCH=""
  REPO_URL="${2:-$up}"; HYPERPROX_REPO_URL="${2:-}"
  checkout_ref; configure_update_source
}
envval() { grep -m1 "^$1=" "${ENV_FILE}" | cut -d= -f2-; }

install_with feat/x
check "a branch ref is checked out as that branch"                '[[ "$(git -C "$HYPERPROX_DIR" symbolic-ref --short HEAD)" == feat/x ]]'
check "  at its head"                                              '[[ "$(git -C "$HYPERPROX_DIR" rev-parse HEAD)" == "$feat_sha" ]]'
check "  main is not moved to it"                                  '[[ "$(git -C "$HYPERPROX_DIR" rev-parse main)" != "$feat_sha" ]]'
check "  updates follow that branch"                               '[[ "$(envval HYPERPROX_UPDATE_BRANCH)" == feat/x ]]'

install_with v1.0.0
check "a tag puts main at it"                                      '[[ "$(git -C "$HYPERPROX_DIR" symbolic-ref --short HEAD)" == main && "$(git -C "$HYPERPROX_DIR" rev-parse HEAD)" == "$tag_sha" ]]'
check "  and updates follow main"                                  '[[ "$(envval HYPERPROX_UPDATE_BRANCH)" == main ]]'

install_with "" "https://git.example.com/me/hyperprox.git"
check "a mirror install writes its own repo as the update source" '[[ "$(envval HYPERPROX_UPDATE_REPO)" == https://git.example.com/me/hyperprox.git ]]'
check "  and main as the branch"                                   '[[ "$(envval HYPERPROX_UPDATE_BRANCH)" == main ]]'
check "  each written once"                                        '[[ "$(grep -c "^HYPERPROX_UPDATE_" "$ENV_FILE")" == 2 ]]'

# A re-run told nothing keeps what is there; told a new source, replaces it (not a second line).
INSTALL_REF=""; HYPERPROX_REF=""; HYPERPROX_REPO_URL=""; REPO_URL="https://github.com/example/default.git"
configure_update_source
check "a re-run with no source keeps the mirror"                   '[[ "$(envval HYPERPROX_UPDATE_REPO)" == https://git.example.com/me/hyperprox.git ]]'
HYPERPROX_REPO_URL="https://git.example.com/other/hyperprox.git"; REPO_URL="$HYPERPROX_REPO_URL"
configure_update_source
check "a re-run with a new source replaces it in place"            '[[ "$(envval HYPERPROX_UPDATE_REPO)" == https://git.example.com/other/hyperprox.git && "$(grep -c "^HYPERPROX_UPDATE_REPO=" "$ENV_FILE")" == 1 ]]'
check "install.sh runs configure_update_source in main"           'sed -n "/^main() {/,/^}/p" "${here}/install.sh" | grep -q configure_update_source'

# An existing clone keeps its origin: HYPERPROX_REPO_URL is for a fresh clone, and the messages name the origin.
HYPERPROX_DIR="${tmp}/existing"; git clone -q "$up" "$HYPERPROX_DIR"
INSTALL_REF=""; HYPERPROX_REF=""; HYPERPROX_REPO_URL="https://git.example.com/fork/hyperprox.git"; REPO_URL="$HYPERPROX_REPO_URL"
out="$(clone_repo 2>&1; echo "REPO_URL=$REPO_URL")"
check "an existing clone with another HYPERPROX_REPO_URL says it applies to a fresh clone only" '[[ "$out" == *"applies to a fresh clone only"*"fetches from its origin, $up"* ]]'
check "  and names the origin it really fetches from"             '[[ "$(clone_repo >/dev/null 2>&1; echo "$REPO_URL")" == "$up" ]]'

exit "$fail"
