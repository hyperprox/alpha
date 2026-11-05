# Undo AMD GPU monitoring: remove HyperProx's node_exporter drop-in and restart it as it was.
DROPIN_NAME=hyperprox-amd-gpu.conf
found=""
for u in prometheus-node-exporter node_exporter node-exporter; do
  f="/etc/systemd/system/$u.service.d/$DROPIN_NAME"
  [ -e "$f" ] || continue
  rm -f "$f" || hp_result failed "could not remove $f"
  found="$found $u"
done
[ -n "$found" ] || hp_result already "there is no HyperProx drop-in for node_exporter on this node"
systemctl daemon-reload >/dev/null 2>&1
for u in $found; do systemctl restart "$u" >/dev/null 2>&1; done
hp_answers 9100 '^node_exporter_build_info' || hp_result failed "drop-in removed, but node_exporter does not answer on port 9100"
hp_result done "drop-in removed; node_exporter runs as it did before"
