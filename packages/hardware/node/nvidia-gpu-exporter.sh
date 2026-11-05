# NVIDIA GPU: use, memory, temperature and power from nvidia-smi, on port 9835.
# It only reads nvidia-smi. HyperProx never installs, upgrades or removes NVIDIA drivers or kernels.
grep -qi 0x10de "$R"/sys/class/drm/card*/device/vendor 2>/dev/null || lspci -nn 2>/dev/null | grep -q '\[10de:' \
  || hp_result skipped "no NVIDIA GPU on this node"
if hp_answers 9835 '^nvidia_smi_memory_total_bytes' 2>/dev/null; then hp_result already "an NVIDIA exporter already answers on port 9835"; fi
hp_has nvidia-smi || hp_result skipped "the NVIDIA driver is not installed (no nvidia-smi), and HyperProx does not install drivers"
nvidia-smi -L >/dev/null 2>&1 || hp_result skipped "nvidia-smi is there but cannot talk to the GPU, so there is nothing to read"

VERSION=1.15.1
case "$(uname -m)" in
  x86_64)  ARCH=x86_64; SUM=71aaae0e00b7fa4a115091973e87eadd332e477d4c6bbebaccc0133bc77df9f6 ;;
  aarch64) ARCH=arm64;  SUM=f1ada1051aefffa0a8d0522dd68a9476fa6e5395509ae8cfbb0d026f39b8e5b4 ;;
  *) hp_result skipped "no nvidia_gpu_exporter build for $(uname -m)" ;;
esac
BIN=/usr/local/lib/hyperprox/nvidia_gpu_exporter-$VERSION
if [ ! -x "$BIN" ]; then
  hp_has curl || hp_result failed "curl is needed to download the exporter"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/utkuozdemir/nvidia_gpu_exporter/releases/download/v$VERSION/nvidia_gpu_exporter_${VERSION}_linux_$ARCH.tar.gz"
  curl -fsSL --max-time 120 -o "$tmp/x.tgz" "$url" || hp_result failed "could not download $url"
  echo "$SUM  $tmp/x.tgz" | sha256sum -c --status || hp_result failed "the download did not match its published checksum, so it was not installed"
  tar -xzf "$tmp/x.tgz" -C "$tmp" nvidia_gpu_exporter || hp_result failed "the download could not be unpacked"
  mkdir -p /usr/local/lib/hyperprox && install -m 0755 "$tmp/nvidia_gpu_exporter" "$BIN"
fi
unit_state="$(hp_write_file /etc/systemd/system/hyperprox-nvidia-gpu-exporter.service 0644 "[Unit]
Description=HyperProx NVIDIA GPU exporter (nvidia_gpu_exporter $VERSION, port 9835)
After=network.target

[Service]
ExecStart=$BIN --web.listen-address=:9835 --nvidia-smi-command=nvidia-smi --query-field-names=uuid,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,fan.speed
DynamicUser=yes
SupplementaryGroups=video
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target")"
systemctl daemon-reload >/dev/null 2>&1
systemctl enable --now hyperprox-nvidia-gpu-exporter >/dev/null 2>&1 || hp_result failed "the exporter service would not start (journalctl -u hyperprox-nvidia-gpu-exporter)"
[ "$unit_state" = written ] && systemctl restart hyperprox-nvidia-gpu-exporter >/dev/null 2>&1
hp_answers 9835 '^nvidia_smi_memory_total_bytes' || hp_result failed "the exporter service runs, but nothing answers on port 9835"
hp_result done "running as a service, answering on port 9835"
