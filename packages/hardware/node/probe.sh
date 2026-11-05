#!/usr/bin/env bash
# HyperProx hardware probe: what one Proxmox node has, read-only.
#
# This is the one place HyperProx decides what hardware a node has. bootstrap.sh runs it on each node,
# the setup wizard and the API send it over SSH, and the API runs `probe.sh classify` locally on the PCI
# list Proxmox reports when it has no node login. So a GPU is "integrated" or "dedicated" for the same
# reason everywhere.
#
# It changes nothing: no package, file or service is touched. Output is one fact per line, tab-separated:
#   gpu  <vendor> <integrated|dedicated> <vvvv:dddd> <plain name>
#   dri <card and render nodes>          nvidia_smi yes|no          docker yes|no      python3 yes|no
#   rapl none|readable|root-only <domains>                          ceph yes|no        arch <uname -m>
#   node_exporter running|installed|absent                          intel_gpu_top yes|no
#   intel_exporter running|absent        nvidia_exporter running|absent                pve <version>
#   igpu_access open|closed|none rule|no-rule   can containers use the built-in graphics (render nodes 0666)
#
#   probe.sh            probe this machine
#   probe.sh classify   read "vendor<TAB>device<TAB>name" lines (hex ids, as Proxmox's API gives them) on
#                       stdin and print the gpu lines for them
#
# HPX_SYSROOT prefixes /sys, /dev and /etc paths, for the tests.
set -u
R="${HPX_SYSROOT:-}"
T=$'\t'

# ── GPU classification ───────────────────────────────────────────────────────────────────────────────
# Input: vendor<TAB>device<TAB>name (vendor and device as 4 hex digits, any case, 0x allowed).
# AMD integrated graphics share AMD's vendor id with its cards; the APU code names tell them apart.
# Intel's discrete cards are Arc (DG1, DG2/Alchemist, Battlemage, "Arc A770" and so on); the "Arc Graphics"
# inside a Core Ultra CPU is integrated and does not match. Device ids 56a0-56ff are Arc Alchemist.
classify() {
  awk -F'\t' '
    function lc(s) { return tolower(s) }
    function hex(s) { s = lc(s); sub(/^0x/, "", s); return s }
    function hexval(s,   i, c, v) { v = 0; for (i = 1; i <= length(s); i++) { c = index("0123456789abcdef", substr(s, i, 1)); if (!c) return -1; v = v * 16 + c - 1 } return v }
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    # "NVIDIA Corporation GP104 [GeForce GTX 1070 Ti]" -> "GeForce GTX 1070 Ti": the marketing name is the
    # last bracketed part, when there is one; otherwise the name without the vendor.
    function model(name,   m, i, last) {
      last = ""
      while (match(name, /\[[^][]*\]/)) { last = substr(name, RSTART + 1, RLENGTH - 2); name = substr(name, 1, RSTART - 1) " " substr(name, RSTART + RLENGTH) }
      if (last != "" && lc(last) != "amd/ati") return trim(last)
      gsub(/(NVIDIA|Intel|Advanced Micro Devices, Inc\.|AMD) ?(Corporation|Corp\.)?/, "", name)
      gsub(/\[AMD\/ATI\]/, "", name)
      return trim(name)
    }
    {
      v = hex($1); d = hex($2); name = $3
      if (v == "10de") { vendor = "nvidia"; label = "NVIDIA"; kind = "dedicated" }
      else if (v == "8086") {
        vendor = "intel"; label = "Intel"; dv = hexval(d)
        kind = (dv >= 22176 && dv <= 22271) || name ~ /(DG1|DG2|Alchemist|Battlemage|Arc [AB][0-9][0-9][0-9])/ ? "dedicated" : "integrated"
      }
      else if (v == "1002") {
        vendor = "amd"; label = "AMD"
        kind = name ~ /(Kaveri|Godavari|Carrizo|Bristol Ridge|Stoney|Kabini|Temash|Mullins|Beema|Trinity|Richland|Llano|Sumo|Wrestler|Ontario|Zacate|Raven|Picasso|Dali|Pollock|Renoir|Lucienne|Cezanne|Barcelo|Rembrandt|Mendocino|Phoenix|Hawk Point|Strix|Krackan|Van Gogh|Aerith|Sephiroth|Raphael|Granite Ridge|Dragon Range)/ ? "integrated" : "dedicated"
      }
      # Anything else is a server BMC or a virtual display (ASPEED, Matrox, QXL, VMware): not a GPU.
      else next
      m = model(name)
      if (m == "") m = "graphics " v ":" d
      if (label != "" && index(lc(m), lc(label)) != 1) m = label " " m
      print "gpu\t" vendor "\t" kind "\t" v ":" d "\t" m
    }'
}

# Display controllers (PCI class 03xx) as vendor<TAB>device<TAB>name, from lspci -nn, or sysfs without it.
pci_displays() {
  if [ -z "$R" ] && command -v lspci >/dev/null 2>&1 || [ -n "${HPX_LSPCI:-}" ]; then
    { if [ -n "${HPX_LSPCI:-}" ]; then cat "$HPX_LSPCI"; else lspci -nn 2>/dev/null; fi; } | awk '
      / \[03[0-9a-f][0-9a-f]\]: / {
        line = $0
        if (!match(line, /\[[0-9a-f][0-9a-f][0-9a-f][0-9a-f]:[0-9a-f][0-9a-f][0-9a-f][0-9a-f]\]( \(rev [0-9a-f]+\))?$/)) next
        ids = substr(line, RSTART + 1, 9)
        name = substr(line, 1, RSTART - 2)
        sub(/^[^]]*\[03[0-9a-f][0-9a-f]\]: /, "", name)
        print substr(ids, 1, 4) "\t" substr(ids, 6, 4) "\t" name
      }'
    return
  fi
  local d
  for d in "$R"/sys/bus/pci/devices/*; do
    [ -r "$d/class" ] || continue
    case "$(cat "$d/class")" in 0x03*) ;; *) continue ;; esac
    printf '%s\t%s\t%s\n' "$(cat "$d/vendor")" "$(cat "$d/device")" ""
  done
}

has() { command -v "$1" >/dev/null 2>&1; }
yn() { if "$@"; then echo yes; else echo no; fi; }

# An exporter "runs" when it answers on its port with its own metrics, whatever installed it.
answers() { has curl && curl -fsS --max-time 3 "http://127.0.0.1:$1/metrics" 2>/dev/null | grep -q "$2"; }

rapl() {
  local f mode any=0 open=0 doms=""
  for f in "$R"/sys/class/powercap/*/energy_uj; do
    [ -e "$f" ] || continue
    any=1
    local dir="${f%/energy_uj}"
    [ -r "$dir/name" ] && doms="${doms:+$doms,}$(cat "$dir/name")"
    mode="$(stat -c %a "$f" 2>/dev/null || echo 400)"
    # Readable by "other": node_exporter runs unprivileged, so root's view says nothing.
    (( 8#${mode} & 4 )) && open=1
  done
  if [ "$any" = 0 ]; then printf 'rapl\tnone\t\n'
  elif [ "$open" = 1 ]; then printf 'rapl\treadable\t%s\n' "$doms"
  else printf 'rapl\troot-only\t%s\n' "$doms"; fi
}

node_exporter() {
  if answers 9100 '^node_exporter_build_info'; then echo running
  elif has dpkg-query && dpkg-query -W -f='${Status}' prometheus-node-exporter 2>/dev/null | grep -q 'install ok installed'; then echo installed
  else echo absent; fi
}

# Built-in graphics open to containers? none: no Intel or AMD built-in GPU with a render node.
igpu_access() {
  local gpus="$1" r v any=0 open=1 rule=no-rule
  grep -qE $'^gpu\t(intel|amd)\tintegrated' <<< "$gpus" || { printf 'igpu_access\tnone\t\n'; return; }
  for r in "$R"/dev/dri/renderD*; do
    [ -e "$r" ] || continue
    v="$(cat "$R/sys/class/drm/$(basename "$r")/device/vendor" 2>/dev/null || echo unknown)"
    case "$v" in 0x8086|0x1002) ;; *) continue ;; esac
    any=1
    [ "$(stat -c %a "$r" 2>/dev/null)" = 666 ] || open=0
  done
  [ -e "$R/etc/udev/rules.d/99-hyperprox-igpu.rules" ] && rule=rule
  if [ "$any" = 0 ]; then printf 'igpu_access\tnone\t%s\n' "$rule"
  elif [ "$open" = 1 ]; then printf 'igpu_access\topen\t%s\n' "$rule"
  else printf 'igpu_access\tclosed\t%s\n' "$rule"; fi
}

probe() {
  local gpus
  gpus="$(pci_displays | classify)"
  [ -n "$gpus" ] && printf '%s\n' "$gpus"
  printf 'dri\t%s\n' "$(ls "$R"/dev/dri 2>/dev/null | grep -E '^(card|renderD)[0-9]+$' | tr '\n' ' ' | sed 's/ $//')"
  printf 'nvidia_smi\t%s\n' "$(yn has nvidia-smi)"
  rapl
  printf 'node_exporter\t%s\n' "$(node_exporter)"
  printf 'docker\t%s\n' "$(yn has docker)"
  printf 'python3\t%s\n' "$(yn has python3)"
  printf 'intel_gpu_top\t%s\n' "$(yn has intel_gpu_top)"
  printf 'intel_exporter\t%s\n' "$(answers 8081 '^igpu_' && echo running || echo absent)"
  printf 'nvidia_exporter\t%s\n' "$(answers 9835 '^nvidia_smi_memory_total_bytes' && echo running || echo absent)"
  printf 'ceph\t%s\n' "$( [ -e "$R/etc/pve/ceph.conf" ] && echo yes || echo no)"
  printf 'arch\t%s\n' "$(uname -m)"
  igpu_access "$gpus"
  printf 'pve\t%s\n' "$( (has pveversion && pveversion 2>/dev/null | cut -d/ -f2) || echo '')"
}

case "${1:-}" in
  classify) classify ;;
  *) probe ;;
esac
