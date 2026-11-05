# Let containers use this node's built-in graphics (for video transcoding).
# By default the render node (/dev/dri/renderD128) is 0660, root:render, so a container given /dev/dri
# can only use it if its user maps onto the host's render group. This rule makes every render node 0666.
# The trade-off: any container on this node can then use its built-in graphics. Delete the file and
# re-run the trigger to undo it (Settings → Setup checklist does both).
RULE_FILE="$R/etc/udev/rules.d/99-hyperprox-igpu.rules"
RULE='# Installed by HyperProx. Lets containers use this node'"'"'s built-in graphics (for video transcoding).
# Any container on this node can then use them. Delete this file and run
# `udevadm trigger --subsystem-match=drm` to undo it.
SUBSYSTEM=="drm", KERNEL=="renderD*", MODE="0666"'

# The render nodes of built-in graphics: Intel or AMD. A node whose only GPU is NVIDIA has none to open.
igpu_nodes() {
  local r v
  for r in "$R"/dev/dri/renderD*; do
    [ -e "$r" ] || continue
    v="$(cat "$R/sys/class/drm/$(basename "$r")/device/vendor" 2>/dev/null || echo unknown)"
    case "$v" in 0x8086|0x1002) echo "$r";; esac
  done
}
open_all() {
  local r any=0
  for r in $(igpu_nodes); do any=1; [ "$(stat -c %a "$r")" = 666 ] || return 1; done
  [ "$any" = 1 ]
}

[ -n "$(igpu_nodes)" ] || hp_result skipped "no built-in graphics on this node"
state="$(hp_write_file "$RULE_FILE" 0644 "$RULE")" || hp_result failed "could not write $RULE_FILE"
if [ -n "$R" ]; then
  [ "$state" = same ] && hp_result already "rule already in place (udev does not run here, so it applies at the next boot)"
  hp_result done "rule written (udev does not run here, so it applies at the next boot)"
fi
udevadm control --reload >/dev/null 2>&1 || true
udevadm trigger --subsystem-match=drm >/dev/null 2>&1 || true
sleep 1
open_all || hp_result failed "rule written, but the render node is still $(stat -c %a "$(igpu_nodes | head -1)")"
[ "$state" = same ] && hp_result already "containers can already use the built-in graphics"
hp_result done "containers can now use the built-in graphics ($(igpu_nodes | xargs -n1 basename | tr '\n' ' ')is 666)"
