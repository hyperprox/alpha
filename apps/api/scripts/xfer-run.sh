#!/bin/bash
# HyperProx: one file copy, run on the SOURCE node, detached, from a root-only directory under /run (memory,
# gone at reboot). HyperProx writes job.env (and, for another node, a one-job key and known_hosts) into that
# directory, starts this, and reads $D/status and $D/log to show progress. Data goes straight from this node
# to the destination node; HyperProx only watches.
#
#   copy   adds what is missing; nothing on the destination is replaced or deleted (--ignore-existing, and the
#          destination key itself cannot delete: rrsync -no-del).
#   Every file this job copied is then checked by checksum against the source, and copied again on a mismatch
#   (twice at most). A dropped connection is retried, and --partial resumes a half-sent file.
#
# It touches nothing but the copied files and its own working folder.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$D/job.env"
st() { printf '%s\n' "$*" >> "$D/status"; }
finish() { rm -f "$D/key" "$D/known_hosts"; st "end $1"; exit 0; }
trap 'rm -f "$D/key" "$D/known_hosts"' EXIT
trap 'st "end cancelled"; rm -f "$D/key" "$D/known_hosts"; exit 0' TERM INT

[ -e "$SRC" ] || { st "error the source $SRC is not there"; finish failed; }
# The real paths (links resolved) must still be inside their allowed folders, checked here, just before rsync.
inside() { local r p; r="$(realpath -e -- "$2" 2>/dev/null)" || return 1; p="$(realpath -e -- "$1" 2>/dev/null)" || return 1; case "$p/" in "$r"/*) return 0;; esac; return 1; }
if [ -n "${SRC_ROOT:-}" ]; then inside "$SRC" "$SRC_ROOT" || { st "error the source now leads outside its allowed folder (through a link?), so nothing was copied"; finish failed; }; fi
if [ -z "${DST_HOST:-}" ] && [ -n "${DST_ROOT:-}" ]; then inside "$DST_PATH" "$DST_ROOT" || { st "error the destination now leads outside its allowed folder (through a link?), so nothing was copied"; finish failed; }; fi
case "$MODE" in copy) ;; *) st "error only copy is offered"; finish failed;; esac

RSH=()
if [ -n "${DST_HOST:-}" ]; then
  RSH=(-e "ssh -i $D/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$D/known_hosts -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=20")
  TARGET="root@${DST_HOST_URI}:${DST_REL}/"
else
  TARGET="${DST_PATH}/"
fi
BW=()
[ "${BWLIMIT:-0}" -gt 0 ] 2>/dev/null && BW=(--bwlimit="$BWLIMIT")
BASE="$(dirname "$SRC")"
# Every file this job has written, across resumes: kept on disk (no secrets in it) until the job is done.
mkdir -p /var/lib/hyperprox-xfer
OURS="/var/lib/hyperprox-xfer/${JOB_ID}.ours"
touch "$OURS"

# Exit codes worth retrying: a dropped or refused connection, a timeout, a partial transfer.
retryable() { case "$1" in 10|12|23|30|35|255) return 0;; *) return 1;; esac; }

run_rsync() {
  local attempt rc
  for attempt in 1 2 3 4 5; do
    rsync "$@" "${BW[@]}" "${RSH[@]}" >> "$D/log" 2>&1
    rc=$?
    [ "$rc" -eq 0 ] || [ "$rc" -eq 24 ] && return 0
    retryable "$rc" || return "$rc"
    st "retry $attempt rsync stopped with code $rc; trying again in 30 seconds"
    sleep 30
  done
  return "$rc"
}

st "phase copy"
run_rsync -a --safe-links --partial --partial-dir=.hpx-partial --ignore-existing --info=progress2 \
  --out-format='HPXFILE %i %n' "$SRC" "$TARGET"
rc=$?
[ "$rc" -eq 0 ] || { st "error copying stopped with rsync code $rc"; finish failed; }

# The files this job wrote ('>f' = a file received), relative to $BASE.
{ cat "$OURS"; grep -a '^HPXFILE >f' "$D/log" | sed 's/^HPXFILE [^ ]* //'; } | sort -u > "$OURS.tmp" && mv -f "$OURS.tmp" "$OURS"
cp "$OURS" "$D/ours"
st "copied $(wc -l < "$D/ours")"

st "phase verify"
for round in 1 2 3; do
  : > "$D/mismatch"
  if [ -s "$D/ours" ]; then
    rsync -a --checksum --dry-run --files-from="$D/ours" --out-format='HPXCHK %i %n' "${RSH[@]}" "$BASE/" "$TARGET" > "$D/verify.log" 2>&1 \
      || { st "error the check could not run (code $?)"; finish failed; }
    grep -a '^HPXCHK >f' "$D/verify.log" | sed 's/^HPXCHK [^ ]* //' > "$D/mismatch"
  fi
  bad="$(wc -l < "$D/mismatch")"
  [ "$bad" -eq 0 ] && { st "verified $(wc -l < "$D/ours")"; rm -f "$OURS"; finish done; }
  [ "$round" -eq 3 ] && { st "error $bad file(s) still differ from the source after two more tries"; finish failed; }
  st "mismatch $bad file(s) differ; copying them again"
  run_rsync -a --checksum --partial --partial-dir=.hpx-partial --files-from="$D/mismatch" "$BASE/" "$TARGET" \
    || { st "error copying again stopped"; finish failed; }
done
