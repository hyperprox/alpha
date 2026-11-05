# node_exporter: CPU, memory, disk and network figures for this node, on port 9100.
if hp_answers 9100 '^node_exporter_build_info' 2>/dev/null; then hp_result already "node_exporter already answers on port 9100"; fi
hp_has curl || hp_safe_apt_install curl >/dev/null || hp_result failed "curl is missing and could not be added"
if ! why="$(hp_safe_apt_install prometheus-node-exporter)"; then hp_result failed "$why"; fi
systemctl enable --now prometheus-node-exporter >/dev/null 2>&1 || hp_result failed "installed, but the service would not start (journalctl -u prometheus-node-exporter)"
hp_answers 9100 '^node_exporter_build_info' || hp_result failed "installed, but nothing answers on port 9100"
hp_result done "installed and answering on port 9100"
