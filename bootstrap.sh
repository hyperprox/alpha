#!/usr/bin/env bash
#
# HyperProx — one-command install, run on a Proxmox host.
#
#   curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/bootstrap.sh | bash
#
# Everything the README used to ask you to do by hand, this does: asks for a
# container ID and an address (offering free ones), picks a storage, fetches the right template for this host's CPU,
# creates the container with the features Docker needs, mints the API token,
# then installs HyperProx and hands you a URL.
#
# First it looks at every node (GPUs, power counters, what is already
# installed), lists what it found, and asks a few yes/no questions — only the
# ones that apply, and never about something that is already there. Then it
# shows one summary of everything it will create and asks once more. Nothing is
# created before that last answer. -y takes every default.
#
# If the install stops part-way (Ctrl+C, a failure), what this run created is
# removed again; anything that was there before is never touched.
#
# The node scripts live in packages/hardware/node/ (the same ones the setup
# wizard and the API use). They only ever add packages, never upgrade or remove
# one, and never touch kernels, drivers or apt holds.
#
# It is safe to re-run: anything already correct is left alone.
#
# The whole script is one function, called on the very last line. Under
# `curl | bash`, bash reads the script from the pipe as it runs; wrapped like
# this, nothing runs until the last line has arrived (a cut-off download runs
# nothing), and no command started later can read the rest of the script as
# its input.

set -euo pipefail

CTID=""            ; HOSTNAME="hyperprox"
CORES=4            ; MEMORY=8192        ; DISK=100
BRIDGE="vmbr0"     ; NET="dhcp"         ; GATEWAY=""
STORAGE=""         ; TEMPLATE_STORAGE=""
PASSWORD=""        ; ASSUME_YES=0       ; DRY_RUN=0       ; KEEP_ON_FAILURE=0
REF=""             # a tag, branch or commit to install instead of main (--ref)
DNS=""             ; DNS_FROM=""        ; DNS_NOTE=""      # the container's nameservers (--dns, or chosen below)
# Remote access: VPN is tailscale, wireguard or none (--vpn, or asked). The Tailscale auth key comes from
# TS_AUTHKEY (preferred: it stays off the command line) or --tailscale-authkey, and is never printed.
VPN=""             ; TS_KEY="${TS_AUTHKEY:-}"; TS_KEY_ARG=""; unset TS_AUTHKEY
TOKEN_NAME="hyperprox"; TOKEN_NAME_GIVEN=0; TEMPLATE_STORAGE_ARG=""
WG_SUBNET=""       ; WG_SUBNET_GIVEN=0  ; WG_ENDPOINT=""   ; WG_PORT=51820
TS_IP=""           ; TS_DNS=""          ; TS_URL=""        ; TS_PID=""
WG_CTID=""         ; WG_CT_TRY=0        ; WG_PUB=""        ; WG_IP=""        ; WG_EP=""     ; WG_LINE=""   ; WG_HOSTNAME=""
PW_FILE=""
[ "${HYPERPROX_YES:-}" = 1 ] && ASSUME_YES=1
# Answers: "" means ask (or take the default with -y); a flag below answers in advance.
A_NODE_HEALTH=""   ; A_POWER=""         ; A_GPU=""
A_CHARTS=""        ; A_PVE_METRICS=""   ; A_DNS=""          ; A_AI=""          ; A_IGPU=""

# ── hpx-ui begin ──────────────────────────────────────────────────────────────
#  The installers' look: banner, step headers, spinners, question boxes, the review table and the finish
#  cards. Pure bash, printf and tput; nothing to install. bootstrap.sh and install.sh each carry an IDENTICAL
#  copy of this block (from the "hpx-ui begin" line to the "hpx-ui end" line), because bootstrap.sh arrives
#  alone through `curl | bash` and has nothing to source. scripts/test-installer-ui.sh fails if the two copies
#  differ: change one, copy it to the other.
#
#  Graphical only where it can be seen: stdout is a terminal at least 72 columns wide, NO_COLOR is not set,
#  TERM is set and not "dumb", and the locale is UTF-8. Anything else (a pipe, a log file, -y > install.log)
#  gets plain lines ("[step 4/10] …", "[ ok ] … (6s)", "[ .. ] …") with no escape codes, so logs stay
#  grep-friendly. The layout is drawn for 80 columns.
UI_FANCY=0; UI_W=80; UI_BW=70; UI_CW=68
UI_STEP=0; UI_STEPS=0; UI_STEP_TITLE=""; UI_NEXT=()
UI_SPIN_PID=""; UI_RUN_PID=""; UI_LOG="/dev/null"; UI_LAST_OUT=""; UI_PROGRESS=""
C_ACC=""; C_ACC2=""; C_ACC3=""; C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_BOLD=""; C_KEY=""; C_INV=""; C_OFF=""

ui_init() {
  local n=0 cols=0
  UI_FANCY=0
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ -n "${TERM:-}" ] && [ "${TERM}" != dumb ]; then
    if [ "$(locale charmap 2>/dev/null)" = UTF-8 ]; then UI_FANCY=1
    elif [ -z "${LC_ALL:-}" ] && [ "$(LC_CTYPE=C.UTF-8 locale charmap 2>/dev/null)" = UTF-8 ]; then
      LC_CTYPE=C.UTF-8; UI_FANCY=1      # this shell only (not exported): lengths count characters, not bytes
    fi
  fi
  [ "$UI_FANCY" -eq 1 ] || return 0
  if [[ "${COLUMNS:-}" =~ ^[0-9]+$ ]]; then cols="$COLUMNS"
  elif command -v tput >/dev/null 2>&1; then cols="$(tput cols 2>/dev/null || echo 0)"; fi
  [[ "$cols" =~ ^[0-9]+$ ]] || cols=0
  [ "$cols" -ge 72 ] || { UI_FANCY=0; return 0; }
  UI_W=80; [ "$cols" -ge 80 ] || UI_W="$cols"
  UI_BW=$(( UI_W - 10 )); UI_CW=$(( UI_W - 12 ))
  command -v tput >/dev/null 2>&1 && n="$(tput colors 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  # The brand teal, #2fd6e8, shading to #1fa9bb and #147c8b: truecolor where the terminal says it has it,
  # else the nearest of 256 (44, 37, 30), else plain cyan.
  if [ "${COLORTERM:-}" = truecolor ] || [ "${COLORTERM:-}" = 24bit ]; then
    C_ACC=$'\e[38;2;47;214;232m'; C_ACC2=$'\e[38;2;31;169;187m'; C_ACC3=$'\e[38;2;20;124;139m'
    C_INV=$'\e[1;48;2;47;214;232;38;2;10;17;28m'
  elif [ "$n" -ge 256 ]; then
    C_ACC=$'\e[38;5;44m'; C_ACC2=$'\e[38;5;37m'; C_ACC3=$'\e[38;5;30m'; C_INV=$'\e[1;48;5;44;38;5;234m'
  else
    C_ACC=$'\e[36m'; C_ACC2=$'\e[36m'; C_ACC3=$'\e[36m'; C_INV=$'\e[1;46;30m'
  fi
  C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_DIM=$'\e[90m'; C_BOLD=$'\e[1m'; C_KEY=$'\e[1;97m'; C_OFF=$'\e[0m'
}

# ui_rep CHAR N: CHAR, N times.
ui_rep() { local s=""; local -i i; for (( i = 0; i < $2; i++ )); do s+="$1"; done; printf '%s' "$s"; }
# ui_pad TEXT WIDTH: TEXT, then spaces up to WIDTH characters.
ui_pad() { local p=$(( $2 - ${#1} )); [ "$p" -ge 0 ] || p=0; printf '%s%*s' "$1" "$p" ''; }
ui_secs() { local t="$1"; if [ "$t" -ge 60 ]; then printf '%dm %02ds' $(( t / 60 )) $(( t % 60 )); else printf '%ds' "$t"; fi; }

# ui_wrap WIDTH TEXT: TEXT as lines of at most WIDTH characters, broken between words.
ui_wrap() {
  local w="$1" line="" word; local -a ws
  read -ra ws <<< "$2"
  for word in "${ws[@]}"; do
    while [ "${#word}" -gt "$w" ]; do
      [ -z "$line" ] || { printf '%s\n' "$line"; line=""; }
      printf '%s\n' "${word:0:$w}"; word="${word:$w}"
    done
    if [ -z "$line" ]; then line="$word"
    elif [ $(( ${#line} + 1 + ${#word} )) -le "$w" ]; then line+=" $word"
    else printf '%s\n' "$line"; line="$word"; fi
  done
  [ -z "$line" ] || printf '%s\n' "$line"
}

# ui_wrap_keep WIDTH TEXT: as ui_wrap, keeping TEXT's leading spaces on every line, and hanging lines that start
# with a marker ("1  ", "✓  ", "!  ", "·  ") under the text after it, so a wrapped item stays one item.
ui_wrap_keep() {
  local w="$1" t="$2" ind="" mark="" hang="" first=1 l
  ind="${t%%[! ]*}"; t="${t#"$ind"}"
  if [[ "$t" =~ ^([0-9]+|[✓✗!•·-])\ + ]]; then mark="${BASH_REMATCH[0]}"; t="${t#"$mark"}"; hang="$(ui_rep ' ' "${#mark}")"; fi
  while IFS= read -r l; do
    if [ "$first" -eq 1 ]; then printf '%s%s%s\n' "$ind" "$mark" "$l"; first=0
    else printf '%s%s%s\n' "$ind" "$hang" "$l"; fi
  done < <(ui_wrap $(( w - ${#ind} - ${#mark} )) "$t")
}

# ui_banner WHAT REF: the HYPERPROX banner and its tagline (fancy), or one plain line.
ui_banner() {
  if [ "$UI_FANCY" -ne 1 ]; then printf 'HyperProx %s · %s\n' "$1" "$2"; return; fi
  printf '\n'
  if [ "$UI_W" -ge 78 ]; then
    printf '%s  %s%s\n' \
      "$C_ACC"  '██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██████╗ ██████╗  ██████╗ ██╗  ██╗' "$C_OFF" \
      "$C_ACC"  '██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝' "$C_OFF" \
      "$C_ACC2" '███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝██████╔╝██████╔╝██║   ██║ ╚███╔╝ ' "$C_OFF" \
      "$C_ACC2" '██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗ ' "$C_OFF" \
      "$C_ACC3" '██║  ██║   ██║   ██║     ███████╗██║  ██║██║     ██║  ██║╚██████╔╝██╔╝ ██╗' "$C_OFF" \
      "$C_ACC3" '╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝' "$C_OFF"
  else
    printf '  %s%s▌ H Y P E R P R O X%s\n' "$C_ACC" "$C_BOLD" "$C_OFF"
  fi
  printf '%s            Your Proxmox command center  ·  %s  ·  %s%s\n\n' "$C_DIM" "$1" "$2" "$C_OFF"
}

# ui_step TITLE: the next numbered step: "━━━ Step 3/10 · Title ━━━…" (plain: "[step 3/10] Title").
ui_step() {
  UI_STEP=$(( UI_STEP + 1 )); UI_STEP_TITLE="$1"; UI_NEXT=()
  if [ "$UI_FANCY" -ne 1 ]; then printf '[step %s/%s] %s\n' "$UI_STEP" "$UI_STEPS" "$1"; return; fi
  local head="━━━ Step ${UI_STEP}/${UI_STEPS} · $1 "
  printf '%s%s%s%s\n' "$C_ACC" "$head" "$(ui_rep '━' $(( UI_W - ${#head} )))" "$C_OFF"
}
# ui_plan MSG...: the long jobs this step runs next (their ui_run messages), listed dim under the spinner.
ui_plan() { UI_NEXT=("$@"); }
ui_sub() {   # a heading inside a step
  if [ "$UI_FANCY" -ne 1 ]; then printf '[ -- ] %s\n' "$1"; return; fi
  printf '  %s▸%s %s\n' "$C_ACC" "$C_OFF" "$1"
}

# ── Result lines. Fancy: "  ✓ text" with the time right-aligned and dim; plain: "[ ok ] text (6s)".
ui_ok() {
  if [ "$UI_FANCY" -ne 1 ]; then printf '[ ok ] %s%s\n' "$1" "${2:+ ($2)}"; return; fi
  if [ -n "${2:-}" ]; then printf '  %s✓%s %s %s%7s%s\n' "$C_OK" "$C_OFF" "$(ui_pad "$1" $(( UI_W - 22 )))" "$C_DIM" "$2" "$C_OFF"
  else printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$1"; fi
}
ui_kv() {    # KEY VALUE: a found fact. Fancy: key column and dim value; plain: "[ ok ] Key: value".
  if [ "$UI_FANCY" -ne 1 ]; then printf '[ ok ] %s: %s\n' "$1" "$2"; return; fi
  printf '  %s✓%s %s %s%s%s\n' "$C_OK" "$C_OFF" "$(ui_pad "$1" 25)" "$C_DIM" "$2" "$C_OFF"
}
ui_warn() {   # wrapped to the layout's width, the wrapped lines under the text
  local l first=1
  if [ "$UI_FANCY" -ne 1 ]; then printf '[warn] %s\n' "$1"; return; fi
  while IFS= read -r l; do
    if [ "$first" -eq 1 ]; then printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$l"; first=0
    else printf '    %s\n' "$l"; fi
  done < <(ui_wrap $(( UI_W - 4 )) "$1")
}
ui_bad() {   # a refused answer or a failed line: red ✗
  if [ "$UI_FANCY" -ne 1 ]; then printf '[ no ] %s\n' "$1"; return; fi
  printf '  %s✗ %s%s\n' "$C_ERR" "$1" "$C_OFF"
}
ui_note() {
  if [ "$UI_FANCY" -ne 1 ]; then printf '       %s\n' "$1"; return; fi
  printf '    %s%s%s\n' "$C_DIM" "$1" "$C_OFF"
}

# ── Spinners. ui_run and ui_wait run a command in the background (stdin from /dev/null, all output to
#    UI_OUT, else UI_LOG) and, on a terminal, show a braille spinner with the seconds so far, the jobs still
#    to come in this step (ui_plan) dim below it, and a progress bar when UI_PROGRESS names a function that
#    prints "done total". The spinner is its own background process watching the command's PID;
#    ui_spin_stop (and ui_abort, from an exit or interrupt trap) removes it and puts the cursor back. Both
#    return the command's exit status. Shell variables the command sets do not come back: it runs in a subshell.
ui_bar() {   # DONE TOTAL: a 24-cell bar with half cells
  local h=0 full half
  [ "$2" -gt 0 ] && h=$(( $1 * 48 / $2 )); [ "$h" -le 48 ] || h=48
  full=$(( h / 2 )); half=$(( h % 2 ))
  printf '%s%s%s%s%s%s' "$C_ACC" "$(ui_rep '█' "$full")" "$([ "$half" -eq 1 ] && printf '▌')" "$C_DIM" \
    "$(ui_rep '░' $(( 24 - full - half )))" "$C_OFF"
}
ui_spin_start() {   # MSG PID
  [ "$UI_FANCY" -eq 1 ] || return 0
  local msg="$1" pid="$2" max=$(( UI_W - 24 )) n
  local -a next=()
  for n in "${UI_NEXT[@]}"; do [ "$n" = "$1" ] || next+=("$n"); done
  [ "${#next[@]}" -le 4 ] || next=("${next[@]:0:4}")
  [ "${#msg}" -le "$max" ] || msg="${msg:0:$(( max - 1 ))}…"
  (
    trap 'exit 0' TERM
    frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏'); i=0; t0=$SECONDS; prog=""
    while kill -0 "$pid" 2>/dev/null; do
      if [ -n "$UI_PROGRESS" ] && [ $(( i % 10 )) -eq 0 ]; then prog="$("$UI_PROGRESS" 2>/dev/null || true)"; fi
      body="$msg"; shown="$msg"
      if [[ "$prog" =~ ^([0-9]+)\ ([1-9][0-9]*)$ ]]; then
        body="$msg  $(ui_bar "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")  ${BASH_REMATCH[1]} of ${BASH_REMATCH[2]}"
        shown="$msg  $(ui_rep x 24)  ${BASH_REMATCH[1]} of ${BASH_REMATCH[2]}"
      fi
      pad=$(( UI_W - 22 - ${#shown} )); [ "$pad" -ge 1 ] || pad=1
      printf '\r  %s%s%s %s%*s%s%7s%s\e[K' "$C_ACC" "${frames[i % 10]}" "$C_OFF" "$body" "$pad" '' "$C_DIM" \
        "$(ui_secs $(( SECONDS - t0 )))" "$C_OFF"
      for n in "${next[@]}"; do printf '\n    %s·  %s%s\e[K' "$C_DIM" "$n" "$C_OFF"; done
      [ "${#next[@]}" -eq 0 ] || printf '\e[%dA' "${#next[@]}"
      i=$(( i + 1 )); sleep 0.1
    done
  ) &
  UI_SPIN_PID=$!
  printf '\e[?25l'
}
ui_spin_stop() {
  [ -n "$UI_SPIN_PID" ] || return 0
  kill "$UI_SPIN_PID" 2>/dev/null || true
  wait "$UI_SPIN_PID" 2>/dev/null || true
  UI_SPIN_PID=""
  printf '\r\e[J\e[?25h'
}
# ui_abort: from an exit or interrupt trap. Stops the running command and what it started (a background job
# ignores Ctrl+C), then the spinner.
ui_kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do ui_kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }
ui_abort() {
  if [ -n "$UI_RUN_PID" ]; then ui_kill_tree "$UI_RUN_PID"; wait "$UI_RUN_PID" 2>/dev/null || true; UI_RUN_PID=""; fi
  ui_spin_stop
}

# ui_wait MSG CMD...: a spinner on a terminal, nothing in plain output; the caller reports the outcome. The command
# runs with errexit on (a function stops at its first failing command), as long as ui_wait is not itself called
# inside `||`, `&&`, `!` or `if`: bash ignores set -e there, even in subshells. Call it, and ui_run, through
# ui_try, which keeps them out of such a context and leaves the status in UI_RC.
ui_wait() {
  local msg="$1" rc=0 e=0; shift
  case $- in *e*) e=1;; esac
  ( set -e; "$@" ) < /dev/null >> "${UI_OUT:-$UI_LOG}" 2>&1 &
  UI_RUN_PID=$!
  ui_spin_start "$msg" "$UI_RUN_PID"
  set +e; wait "$UI_RUN_PID"; rc=$?; [ "$e" -eq 0 ] || set -e
  UI_RUN_PID=""
  ui_spin_stop
  [ "${UI_NEXT[0]:-}" != "$msg" ] || UI_NEXT=("${UI_NEXT[@]:1}")
  return "$rc"
}
# ui_run MSG CMD...: as ui_wait, then a ✓ line with the time taken, or a ✗ line and the last 20 lines of
# the command's output, so a failure is never hidden behind the spinner.
ui_run() {
  local msg="$1" rc=0 e=0 t0=$SECONDS out="${UI_OUT:-$UI_LOG}"; shift
  case $- in *e*) e=1;; esac
  [ "$UI_FANCY" -eq 1 ] || printf '[ .. ] %s\n' "$msg"
  set +e; ui_wait "$msg" "$@"; rc=$?; [ "$e" -eq 0 ] || set -e
  if [ "$rc" -eq 0 ]; then ui_ok "$msg" "$(ui_secs $(( SECONDS - t0 )))"; return 0; fi
  ui_bad "$msg (failed after $(ui_secs $(( SECONDS - t0 ))), exit $rc)"
  if [ -s "$out" ] && [ "$out" != /dev/null ]; then
    UI_LAST_OUT="$out"
    printf '    %slast output:%s\n' "$C_DIM" "$C_OFF"
    tail -n 20 "$out" | sed $'s/\e\\[[0-9;?]*[A-Za-z]//g; s/\r//g; s/^/      /'
  fi
  return "$rc"
}

# ui_try CMD...: CMD (ui_run or ui_wait) called outside any `||`, `&&`, `!` or `if`, so the job's set -e holds.
# The status lands in UI_RC; ui_try itself always succeeds. Use: ui_try ui_run "msg" cmd; [ "$UI_RC" -eq 0 ] || …
UI_RC=0
ui_try() { local e=0; case $- in *e*) e=1;; esac; set +e; "$@"; UI_RC=$?; [ "$e" -eq 0 ] || set -e; return 0; }

# ── Questions. ui_ask_box TITLE QUESTION [EXPLANATION]: a rounded box (plain: the question, the explanation
#    indented below). ui_prompt LABEL DEFAULT: "› ID [160]: " under it (plain: "[160] ").
ui_ask_box() {
  local l w=$(( UI_BW - 4 ))
  if [ "$UI_FANCY" -ne 1 ]; then printf '\n  %s\n' "$2"; [ -z "${3:-}" ] || printf '    %s\n' "$3"; return; fi
  printf '\n'
  ui_box_top "$1" "$UI_BW" "$C_ACC"
  while IFS= read -r l; do ui_box_put "$l" "${#l}" "$UI_BW"; done < <(ui_wrap "$w" "$2")
  if [ -n "${3:-}" ]; then
    while IFS= read -r l; do ui_box_put "$C_DIM$l$C_OFF" "${#l}" "$UI_BW"; done < <(ui_wrap "$w" "$3")
  fi
}
ui_ask_end() { [ "$UI_FANCY" -ne 1 ] || ui_box_bottom "$UI_BW"; }
ui_prompt() {
  if [ "$UI_FANCY" -ne 1 ]; then printf '  [%s] ' "$2"; return; fi
  printf '  %s› %s%s %s[%s]%s: ' "$C_KEY" "$1" "$C_OFF" "$C_DIM" "$2" "$C_OFF"
}
# ui_choices DEFAULT ITEM...: numbered rows inside the open box (plain: indented lines), the default one
# highlighted in reverse teal.
ui_choices() {
  local def="$1" i=0 it row; shift
  [ "$UI_FANCY" -ne 1 ] || ui_box_put "" 0 "$UI_BW"
  for it in "$@"; do
    i=$(( i + 1 )); row=" $i  $it "
    if [ "$UI_FANCY" -ne 1 ]; then printf '    %s\n' "$row"
    elif [ "$i" = "$def" ]; then ui_box_put "  $C_INV$row$C_OFF" $(( 2 + ${#row} )) "$UI_BW"
    else ui_box_put "  $row" $(( 2 + ${#row} )) "$UI_BW"; fi
  done
}
# ui_yn_row LABEL HINT [EXPLANATION]: the explanation dim, then "◆ Label   [Y/n]  " with the cursor left after the
#    hint. ui_yn_answer TEXT STYLE READ_A_NEWLINE then writes the answer on that row (one line up, after Enter).
ui_yn_row() {
  local l
  if [ -n "${3:-}" ]; then
    while IFS= read -r l; do printf '      %s%s%s\n' "$C_DIM" "$l" "$C_OFF"; done < <(ui_wrap $(( UI_W - 8 )) "$3")
  fi
  printf '  %s◆%s %s%s%s%s  ' "$C_ACC" "$C_OFF" "$(ui_pad "$1" 38)" "$C_KEY" "$2" "$C_OFF"
}
ui_yn_answer() {   # TEXT STYLE READ_A_NEWLINE(0|1)
  [ "$3" -eq 1 ] && printf '\e[1A'
  printf '\e[%dG\e[K%s%s%s\n' $(( 2 + 2 + 38 + 5 + 2 + 1 )) "$2" "$1" "$C_OFF"
}

# ── Boxes. ui_box_* draw a rounded box WIDTH wide (questions and cards); ui_table_* the double-lined review
#    table. Text longer than the box is wrapped inside it. Fancy output only.
UI_BOX_C=""
ui_box_top() {   # TITLE WIDTH COLOUR (an empty TITLE: a plain top edge)
  UI_BOX_C="${3:-$C_ACC}"
  local t=""; [ -z "$1" ] || t="─ $1 "
  printf '  %s╭%s%s╮%s\n' "$UI_BOX_C" "$t" "$(ui_rep '─' $(( $2 - 2 - ${#t} )))" "$C_OFF"
}
ui_box_put() {   # TEXT VISIBLE_LENGTH WIDTH: one line "│ text … │"
  local pad=$(( $3 - 4 - $2 )); [ "$pad" -ge 0 ] || pad=0
  printf '  %s│%s %s%*s %s│%s\n' "$UI_BOX_C" "$C_OFF" "$1" "$pad" '' "$UI_BOX_C" "$C_OFF"
}
ui_box_bottom() { printf '  %s╰%s╯%s\n' "$UI_BOX_C" "$(ui_rep '─' $(( $1 - 2 )))" "$C_OFF"; }
ui_card_line() { # TEXT [STYLE] [RIGHT]: a card line with a 2-space margin, wrapped; RIGHT goes to the right edge
  local l w=$(( UI_CW - 8 )) r="${3:-}"
  if [ -z "$1" ]; then ui_box_put "" 0 "$UI_CW"; return; fi
  [ -z "$r" ] || w=$(( w - ${#r} - 2 ))
  while IFS= read -r l; do
    if [ -n "$r" ]; then ui_box_put " ${2:-}$(ui_pad "$l" "$w")$C_OFF  $C_DIM$r$C_OFF " $(( 1 + w + 2 + ${#r} + 1 )) "$UI_CW"; r=""
    else ui_box_put " ${2:-}$l$C_OFF" $(( 1 + ${#l} )) "$UI_CW"; fi
  done < <(if [ "${#1}" -le "$w" ]; then printf '%s\n' "$1"; else ui_wrap_keep "$w" "$1"; fi)
}
# ui_link LABEL URL: a link printed outside any box, on a line of its own and never wrapped, so it can be
# copied whole however narrow the terminal is (plain output: the same two lines).
ui_link() {
  if [ "$UI_FANCY" -ne 1 ]; then printf '%s\n%s\n' "$1" "$2"; return; fi
  printf '  %s%s%s\n' "$C_BOLD" "$1" "$C_OFF"
  printf '  %s%s%s\n' "$C_KEY" "$2" "$C_OFF"
}
ui_table_top() { # TITLE
  printf '  %s╔%s╗%s\n' "$C_ACC" "$(ui_rep '═' $(( UI_CW - 2 )))" "$C_OFF"
  printf '  %s║%s  %s%s%s%s║%s\n' "$C_ACC" "$C_OFF" "$C_KEY" "$(ui_pad "$1" $(( UI_CW - 4 )))" "$C_OFF" "$C_ACC" "$C_OFF"
  printf '  %s╟%s┬%s╢%s\n' "$C_ACC" "$(ui_rep '─' 14)" "$(ui_rep '─' $(( UI_CW - 17 )))" "$C_OFF"
}
ui_table_row() { # KEY VALUE
  local l k="$1" vw=$(( UI_CW - 19 ))
  # Short values keep their own spacing; long ones are wrapped between words.
  while IFS= read -r l; do
    printf '  %s║%s %s %s│%s %s %s║%s\n' "$C_ACC" "$C_OFF" "$(ui_pad "$k" 12)" "$C_ACC" "$C_OFF" "$(ui_pad "$l" "$vw")" "$C_ACC" "$C_OFF"
    k=""
  done < <(if [ "${#2}" -le "$vw" ]; then printf '%s\n' "${2:--}"; else ui_wrap "$vw" "$2"; fi)
}
ui_table_bottom() { printf '  %s╚%s╧%s╝%s\n' "$C_ACC" "$(ui_rep '═' 14)" "$(ui_rep '═' $(( UI_CW - 17 )))" "$C_OFF"; }

# ui_failure_card ERROR CLEANUP LOG: the red card when an install stops (plain: the same facts as lines).
ui_failure_card() {
  local where="step ${UI_STEP}/${UI_STEPS} · ${UI_STEP_TITLE}" l
  local try="curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/scripts/diagnose.sh | bash"
  if [ "$UI_FANCY" -ne 1 ]; then
    printf '[fail] Install stopped at %s: %s\n' "$where" "$1"
    [ -z "$2" ] || printf '       %s\n' "$2"
    [ -z "$3" ] || printf '       Full log: %s\n' "$3"
    printf '       Try: %s\n' "$try"
    return 0
  fi
  printf '\n'
  ui_box_top "Install stopped at $where" "$UI_CW" "$C_ERR"
  ui_card_line "✗ $1" "$C_ERR"
  if [ -n "$UI_LAST_OUT" ] && [ -s "$UI_LAST_OUT" ]; then
    ui_card_line ""
    ui_card_line "last log lines" "$C_DIM"
    while IFS= read -r l; do
      [ "${#l}" -le $(( UI_CW - 10 )) ] || l="${l:0:$(( UI_CW - 11 ))}…"
      ui_box_put "   $C_DIM$l$C_OFF" $(( 3 + ${#l} )) "$UI_CW"
    done < <(tail -n 3 "$UI_LAST_OUT" | sed $'s/\e\\[[0-9;?]*[A-Za-z]//g; s/\r//g')
  fi
  ui_card_line ""
  [ -z "$2" ] || ui_card_line "$2"
  [ -z "$3" ] || ui_card_line "Full log: $3"
  ui_card_line "Try:  $try"
  ui_box_bottom "$UI_CW"
  printf '\n'
}
# ── hpx-ui end ────────────────────────────────────────────────────────────────

say()  { ui_sub "$*"; }
ok()   { ui_ok "$*"; }
warn() { ui_warn "$*"; }
note() { ui_note "$*"; }
# The message is kept for the failure card (on_exit). Coloured only when stderr is the terminal too.
DIE_MSG=""; NO_CARD=0
die()  {
  DIE_MSG="$*"
  if [ "$UI_FANCY" -eq 1 ] && [ -t 2 ]; then printf '  %s✗ %s%s\n' "$C_ERR" "$*" "$C_OFF" >&2; else printf '[fail] %s\n' "$*" >&2; fi
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: bootstrap.sh [options]

  --vmid N            Container ID           (default: asked at a terminal, offering one that fits your
                                             numbering or the next free; with -y or no terminal, that one)
  --hostname NAME     Container hostname     (default: hyperprox)
  --cores N           CPU cores              (default: 4)
  --memory MB         Memory in MB           (default: 8192)
  --disk GB           Disk in GB             (default: 100)
  --storage NAME      Storage for the rootfs (default: block storage with room, most free first)
  --bridge NAME       Network bridge         (default: vmbr0)
  --ip CIDR           Static address, e.g. 10.0.0.50/24 (default: asked at a terminal, offering one that
                      fits your numbering, or dhcp; with -y or no terminal, that one)
  --gateway IP        Gateway, required with --ip
  --password PASS     Container root password (default: generated)
  --skip-exporter     Answer no: do not watch node health (node_exporter)
  --skip-rapl         Answer no: do not monitor power (CPU energy counters)
  --skip-gpu-exporter Answer no: do not monitor GPUs
  --no-charts         Answer no: no Prometheus and Grafana
  --no-pve-metrics    Answer no: do not read Proxmox's own metrics
  --ai | --no-ai      Answer yes or no: a local AI assistant (Ollama)
  --igpu | --no-igpu  Answer yes or no: let containers use the nodes' built-in graphics
  --dry-run           Look and ask, then show what would be done; change nothing
  --keep-on-failure   If the install fails, keep what was created so you can look inside
  --dns IP[,IP]       The container's DNS servers, IPv4 or IPv6, at most three (default: the node's own,
                      unless the container cannot reach it, e.g. Tailscale's 100.100.100.100; then 1.1.1.1)
  --vpn KIND          Remote access: tailscale, wireguard or none (default: asked at a terminal; else none).
                      Tailscale goes in HyperProx's own container; WireGuard gets a small container of
                      its own. Either shows on HyperProx's VPN page after the first sign-in.
  --tailscale-authkey file:PATH  Join Tailscale unattended with the auth key in that file. Or set TS_AUTHKEY in
                      the environment. A key typed on the command line is refused. It is never printed.
  --wg-subnet CIDR    WireGuard tunnel network (default: a free one, e.g. 10.99.0.1/24)
  --wg-endpoint HOST  Public address or DNS name phones connect to (default: the VPN container's LAN address)
  --token-name NAME   The Proxmox API token to make for HyperProx (default: hyperprox; asked at a terminal when
                      that name is taken, since a token's secret is shown only once)
  --template-storage NAME  Where the container template is kept or downloaded (default: a storage that already
                      holds a Debian 13 template, else a file share that is not CephFS, most free space first)
  --ref REF           Install this release tag, branch or commit instead of main (e.g. v0.3.0);
                      HyperProx can update itself from there (Updates page)
  -y, --yes           Take every default and do not ask (or set HYPERPROX_YES=1)
USAGE
}

# ---------------------------------------------------------------------------
#  Questions. The words are the setup wizard's too (packages/hardware/index.js,
#  QUESTIONS); a test keeps the two the same.
# ---------------------------------------------------------------------------
Q_NODE_HEALTH='Do you want HyperProx to watch the health of each of your nodes (CPU, memory, disks)?'
W_NODE_HEALTH='Installs node_exporter on every node. It answers on port 9100.'
Q_POWER='Do you want HyperProx to monitor the power on each of your nodes?'
W_POWER='Lets HyperProx read the CPU energy counters. The trade-off: any local user on that node can then read energy use.'
Q_GPU='Do you want HyperProx to monitor your GPUs?'
W_GPU='Intel and NVIDIA GPUs get a small exporter (ports 8081, 9835); AMD GPUs are read by node_exporter. Drivers are never touched.'
Q_IGPU='Do you want containers on these nodes to be able to use their built-in graphics (for video transcoding)?'
W_IGPU='Opens the built-in Intel or AMD graphics to containers. The trade-off: any container on that node can then use its built-in graphics.'
Q_CHARTS='Do you want charts and dashboards (Prometheus and Grafana)?'
W_CHARTS='Runs Prometheus and Grafana on this machine. You reach them only through HyperProx.'
Q_PVE_METRICS="Do you want HyperProx to read Proxmox's own metrics?"
W_PVE_METRICS='Makes a read-only Proxmox token (PVEAuditor) for the metrics exporter.'
Q_DNS='Do you manage your domains at GoDaddy? HyperProx can manage their DNS for you.'
W_DNS='It needs a GoDaddy API key, kept in the vault. You can skip this and add it later.'
Q_AI='Do you want a local AI assistant? HyperProx can run a small one on this machine, or you can connect one later.'
W_AI='Runs Ollama here (3 CPUs, 4 GB) and downloads a small model (about 2 GB).'

# Where answers come from, set up by open_answers: fd 3. INTERACTIVE=1 when a person is there to ask
# (a terminal, or HPX_TTY); NO_TERMINAL=1 when there is nothing to read answers from at all.
INTERACTIVE=0; NO_TERMINAL=0
open_answers() {
  if [ -n "${HPX_TTY:-}" ]; then
    # Tests point this at a file of answers: it stands in for the keyboard.
    if exec 3< "$HPX_TTY"; then INTERACTIVE=1; else NO_TERMINAL=1; fi 2>/dev/null
  elif [ -f "${BASH_SOURCE[0]:-}" ] && [ ! -t 0 ]; then
    # Run from a file with answers piped in (`printf 'y\nn\n' | bash bootstrap.sh`): they come from stdin.
    # Opened once, as fd 3: stdin may be a socket, which cannot be opened again by name.
    exec 3<&0
  elif [ -t 0 ]; then
    exec 3<&0; INTERACTIVE=1
  elif { exec 3</dev/tty; } 2>/dev/null; then
    # Under `curl | bash` stdin is this script, so the keyboard is reached through /dev/tty.
    INTERACTIVE=1
  else
    NO_TERMINAL=1
  fi
  # No command after this reads stdin by accident: not the rest of a piped script, and not a keypress.
  exec 0</dev/null
}

# ask_yn VAR DEFAULT(yes|no) QUESTION WHAT [LABEL] [SKIPPED]: sets VAR to yes or no. A value given by a flag wins.
# On a terminal the question is a "◆ LABEL [Y/n]" row with WHAT dim below it; plain output keeps the whole
# question (the setup wizard's words). SKIPPED is shown for a no: where to add it later.
ask_yn() {
  local var="$1" def="$2" q="$3" what="$4" label="${5:-$3}" skipped="${6:-}" reply hint nl=1
  [ "$def" = yes ] && hint='[Y/n]' || hint='[y/N]'
  if [ -n "${!var}" ] || [ "$ASSUME_YES" -eq 1 ] || [ "$NO_TERMINAL" -eq 1 ]; then
    [ -n "${!var}" ] || printf -v "$var" '%s' "$def"
    if [ "$UI_FANCY" -eq 1 ]; then ui_yn_row "$label" "$hint"; yn_echo "${!var}" "$skipped" 0
    else printf '  %s %s\n' "$q" "${!var}"; fi
    return
  fi
  if [ "$UI_FANCY" -eq 1 ]; then ui_yn_row "$label" "$hint" "$what"
  else printf '\n  %s\n    %s\n  %s ' "$q" "$what" "$hint"; fi
  # Nothing more to read (EOF) is not consent: every question here asks to add something, so it means no.
  if ! IFS= read -r reply <&3 && [ -z "$reply" ]; then
    printf -v "$var" no
    if [ "$UI_FANCY" -eq 1 ]; then yn_echo "no (no answer)" "" 0; else printf '(no answer: no)'; [ -t 1 ] || echo; fi
    return
  fi
  case "$reply" in [yY]*) printf -v "$var" yes;; [nN]*) printf -v "$var" no;; *) printf -v "$var" '%s' "$def";; esac
  if [ "$UI_FANCY" -eq 1 ]; then yn_echo "${!var}" "$skipped" "$nl"; else [ -t 1 ] || echo; fi
}
yn_echo() {   # ANSWER SKIPPED READ_A_NEWLINE: the answer on its row, green for yes
  case "$1" in
    yes) ui_yn_answer yes "$C_OK" "$3";;
    no)  if [ -n "$2" ]; then ui_yn_answer "skip · $2" "$C_DIM" "$3"; else ui_yn_answer no "$C_DIM" "$3"; fi;;
    *)   ui_yn_answer "$1" "$C_DIM" "$3";;
  esac
}
# ask_secret VAR PROMPT: read without echo. Held in this shell's memory only.
ask_secret() {
  local var="$1" reply=""
  if [ "$UI_FANCY" -eq 1 ]; then printf '  %s› %s%s: ' "$C_KEY" "$2" "$C_OFF"; else printf '    %s: ' "$2"; fi
  IFS= read -rs reply <&3 || reply=""
  echo
  printf -v "$var" '%s' "$reply"
}
# ask_value VAR DEFAULT TITLE QUESTION WHAT CHECK LABEL [ON_EOF]: sets VAR to the answer; Enter takes DEFAULT.
# CHECK VALUE prints why a value cannot be used and fails; the question is then asked again. Nothing more to read
# (EOF) takes ON_EOF (else DEFAULT). On a terminal: a box with the question, then "› LABEL [default]: ".
ask_value() {
  local var="$1" def="$2" title="$3" q="$4" what="$5" chk="$6" label="$7" on_eof="${8-$2}" reply why
  [ "$UI_FANCY" -ne 1 ] || { ui_ask_box "$title" "$q" "$what"; ui_ask_end; }
  while :; do
    if [ "$UI_FANCY" -eq 1 ]; then ui_prompt "$label" "${def:-?}"; else ui_ask_box "$title" "$q" "$what"; ui_prompt "$label" "${def:-?}"; fi
    if ! IFS= read -r reply <&3 && [ -z "$reply" ]; then
      [ -n "$on_eof" ] || { echo; NO_CARD=1; die "No answer. Cancelled. Nothing was created."; }
      printf '(no answer: %s)\n' "$on_eof"; reply="$on_eof"
    else
      [ -t 1 ] || echo
      reply="${reply//[[:space:]]/}"; [ -n "$reply" ] || reply="$def"
      [ -n "$reply" ] || continue
    fi
    if why="$("$chk" "$reply")"; then printf -v "$var" '%s' "$reply"; return 0; fi
    if [ "$UI_FANCY" -eq 1 ]; then ui_bad "$why"; else warn "$why"; fi
    # The default was checked before it was offered; a default that went bad meanwhile cannot be kept.
    [ "$reply" != "$def" ] || die "$why"
  done
}
# ask_choice VAR DEFAULT TITLE QUESTION ON_EOF ITEM...: a numbered list, the default highlighted. VAR gets the
# number picked, or what was typed when it is not one of the numbers (the caller checks it). EOF gives ON_EOF.
ask_choice() {
  local var="$1" def="$2" title="$3" q="$4" on_eof="$5" reply; shift 5
  if [ "$UI_FANCY" -eq 1 ]; then
    ui_ask_box "$title" "$q"; ui_choices "$def" "$@"; ui_ask_end; ui_prompt Choice "$def"
  else
    ui_ask_box "$title" "$q"; ui_choices "$def" "$@"; ui_prompt Choice "$def"
  fi
  if ! IFS= read -r reply <&3 && [ -z "$reply" ]; then printf '(no answer: %s)\n' "$on_eof"; printf -v "$var" '%s' "$on_eof"; return; fi
  [ -t 1 ] || echo
  reply="${reply//[[:space:]]/}"; [ -n "$reply" ] || reply="$def"
  printf -v "$var" '%s' "$reply"
}

# ---------------------------------------------------------------------------
#  The container's ID and address, when asked for them
# ---------------------------------------------------------------------------
CLUSTER_RES=""
# id_in_use ID: where ID is used (a guest config anywhere in the cluster, or the cluster's own list), or fail.
id_in_use() {
  local f
  if f="$(guest_conf "$1")"; then echo "$f"; return 0; fi
  [ -n "$CLUSTER_RES" ] || CLUSTER_RES="$(pvesh get /cluster/resources --type vm --output-format json 2>/dev/null || true)"
  grep -qE "\"vmid\"[[:space:]]*:[[:space:]]*\"?$1\"?[,}]" <<< "$CLUSTER_RES" && { echo "the cluster's guest list"; return 0; }
  return 1
}
check_ctid() {
  local where
  [[ "$1" =~ ^[1-9][0-9]{2,8}$ ]] || { echo "$1 is not a container ID: it must be a number of 100 or more."; return 1; }
  if where="$(id_in_use "$1")"; then echo "ID $1 is already used ($where). Choose another."; return 1; fi
}
# check_net dhcp|CIDR: a static address must be well formed, in no guest's config, and answer nothing.
check_net() {
  [ "$1" = dhcp ] && return 0
  [[ "${1%%/*}" =~ $IPV4_RE ]] && [[ "$1" =~ /([1-9]|[12][0-9]|3[0-2])$ ]] \
    || { echo "$1 is not dhcp or an address with its prefix, e.g. 192.0.2.50/24."; return 1; }
  [ "$1" = "${CONV_IP:-}" ] && return 0      # checked already, when it was offered
  addr_in_configs "${1%%/*}" && { echo "Another guest's config already uses ${1%%/*}. Choose another."; return 1; }
  addr_answers "${1%%/*}" && { echo "Something already answers on ${1%%/*}. Choose another."; return 1; }
  return 0
}
check_gw() { [[ "$1" =~ $IPV4_RE ]] || { echo "$1 is not an IPv4 address."; return 1; }; }
# ask_network: DHCP or a static address (the numbering's, when the ID is the numbering's), then the gateway.
# Sets NET and GATEWAY. A number from the list, "dhcp" or an address with its prefix are all answers; nothing
# to read (EOF) is DHCP.
ask_network() {
  local -a items=() map=()
  local pick n why gw_def
  if [ -n "$CONV_IP" ] && [ "$CTID" = "$CONV_ID" ]; then
    items+=("Static  ${CONV_IP}  via ${CONV_GW}  (matches ID)"); map+=(conv)
  fi
  items+=("DHCP    (address shown at the end)" "Static, type my own"); map+=(dhcp own)
  while :; do
    ask_choice pick 1 "Network" "How should the container get its address?" dhcp "${items[@]}"
    case "$pick" in
      [1-9]) n="${map[$(( pick - 1 ))]:-}";;
      dhcp|DHCP) n=dhcp;;
      */*) if why="$(check_net "$pick")"; then NET="$pick"; n=typed; else bad_answer "$why"; continue; fi;;
      *) n="";;
    esac
    case "$n" in
      conv) NET="$CONV_IP"; GATEWAY="$CONV_GW"; return 0;;
      dhcp) NET=dhcp; GATEWAY=""; return 0;;
      own)  ask_value NET "" "Address" "Which static address should the container have?" \
              "With its prefix, e.g. 192.0.2.50/24. It is checked against every guest's config and with a ping." check_net Address dhcp
            if [ "$NET" = dhcp ]; then GATEWAY=""; return 0; fi
            break;;
      typed) break;;
      *) bad_answer "$pick is not one of the choices: type its number, dhcp, or an address with its prefix.";;
    esac
  done
  gw_def="$GATEWAY"; [ "$NET" = "${CONV_IP:-}" ] && gw_def="$CONV_GW"
  [ -n "$gw_def" ] || gw_def="$(ip route show default 2>/dev/null | awk '/via/ {for (i = 1; i < NF; i++) if ($i == "via") {print $(i+1); exit}}')"
  GW_NET="$NET"
  ask_value GATEWAY "$gw_def" "Gateway" "Which gateway should ${NET} use?" "Usually your router's address on that network." check_gw_in Gateway
}
GW_NET=""
check_gw_in() {   # a gateway inside the chosen network (GW_NET)
  check_gw "$1" || return 1
  cidr_overlaps "$GW_NET" "$1/32" || { echo "$1 is not inside ${GW_NET}; the gateway must be on that network."; return 1; }
}
bad_answer() { if [ "$UI_FANCY" -eq 1 ]; then ui_bad "$1"; else warn "$1"; fi; }

# ---------------------------------------------------------------------------
#  Remote access (VPN). Tailscale goes into HyperProx's own container; WireGuard gets a small container of
#  its own. Nothing is ever installed or changed on a Proxmox node. Either way HyperProx's VPN page takes it
#  over at the first sign-in: bootstrap writes data/setup/vpn-pending.json in the container (public facts only:
#  addresses, the WireGuard server's public key, container IDs), and the API adopts what it lists
#  (apps/api/src/lib/vpn/install-handoff.ts).
# ---------------------------------------------------------------------------
ip2int() { local IFS=. a b c d; read -r a b c d <<< "$1"; echo $(( (a << 24) + (b << 16) + (c << 8) + d )); }
# cidr_overlaps A/n B/m: the two networks share any address.
cidr_overlaps() {
  local n ai bi mask
  n="${1#*/}"; [ "${2#*/}" -lt "$n" ] && n="${2#*/}"
  ai="$(ip2int "${1%/*}")"; bi="$(ip2int "${2%/*}")"
  mask=$(( n == 0 ? 0 : (0xFFFFFFFF << (32 - n)) & 0xFFFFFFFF ))
  [ $(( ai & mask )) -eq $(( bi & mask )) ]
}
# The IPv4 networks in use here: this node's own, the cluster's nodes, every guest config's static addresses,
# every route this node has (connected and static), and Tailscale's 100.64.0.0/10. A WireGuard tunnel network must
# overlap none of them. This is checked here, as you answer; then by the installed copy's checkSpec and
# checkAllowedIps against these networks (wg_check_rules); and once more by the API when it adopts the server,
# against the cluster's own networks read from a node (corosync, Ceph): an overlap there leaves it pending, refused.
used_networks() {
  local n x
  { ip -4 -o addr show 2>/dev/null | awk '{print $4}'
    ip -4 route show 2>/dev/null | awk '$1 ~ /^[0-9.]+\/[0-9]+$/ {print $1} $1 ~ /^[0-9.]+$/ {print $1 "/32"}'
    for n in "${NODES[@]}"; do x="$(node_ip "$n")"; [[ "$x" =~ $IPV4_RE ]] && echo "$x/32"; done
    cat "$PVE_ETC"/nodes/*/lxc/*.conf "$PVE_ETC"/nodes/*/qemu-server/*.conf 2>/dev/null | grep -oE 'ip=[0-9.]+/[0-9]+' | cut -d= -f2
    echo 100.64.0.0/10
  } | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' | grep -v '^127\.' | sort -u || true
}
check_wg_subnet() {
  local net
  [[ "${1%%/*}" =~ $IPV4_RE ]] && [[ "$1" =~ /(1[6-9]|2[0-9]|30)$ ]] \
    || { echo "$1 is not a tunnel network with its prefix (/16 to /30), e.g. 10.99.0.1/24."; return 1; }
  local n="${1#*/}" host size
  size=$(( 1 << (32 - n) )); host=$(( $(ip2int "${1%/*}") % size ))
  [ "$host" -ne 0 ] && [ "$host" -ne $(( size - 1 )) ] \
    || { echo "${1%/*} is the network's $([ "$host" -eq 0 ] && echo network || echo broadcast) address; give the server a host address, e.g. 10.99.0.1/24."; return 1; }
  while IFS= read -r net; do
    cidr_overlaps "$1" "$net" && { echo "$1 overlaps $net, which is already in use here: LAN and cluster traffic must stay off the tunnel."; return 1; }
  done < <(used_networks)
  return 0
}
wg_subnet_default() {
  local c
  for c in 10.99.0.1/24 10.98.0.1/24 10.97.0.1/24 172.30.99.1/24 192.168.199.1/24; do
    check_wg_subnet "$c" >/dev/null && { echo "$c"; return 0; }
  done
}
check_endpoint() { [ "$1" = lan ] || [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || { echo "$1 is not an address or a DNS name."; return 1; }; }

# ask_vpn: sets VPN (tailscale | wireguard | none), and WG_SUBNET and WG_ENDPOINT for WireGuard. Not now is the
# default; with -y or no terminal it is not asked, and only an auth key or --vpn turns it on.
ask_vpn() {
  local pick why
  [ -n "$VPN" ] || [ -z "$TS_KEY" ] || VPN=tailscale
  if [ -z "$VPN" ]; then
    if [ "$ASK_PLACEMENT" -eq 1 ]; then
      while :; do
        ask_choice pick 3 "VPN" "How do you want to reach HyperProx when you are away from home?" 3 \
          "Tailscale   sign in with a link, nothing to open on router" \
          "WireGuard   own small VPN container, forward UDP ${WG_PORT}" \
          "Not now     add it later on the VPN page"
        case "${pick,,}" in
          1|tailscale) VPN=tailscale; break;;
          2|wireguard) VPN=wireguard; break;;
          3|none|no|not*) VPN=none; break;;
          *) bad_answer "$pick is not one of the choices: type 1, 2 or 3.";;
        esac
      done
    else
      VPN=none
    fi
  fi
  if [ "$VPN" = tailscale ] && [ -z "$TS_KEY" ] && [ "$INTERACTIVE" -ne 1 ]; then
    warn "Tailscale signs in through a link, and there is no terminal to show it on: skipped. Give an auth key (TS_AUTHKEY), or add it later on the VPN page."
    VPN=none
  fi
  [ "$VPN" = wireguard ] || return 0
  if [ ! -d "${HPX_SYSFS:-/sys}/module/wireguard" ]; then
    warn "The WireGuard kernel module is not loaded on ${THIS_NODE}, and HyperProx never changes a node to load it: WireGuard skipped."
    note "To use it: load it there (modprobe wireguard, and add wireguard to /etc/modules), then add it on the VPN page; or choose Tailscale."
    VPN=none; return 0
  fi
  [ -n "$WG_SUBNET" ] || WG_SUBNET="$(wg_subnet_default)"
  [ -n "$WG_SUBNET" ] || die "No free tunnel network was found for WireGuard; pass --wg-subnet."
  if [ "$ASK_PLACEMENT" -eq 1 ] && [ "$WG_SUBNET_GIVEN" -eq 0 ]; then
    ask_value WG_SUBNET "$WG_SUBNET" "WireGuard tunnel" "Which network should the tunnel use?" \
      "Phones and laptops get addresses in it. It must not overlap your LAN, the cluster or Tailscale; the one offered does not." check_wg_subnet Tunnel
    ask_value WG_ENDPOINT "${WG_ENDPOINT:-lan}" "WireGuard address" "Which address do phones connect to from outside: your public IP, or a DNS name for it?" \
      "Enter keeps the VPN container's LAN address for now (it works at home); change it on the VPN page." check_endpoint Address
  fi
  why="$(check_wg_subnet "$WG_SUBNET")" || die "$why"
  why="$(check_endpoint "${WG_ENDPOINT:-lan}")" || die "$why"
}
# ── Tailscale, in HyperProx's own container. It has /dev/net/tun (the lxc lines written after pct create).
#    --accept-dns=false: the container keeps its own resolver, so the MagicDNS checks (choose_dns here,
#    resolv_uses_magicdns in install.sh) see what they saw before. An auth key goes in through a root-only
#    file in the container that is removed straight after: never on a command line, never in a log.
ts_install() {   # Tailscale's own install script, downloaded first (a failed download is a failure, not an empty script)
  pct exec "$CTID" -- bash -c 'set -eo pipefail
    command -v tailscale >/dev/null 2>&1 && exit 0
    curl -fsSL https://tailscale.com/install.sh -o /tmp/hpx-tailscale-install.sh
    sh /tmp/hpx-tailscale-install.sh
    rm -f /tmp/hpx-tailscale-install.sh
    command -v tailscale >/dev/null 2>&1'
}
ts_up_key() {
  printf '%s' "$TS_KEY" | pct exec "$CTID" -- bash -c 'umask 077; cat > /run/hpx-ts.key'
  pct exec "$CTID" -- bash -c "tailscale up --auth-key=file:/run/hpx-ts.key --hostname='${HOSTNAME%%.*}' --accept-dns=false; rc=\$?; rm -f /run/hpx-ts.key; exit \$rc"
}
ts_wait_ip() {   # until the container has a tailnet address (someone signed in), at most 15 minutes
  local i
  for i in $(seq 1 450); do
    pct exec "$CTID" -- tailscale ip -4 2>/dev/null | grep -qE '^[0-9.]+$' && return 0
    sleep 2
  done
  return 1
}
# setup_tailscale: sets TS_IP, TS_DNS and TS_URL. Never fatal: a failure says where to finish it.
setup_tailscale() {
  local out url st t0
  TS_IP=""; TS_DNS=""; TS_URL=""
  # Nothing here may stop the install: every failure warns, says where to finish it, and returns.
  ui_try ui_run "Installing Tailscale in container $CTID" ts_install
  [ "$UI_RC" -eq 0 ] || { warn "Tailscale could not be installed; add it later on the VPN page."; return 0; }
  if [ -n "$TS_KEY" ]; then
    ui_try ui_run "Joining your tailnet with the auth key" ts_up_key
    [ "$UI_RC" -eq 0 ] || { warn "Tailscale did not accept the auth key; add it later on the VPN page."; return 0; }
  else
    out="$(mktemp)"; TMP_PATHS+=("$out")
    pct exec "$CTID" -- tailscale up --hostname="${HOSTNAME%%.*}" --accept-dns=false --qr > "$out" 2>&1 &
    TS_PID=$!
    url=""
    for _ in $(seq 1 60); do
      url="$(grep -oE 'https://login\.tailscale\.com/[A-Za-z0-9/_-]+' "$out" | head -1 || true)"
      [ -n "$url" ] && break
      kill -0 "$TS_PID" 2>/dev/null || break
      sleep 1
    done
    if [ -z "$url" ] && ! pct exec "$CTID" -- tailscale ip -4 >/dev/null 2>&1; then
      # It stopped (or hung) without a sign-in link and is not on a tailnet: say why, and go on without waiting.
      ui_kill_tree "$TS_PID"; TS_PID=""
      warn "Tailscale did not give a sign-in link; add it later on the VPN page. Its last words:"
      tail -n 5 "$out" | sed $'s/\e\\[[0-9;?]*[A-Za-z]//g; s/^/      /' || true
      return 0
    fi
    if [ -n "$url" ]; then
      sleep 1   # the QR code follows the link
      if [ "$UI_FANCY" -eq 1 ]; then printf '    %sOpen%s  %s%s%s   or scan:\n' "$C_BOLD" "$C_OFF" "$C_ACC" "$url" "$C_OFF"
      else printf '       Open %s or scan:\n' "$url"; fi
      grep -E '[█▀▄]' "$out" | sed 's/^/      /' || true
    fi
    t0=$SECONDS
    ui_try ui_wait "Waiting for you to sign in to Tailscale…" ts_wait_ip
    if [ "$UI_RC" -ne 0 ]; then
      ui_kill_tree "$TS_PID"; TS_PID=""
      warn "Nobody signed in to Tailscale within 15 minutes; finish it later on the VPN page."
      return 0
    fi
    ui_kill_tree "$TS_PID" 2>/dev/null; TS_PID=""
  fi
  TS_IP="$(pct exec "$CTID" -- tailscale ip -4 2>/dev/null | head -1 || true)"
  st="$(pct exec "$CTID" -- tailscale status --json --peers=false 2>/dev/null || true)"
  TS_DNS="$(grep -m1 -oE '"DNSName"[[:space:]]*:[[:space:]]*"[^"]+"' <<< "$st" | sed -E 's/.*"([^"]+)"$/\1/; s/\.$//' || true)"
  [[ "$TS_IP" =~ $IPV4_RE ]] || { warn "Tailscale did not report an address; check it later on the VPN page."; TS_IP=""; return 0; }
  [[ "$TS_DNS" =~ ^[A-Za-z0-9.-]+$ ]] || TS_DNS=""
  TS_URL="https://${TS_DNS:-$TS_IP}/"
  ui_ok "On your tailnet as ${TS_DNS:-${HOSTNAME%%.*}} · ${TS_IP}" "$(ui_secs $(( SECONDS - ${t0:-$SECONDS} )))"
}

# ── WireGuard, in a small unprivileged container of its own. Created here (with this run's mark, so the undo
#    removes it); set up after HyperProx is installed, by the Catalogue recipe's own script
#    (WIREGUARD_SERVER_RECIPE in apps/api/src/lib/vpn/wireguard/recipe.ts, read from the installed copy). It makes
#    the server key inside that container (only the public half is printed), brings hp-wg0 up, and masquerades the
#    tunnel network out of the container's LAN interface so phones reach HyperProx. No client key is made here:
#    phones are added on the VPN page once HyperProx has adopted the server from the marker.
create_wg_ct() {
  pct create "$WG_CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
    --arch "$ARCH" --ostype debian --description "$RUN_MARK" --hostname "$WG_HOSTNAME" \
    --cores 1 --memory 256 --swap 256 --rootfs "${STORAGE}:2" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" ${DNS:+--nameserver "${DNS//,/ }"} \
    --unprivileged 1 --features nesting=1 --onboot 1 --start 0
}
pick_wg_ctid() {   # the next free ID after HyperProx's own
  local id n
  id="$(pvesh get /cluster/nextid 2>/dev/null || true)"
  [[ "$id" =~ ^[0-9]+$ ]] || return 1
  for n in $(seq 0 50); do
    [ "$((id + n))" != "$CTID" ] || continue
    id_in_use "$((id + n))" >/dev/null && continue
    [ "$(pvesh get /cluster/nextid --vmid "$((id + n))" 2>/dev/null)" = "$((id + n))" ] || continue
    echo "$((id + n))"; return 0
  done
  return 1
}
wait_dns_in() {   # CTID: until the container can resolve names, at most two minutes
  for _ in $(seq 1 60); do
    pct exec "$1" -- getent hosts deb.debian.org >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
# The tunnel network checked by the API's own rules (checkSpec, checkAllowedIps), run from the installed copy,
# against this node's networks (used_networks). The cluster-wide check happens at adoption (see above).
wg_check_rules() {
  local nets
  nets="$(used_networks | tr '\n' ' ')"
  # shellcheck disable=SC2086
  pct exec "$CTID" -- node -e '
    const c = require("/opt/hyperprox/apps/api/dist/lib/vpn/wireguard/config.js")
    const [addr, ...nets] = process.argv.slice(1).filter(a => a !== "--")
    const why = c.checkSpec({ iface: "hp-wg0", address: addr, listenPort: Number(process.env.WG_PORT || 51820), peers: [] })
      || c.checkAllowedIps([addr], { node: false, clusterNets: nets })
    if (why) { console.log(why); process.exit(1) }' -- "$WG_SUBNET" $nets
}
wg_recipe() {
  local script
  script="$(pct exec "$CTID" -- node -e 'process.stdout.write(require("/opt/hyperprox/apps/api/dist/lib/vpn/wireguard/recipe.js").WIREGUARD_SERVER_RECIPE.install.script)')" || return 1
  [ -n "$script" ] || return 1
  printf '%s\n' "$script" | pct exec "$WG_CTID" -- env WG_ADDRESS="$WG_SUBNET" WG_PORT="$WG_PORT" bash -s
}
# setup_wireguard: sets WG_PUB, WG_IP, WG_EP and WG_LINE. A failure removes the WireGuard container again
# (it is this run's) and says where to add it later; HyperProx itself stays.
setup_wireguard() {
  local out why
  out="$(mktemp)"; TMP_PATHS+=("$out")
  if ! why="$(wg_check_rules 2>&1)"; then
    warn "HyperProx's WireGuard rules refuse ${WG_SUBNET}: ${why}"; wg_give_up; return 0
  fi
  UI_OUT="$out" ui_try ui_run "Setting up WireGuard in container $WG_CTID (recipe)" wg_recipe
  if [ "$UI_RC" -ne 0 ]; then wg_give_up; return 0; fi
  WG_PUB="$(sed -n 's/^HP_WG_PUB=//p' "$out" | tail -1)"
  [[ "$WG_PUB" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] || { warn "The WireGuard container did not report its public key."; wg_give_up; return 0; }
  WG_IP="$(first_ipv4 "$WG_CTID")"
  if [ "${WG_ENDPOINT:-lan}" = lan ]; then WG_EP="${WG_IP}:${WG_PORT}"; else WG_EP="${WG_ENDPOINT}:${WG_PORT}"; fi
  WG_LINE="forward UDP ${WG_PORT} to ${WG_IP} on your router; add your phone on the VPN page"
  ui_ok "WireGuard server up in container $WG_CTID · tunnel $WG_SUBNET"
  note "On your router, forward UDP ${WG_PORT} to ${WG_IP}. After your first sign-in, add your phone on the VPN page: it shows a QR code."
  note "The phone then reaches HyperProx (and, if you tick it there, your whole home network) through that container."
}
first_ipv4() {   # CTID: the container's first IPv4 address (hostname -I can list an IPv6 one first)
  pct exec "$1" -- hostname -I 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true
}
wg_give_up() {
  warn "WireGuard was not set up; add it later on the VPN page."
  if [ "$WG_CT_TRY" -eq 1 ] && [ -n "$WG_CTID" ]; then
    pct stop "$WG_CTID" >/dev/null 2>&1 || true
    pct destroy "$WG_CTID" --purge >/dev/null 2>&1 && note "Removed its container $WG_CTID again."
    WG_CT_TRY=0
  fi
  VPN=none
}
# vpn_marker FILE: what HyperProx's VPN page takes over at the first sign-in. Public facts only.
vpn_marker() {
  local e=()
  [ -n "$TS_IP" ] && e+=("$(printf '{"kind":"tailscale","ctid":%s,"machineId":"lxc-%s","hostname":"%s","ip":"%s","dnsName":"%s"}' \
    "$CTID" "$CTID" "${HOSTNAME%%.*}" "$TS_IP" "$TS_DNS")")
  [ -n "$WG_PUB" ] && e+=("$(printf '{"kind":"wireguard","ctid":%s,"machineId":"lxc-%s","iface":"hp-wg0","address":"%s","listenPort":%s,"endpoint":"%s","publicKey":"%s"}' \
    "$WG_CTID" "$WG_CTID" "$WG_SUBNET" "$WG_PORT" "$WG_EP" "$WG_PUB")")
  [ "${#e[@]}" -gt 0 ] || return 1
  local IFS=,
  printf '{"version":1,"source":"bootstrap","entries":[%s]}\n' "${e[*]}" > "$1"
}

check_token_name_shape() { [[ "$1" =~ ^[A-Za-z][A-Za-z0-9._-]{1,31}$ ]]; }
check_token_name() {   # a new token's name: well formed and free, or the taken one kept on purpose
  check_token_name_shape "$1" || { echo "$1 is not a token name: letters, digits, '.', '_' or '-', starting with a letter."; return 1; }
  [ "$1" = "$TOKEN_TAKEN" ] && return 0
  token_exists "$1" && { echo "A token named $1 exists too. Choose another name."; return 1; }
  return 0
}
TOKEN_TAKEN=""
# ask_token_name: when the token's name is taken (its secret was shown once and is gone), offer a free one.
ask_token_name() {
  token_exists "$TOKEN_NAME" || return 0
  TOKEN_TAKEN="$TOKEN_NAME"
  [ "$ASK_PLACEMENT" -eq 1 ] && [ "$TOKEN_NAME_GIVEN" -eq 0 ] || return 0
  local n free="${TOKEN_NAME}-2"
  for n in $(seq 2 20); do token_exists "${TOKEN_NAME}-$n" || { free="${TOKEN_NAME}-$n"; break; }; done
  ask_value TOKEN_NAME "$free" "Proxmox API token" "A token named ${TOKEN_TAKEN} exists already; its secret was shown only once, so HyperProx cannot use it. Which name should the new one get?" \
    "Enter makes ${free}. Type ${TOKEN_TAKEN} to leave it as it is; the setup page then asks for its secret." check_token_name Name "$TOKEN_TAKEN"
}
# ENV_SET_KV: set_kv KEY VALUE for the container's .env ($f), as a shell function to run in it. The new file is
# written root-only beside the old one and moved over it, so .env is never half-written or briefly readable.
# shellcheck disable=SC2016  # expanded in the container, not here
ENV_SET_KV='set_kv() { local t; t="$(umask 077; mktemp "$f.XXXXXX")" || return 1
  K="$1" V="$2" awk '"'"'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; d = 0 } !d && index($0, k "=") == 1 { print k "=" v; d = 1; next } { print } END { if (!d) print k "=" v }'"'"' "$f" > "$t" \
    && chmod 600 "$t" && mv -f "$t" "$f" || { rm -f "$t"; return 1; }; }'
# save_password FILE: the root password into FILE, mode 600, owned by root; never through a link.
save_password() {
  [ ! -L "$1" ] || { warn "$1 is a symbolic link; the root password is not written there."; return 1; }
  install -m 600 -o root -g root /dev/null "$1" 2>/dev/null || return 1
  [ ! -L "$1" ] || return 1
  printf 'HyperProx container %s (%s)\nroot password: %s\n' "$CTID" "$HOSTNAME" "$PASSWORD" > "$1" || return 1
  chmod 600 "$1"
}
vpn_words() {   # the plan's VPN line
  case "$VPN" in
    tailscale) if [ -n "$TS_KEY" ]; then echo "Tailscale in this container, joined with the auth key given"
               else echo "Tailscale in this container (sign-in link shown during install)"; fi;;
    wireguard) echo "WireGuard in a small container of its own (next free ID), tunnel ${WG_SUBNET}, UDP ${WG_PORT}";;
    *)         echo "not now (add it later on the VPN page)";;
  esac
}

# ---------------------------------------------------------------------------
#  Undo: what this run created is removed again if it does not finish.
#  Every *_TRY flag is set just before the command that creates the thing, and
#  each was checked to be absent first, so nothing that was already there is
#  ever removed.
# ---------------------------------------------------------------------------
FINISHED=0; INTERRUPTED=0
TMP_PATHS=()
CT_TRY=0
# This run's mark, put in the container's description: the rollback removes a container only if it carries it.
RUN_MARK="hyperprox-install-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
TPL_TRY=0
TOKEN_TRY=0; TOKEN_EXISTED=0; XTOKEN_TRY=0; XTOKEN_EXISTED=0
NODE_UNDO=(); NODE_LEFT=()

guest_conf() {   # the config file of guest ID anywhere in the cluster, if there is one
  local f
  for f in "$PVE_ETC"/nodes/*/lxc/"$1".conf "$PVE_ETC"/nodes/*/qemu-server/"$1".conf "$PVE_ETC"/lxc/"$1".conf; do
    [ -e "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}
# Read whole before searching: with pipefail, `cmd | grep -q` fails when grep stops reading early.
token_exists() { grep -q "\"$1\"" <<< "$(pveum user token list root@pam --output-format json 2>/dev/null)"; }
# The ACL lines that name one token, as "path<TAB>role", from `pveum acl list --output-format json` on stdin.
token_acl_lines() {  # token_acl_lines <user!token>
  sed 's/},{/}\n{/g' | grep -F "\"ugid\":\"$1\"" | while IFS= read -r l; do
    printf '%s\t%s\n' "$(grep -oP '"path":"\K[^"]*' <<< "$l")" "$(grep -oP '"roleid":"\K[^"]*' <<< "$l")"
  done
}
# Delete a root@pam token, its ACL lines first: Proxmox keeps a deleted token's lines in user.cfg (and logs
# "ignore invalid acl token" from then on), and a later token of the same name would inherit them.
remove_token() {  # remove_token <name>
  local id="root@pam!$1" p r
  while IFS=$'\t' read -r p r; do
    [ -n "$p" ] && [ -n "$r" ] && pveum acl delete "$p" --tokens "$id" --roles "$r" >/dev/null 2>&1
  done < <(pveum acl list --output-format json 2>/dev/null | token_acl_lines "$id")
  pveum user token remove root@pam "$1" >/dev/null 2>&1
}
# The path of a template on its storage, or nothing if the storage cannot say.
template_path() { pvesm path "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" 2>/dev/null || true; }

rollback() {
  local p node step f out tp
  # Node steps first, newest first; then the container, tokens and template.
  for (( i=${#NODE_UNDO[@]}-1; i>=0; i-- )); do
    p="${NODE_UNDO[$i]}"; node="${p%%$'\t'*}"; step="${p#*$'\t'}"
    out="$(step_text "$step" | node_run "$node" 2>/dev/null || true)"
    if grep -q $'^HPX-RESULT\t\(done\|already\)' <<< "$out"; then
      ok "$node: undid $(step_label "${step%-undo}")"
    else warn "$node: could not undo $(step_label "${step%-undo}"); see Settings → Setup checklist"; fi
  done
  if [ "$WG_CT_TRY" -eq 1 ] && [ -n "$WG_CTID" ] && f="$(guest_conf "$WG_CTID")" \
      && grep -qF "$RUN_MARK" "$f" && grep -qxF "hostname: ${WG_HOSTNAME}" "$f"; then
    pct stop "$WG_CTID" >/dev/null 2>&1 || true
    if pct destroy "$WG_CTID" --purge >/dev/null 2>&1; then ok "Removed the WireGuard container $WG_CTID"
    else warn "Could not remove container $WG_CTID; remove it with: pct destroy $WG_CTID --purge"; fi
  fi
  if [ "$CT_TRY" -eq 1 ]; then
    # Only a container that carries this run's mark is ours. pct create removes its own volumes when it fails.
    if f="$(guest_conf "$CTID")"; then
      if grep -qF "$RUN_MARK" "$f" && grep -qxF "hostname: ${HOSTNAME}" "$f"; then
        pct stop "$CTID" >/dev/null 2>&1 || true
        if pct destroy "$CTID" --purge >/dev/null 2>&1; then ok "Removed container $CTID"
        else warn "Could not remove container $CTID; remove it with: pct destroy $CTID --purge"; fi
      elif grep -qxF "lock: create" "$f"; then
        # A create cut off before it wrote anything but its lock: not provably ours, so it is not removed here.
        warn "Container $CTID was left half-made (locked while being created). If nobody else is creating it, remove it with:"
        note "pct unlock $CTID && pct destroy $CTID --purge"
      fi
    fi
  fi
  if [ "$XTOKEN_TRY" -eq 1 ] && [ "$XTOKEN_EXISTED" -eq 0 ] && token_exists "$EXPORTER_TOKEN"; then
    remove_token "$EXPORTER_TOKEN" && ok "Removed token root@pam!$EXPORTER_TOKEN" || warn "Could not remove token root@pam!$EXPORTER_TOKEN"
  fi
  if [ "$TOKEN_TRY" -eq 1 ] && [ "$TOKEN_EXISTED" -eq 0 ] && token_exists "$TOKEN_NAME"; then
    remove_token "$TOKEN_NAME" && ok "Removed token root@pam!$TOKEN_NAME" || warn "Could not remove token root@pam!$TOKEN_NAME"
  fi
  tp=""; [ "$TPL_TRY" -eq 1 ] && tp="$(template_path)"
  if [ -n "$tp" ] && [ -e "$tp" ]; then
    pveam remove "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" >/dev/null 2>&1 \
      && ok "Removed the template this run downloaded" || warn "Could not remove ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
  fi
  for p in "${NODE_LEFT[@]}"; do
    node="${p%%$'\t'*}"; step="${p#*$'\t'}"
    if [ "$step" = rapl ]; then
      note "Left in place on $node: $(step_label "$step") (a rule that lets local users read energy use; to undo it, delete /etc/udev/rules.d/99-hyperprox-rapl.rules there)"
    else
      note "Left in place on $node: $(step_label "$step") (monitoring software; it does no harm, and a re-run uses it)"
    fi
  done
}
made_anything() {
  [ "$CT_TRY" -eq 1 ] || [ "$WG_CT_TRY" -eq 1 ] || [ "$TPL_TRY" -eq 1 ] || [ "$TOKEN_TRY" -eq 1 ] || [ "$XTOKEN_TRY" -eq 1 ] \
    || [ "${#NODE_UNDO[@]}" -gt 0 ] || [ "${#NODE_LEFT[@]}" -gt 0 ]
}
on_exit() {
  local rc=$? p log
  trap '' INT TERM HUP     # a second Ctrl+C must not stop the clean-up half-way
  set +eu
  ui_abort                 # a command still running under a spinner, and the spinner itself
  [ -z "$TS_PID" ] || ui_kill_tree "$TS_PID"
  local outcome=""
  if [ "$FINISHED" -ne 1 ]; then
    echo
    if ! made_anything; then
      [ "$INTERRUPTED" -eq 1 ] && note "Stopped. Nothing was created."
      outcome="Nothing was created."
    elif [ "$KEEP_ON_FAILURE" -eq 1 ] && [ "$INTERRUPTED" -ne 1 ]; then
      warn "Stopped part-way. Kept what was made, as asked (--keep-on-failure): container ${CTID}."
      outcome="Kept what was made, as asked (--keep-on-failure): container ${CTID}. Look inside with: pct enter ${CTID}"
    else
      say "$([ "$INTERRUPTED" -eq 1 ] && echo Interrupted || echo Stopped) — undoing what this run created"
      rollback
      outcome="Cleaned up: what this run created was removed again (listed above). Nothing else was changed."
    fi
    if [ "$rc" -ne 0 ] && [ "$NO_CARD" -ne 1 ] && { [ -n "$DIE_MSG" ] || made_anything; }; then
      # The spinner commands' output outlives this run only when something went wrong after work began.
      log=""
      if made_anything && [ -s "$UI_LOG" ]; then
        log="${TMPDIR:-/tmp}/hyperprox-bootstrap-$(date +%Y%m%d-%H%M%S).log"
        (umask 077; sed $'s/\e\\[[0-9;?]*[A-Za-z]//g' "$UI_LOG" > "$log") 2>/dev/null || log=""
      fi
      ui_failure_card "${DIE_MSG:-$([ "$INTERRUPTED" -eq 1 ] && echo 'Interrupted' || echo "Stopped (exit $rc)")}" "$outcome" "$log"
    fi
  fi
  for p in "${TMP_PATHS[@]}"; do [ -n "$p" ] && rm -rf -- "$p"; done
  exit "$rc"
}

# ---------------------------------------------------------------------------
#  The container's DNS
#
#  Proxmox gives a new container the node's own /etc/resolv.conf. That fails when the node's resolver is one
#  only the node can reach: Tailscale's MagicDNS (100.100.100.100, fd7a:115c:a1e0::53), a local stub
#  (127.0.0.53 from systemd-resolved, ::1), or anything else in Tailscale's 100.64.0.0/10. In that order of
#  preference the container gets: --dns; the DNS saved in an existing HyperProx's Naming & addresses, when
#  HPX_API_URL and HPX_API_TOKEN point at one; 1.1.1.1 when the node's resolver is unusable; else the node's.
# ---------------------------------------------------------------------------
IPV4_RE='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'
is_ipv4() { [[ "$1" =~ $IPV4_RE ]]; }
is_ipv6() {   # hex groups and colons, at most one "::", 2..8 groups; no zone, no embedded IPv4
  local a="$1" groups
  [[ "$a" =~ ^[0-9A-Fa-f:]{2,39}$ && "$a" == *:* ]] || return 1
  [[ "$a" != *:::* ]] || return 1
  [ "$(grep -o '::' <<< "$a" | wc -l)" -le 1 ] || return 1
  [[ "$a" =~ (^|:)[0-9A-Fa-f]{5,} ]] && return 1
  groups="$(tr ':' '\n' <<< "$a" | grep -c .)"
  if [[ "$a" == *::* ]]; then [ "$groups" -le 7 ]; else [ "$groups" -eq 8 ] && [[ "$a" != :* && "$a" != *: ]]; fi
}
dns_list_ok() {   # "ip[,ip[,ip]]"
  local a n=0 IFS=,
  [ -n "$1" ] && [[ "$1" != *,,* && "$1" != ,* && "$1" != *, ]] || return 1
  for a in $1; do n=$((n + 1)); is_ipv4 "$a" || is_ipv6 "$a" || return 1; done
  [ "$n" -ge 1 ] && [ "$n" -le 3 ]
}
# Why a resolver is unusable from a container ("tailscale", "stub", "cgnat"), or nothing.
dns_unusable() {
  local a="${1,,}" o2
  case "$a" in
    100.100.100.100|fd7a:115c:a1e0:*) echo tailscale; return;;
    127.*|::1) echo stub; return;;
  esac
  if [[ "$a" =~ ^100\.([0-9]{1,3})\. ]]; then o2="${BASH_REMATCH[1]}"; [ "$o2" -ge 64 ] && [ "$o2" -le 127 ] && echo cgnat; fi
  return 0
}
# The DNS servers in an existing HyperProx's Naming & addresses, comma separated, or nothing. Over https only,
# with the certificate checked: against the system's CAs, or, for HyperProx's own self-signed certificate, against
# HPX_API_PINNEDPUBKEY (curl's sha256//<base64> form, e.g. from `openssl x509 -pubkey ... | openssl dgst -sha256 -binary | base64`).
# HPX_API_TOKEN should be a read-only (viewer) API token: this only reads the naming settings.
naming_dns() {
  [ -n "${HPX_API_URL:-}" ] && [ -n "${HPX_API_TOKEN:-}" ] || return 0
  [[ "$HPX_API_URL" =~ ^https://[A-Za-z0-9.:-]+(/[A-Za-z0-9._/-]*)?$ ]] || { warn "HPX_API_URL must be an https address; its Naming & addresses DNS is not used." >&2; return 0; }
  local body list tls=()
  if [ -n "${HPX_API_PINNEDPUBKEY:-}" ]; then
    [[ "$HPX_API_PINNEDPUBKEY" =~ ^sha256//[A-Za-z0-9+/]{43}=$ ]] || { warn "HPX_API_PINNEDPUBKEY must be sha256//<base64>; its Naming & addresses DNS is not used." >&2; return 0; }
    # The pin stands in for the CA check (a self-signed certificate), and curl still refuses any other key.
    tls=(--insecure --pinnedpubkey "$HPX_API_PINNEDPUBKEY")
  fi
  # The token goes to curl on stdin, never on a command line.
  body="$(printf 'Authorization: Bearer %s\n' "$HPX_API_TOKEN" \
    | curl -fsS --proto =https "${tls[@]}" --max-time 8 -H @- "${HPX_API_URL%/}/api/catalogue/wizard/naming" 2>/dev/null)" || return 0
  list="$(tr -d '\n' <<< "$body" | sed -n 's/.*"dns"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr -d '" \t')"
  [ -n "$list" ] && dns_list_ok "$list" && echo "$list"
}
choose_dns() {   # sets DNS, DNS_FROM, DNS_NOTE
  [ -n "$DNS_FROM" ] && return
  local saved ns why=""
  saved="$(naming_dns)"
  if [ -n "$saved" ]; then DNS="$saved"; DNS_FROM="Naming & addresses"; return; fi
  for ns in $(awk '$1 == "nameserver" {print $2}' "${HPX_RESOLV_CONF:-/etc/resolv.conf}" 2>/dev/null); do
    why="$(dns_unusable "$ns")"; [ -n "$why" ] && break
  done
  [ -n "$why" ] || return 0
  DNS="1.1.1.1"; DNS_FROM="auto"
  case "$why" in
    tailscale) DNS_NOTE="Your node uses Tailscale DNS; the container will use 1.1.1.1 (change with --dns).";;
    stub)      DNS_NOTE="Your node uses a local DNS stub ($ns), which a container cannot reach; the container will use 1.1.1.1 (change with --dns).";;
    cgnat)     DNS_NOTE="Your node's DNS server $ns is in 100.64.0.0/10 (Tailscale's range), which a container usually cannot reach; the container will use 1.1.1.1 (change with --dns).";;
  esac
}

# ---------------------------------------------------------------------------
#  Node scripts and running them
# ---------------------------------------------------------------------------
RAW_BASE="${HPX_RAW_BASE:-https://raw.githubusercontent.com/hyperprox/alpha/main}"
NODE_DIR=""
node_scripts_dir() {   # sets NODE_DIR
  local here="" f
  [ -f "${BASH_SOURCE[0]:-}" ] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -n "$here" ] && [ -f "$here/packages/hardware/node/probe.sh" ]; then NODE_DIR="$here/packages/hardware/node"; return; fi
  NODE_DIR="$(mktemp -d)"; TMP_PATHS+=("$NODE_DIR")
  for f in probe common node-exporter rapl intel-gpu-exporter nvidia-gpu-exporter amd-gpu-metrics amd-gpu-metrics-undo igpu-access igpu-access-undo; do
    curl -fsSL "$RAW_BASE/packages/hardware/node/$f.sh" -o "$NODE_DIR/$f.sh" || die "Could not download the node scripts from $RAW_BASE"
  done
}

# node_run NODE: run the script on stdin there. This node directly, the others over the cluster's SSH trust,
# by the address the cluster has for them (node names do not always resolve) and checked against the key
# the cluster recorded for that node name.
node_run() {
  if [ "$1" = "$THIS_NODE" ]; then bash -s; return; fi
  local ip f kh="" opts=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -o "HostKeyAlias=$1")
  ip="$(node_ip "$1")"; [ -n "$ip" ] && opts+=(-o "HostName=$ip")
  # The keys the cluster itself recorded: the node's own file (PVE 8.1+) and the cluster-wide one.
  for f in "$PVE_ETC/nodes/$1/ssh_known_hosts" "$PVE_ETC/priv/known_hosts"; do [ -f "$f" ] && kh="${kh:+$kh }$f"; done
  [ -n "$kh" ] && opts+=(-o "GlobalKnownHostsFile=$kh")
  ssh "${opts[@]}" "$1" 'bash -s'
}

# run_node_step STEP NODE: carry out one node step there (its HPX-RESULT line and anything else on stdout).
run_node_step() { step_text "$1" | node_run "$2" 2>&1; }
# probe_node NODE: what NODE has (probe.sh's lines on stdout; its errors are dropped, as before).
probe_node() { node_run "$1" < "$NODE_DIR/probe.sh" 2>/dev/null; }

cluster_nodes() {
  pvesh get /nodes --output-format json 2>/dev/null \
    | sed 's/},{/}\n{/g' | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u
}
# The address each node has in the cluster.
CLUSTER_STATUS=""
node_ip() {
  [ -n "$CLUSTER_STATUS" ] || CLUSTER_STATUS="$(pvesh get /cluster/status --output-format json 2>/dev/null | sed 's/},{/}\n{/g')"
  grep "\"name\"[[:space:]]*:[[:space:]]*\"$1\"" <<< "$CLUSTER_STATUS" | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true
}

declare -gA HW_GPUS HW_RAPL HW_NX HW_INTEL_X HW_NV_X HW_OK HW_IGPU HW_AMD_X
CHECKLIST=()
check() { CHECKLIST+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"); }   # status label node reason

step_label() {
  case "$1" in
    node-exporter) echo "Health monitoring";; rapl) echo "Power monitoring";;
    intel-gpu-exporter) echo "Intel GPU monitoring";; nvidia-gpu-exporter) echo "NVIDIA GPU monitoring";;
    amd-gpu-metrics) echo "AMD GPU monitoring";;
    igpu-access) echo "Built-in graphics for containers";;
  esac
}
# A step as one script: the helpers, then (for the built-in graphics steps) the probe's own functions.
step_text() {
  cat "$NODE_DIR/common.sh"
  case "$1" in igpu-access*) echo 'HPX_PROBE_LIB=1'; cat "$NODE_DIR/probe.sh";; esac
  cat "$NODE_DIR/$1.sh"
}
metrics_from() { curl -fsS --max-time 5 "http://$1:$2/metrics" 2>/dev/null; }
# metrics_has HOST PORT PATTERN. node_exporter's page is large: piped into grep -q, curl is cut off when grep
# stops early, and with pipefail that reads as "does not answer".
metrics_has() { local m; m="$(metrics_from "$1" "$2" || true)"; grep -q "$3" <<< "$m"; }
rapl_joules() { { metrics_from "$1" 9100 || true; } | awk '/^node_rapl_package_joules_total/ {s += $2} END {printf "%.3f", s + 0}'; }
join_list() { local IFS=,; local s="$*"; echo "${s//,/, }"; }

# ---------------------------------------------------------------------------
#  This host's CPU architecture, as Debian and Proxmox's templates name it
# ---------------------------------------------------------------------------
host_arch() {
  local a
  a="$(dpkg --print-architecture 2>/dev/null || true)"
  if [ -z "$a" ]; then
    case "$(uname -m)" in x86_64|amd64) a=amd64;; aarch64|arm64) a=arm64;; *) a="";; esac
  fi
  case "$a" in amd64|arm64) echo "$a";; *) return 1;; esac
}

# Standard Debian template names in some pveam output, one per line (pveam list: "store:vztmpl/NAME";
# pveam available: "system  NAME  [arch]").
debian_templates() { grep -oE 'debian-[0-9]+-standard_[^[:space:]/:]+\.tar\.zst' | sort -u || true; }
# Only those built for ARCH: the name ends in exactly _ARCH.tar.zst.
for_arch() { grep -E "_${1}\.tar\.zst\$" || true; }
newest() { sort -V | tail -1; }

# add_tun CTID: /dev/net/tun in the container, for Tailscale. `pct set --dev0` (PVE 8.1 and later) writes it the
# way Proxmox expects. On an older Proxmox the two lxc lines are added through Proxmox's own config code, under its
# lock: never appended (lines after a [pve:pending] or snapshot block belong to that block, and PVE drops them).
add_tun() {
  local conf="$PVE_ETC/lxc/$1.conf" err
  grep -qE '^dev[0-9]+:.*/dev/net/tun|c 10:200 rwm' "$conf" 2>/dev/null && return 0
  err="$(pct set "$1" --dev0 /dev/net/tun 2>&1 >/dev/null)" && return 0
  # Only a Proxmox that does not know devN gets the old lines; any other refusal is reported, and nothing is forced.
  if ! grep -qiE "dev0.*(not defined in schema|unknown|does not exist)|unknown option.*dev0" <<< "$err"; then
    warn "Could not give container $1 /dev/net/tun (pct set: ${err:-no reason given}). Tailscale will not run there until it has it."
    return 0
  fi
  # Under Proxmox's own config lock, through its own reader and writer: pending and snapshot sections stay whole,
  # and the file is replaced, never edited in place on the cluster filesystem.
  # shellcheck disable=SC2016  # Perl, not shell
  perl -e '
    use strict; use warnings; use PVE::LXC::Config;
    my $id = shift;
    PVE::LXC::Config->lock_config($id, sub {
      my $c = PVE::LXC::Config->load_config($id);
      my $l = ($c->{lxc} //= []);
      my %have = map { "$_->[0] $_->[1]" => 1 } @$l;
      for my $p (["lxc.cgroup2.devices.allow", "c 10:200 rwm"], ["lxc.mount.entry", "/dev/net/tun dev/net/tun none bind,create=file"]) {
        push @$l, $p unless $have{"$p->[0] $p->[1]"};
      }
      PVE::LXC::Config->write_config($id, $c);
    });' "$1" 2>/dev/null || warn "Could not add /dev/net/tun to container $1."
}

# pick_template_storage: where a template to download goes. One that already keeps a Debian 13 template for this
# CPU (that is where this cluster keeps them); else a file store that is not CephFS (a CephFS pool may be one with
# no replicas, kept for bulk data); else any. TPL_STORES is most-free first, so among equals the roomiest wins.
pick_template_storage() {
  local s rank best="" br=9
  for s in "${TPL_STORES[@]}"; do
    if grep -q '^debian-13-standard_' <<< "${HAVE[$s]:-}"; then rank=0
    elif [ "${TPL_TYPE[$s]:-}" = cephfs ]; then rank=2
    else rank=1; fi
    if [ "$rank" -lt "$br" ]; then br=$rank; best=$s; fi
  done
  echo "$best"
}

# ---------------------------------------------------------------------------
#  Storage for the container's disk: one that is active, can hold DISK GB, and
#  is block storage if there is any (a container's root on a network file share
#  is slow and fragile). Among equals, the most space free.
# ---------------------------------------------------------------------------
pick_rootfs_storage() {
  pvesm status -content rootdir 2>/dev/null | awk -v need="$(( DISK * 1024 * 1024 ))" '
    NR > 1 && $3 == "active" && $6 + 0 >= need {
      tier = 3
      if ($2 ~ /^(rbd|zfspool|lvmthin|lvm|iscsidirect)$/) tier = 1
      else if ($2 ~ /^(dir|btrfs|zfs)$/) tier = 2
      printf "%d %.0f %s\n", tier, $6, $1
    }' | sort -k1,1n -k2,2nr | head -1 | awk '{print $3}'
}

# ---------------------------------------------------------------------------
#  Numbering. Many clusters number guests <node#><two digits> and give each the
#  address .2<the same two digits> (guest 342 on node 3 at x.y.z.242). When most
#  guests do, the new container is offered an ID and an address that fit.
# ---------------------------------------------------------------------------
# A guest's first static IPv4 address, from the current config only (not snapshots): "a.b.c.d/nn gw".
conf_ip() {
  awk '/^\[/ { exit }
       /^(net|ipconfig)[0-9]+:/ && match($0, /ip=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+/) {
         ip = substr($0, RSTART + 3, RLENGTH - 3); gw = ""
         if (match($0, /gw=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) gw = substr($0, RSTART + 3, RLENGTH - 3)
         print ip, gw; exit }' "$1"
}
node_digit_from_name() { [[ "$1" =~ [^0-9]([1-9])$ ]] && echo "${BASH_REMATCH[1]}"; return 0; }
majority() { sort | uniq -c | sort -k1,1nr | awk 'NR==1 {print $2}'; }

# addr_answers ADDR: something on the network answers on ADDR (a ping, or an ARP reply where iputils arping is
# installed: hosts that drop pings still answer ARP).
addr_answers() {
  ping -c 1 -W 1 "$1" >/dev/null 2>&1 && return 0
  if command -v arping >/dev/null 2>&1 && arping -V 2>&1 | grep -q iputils; then
    # -D: duplicate address detection, which exits non-zero when anything replies.
    arping -q -D -c 2 -w 3 -I "$BRIDGE" "$1" >/dev/null 2>&1 || return 0
  fi
  return 1
}
# addr_in_configs ADDR: some guest config (snapshots and pending changes too) names ADDR.
addr_in_configs() { grep -qsE "ip=${1//./\\.}/" "$PVE_ETC"/nodes/*/lxc/*.conf "$PVE_ETC"/nodes/*/qemu-server/*.conf; }

CONV_ID=""; CONV_IP=""; CONV_GW=""; CONV_MATCH=0; CONV_TOTAL=0
detect_numbering() {
  local f node id ipc ip gw o lead d subnet cidr x cand_id cand_ip pings=0 used_ips
  local -A digit votes
  local rows=()
  for f in "$PVE_ETC"/nodes/*/lxc/*.conf "$PVE_ETC"/nodes/*/qemu-server/*.conf; do
    [ -e "$f" ] || continue
    ipc="$(conf_ip "$f")"; [ -n "$ipc" ] || continue
    node="$(basename "$(dirname "$(dirname "$f")")")"; id="$(basename "$f" .conf)"
    rows+=("$node $id $ipc")
    ip="${ipc%%/*}"; o="${ip##*.}"
    if [[ "$id" =~ ^[1-9][0-9][0-9]$ ]] && [ "$o" -ge 200 ] && [ "$o" -le 299 ] && [ $((10#${id:1})) -eq $((o - 200)) ]; then
      votes[$node]+="${id:0:1}"$'\n'
    fi
  done
  CONV_TOTAL=${#rows[@]}
  [ "$CONV_TOTAL" -ge 3 ] || return 0
  # Each node's digit: the one its name ends in, else the one most of its guests start with.
  for node in "${!votes[@]}" "$THIS_NODE"; do
    d="$(node_digit_from_name "$node")"
    [ -n "$d" ] || d="$(printf '%s' "${votes[$node]:-}" | grep . | majority || true)"
    digit[$node]="$d"
  done
  local matched=()
  for f in "${rows[@]}"; do
    read -r node id ipc gw <<< "$f"
    ip="${ipc%%/*}"; o="${ip##*.}"
    [[ "$id" =~ ^[1-9][0-9][0-9]$ ]] && [ "$o" -ge 200 ] && [ "$o" -le 299 ] || continue
    [ "${id:0:1}" = "${digit[$node]:-x}" ] && [ $((10#${id:1})) -eq $((o - 200)) ] || continue
    matched+=("$ipc ${gw:-}")
  done
  CONV_MATCH=${#matched[@]}
  [ "$CONV_MATCH" -ge 3 ] && [ $((CONV_MATCH * 2)) -gt "$CONV_TOTAL" ] || return 0
  d="${digit[$THIS_NODE]:-}"; [ -n "$d" ] || return 0
  command -v ping >/dev/null 2>&1 || return 0      # an address that cannot be checked is not offered
  subnet="$(printf '%s\n' "${matched[@]}" | awk '{split($1, a, "/"); sub(/\.[0-9]+$/, "", a[1]); print a[1]}' | majority)"
  cidr="$(printf '%s\n' "${matched[@]}" | awk '{split($1, a, "/"); print a[2]}' | majority)"
  gw="$(printf '%s\n' "${matched[@]}" | awk 'NF > 1 {print $2}' | majority)"
  [ -n "$gw" ] || gw="$(ip route show default 2>/dev/null | awk '/via/ {for (i = 1; i < NF; i++) if ($i == "via") {print $(i+1); exit}}')"
  [ -n "$subnet" ] && [ -n "$cidr" ] && [ -n "$gw" ] || return 0
  # Every address any guest config names (snapshots and pending changes too), and every node's.
  used_ips="$( { cat "$PVE_ETC"/nodes/*/lxc/*.conf "$PVE_ETC"/nodes/*/qemu-server/*.conf 2>/dev/null \
                  | grep -oE 'ip=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | cut -d= -f2
                for node in "${NODES[@]}"; do node_ip "$node"; done; } | sort -u)"
  for x in $(seq 0 54); do
    cand_id="$d$(printf '%02d' "$x")"; cand_ip="$subnet.$((200 + x))"
    guest_conf "$cand_id" >/dev/null && continue
    [ "$(pvesh get /cluster/nextid --vmid "$cand_id" 2>/dev/null)" = "$cand_id" ] || continue
    [ "$cand_ip" = "$gw" ] && continue
    grep -qxF "$cand_ip" <<< "$used_ips" && continue
    pings=$((pings + 1)); [ "$pings" -le 12 ] || return 0
    addr_answers "$cand_ip" && continue
    CONV_ID="$cand_id"; CONV_IP="$cand_ip/$cidr"; CONV_GW="$gw"
    return 0
  done
}

# ===========================================================================
main() {
  ui_init
  while [ $# -gt 0 ]; do
    case "$1" in
      --vmid) CTID="$2"; shift 2;;
      --hostname) HOSTNAME="$2"; shift 2;;
      --cores) CORES="$2"; shift 2;;
      --memory) MEMORY="$2"; shift 2;;
      --disk) DISK="$2"; shift 2;;
      --storage) STORAGE="$2"; shift 2;;
      --bridge) BRIDGE="$2"; shift 2;;
      --ip) NET="$2"; shift 2;;
      --gateway) GATEWAY="$2"; shift 2;;
      --password) PASSWORD="$2"; shift 2;;
      --skip-exporter) A_NODE_HEALTH=no; shift;;
      --skip-rapl) A_POWER=no; shift;;
      --skip-gpu-exporter) A_GPU=no; shift;;
      --no-charts) A_CHARTS=no; shift;;
      --no-pve-metrics) A_PVE_METRICS=no; shift;;
      --ai) A_AI=yes; shift;;
      --no-ai) A_AI=no; shift;;
      --igpu) A_IGPU=yes; shift;;
      --no-igpu) A_IGPU=no; shift;;
      --dry-run) DRY_RUN=1; shift;;
      --keep-on-failure) KEEP_ON_FAILURE=1; shift;;
      --ref) REF="${2:-}"; shift 2;;
      --dns) DNS="${2:-}"; DNS_FROM="--dns"; shift 2;;
      --vpn) VPN="${2:-}"; shift 2;;
      --token-name) TOKEN_NAME="${2:-}"; TOKEN_NAME_GIVEN=1; shift 2;;
      --template-storage) TEMPLATE_STORAGE_ARG="${2:-}"; shift 2;;
      --tailscale-authkey) TS_KEY_ARG="${2:-}"; shift 2;;
      --wg-subnet) WG_SUBNET="${2:-}"; WG_SUBNET_GIVEN=1; shift 2;;
      --wg-endpoint) WG_ENDPOINT="${2:-}"; shift 2;;
      -y|--yes) ASSUME_YES=1; shift;;
      -h|--help) usage; exit 0;;
      *) die "Unknown option: $1 (try --help)";;
    esac
  done
  ipv4='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'
  [[ "$HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]] && [ "${#HOSTNAME}" -le 253 ] \
    || die "--hostname must be a host name: letters, digits and hyphens, optionally dotted."
  [[ "$BRIDGE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "--bridge must be a network interface name, e.g. vmbr0."
  [ -z "$GATEWAY" ] || [[ "$GATEWAY" =~ $ipv4 ]] || die "--gateway must be an IPv4 address."
  for v in CORES MEMORY DISK; do [[ "${!v}" =~ ^[1-9][0-9]*$ ]] || die "--${v,,} must be a whole number."; done
  [ -z "$CTID" ] || [[ "$CTID" =~ ^[1-9][0-9]{2,8}$ ]] || die "--vmid must be a number of 100 or more."
  if [ -n "$REF" ]; then
    [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$REF" != *..* && "$REF" != -* ]] || die "--ref must be a tag, branch or commit id."
    # The installer and the node scripts come from that same version (HPX_RAW_BASE, when set, is used as given).
    [ -n "${HPX_RAW_BASE:-}" ] || RAW_BASE="https://raw.githubusercontent.com/hyperprox/alpha/$REF"
  fi
  if [ -n "$DNS_FROM" ]; then
    dns_list_ok "$DNS" || die "--dns must be one to three IPv4 or IPv6 addresses, separated by commas."
  fi
  case "$VPN" in ""|tailscale|wireguard|none) ;; *) die "--vpn must be tailscale, wireguard or none.";; esac
  check_token_name_shape "$TOKEN_NAME" || die "--token-name must be letters, digits, '.', '_' or '-', starting with a letter (at most 32)."
  [ -z "$TEMPLATE_STORAGE_ARG" ] || [[ "$TEMPLATE_STORAGE_ARG" =~ ^[A-Za-z][A-Za-z0-9._-]{0,63}$ ]] || die "--template-storage must be a storage name."
  if [ -n "$TS_KEY_ARG" ]; then
    # A key on the command line is in the process list and the shell history: only file:PATH is taken here.
    [[ "$TS_KEY_ARG" == file:* ]] || die "--tailscale-authkey takes file:/path/to/key only, so the key stays off the command line. Or set TS_AUTHKEY=tskey-… in the environment."
    [ -r "${TS_KEY_ARG#file:}" ] || die "--tailscale-authkey: cannot read ${TS_KEY_ARG#file:}."
    TS_KEY="$(tr -d '[:space:]' < "${TS_KEY_ARG#file:}")"
  fi
  # Checked by shape only, and never echoed: a wrong key is reported without it.
  [ -z "$TS_KEY" ] || [[ "$TS_KEY" =~ ^tskey-[A-Za-z0-9_-]{8,200}$ ]] || die "The Tailscale auth key does not look like one (tskey-…)."
  [ -z "$TS_KEY" ] || [ "$VPN" != wireguard ] || die "A Tailscale auth key and --vpn wireguard do not go together."
  [ -z "$WG_ENDPOINT" ] || [[ "$WG_ENDPOINT" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || die "--wg-endpoint must be an address or a DNS name, without a port."
  # A mirror or fork to clone instead of GitHub (HPX_REPO_URL), as install.sh's HYPERPROX_REPO_URL.
  REPO_URL_ARG="${HPX_REPO_URL:-}"
  [ -z "$REPO_URL_ARG" ] || [[ "$REPO_URL_ARG" =~ ^https?://[A-Za-z0-9.:-]+/[A-Za-z0-9._~/-]+$ ]] || die "HPX_REPO_URL must be an http(s) git URL."
  if [ "$NET" != dhcp ]; then
    [[ "${NET%%/*}" =~ $ipv4 ]] && [[ "$NET" =~ /([1-9]|[12][0-9]|3[0-2])$ ]] || die "--ip must be an address with its prefix, e.g. 10.0.0.50/24."
    [ -n "$GATEWAY" ] || die "--ip needs --gateway too."
  fi

  CTID_GIVEN="$CTID"; NET_GIVEN=0; [ "$NET" = dhcp ] || NET_GIVEN=1
  open_answers
  trap on_exit EXIT
  trap 'INTERRUPTED=1; exit 130' INT TERM HUP
  PVE_ETC="${HPX_PVE_ETC:-/etc/pve}"
  # Output of the commands that run under a spinner; shown (its tail) only when one fails.
  UI_LOG="$(mktemp)"; TMP_PATHS+=("$UI_LOG")
  ASK_PLACEMENT=0; [ "$INTERACTIVE" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ] && ASK_PLACEMENT=1

  ui_banner "installer" "${REF:-main}$([ "$DRY_RUN" -eq 1 ] && echo ' · dry run')"
  UI_STEPS=10

  # -------------------------------------------------------------------------
  #  1. Are we somewhere this can work?
  # -------------------------------------------------------------------------
  ui_step "Looking around"
  command -v pveversion >/dev/null 2>&1 || die "This must run on a Proxmox VE host — pveversion was not found."
  [ "$(id -u)" -eq 0 ] || die "This must run as root."
  ui_kv "Proxmox VE" "$(pveversion | cut -d/ -f2)"
  ip link show "$BRIDGE" >/dev/null 2>&1 || die "There is no network bridge '$BRIDGE' on this node. Pass --bridge."
  ARCH="$(host_arch)" || die "This host's CPU ($(uname -m)) has no Proxmox container template; HyperProx needs amd64 or arm64."
  ui_kv "CPU architecture" "$ARCH"
  # This node's name in the cluster (which is not always what `hostname` says).
  THIS_NODE=""
  [ -L "$PVE_ETC/local" ] && THIS_NODE="$(basename "$(readlink -f "$PVE_ETC/local")")"
  [ -n "$THIS_NODE" ] || THIS_NODE="$(hostname -s 2>/dev/null || hostname)"
  NODES=($(cluster_nodes))
  [ "${#NODES[@]}" -gt 0 ] || NODES=("$THIS_NODE")

  # -------------------------------------------------------------------------
  #  2. Where to put it
  # -------------------------------------------------------------------------
  if [ -z "$STORAGE" ]; then
    STORAGE="$(pick_rootfs_storage)"
    [ -n "$STORAGE" ] || die "No active storage on this node can hold a ${DISK} GB container disk. Pass --storage, or a smaller --disk."
  else
    pvesm status -content rootdir 2>/dev/null | awk -v s="$STORAGE" 'NR>1 && $1==s && $3=="active" {f=1} END {exit !f}' \
      || die "Storage '$STORAGE' is not active on this node, or cannot hold containers."
  fi
  ui_kv "Rootfs storage" "$STORAGE"
  choose_dns
  case "$DNS_FROM" in
    "")   ui_kv "DNS" "the node's own" ;;
    auto) ui_kv "DNS" "${DNS//,/, }"; note "$DNS_NOTE" ;;
    *)    ui_kv "DNS" "${DNS//,/, } (from ${DNS_FROM})" ;;
  esac

  # -------------------------------------------------------------------------
  #  3. Template — the newest Debian 13 built for this CPU. A template for
  #     another CPU is never used, even when it is the only one downloaded.
  # -------------------------------------------------------------------------
  if [ "$DRY_RUN" -ne 1 ]; then
    ui_try ui_wait "Refreshing Proxmox's template list" pveam update
    [ "$UI_RC" -eq 0 ] || warn "Could not refresh the template list; using what is cached."
  fi
  # Storages that take templates, most free space first, and the type of each.
  declare -gA TPL_TYPE
  TPL_STORES=()
  while read -r _n _t; do TPL_STORES+=("$_n"); TPL_TYPE[$_n]="$_t"; done \
    < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $6, $1, $2}' | sort -k1,1nr | awk '{print $2, $3}')
  [ "${#TPL_STORES[@]}" -gt 0 ] || die "No active storage on this node accepts container templates."
  if [ -n "$TEMPLATE_STORAGE_ARG" ]; then
    [ -n "${TPL_TYPE[$TEMPLATE_STORAGE_ARG]:-}" ] || die "Storage '$TEMPLATE_STORAGE_ARG' is not active on this node, or does not take container templates."
    TPL_STORES=("$TEMPLATE_STORAGE_ARG")
  fi
  AVAIL="$(pveam available --section system 2>/dev/null | debian_templates | for_arch "$ARCH")"
  declare -gA HAVE
  ALL_HAVE=""
  for s in "${TPL_STORES[@]}"; do
    if ! l="$(pveam list "$s" 2>/dev/null)"; then warn "Could not list the templates on $s; any there are checked again before downloading."; fi
    l="$(debian_templates <<< "$l")"
    HAVE[$s]="$(for_arch "$ARCH" <<< "$l")"
    ALL_HAVE="$ALL_HAVE${HAVE[$s]:+${HAVE[$s]}$'\n'}"
  done
  CANDIDATES="$(printf '%s\n%s\n' "$AVAIL" "$ALL_HAVE" | grep . | sort -u || true)"
  TEMPLATE="$(grep '^debian-13-standard_' <<< "$CANDIDATES" | newest || true)"
  if [ -z "$TEMPLATE" ]; then
    TEMPLATE="$(grep -E '^debian-(1[2-9]|[2-9][0-9])-standard_' <<< "$CANDIDATES" | newest || true)"
    [ -n "$TEMPLATE" ] || die "No Debian container template for $ARCH is available from Proxmox or on this node's storage."
    warn "No Debian 13 template for $ARCH; using $TEMPLATE"
  fi
  NEED_DOWNLOAD=1
  for s in "${TPL_STORES[@]}"; do
    if grep -qxF "$TEMPLATE" <<< "${HAVE[$s]}"; then TEMPLATE_STORAGE="$s"; NEED_DOWNLOAD=0; break; fi
  done
  if [ "$NEED_DOWNLOAD" -eq 1 ]; then
    grep -qxF "$TEMPLATE" <<< "$AVAIL" || die "$TEMPLATE is not offered for download."
    TEMPLATE_STORAGE="$(pick_template_storage)"
    ui_kv "Template" "$TEMPLATE ($ARCH), to be downloaded to $TEMPLATE_STORAGE"
  else
    TEMPLATE_PATH="$(template_path)"
    [ -n "$TEMPLATE_PATH" ] && [ -r "$TEMPLATE_PATH" ] && [ -s "$TEMPLATE_PATH" ] \
      || die "The template ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE} is listed but cannot be read (${TEMPLATE_PATH:-no path}). Is the storage mounted?"
    ui_kv "Template" "$TEMPLATE ($ARCH), already on $TEMPLATE_STORAGE"
  fi

  # -------------------------------------------------------------------------
  #  3b. What every node has
  # -------------------------------------------------------------------------
  node_scripts_dir
  ANY_CEPH=0; REACHED=()
  echo "    Found ${#NODES[@]} node$([ "${#NODES[@]}" -eq 1 ] || echo s):"
  for node in "${NODES[@]}"; do
    # The probe only reads (packages/hardware/node/probe.sh); its output lands in a file while the spinner turns.
    probe_out="$(mktemp)"; TMP_PATHS+=("$probe_out")
    UI_OUT="$probe_out" ui_try ui_wait "Looking at $node" probe_node "$node"; probe_rc="$UI_RC"
    out="$(cat "$probe_out")"; rm -f "$probe_out"
    if [ "$probe_rc" -ne 0 ] || ! grep -q '^arch' <<< "$out"; then
      HW_OK[$node]=0
      echo "      • $node: could not be reached, so it is left out"
      continue
    fi
    HW_OK[$node]=1; REACHED+=("$node")
    gpus="$(awk -F'\t' '$1=="gpu"{print $2"\t"$3"\t"$5}' <<< "$out")"
    HW_GPUS[$node]="$gpus"
    HW_RAPL[$node]="$(awk -F'\t' '$1=="rapl"{print $2}' <<< "$out")"
    HW_NX[$node]="$(awk -F'\t' '$1=="node_exporter"{print $2}' <<< "$out")"
    HW_INTEL_X[$node]="$(awk -F'\t' '$1=="intel_exporter"{print $2}' <<< "$out")"
    HW_NV_X[$node]="$(awk -F'\t' '$1=="nvidia_exporter"{print $2}' <<< "$out")"
    HW_AMD_X[$node]="$(awk -F'\t' '$1=="amd_metrics"{print $2}' <<< "$out")"
    HW_IGPU[$node]="$(awk -F'\t' '$1=="igpu_access"{print $2}' <<< "$out")"
    grep -q $'^ceph\tyes' <<< "$out" && ANY_CEPH=1
    # "AMD Radeon Vega Series / Radeon Vega Mobile Series" is shown as "AMD Radeon Vega".
    words="$(awk -F'\t' 'NF { n = $3; sub(/ \/ .*/, "", n); sub(/ Series$/, "", n)
                         printf "%s%s (%s)", (k++ ? ", " : ""), n, ($2 == "integrated" ? "built in" : "dedicated") }' <<< "$gpus")"
    [ -n "$words" ] || words="no GPU"
    [ "${HW_RAPL[$node]}" = none ] && words="$words · no power counters"
    [ "${HW_NX[$node]}" = running ] && words="$words · health monitoring ✓"
    grep -qE $'^(intel|nvidia|amd)\t' <<< "$gpus" && gpu_covered "$node" && words="$words · GPU monitoring ✓"
    echo "      • $node: $words"
  done
  [ "$ANY_CEPH" -eq 1 ] && echo "    Ceph storage found."
  [ "${#REACHED[@]}" -gt 0 ] || die "No node could be reached, not even this one."

  # -------------------------------------------------------------------------
  #  2. The container's ID and address. With someone at the keyboard both are asked for, a free ID and an
  #     address that fit the cluster's numbering offered first; -y, a flag or no terminal: no question.
  # -------------------------------------------------------------------------
  ui_step "Your container"
  if [ -z "$CTID" ] && [ "$NET" = dhcp ]; then
    detect_numbering
    if [ -n "$CONV_ID" ] && [ "$ASK_PLACEMENT" -ne 1 ]; then
      use=""
      if [ "$NO_TERMINAL" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
        note "Your guests follow <node#><IP> numbering; with no terminal to ask on, a static address is not chosen for you."
        use=no
      else
        ask_yn use yes "Your guests follow <node#><IP> numbering ($CONV_MATCH of $CONV_TOTAL do); use CT $CONV_ID with IP $CONV_IP (gateway $CONV_GW)?" \
          "The ID is free, no guest config uses the address, and nothing answers a ping on it." "Use CT $CONV_ID at ${CONV_IP%%/*}"
      fi
      if [ "$use" = yes ]; then CTID="$CONV_ID"; NET="$CONV_IP"; GATEWAY="$CONV_GW"; fi
    fi
  fi
  [ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
  [[ "$CTID" =~ ^[0-9]+$ ]] || die "Could not get a free container ID from Proxmox."
  if f="$(id_in_use "$CTID")"; then die "ID $CTID is already used ($f). Pass --vmid to choose another."; fi
  if [ "$ASK_PLACEMENT" -eq 1 ] && [ -z "$CTID_GIVEN" ]; then
    if [ -n "$CONV_ID" ]; then
      why="Your guests follow <node#><IP> numbering ($CONV_MATCH of $CONV_TOTAL do), so on $THIS_NODE the next free one is $CONV_ID, which goes with ${CONV_IP%%/*}."
    else
      why="The next free one is $CTID. Any free ID of 100 or more; every guest in the cluster is checked."
    fi
    # Nothing to read (EOF) takes the next free ID, never the numbering's static address.
    ask_value CTID "${CONV_ID:-$CTID}" "Container ID" "Which ID should the HyperProx container get?" "$why" check_ctid ID "$CTID"
  fi
  if [ "$ASK_PLACEMENT" -eq 1 ] && [ "$NET_GIVEN" -eq 0 ]; then ask_network; fi
  ok "Container ID $CTID"
  if [ "$NET" = dhcp ]; then ui_kv "Network" "DHCP on $BRIDGE"
  else
    if [ "$NET" != "${CONV_IP:-}" ]; then
      addr_in_configs "${NET%%/*}" && die "Another guest's config already uses ${NET%%/*}. Choose another --ip."
      addr_answers "${NET%%/*}" && die "Something already answers on ${NET%%/*}. Choose another --ip."
    fi
    ui_kv "Network" "$NET, gateway $GATEWAY, on $BRIDGE"
  fi

  # -------------------------------------------------------------------------
  #  3c. The questions — only those that apply, and never about what is there
  # -------------------------------------------------------------------------
  ui_step "What to switch on"
  [ "$NO_TERMINAL" -eq 1 ] && note "No terminal to ask on, so the defaults are shown. Re-run with -y to go ahead with them."
  N=${#REACHED[@]}; NS="$N node$([ "$N" -eq 1 ] || echo s)"
  NX_NEED=(); RAPL_ANY=(); RAPL_NEED=(); GPU_ANY=(); GPU_NEED=(); IGPU_ANY=(); IGPU_NEED=(); AMD_ANY=0
  for node in "${REACHED[@]}"; do
    [ "${HW_NX[$node]}" = running ] || NX_NEED+=("$node")
    [ "${HW_RAPL[$node]}" != none ] && RAPL_ANY+=("$node")
    [ "${HW_RAPL[$node]}" = root-only ] && RAPL_NEED+=("$node")
    if grep -qE $'^(intel|nvidia|amd)\t' <<< "${HW_GPUS[$node]}"; then
      GPU_ANY+=("$node"); gpu_covered "$node" || GPU_NEED+=("$node")
      grep -q $'^amd\t' <<< "${HW_GPUS[$node]}" && AMD_ANY=1
    fi
    case "${HW_IGPU[$node]}" in open) IGPU_ANY+=("$node");; closed) IGPU_ANY+=("$node"); IGPU_NEED+=("$node");; esac
  done

  # partial NEED_ARRAY_NAME ANY_ARRAY_NAME: names the nodes left to do when only some need it.
  partial() {
    local -n need="$1" any="$2"; local done_=() n
    [ "${#need[@]}" -lt "${#any[@]}" ] || return 0
    for n in "${any[@]}"; do [[ " ${need[*]} " == *" $n "* ]] || done_+=("$n"); done
    note "Already on $(join_list "${done_[@]}"); this is about $(join_list "${need[@]}")."
  }

  if [ -z "$A_NODE_HEALTH" ] && [ "${#NX_NEED[@]}" -eq 0 ]; then
    ok "Health monitoring already running on all $NS"; A_NODE_HEALTH=yes
  else
    partial NX_NEED REACHED
    ask_yn A_NODE_HEALTH yes "$Q_NODE_HEALTH" "$W_NODE_HEALTH" "Node health (CPU, memory, disks)"
  fi
  if [ "${#RAPL_ANY[@]}" -eq 0 ]; then A_POWER=no
  elif [ -z "$A_POWER" ] && [ "${#RAPL_NEED[@]}" -eq 0 ]; then
    ok "Power counters already readable on $([ "${#RAPL_ANY[@]}" -eq "$N" ] && echo "all $NS" || join_list "${RAPL_ANY[@]}")"; A_POWER=yes
  else
    partial RAPL_NEED RAPL_ANY
    ask_yn A_POWER yes "$Q_POWER" "$W_POWER" "Power use per node"
  fi
  if [ "${#GPU_ANY[@]}" -eq 0 ]; then A_GPU=no
  elif [ -z "$A_GPU" ] && [ "${#GPU_NEED[@]}" -eq 0 ]; then
    ok "GPU monitoring already running on $([ "${#GPU_ANY[@]}" -eq "$N" ] && echo "all $NS" || join_list "${GPU_ANY[@]}")"; A_GPU=yes
  else
    [ "$AMD_ANY" -eq 1 ] && note "AMD GPUs are read by node_exporter, so on those nodes this also needs node health monitoring."
    partial GPU_NEED GPU_ANY
    ask_yn A_GPU yes "$Q_GPU" "$W_GPU" "GPU monitoring"
  fi
  # Offered on nodes with built-in Intel or AMD graphics, but the default is no, even with -y.
  if [ "${#IGPU_ANY[@]}" -eq 0 ]; then A_IGPU=no
  elif [ -z "$A_IGPU" ] && [ "${#IGPU_NEED[@]}" -eq 0 ]; then
    ok "Built-in graphics already open to containers on $(join_list "${IGPU_ANY[@]}")"; A_IGPU=yes
  else
    [ "${#IGPU_NEED[@]}" -gt 0 ] && note "Applies to $(join_list "${IGPU_NEED[@]}")."
    ask_yn A_IGPU no "$Q_IGPU" "$W_IGPU" "Built-in graphics for containers"
  fi
  ask_yn A_CHARTS yes "$Q_CHARTS" "$W_CHARTS" "Charts and history"
  if [ "$A_CHARTS" = yes ]; then ask_yn A_PVE_METRICS yes "$Q_PVE_METRICS" "$W_PVE_METRICS" "Proxmox's own metrics"; else A_PVE_METRICS=no; fi
  GD_KEY=""; GD_SECRET=""
  ask_yn A_DNS no "$Q_DNS" "$W_DNS" "DNS provider (GoDaddy)" "add it later in Settings → Setup checklist"
  if [ "$A_DNS" = yes ] && [ "$ASSUME_YES" -ne 1 ] && [ "$NO_TERMINAL" -ne 1 ]; then
    note "Production key from developer.godaddy.com/keys (test keys do not work). Typing is hidden."
    ask_secret GD_KEY "API key"
    ask_secret GD_SECRET "API secret"
    if [ -z "$GD_KEY" ] || [ -z "$GD_SECRET" ]; then A_DNS=no; note "No key given; add one later under Settings → Setup checklist."; fi
    # Checked before it is held, as the setup wizard does. The key goes to curl on stdin, never on a command line.
    if [ "$A_DNS" = yes ]; then
      if printf 'Authorization: sso-key %s:%s\n' "$GD_KEY" "$GD_SECRET" \
          | curl -fsS -o /dev/null --max-time 15 -H @- 'https://api.godaddy.com/v1/domains?limit=1' 2>/dev/null; then
        ok "GoDaddy accepted the key"
      else
        A_DNS=no; GD_KEY=""; GD_SECRET=""
        warn "GoDaddy did not accept that key (it must be a Production key). Add one later under Settings → Setup checklist."
      fi
    fi
  elif [ "$A_DNS" = yes ]; then
    A_DNS=no; note "A GoDaddy key cannot be typed without a terminal; add one later under Settings → Setup checklist."
  fi
  ask_yn A_AI no "$Q_AI" "$W_AI" "AI assistant" "connect one later on the AI page"

  # The node work these answers mean, one node at a time: "node<TAB>step".
  PLAN=()
  for node in "${REACHED[@]}"; do
    [ "$A_NODE_HEALTH" = yes ] && [ "${HW_NX[$node]}" != running ] && PLAN+=("$node"$'\t'node-exporter)
    [ "$A_POWER" = yes ] && [ "${HW_RAPL[$node]}" = root-only ] && PLAN+=("$node"$'\t'rapl)
    if [ "$A_GPU" = yes ]; then
      grep -q $'^intel\t' <<< "${HW_GPUS[$node]}" && [ "${HW_INTEL_X[$node]}" != running ] && PLAN+=("$node"$'\t'intel-gpu-exporter)
      grep -q $'^nvidia\t' <<< "${HW_GPUS[$node]}" && [ "${HW_NV_X[$node]}" != running ] && PLAN+=("$node"$'\t'nvidia-gpu-exporter)
      grep -q $'^amd\t' <<< "${HW_GPUS[$node]}" && [ "${HW_AMD_X[$node]}" != on ] && PLAN+=("$node"$'\t'amd-gpu-metrics)
    fi
    [ "$A_IGPU" = yes ] && [ "${HW_IGPU[$node]}" = closed ] && PLAN+=("$node"$'\t'igpu-access)
  done

  # -------------------------------------------------------------------------
  #  4. One summary of everything, then one question. Nothing exists yet.
  # -------------------------------------------------------------------------
  NETCONF="name=eth0,bridge=${BRIDGE},ip=${NET}"
  [ -n "$GATEWAY" ] && NETCONF="${NETCONF},gw=${GATEWAY}"
  [ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | head -c 20 || true)"
  [ -n "$PASSWORD" ] || die "Could not generate a root password; pass --password."
  ask_token_name
  # Named after HyperProx's own token, as apps/setup/pve-exporter.js names it, so `hyperprox pve-exporter`
  # and the setup wizard find this one instead of making a second.
  EXPORTER_TOKEN="${TOKEN_NAME}-exporter"
  token_exists "$TOKEN_NAME" && TOKEN_EXISTED=1
  token_exists "$EXPORTER_TOKEN" && XTOKEN_EXISTED=1

  # -------------------------------------------------------------------------
  #  4. Remote access, then one table of everything, and one question. Nothing exists yet.
  # -------------------------------------------------------------------------
  ui_step "Remote access"
  ask_vpn
  if [ "$UI_FANCY" -eq 1 ]; then summary_box; else
  echo
  echo "  Ready to create:"
  echo "    Container  $CTID ($HOSTNAME): privileged, with nesting, keyctl and tun; starts on boot"
  echo "    Resources  ${CORES} cores · ${MEMORY} MB · ${DISK} GB on ${STORAGE}"
  if [ "$NET" = dhcp ]; then echo "    Network    DHCP on ${BRIDGE}"
  else echo "    Network    ${NET}, gateway ${GATEWAY}, on ${BRIDGE}"; fi
  if [ -n "$DNS" ]; then echo "    DNS        ${DNS//,/, }$([ "$DNS_FROM" = auto ] || echo " (from ${DNS_FROM})")"
  else echo "    DNS        the node's own"; fi
  [ -z "$DNS_NOTE" ] || echo "               ${DNS_NOTE}"
  echo "    Template   ${TEMPLATE} (${ARCH}) on ${TEMPLATE_STORAGE}$([ "$NEED_DOWNLOAD" -eq 1 ] && echo ', downloaded first' || echo ', already there')"
  echo "    VPN        $(vpn_words)"
  if [ "$TOKEN_EXISTED" -eq 1 ]; then echo "    Token      root@pam!${TOKEN_NAME} exists already and is left alone; the setup page will ask for one"
  else echo "    Token      root@pam!${TOKEN_NAME} (Administrator on /)"; fi
  if [ "$A_PVE_METRICS" = yes ]; then
    if [ "$XTOKEN_EXISTED" -eq 1 ]; then echo "               root@pam!${EXPORTER_TOKEN} exists already and is left alone"
    else echo "               root@pam!${EXPORTER_TOKEN} (read-only: PVEAuditor on /)"; fi
  fi
  if [ "${#PLAN[@]}" -gt 0 ]; then
    echo "  Then, on your nodes, one at a time:"
    for p in "${PLAN[@]}"; do printf '    • %s: %s\n' "${p%%$'\t'*}" "$(step_label "${p#*$'\t'}")"; done
  else
    echo "  Nothing to change on your nodes."
  fi
  echo "  In HyperProx: charts ${A_CHARTS} · Proxmox metrics ${A_PVE_METRICS} · GoDaddy ${A_DNS} · local AI ${A_AI}"
  [ "${#IGPU_ANY[@]}" -gt 0 ] && echo "  Built-in graphics for containers: ${A_IGPU}"
  fi
  echo
  if [ "$DRY_RUN" -eq 1 ]; then
    FINISHED=1
    ok "Dry run: nothing was changed."
    exit 0
  fi
  if [ "$ASSUME_YES" -ne 1 ]; then
    [ "$INTERACTIVE" -eq 1 ] || die "No terminal to confirm on. Re-run with -y (or HYPERPROX_YES=1) to accept the plan above."
    if [ "$UI_FANCY" -eq 1 ]; then printf '  %s› Go ahead?%s %s[Y/n]%s ' "$C_KEY" "$C_OFF" "$C_DIM" "$C_OFF"
    else printf "  Create it? [Y/n] "; fi
    if ! IFS= read -r reply <&3 && [ -z "$reply" ]; then echo; NO_CARD=1; die "No answer. Cancelled. Nothing was created."; fi
    [ -t 1 ] || echo
    case "$reply" in [nN]*) NO_CARD=1; die "Cancelled. Nothing was created.";; esac
  fi

  # -------------------------------------------------------------------------
  #  5. The template, then the container
  #
  #  Privileged with nesting and keyctl is not a preference — Docker's overlay
  #  driver fails without it, which is the first wall people hit. tun is included
  #  so Tailscale works later without a second reboot.
  # -------------------------------------------------------------------------
  ui_step "Creating the container"
  if [ "$NEED_DOWNLOAD" -eq 1 ]; then
    # The listing can fail quietly; the storage's own path is the last word on whether the file is there.
    TEMPLATE_PATH="$(template_path)"
    [ -n "$TEMPLATE_PATH" ] || die "Cannot find where ${TEMPLATE_STORAGE} keeps templates (pvesm path failed)."
    [ -e "$TEMPLATE_PATH" ] && NEED_DOWNLOAD=0 && ok "Template $TEMPLATE is on $TEMPLATE_STORAGE already"
  fi
  if [ "$NEED_DOWNLOAD" -eq 1 ]; then
    note "This is the slow part, usually a minute or two."
    TPL_TRY=1
    ui_try ui_run "Downloading $TEMPLATE" pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
    [ "$UI_RC" -eq 0 ] || die "Template download failed."
  fi
  TEMPLATE_PATH="$(template_path)"
  [ -n "$TEMPLATE_PATH" ] && [ -r "$TEMPLATE_PATH" ] && [ -s "$TEMPLATE_PATH" ] \
    || die "The template ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE} cannot be read (${TEMPLATE_PATH:-no path})."

  # Checked again at the last moment: the ID may have been taken while the questions were open.
  if f="$(id_in_use "$CTID")"; then die "ID $CTID was taken meanwhile ($f). Re-run to pick another."; fi
  if [ "$NET" != dhcp ]; then
    addr_in_configs "${NET%%/*}" && die "${NET%%/*} was taken meanwhile by another guest's config. Re-run to pick another."
    addr_answers "${NET%%/*}" && die "Something answers on ${NET%%/*} now. Re-run to pick another address."
  fi
  CT_TRY=1
  create_log="$(mktemp)"; TMP_PATHS+=("$create_log")
  create_ct() {
    pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
      --arch "$ARCH" --ostype debian \
      --description "$RUN_MARK" \
      --hostname "$HOSTNAME" \
      --cores "$CORES" --memory "$MEMORY" --swap 512 \
      --rootfs "${STORAGE}:${DISK}" \
      --net0 "$NETCONF" \
      ${DNS:+--nameserver "${DNS//,/ }"} \
      --unprivileged 0 \
      --features "keyctl=1,nesting=1" \
      --onboot 1 --start 0
  }
  UI_OUT="$create_log" ui_try ui_wait "Creating container $CTID on $STORAGE" create_ct
  if [ "$UI_RC" -ne 0 ]; then
    create_out="$(cat "$create_log")"
    # Someone else's container with this ID: not ours to remove.
    grep -q 'already exists' <<< "$create_out" && CT_TRY=0
    printf '%s\n' "$create_out" | sed 's/^/    /' >&2
    die "Container creation failed."
  fi

  add_tun "$CTID"
  ok "Container $CTID created"

  pct start "$CTID" >/dev/null || die "Container failed to start."
  # Checked after the start: that is when Proxmox has applied (or dropped) what the config asked for.
  pct exec "$CTID" -- test -c /dev/net/tun 2>/dev/null \
    || warn "/dev/net/tun is missing in container $CTID; Tailscale cannot run there until it is added (pct set $CTID --dev0 /dev/net/tun)."
  # The root password goes in on stdin, so it is on no command line (and in no process list).
  printf 'root:%s\n' "$PASSWORD" | pct exec "$CTID" -- chpasswd \
    || warn "Could not set the root password; set it with: pct exec $CTID -- passwd"
  ui_try ui_run "Waiting for the container's network" wait_dns_in "$CTID"
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 \
    || die "The container has no working DNS. Check the bridge and gateway, then re-run."
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  ok "Container is up at ${CT_IP:-unknown}"
  ui_try ui_run "Preparing the container (apt: curl, certificates)" \
    pct exec "$CTID" -- bash -c "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates"
  [ "$UI_RC" -eq 0 ] || die "Could not install curl inside the container."

  # Remote access: Tailscale now, while you are here to sign in; WireGuard's container now (the undo covers it),
  # its server once HyperProx is installed (the recipe comes from the installed copy).
  [ "$VPN" != tailscale ] || setup_tailscale
  # WireGuard is optional: anything that goes wrong with it removes its container again and goes on without it.
  if [ "$VPN" = wireguard ]; then
    # A host name label is at most 63 characters; "-wg" takes three of them.
    WG_HOSTNAME="${HOSTNAME%%.*}"; WG_HOSTNAME="${WG_HOSTNAME:0:60}"; WG_HOSTNAME="${WG_HOSTNAME%-}-wg"
    if ! WG_CTID="$(pick_wg_ctid)"; then
      WG_CTID=""; warn "No free container ID for the WireGuard container."; wg_give_up
    else
      wg_log="$(mktemp)"; TMP_PATHS+=("$wg_log")
      WG_CT_TRY=1
      UI_OUT="$wg_log" ui_try ui_run "Creating the WireGuard container $WG_CTID" create_wg_ct
      if [ "$UI_RC" -ne 0 ]; then
        grep -q 'already exists' "$wg_log" && WG_CT_TRY=0
        warn "Could not create the WireGuard container."; wg_give_up
      elif ! pct start "$WG_CTID" >/dev/null 2>&1; then
        warn "The WireGuard container failed to start."; wg_give_up
      else
        ui_try ui_run "Waiting for the WireGuard container's network" wait_dns_in "$WG_CTID"
        [ "$UI_RC" -eq 0 ] || { warn "The WireGuard container has no working DNS."; wg_give_up; }
      fi
    fi
  fi

  # -------------------------------------------------------------------------
  #  6. Proxmox API token
  # -------------------------------------------------------------------------
  say "Creating the Proxmox API token"
  TOKEN_SECRET=""
  if [ "$TOKEN_EXISTED" -eq 1 ] || token_exists "$TOKEN_NAME"; then
    # Someone else's token: neither its secret nor its permissions are ours to change.
    warn "A token named '${TOKEN_NAME}' already exists; its secret is only shown once, so it is left alone."
    note "The setup page will ask for its secret. Or re-run with --token-name to make a new one."
  else
    TOKEN_SECRET="$(pveum user token add root@pam "$TOKEN_NAME" --privsep=0 --output-format json 2>/dev/null \
      | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" || TOKEN_SECRET=""
    # Ours only once it has handed back its secret: a token that failed to be made, or was made by someone
    # else meanwhile ("already exists"), is never removed by the undo.
    [ -n "$TOKEN_SECRET" ] || die "Could not create the token root@pam!${TOKEN_NAME} (check: pveum user token list root@pam)."
    TOKEN_TRY=1
    ok "Token root@pam!${TOKEN_NAME} created"
    pveum acl modify / --token "root@pam!${TOKEN_NAME}" --role Administrator >/dev/null 2>&1 \
      && ok "Granted Administrator on /" || warn "Could not set the ACL; grant it by hand."
  fi

  # The PVE exporter (Grafana's Proxmox panels) gets a token of its own that can only read: privilege
  # separation on, PVEAuditor on / and nothing else. Named and marked the way HyperProx's own provisioning
  # does it (apps/setup/pve-exporter.js), so `hyperprox pve-exporter` can later repair it.
  EXPORTER_SECRET=""
  if [ "$A_PVE_METRICS" != yes ]; then
    ok "Proxmox metrics: skipped (you said no)"
  elif [ "$XTOKEN_EXISTED" -eq 1 ] || token_exists "$EXPORTER_TOKEN"; then
    warn "A token named '${EXPORTER_TOKEN}' already exists; its secret is only shown once."
    note "After signing in to HyperProx, run in the container: hyperprox pve-exporter"
  else
    EXPORTER_SECRET="$(pveum user token add root@pam "${EXPORTER_TOKEN}" --privsep 1 \
      --comment "HyperProx metrics exporter, read-only (PVEAuditor) [exporter for root@pam!${TOKEN_NAME}]" --output-format json 2>/dev/null \
      | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
    [ -n "$EXPORTER_SECRET" ] && XTOKEN_TRY=1
    if [ -n "$EXPORTER_SECRET" ] && pveum acl modify / --token "root@pam!${EXPORTER_TOKEN}" --role PVEAuditor >/dev/null 2>&1; then
      ok "Token root@pam!${EXPORTER_TOKEN} created (read-only: PVEAuditor on /)"
    else
      warn "Could not make the exporter's read-only token; after setup, run in the container: hyperprox pve-exporter"
      EXPORTER_SECRET=""
    fi
  fi

  # -------------------------------------------------------------------------
  #  7. Your answers, carried out on the nodes — one node at a time
  #
  #  Each step reports done, already, skipped or failed with a plain reason, and
  #  is then checked from here: the exporter answers over the network (which is
  #  what Prometheus needs), and power reads more than zero.
  # -------------------------------------------------------------------------
  if [ "${#PLAN[@]}" -gt 0 ]; then say "Setting up your nodes"; fi
  for p in "${PLAN[@]}"; do
    node="${p%%$'\t'*}"; step="${p#*$'\t'}"; label="$(step_label "$step")"
    step_out="$(mktemp)"; TMP_PATHS+=("$step_out")
    UI_OUT="$step_out" ui_try ui_wait "$node — $label" run_node_step "$step" "$node"
    out="$(cat "$step_out")"; rm -f "$step_out"
    res="$(grep '^HPX-RESULT' <<< "$out" | tail -1)"
    if [ -z "$res" ]; then check failed "$label" "$node" "could not run the step there"; warn "$node — $label: could not run the step there"; continue; fi
    st="$(cut -f2 <<< "$res")"; why="$(cut -f3- <<< "$res")"
    if [ "$st" = done ]; then
      if [ -f "$NODE_DIR/$step-undo.sh" ]; then NODE_UNDO+=("$node"$'\t'"$step-undo"); else NODE_LEFT+=("$node"$'\t'"$step"); fi
    fi
    check "$st" "$label" "$node" "$why"
    case "$st" in done|already) ok "$node — $label: $why";; skipped) note "$node — $label: $why";; *) warn "$node — $label: $why";; esac
  done

  # Check the outcome, not the scripts' word.
  if [ "$A_NODE_HEALTH" = yes ] || [ "$A_POWER" = yes ] || [ "$A_GPU" = yes ]; then
    say "Checking from here"
    _before=${#CHECKLIST[@]}
    for node in "${NODES[@]}"; do
      [ "${HW_OK[$node]}" -eq 1 ] || { check failed "Node checks" "$node" "could not be reached"; continue; }
      ip="$(node_ip "$node")"; ip="${ip:-$node}"
      if [ "$A_NODE_HEALTH" = yes ]; then
        if metrics_has "$ip" 9100 '^node_exporter_build_info'; then check ok "Health answers" "$node" "port 9100 answers from here"
        else check failed "Health answers" "$node" "port 9100 does not answer from here (a firewall?)"; fi
      fi
      if [ "$A_POWER" = yes ] && [ "${HW_RAPL[$node]}" != none ]; then
        j1="$(rapl_joules "$ip")"; sleep 2; j2="$(rapl_joules "$ip")"
        if awk -v a="$j1" -v b="$j2" 'BEGIN{exit !(b > a)}'; then
          check ok "Power reading" "$node" "$(awk -v a="$j1" -v b="$j2" 'BEGIN{printf "%.1f W", (b-a)/2}')"
        else check failed "Power reading" "$node" "node_exporter shows no energy use (is health monitoring on?)"; fi
      fi
      if [ "$A_GPU" = yes ]; then
        if grep -q $'^intel\t' <<< "${HW_GPUS[$node]}"; then
          metrics_has "$ip" 8081 '^igpu_' && check ok "Intel GPU answers" "$node" "port 8081 answers from here" \
            || check failed "Intel GPU answers" "$node" "port 8081 does not answer from here"
        fi
        if grep -q $'^amd\t' <<< "${HW_GPUS[$node]}"; then
          metrics_has "$ip" 9100 '^node_drm_gpu_busy_percent' && check ok "AMD GPU answers" "$node" "node_exporter reports it from here" \
            || check failed "AMD GPU answers" "$node" "node_exporter reports no AMD GPU figures"
        fi
        if grep -q $'^nvidia\t' <<< "${HW_GPUS[$node]}"; then
          metrics_has "$ip" 9835 '^nvidia_smi_memory_total_bytes' && check ok "NVIDIA GPU answers" "$node" "port 9835 answers from here" \
            || check failed "NVIDIA GPU answers" "$node" "port 9835 does not answer from here"
        fi
      fi
    done
    _ok=0; _bad=0
    for row in "${CHECKLIST[@]:$_before}"; do case "${row%%$'\t'*}" in ok) _ok=$((_ok + 1));; *) _bad=$((_bad + 1));; esac; done
    if [ "$_bad" -eq 0 ]; then ok "All ${_ok} checks answer from here"
    else warn "${_bad} of $((_ok + _bad)) checks do not answer from here (listed at the end)"; fi
  fi

  # -------------------------------------------------------------------------
  #  8. Install HyperProx inside the container
  # -------------------------------------------------------------------------
  # install.sh draws steps 6 to 10 itself, with its own spinners. It gets this terminal's type and width, or
  # NO_COLOR when this run's output is plain (a log), so the two look alike; HPX_UI_NESTED drops its banner.
  ui_env="HPX_UI_NESTED=1 HPX_UI_STEP_BASE=${UI_STEP} HPX_UI_STEPS=${UI_STEPS}"
  if [ "$UI_FANCY" -eq 1 ]; then
    ui_env+=" TERM='${TERM//[^A-Za-z0-9._+-]/}' COLORTERM='${COLORTERM//[^A-Za-z0-9]/}' COLUMNS='$(( UI_W + 2 ))'"
  else
    ui_env+=" NO_COLOR=1"
  fi
  pct exec "$CTID" -- bash -c "curl -fsSL '$RAW_BASE/install.sh' -o /tmp/install.sh && $ui_env HYPERPROX_REF='$REF' HYPERPROX_REPO_URL='$REPO_URL_ARG' bash /tmp/install.sh < /dev/null" \
    || die "The HyperProx installer failed inside the container. To keep the container and look inside, re-run with --keep-on-failure."

  # -------------------------------------------------------------------------
  #  9. Hand the container everything it would otherwise ask you for
  # -------------------------------------------------------------------------
  # The node's address and port always; the token too when this run made it. Its secret goes in on stdin, so
  # it is on no command line.
  say "Configuring the Proxmox connection"
  # This node's address in the cluster: `hostname -I` lists every address, and the first is not always it.
  HOST_IP="$(node_ip "$THIS_NODE")"
  [ -n "$HOST_IP" ] || HOST_IP="$(hostname -I | awk '{print $1}')"
  # A token that was there already and kept: its name is written too, so the wizard asks only for its secret.
  if printf '%s\n' "$TOKEN_SECRET" | pct exec "$CTID" -- env HPX_HOST="$HOST_IP" HPX_TOKEN_ID="$TOKEN_NAME" bash -c "f=/opt/hyperprox/.env; $ENV_SET_KV"'
      IFS= read -r secret || true
      set_kv PROXMOX_HOST "$HPX_HOST"
      set_kv PROXMOX_PORT 8006
      set_kv PROXMOX_USER root@pam
      set_kv PROXMOX_TOKEN_ID "$HPX_TOKEN_ID"
      [ -z "$secret" ] || set_kv PROXMOX_TOKEN_SECRET "$secret"
      systemctl restart hyperprox-api 2>/dev/null || true'; then
    if [ -n "$TOKEN_SECRET" ]; then ok "Proxmox connection configured — the setup wizard will not ask again"
    else ok "Proxmox address and token name configured (${HOST_IP}:8006, ${TOKEN_NAME}); the setup wizard asks only for its secret"; fi
  else
    warn "Could not write the Proxmox connection; the setup wizard will ask for it"
  fi

  if [ -n "$EXPORTER_SECRET" ]; then
    # pve.yml as apps/setup/pve-exporter.js writes it: 0600 and owned by the exporter's user (uid 101).
    _pveyml="$(mktemp)"; TMP_PATHS+=("$_pveyml"); chmod 600 "$_pveyml"
    cat > "$_pveyml" <<PVEYML
# prometheus-pve-exporter: the read-only Proxmox API token it signs in with (PVEAuditor on /).
# Written by bootstrap.sh. To make a new one: hyperprox pve-exporter.
default:
  user: "root@pam"
  token_name: "${EXPORTER_TOKEN}"
  token_value: "${EXPORTER_SECRET}"
  verify_ssl: false
PVEYML
    if pct push "$CTID" "$_pveyml" /opt/hyperprox/config/pve-exporter/pve.yml --perms 0600 --user 101 --group 101; then
      pct exec "$CTID" -- docker restart hyperprox-pve-exporter >/dev/null 2>&1 || true
      ok "PVE exporter configured with its read-only token"
    else
      warn "Could not write the exporter's pve.yml; after setup, run in the container: hyperprox pve-exporter"
    fi
    rm -f "$_pveyml"
  fi

  # -------------------------------------------------------------------------
  #  9b. Your other answers, handed to HyperProx
  #
  #  The choices go into the container as plain settings, plus what was found and
  #  done (no secrets) so the setup page can show it. A GoDaddy key is a secret:
  #  it is never written to a file. It goes to the setup wizard's memory over
  #  stdin, and from there into the vault once you create the owner account.
  # -------------------------------------------------------------------------
  say "Handing your answers to HyperProx"
  _inst_prom=false; [ "$A_CHARTS" = yes ] && _inst_prom=true
  pct exec "$CTID" -- env HPX_PROM="$_inst_prom" HPX_AI="$([ "$A_AI" = yes ] && echo true || echo false)" bash -c "f=/opt/hyperprox/.env; $ENV_SET_KV"'
    set_kv INSTALL_PROMETHEUS "$HPX_PROM"
    set_kv INSTALL_GRAFANA "$HPX_PROM"
    set_kv INSTALL_OLLAMA "$HPX_AI"' && ok "Charts: ${A_CHARTS} · local AI: ${A_AI}"

  # The cluster's own record of every node's SSH host key, and this node's own key files, read HERE, as root on a
  # node: public keys only. HyperProx takes it as the anchor for verifying its nodes' keys by itself, so nobody has to
  # compare fingerprints (lib/hostkey-verify.ts; the same output as the command it shows for installs made elsewhere).
  _hostrec="$( { echo "@@hpx local $(basename "$(readlink -f /etc/pve/local)")"; for f in /etc/pve/nodes/*/ssh_known_hosts; do [ -f "$f" ] && echo "@@hpx node $(basename "$(dirname "$f")")" && cat -- "$f"; done; echo "@@hpx priv"; cat /etc/pve/priv/known_hosts 2>/dev/null; echo "@@hpx own"; cat /etc/ssh/ssh_host_*_key.pub; echo "@@hpx end"; } 2>/dev/null | base64 -w0 || true)"

  _answers="$(mktemp)"; TMP_PATHS+=("$_answers"); chmod 600 "$_answers"
  {
    printf '{"source":"bootstrap","hostRecord":"%s","answers":{' "$_hostrec"
    printf '"node-health":%s,"power":%s,"gpu":%s,"charts":%s,"proxmox-metrics":%s,"dns":%s,"ai":%s,"igpu-access":%s,"vpn":"%s"},"results":[' \
      "$([ "$A_NODE_HEALTH" = yes ] && echo true || echo false)" "$([ "$A_POWER" = yes ] && echo true || echo false)" \
      "$([ "$A_GPU" = yes ] && echo true || echo false)" "$([ "$A_CHARTS" = yes ] && echo true || echo false)" \
      "$([ "$A_PVE_METRICS" = yes ] && echo true || echo false)" "$([ "$A_DNS" = yes ] && echo true || echo false)" \
      "$([ "$A_AI" = yes ] && echo true || echo false)" "$([ "$A_IGPU" = yes ] && echo true || echo false)" "$VPN"
    _first=1
    for row in "${CHECKLIST[@]}"; do
      IFS=$'\t' read -r _s _l _n _w <<< "$row"
      [ "$_first" -eq 1 ] || printf ','; _first=0
      printf '{"status":"%s","label":"%s","node":"%s","reason":"%s"}' "$_s" "$_l" "$_n" "$(printf '%s' "$_w" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    done
    printf ']}\n'
  } > "$_answers"
  pct exec "$CTID" -- mkdir -p /opt/hyperprox/data/setup
  pct push "$CTID" "$_answers" /opt/hyperprox/data/setup/bootstrap.json --perms 0600 >/dev/null 2>&1 \
    && ok "What was found and done is on the setup page too" || warn "Could not hand the results to the setup page"
  rm -f "$_answers"

  if [ "$A_DNS" = yes ] && [ -n "$GD_KEY" ]; then
    # Sent on stdin, so it is on no command line; the wizard holds it in memory only.
    hand_godaddy() {
      printf '{"godaddy":{"key":"%s","secret":"%s"}}' "$GD_KEY" "$GD_SECRET" | pct exec "$CTID" -- bash -c '
        k="$(grep -oP "^SETUP_SECRET=\K.*" /opt/hyperprox/.env)"
        for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3001/health && break; sleep 2; done
        curl -fsS -o /dev/null -X POST -H "Content-Type: application/json" -H "X-Setup-Key: $k" --data-binary @- http://127.0.0.1:3001/api/setup/hold-secrets'
    }
    ui_try ui_wait "Waiting for the setup wizard, then handing it the GoDaddy key" hand_godaddy
    if [ "$UI_RC" -eq 0 ]; then
      ok "GoDaddy key held in memory until you create the owner account, then kept in the vault"
    else
      warn "Could not hand over the GoDaddy key; add it on the setup page or under Settings → Setup checklist"
    fi
  fi
  GD_KEY=""; GD_SECRET=""

  # Remote access: the WireGuard server, then what HyperProx's VPN page is to take over. The marker holds public
  # facts only (addresses, the server's public key, container IDs). The API adopts what it lists when HyperProx
  # is first unlocked (apps/api/src/lib/vpn/install-handoff.ts), and adopting twice changes nothing.
  if [ "$VPN" = wireguard ]; then say "Setting up WireGuard"; setup_wireguard; fi
  if [ -n "$TS_IP" ] || [ -n "$WG_PUB" ]; then
    _marker="$(mktemp)"; TMP_PATHS+=("$_marker"); chmod 600 "$_marker"
    vpn_marker "$_marker"
    if pct push "$CTID" "$_marker" /opt/hyperprox/data/setup/vpn-pending.json --perms 0600 >/dev/null 2>&1; then
      ok "Remote access handed to HyperProx: its VPN page takes it over at the first sign-in"
    else
      warn "Could not hand the VPN over to HyperProx; its VPN page shows it as found, not managed"
    fi
  fi
  FINISHED=1
  # The run's mark has done its job (only the undo reads it): a plain description takes its place.
  pct set "$CTID" --description "HyperProx, installed by bootstrap.sh on $(date +%F)" >/dev/null 2>&1 || true
  [ -z "$WG_PUB" ] || pct set "$WG_CTID" --description "HyperProx WireGuard server, installed by bootstrap.sh on $(date +%F)" >/dev/null 2>&1 || true

  # -------------------------------------------------------------------------
  #  Done
  # -------------------------------------------------------------------------
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i !~ /^100\./) {print $i; exit}}')"
  # The setup link carries the setup key (install.sh made it); this card is the one place it is shown.
  SETUP_KEY="$(pct exec "$CTID" -- sed -n 's/^SETUP_SECRET=//p' /opt/hyperprox/.env 2>/dev/null | head -1 || true)"
  [[ "$SETUP_KEY" =~ ^[0-9a-f]{32,128}$ ]] || SETUP_KEY=""
  # In the fragment (#k=), which a browser never sends: the key stays out of every access log.
  SETUP_URL="https://${CT_IP}/setup${SETUP_KEY:+#k=${SETUP_KEY}}"
  # The root password, kept where only root on this node reads it; the summary names the file, not the password.
  PW_FILE=""; save_password "${HPX_PW_DIR:-/root}/hyperprox-${CTID}.txt" && PW_FILE="${HPX_PW_DIR:-/root}/hyperprox-${CTID}.txt"
  if [ "$UI_FANCY" -eq 1 ]; then success_card; return 0; fi
  echo
  printf '  HyperProx is ready\n'
  echo
  echo "    Open       ${SETUP_URL}"
  echo "               the setup wizard; keep this link private, it carries the setup key (self-signed certificate: the browser warns once)"
  [ -z "$TS_URL" ] || echo "    Away       ${TS_URL}   (Tailscale)"
  [ -z "$WG_LINE" ] || echo "    VPN        WireGuard: ${WG_LINE}"
  [ "$VPN" != none ] || echo "    VPN        add remote access later on the VPN page"
  echo "    Container  $CTID  (pct enter $CTID)"
  if [ -n "$PW_FILE" ]; then echo "    Root pw    saved in $PW_FILE (root only)"
  else echo "    Root pw    $PASSWORD"; fi
  if [ "${#CHECKLIST[@]}" -gt 0 ]; then
    echo
    echo "    What was done on your nodes:"
    for row in "${CHECKLIST[@]}"; do
      IFS=$'\t' read -r _s _l _n _w <<< "$row"
      case "$_s" in done|already|ok) _m="${C_OK}✓${C_OFF}";; skipped) _m="${C_DIM}–${C_OFF}";; *) _m="${C_ERR}✗${C_OFF}";; esac
      printf '      %s %-22s %-12s %s\n' "$_m" "$_l" "$_n" "$_w"
    done
    note "Anything skipped or failed can be done later: Settings → Setup checklist."
  fi
  echo
  note "First: open the setup link above and finish the wizard; it already has your answers from here."
  note "Then create the owner account at https://${CT_IP}/login. HyperProx has no password of its own;"
  note "it signs in with its built-in vault (email, master password, required 2FA). See docs/security.md."
  note "Then: open Plug-ins and press Scan, and HyperProx will find the services"
  note "already running on your network and offer to configure them."
  echo
}

# ---------------------------------------------------------------------------
#  The review table and the success card, on a terminal. Plain output prints the same facts as lines (main).
# ---------------------------------------------------------------------------
summary_box() {
  local p mon=()
  [ "$A_NODE_HEALTH" = yes ] && mon+=("node health"); [ "$A_POWER" = yes ] && mon+=(power)
  [ "$A_GPU" = yes ] && mon+=(GPU); [ "$A_CHARTS" = yes ] && mon+=(charts); [ "$A_PVE_METRICS" = yes ] && mon+=("Proxmox metrics")
  echo
  ui_table_top "Ready to install"
  ui_table_row "Container" "$CTID  $HOSTNAME  on $THIS_NODE"
  if [ "$NET" = dhcp ]; then ui_table_row "Address" "DHCP on ${BRIDGE}"
  else ui_table_row "Address" "${NET}  gw ${GATEWAY}  on ${BRIDGE}"; fi
  if [ -n "$DNS" ]; then ui_table_row "DNS" "${DNS//,/, }$([ "$DNS_FROM" = auto ] || echo " (from ${DNS_FROM})")"
  else ui_table_row "DNS" "the node's own"; fi
  ui_table_row "Size" "${CORES} cores · ${MEMORY} MB RAM · ${DISK} GB on ${STORAGE}"
  ui_table_row "Features" "privileged · nesting · keyctl · tun · on boot"
  ui_table_row "Template" "${TEMPLATE}$([ "$NEED_DOWNLOAD" -eq 1 ] && echo ' (downloaded first)')"
  ui_table_row "Monitoring" "$( [ "${#mon[@]}" -gt 0 ] && join_list "${mon[@]}" | sed 's/, / · /g' || echo none)"
  ui_table_row "VPN" "$(vpn_words)"
  if [ "$TOKEN_EXISTED" -eq 1 ]; then ui_table_row "Token" "root@pam!${TOKEN_NAME} exists: kept (setup page asks for its secret)"
  else ui_table_row "Token" "root@pam!${TOKEN_NAME} (Administrator on /)"; fi
  if [ "$A_PVE_METRICS" = yes ] && [ "$XTOKEN_EXISTED" -ne 1 ]; then ui_table_row "" "root@pam!${EXPORTER_TOKEN} (read-only)"; fi
  if [ "${#PLAN[@]}" -gt 0 ]; then
    for p in "${PLAN[@]}"; do ui_table_row "$([ "$p" = "${PLAN[0]}" ] && echo 'On nodes')" "${p%%$'\t'*}: $(step_label "${p#*$'\t'}")"; done
  else
    ui_table_row "On nodes" "nothing to change"
  fi
  ui_table_row "Extras" "GoDaddy ${A_DNS} · local AI ${A_AI}$([ "${#IGPU_ANY[@]}" -gt 0 ] && echo " · built-in graphics ${A_IGPU}")"
  ui_table_bottom
}
success_card() {
  local row _s _l _n _w bad=0
  for row in "${CHECKLIST[@]}"; do case "${row%%$'\t'*}" in done|already|ok|skipped) ;; *) bad=$(( bad + 1 ));; esac; done
  echo
  ui_box_top "" "$UI_CW" "$C_OK"
  ui_card_line "✓  HyperProx is running" "$C_OK$C_BOLD" "total $(ui_secs "$SECONDS")"
  ui_card_line ""
  ui_card_line "   Open the setup link printed below this box." "$C_KEY"
  ui_card_line "   Keep it private: it carries the setup key." "$C_DIM"
  [ -z "$TS_URL" ] || ui_card_line "   Away   ${TS_URL}  (Tailscale)" "$C_KEY"
  [ -z "$WG_LINE" ] || ui_card_line "   VPN    ${WG_LINE}"
  ui_card_line ""
  ui_card_line "   Next" "$C_BOLD"
  ui_card_line "   1  Open the link and finish the setup wizard: it has your answers from here$([ -n "$TOKEN_SECRET" ] && echo ' and your Proxmox connection' || echo '; it asks for the token secret')"
  ui_card_line "   2  Then create your owner account at https://${CT_IP}/login (vault, 2FA)"
  case "$VPN" in
    wireguard) ui_card_line "   3  On the VPN page, add your phone: it shows a QR code";;
    tailscale) ui_card_line "   3  Add DNS, proxy and alerts any time under Settings";;
    *)         ui_card_line "   3  Remote access: add it later on the VPN page";;
  esac
  [ "$bad" -eq 0 ] || ui_card_line "   $bad node step(s) did not work: Settings → Setup checklist" "$C_WARN"
  ui_card_line ""
  if [ -n "$PW_FILE" ]; then ui_card_line "Container $CTID · root password saved in $PW_FILE" "$C_DIM"
  else ui_card_line "Container $CTID · root password: $PASSWORD" "$C_DIM"; fi
  ui_box_bottom "$UI_CW"
  echo
  ui_link "Setup link (private):" "$SETUP_URL"
  echo
}

# GPU monitoring already covers every Intel, NVIDIA and AMD GPU on NODE.
gpu_covered() {
  local g="${HW_GPUS[$1]}"
  ! grep -q $'^intel\t' <<< "$g" || [ "${HW_INTEL_X[$1]}" = running ] || return 1
  ! grep -q $'^nvidia\t' <<< "$g" || [ "${HW_NV_X[$1]}" = running ] || return 1
  ! grep -q $'^amd\t' <<< "$g" || [ "${HW_AMD_X[$1]}" = on ] || return 1
  return 0
}

main "$@"; exit $?
