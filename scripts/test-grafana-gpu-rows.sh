#!/usr/bin/env bash
# The cluster dashboard draws a GPU row only for the vendors a cluster has. This renders it for real:
# the Grafana image docker-compose.yml pins, the pinned Prometheus scraping a stand-in node that reports
# only AMD GPU figures, and headless Chromium dumping the page Grafana draws. Everything runs in
# throwaway containers on a throwaway network, removed on exit.
#
#   only AMD data  -> the dashboard drawn for that cluster shows the AMD row and no Intel or NVIDIA row
#   control        -> the same Grafana draws all three rows when all three vendors are present, so the
#                     page dump really does contain row titles
#
#   bash scripts/test-grafana-gpu-rows.sh      (needs Docker and network access for apt in the tools box)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
grafana="$(grep -oP 'image: \Kgrafana/grafana:\S+' "${here}/docker-compose.yml" | head -1)"
prom="$(grep -oP 'image: \Kprom/prometheus:\S+' "${here}/docker-compose.yml" | head -1)"
id="hpx-gpurows-$$"; net="$id-net"; work="$(mktemp -d)"
fail=0
ok()  { echo "ok    $1"; }
bad() { echo "FAIL  $1"; fail=1; }
cleanup() { docker rm -f "$id-tools" "$id-prom" "$id-grafana" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1; rm -rf "$work"; }
trap cleanup EXIT

# Dashboards: the one drawn for an AMD-only cluster, and a control with every vendor.
mkdir -p "$work/dash" "$work/ds"
node -e '
  const d = require(process.argv[1]); const fs = require("fs")
  const t = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
  fs.writeFileSync(process.argv[3] + "/amd-only.json", JSON.stringify(d.renderClusterDashboard(t, ["amd"])))
  const all = d.renderClusterDashboard(t, ["intel", "amd", "nvidia"]); all.uid = "control"; all.title = "Control"
  fs.writeFileSync(process.argv[3] + "/control.json", JSON.stringify(all))
' "${here}/packages/hardware/dashboard.js" "${here}/config/grafana/dashboards/hyperprox-cluster.json" "$work/dash"
cp "${here}/config/grafana/provisioning/dashboards/provider.yml" "$work/provider.yml"
sed -i "s|/etc/grafana/provisioning/dashboards|/var/lib/hpx-dash|" "$work/provider.yml"
cat > "$work/ds/prometheus.yml" <<EOF
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://$id-prom:9090
    isDefault: true
EOF
# A node that reports only AMD GPU figures.
cat > "$work/metrics" <<'EOF'
node_exporter_build_info{version="1.9.0"} 1
node_drm_gpu_busy_percent{card="card1",memory_vendor=""} 37
node_drm_memory_vram_used_bytes{card="card1"} 1.073741824e+09
node_drm_memory_vram_size_bytes{card="card1"} 2.147483648e+09
EOF
cat > "$work/prometheus.yml" <<EOF
global: { scrape_interval: 2s }
scrape_configs:
  - job_name: node
    # python's http.server sends no Prometheus content type; Prometheus 3 needs to be told what it is.
    fallback_scrape_protocol: PrometheusText0.0.4
    static_configs: [ { targets: ['$id-tools:9100'], labels: { node: node-a } } ]
EOF

docker network create "$net" >/dev/null
docker run -d --name "$id-tools" --network "$net" -v "$work:/work" debian:trixie bash -c '
  apt-get -q update >/dev/null && apt-get -q -y install --no-install-recommends python3 chromium fonts-dejavu-core curl >/dev/null 2>&1
  mkdir -p /srv && cp /work/metrics /srv/metrics && touch /work/tools-ready
  cd /srv && exec python3 -m http.server 9100' >/dev/null
docker run -d --name "$id-prom" --network "$net" -v "$work/prometheus.yml:/etc/prometheus/prometheus.yml:ro" "$prom" >/dev/null
docker run -d --name "$id-grafana" --network "$net" \
  -e GF_AUTH_ANONYMOUS_ENABLED=true -e GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer -e GF_AUTH_DISABLE_LOGIN_FORM=true \
  -e GF_SECURITY_ADMIN_PASSWORD=throwaway-test-only -e GF_ANALYTICS_REPORTING_ENABLED=false -e GF_NEWS_NEWS_FEED_ENABLED=false \
  -v "$work/provider.yml:/etc/grafana/provisioning/dashboards/provider.yml:ro" -v "$work/ds:/etc/grafana/provisioning/datasources:ro" \
  -v "$work/dash:/var/lib/hpx-dash:ro" "$grafana" >/dev/null

for _ in $(seq 1 300); do [ -e "$work/tools-ready" ] && break; sleep 2; done
[ -e "$work/tools-ready" ] || { bad "the tools container (python3, chromium) did not get ready"; exit 1; }
in_tools() { docker exec "$id-tools" bash -c "$1"; }
for _ in $(seq 1 150); do in_tools "curl -fsS http://$id-grafana:3000/api/health" >/dev/null 2>&1 && break; sleep 2; done
for _ in $(seq 1 60); do
  in_tools "curl -fsS 'http://$id-prom:9090/api/v1/query?query=node_drm_gpu_busy_percent'" 2>/dev/null | grep -q '"37"' && break; sleep 2
done
in_tools "curl -fsS 'http://$id-prom:9090/api/v1/query?query=node_drm_gpu_busy_percent'" | grep -q '"37"' \
  && ok "Prometheus has the AMD figures, and only those" || bad "Prometheus has no AMD figures"
in_tools "curl -fsS http://$id-grafana:3000/api/search?type=dash-db" | grep -q '"uid":"hyperprox-cluster"' \
  && ok "Grafana provisioned the dashboard drawn for this cluster" || bad "dashboard not provisioned"

render() {  # render <uid> -> page text after Grafana has drawn it
  in_tools "chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --window-size=1600,4000 \
    --virtual-time-budget=40000 --dump-dom 'http://$id-grafana:3000/d/$1?orgId=1&from=now-5m&to=now&kiosk' 2>/dev/null"
}
amd="$(render hyperprox-cluster)"
ctl="$(render control)"
printf '%s' "$amd" > "$work/amd.html"; printf '%s' "$ctl" > "$work/control.html"

grep -q 'Intel GPUs' <<< "$ctl" && grep -q 'AMD GPUs' <<< "$ctl" && grep -q 'NVIDIA GPUs' <<< "$ctl" \
  && ok "control: the page dump shows every row title when every vendor is present" || bad "control: row titles not in the rendered page"
grep -q 'AMD GPUs' <<< "$amd" && grep -q 'AMD GPU — Utilization' <<< "$amd" \
  && ok "AMD-only cluster: the AMD row and its panels are drawn" || bad "AMD-only: the AMD row is missing"
! grep -q 'Intel GPUs' <<< "$amd" && ! grep -q 'NVIDIA GPUs' <<< "$amd" \
  && ! grep -qE '(Intel|NVIDIA) GPU — ' <<< "$amd" \
  && ok "AMD-only cluster: no Intel or NVIDIA row or panel is drawn" || bad "AMD-only: an Intel or NVIDIA row was drawn"
exit "$fail"
