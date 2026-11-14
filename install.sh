#!/usr/bin/env bash
# =============================================================================
#  HyperProx — One-Shot Installer
#  Supports: Debian 12, Debian 13, Ubuntu 22.04, Ubuntu 24.04
#  Targets:  Proxmox LXC (privileged), bare metal, VM
#  Usage:    curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/install.sh | bash
#            — or —
#            bash install.sh [--no-build] [--dev] [--ref=REF]
#
#  --ref=REF (or HYPERPROX_REF) installs a release tag, branch or commit instead of main; the in-app updater
#  (Updates page) takes it from there. HYPERPROX_REPO_URL clones a mirror or fork instead of GitHub.
# =============================================================================

set -euo pipefail

# A fresh Debian container has no locale generated, so apt, perl and git print warnings on every call.
# C.UTF-8 is built into glibc and always exists; use it for everything this installer runs.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
unset LANGUAGE

export DEBIAN_FRONTEND=noninteractive

# ── Flags ────────────────────────────────────────────────────────────────────
SKIP_BUILD=false
DEV_MODE=false
for arg in "$@"; do
  case $arg in
    --no-build) SKIP_BUILD=true ;;
    --dev)      DEV_MODE=true ;;
    --ref=*)    HYPERPROX_REF="${arg#--ref=}" ;;
  esac
done

# ── Constants ─────────────────────────────────────────────────────────────────
HYPERPROX_DIR="/opt/hyperprox"
REPO_URL="${HYPERPROX_REPO_URL:-https://github.com/hyperprox/alpha.git}"
INSTALL_REF="${HYPERPROX_REF:-}"
NODE_VERSION="20"
# 10: pnpm-workspace.yaml carries overrides and allowBuilds, which pnpm 9 ignores, so a frozen install fails.
PNPM_VERSION="10"
SETUP_PORT="3001"
API_PORT="3002"
FRONTEND_PORT="3000"
LOG_FILE="/var/log/hyperprox-install.log"

# Initialise log file — try /var/log, fall back to home dir
mkdir -p /var/log 2>/dev/null || true
if ! touch "${LOG_FILE}" 2>/dev/null; then
  LOG_FILE="${HOME}/hyperprox-install.log"
  touch "${LOG_FILE}" 2>/dev/null || LOG_FILE="/dev/null"
fi
echo "HyperProx install log — $(date -u)" > "${LOG_FILE}"

# ── Look ─────────────────────────────────────────────────────────────────────
# The shared UI block below is identical in bootstrap.sh (see its header). When bootstrap.sh runs this
# installer in the container it passes HPX_UI_NESTED (no banner, no card of its own: bootstrap shows both),
# HPX_UI_STEP_BASE and HPX_UI_STEPS, so the steps continue its count ("Step 6/10 · Docker").
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
ui_warn() {
  if [ "$UI_FANCY" -ne 1 ]; then printf '[warn] %s\n' "$1"; return; fi
  printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$1"
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
  done < <(if [ "${#1}" -le "$w" ]; then printf '%s\n' "$1"; else ui_wrap "$w" "$1"; fi)
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
ui_init
UI_LOG="${LOG_FILE}"
UI_STEPS="${HPX_UI_STEPS:-5}"; [[ "${UI_STEPS}" =~ ^[0-9]+$ ]] || UI_STEPS=5
UI_STEP="${HPX_UI_STEP_BASE:-0}"; [[ "${UI_STEP}" =~ ^[0-9]+$ ]] || UI_STEP=0
NESTED="${HPX_UI_NESTED:-}"

# ── Helpers ───────────────────────────────────────────────────────────────────
banner() {
  [[ -n "${NESTED}" ]] && return 0
  ui_banner "installer" "${INSTALL_REF:-main}"
}

step()    { ui_sub "$1"; }
ok()      { ui_ok "$1"; }
warn()    { ui_warn "$1"; }
info()    { ui_note "$1"; }
DIE_MSG=""
die()     { DIE_MSG="$1"; ui_bad "ERROR: $1"; [[ -n "${NESTED}" ]] && ui_note "Full log: ${LOG_FILE}"; exit 1; }
# On any stop that is not a success: the spinner goes, and (run on its own) the failure card says where it stopped.
on_exit() {
  local rc=$?
  ui_abort
  if [[ ${rc} -ne 0 && -z "${NESTED}" ]]; then
    ui_failure_card "${DIE_MSG:-stopped unexpectedly (exit ${rc})}" "Nothing is rolled back: re-running this installer picks up where it stopped." "${LOG_FILE}"
  fi
  exit "${rc}"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# ── Root check ────────────────────────────────────────────────────────────────
# After die() exists: before, a non-root run failed with "die: command not found" instead of the message.
[[ $EUID -ne 0 ]] && die "Run as root: sudo bash install.sh"

confirm() {
  # Default to yes when running non-interactively (curl | bash)
  if [[ ! -t 0 ]]; then return 0; fi
  if [[ "${UI_FANCY}" -eq 1 ]]; then printf '  %s› %s%s %s[Y/n]%s ' "${C_KEY}" "$1" "${C_OFF}" "${C_DIM}" "${C_OFF}"
  else printf '  %s [Y/n] ' "$1"; fi
  read -r reply
  [[ "${reply,,}" =~ ^(y|yes|)$ ]]
}

# ── Spinner ───────────────────────────────────────────────────────────────────
# Usage: run_with_spinner "Message" command [args...]
# The command's output goes to LOG_FILE; ui_run (the shared block) shows the spinner and the time taken, and on
# failure the last 20 lines of that output, before this stops the install.
run_with_spinner() {
  local msg="$1"; shift
  ui_try ui_run "${msg}" "$@"
  [[ "${UI_RC}" -eq 0 ]] || die "${msg} failed. See ${LOG_FILE} for full output."
}

# ── Environment Detection ─────────────────────────────────────────────────────
detect_environment() {
  step "Detecting environment"

  if [[ -f /etc/os-release ]]; then
    source /etc/os-release
    OS_ID="${ID}"
    OS_VERSION="${VERSION_ID}"
    OS_CODENAME="${VERSION_CODENAME:-}"
  else
    die "Cannot determine OS. Requires Debian 11, 12 or 13, or Ubuntu 22.04 or 24.04."
  fi

  case "${OS_ID}" in
    debian)
      [[ "${OS_VERSION}" == "13" || "${OS_VERSION}" == "12" || "${OS_VERSION}" == "11" ]] || die "Debian 11, 12 or 13 required. Found: Debian ${OS_VERSION}"
      PKG_CODENAME="${OS_CODENAME}"
      ;;
    ubuntu)
      [[ "${OS_VERSION}" == "22.04" || "${OS_VERSION}" == "24.04" ]] || \
        die "Ubuntu 22.04 or 24.04 required. Found: Ubuntu ${OS_VERSION}"
      PKG_CODENAME="${OS_CODENAME}"
      ;;
    *)
      die "Unsupported OS: ${OS_ID}. Requires Debian 11, 12 or 13, or Ubuntu 22.04 or 24.04."
      ;;
  esac
  ok "OS: ${OS_ID^} ${OS_VERSION}"

  # Virtualisation / container type
  VIRT_TYPE="bare-metal"
  ENV_NOTE=""

  if command -v systemd-detect-virt &>/dev/null; then
    VIRT_RAW="$(systemd-detect-virt 2>/dev/null || true)"
    case "${VIRT_RAW}" in
      lxc)
        VIRT_TYPE="lxc"
        ENV_NOTE="Proxmox LXC container"
        ;;
      kvm|qemu)
        VIRT_TYPE="vm"
        ENV_NOTE="KVM/QEMU virtual machine"
        ;;
      none)
        VIRT_TYPE="bare-metal"
        ENV_NOTE="Bare metal"
        ;;
      *)
        VIRT_TYPE="${VIRT_RAW}"
        ENV_NOTE="Virtualisation: ${VIRT_RAW}"
        ;;
    esac
  fi

  # Is this machine a Proxmox node itself?
  IS_PROXMOX_NODE=false
  if command -v pveversion &>/dev/null 2>&1; then
    IS_PROXMOX_NODE=true
    PVE_VERSION="$(pveversion | grep -oP 'pve-manager/\K[^/]+')"
    warn "This machine IS a Proxmox node (PVE ${PVE_VERSION}). Installing HyperProx here is supported but unusual."
    warn "Recommended: install HyperProx in a dedicated LXC on this node instead."
    confirm "Continue installing on the Proxmox node itself?" || die "Aborted. Create a dedicated LXC and run the installer there."
  fi

  ui_kv "Environment" "${ENV_NOTE}"

  # LXC-specific preflight
  if [[ "${VIRT_TYPE}" == "lxc" ]]; then
    # Check overlay filesystem — this is the definitive test for Docker compatibility.
    # Overlay requires both privileged container AND nesting=1 in Proxmox.
    if grep -q overlay /proc/filesystems 2>/dev/null; then
      ok "LXC container: privileged + nesting ✓"
    else
      warn "overlay filesystem not available — Docker will fail."
      warn "Fix in Proxmox (run on your Proxmox node):"
      warn "  pct set <CTID> --features keyctl=1,nesting=1 && pct reboot <CTID>"
      warn "Also ensure the container is set to Unprivileged: No in Options."
      confirm "Continue anyway?" || die "Aborted. Re-run after fixing LXC configuration."
    fi
  fi
}

# ── Network Configuration ─────────────────────────────────────────────────────
# True when $1 (a resolv.conf) sends lookups to Tailscale's MagicDNS resolver, 100.100.100.100 or its IPv6
# twin. Only nameserver lines count. The old test grepped the whole file for "ts.net", so a container
# resolving through 1.1.1.1 that merely inherited a tailnet search domain from its Proxmox host (or a
# comment naming Tailscale) was "fixed" too. A search domain on its own breaks nothing.
resolv_uses_magicdns() {
  grep -qE '^[[:space:]]*nameserver[[:space:]]+(100\.100\.100\.100|fd7a:115c:a1e0::53)([[:space:]]|$)' "$1" 2>/dev/null
}

configure_network() {
  # Fix broken DNS: Proxmox can hand a container its host's Tailscale resolver, which answers nothing
  # unless Tailscale also runs in the container. Where it does run, MagicDNS works and is left alone.
  if resolv_uses_magicdns /etc/resolv.conf && ! systemctl is-active --quiet tailscaled 2>/dev/null; then
    warn "Detected the Tailscale DNS resolver without Tailscale running here — replacing with public resolvers"
    cat > /etc/resolv.conf <<'EOF'
nameserver 1.1.1.1
nameserver 8.8.8.8
EOF
    ok "DNS fixed"
  fi

  # Only relevant inside an LXC — bare metal / VM manage networking externally
  [[ "${VIRT_TYPE}" != "lxc" ]] && return

  step "Configuring network"

  # Detect current interface, IP, gateway
  local iface gateway current_ip
  iface="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' || echo 'eth0')"
  current_ip="$(ip -4 addr show "${iface}" 2>/dev/null | grep -oP '(?<=inet )\S+' | head -1)"
  gateway="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'via \K\S+' || echo '')"

  if [[ -z "${current_ip}" ]]; then
    warn "Could not detect current IP address — skipping network config"
    return
  fi

  ok "Current IP: ${current_ip} via ${gateway} on ${iface}"

  # In a Proxmox container the address belongs to Proxmox: it writes /etc/network/interfaces from the
  # container's net0 at every start, so an address written here would be gone after the next restart while
  # HyperProx kept using it. Nothing is written here; the exact command for the node is shown instead.
  if grep -qE 'inet6? dhcp' /etc/network/interfaces 2>/dev/null; then
    lxc_static_advice "${iface}" "${current_ip}" "${gateway}"
  else
    ok "Static address ${current_ip} (set in Proxmox)"
  fi
}

# lxc_static_advice IFACE CIDR GATEWAY: how to keep this address, run on the Proxmox node.
lxc_static_advice() {
  local mac
  mac="$(cat "/sys/class/net/$1/address" 2>/dev/null || echo '<its MAC>')"
  warn "This container gets its address by DHCP (${2%%/*} now), so it can change, and HyperProx's address with it."
  info "To keep ${2}, run this on the Proxmox node (with this container's ID and its bridge), then restart the container:"
  info "  pct set <ID> --net0 name=$1,bridge=vmbr0,hwaddr=${mac},ip=${2}${3:+,gw=$3}"
  info "Or reserve ${2%%/*} for MAC ${mac} in your router's DHCP. HyperProx follows an address change on its next update."
}

# ── System Update + Prerequisites ─────────────────────────────────────────────
install_prerequisites() {
  step "Installing system prerequisites"

  run_with_spinner "Updating apt" apt-get update -qq

  local pkgs=(curl wget git gnupg lsb-release ca-certificates
              apt-transport-https openssl jq unzip build-essential
              python3)   # the keyholder (bin/hyperprox-keyholder) is a python3 standard-library script
  # Not packaged on Debian 13 (trixie) and nothing below needs it; install it only where it exists.
  if apt-cache show software-properties-common >/dev/null 2>&1; then
    pkgs+=(software-properties-common)
  fi

  run_with_spinner "Installing packages" \
    apt-get install -y -qq "${pkgs[@]}"

  ok "System packages installed"
}

# ── Disable AppArmor (LXC incompatible) ──────────────────────────────────────
disable_apparmor() {
  [[ "${VIRT_TYPE}" != "lxc" ]] && return

  if systemctl is-active --quiet apparmor 2>/dev/null || systemctl is-enabled --quiet apparmor 2>/dev/null; then
    step "Disabling AppArmor"
    info "AppArmor is not supported in LXC containers — disabling to allow Docker to run..."
    systemctl stop apparmor 2>/dev/null || true
    systemctl disable apparmor 2>/dev/null || true
    # Unload all AppArmor profiles
    if command -v aa-teardown &>/dev/null; then
      aa-teardown 2>/dev/null || true
    fi
    ok "AppArmor disabled"
  fi
}

# ── Docker CE ─────────────────────────────────────────────────────────────────
install_docker() {
  step "Installing Docker CE"

  if command -v docker &>/dev/null; then
    DOCKER_VERSION="$(docker --version | grep -oP '\d+\.\d+\.\d+')"
    ok "Docker already installed: ${DOCKER_VERSION} — skipping"
    return
  fi

  info "Adding Docker GPG key..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>>"${LOG_FILE}"
  chmod a+r /etc/apt/keyrings/docker.gpg

  info "Adding Docker apt repository..."
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${OS_ID} ${PKG_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  run_with_spinner "Updating apt (Docker repo)" apt-get update -qq

  run_with_spinner "Installing Docker CE" \
    apt-get install -y -qq \
      docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin

  if [[ "${VIRT_TYPE}" == "lxc" ]]; then
    info "Configuring Docker daemon for LXC environment..."
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<'EOF'
{
  "storage-driver": "overlay2",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "no-new-privileges": false
}
EOF
  fi

  info "Starting Docker daemon..."
  systemctl enable docker --quiet
  # Installing docker-ce starts the daemon with its defaults (Docker 29: the containerd image store). It must be
  # RESTARTED so the daemon.json above is in force before anything is pulled; otherwise every image and container
  # lands in a store the daemon stops reading at the next reboot, and HyperProx comes back with no containers.
  systemctl restart docker

  ui_try ui_run "Docker smoke test (hello-world)" docker run --rm hello-world
  [[ "${UI_RC}" -eq 0 ]] || die "Docker installed but test container failed. Check LXC nesting settings."
  ok "Docker CE installed and working"
}

# ── Node.js + pnpm ────────────────────────────────────────────────────────────
install_node() {
  step "Installing Node.js ${NODE_VERSION} LTS + pnpm"

  if command -v node &>/dev/null; then
    CURRENT_NODE="$(node --version | grep -oP '\d+' | head -1)"
    if [[ "${CURRENT_NODE}" -ge "${NODE_VERSION}" ]]; then
      ok "Node.js already installed: $(node --version) — skipping"
    else
      warn "Node.js $(node --version) found but ${NODE_VERSION}+ required — upgrading"
      _install_node_nodesource
    fi
  else
    _install_node_nodesource
  fi

  if command -v pnpm &>/dev/null && [[ "$(pnpm --version 2>/dev/null | cut -d. -f1)" -ge "${PNPM_VERSION}" ]]; then
    ok "pnpm already installed: $(pnpm --version)"
  else
    run_with_spinner "Installing pnpm" \
      npm install -g "pnpm@${PNPM_VERSION}"
    ok "pnpm $(pnpm --version) installed"
  fi
}

_install_node_nodesource() {
  run_with_spinner "Configuring NodeSource repo" \
    bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -"

  run_with_spinner "Installing Node.js" \
    apt-get install -y -qq nodejs

  ok "Node.js $(node --version) installed"
}

# ── Clone Repo ────────────────────────────────────────────────────────────────
clone_repo() {
  step "Cloning HyperProx repository"

  if [[ -d "${HYPERPROX_DIR}/.git" ]]; then
    # The README's way is to clone first and run this from the clone: that is not a surprise worth a warning.
    if [[ "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" == "$(cd "${HYPERPROX_DIR}" && pwd -P)" ]]; then
      ok "Installing from this clone (${HYPERPROX_DIR})"
    else
      ok "Found the HyperProx code at ${HYPERPROX_DIR}; bringing it up to date"
    fi
    if [[ -n "${INSTALL_REF}" ]]; then
      if [[ -z "$(git -C "${HYPERPROX_DIR}" status --porcelain --untracked-files=no)" ]]; then checkout_ref
      else warn "Local changes in ${HYPERPROX_DIR}: not moving it to ${INSTALL_REF} — installing the code that is there"; fi
      return
    fi
    # No question here: an install always wants the current code. Fast-forward only, so local edits are never overwritten.
    if git -C "${HYPERPROX_DIR}" pull --ff-only --quiet >>"${LOG_FILE}" 2>&1; then
      ok "Repository updated"
    else
      warn "Could not fast-forward ${HYPERPROX_DIR} (local changes?) — installing the code that is there"
    fi
    return
  fi

  if [[ -d "${HYPERPROX_DIR}" ]]; then
    warn "${HYPERPROX_DIR} exists but is not a git repo — removing"
    rm -rf "${HYPERPROX_DIR}"
  fi

  run_with_spinner "Cloning repository" \
    git clone --quiet "${REPO_URL}" "${HYPERPROX_DIR}"

  ok "Cloned to ${HYPERPROX_DIR}"
  checkout_ref
}

# --ref: a branch is checked out as that branch, tracking origin, so the in-app updater follows it; a tag or
# commit puts main at it. Staying on a branch (not a detached HEAD) keeps a later install.sh, a `git pull` and
# the in-app updater working.
INSTALL_BRANCH=""
checkout_ref() {
  [[ -n "${INSTALL_REF}" ]] || return 0
  [[ "${INSTALL_REF}" =~ ^[A-Za-z0-9._/-]{1,100}$ && "${INSTALL_REF}" != *..* && "${INSTALL_REF}" != -* ]] \
    || die "--ref must be a tag, branch or commit id"
  git -C "${HYPERPROX_DIR}" fetch --quiet --tags origin >>"${LOG_FILE}" 2>&1 || true
  if [[ "${INSTALL_REF}" != main ]] && git -C "${HYPERPROX_DIR}" show-ref --verify --quiet "refs/remotes/origin/${INSTALL_REF}" \
     && ! git -C "${HYPERPROX_DIR}" show-ref --verify --quiet "refs/tags/${INSTALL_REF}"; then
    git -C "${HYPERPROX_DIR}" checkout --quiet -B "${INSTALL_REF}" --track "origin/${INSTALL_REF}" >>"${LOG_FILE}" 2>&1 \
      || die "Could not check out ${INSTALL_REF}"
    INSTALL_BRANCH="${INSTALL_REF}"
    ok "On branch ${INSTALL_REF} ($(git -C "${HYPERPROX_DIR}" rev-parse --short=7 HEAD))"
    return 0
  fi
  local sha
  sha="$(git -C "${HYPERPROX_DIR}" rev-parse --verify --quiet "${INSTALL_REF}^{commit}" \
      || git -C "${HYPERPROX_DIR}" rev-parse --verify --quiet "origin/${INSTALL_REF}^{commit}" || true)"
  [[ -n "$sha" ]] || die "${INSTALL_REF} is not a tag, branch or commit in ${REPO_URL}"
  git -C "${HYPERPROX_DIR}" checkout --quiet -B main "$sha" >>"${LOG_FILE}" 2>&1 \
    || die "Could not check out ${INSTALL_REF}"
  ok "Pinned to ${INSTALL_REF} ($(git -C "${HYPERPROX_DIR}" rev-parse --short=7 HEAD))"
}

# ── Install Dependencies + Build ───────────────────────────────────────────────
build_app() {
  [[ "${SKIP_BUILD}" == "true" ]] && { warn "Skipping build (--no-build flag)"; return; }

  step "Installing dependencies"
  cd "${HYPERPROX_DIR}"
  info "The first run downloads every package; it can take a few minutes."
  run_with_spinner "Installing npm packages" \
    pnpm install --frozen-lockfile
  ok "Dependencies installed"

  step "Building API"
  cd "${HYPERPROX_DIR}/apps/api"
  # The API's TypeScript needs the generated Prisma client (Prisma.DbNull, typed transactions).
  # Generating it reads only the schema file — no database needed — so it must happen before the build.
  run_with_spinner "Generating Prisma client" \
    npx prisma generate --schema ./prisma/schema.prisma
  run_with_spinner "Building API" pnpm build
  ok "API built"

  step "Building Frontend"
  cd "${HYPERPROX_DIR}/apps/frontend"

  # NEXT_PUBLIC_* vars are baked in at build time — validate they exist
  source "${HYPERPROX_DIR}/.env"
  [[ -z "${NEXT_PUBLIC_API_URL:-}" ]] && die "NEXT_PUBLIC_API_URL is not set in .env — cannot build frontend"
  [[ -z "${NEXT_PUBLIC_WS_URL:-}" ]]  && die "NEXT_PUBLIC_WS_URL is not set in .env — cannot build frontend"
  # FIX: Write .env.production so NEXT_PUBLIC_ vars are baked into the Next.js build
  grep '^NEXT_PUBLIC_' "${HYPERPROX_DIR}/.env" > .env.production

  info "The web app is the slow part: typically 3 to 5 minutes."
  run_with_spinner "Building Frontend" pnpm build

  info "Copying static assets to standalone output..."
  SRC="${HYPERPROX_DIR}/apps/frontend/.next/static"
  DEST="${HYPERPROX_DIR}/apps/frontend/.next/standalone/apps/frontend/.next/static"
  mkdir -p "$(dirname "${DEST}")"
  cp -r "${SRC}" "${DEST}"

  if [[ -d "${HYPERPROX_DIR}/apps/frontend/public" ]]; then
    cp -r "${HYPERPROX_DIR}/apps/frontend/public" \
      "${HYPERPROX_DIR}/apps/frontend/.next/standalone/apps/frontend/public" 2>/dev/null || true
  fi
  ok "Frontend built"
}

# prometheus_size FREE_GB: the retention size in GB for that much free disk.
prometheus_size() { local q=$(( ${1:-0} / 4 )); [[ $q -ge 2 ]] || q=2; [[ $q -le 40 ]] || q=40; echo "$q"; }

# ── Generate .env ─────────────────────────────────────────────────────────────
configure_env() {
  step "Generating environment configuration"

  ENV_FILE="${HYPERPROX_DIR}/.env"

  if [[ -f "${ENV_FILE}" ]]; then
    warn ".env already exists — preserving existing configuration"
    # The setup key is removed once setup is done. If setup has not finished, make sure there is one,
    # so the wizard link below works.
    if ! grep -q '^SETUP_COMPLETE=true' "${ENV_FILE}" && ! grep -q '^SETUP_SECRET=.' "${ENV_FILE}"; then
      sed -i '/^SETUP_SECRET=/d' "${ENV_FILE}"
      echo "SETUP_SECRET=$(openssl rand -hex 32)" >> "${ENV_FILE}"
      ok "Made a new setup key (setup has not finished yet)"
    fi
    return
  fi

  HOST_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"

  # Prometheus may keep up to a quarter of the free disk, between 2 and 40 GB (a fixed 40 GB overfilled small disks).
  local free_gb
  free_gb="$(df -BG --output=avail "$(dirname "${HYPERPROX_DIR}")" 2>/dev/null | awk 'NR==2 { gsub("G", ""); print $1 + 0 }')"
  PROM_SIZE="$(prometheus_size "${free_gb:-0}")"

  AES_KEY="$(openssl rand -hex 32)"
  JWT_SECRET="$(openssl rand -hex 32)"
  SETUP_SECRET="$(openssl rand -hex 32)"
  DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)"
  GRAFANA_ADMIN_PASSWORD="$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)"
  GRAFANA_SECRET_KEY="$(openssl rand -hex 32)"

  cat > "${ENV_FILE}" <<EOF
# =============================================================================
# HyperProx Environment Configuration
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Edit this file to configure HyperProx, then restart services.
# =============================================================================

# ── App ───────────────────────────────────────────────────────────────────────
NODE_ENV=production
HOST_IP=${HOST_IP}
API_HOST=localhost
SETUP_PORT=${SETUP_PORT}
API_PORT=${API_PORT}
FRONTEND_PORT=${FRONTEND_PORT}

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://hyperprox:${DB_PASSWORD}@localhost:5432/hyperprox
POSTGRES_USER=hyperprox
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=hyperprox

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=

# ── Security ──────────────────────────────────────────────────────────────────
# ENCRYPTION_KEY and JWT_SECRET are legacy. Credentials and sessions now live behind the vault gate; the
# first owner unlock migrates stored credentials into the vault, reads them back, and only then blanks
# these lines. No plaintext copy is kept.
# The vault settings (VAULT_*) are added further down by the installer.
ENCRYPTION_KEY=${AES_KEY}
JWT_SECRET=${JWT_SECRET}
# The key in the setup wizard's link. Removed from this file once setup is done.
SETUP_SECRET=${SETUP_SECRET}

# ── Grafana ───────────────────────────────────────────────────────────────────
# GRAFANA_ADMIN_PASSWORD is read only when Grafana first sets up its database. The first owner sign-in
# moves it into the vault and takes it out of this file. GRAFANA_SECRET_KEY stays: Grafana needs it on
# every start, before HyperProx is unlocked.
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
GRAFANA_SECRET_KEY=${GRAFANA_SECRET_KEY}

# ── Monitoring ────────────────────────────────────────────────────────────────
PROMETHEUS_RETENTION=90d
PROMETHEUS_RETENTION_SIZE=${PROM_SIZE}GB

# ── Docker Compose ────────────────────────────────────────────────────────────
# Optional parts of docker-compose.yml to run: monitoring (Prometheus, Grafana, PVE exporter) and ai (a
# local Ollama). docker compose reads this itself; the setup wizard rewrites it from your choices.
COMPOSE_PROFILES=monitoring

# ── Proxmox (filled in by setup wizard) ──────────────────────────────────────
PROXMOX_HOST=
PROXMOX_PORT=8006
PROXMOX_USER=
PROXMOX_TOKEN_ID=
PROXMOX_TOKEN_SECRET=
PROXMOX_PUBLIC_URL=

# ── Frontend public URLs ──────────────────────────────────────────────────────
# Everything is served through nginx on https://${HOST_IP}/ (see config/nginx).
NEXT_PUBLIC_API_URL=https://${HOST_IP}/api
NEXT_PUBLIC_WS_URL=wss://${HOST_IP}/ws

# ── Cluster identity ──────────────────────────────────────────────────────────
# Display name shown in the sidebar
NEXT_PUBLIC_CLUSTER_NAME="My Cluster"

# Grafana embed URL — must be reachable from the user's browser. The Monitoring page embeds it, and an
# http iframe on the https app is blocked, so it is served on the same origin at /grafana/.
NEXT_PUBLIC_GRAFANA_URL=/grafana
GRAFANA_ROOT_URL=https://${HOST_IP}/grafana/
GRAFANA_SERVE_FROM_SUB_PATH=true

# The Proxmox node name to use for CEPH status/OSD queries
# Auto-detected during setup wizard — override here if needed
CEPH_MON_NODE=

# ── AI providers (all optional) ───────────────────────────────────────────────
# The deployment wizard can plan against Anthropic, OpenAI, or a local Ollama.
# These are seeded into the encrypted credential store on first run; after that
# the store is the source of truth and these lines are ignored. Setting any of
# them here is a convenience for unattended installs — the AI page is the
# ordinary way to enter them, and nothing here is required to start HyperProx.
#
# ANTHROPIC_API_KEY=
# ANTHROPIC_MODEL=claude-opus-5
#
# OPENAI_API_KEY=
# OPENAI_MODEL=gpt-4o
# OPENAI_BASE_URL=https://api.openai.com/v1   # or OpenRouter, Groq, a local server
#
# OLLAMA_URL=http://your-ollama-host:11434
# OLLAMA_MODEL=qwen3:8b

# ── Setup wizard state ────────────────────────────────────────────────────────
SETUP_COMPLETE=false
EOF

  chmod 600 "${ENV_FILE}"
  ok "Generated .env at ${ENV_FILE}"
  info "Proxmox credentials will be configured through the setup wizard"
}

# ── Where updates come from ───────────────────────────────────────────────────
# The in-app updater (Updates page) follows the source this install came from: HYPERPROX_REPO_URL's mirror or
# fork, and the branch --ref named (a tag or commit follows main). Written when missing, and replaced when this
# run was told a source; a re-run with neither keeps what is there.
set_env_line() {  # set_env_line <file> <KEY> <value>: replace the KEY= line, or append it
  local f="$1" k="$2" v="$3"
  if grep -qE "^${k}=" "$f" 2>/dev/null; then
    local tmp; tmp="$(mktemp "${f}.XXXX")"
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$f" > "$tmp" && cat "$tmp" > "$f"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

configure_update_source() {
  local f="${ENV_FILE:-${HYPERPROX_DIR}/.env}" branch
  [[ -f "$f" ]] || return 0
  branch="${INSTALL_BRANCH:-$(git -C "${HYPERPROX_DIR}" symbolic-ref --short -q HEAD 2>/dev/null || echo main)}"
  [[ -n "$branch" ]] || branch=main
  if [[ -n "${HYPERPROX_REPO_URL:-}" ]] || ! grep -qE '^HYPERPROX_UPDATE_REPO=' "$f"; then
    set_env_line "$f" HYPERPROX_UPDATE_REPO "${REPO_URL}"
  fi
  if [[ -n "${HYPERPROX_REF:-}" ]] || ! grep -qE '^HYPERPROX_UPDATE_BRANCH=' "$f"; then
    set_env_line "$f" HYPERPROX_UPDATE_BRANCH "${branch}"
  fi
  ok "Updates follow $(grep -m1 '^HYPERPROX_UPDATE_REPO=' "$f" | cut -d= -f2-) ($(grep -m1 '^HYPERPROX_UPDATE_BRANCH=' "$f" | cut -d= -f2-))"
}

# ── Vault gate settings ───────────────────────────────────────────────────────
# Idempotent: runs for fresh installs and for existing .env files that predate the vault. Existing values
# are never overwritten, so re-running the installer keeps the admin token that is already in force.
VAULT_IMAGE="vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055"

env_has() { grep -qE "^$1=" "${ENV_FILE}" 2>/dev/null; }

# Argon2id PHC hash of $1, produced by Vaultwarden's own `hash` tool from the pinned image. The tool
# insists on a terminal for its password prompt, so it runs under script(1) with the token piped in.
vault_token_hash() {
  local token="$1" out
  out="$(printf '%s\n%s\n' "${token}" "${token}" \
    | script -qec "docker run --rm -it ${VAULT_IMAGE} /vaultwarden hash --preset bitwarden" /dev/null 2>>"${LOG_FILE}" \
    | tr -d '\r')" || true
  printf '%s' "${out}" | grep -oP "ADMIN_TOKEN='\K[^']+" | head -1
}

configure_vault_env() {
  step "Configuring the vault gate"
  ENV_FILE="${HYPERPROX_DIR}/.env"
  [[ -f "${ENV_FILE}" ]] || die ".env not found at ${ENV_FILE}"

  # The vault is served over TLS on loopback (the Bitwarden CLI refuses plain http). Self-signed, made once,
  # never replaced. Cert is world-readable; the key is root-only (the container runs as root).
  local tls="${HYPERPROX_DIR}/config/vault-tls"
  mkdir -p "${tls}"; chmod 755 "${tls}"
  if [[ ! -s "${tls}/cert.pem" || ! -s "${tls}/key.pem" ]]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj /CN=hyperprox-vault -addext subjectAltName=IP:127.0.0.1,DNS:localhost \
      -keyout "${tls}/key.pem" -out "${tls}/cert.pem" >>"${LOG_FILE}" 2>&1 \
      || die "Could not generate the vault TLS certificate (see ${LOG_FILE})"
    ok "Generated the vault's loopback TLS certificate"
  fi
  chmod 644 "${tls}/cert.pem"; chmod 600 "${tls}/key.pem"

  local added=false
  if ! env_has VAULT_ADMIN_TOKEN_HASH; then
    local token hash
    token="$(openssl rand -hex 24)"
    ui_try ui_run "Pulling the pinned Vaultwarden image" docker pull --quiet "${VAULT_IMAGE}"
    [[ "${UI_RC}" -eq 0 ]] || die "Could not pull ${VAULT_IMAGE}"
    hash="$(vault_token_hash "${token}")"
    [[ "${hash}" == \$argon2id\$* ]] || die "Could not generate the vault admin token hash (see ${LOG_FILE})"
    {
      echo ""
      echo "# ── Vault (Vaultwarden) ───────────────────────────────────────────────────────"
      echo "# VAULT_ADMIN_TOKEN opens the vault's /admin page on 127.0.0.1:8222. That page manages users and"
      echo "# settings, NOT vault contents (those are end-to-end encrypted). Keep it private."
      echo "VAULT_ADMIN_TOKEN=${token}"
      # Single quotes: the hash is full of '\$', which docker compose would otherwise try to expand.
      echo "VAULT_ADMIN_TOKEN_HASH='${hash}'"
    } >> "${ENV_FILE}"
    added=true
  fi
  # An earlier build of this installer wrote a plain-http URL; the vault now speaks only https.
  sed -i 's|^VAULT_URL=http://127.0.0.1:8222$|VAULT_URL=https://127.0.0.1:8222|' "${ENV_FILE}"
  env_has VAULT_URL || { echo "VAULT_URL=https://127.0.0.1:8222" >> "${ENV_FILE}"; added=true; }
  env_has VAULT_CA_CERT || { echo "VAULT_CA_CERT=${tls}/cert.pem" >> "${ENV_FILE}"; added=true; }
  # Empty = Send links and invitations use the loopback origin. Set to the https address people can reach.
  env_has VAULT_PUBLIC_URL || { echo "VAULT_PUBLIC_URL=" >> "${ENV_FILE}"; added=true; }
  env_has VAULT_IDLE_LOCK_MINUTES || { echo "VAULT_IDLE_LOCK_MINUTES=30" >> "${ENV_FILE}"; added=true; }
  # The address people open HyperProx at: notification messages link to it (docs/notifications.md).
  # Where notifications and lock alerts go is set under Settings → Notifications, not here; an existing
  # LOCK_ALERT_* line is moved onto a channel once, at the first start, and then no longer read.
  env_has HYPERPROX_PUBLIC_URL || { echo "HYPERPROX_PUBLIC_URL=" >> "${ENV_FILE}"; added=true; }
  chmod 600 "${ENV_FILE}"
  [[ "${added}" == "true" ]] && ok "Vault settings written to .env" || ok "Vault settings already present"
}

# ── Per-install configuration ─────────────────────────────────────────────────
# bin/hyperprox-config: METRICS_TOKEN (generated once, never rotated) and its copy for Prometheus,
# config/pve-exporter/pve.yml, no retired npm profile, Grafana behind nginx at /grafana/. The same step
# deploy.sh runs on every update, so a re-run of this installer and an update agree. Idempotent.
apply_install_config() {
  step "Checking per-install configuration"
  HYPERPROX_DIR="${HYPERPROX_DIR}" bash "${HYPERPROX_DIR}/bin/hyperprox-config" \
    || die "bin/hyperprox-config failed (see above)"
  ok "Per-install configuration is up to date"
}

# ── Docker Compose Stack ───────────────────────────────────────────────────────
# The repo's docker-compose.yml is the only compose file. This installer used to carry its own copy in a
# heredoc, written only when the clone had none - which a clone always has - so the copy was never used and
# drifted unnoticed. Per-install choices live in .env; the profiles are the one this step makes sure of.
configure_compose() {
  step "Checking the Docker Compose stack"
  cd "${HYPERPROX_DIR}"
  [[ -f docker-compose.yml ]] || die "docker-compose.yml is missing from ${HYPERPROX_DIR} — is this a HyperProx clone?"

  # An .env from before COMPOSE_PROFILES: keep what the setup wizard was told, else monitoring as before.
  if ! env_has COMPOSE_PROFILES; then
    local profiles="monitoring"
    if env_has INSTALL_PROMETHEUS; then
      profiles=""
      grep -qE '^INSTALL_(PROMETHEUS|GRAFANA)=true' "${ENV_FILE}" && profiles="monitoring"
    fi
    printf '\n# Optional compose profiles (monitoring, ai); docker compose reads this itself.\nCOMPOSE_PROFILES=%s\n' "${profiles}" >> "${ENV_FILE}"
    ok "Compose profiles: ${profiles:-none}"
  fi

  docker compose config -q >>"${LOG_FILE}" 2>&1 || die "docker-compose.yml does not validate with this .env (see ${LOG_FILE})"
  ok "docker-compose.yml validates"
}

# ── Prometheus + Grafana base config ──────────────────────────────────────────
write_monitoring_config() {
  step "Writing monitoring base configuration"

  # Preserve an existing prometheus.yml on reinstall. It is tracked in git, so a fresh clone has the shipped one:
  # only a file that differs from it is "yours".
  if [[ -f "${HYPERPROX_DIR}/config/prometheus/prometheus.yml" ]]; then
    if git -C "${HYPERPROX_DIR}" diff --quiet -- config/prometheus/prometheus.yml 2>/dev/null; then
      ok "Prometheus config: the shipped one"
    else
      warn "Prometheus config has local changes — keeping them"
    fi
  else
    mkdir -p "${HYPERPROX_DIR}/config/prometheus/targets"
    mkdir -p "${HYPERPROX_DIR}/config/prometheus/rules"

    # FIX: job name 'node' (not 'node_exporter') — matches alert rules and
    # existing HyperProx API references
    cat > "${HYPERPROX_DIR}/config/prometheus/prometheus.yml" <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: hyperprox

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['127.0.0.1:9090']

  - job_name: node
    scrape_interval: 60s
    scrape_timeout: 30s
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/nodes.json
        refresh_interval: 30s
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
      - source_labels: [node]
        target_label: node

  - job_name: pve
    metrics_path: /pve
    params:
      module: [default]
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/pve.json
        refresh_interval: 30s
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: 127.0.0.1:9221

  - job_name: ceph
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/ceph.json
        refresh_interval: 30s

  - job_name: nvidia
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/nvidia.json
        refresh_interval: 30s
EOF

    ok "Prometheus config written"
  fi

  # Target files are DEPLOYMENT-SPECIFIC and must never be inherited from the
  # repo. This seeding used to live in the else-branch above, which is
  # unreachable on a fresh install: prometheus.yml is tracked, so a clone always
  # has it, the guard takes the "preserve" path, and the target files shipped in
  # git survived — every new install started with the dev cluster's node IPs as
  # scrape targets. The four files have since been untracked; this seeds any
  # that are missing and never overwrites one that is already populated.
  # intel-gpu.json was also absent from the original list.
  mkdir -p "${HYPERPROX_DIR}/config/prometheus/targets"
  for _t in nodes pve ceph nvidia intel-gpu; do
    if [[ ! -f "${HYPERPROX_DIR}/config/prometheus/targets/${_t}.json" ]]; then
      echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/${_t}.json"
    fi
  done

  # Grafana's provisioning (datasource, dashboards) ships in the repo under config/grafana/provisioning,
  # which is what docker-compose.yml mounts. Nothing to write.

  # config/pve-exporter/pve.yml and the plug-in scrape's METRICS_TOKEN are made by bin/hyperprox-config
  # (apply_install_config), which deploy.sh runs too.
}

# ── TLS for the front door ────────────────────────────────────────────────────
# nginx serves HyperProx on https://<host>/ with certs/cert.pem + certs/key.pem. Supply your own (full chain
# in cert.pem) and they are used as they are; otherwise a self-signed one is made here, once, and kept.
configure_tls() {
  step "Configuring HTTPS"
  local dir="${HYPERPROX_DIR}/certs" host_ip
  mkdir -p "${dir}"; chmod 755 "${dir}"
  # Reverse proxies whose X-Forwarded-Proto nginx believes; empty means loopback only (see README, HTTPS).
  mkdir -p "${HYPERPROX_DIR}/data/nginx/trusted-proxies"
  if [[ -s "${dir}/cert.pem" && -s "${dir}/key.pem" ]]; then
    ok "Using the certificate in ${dir}"
  else
    host_ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"
    local san="DNS:$(hostname),DNS:localhost,IP:127.0.0.1"
    [[ -n "${host_ip}" ]] && san="IP:${host_ip},${san}"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj "/CN=$(hostname)" -addext "subjectAltName=${san}" \
      -keyout "${dir}/key.pem" -out "${dir}/cert.pem" >>"${LOG_FILE}" 2>&1 \
      || die "Could not generate the HTTPS certificate (see ${LOG_FILE})"
    ok "Generated a self-signed certificate (${san})"
    info "Browsers will warn once. To use your own, replace ${dir}/cert.pem and key.pem, then: docker restart hyperprox-nginx"
  fi
  chmod 644 "${dir}/cert.pem"; chmod 600 "${dir}/key.pem"
}

# ── Systemd Services ──────────────────────────────────────────────────────────
write_systemd_services() {
  step "Creating systemd service units"

  cat > /etc/systemd/system/hyperprox-api.service <<EOF
[Unit]
Description=HyperProx API (Fastify)
# The vault is the sign-in gate: there is no HyperProx without it. ExecStartPre refuses to start the
# API (with a clear journal message) until the vault answers.
After=network.target docker.service
Wants=docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${HYPERPROX_DIR}/apps/api
EnvironmentFile=${HYPERPROX_DIR}/.env
# Reached through nginx on loopback; takes effect once the API reads API_BIND (it binds every interface now).
Environment=API_BIND=127.0.0.1
TimeoutStartSec=120
ExecStartPre=${HYPERPROX_DIR}/bin/wait-for-vault
ExecStart=$(which node) dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hyperprox-api

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/hyperprox-frontend.service <<EOF
[Unit]
Description=HyperProx Frontend (Next.js)
After=network.target hyperprox-api.service

[Service]
Type=simple
User=root
WorkingDirectory=${HYPERPROX_DIR}/apps/frontend/.next/standalone/apps/frontend
EnvironmentFile=${HYPERPROX_DIR}/.env
Environment=PORT=${FRONTEND_PORT}
# Loopback only: browsers reach the frontend through nginx on https://<host>/.
Environment=HOSTNAME=127.0.0.1
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hyperprox-frontend

[Install]
WantedBy=multi-user.target
EOF

  # Setup wizard — Restart=on-failure is intentional: it stops once setup
  # is complete and SETUP_COMPLETE=true, and should not restart after that.
  cat > /etc/systemd/system/hyperprox-setup.service <<EOF
[Unit]
Description=HyperProx Setup Wizard
After=network.target hyperprox-api.service

[Service]
Type=simple
User=root
WorkingDirectory=${HYPERPROX_DIR}/apps/setup
EnvironmentFile=${HYPERPROX_DIR}/.env
Environment=PORT=${SETUP_PORT}
# Loopback only: the wizard is served through nginx at https://<host>/setup.
Environment=SETUP_BIND=127.0.0.1
ExecStart=$(which node) setup.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hyperprox-setup

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  # The same loopback drop-ins deploy.sh keeps in place (a re-run over an old install has old units).
  bash "${HYPERPROX_DIR}/bin/hyperprox-bind" || die "bin/hyperprox-bind failed (see above)"
  ok "Systemd units created"
}

# ── CLI ───────────────────────────────────────────────────────────────────────
install_cli() {
  step "Installing the hyperprox command"
  chmod +x "${HYPERPROX_DIR}/bin/hyperprox" "${HYPERPROX_DIR}/bin/wait-for-vault" \
    "${HYPERPROX_DIR}/bin/hyperprox-keyholder" "${HYPERPROX_DIR}/bin/install-keyholder"
  ln -sf "${HYPERPROX_DIR}/bin/hyperprox" /usr/local/bin/hyperprox
  ok "hyperprox status | hyperprox lock"
}

wait_postgres() {   # at most a minute
  local i
  for i in $(seq 1 30); do
    docker exec hyperprox-postgres pg_isready -U hyperprox >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ── Database Migration ────────────────────────────────────────────────────────
run_migrations() {
  step "Running database migrations"

  ui_try ui_run "Waiting for PostgreSQL" wait_postgres
  [[ "${UI_RC}" -eq 0 ]] || die "PostgreSQL did not become ready in time"

  cd "${HYPERPROX_DIR}/apps/api"
  source "${HYPERPROX_DIR}/.env"
  export DATABASE_URL
  run_with_spinner "Generating Prisma client" \
    npx prisma generate --schema ./prisma/schema.prisma
  run_with_spinner "Running Prisma migrations" \
    npx prisma migrate deploy --schema ./prisma/schema.prisma
  ok "Database migrations applied"
}

# compose_progress: "<images here> <images in the stack>", for the pull's progress bar.
compose_progress() {
  local imgs n=0 t=0 i
  imgs="$(cd "${HYPERPROX_DIR}" && docker compose config --images 2>/dev/null | sort -u)"
  for i in ${imgs}; do t=$((t + 1)); docker image inspect "${i}" >/dev/null 2>&1 && n=$((n + 1)); done
  echo "${n} ${t}"
}

# ── Start Everything ──────────────────────────────────────────────────────────
start_services() {
  step "Starting the vault"
  cd "${HYPERPROX_DIR}"
  run_with_spinner "Starting the vault" \
    docker compose up -d --quiet-pull vault
  VAULT_URL=https://127.0.0.1:8222 VAULT_CA_CERT="${HYPERPROX_DIR}/config/vault-tls/cert.pem" VAULT_WAIT_SECONDS=90 \
    ui_try ui_run "Waiting for the vault to answer" "${HYPERPROX_DIR}/bin/wait-for-vault"
  [[ "${UI_RC}" -eq 0 ]] || die "The vault did not start. HyperProx cannot run without it. See: docker logs hyperprox-vault"
  ok "Vault is up on https://127.0.0.1:8222"

  step "Starting Docker stack"
  # Pulled first, with a bar: how many of the stack's images are here already. Then started.
  UI_PROGRESS=compose_progress run_with_spinner "Pulling images" docker compose pull --quiet
  run_with_spinner "Starting containers (postgres, redis, nginx and the COMPOSE_PROFILES in .env)" \
    docker compose up -d --quiet-pull
  ok "Docker stack started"

  run_migrations

  step "Starting HyperProx services"
  # The keyholder holds the unlocked vault state, so API restarts (deploys) do not lock HyperProx.
  info "Installing the keyholder..."
  bash "${HYPERPROX_DIR}/bin/install-keyholder" || die "The keyholder could not be installed (see above)"
  systemctl enable hyperprox-api hyperprox-frontend hyperprox-setup --quiet

  info "Starting hyperprox-api..."
  systemctl restart hyperprox-api
  sleep 2

  info "Starting hyperprox-frontend..."
  systemctl restart hyperprox-frontend
  sleep 1

  info "Starting hyperprox-setup..."
  # A setup started again before any owner exists may hand over its own login and key.
  HYPERPROX_DIR="${HYPERPROX_DIR}" bash "${HYPERPROX_DIR}/bin/hyperprox-setup-reset" || true
  systemctl restart hyperprox-setup
  sleep 1

  local failed=()
  for svc in hyperprox-api hyperprox-frontend hyperprox-setup; do
    if ! systemctl is-active --quiet "${svc}"; then
      failed+=("${svc}")
    fi
  done

  if [[ ${#failed[@]} -gt 0 ]]; then
    warn "Some services failed to start: ${failed[*]}"
    warn "Check logs: journalctl -u ${failed[0]} -n 50"
  else
    ok "HyperProx services running"
  fi

  # The containers too, and what they are for: a crash-looping one is a failed install, not a success.
  docker info >/dev/null 2>&1 || die "Docker is not running (systemctl status docker); HyperProx's containers cannot start."
  ui_try ui_run "Waiting for the containers to settle" wait_containers
  local bad
  bad="$(container_problems)"
  if [[ -n "${bad}" ]]; then
    local n
    while read -r n _; do
      ui_bad "${n} is not running properly; its last lines:"
      docker logs --tail 15 "${n}" 2>&1 | sed $'s/\e\\[[0-9;?]*[A-Za-z]//g; s/^/      /' || true
    done <<< "${bad}"
    die "Containers not running: $(awk '{print $1 " (" $2 ")"}' <<< "${bad}" | paste -sd, - | sed 's/,/, /g')"
  fi
  ok "All containers running"
  if grep -qE '^COMPOSE_PROFILES=.*monitoring' "${ENV_FILE}" 2>/dev/null; then
    ui_try ui_run "Prometheus answers a query" prometheus_answers
    [[ "${UI_RC}" -eq 0 ]] || die "Prometheus does not answer queries on 127.0.0.1:9090: docker logs hyperprox-prometheus"
  fi
}

# compose_rows: "name state status…" for each container of this install's compose project whose service is in
# the active profiles (a container left from a profile switched off is not this install's concern).
compose_rows() {
  local services
  services="$(cd "${HYPERPROX_DIR}" && docker compose config --services 2>/dev/null)"
  docker ps -a --filter "label=com.docker.compose.project=$(basename "${HYPERPROX_DIR}")" \
      --format '{{.Label "com.docker.compose.service"}} {{.Names}} {{.State}} {{.Status}}' 2>/dev/null \
    | S="${services}" awk 'BEGIN { n = split(ENVIRON["S"], a, "\n"); for (i = 1; i <= n; i++) on[a[i]] = 1 }
                           !n || on[$1] { $1 = ""; sub(/^ /, ""); print }'
}
# container_problems: one line per container that is restarting, exited, dead or unhealthy: "name state".
container_problems() {
  compose_rows | awk '$2 == "restarting" || $2 == "exited" || $2 == "dead" || /\(unhealthy\)/ { s = $2; if (/\(unhealthy\)/) s = "unhealthy"; print $1, s }'
}
# wait_containers: until no container is still starting (health "starting", or restarting), at most 2 minutes.
wait_containers() {
  local i
  for i in $(seq 1 60); do
    compose_rows | awk '{ $1 = ""; print }' | grep -qE '^ restarting|\(health: starting\)' || return 0
    sleep 2
  done
  return 0
}
prometheus_answers() {
  local i
  for i in $(seq 1 30); do
    curl -fsS --max-time 5 'http://127.0.0.1:9090/api/v1/query?query=up' 2>/dev/null | grep -q '"status":"success"' && return 0
    sleep 2
  done
  return 1
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  HOST_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"
  # The wizard only answers requests carrying the setup key; the link carries it. Read from .env so a
  # re-run that kept an existing .env prints the key that is actually in force.
  SETUP_SECRET="$(grep -oP '^SETUP_SECRET=\K.*' "${ENV_FILE}" 2>/dev/null || true)"
  local done_already=false link
  grep -q '^SETUP_COMPLETE=true' "${ENV_FILE}" 2>/dev/null && done_already=true
  link="https://${HOST_IP}/setup#k=${SETUP_SECRET}"; [[ "${done_already}" == true ]] && link="https://${HOST_IP}/login"
  # Run by bootstrap.sh: its own card is the one summary (it reads the setup link from .env), so nothing here.
  if [[ -n "${NESTED}" ]]; then ok "HyperProx is installed"; return 0; fi

  if [[ "${UI_FANCY}" -eq 1 ]]; then
    echo ""
    ui_box_top "" "${UI_CW}" "${C_OK}"
    ui_card_line "✓  HyperProx is installed" "${C_OK}${C_BOLD}" "total $(ui_secs "${SECONDS}")"
    ui_card_line ""
    if [[ "${done_already}" == true ]]; then ui_card_line "   Setup is already done. Sign in at ${link}"
    else
      ui_card_line "   Open   ${link}" "${C_KEY}"
      ui_card_line "   Keep this link private: it is the key to the setup wizard." "${C_DIM}"
    fi
    ui_card_line "   The certificate is self-signed unless you supplied one, so the browser warns once." "${C_DIM}"
    ui_card_line ""
    ui_card_line "   Next" "${C_BOLD}"
    ui_card_line "   1  The setup wizard connects your Proxmox cluster and asks a few yes/no questions"
    ui_card_line "   2  Then create the owner account at https://${HOST_IP}/login (vault, required 2FA)"
    ui_card_line "   3  Check on it any time with: hyperprox status · lock it with: hyperprox lock"
    ui_card_line ""
    ui_card_line "Install log: ${LOG_FILE} · logs: journalctl -fu hyperprox-api" "${C_DIM}"
    ui_box_bottom "${UI_CW}"
    echo ""
    return 0
  fi
  echo ""
  echo "HyperProx installed successfully!"
  echo ""
  echo "  Open the setup wizard in your browser:"
  if [[ "${done_already}" == true ]]; then
    echo "    Setup is already done. Sign in at ${link}"
  else
    echo "    ${link}"
    echo "  Keep this link private - it is the key to the setup wizard."
  fi
  echo "  The certificate is self-signed unless you supplied one, so the browser warns once."
  echo ""
  echo "  The wizard will guide you through:"
  echo "    • Connecting your Proxmox cluster"
  echo "    • Finding the GPUs and power meters on each node"
  echo "    • A few yes/no questions (monitoring, power, GPUs, charts, DNS, local AI),"
  echo "      which it then carries out on your nodes for you"
  echo ""
  echo "  Then create the owner account"
  echo "    HyperProx has no password of its own. After setup, open https://${HOST_IP}/login to"
  echo "    create the owner vault account (email, master password, and a required 2FA code)."
  echo "    Check on it any time with: hyperprox status    Lock it now with: hyperprox lock"
  echo "    Details: docs/security.md. The vault admin token is VAULT_ADMIN_TOKEN in ${ENV_FILE}."
  echo ""
  echo "  Service logs:"
  echo "    journalctl -fu hyperprox-api"
  echo "    journalctl -fu hyperprox-frontend"
  echo "    journalctl -fu hyperprox-setup"
  echo "    docker compose -f ${HYPERPROX_DIR}/docker-compose.yml ps"
  echo ""
  echo "  Install log: ${LOG_FILE}"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
# Five steps, each a group of the jobs below (bootstrap.sh counts them as its steps 6 to 10).
main() {
  banner
  ui_step "Docker"
  ui_plan "Updating apt" "Installing packages" "Installing Docker CE"
  detect_environment
  configure_network
  disable_apparmor
  install_prerequisites
  install_docker
  ui_step "HyperProx"
  ui_plan "Installing Node.js" "Cloning repository"
  install_node
  clone_repo
  configure_env
  configure_vault_env
  configure_update_source
  apply_install_config
  ui_step "Building"
  ui_plan "Installing npm packages" "Generating Prisma client" "Building API" "Building Frontend"
  build_app
  ui_step "Configuring"
  configure_compose
  write_monitoring_config
  configure_tls
  write_systemd_services
  install_cli
  ui_step "Starting"
  ui_plan "Starting the vault" "Waiting for the vault to answer" "Pulling images" "Waiting for PostgreSQL"
  start_services
  print_summary
}

main "$@"
