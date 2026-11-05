# Undo "let containers use this node's built-in graphics": remove HyperProx's rule and re-apply the
# defaults, which puts the render nodes back to 0660 for the render group.
RULE_FILE="$R/etc/udev/rules.d/99-hyperprox-igpu.rules"
[ -e "$RULE_FILE" ] || hp_result already "there is no HyperProx graphics rule on this node"
rm -f "$RULE_FILE" || hp_result failed "could not remove $RULE_FILE"
[ -n "$R" ] && hp_result done "rule removed (udev does not run here, so it applies at the next boot)"
udevadm control --reload >/dev/null 2>&1 || true
udevadm trigger --subsystem-match=drm >/dev/null 2>&1 || true
sleep 1
m="$(stat -c %a /dev/dri/renderD128 2>/dev/null || echo none)"
[ "$m" = 666 ] && hp_result failed "rule removed, but renderD128 is still 666 (another rule may open it)"
hp_result done "rule removed; renderD128 is back to $m"
