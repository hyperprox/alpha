# AMD GPU (built in or a card): busy %, VRAM size and use, from node_exporter's own drm collector.
# The collector is off by default. This turns it on with a systemd drop-in that resets ExecStart to the
# unit's current command plus --collector.drm, so every flag the unit already had is kept. Undo removes
# the drop-in. Nothing is installed: node_exporter itself must already run (the health question).
DROPIN_NAME=hyperprox-amd-gpu.conf

grep -qi 0x1002 "$R"/sys/class/drm/card*/device/vendor 2>/dev/null || hp_result skipped "no AMD GPU on this node"
if hp_answers 9100 '^node_drm_gpu_busy_percent' 2>/dev/null; then hp_result already "AMD GPU figures already answer on port 9100"; fi

# The unit that runs node_exporter here: the distribution's, or one someone installed by hand.
unit=""
for u in prometheus-node-exporter node_exporter node-exporter; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then unit="$u"; break; fi
done
[ -n "$unit" ] || hp_result skipped "node_exporter is not running here; answer yes to watching node health first"

# The unit's own ExecStart, as systemd would run it without our drop-in: the unit file, then its other
# drop-ins in order. "ExecStart=" on its own resets; continuation lines are joined.
current_exec() {
  systemctl cat "$unit" 2>/dev/null | awk -v skip="/$unit.service.d/$DROPIN_NAME" '
    /^# \// { inskip = (index($0, skip) > 0); next }
    inskip { next }
    { line = $0
      while (line ~ /\\$/ && (getline nxt) > 0) { sub(/\\$/, "", line); line = line " " nxt }
      if (line ~ /^ExecStart=/) { v = substr(line, 11); gsub(/^[ \t]+|[ \t]+$/, "", v); cmd = v } }
    END { print cmd }'
}
cmd="$(current_exec)"
[ -n "$cmd" ] || hp_result failed "could not read how $unit starts (systemctl cat $unit)"
# Keep every flag; switch the collector on (and drop an explicit "off", which would win otherwise).
new="$(printf '%s' "$cmd" | sed -E 's/(^|[[:space:]])--no-collector\.drm([[:space:]]|$)/\1\2/g; s/[[:space:]]+/ /g; s/ $//')"
case " $new " in *" --collector.drm "*) ;; *) new="$new --collector.drm";; esac

dir="/etc/systemd/system/$unit.service.d"
state="$(hp_write_file "$dir/$DROPIN_NAME" 0644 "# Installed by HyperProx: node_exporter's drm collector, for AMD GPU use and VRAM.
# It repeats the unit's own command with --collector.drm added. To undo: delete this file, then
# systemctl daemon-reload && systemctl restart $unit
[Service]
ExecStart=
ExecStart=$new")" || hp_result failed "could not write $dir/$DROPIN_NAME"
systemctl daemon-reload >/dev/null 2>&1
systemctl restart "$unit" >/dev/null 2>&1
if hp_answers 9100 '^node_drm_gpu_busy_percent'; then
  [ "$state" = same ] && hp_result already "AMD GPU figures answer on port 9100"
  hp_result done "AMD GPU figures answer on port 9100 (node_exporter's drm collector is on)"
fi
# No AMD figures: put node_exporter back exactly as it was (a drop-in that was already there stays).
if [ "$state" = written ]; then
  rm -f "$dir/$DROPIN_NAME"; rmdir "$dir" 2>/dev/null || true
  systemctl daemon-reload >/dev/null 2>&1; systemctl restart "$unit" >/dev/null 2>&1
  hp_answers 9100 '^node_exporter_build_info' || hp_result failed "no AMD GPU figures appeared, so the change was undone, but node_exporter does not answer on port 9100 now"
  hp_result failed "node_exporter's drm collector reported no AMD GPU (is the amdgpu driver loaded?), so the change was undone and node_exporter runs as before"
fi
hp_result failed "node_exporter runs with --collector.drm but reports no AMD GPU (is the amdgpu driver loaded?)"
