#!/usr/bin/env bash
# Runs the node-side steps inside throwaway Debian containers: the real apt, the real downloads, and the
# file writes, twice each to prove a second run changes nothing. udev and systemd do not run in a
# container, so a stand-in systemctl starts a unit's ExecStart and RAPL is tested against a fake sysfs.
#
#   bash packages/hardware/test/docker-node-steps.sh      (needs Docker and network access)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(cd "$HERE/../node" && pwd)"
IMAGE="${HPX_TEST_IMAGE:-debian:trixie}"
pass=0; fail=0
# Containers are --rm, but a killed run can leave one behind: remove this run's on any exit.
trap 'docker ps -aq --filter "name=hpx-nodetest-$$-" | xargs -r docker rm -f >/dev/null 2>&1' EXIT
ok()  { printf 'ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'FAIL %s\n%s\n' "$1" "${2:-}" | sed '2,$s/^/     /'; fail=$((fail+1)); }

# One container per case. The case body runs as bash inside it, with the node scripts at /node.
run_case() {
  local name="$1" body="$2" out
  out="$(docker run --rm --name "hpx-nodetest-$$-${name}" -v "$NODE:/node:ro" -e DEBIAN_FRONTEND=noninteractive \
    "$IMAGE" bash -c "$PRELUDE
$body" 2>&1)"
  if printf '%s\n' "$out" | grep -q '^CASE-OK$'; then ok "$name"; else bad "$name" "$(printf '%s\n' "$out" | tail -25)"; fi
}

PRELUDE='
set -u
step() { cat /node/common.sh /node/$1.sh > /tmp/$1.run; bash /tmp/$1.run; }
result() { printf "%s\n" "$1" | grep "^HPX-RESULT" | tail -1 | cut -f2; }
die() { echo "CASE-FAIL: $*"; exit 1; }
# Stand-in systemctl: "enable --now UNIT" starts the unit'"'"'s ExecStart in the background; the rest is a no-op.
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/systemctl <<"SC"
#!/bin/bash
[ "$1" = enable ] || exit 0
unit="${@: -1}"
for f in /etc/systemd/system/$unit.service /usr/lib/systemd/system/$unit.service /lib/systemd/system/$unit.service; do
  [ -f "$f" ] && break
done
[ -f "$f" ] || exit 1
cmd="$(grep -m1 "^ExecStart=" "$f" | cut -d= -f2- | sed "s/\$ARGS//")"
setsid bash -c "$cmd" >/tmp/$unit.log 2>&1 < /dev/null &
exit 0
SC
chmod +x /usr/local/sbin/systemctl
versions() { dpkg-query -W -f="\${Package} \${Version}\n" | sort; }
'

# ── node_exporter: installs from apt, answers, second run says already, nothing else upgraded ──────────
run_case node-exporter '
apt-get -q update >/dev/null
versions > /tmp/before
r1="$(step node-exporter)"; [ "$(result "$r1")" = done ] || die "first run: $r1"
r2="$(step node-exporter)"; [ "$(result "$r2")" = already ] || die "second run: $r2"
versions > /tmp/after
# Every package that was there before has the same version after: only additions.
join /tmp/before /tmp/after | awk "\$2 != \$3 {print; bad=1} END {exit bad}" || die "a package changed version"
[ "$(wc -l < /tmp/before)" -lt "$(wc -l < /tmp/after)" ] || die "nothing was added"
echo CASE-OK'

# ── the apt safety gate: an install that would upgrade something is refused and never run ─────────────
run_case apt-refuses-upgrade '
mkdir -p /tmp/stub; cat > /tmp/stub/apt-get <<"ST"
#!/bin/bash
for a in "$@"; do [ "$a" = -s ] && { echo "Inst libc6 [2.41-11] (2.41-12 Debian:13.2/stable [amd64])"; echo "Inst newpkg (1.0 Debian:13.2/stable [amd64])"; exit 0; }; done
echo REAL-INSTALL-RAN >> /tmp/real; exit 0
ST
chmod +x /tmp/stub/apt-get
out="$(PATH=/tmp/stub:$PATH bash -c ". /node/common.sh; hp_safe_apt_install newpkg; echo rc=\$?")"
printf "%s\n" "$out" | grep -q "rc=1" || die "not refused: $out"
printf "%s\n" "$out" | grep -q "would upgrade or remove other packages" || die "no plain reason: $out"
printf "%s\n" "$out" | grep -q "Inst libc6 \[" || die "does not say what: $out"
[ ! -e /tmp/real ] || die "the real install ran"
cat > /tmp/stub/apt-get <<"ST"
#!/bin/bash
for a in "$@"; do [ "$a" = -s ] && { echo "Remv systemd-timesyncd [257-1]"; exit 0; }; done
echo REAL-INSTALL-RAN >> /tmp/real; exit 0
ST
out="$(PATH=/tmp/stub:$PATH bash -c ". /node/common.sh; hp_safe_apt_install newpkg; echo rc=\$?")"
printf "%s\n" "$out" | grep -q "rc=1" || die "a removal was not refused: $out"
[ ! -e /tmp/real ] || die "the real install ran"
echo CASE-OK'

# ── RAPL: writes the rule once, says already after, skips a CPU without counters ───────────────────────
run_case rapl '
export HPX_SYSROOT=/fake
mkdir -p /fake/sys/class/powercap/intel-rapl:0 /fake/etc/udev/rules.d
echo package-0 > /fake/sys/class/powercap/intel-rapl:0/name; echo 1 > /fake/sys/class/powercap/intel-rapl:0/energy_uj
chmod 0400 /fake/sys/class/powercap/intel-rapl:0/energy_uj
r1="$(step rapl)"; [ "$(result "$r1")" = done ] || die "first: $r1"
f=/fake/etc/udev/rules.d/99-hyperprox-rapl.rules
grep -q "RUN+=\"/bin/chmod o+r /sys%p/energy_uj\"" "$f" || die "rule content"
[ "$(stat -c %a "$f")" = 644 ] || die "rule mode $(stat -c %a "$f")"
sum1="$(sha256sum "$f")"; t1="$(stat -c %Y "$f")"; sleep 1
r2="$(step rapl)"; [ "$(result "$r2")" = already ] || die "second: $r2"
[ "$(sha256sum "$f")" = "$sum1" ] && [ "$(stat -c %Y "$f")" = "$t1" ] || die "rewritten on the second run"
# Counters already open with a rule of their own: left alone, ours not added.
rm -f "$f"; chmod 0444 /fake/sys/class/powercap/intel-rapl:0/energy_uj
echo "SUBSYSTEM==\"powercap\", RUN+=\"/bin/chmod 444 /sys%p/energy_uj\"" > /fake/etc/udev/rules.d/99-rapl.rules
r3="$(step rapl)"; [ "$(result "$r3")" = already ] || die "existing rule: $r3"; [ ! -e "$f" ] || die "added a second rule"
rm -rf /fake/sys/class/powercap/*
r4="$(step rapl)"; [ "$(result "$r4")" = skipped ] || die "no RAPL: $r4"
echo CASE-OK'

# ── Intel GPU without Docker: intel-gpu-tools from apt, the built-in exporter as a service ─────────────
run_case intel-gpu-exporter '
export HPX_SYSROOT=/fake
mkdir -p /fake/sys/class/drm/card0/device; echo 0x8086 > /fake/sys/class/drm/card0/device/vendor
apt-get -q update >/dev/null && apt-get -q -y install --no-install-recommends python3 curl >/dev/null
# No GPU in a container: intel_gpu_top is replaced by one that prints a real sample and waits.
mkdir -p /usr/local/bin; cat > /usr/local/bin/intel_gpu_top <<"IG"
#!/bin/bash
printf "[\n{\n\"period\": {\"duration\": 40.6, \"unit\": \"ms\"},\n\"frequency\": {\"requested\": 300.0, \"actual\": 300.0},\n\"interrupts\": {\"count\": 0.0},\n\"rc6\": {\"value\": 99.0},\n\"power\": {\"GPU\": 0.018, \"Package\": 9.34},\n\"imc-bandwidth\": {\"reads\": 1407.4, \"writes\": 479.3},\n\"engines\": {\"Render/3D\": {\"busy\": 1.5, \"sema\": 0, \"wait\": 0}, \"VideoEnhance\": {\"busy\": 0, \"sema\": 0, \"wait\": 0}},\n\"clients\": {}\n}"
sleep 600
IG
chmod +x /usr/local/bin/intel_gpu_top
versions > /tmp/before
r1="$(step intel-gpu-exporter)"; [ "$(result "$r1")" = done ] || die "first: $r1 $(cat /tmp/hyperprox-intel-gpu-exporter.log 2>/dev/null)"
m="$(curl -fsS http://127.0.0.1:8081/metrics)"
printf "%s\n" "$m" | grep -q "^igpu_power_package 9.34$" || die "metrics: $m"
printf "%s\n" "$m" | grep -q "^igpu_engines_render_3d_0_busy 1.5$" || die "engine names: $m"
printf "%s\n" "$m" | grep -q "^igpu_engines_video_enhance_0_busy" || die "engine names: $m"
r2="$(step intel-gpu-exporter)"; [ "$(result "$r2")" = already ] || die "second: $r2"
versions > /tmp/after
join /tmp/before /tmp/after | awk "\$2 != \$3 {print; bad=1} END {exit bad}" || die "a package changed version"
dpkg-query -W intel-gpu-tools >/dev/null || die "intel-gpu-tools not installed"
echo CASE-OK'

# ── no Intel GPU: skipped, nothing written ────────────────────────────────────────────────────────────
run_case intel-skips-without-gpu '
export HPX_SYSROOT=/fake; mkdir -p /fake/sys/class/drm/card0/device; echo 0x10de > /fake/sys/class/drm/card0/device/vendor
r="$(step intel-gpu-exporter)"; [ "$(result "$r")" = skipped ] || die "$r"
[ ! -e /usr/local/lib/hyperprox ] && [ ! -e /etc/systemd/system/hyperprox-intel-gpu-exporter.service ] || die "wrote files"
echo CASE-OK'

# ── NVIDIA: the pinned exporter, checksum-checked, as a service; no driver, no apt ────────────────────
NVSTUB='mkdir -p /usr/local/bin; cat > /usr/local/bin/nvidia-smi <<"NV"
#!/bin/bash
# Stand-in for a driver that is installed: answers -L and a csv query, as nvidia-smi does.
for a in "$@"; do case "$a" in
  -L) echo "GPU 0: NVIDIA GeForce GTX 1070 Ti (UUID: GPU-00000000-0000-0000-0000-000000000000)"; exit 0;;
  --query-gpu=*) q="${a#--query-gpu=}";;
esac; done
[ -n "${q:-}" ] || exit 0
IFS=, read -ra f <<< "$q"; h=(); v=()
for x in "${f[@]}"; do case "$x" in
  uuid) h+=("uuid"); v+=("GPU-00000000-0000-0000-0000-000000000000");;
  name) h+=("name"); v+=("NVIDIA GeForce GTX 1070 Ti");;
  memory.*) h+=("$x [MiB]"); v+=("8192 MiB");;
  utilization.*|fan.speed) h+=("$x [%]"); v+=("3 %");;
  temperature.gpu) h+=("$x"); v+=("41");;
  power.*) h+=("$x [W]"); v+=("8.50 W");;
  *) h+=("$x"); v+=("[N/A]");;
esac; done
(IFS=,; echo "${h[*]}" | sed "s/,/, /g"; echo "${v[*]}" | sed "s/,/, /g")
NV
chmod +x /usr/local/bin/nvidia-smi'

run_case nvidia-gpu-exporter '
export HPX_SYSROOT=/fake; mkdir -p /fake/sys/class/drm/card0/device; echo 0x10de > /fake/sys/class/drm/card0/device/vendor
apt-get -q update >/dev/null && apt-get -q -y install --no-install-recommends curl ca-certificates >/dev/null
'"$NVSTUB"'
versions > /tmp/before
r1="$(step nvidia-gpu-exporter)"; [ "$(result "$r1")" = done ] || die "first: $r1 $(cat /tmp/hyperprox-nvidia-gpu-exporter.log 2>/dev/null)"
curl -fsS http://127.0.0.1:9835/metrics | grep -q "^nvidia_smi_power_draw_watts" || die "no power reading"
r2="$(step nvidia-gpu-exporter)"; [ "$(result "$r2")" = already ] || die "second: $r2"
versions > /tmp/after
diff /tmp/before /tmp/after >/dev/null || die "packages changed: $(diff /tmp/before /tmp/after)"
echo CASE-OK'

run_case nvidia-checksum-mismatch '
export HPX_SYSROOT=/fake; mkdir -p /fake/sys/class/drm/card0/device; echo 0x10de > /fake/sys/class/drm/card0/device/vendor
apt-get -q update >/dev/null && apt-get -q -y install --no-install-recommends curl ca-certificates >/dev/null
'"$NVSTUB"'
sed "s/SUM=71aaae[0-9a-f]*/SUM=$(printf "0%.0s" $(seq 64))/" /node/nvidia-gpu-exporter.sh > /tmp/nv.sh
r="$(cat /node/common.sh /tmp/nv.sh | bash)"
[ "$(result "$r")" = failed ] || die "$r"; printf "%s" "$r" | grep -q "did not match its published checksum" || die "$r"
! ls /usr/local/lib/hyperprox/nvidia_gpu_exporter-* >/dev/null 2>&1 || die "installed anyway"
echo CASE-OK'

run_case nvidia-without-driver '
export HPX_SYSROOT=/fake; mkdir -p /fake/sys/class/drm/card0/device; echo 0x10de > /fake/sys/class/drm/card0/device/vendor
r="$(step nvidia-gpu-exporter)"; [ "$(result "$r")" = skipped ] || die "$r"
printf "%s" "$r" | grep -q "does not install drivers" || die "$r"
echo CASE-OK'

# ── Built-in graphics for containers: the rule, idempotent, undone; nothing on an NVIDIA-only node ─────
run_case igpu-access '
export HPX_SYSROOT=/fake
mkdir -p /fake/dev/dri /fake/sys/class/drm/renderD128/device /fake/etc/udev/rules.d
: > /fake/dev/dri/renderD128; chmod 0660 /fake/dev/dri/renderD128; echo 0x8086 > /fake/sys/class/drm/renderD128/device/vendor
f=/fake/etc/udev/rules.d/99-hyperprox-igpu.rules
r1="$(step igpu-access)"; [ "$(result "$r1")" = done ] || die "first: $r1"
grep -qx "SUBSYSTEM==\"drm\", KERNEL==\"renderD\*\", MODE=\"0666\"" "$f" || die "rule content: $(cat $f)"
[ "$(stat -c %a "$f")" = 644 ] || die "rule mode"
sum="$(sha256sum "$f")"
r2="$(step igpu-access)"; [ "$(result "$r2")" = already ] || die "second: $r2"
[ "$(sha256sum "$f")" = "$sum" ] || die "rewritten"
u1="$(step igpu-access-undo)"; [ "$(result "$u1")" = done ] || die "undo: $u1"; [ ! -e "$f" ] || die "rule still there"
u2="$(step igpu-access-undo)"; [ "$(result "$u2")" = already ] || die "second undo: $u2"
echo 0x10de > /fake/sys/class/drm/renderD128/device/vendor
r3="$(step igpu-access)"; [ "$(result "$r3")" = skipped ] || die "NVIDIA only: $r3"; [ ! -e "$f" ] || die "wrote a rule on an NVIDIA-only node"
echo CASE-OK'

echo; echo "docker node steps: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
