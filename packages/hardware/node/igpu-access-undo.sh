# Undo "let containers use this node's built-in graphics": remove HyperProx's rule, re-apply the defaults,
# and put back each render node's mode as it was recorded before the first change. Every render node that
# was touched is checked, not only renderD128, and each is found by the PCI address recorded for it: the
# renderD numbers can change between boots.
RULE_FILE="$R/etc/udev/rules.d/99-hyperprox-igpu.rules"
STATE="$R/var/lib/hyperprox/igpu-access.modes"
[ -e "$RULE_FILE" ] || [ -s "$STATE" ] || hp_result already "there is no HyperProx graphics rule on this node"
rm -f "$RULE_FILE" || hp_result failed "could not remove $RULE_FILE"
if [ -z "$R" ]; then
  udevadm control --reload >/dev/null 2>&1 || true
  udevadm trigger --subsystem-match=drm >/dev/null 2>&1 || true
  sleep 1
fi
bad=""; restored=""
if [ -s "$STATE" ]; then
  while IFS=$'\t' read -r was addr mode; do
    [ -n "$addr" ] || continue
    n="$(render_nodes | awk -F'\t' -v a="$addr" '$3 == a { print $2; exit }')"
    [ -n "$n" ] || { restored="$restored $addr=gone"; continue; }
    f="$R/dev/dri/$n"
    [ "$(stat -c %a "$f")" = "$mode" ] || chmod "$mode" "$f" 2>/dev/null
    if [ "$(stat -c %a "$f")" = "$mode" ]; then restored="$restored $n=$mode"; else bad="$bad $n"; fi
  done < "$STATE"
fi
[ -z "$bad" ] || hp_result failed "rule removed, but${bad} did not go back to its old mode"
rm -f "$STATE"
hp_result done "rule removed; render nodes back as they were:${restored:- (none recorded)}"
