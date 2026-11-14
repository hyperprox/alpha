#!/usr/bin/env bash
# The installers' shared UI block (bootstrap.sh and install.sh each carry a copy, between the "hpx-ui begin" and
# "hpx-ui end" lines): the two copies are identical, plain output has no escape codes, a terminal gets the
# graphical layout at 80 columns, and a spinner never outlives its command or hides a failure.
#
#   bash scripts/test-installer-ui.sh
set -euo pipefail
export LC_ALL=C.UTF-8   # widths below are counted in characters

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
block() { sed -n '/^# ── hpx-ui begin/,/^# ── hpx-ui end/p' "$1"; }
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
fail=0
check() {  # check <name> <command>
  if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi
}

block "${here}/bootstrap.sh" > "${tmp}/b.sh"
block "${here}/install.sh"   > "${tmp}/i.sh"
check "bootstrap.sh carries the UI block"         '[[ -s "${tmp}/b.sh" ]] && grep -q "^ui_run()" "${tmp}/b.sh"'
check "install.sh carries the same block, byte for byte" 'cmp -s "${tmp}/b.sh" "${tmp}/i.sh"'

# A harness: the block, then what the test asks for. FANCY=1 runs it under script(1) so stdout is a terminal.
cat > "${tmp}/run.sh" <<EOF
. "${tmp}/b.sh"
ui_init
UI_LOG="${tmp}/log"; : > "\$UI_LOG"
UI_STEPS=10
"\$@"
EOF
plain() { env -i PATH="$PATH" TERM=xterm-256color LANG=C.UTF-8 bash "${tmp}/run.sh" "$@" 2>&1; }
fancy() {   # on a pseudo-terminal 80 columns wide
  env -i PATH="$PATH" TERM=xterm-256color LANG=C.UTF-8 COLUMNS=80 ${NO_COLOR:+NO_COLOR=$NO_COLOR} \
    script -qec "bash ${tmp}/run.sh $*" /dev/null 2>&1
}
cat >> "${tmp}/b.sh" <<'EOF'
demo() {
  ui_step "Docker"
  ui_run "Short job" sleep 0.3
  ui_run "Failing job" bash -c 'echo first-line; echo the-reason >&2; exit 3' || true
  ui_table_top "Ready to install"; ui_table_row "Container" "160  hyperprox  on pve1"; ui_table_bottom
  ui_box_top "" "$UI_CW" "$C_OK"; ui_card_line "✓  HyperProx is running" "" "total 1m 02s"; ui_box_bottom "$UI_CW"
}
two_steps() { false; echo SHOULD-NOT-RUN; }
errexit() { set -e; ui_try ui_run "Two steps" two_steps; echo "rc=$UI_RC"; }
spinner_gone() { ui_run "Job" sleep 0.5; if [ -z "$(jobs -pr)" ]; then echo GONE; else echo LEFT; fi; }
card() {
  ui_box_top "" "$UI_CW" "$C_OK"
  ui_card_line "   1  The setup wizard connects your Proxmox cluster and asks a few yes/no questions, then more words"
  ui_box_bottom "$UI_CW"
  ui_link "Setup link (private):" "https://192.0.2.10/setup#k=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ui_warn "A fairly long warning that goes on past the width of an eighty column terminal so it has to be wrapped somewhere"
}
choices() {
  ui_ask_box "VPN" "How do you want to reach HyperProx?"
  ui_choices 3 "Tailscale   short" "WireGuard   a row that is far too long to fit inside the question box and has to wrap onto a second line" "Not now"
  ui_ask_end
  ui_note "Browsers will warn once. To use your own, replace /opt/hyperprox/certs/cert.pem and key.pem, then: docker restart hyperprox-nginx"
  ui_command "modprobe wireguard && echo wireguard > /etc/modules-load.d/wireguard.conf"
}
EOF

out="$(plain demo)"
check "plain: no escape codes at all"                '! grep -q $'"'"'\e'"'"' <<< "$out"'
check "plain: step lines read [step N/M]"            'grep -qx "\[step 1/10\] Docker" <<< "$out"'
check "plain: done lines read [ ok ] … (Ns)"          'grep -qE "^\[ ok \] Short job \([0-9]+s\)$" <<< "$out"'
check "plain: a running job reads [ .. ]"            'grep -qx "\[ \.\. \] Short job" <<< "$out"'
check "plain: a failure shows the end of its output" 'grep -q "the-reason" <<< "$out" && grep -q "exit 3" <<< "$out"'

out="$(fancy demo)"
check "terminal: coloured (escape codes)"            'grep -q $'"'"'\e\['"'"' <<< "$out"'
check "terminal: the step rule is 80 wide"           '[[ "$(sed $'"'"'s/\x1b\[[0-9;?]*[A-Za-z]//g'"'"' <<< "$out" | grep -m1 "Step 1/10" | tr -d "\r" | wc -m)" -eq 81 ]]'
check "terminal: the table has straight sides"       '[[ "$(sed $'"'"'s/\x1b\[[0-9;?]*[A-Za-z]//g'"'"' <<< "$out" | tr -d "\r" | grep -E "^  [╔║╟╚]" | while IFS= read -r l; do echo "${#l}"; done | sort -u | wc -l)" -eq 1 ]]'
check "terminal: a failure is not hidden"            'grep -q "the-reason" <<< "$out"'
out="$(NO_COLOR=1 fancy demo)"
check "NO_COLOR on a terminal: plain"                '! grep -q $'"'"'\e\['"'"' <<< "$(tr -d "\r" <<< "$out")"'
# shellcheck disable=SC2034  # read by the check below, inside the string eval runs
out="$(env -i PATH="$PATH" TERM=xterm-256color LANG=C.UTF-8 COLUMNS=60 script -qec "bash ${tmp}/run.sh demo" /dev/null 2>&1)"
check "a terminal under 72 columns: plain"           'grep -q "^\[step 1/10\] Docker" <<< "$(tr -d "\r" <<< "$out")"'
# shellcheck disable=SC2034  # read by the check below, inside the string eval runs
out="$(plain errexit)"
check "a job stops at its first failing command (set -e holds)" '! grep -q SHOULD-NOT-RUN <<< "$out" && grep -q "^rc=1$" <<< "$out"'
check "the spinner process ends with its command"    '[[ "$(fancy spinner_gone | tr -d "\r" | tail -1)" == *GONE ]]'

# The finish card: the setup link is outside the box, whole, on its own line; wrapped card lines keep their indent.
# shellcheck disable=SC2034  # read by the checks below, inside the strings eval runs
out="$(fancy card | sed $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' | tr -d '\r')"
# shellcheck disable=SC2034  # read by the check below
link_line='  https://192.0.2.10/setup#k=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
check "the setup link is printed whole on its own line, outside the box" 'grep -qxF "$link_line" <<< "$out"'
check "  and no box line holds any of it"            '! grep "│" <<< "$out" | grep -q "0123456789abcdef"'
check "a wrapped numbered card line hangs under its text" 'grep -qE "^  │ +1  The setup" <<< "$out" && grep -qE "^  │ {8}[a-z]" <<< "$out"'
check "every card line has straight sides"           '[[ "$(grep -E "^  [╭│╰]" <<< "$out" | while IFS= read -r l; do echo "${#l}"; done | sort -u | wc -l)" -eq 1 ]]'
check "a long warning is wrapped to 80 columns, its second line indented" '[[ "$(grep -A1 "A fairly long" <<< "$out" | while IFS= read -r l; do echo "${#l}"; done | sort -n | tail -1)" -le 80 ]] && grep -A1 "A fairly long" <<< "$out" | tail -1 | grep -qE "^    [a-z]"'
# shellcheck disable=SC2034  # read by the checks below, inside the strings eval runs
out2="$(fancy choices | sed $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' | tr -d '\r')"
check "a choice row too long for the box wraps inside it: straight sides" '[[ "$(grep -E "^  [╭│╰]" <<< "$out2" | while IFS= read -r l; do echo "${#l}"; done | sort -u | wc -l)" -eq 1 ]] && grep -q "has to wrap" <<< "$out2"'
check "a long note wraps between words, never inside a name"         '! grep -q "hy$" <<< "$out2" && grep -qE "^    .*docker restart hyperprox-nginx$|^    hyperprox-nginx$" <<< "$out2" && [[ "$(grep -E "^    [^ ]" <<< "$out2" | while IFS= read -r l; do echo "${#l}"; done | sort -n | tail -1)" -le 80 ]]'
check "a command is printed whole on its own line"                    'grep -qxF "      modprobe wireguard && echo wireguard > /etc/modules-load.d/wireguard.conf" <<< "$out2"'
check "install.sh prints the setup link with ui_link, not inside the card" 'grep -qF "ui_link \"Setup link (private):\" \"\${link}\"" "${here}/install.sh" && ! grep -qF "Open   \${link}" "${here}/install.sh"'
check "bootstrap.sh does the same"                   'grep -qF "ui_link \"Setup link (private):\" \"\$SETUP_URL\"" "${here}/bootstrap.sh" && ! grep -qF "Open   \${SETUP_URL}" "${here}/bootstrap.sh"'
check "per-install config, bind and keyholder lines are indented as notes" 'grep -qF "log()  { printf '"'"'    %s" "${here}/bin/hyperprox-config" && grep -qF "printf '"'"'    %s: %s=%s (drop-in" "${here}/bin/hyperprox-bind" && grep -qF "echo \"    keyholder started" "${here}/bin/install-keyholder"'

exit "${fail}"
