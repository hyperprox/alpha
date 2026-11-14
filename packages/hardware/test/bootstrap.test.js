'use strict'
// bootstrap.sh run for real in bash against stand-ins for Proxmox's commands: fake nodes (from the detection
// fixtures) reached through a stand-in ssh, -y, answers piped in or typed at a stand-in terminal, runs fed
// through a pipe the way `curl | bash` feeds them, and full runs whose node steps are recorded, not executed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const hw = require('..')
const { fakeNode, loadFixtures } = require('./harness')

const BOOTSTRAP = path.join(__dirname, '..', '..', '..', 'bootstrap.sh')
const NODE_SCRIPTS = path.join(__dirname, '..', 'node')
const fx = Object.fromEntries(loadFixtures().map(f => [f.file.replace(/\.json$/, ''), f]))

const T13_AMD = 'debian-13-standard_13.6-1_amd64.tar.zst'
const T13_ARM = 'debian-13-standard_13.6-1_arm64.tar.zst'
const T13_OLD_AMD = 'debian-13-standard_13.1-2_amd64.tar.zst'
const T12_AMD = 'debian-12-standard_12.12-1_amd64.tar.zst'

// opts: { have: [templates already on 'local'], available: [templates offered], guests: { 'node/lxc/ID': conf },
//         resources: [guest IDs only the cluster's resource list knows],
//         pingable: [addresses], tokens: [existing token names], rootdir: 'pvesm status lines' }
function cluster(nodes, opts = {}) {
  const made = Object.entries(nodes).map(([name, f]) => [name, fakeNode(fx[f])])
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-boot-'))
  const bin = path.join(root, 'bin')
  const tpl = path.join(root, 'tpl')
  const tmp = path.join(root, 'tmp')
  for (const d of [bin, tpl, tmp, path.join(root, 'pve/lxc')]) fs.mkdirSync(d, { recursive: true })
  for (const t of opts.have ?? [T13_OLD_AMD]) fs.writeFileSync(path.join(tpl, t), 'template')
  fs.writeFileSync(path.join(root, 'available'),
    (opts.available ?? [T12_AMD, T13_AMD, T13_ARM]).map(t => `system          ${t}   ${/_(\w+)\.tar/.exec(t)[1]}`).join('\n') + '\n')
  for (const [where, conf] of Object.entries(opts.guests ?? {})) {
    const [node, kind, id] = where.split('/')
    const dir = path.join(root, 'pve/nodes', node, kind)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}.conf`), conf)
  }
  fs.writeFileSync(path.join(root, 'pingable'), (opts.pingable ?? []).join('\n') + '\n')
  // The node's resolver: a plain LAN one unless the test says otherwise (opts.resolv).
  fs.writeFileSync(path.join(root, 'resolv.conf'), opts.resolv ?? 'search lan\nnameserver 192.0.2.53\n')
  fs.writeFileSync(path.join(root, 'tokens'), (opts.tokens ?? []).join('\n') + (opts.tokens?.length ? '\n' : ''))
  fs.writeFileSync(path.join(root, 'rootdir'), opts.rootdir ??
    'Name Type Status Total Used Available %\nnas cifs active 9000000000 0 9000000000 0.00%\nlocal-lvm lvmthin active 300000000 0 300000000 0.00%\nsmall zfspool active 50000000 0 50000000 0.00%\n')
  const log = path.join(root, 'calls.log')
  const w = (n, body) => fs.writeFileSync(path.join(bin, n), `#!/bin/bash\necho "${n} $*" >> ${log}\n${body}\n`, { mode: 0o755 })
  const nodeJson = JSON.stringify(Object.keys(nodes).map(n => ({ node: n, status: 'online' })))
  const statusJson = JSON.stringify(Object.keys(nodes).map((n, i) => ({ type: 'node', name: n, ip: `127.0.0.${i + 2}` })))
  w('pveversion', 'echo "pve-manager/9.1.0/abc (running kernel: 7.0.0-1-pve)"')
  w('hostname', 'case "$1" in -I) echo 10.9.9.9;; *) echo installer;; esac')
  w('dpkg', '[ "$1" = --print-architecture ] && [ -n "${FAKE_ARCH-amd64}" ] && echo "${FAKE_ARCH-amd64}" && exit 0; exit 1')
  w('uname', 'case "$1" in -m) echo "${FAKE_UNAME_M:-x86_64}";; *) /bin/uname "$@";; esac')
  w('ping', `for a in "$@"; do t="$a"; done; grep -qxF "$t" \${FAKE_PINGABLE:-${root}/pingable}`)
  // iputils arping -D: exits non-zero when something replies. Some hosts drop pings but answer ARP.
  w('arping', `[ "$1" = -V ] && { echo "arping from iputils 20240905"; exit 0; }
for a in "$@"; do t="$a"; done; ! grep -qxF "$t" ${root}/arpable 2>/dev/null`)
  fs.writeFileSync(path.join(root, 'routes'), (opts.routes ?? []).join('\n') + '\n')
  w('ip', `[ "$*" = "-4 route show" ] && { cat ${root}/routes; exit 0; }; exit 0`)
  fs.writeFileSync(path.join(root, 'vztmpl'), 'Name Type Status Total Used Available %\n' + (opts.vztmpl ?? ['local dir active 900000000 1000 899999000 1%']).join('\n') + '\n')
  for (const [store, list] of Object.entries(opts.storeHas ?? {})) fs.writeFileSync(path.join(root, `has-${store}`), list.join('\n') + '\n')
  fs.writeFileSync(path.join(root, 'resources'), JSON.stringify((opts.resources ?? []).map(id => ({ id: `lxc/${id}`, type: 'lxc', vmid: id }))))
  w('pvesh', `case "$2" in
  /cluster/nextid) if [ "$3" = --vmid ]; then echo "$4"; else echo 900; fi;;
  /cluster/resources) cat ${root}/resources;;
  /nodes) echo '${nodeJson}';; /cluster/status) echo '${statusJson}';; esac`)
  w('pvesm', `case "$1 $2 $3" in
  "status -content rootdir") cat ${root}/rootdir;;
  "status -content vztmpl") cat ${root}/vztmpl;;
  path*) echo "${tpl}/\${2#*vztmpl/}";;
  list*) echo "Volid Format Type Size VMID";;
esac`)
  w('pveam', `case "$1" in
  available) cat ${root}/available;;
  list) [ -n "\${FAKE_LIST_FAIL:-}" ] && exit 1; echo "NAME SIZE"
        # A store with its own listing (opts.storeHas) lists that; any other lists what is downloaded.
        if [ -f ${root}/has-$2 ]; then sed "s|^|$2:vztmpl/|" ${root}/has-$2; else for f in ${tpl}/*; do [ -e "$f" ] && echo "$2:vztmpl/$(basename "$f")   100MB"; done; fi;;
  download) echo template > "${tpl}/$3";;
  remove) rm -f "${tpl}/\${2#*vztmpl/}";;
esac; exit 0`)
  w('pct', `case "$1" in
  status) exit 1;;
  create) ctrl_c() { kill -INT $PPID; p=$PPID; while [ "$p" -gt 1 ]; do
            if tr '\\0' ' ' < /proc/$p/cmdline | grep -q 'bootstrap.sh'; then kill -INT $p; fi
            p=$(awk '{print $4}' /proc/$p/stat); done; }
          [ "$2" = "\${FAKE_CREATE_FAIL_ID:-}" ] && { echo "unable to create CT $2 - no space left" >&2; exit 1; }
          h=""; d=""; prev=""; for a in "$@"; do [ "$prev" = --hostname ] && h="$a"; [ "$prev" = --description ] && d="$a"; prev="$a"; done
          c="$HPX_PVE_ETC/lxc/$2.conf"
          # Another run got there first: its container, with the same hostname but its own mark.
          if [ -n "\${FAKE_RACE:-}" ]; then printf '#hyperprox-install-someoneelse\nhostname: %s\n' "$h" > "$c"; echo "CT $2 already exists on node 'other'" >&2; exit 255; fi
          # Cut off right after Proxmox wrote its lock, before anything else.
          if [ -n "\${FAKE_STUB:-}" ]; then echo 'lock: create' > "$c"; ctrl_c; exit 1; fi
          printf '#%s\nhostname: %s\n' "$d" "$h" > "$c"
          [ -n "\${FAKE_PENDING:-}" ] && printf '[pve:pending]\nmemory: 4096\n' >> "$c"
          [ -n "\${FAKE_INT_ON_CREATE:-}" ] && ctrl_c; exit 0;;
  start) [ -n "\${FAKE_START_FAIL:-}" ] && exit 1; exit 0;;
  destroy) rm -f "$HPX_PVE_ETC/lxc/$2.conf"; exit 0;;
  exec) [ -t 0 ] || cat > /dev/null   # a command that reads stdin, as pct exec does
        # Tailscale in the container: joined at once, at a fixed address. WireGuard: the recipe prints the key.
        [[ "$*" == *"hpx-tailscale-install"* ]] && [ -n "\${FAKE_TS_INSTALL_FAIL:-}" ] && { echo 'curl: (6) Could not resolve host' >&2; exit 6; }
        [[ "$*" == *"tailscale up"* ]] && [ -n "\${FAKE_TS_NOLOGIN:-}" ] && { echo 'backend error: no route to the control server' >&2; exit 1; }
        [[ "$*" == *"tailscale ip -4"* ]] && [ -n "\${FAKE_TS_NOLOGIN:-}" ] && exit 1
        [[ "$*" == *"tailscale ip -4"* ]] && { echo 100.101.102.103; exit 0; }
        [[ "$*" == *"s/^SETUP_SECRET=//p"* ]] && { echo 0123456789abcdef0123456789abcdef; exit 0; }
        [[ "$*" == *"tailscale status --json"* ]] && { echo '{"Self":{"DNSName":"hyperprox.example-tailnet.ts.net.","TailscaleIPs":["100.101.102.103"]}}'; exit 0; }
        [[ "$*" == *"WIREGUARD_SERVER_RECIPE"* ]] && { echo 'echo recipe'; exit 0; }
        [[ "$*" == *"WG_ADDRESS="*"bash -s"* ]] && { echo "HP_WG_PUB=\${FAKE_WG_PUB:-QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=}"; exit 0; }
        [[ "$*" == *install.sh* ]] && [ -n "\${FAKE_INSTALL_FAIL:-}" ] && exit 1
        [[ "$*" == *"hostname -I"* ]] && echo 10.9.9.50; exit 0;;
  push) cp "$3" "${root}/pushed-\${4##*/}"; exit 0;;
  set) [ -n "\${FAKE_SET_FAIL:-}" ] && { echo "\${FAKE_SET_FAIL}" >&2; exit 255; }; exit 0;;
  *) exit 0;;
esac`)
  w('pveum', `t=${root}/tokens
case "$*" in
  *"token list"*) printf '['; sep=''; while read -r n; do [ -n "$n" ] && printf '%s{"tokenid":"%s"}' "$sep" "$n" && sep=,; done < $t; echo ']';;
  *"token add"*) echo "$5" >> $t
                 # Someone else made the same token meanwhile.
                 [ -n "\${FAKE_TOKEN_RACE:-}" ] && [ "$5" = hyperprox ] && { echo "Token already exists." >&2; exit 255; }
                 echo '{"value":"tok-secret"}';;
  *"token remove"*) grep -vxF "$5" $t > $t.new; mv $t.new $t;;
  # ACL lines, kept as Proxmox keeps them: a removed token's lines stay until deleted.
  "acl modify "*) printf '{"path":"%s","roleid":"%s","type":"token","ugid":"%s"}\n' "$3" "$7" "$5" >> ${root}/acls;;
  "acl delete "*) [ -f ${root}/acls ] && grep -vF "\"ugid\":\"$5\"" ${root}/acls > ${root}/acls.new; mv ${root}/acls.new ${root}/acls 2>/dev/null;;
  "acl list"*) printf '['; paste -sd, ${root}/acls 2>/dev/null | tr -d '\n'; echo ']';;
esac; exit 0`)
  // Exporters "answer" from here when the fixture says they would after the step: the stand-in curl
  // serves metrics for any node address on 9100, a rising RAPL counter, and the GPU ports. The node
  // scripts download (when bootstrap.sh arrives through a pipe) is served from this repository.
  w('curl', `for a in "$@"; do case "$a" in http://*|https://*) u="$a";; esac; done
o=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && o="$a"; prev="$a"; done
case "$u" in
  */packages/hardware/node/*.sh) cp "${NODE_SCRIPTS}/\${u##*/}" "$o";;
  *:9100/metrics) echo 'node_exporter_build_info{version="1.9.1"} 1'; echo "node_rapl_package_joules_total{index=\\"0\\"} $(date +%s).5"; echo 'node_drm_gpu_busy_percent{card="card1"} 3';;
  *:8081/metrics) echo 'igpu_power_package 2.1';;
  *:9835/metrics) echo 'nvidia_smi_memory_total_bytes 8.5e9';;
  https://api.godaddy.com/*) h="$(cat)"; echo "$h" > ${root}/godaddy-header; [ "$h" = 'Authorization: sso-key good-key:good-secret' ] || exit 22; exit 0;;
  *) exit 7;;
esac`)
  // ssh ... NODE 'bash -s': the probe runs against that node's fake sysroot; a step is recorded, not run.
  const envs = path.join(root, 'nodes')
  fs.mkdirSync(envs)
  for (const [name, n] of made) {
    fs.writeFileSync(path.join(envs, name), Object.entries(n.env).map(([k, v]) => `export ${k}='${v}'`).join('\n') + '\n')
  }
  w('ssh', `node="\${@: -2:1}"; s="$(cat)"
if ! grep -q '^# HyperProx node-side helpers' <<< "$s" && grep -q '^# HyperProx hardware probe' <<< "$s"; then ( . ${envs}/$node; printf '%s' "$s" | /bin/bash -s ); exit $?; fi
step="$(grep -m1 -oE '^# (Undo|node_exporter|Power|Intel GPU|NVIDIA GPU|AMD GPU|Let containers)' <<< "$s" | cut -c3-)"
echo "$node $step" >> ${root}/steps.log
printf 'HPX-RESULT\\tdone\\tset up (%s)\\n' "$step"`)
  fs.mkdirSync(path.join(root, 'sys/module/wireguard'), { recursive: true })
  // Proxmox's own config code, as bootstrap.sh's perl calls it: under the lock, the lxc lines go in before any section.
  w('perl', `grep -q lock_config <<< "$*" || exit 2
id="\${@: -1}"; c="$HPX_PVE_ETC/lxc/$id.conf"
awk 'BEGIN { l = "lxc.cgroup2.devices.allow: c 10:200 rwm\\nlxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file" } /^\\[/ && !d { print l; d = 1 } { print } END { if (!d) print l }' "$c" > "$c.new" && mv "$c.new" "$c"`)
  const env = extra => ({ PATH: `${bin}:/usr/bin:/bin`, HPX_PW_DIR: root, HPX_SYSFS: path.join(root, 'sys'), HPX_PVE_ETC: path.join(root, 'pve'), HPX_RESOLV_CONF: path.join(root, 'resolv.conf'), HOME: root, TMPDIR: tmp, LANG: 'C', TERM: 'dumb', ...extra })
  // A file of answers standing in for the keyboard (HPX_TTY).
  const tty = answers => { const f = path.join(root, `tty-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, answers); return f }
  const run = (args, input, extra = {}) => spawnSync('/bin/bash', [BOOTSTRAP, ...args], {
    input: input ?? '', encoding: 'utf8', timeout: 60_000, env: env(extra),
  })
  // As `curl ... | bash` runs it: the script itself is bash's stdin.
  const piped = (args, extra = {}) => spawnSync('/bin/bash', ['-s', '--', ...args], {
    input: fs.readFileSync(BOOTSTRAP, 'utf8'), encoding: 'utf8', timeout: 60_000, env: env(extra),
  })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  const steps = () => fs.existsSync(path.join(root, 'steps.log')) ? fs.readFileSync(path.join(root, 'steps.log'), 'utf8').trim().split('\n') : []
  const templates = () => fs.readdirSync(tpl).sort()
  const tokens = () => fs.readFileSync(path.join(root, 'tokens'), 'utf8').split('\n').filter(Boolean)
  const leftovers = () => fs.readdirSync(tmp)
  const pushed = name => { const f = path.join(root, `pushed-${name}`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }
  return {
    root, env, tty, run, piped, calls, steps, templates, tokens, leftovers, pushed,
    cleanup: () => { made.forEach(([, n]) => n.cleanup()); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const askOf = id => hw.QUESTIONS.find(q => q.id === id).ask
const createLine = c => c.calls().split('\n').find(l => l.startsWith('pct create')) ?? ''

test('-y --dry-run: a tidy list per node, a plan per node, and nothing changed', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'fresh-intel-node', 'node-c': 'server-no-gpu' })
  try {
    const r = c.run(['-y', '--dry-run'])
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    assert.match(out, /Found 3 nodes:\n\s+• node-a: NVIDIA GeForce GTX 1070 Ti \(dedicated\) · health monitoring ✓/)
    assert.match(out, /\n\s+• node-b: Intel HD Graphics 630 \(built in\)\n/)
    assert.match(out, /\n\s+• node-c: no GPU · no power counters\n/)
    assert.match(out, /• node-b: Health monitoring\n\s+• node-b: Power monitoring\n\s+• node-b: Intel GPU monitoring\n\s+• node-c: Health monitoring\n/)
    assert.doesNotMatch(out, /node-a: (Health monitoring|NVIDIA GPU monitoring)/, 'already running on node-a: not planned')
    assert.match(out, /Already on node-a; this is about node-b, node-c\./)
    assert.match(out, /built-in graphics \(for video transcoding\)\? no/, '-y offers it but answers no')
    assert.doesNotMatch(out, /Built-in graphics for containers\n/, 'and plans nothing for it')
    assert.match(out, /Dry run: nothing was changed/)
    assert.doesNotMatch(c.calls(), /^(pct create|pveum user token add|pveum acl|pveam download)/m)
    assert.deepEqual(c.steps(), [])
  } finally { c.cleanup() }
})

test('each node shows the same GPU words as the setup wizard, Ceph on a line of its own', () => {
  const c = cluster({ 'node-a': 'amd-apu', 'node-b': 'intel-igpu-psys' })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    ;['amd-apu', 'intel-igpu-psys'].forEach((f, i) => {
      const n = fakeNode(fx[f])
      try {
        const node = hw.parseProbe(n.run(hw.probeScript()).stdout, `node-${'ab'[i]}`)
        const short = g => hw.gpuWords({ ...g, name: g.name.replace(/ \/ .*/, '').replace(/ Series$/, '') })
        const words = node.gpus.length ? node.gpus.map(short).join(', ') : 'no GPU'
        assert.ok(out.includes(`• ${node.node}: ${words}`), `${out}\n--- wanted: ${words}`)
        if (node.ceph) assert.match(out, /\n    Ceph storage found\.\n/)
      } finally { n.cleanup() }
    })
  } finally { c.cleanup() }
})

test('answers piped in: asked in order, only what applies, and the plan follows them', () => {
  const c = cluster({ 'node-a': 'fresh-intel-node', 'node-b': 'server-no-gpu' })
  try {
    // health no, power yes, gpu no, built-in graphics yes, charts yes, proxmox metrics no, dns no, ai no
    const r = c.run(['--dry-run'], 'n\ny\nn\ny\ny\nn\nn\nn\n')
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    const asked = hw.QUESTIONS.filter(q => out.includes(q.ask)).map(q => q.id)
    assert.deepEqual(asked, ['node-health', 'power', 'gpu', 'igpu-access', 'charts', 'proxmox-metrics', 'dns', 'ai'])
    assert.match(out, /Then, on your nodes, one at a time:\n\s+• node-a: Power monitoring\n\s+• node-a: Built-in graphics for containers\n\s+In HyperProx/)
    assert.match(out, /Applies to node-a\./)
    assert.match(out, /charts yes · Proxmox metrics no · GoDaddy no · local AI no/)
  } finally { c.cleanup() }
})

test('no GPU and no power counters anywhere: neither question is asked', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    const out = plain(c.run(['--dry-run'], 'y\ny\nn\nn\nn\n').stdout)
    assert.ok(!out.includes(askOf('igpu-access')), 'no built-in graphics: not offered')
    assert.ok(!out.includes(askOf('gpu')))
    assert.ok(!out.includes(askOf('power')))
    assert.ok(out.includes(askOf('node-health')))
  } finally { c.cleanup() }
})

test('health and GPU monitoring already on every node: neither is asked, and both are said', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'nvidia-dedicated' })
  try {
    const r = c.run(['--dry-run'], c.tty('n\nn\nn\nn\n'))
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    assert.match(out, /\[ ok \] Health monitoring already running on all 2 nodes/)
    assert.match(out, /\[ ok \] GPU monitoring already running on all 2 nodes/)
    assert.ok(!out.includes(askOf('node-health')), 'not asked')
    assert.ok(!out.includes(askOf('gpu')), 'not asked')
    assert.match(out, /Nothing to change on your nodes\./)
  } finally { c.cleanup() }
})

test('health monitoring on some nodes: asked only about the rest, by name', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'fresh-intel-node' })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.ok(out.includes(askOf('node-health')))
    assert.match(out, /Already on node-a; this is about node-b\./)
    assert.match(out, /• node-b: Health monitoring/)
    assert.doesNotMatch(out, /• node-a: Health monitoring/)
  } finally { c.cleanup() }
})

test('an AMD-only cluster is asked about its GPU, and the plan turns on node_exporter\'s AMD figures', () => {
  const c = cluster({ 'node-a': 'amd-apu' })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.ok(out.includes(askOf('gpu')))
    assert.doesNotMatch(out, /not covered/)
    assert.match(out, /node-a: AMD GPU monitoring/)
  } finally { c.cleanup() }
})

test('the shell asks exactly the words the wizard asks', () => {
  const src = fs.readFileSync(BOOTSTRAP, 'utf8')
  const vars = { 'node-health': 'NODE_HEALTH', power: 'POWER', gpu: 'GPU', 'igpu-access': 'IGPU', charts: 'CHARTS', 'proxmox-metrics': 'PVE_METRICS', dns: 'DNS', ai: 'AI' }
  for (const q of hw.QUESTIONS) {
    const v = vars[q.id]
    const get = k => { const m = new RegExp(`^${k}_${v}=(['"])(.*)\\1$`, 'm').exec(src); return m && m[2] }
    assert.equal(get('Q'), q.ask, q.id)
    assert.equal(get('W'), q.what, q.id)
  }
})

// ── Template: only ever one built for this host's CPU ──────────────────────────────────────────────────

test('an arm64 template already downloaded on an amd64 host is ignored; the newest amd64 one is fetched', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_ARM, T13_OLD_AMD] })
  try {
    const r = c.run(['-y', '--no-pve-metrics'])
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    assert.match(out, /CPU architecture: amd64/)
    assert.doesNotMatch(out, /Ignoring/, 'a template for another CPU is passed over without a line about it')
    assert.match(out, new RegExp(`Template\\s+${T13_AMD.replace(/\./g, '\\.')} \\(amd64\\) on local, downloaded first`))
    assert.match(c.calls(), new RegExp(`^pveam download local ${T13_AMD}$`, 'm'))
    const create = createLine(c)
    assert.ok(create.includes(`local:vztmpl/${T13_AMD}`), create)
    assert.match(create, /--arch amd64/)
    assert.ok(!create.includes(T13_ARM), 'never the arm64 one')
    assert.ok(c.templates().includes(T13_ARM), 'the other template is left where it was')
  } finally { c.cleanup() }
})

test('the newest matching template already there is used, not downloaded again', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD, T13_ARM] })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.match(out, new RegExp(`Template: ${T13_AMD.replace(/\./g, '\\.')} \\(amd64\\), already on local`))
    assert.doesNotMatch(c.calls(), /pveam download/)
  } finally { c.cleanup() }
})

test('an arm64 host takes the arm64 template; without dpkg the CPU comes from uname', () => {
  for (const extra of [{ FAKE_ARCH: 'arm64' }, { FAKE_ARCH: '', FAKE_UNAME_M: 'aarch64' }]) {
    const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
    try {
      const r = c.run(['-y', '--no-pve-metrics'], '', extra)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(createLine(c), new RegExp(`local:vztmpl/${T13_ARM}.* --arch arm64`))
    } finally { c.cleanup() }
  }
})

test('only a wrong-architecture template anywhere: it stops rather than use it', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_ARM], available: [T13_ARM] })
  try {
    const r = c.run(['-y'])
    assert.notEqual(r.status, 0)
    assert.match(plain(r.stderr), /No Debian container template for amd64/)
    assert.doesNotMatch(c.calls(), /^pct create/m)
  } finally { c.cleanup() }
})

test('a template that is listed but cannot be read stops the run before anything is made', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    fs.writeFileSync(path.join(c.root, 'tpl', T13_AMD), '')   // empty: a broken mount, a cut-off copy
    const r = c.run(['-y'])
    assert.notEqual(r.status, 0)
    assert.match(plain(r.stderr), /is listed but cannot be read/)
    assert.doesNotMatch(c.calls(), /^pct create/m)
  } finally { c.cleanup() }
})

test('rootfs storage: block storage with room, not the biggest network share or one too small', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.match(out, /Rootfs storage: local-lvm/)
  } finally { c.cleanup() }
})

// ── Numbering ──────────────────────────────────────────────────────────────────────────────────────────

const lxc = (ip, gw = '192.0.2.1') => `arch: amd64\nhostname: g\nnet0: name=eth0,bridge=vmbr0,gw=${gw},hwaddr=BC:24:11:00:00:01,ip=${ip},type=veth\n`
const conventional = {
  'installer/lxc/101': lxc('192.0.2.201/24'),
  'installer/lxc/103': lxc('192.0.2.203/24'),
  'node-a/lxc/202': lxc('192.0.2.202/24'),
  'node-a/qemu-server/204': 'name: vm\nipconfig0: ip=192.0.2.204/24,gw=192.0.2.1\n',
  'node-a/lxc/150': lxc('192.0.2.77/24'),
  'node-a/lxc/151': 'net0: name=eth0,bridge=vmbr0,ip=dhcp,type=veth\n',
}

test('numbering: guests follow <node#><IP>, so a free ID and a free address that fit are offered', () => {
  // .200 answers a ping; 101 and 103 are taken; .202 and .204 are in other guests' configs.
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: conventional, pingable: ['192.0.2.200'] })
  try {
    const r = c.run(['-y', '--no-pve-metrics'])
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    assert.match(out, /Your guests follow <node#><IP> numbering \(4 of 5 do\); use CT 105 with IP 192\.0\.2\.205\/24 \(gateway 192\.0\.2\.1\)\? yes/)
    assert.match(out, /Container ID 105/)
    assert.match(out, /Network\s+192\.0\.2\.205\/24, gateway 192\.0\.2\.1, on vmbr0/)
    assert.match(createLine(c), /^pct create 105 .*--net0 name=eth0,bridge=vmbr0,ip=192\.0\.2\.205\/24,gw=192\.0\.2\.1/)
    assert.match(c.calls(), /^ping .*192\.0\.2\.200$/m)
  } finally { c.cleanup() }
})

test('numbering at a terminal: another ID typed keeps DHCP', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: conventional })
  try {
    // ID 900 instead of the numbering's, Enter at the address (DHCP), defaults for the rest, VPN not now,
    // and "Create it?" no.
    const r = c.run([], '', { HPX_TTY: c.tty('900\n\n\n\n\n\n\n\nn\n') })
    const out = plain(r.stdout + r.stderr)
    assert.match(out, /Container ID 900/)
    assert.match(out, /Network\s+DHCP on vmbr0/)
    assert.match(out, /Create it\? \[Y\/n\]/)
    assert.match(out, /Cancelled\. Nothing was created\./)
    assert.doesNotMatch(c.calls(), /^pct create/m)
  } finally { c.cleanup() }
})

test('numbering: guests that do not follow it get no offer', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: {
    'node-a/lxc/100': lxc('192.0.2.50/24'), 'node-a/lxc/101': lxc('192.0.2.51/24'),
    'node-a/lxc/102': lxc('192.0.2.233/24'), 'installer/lxc/103': lxc('192.0.2.203/24'),
  } })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.doesNotMatch(out, /numbering/)
    assert.match(out, /Container ID 900/)
    assert.match(out, /Network: DHCP/)
  } finally { c.cleanup() }
})

// ── Asked for the ID and the address ───────────────────────────────────────────────────────────────────

test('at a terminal the ID is asked for: a bad or used one is asked again, Enter at the address keeps DHCP', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: { 'node-a/lxc/950': lxc('192.0.2.50/24') }, resources: [960] })
  try {
    // ID: abc, 99, 950 (a config), 960 (only the cluster's list), 951; address Enter; health, charts, dns, ai: no
    const r = c.run(['--dry-run'], '', { HPX_TTY: c.tty('abc\n99\n950\n960\n951\n\nn\nn\nn\nn\n\n') })
    const out = r.stdout + r.stderr
    assert.equal(r.status, 0, out)
    assert.ok(!/\x1b/.test(out), 'no escape codes when the output is not a terminal')
    assert.match(out, /Which ID should the HyperProx container get\?\n.*\n  \[900\]/)
    assert.match(out, /abc is not a container ID: it must be a number of 100 or more\./)
    assert.match(out, /99 is not a container ID/)
    assert.match(out, /ID 950 is already used \([^)]*950\.conf\)\. Choose another\./)
    assert.match(out, /ID 960 is already used \(the cluster's guest list\)\. Choose another\./)
    assert.match(out, /Container ID 951/)
    assert.match(out, /Container\s+951 \(hyperprox\)/)
    assert.match(out, /Network\s+DHCP on vmbr0/)
    assert.match(out, /Dry run: nothing was changed/)
  } finally { c.cleanup() }
})

test('at a terminal the address is asked for: a used one is asked again, then the gateway, and it is created so', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: { 'node-a/lxc/950': lxc('192.0.2.50/24') }, pingable: ['192.0.2.61'] })
  try {
    // ID Enter; address: junk, .50 (a config), .61 (answers a ping), .60; gateway: Enter (none known), then
    // 192.0.2.1; health, charts, dns, ai: no; VPN not now; create yes
    const r = c.run([], '', { HPX_TTY: c.tty('\nfoo\n192.0.2.50/24\n192.0.2.61/24\n192.0.2.60/24\n\n198.51.100.1\n192.0.2.1\nn\nn\nn\nn\n\ny\n') })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /foo is not one of the choices/)
    assert.match(out, /Another guest's config already uses 192\.0\.2\.50\. Choose another\./)
    assert.match(out, /Something already answers on 192\.0\.2\.61\. Choose another\./)
    assert.match(out, /Which gateway should 192\.0\.2\.60\/24 use\?/)
    assert.match(out, /198\.51\.100\.1 is not inside 192\.0\.2\.60\/24/)
    assert.match(out, /Network\s+192\.0\.2\.60\/24, gateway 192\.0\.2\.1, on vmbr0/)
    assert.match(createLine(c), /^pct create 900 .*--net0 name=eth0,bridge=vmbr0,ip=192\.0\.2\.60\/24,gw=192\.0\.2\.1/)
  } finally { c.cleanup() }
})

test('at a terminal, an accepted numbering offer is the default for the ID and the address', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: conventional, pingable: ['192.0.2.200'] })
  try {
    // Enter at the ID and the address (both the numbering's); health, charts, dns, ai: no; VPN not now
    const r = c.run(['--dry-run'], '', { HPX_TTY: c.tty('\n\nn\nn\nn\nn\n\n') })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /Which ID should the HyperProx container get\?\n.*numbering \(4 of 5 do\).*\n  \[105\]/)
    assert.match(out, /1  Static  192\.0\.2\.205\/24  via 192\.0\.2\.1  \(matches ID\)/)
    assert.match(out, /Container ID 105/)
    assert.match(out, /Network\s+192\.0\.2\.205\/24, gateway 192\.0\.2\.1, on vmbr0/)
  } finally { c.cleanup() }
})

test('-y, --vmid/--ip or no terminal: the ID and the address are not asked for', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    for (const [args, extra] of [[['-y', '--dry-run'], {}], [['--dry-run', '--vmid', '777', '--ip', '192.0.2.70/24', '--gateway', '192.0.2.1'], { HPX_TTY: c.tty('n\nn\nn\nn\n') }],
                                 [['--dry-run'], { HPX_TTY: '/nonexistent/tty' }]]) {
      const r = c.run(args, '', extra)
      const out = plain(r.stdout + r.stderr)
      assert.equal(r.status, 0, out)
      assert.doesNotMatch(out, /Which container ID|Which address should/)
    }
  } finally { c.cleanup() }
})

// ── Remote access (VPN) ────────────────────────────────────────────────────────────────────────────────

test('VPN at a terminal: WireGuard asks for a tunnel network that overlaps nothing, and the plan says so', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: { 'node-a/lxc/950': lxc('192.0.2.50/24') } })
  try {
    // ID, address: Enter; health, charts, dns, ai: no; VPN 2; tunnel: one on the LAN, then Enter; address: Enter
    const r = c.run(['--dry-run'], '', { HPX_TTY: c.tty('\n\nn\nn\nn\nn\n2\n192.0.2.1/24\n10.99.0.255/24\n10.99.0.0/24\n\n\n') })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /How do you want to reach HyperProx when you are away from home\?/)
    assert.match(out, /192\.0\.2\.1\/24 overlaps 192\.0\.2\.50\/24/)
    assert.match(out, /10\.99\.0\.255 is the network's broadcast address/)
    assert.match(out, /10\.99\.0\.0 is the network's network address/)
    assert.match(out, /VPN\s+WireGuard in a small container of its own \(next free ID\), tunnel 10\.99\.0\.1\/24, UDP 51820/)
    assert.doesNotMatch(c.calls(), /^pct create/m)
  } finally { c.cleanup() }
})

test('VPN: WireGuard without the kernel module on the node is skipped, and the node is not changed', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    fs.rmSync(path.join(c.root, 'sys/module/wireguard'), { recursive: true })
    const out = plain(c.run(['-y', '--dry-run', '--vpn', 'wireguard']).stdout)
    assert.match(out, /WireGuard kernel module is not loaded/)
    assert.match(out, /modprobe wireguard && echo wireguard > \/etc\/modules-load\.d\/wireguard\.conf/, 'the one-line fix')
    assert.match(out, /VPN\s+not now/)
    assert.doesNotMatch(c.calls(), /modprobe/)
  } finally { c.cleanup() }
})

test('VPN at a terminal without the WireGuard module: the menu says why and how, and choosing it is refused', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    fs.rmSync(path.join(c.root, 'sys/module/wireguard'), { recursive: true })
    // ID, address: Enter; health, charts, dns, ai: no; VPN 2 (refused), then 3
    const r = c.run(['--dry-run'], '', { HPX_TTY: c.tty('\n\nn\nn\nn\nn\n2\n3\n\n') })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /WireGuard\s+not available: the wireguard module is not loaded on/)
    assert.match(out, /modprobe wireguard && echo wireguard > \/etc\/modules-load\.d\/wireguard\.conf/)
    assert.match(out, /WireGuard needs the wireguard module/)
    assert.match(out, /VPN\s+not now/)
    assert.doesNotMatch(c.calls(), /modprobe/)
  } finally { c.cleanup() }
})

test('VPN: -y does not ask and sets nothing up; no terminal and no key skips Tailscale', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.doesNotMatch(out, /How do you want to reach HyperProx/)
    assert.match(out, /VPN\s+not now \(add it later on the VPN page\)/)
    const ts = plain(c.run(['-y', '--dry-run', '--vpn', 'tailscale'], '', { HPX_TTY: '/nonexistent/tty' }).stdout)
    assert.match(ts, /no terminal to show it on: skipped/)
  } finally { c.cleanup() }
})

test('VPN: Tailscale with TS_AUTHKEY joins unattended; the key is on no command line and in no file handed over', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  const key = 'tskey-auth-kTESTONLY0000-abcdefghijklmnop'
  try {
    const r = c.run(['-y', '--no-pve-metrics'], '', { TS_AUTHKEY: key })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.ok(!c.calls().includes(key), 'not on any command line')
    assert.ok(!out.includes(key), 'not printed')
    assert.match(c.calls(), /tailscale up --auth-key=file:\/run\/hpx-ts\.key .*--accept-dns=false/)
    assert.match(out, /Away\s+https:\/\/hyperprox\.example-tailnet\.ts\.net\/\s+\(Tailscale\)/)
    const marker = JSON.parse(c.pushed('vpn-pending.json'))
    assert.deepEqual(marker.entries, [{ kind: 'tailscale', ctid: 900, machineId: 'lxc-900', hostname: 'hyperprox', ip: '100.101.102.103', dnsName: 'hyperprox.example-tailnet.ts.net' }])
    assert.ok(!c.pushed('vpn-pending.json').includes('tskey'))
    assert.match(c.pushed('bootstrap.json'), /"vpn":"tailscale"/)
  } finally { c.cleanup() }
})

test('VPN: WireGuard -y makes its own unprivileged container, runs the recipe there and hands over public facts only', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y', '--no-pve-metrics', '--vpn', 'wireguard', '--wg-endpoint', 'vpn.example.com'])
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    const wg = c.calls().split('\n').find(l => l.startsWith('pct create 901 ')) ?? ''
    assert.match(wg, /--hostname hyperprox-wg .*--unprivileged 1/)
    assert.match(c.calls(), /WIREGUARD_SERVER_RECIPE/, 'the Catalogue recipe, from the installed copy')
    const marker = JSON.parse(c.pushed('vpn-pending.json'))
    assert.deepEqual(marker.entries, [{ kind: 'wireguard', ctid: 901, machineId: 'lxc-901', iface: 'hp-wg0', address: '10.99.0.1/24',
      listenPort: 51820, endpoint: 'vpn.example.com:51820', publicKey: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=' }])
    assert.doesNotMatch(c.pushed('vpn-pending.json'), /private/i)
    assert.match(out, /forward UDP 51820 to 10\.9\.9\.50/)
  } finally { c.cleanup() }
})

test('VPN: a failed install removes the WireGuard container too', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y', '--no-pve-metrics', '--vpn', 'wireguard'], '', { FAKE_INSTALL_FAIL: '1' })
    assert.equal(r.status, 1)
    assert.match(c.calls(), /^pct destroy 901 --purge$/m)
    assert.match(c.calls(), /^pct destroy 900 --purge$/m)
  } finally { c.cleanup() }
})

test('VPN: a network in this node\'s routes is not offered for the tunnel', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { routes: ['10.99.0.0/16 via 192.0.2.254 dev vmbr0', 'default via 192.0.2.1 dev vmbr0'] })
  try {
    const out = plain(c.run(['-y', '--dry-run', '--vpn', 'wireguard']).stdout)
    assert.match(out, /tunnel 10\.98\.0\.1\/24/)
  } finally { c.cleanup() }
})

test('VPN: a WireGuard container that cannot be made is given up; HyperProx is still installed', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y', '--no-pve-metrics', '--vpn', 'wireguard'], '', { FAKE_CREATE_FAIL_ID: '901' })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /Could not create the WireGuard container/)
    assert.match(out, /WireGuard was not set up; add it later on the VPN page/)
    assert.doesNotMatch(c.calls(), /^pct destroy 900/m, 'HyperProx\'s container stays')
    assert.equal(c.pushed('vpn-pending.json'), null)
    assert.match(out, /HyperProx is ready/)
  } finally { c.cleanup() }
})

test('VPN: Tailscale that cannot install, or gives no sign-in link, warns with the reason and the install goes on at once', () => {
  for (const [extra, why] of [[{ FAKE_TS_INSTALL_FAIL: '1' }, /Tailscale could not be installed/], [{ FAKE_TS_NOLOGIN: '1' }, /did not give a sign-in link[^]*backend error: no route to the control server/]]) {
    const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
    try {
      const t0 = Date.now()
      // ID, address: Enter; health, charts, dns, ai: no; VPN 1 (Tailscale); create yes
      const r = c.run([], '', { HPX_TTY: c.tty('\n\nn\nn\nn\nn\n1\ny\n'), ...extra })
      const out = plain(r.stdout + r.stderr)
      assert.equal(r.status, 0, out)
      assert.match(out, why)
      assert.match(out, /HyperProx is ready/)
      assert.ok(Date.now() - t0 < 45_000, 'no 15-minute wait')
      assert.equal(c.pushed('vpn-pending.json'), null)
    } finally { c.cleanup() }
  }
})

test('the Tailscale auth key is refused on the command line; a file: path is taken', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    const raw = c.run(['-y', '--dry-run', '--tailscale-authkey', 'tskey-auth-kTESTONLY0000-abcdefgh'])
    assert.notEqual(raw.status, 0)
    assert.match(plain(raw.stderr), /takes file:\/path\/to\/key only[^]*TS_AUTHKEY/)
    const f = path.join(c.root, 'ts.key'); fs.writeFileSync(f, 'tskey-auth-kTESTONLY0000-abcdefgh\n')
    const ok = plain(c.run(['-y', '--dry-run', '--tailscale-authkey', `file:${f}`]).stdout)
    assert.match(ok, /VPN\s+Tailscale in this container, joined with the auth key given/)
  } finally { c.cleanup() }
})

test('the root password is saved root-only and not printed; a link in its place is refused', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y', '--no-pve-metrics', '--password', 'Sekrit-Test-Pw1'])
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    const f = path.join(c.root, 'hyperprox-900.txt')
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    assert.match(fs.readFileSync(f, 'utf8'), /root password: Sekrit-Test-Pw1/)
    assert.ok(!out.includes('Sekrit-Test-Pw1'), 'not printed when it was saved')
    assert.match(out, /Root pw\s+saved in .*hyperprox-900\.txt/)
  } finally { c.cleanup() }
  const d = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    fs.symlinkSync('/nonexistent-target', path.join(d.root, 'hyperprox-900.txt'))
    const out = plain(d.run(['-y', '--no-pve-metrics', '--password', 'Sekrit-Test-Pw1']).stdout)
    assert.match(out, /is a symbolic link; the root password is not written there/)
    assert.match(out, /Root pw\s+Sekrit-Test-Pw1/)
  } finally { d.cleanup() }
})

// ── From the first install test ────────────────────────────────────────────────────────────────────────

test('template storage: one that already keeps a Debian 13 template, else a file store that is not CephFS; --template-storage wins', () => {
  const stores = ['media cephfs active 99000000000 0 99000000000 1%', 'nas cifs active 5000000000 0 5000000000 1%', 'local dir active 900000000 1000 899999000 1%']
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [], vztmpl: stores, storeHas: { media: [], nas: [], local: [T13_OLD_AMD] } })
  try {
    assert.match(plain(c.run(['-y', '--dry-run']).stdout), new RegExp(`Template: ${T13_AMD.replace(/\./g, '\\.')} \\(amd64\\), to be downloaded to local`))
  } finally { c.cleanup() }
  const d = cluster({ 'node-a': 'server-no-gpu' }, { have: [], vztmpl: stores, storeHas: { media: [], nas: [], local: [] } })
  try {
    assert.match(plain(d.run(['-y', '--dry-run']).stdout), /to be downloaded to nas/, 'the biggest store is CephFS: passed over')
    assert.match(plain(d.run(['-y', '--dry-run', '--template-storage', 'media']).stdout), /to be downloaded to media/)
    const bad = d.run(['-y', '--dry-run', '--template-storage', 'nope'])
    assert.match(plain(bad.stderr), /Storage 'nope' is not active on this node, or does not take container templates/)
  } finally { d.cleanup() }
})

test('tun: pct set --dev0 when PVE takes it; else the lines go before a [pve:pending] block, never after it', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    assert.equal(c.run(['-y', '--no-pve-metrics']).status, 0)
    assert.match(c.calls(), /^pct set 900 --dev0 \/dev\/net\/tun$/m)
  } finally { c.cleanup() }
  const d = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = d.run(['-y', '--no-pve-metrics'], '', { FAKE_SET_FAIL: "400 Parameter verification failed. dev0: property is not defined in schema and the schema does not allow additional properties", FAKE_PENDING: '1' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const conf = fs.readFileSync(path.join(d.root, 'pve/lxc/900.conf'), 'utf8')
    const at = conf.indexOf('lxc.cgroup2.devices.allow: c 10:200 rwm'), pend = conf.indexOf('[pve:pending]')
    assert.ok(at >= 0 && pend > at, conf)
    assert.match(conf, /lxc\.mount\.entry: \/dev\/net\/tun dev\/net\/tun none bind,create=file\n\[pve:pending\]/)
    assert.match(d.calls(), /^perl -e .*lock_config.*write_config/ms, 'through Proxmox\'s own config code, under its lock')
  } finally { d.cleanup() }
  const e = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = e.run(['-y', '--no-pve-metrics'], '', { FAKE_SET_FAIL: "CT 900 is locked (backup)" })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /Could not give container 900 \/dev\/net\/tun \(pct set: CT 900 is locked \(backup\)\)/)
    assert.doesNotMatch(e.calls(), /^perl /m, 'another refusal is reported, never worked around')
    assert.doesNotMatch(fs.readFileSync(path.join(e.root, 'pve/lxc/900.conf'), 'utf8'), /10:200/)
  } finally { e.cleanup() }
})

test('token name: a taken one is asked about at a terminal (Enter makes a free one); --token-name; host and port always written', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], tokens: ['hyperprox'] })
  try {
    // ID, address: Enter; health, charts, dns, ai: no; token: Enter; VPN: Enter; create yes
    const r = c.run([], '', { HPX_TTY: c.tty('\n\nn\nn\nn\nn\n\n\ny\n') })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /A token named hyperprox exists already/)
    assert.match(c.calls(), /pveum user token add root@pam hyperprox-2 /)
    assert.match(c.calls(), /pct exec 900 -- env HPX_HOST=\S+ HPX_TOKEN_ID=hyperprox-2 bash -c/)
    assert.ok(!c.calls().includes('tok-secret'), 'the secret is on no command line')
  } finally { c.cleanup() }
  const d = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], tokens: ['hyperprox'] })
  try {
    assert.equal(d.run(['-y', '--no-pve-metrics', '--token-name', 'hyperprox-test']).status, 0)
    assert.match(d.calls(), /pveum user token add root@pam hyperprox-test /)
  } finally { d.cleanup() }
  const e = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], tokens: ['hyperprox'] })
  try {
    const out = plain(e.run(['-y', '--no-pve-metrics']).stdout)
    assert.doesNotMatch(e.calls(), /pveum user token add root@pam hyperprox /)
    assert.match(e.calls(), /pct exec 900 -- env HPX_HOST=\S+ HPX_TOKEN_ID=hyperprox bash -c/, 'the address and the kept token\'s name are written')
    assert.match(out, /Proxmox address and token name configured/)
    assert.equal(e.run(['-y', '--dry-run', '--token-name', 'a']).status, 1, 'a one-letter name is refused')
  } finally { e.cleanup() }
})

test('the end: one card with the setup link and its key, no yes pipe, the run mark replaced, checks summarised', () => {
  const c = cluster({ 'node-a': 'fresh-intel-node' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y', '--no-pve-metrics'])
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 0, out)
    assert.match(out, /Open\s+https:\/\/10\.9\.9\.50\/setup#k=0123456789abcdef0123456789abcdef/)
    assert.match(out, /finish the wizard; it already has your answers from here/)
    assert.doesNotMatch(c.calls(), /yes \|/)
    assert.match(c.calls(), /bash \/tmp\/install\.sh < \/dev\/null/)
    assert.match(c.calls(), /^pct set 900 --description HyperProx, installed by bootstrap\.sh on \d{4}-\d\d-\d\d$/m)
    assert.match(out, /checks? (answer|do not answer) from here/)
  } finally { c.cleanup() }
})

// ── The terminal, and `curl | bash` ────────────────────────────────────────────────────────────────────

test('without a terminal and without -y it shows the defaults and stops before changing anything', () => {
  const c = cluster({ 'node-a': 'fresh-intel-node' })
  try {
    const r = c.run([], '', { HPX_TTY: '/nonexistent/tty' })
    const out = plain(r.stdout + r.stderr)
    assert.notEqual(r.status, 0)
    assert.match(out, /No terminal to ask on, so the defaults are shown/)
    assert.match(out, /No terminal to confirm on\. Re-run with -y/)
    assert.doesNotMatch(c.calls(), /^(pct create|pveam download)/m)
    assert.deepEqual(c.steps(), [])
  } finally { c.cleanup() }
})

test('answers piped into a file run still need -y to create anything', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    const r = c.run([], 'y\ny\ny\nn\nn\ny\n')
    assert.notEqual(r.status, 0)
    assert.match(plain(r.stderr), /No terminal to confirm on/)
    assert.doesNotMatch(c.calls(), /^pct create/m)
  } finally { c.cleanup() }
})

test('through a pipe, like curl | bash: questions come from the terminal and the script is not eaten', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'fresh-intel-node' })
  try {
    // ID and address: Enter; health yes, power no, gpu yes, built-in graphics no, charts yes, metrics no, dns no,
    // ai no, VPN not now, create yes
    const r = c.piped([], { HPX_TTY: c.tty('\n\ny\nn\ny\nn\ny\nn\nn\nn\n\ny\n') })
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    assert.match(out, /Create it\? \[Y\/n\]/)
    assert.deepEqual(c.steps(), ['node-b node_exporter', 'node-b Intel GPU'])
    assert.match(out, /HyperProx is ready/, 'pct exec read stdin, and the rest of the script was still there')
    assert.deepEqual(c.leftovers(), [], 'the downloaded node scripts are removed')
  } finally { c.cleanup() }
})

test('through a pipe with no terminal: refuses, unless HYPERPROX_YES=1', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    const no = c.piped([], { HPX_TTY: '/nonexistent/tty' })
    assert.notEqual(no.status, 0)
    assert.match(plain(no.stderr), /No terminal to confirm on/)
    assert.doesNotMatch(c.calls(), /^pct create/m)
    const yes = c.piped([], { HPX_TTY: '/nonexistent/tty', HYPERPROX_YES: '1' })
    assert.equal(yes.status, 0, yes.stdout + yes.stderr)
    assert.match(createLine(c), /^pct create 900 /)
    assert.deepEqual(c.leftovers(), [])
  } finally { c.cleanup() }
})

// ── Leaving nothing behind ──────────────────────────────────────────────────────────────────────────────

test('Ctrl+C at a question: nothing is created and nothing is left behind', async () => {
  const c = cluster({ 'node-a': 'fresh-intel-node' })
  const fifo = path.join(c.root, 'keyboard')
  spawnSync('mkfifo', [fifo])
  const hold = fs.openSync(fifo, 'r+')   // a keyboard nobody types on
  try {
    const child = spawn('/bin/bash', ['-s'], { env: c.env({ HPX_TTY: fifo }) })
    child.stdin.end(fs.readFileSync(BOOTSTRAP, 'utf8'))
    let out = ''
    const done = new Promise(res => child.on('close', (code, sig) => res({ code, sig })))
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no question came: ' + out)), 30_000)
      child.stdout.on('data', d => { out += d; if (/\[(Y\/n|900)\]/.test(out)) { clearTimeout(t); res() } })
    })
    child.kill('SIGINT')
    const { code } = await done
    assert.equal(code, 130, out)
    assert.match(plain(out), /Stopped\. Nothing was created\./)
    assert.doesNotMatch(c.calls(), /^(pct create|pveam download|pveum user token add)/m)
    assert.deepEqual(c.leftovers(), [], 'temporary files removed')
  } finally { fs.closeSync(hold); c.cleanup() }
})

test('Ctrl+C while the container is being made: the container and the downloaded template are removed', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_ARM] })
  try {
    const r = c.run(['-y'], '', { FAKE_INT_ON_CREATE: '1' })
    const out = plain(r.stdout)
    assert.equal(r.status, 130, out + r.stderr)
    assert.match(out, /Interrupted — undoing what this run created/)
    assert.match(c.calls(), /^pct destroy 900 --purge$/m)
    assert.match(c.calls(), new RegExp(`^pveam remove local:vztmpl/${T13_AMD}$`, 'm'))
    assert.deepEqual(c.templates(), [T13_ARM], 'the template that was already there is untouched')
    assert.doesNotMatch(c.calls(), /token add/, 'stopped before the tokens')
  } finally { c.cleanup() }
})

test('a failed install undoes what it made, and never touches what was there before', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'fresh-intel-node' }, { have: [T13_AMD], tokens: ['hyperprox'] })
  try {
    const r = c.run(['-y', '--igpu', '--skip-rapl'], '', { FAKE_INSTALL_FAIL: '1' })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 1, out)
    assert.match(out, /Stopped — undoing what this run created/)
    assert.match(c.calls(), /^pct destroy 900 --purge$/m)
    assert.match(c.calls(), /^pveum user token remove root@pam hyperprox-exporter$/m)
    // Its ACL line goes first: Proxmox keeps a removed token's lines ("ignore invalid acl token").
    const calls = c.calls()
    const aclDel = calls.search(/^pveum acl delete \/ --tokens root@pam!hyperprox-exporter --roles PVEAuditor$/m)
    assert.ok(aclDel >= 0 && aclDel < calls.search(/^pveum user token remove root@pam hyperprox-exporter$/m), calls)
    assert.doesNotMatch(calls, /^pveum acl delete \S+ --tokens root@pam!hyperprox /m, 'the kept token\'s lines are not touched')
    assert.doesNotMatch(c.calls(), /^pveum user token remove root@pam hyperprox$/m, 'the token that was there before stays')
    assert.doesNotMatch(c.calls(), /^pveum acl modify \/ --token root@pam!hyperprox --role/m, 'and its permissions are not changed')
    assert.deepEqual(c.tokens(), ['hyperprox'])
    assert.ok(c.steps().includes('node-b Undo'), `built-in graphics undone: ${c.steps()}`)
    assert.match(out, /Left in place on node-b: Health monitoring/)
    assert.doesNotMatch(c.calls(), /^pveam remove/m, 'the template was already there')
  } finally { c.cleanup() }
})

test('--keep-on-failure keeps the container for a look', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y', '--keep-on-failure'], '', { FAKE_INSTALL_FAIL: '1' })
    assert.equal(r.status, 1)
    assert.match(plain(r.stdout + r.stderr), /Kept what was made, as asked/)
    assert.doesNotMatch(c.calls(), /^pct destroy/m)
  } finally { c.cleanup() }
})

// ── Full runs ───────────────────────────────────────────────────────────────────────────────────────────

test('a full -y run: one node at a time, checked from here, a plain checklist at the end', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'fresh-intel-node' })
  try {
    const r = c.run(['-y', '--no-pve-metrics'])
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    assert.deepEqual(c.steps(), ['node-b node_exporter', 'node-b Power', 'node-b Intel GPU'])
    assert.match(out, /Proxmox metrics: skipped \(you said no\)/)
    assert.doesNotMatch(c.calls(), /token add root@pam hyperprox-exporter/)
    assert.match(out, /What was done on your nodes:/)
    assert.match(out, /✓ Health monitoring\s+node-b\s+set up \(node_exporter\)/)
    assert.match(out, /✓ Power reading\s+node-b\s+\d+\.\d W/)
    assert.match(out, /✓ NVIDIA GPU answers\s+node-a\s+port 9835 answers from here/)
    assert.match(out, /Settings → Setup checklist/)
    assert.doesNotMatch(c.calls(), /^pct destroy/m, 'a finished run removes nothing')
  } finally { c.cleanup() }
})

test('--igpu -y: the built-in graphics step runs only on the node that has them', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'fresh-intel-node', 'node-c': 'intel-igpu-open' })
  try {
    const r = c.run(['-y', '--igpu', '--skip-exporter', '--skip-rapl', '--skip-gpu-exporter'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(c.steps(), ['node-b Let containers'], 'node-a is NVIDIA only; node-c is open already')
    assert.match(plain(r.stdout), /✓ Built-in graphics for containers\s+node-b/)
  } finally { c.cleanup() }
})

test('a GoDaddy key is checked before it is held, and a wrong one is dropped', () => {
  for (const [key, accepted] of [['good-key', true], ['bad-key', false]]) {
    const c = cluster({ 'node-a': 'server-no-gpu' })
    try {
      // ID and address: Enter; health no, charts no, dns yes + key + secret, ai no, VPN not now, "Create it?" yes
      const r = c.run([], '', { HPX_TTY: c.tty(`\n\nn\nn\ny\n${key}\ngood-secret\nn\n\ny\n`) })
      const out = plain(r.stdout + r.stderr)
      assert.equal(r.status, 0, out)
      if (accepted) {
        assert.match(out, /GoDaddy accepted the key/)
        assert.match(out, /GoDaddy key held in memory until you create the owner account/)
      } else {
        assert.match(out, /GoDaddy did not accept that key/)
        assert.doesNotMatch(out, /GoDaddy key held/)
      }
      assert.ok(!c.calls().split('\n').some(l => l.startsWith('curl') && l.includes(key)), 'never on a command line')
    } finally { c.cleanup() }
  }
})

// ── From review: the undo only ever removes what this run made ─────────────────────────────────────────

test('two runs, one ID: the second never removes the first one\'s container', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const first = c.run(['-y', '--no-pve-metrics'])
    assert.equal(first.status, 0, first.stdout + first.stderr)
    const conf = path.join(c.root, 'pve/lxc/900.conf')
    const before = fs.readFileSync(conf, 'utf8')
    const second = c.run(['-y', '--no-pve-metrics'])
    assert.notEqual(second.status, 0)
    assert.match(plain(second.stderr), /ID 900 is already used/)
    assert.doesNotMatch(c.calls(), /^pct destroy/m)
    assert.equal(fs.readFileSync(conf, 'utf8'), before)
  } finally { c.cleanup() }
})

test('the ID is taken between the check and pct create: that container is not ours and stays', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y'], '', { FAKE_RACE: '1' })
    assert.notEqual(r.status, 0)
    assert.match(plain(r.stderr), /already exists/)
    assert.doesNotMatch(c.calls(), /^pct (stop|destroy)/m)
    assert.match(fs.readFileSync(path.join(c.root, 'pve/lxc/900.conf'), 'utf8'), /someoneelse/)
  } finally { c.cleanup() }
})

test('a create cut off at its lock: not removed, and the commands to remove it are shown', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y'], '', { FAKE_STUB: '1' })
    assert.equal(r.status, 130, r.stdout + r.stderr)
    assert.doesNotMatch(c.calls(), /^pct destroy/m)
    assert.match(plain(r.stdout), /pct unlock 900 && pct destroy 900 --purge/)
  } finally { c.cleanup() }
})

test('a failed token add (someone made it meanwhile): that token is not removed', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y'], '', { FAKE_TOKEN_RACE: '1' })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 1, out)
    assert.match(out, /Could not create the token root@pam!hyperprox/)
    assert.doesNotMatch(c.calls(), /^pveum user token remove/m)
    assert.deepEqual(c.tokens(), ['hyperprox'])
    assert.match(c.calls(), /^pct destroy 900 --purge$/m, 'the container this run made is still removed')
  } finally { c.cleanup() }
})

test('EOF at the questions and at "Create it?": no to everything, cancelled, nothing created', () => {
  const c = cluster({ 'node-a': 'fresh-intel-node' }, { guests: conventional })
  try {
    const r = c.run([], '', { HPX_TTY: c.tty('') })
    const out = plain(r.stdout + r.stderr)
    assert.notEqual(r.status, 0)
    assert.match(out, /numbering[^]*?\[Y\/n\] \(no answer: no\)/, 'the static address is not taken on EOF')
    assert.match(out, /Container ID 900/)
    assert.match(out, /No answer\. Cancelled\. Nothing was created\./)
    assert.doesNotMatch(c.calls(), /^(pct create|pveam download|pveum user token add)/m)
  } finally { c.cleanup() }
})

test('a template listing that fails: the template already there is used, and never removed', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y'], '', { FAKE_LIST_FAIL: '1', FAKE_INSTALL_FAIL: '1' })
    const out = plain(r.stdout + r.stderr)
    assert.equal(r.status, 1, out)
    assert.match(out, /Could not list the templates on local/)
    assert.match(out, /is on local already/)
    assert.doesNotMatch(c.calls(), /^pveam (download|remove)/m)
    assert.deepEqual(c.templates(), [T13_AMD])
  } finally { c.cleanup() }
})

test('the root password is set over stdin, never on the pct create command line', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD] })
  try {
    const r = c.run(['-y', '--password', 'pw-secret-1'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!c.calls().split('\n').some(l => l.includes('pw-secret-1')), 'on no command line')
    assert.match(c.calls(), /^pct exec 900 -- chpasswd$/m)
  } finally { c.cleanup() }
})

test('a static address that drops pings but answers ARP is not offered', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: conventional, pingable: ['192.0.2.200'] })
  try {
    fs.writeFileSync(path.join(c.root, 'arpable'), '192.0.2.205\n')
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.match(out, /use CT 106 with IP 192\.0\.2\.206\/24/)
  } finally { c.cleanup() }
})

test('bad --hostname, --gateway or --bridge are refused before anything runs', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    for (const args of [['--hostname', 'a b'], ['--hostname', '-x'], ['--ip', '192.0.2.9/24', '--gateway', '300.1.1.1'], ['--bridge', 'vmbr0;x'], ['--ip', '192.0.2.9/40', '--gateway', '192.0.2.1']]) {
      const r = c.run(['-y', '--dry-run', ...args])
      assert.notEqual(r.status, 0, args.join(' '))
    }
    assert.doesNotMatch(c.calls(), /^pveversion/m, 'refused before looking at anything')
  } finally { c.cleanup() }
})

// --- the container's DNS ----------------------------------------------------------------------------------------

const TAILSCALE_NOTE = 'Your node uses Tailscale DNS; the container will use 1.1.1.1 (change with --dns).'
const dnsRun = (opts, args = [], extra = {}) => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], ...opts })
  const r = c.run(['-y', ...args], '', extra)
  return { c, r, out: plain(r.stdout), create: createLine(c) }
}

test('DNS: a node on Tailscale DNS gives the container 1.1.1.1, and the summary says why', () => {
  for (const resolv of ['nameserver 100.100.100.100\nnameserver fd7a:115c:a1e0::53\nsearch tailnet.ts.net\n', 'nameserver fd7a:115c:a1e0::53\n']) {
    const { c, r, out, create } = dnsRun({ resolv })
    try {
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.ok(out.includes(TAILSCALE_NOTE), out)
      assert.match(out, /DNS\s+1\.1\.1\.1/)
      assert.match(create, /--nameserver 1\.1\.1\.1( |$)/)
    } finally { c.cleanup() }
  }
})

test('DNS: a local stub (127.x, ::1) and an address in 100.64.0.0/10 are unusable too', () => {
  for (const [resolv, word] of [['nameserver 127.0.0.53\n', /local DNS stub \(127\.0\.0\.53\)/], ['nameserver ::1\n', /local DNS stub \(::1\)/],
                                ['nameserver 100.88.1.2\n', /100\.88\.1\.2 is in 100\.64\.0\.0\/10/], ['nameserver 192.0.2.53\nnameserver 127.0.0.1\n', /local DNS stub \(127\.0\.0\.1\)/]]) {
    const { c, r, out, create } = dnsRun({ resolv })
    try {
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(out, word)
      assert.match(out, /the container will use 1\.1\.1\.1 \(change with --dns\)/)
      assert.match(create, /--nameserver 1\.1\.1\.1/)
    } finally { c.cleanup() }
  }
})

test('DNS: a usable node resolver is left alone (no --nameserver), including 100.128.x just outside CGNAT', () => {
  for (const resolv of ['nameserver 192.0.2.53\n', 'nameserver 100.128.0.1\n', 'nameserver 2001:db8::53\n', '# no nameserver at all\n']) {
    const { c, r, out, create } = dnsRun({ resolv })
    try {
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.doesNotMatch(create, /--nameserver/)
      assert.doesNotMatch(out, /change with --dns/)
      assert.match(out, /DNS\s+the node's own/)
    } finally { c.cleanup() }
  }
})

test('DNS: --dns wins over everything, IPv4 and IPv6, and is passed to pct create as one list', () => {
  const { c, r, out, create } = dnsRun({ resolv: 'nameserver 100.100.100.100\n' }, ['--dns', '9.9.9.9,2606:4700:4700::1111'])
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!out.includes(TAILSCALE_NOTE), 'the person chose; nothing to explain')
    assert.match(out, /DNS\s+9\.9\.9\.9, 2606:4700:4700::1111 \(from --dns\)/)
    assert.match(create, /--nameserver 9\.9\.9\.9 2606:4700:4700::1111/)
  } finally { c.cleanup() }
})

test('DNS: a bad --dns is refused before anything runs', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    for (const bad of ['', '1.2.3', '300.1.1.1', 'dns.example.com', '1.1.1.1;id', '1.1.1.1,,8.8.8.8', '1::2::3', '12345::1',
                       '1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4', '$(id)', 'fe80::1%eth0']) {
      const r = c.run(['-y', '--dry-run', '--dns', bad])
      assert.notEqual(r.status, 0, bad)
      assert.match(plain(r.stderr), /--dns must be/, bad)
    }
    assert.doesNotMatch(c.calls(), /^pveversion/m, 'refused before looking at anything')
  } finally { c.cleanup() }
})

test('DNS: an existing HyperProx\'s Naming & addresses DNS is preferred; its token never reaches a command line', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], resolv: 'nameserver 100.100.100.100\n' })
  const curl = path.join(c.root, 'bin', 'curl')
  const orig = fs.readFileSync(curl, 'utf8')
  // The stand-in API: answers the naming route only for the right bearer token, read from stdin (-H @-).
  fs.writeFileSync(curl, orig.replace('  *) exit 7;;', `  https://hyperprox.example/api/catalogue/wizard/naming) h="$(cat)"; [ "$h" = 'Authorization: Bearer tok-naming-1' ] || exit 22
    echo '{"success":true,"data":{"settings":{"subnet":"10.0.0.0/24","dns":["10.0.0.53", "10.0.0.54"],"bridge":"vmbr0"}}}';;
  *) exit 7;;`), { mode: 0o755 })
  try {
    const ok = c.run(['-y'], '', { HPX_API_URL: 'https://hyperprox.example', HPX_API_TOKEN: 'tok-naming-1' })
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(plain(ok.stdout), /DNS\s+10\.0\.0\.53, 10\.0\.0\.54 \(from Naming & addresses\)/)
    assert.match(createLine(c), /--nameserver 10\.0\.0\.53 10\.0\.0\.54/)
    assert.ok(!c.calls().includes('tok-naming-1'), 'the token is on no command line')
    const call = c.calls().split('\n').find(l => l.includes('/api/catalogue/wizard/naming')) ?? ''
    assert.match(call, /--proto =https/)
    assert.doesNotMatch(call, /--insecure| -k /, 'the certificate is checked')
  } finally { c.cleanup() }
  // A pinned key stands in for the CA check (HyperProx's self-signed certificate); a malformed pin, or http, is not used.
  const PIN = 'sha256//' + 'A'.repeat(43) + '='
  const p = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], resolv: 'nameserver 100.100.100.100\n' })
  try {
    const okPin = p.run(['-y', '--dry-run'], '', { HPX_API_URL: 'https://hyperprox.example', HPX_API_TOKEN: 'tok', HPX_API_PINNEDPUBKEY: PIN })
    assert.equal(okPin.status, 0, okPin.stdout + okPin.stderr)
    const call = p.calls().split('\n').find(l => l.includes('/api/catalogue/wizard/naming')) ?? ''
    assert.match(call, new RegExp(`--insecure --pinnedpubkey ${PIN.replace(/[/+=]/g, '\\$&')}`))
  } finally { p.cleanup() }
  for (const extra of [{ HPX_API_URL: 'http://hyperprox.example', HPX_API_TOKEN: 'tok' }, { HPX_API_URL: 'https://hyperprox.example', HPX_API_TOKEN: 'tok', HPX_API_PINNEDPUBKEY: 'md5//x' }]) {
    const q = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], resolv: 'nameserver 100.100.100.100\n' })
    try {
      const r = q.run(['-y', '--dry-run'], '', extra)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.ok(!q.calls().includes('/api/catalogue/wizard/naming'), 'not asked at all')
      assert.match(plain(r.stdout + r.stderr), /HPX_API_(URL must be an https|PINNEDPUBKEY must be)/)
      assert.ok(plain(r.stdout).includes(TAILSCALE_NOTE))
    } finally { q.cleanup() }
  }
  // Not reachable, or the wrong token: skipped, and the Tailscale rule applies.
  for (const extra of [{ HPX_API_URL: 'https://hyperprox.example', HPX_API_TOKEN: 'wrong' }, { HPX_API_URL: 'https://down.example', HPX_API_TOKEN: 'tok' }, {}]) {
    const d = cluster({ 'node-a': 'server-no-gpu' }, { have: [T13_AMD], resolv: 'nameserver 100.100.100.100\n' })
    try {
      const r = d.run(['-y', '--dry-run'], '', extra)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.ok(plain(r.stdout).includes(TAILSCALE_NOTE))
    } finally { d.cleanup() }
  }
})
