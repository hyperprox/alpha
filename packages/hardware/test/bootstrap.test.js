'use strict'
// bootstrap.sh's question flow, run for real in bash against stand-ins for Proxmox's commands: three fake
// nodes (from the detection fixtures) reached through a stand-in ssh, -y, answers piped in, and a full run
// whose node steps are recorded instead of executed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const hw = require('..')
const { fakeNode, loadFixtures } = require('./harness')

const BOOTSTRAP = path.join(__dirname, '..', '..', '..', 'bootstrap.sh')
const fx = Object.fromEntries(loadFixtures().map(f => [f.file.replace(/\.json$/, ''), f]))

function cluster(nodes) {
  // nodes: { name: fixtureName }
  const made = Object.entries(nodes).map(([name, f]) => [name, fakeNode(fx[f])])
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hpx-boot-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(root, 'pve/lxc'), { recursive: true })
  const log = path.join(root, 'calls.log')
  const w = (n, body) => fs.writeFileSync(path.join(bin, n), `#!/bin/bash\necho "${n} $*" >> ${log}\n${body}\n`, { mode: 0o755 })
  const nodeJson = JSON.stringify(Object.keys(nodes).map(n => ({ node: n, status: 'online' })))
  const statusJson = JSON.stringify(Object.keys(nodes).map((n, i) => ({ type: 'node', name: n, ip: `127.0.0.${i + 2}` })))
  w('pveversion', 'echo "pve-manager/9.1.0/abc (running kernel: 7.0.0-1-pve)"')
  w('hostname', 'case "$1" in -I) echo 10.9.9.9;; *) echo installer;; esac')
  w('pvesh', `case "$2" in /cluster/nextid) echo 900;; /nodes) echo '${nodeJson}';; /cluster/status) echo '${statusJson}';; esac`)
  w('pvesm', 'printf "Name Type Status Total Used Available %%\\nlocal-lvm lvmthin active 100 10 90 10\\n"')
  w('pveam', 'case "$1" in available) echo "system          debian-13-standard_13.1-2_amd64.tar.zst";; list) echo "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst";; esac')
  w('pct', 'case "$1" in status) exit 1;; exec) [[ "$*" == *"hostname -I"* ]] && echo 10.9.9.50; exit 0;; *) exit 0;; esac')
  w('pveum', 'case "$*" in *"token list"*) echo "[]";; *"token add"*) echo \'{"value":"tok-secret"}\';; esac; exit 0')
  // Exporters "answer" from here when the fixture says they would after the step: the stand-in curl
  // serves metrics for any node address on 9100, a rising RAPL counter, and the GPU ports.
  w('curl', `for a in "$@"; do case "$a" in http://*|https://*) u="$a";; esac; done
case "$u" in
  *:9100/metrics) echo 'node_exporter_build_info{version="1.9.1"} 1'; echo "node_rapl_package_joules_total{index=\\"0\\"} $(date +%s).5";;
  *:8081/metrics) echo 'igpu_power_package 2.1';;
  *:9835/metrics) echo 'nvidia_smi_memory_total_bytes 8.5e9';;
  https://api.godaddy.com/*) h="$(cat)"; echo "$h" > ${root}/godaddy-header; [ "$h" = 'Authorization: sso-key good-key:good-secret' ] || exit 22; exit 0;;
  *) exit 7;;
esac`)
  // ssh NODE 'bash -s': the probe runs against that node's fake sysroot; a step is recorded, not run.
  const envs = path.join(root, 'nodes')
  fs.mkdirSync(envs)
  for (const [name, n] of made) {
    fs.writeFileSync(path.join(envs, name), Object.entries(n.env).map(([k, v]) => `export ${k}='${v}'`).join('\n') + '\n')
  }
  w('ssh', `node="\${@: -2:1}"; s="$(cat)"
if grep -q '^# HyperProx hardware probe' <<< "$s"; then ( . ${envs}/$node; printf '%s' "$s" | /bin/bash -s ); exit $?; fi
step="$(grep -m1 -oE '^# (node_exporter|Power|Intel GPU|NVIDIA GPU|Let containers)' <<< "$s" | cut -c3-)"
echo "$node $step" >> ${root}/steps.log
printf 'HPX-RESULT\\tdone\\tset up (%s)\\n' "$step"`)
  const run = (args, input, extra = {}) => spawnSync('/bin/bash', [BOOTSTRAP, ...args], {
    input: input ?? '', encoding: 'utf8', timeout: 60_000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HPX_PVE_ETC: path.join(root, 'pve'), HOME: root, LANG: 'C', TERM: 'dumb', ...extra },
  })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  const steps = () => fs.existsSync(path.join(root, 'steps.log')) ? fs.readFileSync(path.join(root, 'steps.log'), 'utf8').trim().split('\n') : []
  return { run, calls, steps, cleanup: () => { made.forEach(([, n]) => n.cleanup()); fs.rmSync(root, { recursive: true, force: true }) } }
}

const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '')

test('-y --dry-run: says what it found in one plain paragraph, plans per node, changes nothing', () => {
  const c = cluster({ 'node-a': 'nvidia-dedicated', 'node-b': 'fresh-intel-node', 'node-c': 'server-no-gpu' })
  try {
    const r = c.run(['-y', '--dry-run'])
    const out = plain(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    assert.match(out.replace(/\s*\n\s*/g, ' '), /Found 3 nodes\. node-a: NVIDIA GeForce GTX 1070 Ti \(dedicated\); health monitoring already running\. node-b: Intel HD Graphics 630 \(built in\)\. node-c: no GPU; no power counters\./)
    assert.match(out, /node-b: Health monitoring\n\s+node-b: Power monitoring\n\s+node-b: Intel GPU monitoring\n\s+node-c: Health monitoring\n/)
    assert.doesNotMatch(out, /node-a: (Health monitoring|NVIDIA GPU monitoring)/, 'already running on node-a: not planned')
    assert.match(out, /built-in graphics \(for video transcoding\)\? no/, '-y offers it but answers no')
    assert.doesNotMatch(out, /Built-in graphics for containers\n/, 'and plans nothing for it')
    assert.match(out, /Dry run: nothing was changed/)
    assert.doesNotMatch(c.calls(), /^(pct create|pveum|pveam download)/m)
    assert.deepEqual(c.steps(), [])
  } finally { c.cleanup() }
})

test('the same summary words as the setup wizard', () => {
  const c = cluster({ 'node-a': 'amd-apu', 'node-b': 'intel-igpu-psys' })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout).replace(/\s*\n\s*/g, ' ')
    const nodes = ['amd-apu', 'intel-igpu-psys'].map((f, i) => {
      const n = fakeNode(fx[f]); try { return hw.parseProbe(n.run(hw.probeScript()).stdout, `node-${'ab'[i]}`) } finally { n.cleanup() }
    })
    assert.ok(out.includes(hw.summarise(nodes)), `${out}\n---\n${hw.summarise(nodes)}`)
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
    assert.match(out, /Then, on your nodes, one at a time:\n\s+node-a: Power monitoring\n\s+node-a: Built-in graphics for containers\n\s+In HyperProx/)
    assert.match(out, /Applies to node-a\./)
    assert.match(out, /charts yes · Proxmox metrics no · GoDaddy no · local AI no/)
  } finally { c.cleanup() }
})

test('no GPU and no power counters anywhere: neither question is asked', () => {
  const c = cluster({ 'node-a': 'server-no-gpu' })
  try {
    const out = plain(c.run(['--dry-run'], 'y\ny\nn\nn\nn\n').stdout)
    assert.ok(!out.includes(hw.QUESTIONS.find(q => q.id === 'igpu-access').ask), 'no built-in graphics: not offered')
    assert.ok(!out.includes(hw.QUESTIONS.find(q => q.id === 'gpu').ask))
    assert.ok(!out.includes(hw.QUESTIONS.find(q => q.id === 'power').ask))
    assert.ok(out.includes(hw.QUESTIONS.find(q => q.id === 'node-health').ask))
  } finally { c.cleanup() }
})

test('an AMD-only cluster is told plainly that AMD is not covered', () => {
  const c = cluster({ 'node-a': 'amd-apu' })
  try {
    const out = plain(c.run(['-y', '--dry-run']).stdout)
    assert.match(out, /AMD GPUs are not covered yet/)
    assert.ok(!out.includes(hw.QUESTIONS.find(q => q.id === 'gpu').ask))
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
  } finally { c.cleanup() }
})

test('without a terminal and without -y it shows the defaults and stops before changing anything', () => {
  const c = cluster({ 'node-a': 'fresh-intel-node' })
  try {
    const r = c.run([], '', { HPX_TTY: '/nonexistent/tty' })
    const out = plain(r.stdout + r.stderr)
    assert.notEqual(r.status, 0)
    assert.match(out, /No terminal to ask on, so the defaults are shown/)
    assert.match(out, /No terminal to confirm on\. Re-run with -y/)
    assert.doesNotMatch(c.calls(), /^pct create/m)
    assert.deepEqual(c.steps(), [])
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
      // health no, charts no, dns yes + key + secret, ai no, then confirm
      const r = c.run([], `n\nn\ny\n${key}\ngood-secret\nn\ny\n`)
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
