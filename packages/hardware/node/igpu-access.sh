# Let containers use this node's built-in graphics (for video transcoding).
# By default a render node is 0660, root:render, so a container given /dev/dri can only use it if its user
# maps onto the host's render group. This rule makes the render node of each BUILT-IN Intel or AMD GPU
# 0666, matched by its PCI address: an NVIDIA card or a dedicated AMD or Arc card is never opened.
# The trade-off: any container on this node can then use its built-in graphics. Undo restores the modes
# recorded here before the first change (Settings → Setup checklist does both).
RULE_FILE="$R/etc/udev/rules.d/99-hyperprox-igpu.rules"
STATE="$R/var/lib/hyperprox/igpu-access.modes"

rows="$(integrated_render_nodes)"
[ -n "$rows" ] || hp_result skipped "no built-in graphics on this node"
rule="# Installed by HyperProx. Lets containers use this node's built-in graphics (for video transcoding).
# Any container on this node can then use them. Only the built-in GPU's render node is opened, by its PCI
# address. Undo on Settings → Setup checklist, or delete this file and run
# \`udevadm trigger --subsystem-match=drm\`."
while IFS=$'\t' read -r _ n addr kind mode; do
  rule="$rule
SUBSYSTEM==\"drm\", KERNEL==\"renderD*\", KERNELS==\"$addr\", MODE=\"0666\""
done <<< "$rows"

# Remember each render node's mode as it was, once, before the first change, so undo can put it back.
if [ ! -s "$STATE" ]; then
  mkdir -p "$(dirname "$STATE")"
  awk -F'\t' '{ print $2 "\t" $3 "\t" $5 }' <<< "$rows" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
fi

open_all() { [ -n "$(integrated_render_nodes)" ] && awk -F'\t' '$5 != "666" { bad = 1 } END { exit bad }' <<< "$(integrated_render_nodes)"; }
state="$(hp_write_file "$RULE_FILE" 0644 "$rule")" || hp_result failed "could not write $RULE_FILE"
if [ -n "$R" ]; then
  [ "$state" = same ] && hp_result already "rule already in place (udev does not run here, so it applies at the next boot)"
  hp_result done "rule written (udev does not run here, so it applies at the next boot)"
fi
udevadm control --reload >/dev/null 2>&1 || true
udevadm trigger --subsystem-match=drm >/dev/null 2>&1 || true
sleep 1
names="$(integrated_render_nodes | cut -f2 | tr '\n' ' ')"
open_all || hp_result failed "rule written, but ${names}is not 666 yet"
[ "$state" = same ] && hp_result already "containers can already use the built-in graphics"
hp_result done "containers can now use the built-in graphics (${names}is 666)"
