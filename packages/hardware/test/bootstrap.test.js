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
  w('ip', 'case "$1" in link) exit 0;; *) exit 0;; esac')
  w('pvesh', `case "$2" in
  /cluster/nextid) if [ "$3" = --vmid ]; then echo "$4"; else echo 900; fi;;
  /nodes) echo '${nodeJson}';; /cluster/status) echo '${statusJson}';; esac`)
  w('pvesm', `case "$1 $2 $3" in
  "status -content rootdir") cat ${root}/rootdir;;
  "status -content vztmpl") printf "Name Type Status Total Used Available %%\\nlocal dir active 900000000 1000 899999000 1%%\\n";;
  path*) echo "${tpl}/\${2#*vztmpl/}";;
  list*) echo "Volid Format Type Size VMID";;
esac`)
  w('pveam', `case "$1" in
  available) cat ${root}/available;;
  list) [ -n "\${FAKE_LIST_FAIL:-}" ] && exit 1; echo "NAME SIZE"; for f in ${tpl}/*; do [ -e "$f" ] && echo "$2:vztmpl/$(basename "$f")   100MB"; done;;
  download) echo template > "${tpl}/$3";;
  remove) rm -f "${tpl}/\${2#*vztmpl/}";;
esac; exit 0`)
  w('pct', `case "$1" in
  status) exit 1;;
  create) ctrl_c() { kill -INT $PPID; p=$PPID; while [ "$p" -gt 1 ]; do
            if tr '\\0' ' ' < /proc/$p/cmdline | grep -q 'bootstrap.sh'; then kill -INT $p; fi
            p=$(awk '{print $4}' /proc/$p/stat); done; }
          h=""; d=""; prev=""; for a in "$@"; do [ "$prev" = --hostname ] && h="$a"; [ "$prev" = --description ] && d="$a"; prev="$a"; done
          c="$HPX_PVE_ETC/lxc/$2.conf"
          # Another run got there first: its container, with the same hostname but its own mark.
          if [ -n "\${FAKE_RACE:-}" ]; then printf '#hyperprox-install-someoneelse\nhostname: %s\n' "$h" > "$c"; echo "CT $2 already exists on node 'other'" >&2; exit 255; fi
          # Cut off right after Proxmox wrote its lock, before anything else.
          if [ -n "\${FAKE_STUB:-}" ]; then echo 'lock: create' > "$c"; ctrl_c; exit 1; fi
          printf '#%s\nhostname: %s\n' "$d" "$h" > "$c"
          [ -n "\${FAKE_INT_ON_CREATE:-}" ] && ctrl_c; exit 0;;
  start) [ -n "\${FAKE_START_FAIL:-}" ] && exit 1; exit 0;;
  destroy) rm -f "$HPX_PVE_ETC/lxc/$2.conf"; exit 0;;
  exec) [ -t 0 ] || cat > /dev/null   # a command that reads stdin, as pct exec does
        [[ "$*" == *install.sh* ]] && [ -n "\${FAKE_INSTALL_FAIL:-}" ] && exit 1
        [[ "$*" == *"hostname -I"* ]] && echo 10.9.9.50; exit 0;;
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
  const env = extra => ({ PATH: `${bin}:/usr/bin:/bin`, HPX_PVE_ETC: path.join(root, 'pve'), HOME: root, TMPDIR: tmp, LANG: 'C', TERM: 'dumb', ...extra })
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
  return {
    root, env, tty, run, piped, calls, steps, templates, tokens, leftovers,
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
    assert.match(out, /✓ Health monitoring already running on all 2 nodes/)
    assert.match(out, /✓ GPU monitoring already running on all 2 nodes/)
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
    assert.match(out, new RegExp(`Ignoring ${T13_ARM.replace(/\./g, '\\.')} on local: it is not built for amd64`))
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

test('numbering: answering no keeps the next free ID and DHCP', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' }, { guests: conventional })
  try {
    // numbering no, then defaults for the rest, and the final "Create it?" is answered no.
    const r = c.run([], '', { HPX_TTY: c.tty('n\n\n\n\n\n\nn\n') })
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
    // health yes, power no, gpu yes, built-in graphics no, charts yes, metrics no, dns no, ai no, create yes
    const r = c.piped([], { HPX_TTY: c.tty('y\nn\ny\nn\ny\nn\nn\nn\ny\n') })
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
      child.stdout.on('data', d => { out += d; if (out.includes('[Y/n]')) { clearTimeout(t); res() } })
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
      // health no, charts no, dns yes + key + secret, ai no, then "Create it?" yes
      const r = c.run([], '', { HPX_TTY: c.tty(`n\nn\ny\n${key}\ngood-secret\nn\ny\n`) })
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
