# Intel GPU (built-in or Arc): busy %, frequency and power from intel_gpu_top, on port 8081.
#
# Where Docker is already on the node, this runs the widely used intel-gpu-exporter image. HyperProx never
# installs Docker on a Proxmox host (it changes the firewall your guests' networking goes through), so
# without Docker it adds intel-gpu-tools from apt and runs a small exporter of its own instead, with the
# same metric names, as a systemd service.
grep -qi 0x8086 "$R"/sys/class/drm/card*/device/vendor 2>/dev/null || hp_result skipped "no Intel GPU on this node"
if hp_answers 8081 '^igpu_' 2>/dev/null; then hp_result already "the Intel GPU exporter already answers on port 8081"; fi

# Pinned by digest, never a moving tag: this runs privileged on your node.
IMAGE="ghcr.io/onedr0p/intel-gpu-exporter:rolling@sha256:90a95483bf5d3752f4db2ab2e1663f19bba307fd832bf53557cbdc38c3701f84"
if hp_has docker; then
  if docker ps -a --format '{{.Names}}' | grep -qx intel-gpu-exporter; then
    docker start intel-gpu-exporter >/dev/null 2>&1 || hp_result failed "a container named intel-gpu-exporter exists but will not start"
  else
    docker run -d --name intel-gpu-exporter --restart unless-stopped \
      --privileged --pid host -v /dev/dri:/dev/dri -p 8081:8080 "$IMAGE" >/dev/null 2>&1 \
      || hp_result failed "docker could not start $IMAGE"
  fi
  hp_answers 8081 '^igpu_' || hp_result failed "the container started, but nothing answers on port 8081"
  hp_result done "running in Docker, answering on port 8081"
fi

hp_has python3 || hp_result skipped "needs python3 or Docker on this node, and it has neither"
if ! why="$(hp_safe_apt_install intel-gpu-tools)"; then hp_result failed "$why"; fi
hp_write_file /usr/local/lib/hyperprox/intel-gpu-exporter.py 0755 "$(cat <<'PY'
#!/usr/bin/env python3
# HyperProx Intel GPU exporter: runs intel_gpu_top -J and serves its latest sample as Prometheus metrics,
# with the metric names of the intel-gpu-exporter image (igpu_engines_render_3d_0_busy, igpu_power_package,
# ...). Standard library only. Installed by HyperProx; remove the hyperprox-intel-gpu-exporter service to undo.
import http.server, json, re, subprocess, sys, threading

PORT = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 8081
latest = {}
lock = threading.Lock()

def name(s):
    s = re.sub(r'([a-z])([A-Z])', r'\1_\2', s).lower()
    s = re.sub(r'[^a-z0-9]+', '_', s).strip('_')
    return s if re.search(r'_\d+$', s) else s + '_0'

def flatten(sample):
    out = {}
    for key, metric in (('period', 'duration'),):
        if key in sample: out['igpu_period'] = sample[key].get(metric, 0)
    f = sample.get('frequency', {})
    for k in ('requested', 'actual'):
        if k in f: out['igpu_frequency_' + k] = f[k]
    if 'interrupts' in sample: out['igpu_interrupts'] = sample['interrupts'].get('count', 0)
    if 'rc6' in sample: out['igpu_rc6'] = sample['rc6'].get('value', 0)
    p = sample.get('power', {})
    for k in ('GPU', 'Package'):
        if k in p: out['igpu_power_' + k.lower()] = p[k]
    b = sample.get('imc-bandwidth', {})
    for k in ('reads', 'writes'):
        if k in b: out['igpu_imc_bandwidth_' + k] = b[k]
    for eng, vals in sample.get('engines', {}).items():
        for k in ('busy', 'sema', 'wait'):
            if k in vals: out['igpu_engines_%s_%s' % (name(eng), k)] = vals[k]
    return out

def reader():
    global latest
    proc = subprocess.Popen(['intel_gpu_top', '-J', '-s', '10000'], stdout=subprocess.PIPE, text=True)
    depth, buf = 0, ''
    for ch in iter(lambda: proc.stdout.read(1), ''):
        if ch == '{':
            depth += 1
        if depth > 0:
            buf += ch
        if ch == '}':
            depth -= 1
            if depth == 0:
                try:
                    flat = flatten(json.loads(buf))
                    with lock: latest = flat
                except ValueError:
                    pass
                buf = ''
    sys.exit('intel_gpu_top stopped')

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] != '/metrics':
            self.send_response(404); self.end_headers(); return
        with lock: rows = dict(latest)
        body = ''.join('%s %s\n' % (k, float(v)) for k, v in sorted(rows.items())).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; version=0.0.4')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

if __name__ == '__main__':
    t = threading.Thread(target=reader, daemon=True); t.start()
    http.server.ThreadingHTTPServer(('', PORT), Handler).serve_forever()
PY
)" >/dev/null || hp_result failed "could not write the exporter"
unit_state="$(hp_write_file /etc/systemd/system/hyperprox-intel-gpu-exporter.service 0644 '[Unit]
Description=HyperProx Intel GPU exporter (intel_gpu_top, port 8081)
After=network.target

[Service]
ExecStart=/usr/bin/python3 /usr/local/lib/hyperprox/intel-gpu-exporter.py --port 8081
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target')"
systemctl daemon-reload >/dev/null 2>&1
systemctl enable --now hyperprox-intel-gpu-exporter >/dev/null 2>&1 || hp_result failed "the exporter service would not start (journalctl -u hyperprox-intel-gpu-exporter)"
[ "$unit_state" = written ] && systemctl restart hyperprox-intel-gpu-exporter >/dev/null 2>&1
hp_answers 8081 '^igpu_' || hp_result failed "the exporter service runs, but nothing answers on port 8081"
hp_result done "running as a service, answering on port 8081"
