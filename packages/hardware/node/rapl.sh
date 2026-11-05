# Power: let the unprivileged node_exporter read the CPU energy counters (RAPL).
# Since kernel 5.10 energy_uj is root-only (0400), a PLATYPUS mitigation: energy readings are fine-grained
# enough to leak secrets. node_exporter then gets nothing, silently. This rule reopens them to local users
# on this node only; delete the file to undo it.
RULE_FILE="$R/etc/udev/rules.d/99-hyperprox-rapl.rules"
RULE='# Installed by HyperProx. Lets the unprivileged node_exporter read the CPU energy counters (RAPL).
# Kernel 5.10+ keeps energy_uj at 0400 as a PLATYPUS mitigation; this rule reverses that on this host,
# so any local user here can read energy use. Delete this file to undo it.
# It chmods the device udev reports, once per power domain as each appears.
SUBSYSTEM=="powercap", ACTION=="add|change", RUN+="/bin/chmod o+r /sys%p/energy_uj"'

ls "$R"/sys/class/powercap/*/energy_uj >/dev/null 2>&1 || hp_result skipped "this CPU has no power counters (RAPL)"

open() {
  local f
  for f in "$R"/sys/class/powercap/*/energy_uj; do
    (( 8#$(stat -c %a "$f") & 4 )) || return 1
  done
}
if open && grep -qs 'energy_uj' "$R"/etc/udev/rules.d/*.rules; then
  hp_result already "power counters already readable, and a udev rule keeps them that way"
fi
state="$(hp_write_file "$RULE_FILE" 0644 "$RULE")" || hp_result failed "could not write $RULE_FILE"
if [ -z "$R" ]; then
  udevadm control --reload-rules >/dev/null 2>&1 || true
  udevadm trigger --action=add --subsystem-match=powercap >/dev/null 2>&1 || true
  sleep 1
fi
if ! open; then
  if [ -n "$R" ]; then
    [ "$state" = same ] && hp_result already "rule already in place (udev does not run here, so it applies at the next boot)"
    hp_result done "rule written (udev does not run here, so it applies at the next boot)"
  fi
  hp_result failed "rule written, but the counters are still root-only"
fi
# node_exporter caches nothing about permissions, but a restart makes the next scrape certain.
if [ "$state" = written ] && [ -z "$R" ]; then
  systemctl try-restart prometheus-node-exporter node_exporter >/dev/null 2>&1 || true
fi
[ "$state" = same ] && hp_result already "power counters already readable"
hp_result done "power counters readable by node_exporter"
