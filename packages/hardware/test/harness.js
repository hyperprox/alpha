'use strict'
// Builds a fake node from a fixture: a sysroot (powercap, drm, /dev/dri, /etc/pve) and a PATH holding only
// the tools the scripts need plus stubs for the commands the fixture says the node has. `curl` answers
// from the fixture's "answering" map, so "is an exporter running" is the fixture's word.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, execFileSync } = require('child_process')

const TOOLS = ['awk', 'ls', 'grep', 'sed', 'tr', 'stat', 'cat', 'uname', 'cut', 'sleep', 'mkdir', 'chmod', 'mv',
  'mktemp', 'rm', 'head', 'sha256sum', 'tar', 'install', 'dirname', 'basename', 'printf', 'env', 'sort', 'wc', 'readlink', 'xargs']

function which(t) { try { return execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim() } catch { return '' } }

function fakeNode(fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-node-'))
  const sys = path.join(root, 'sysroot')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const t of TOOLS) { const p = which(t); if (p && p.startsWith('/')) fs.symlinkSync(p, path.join(bin, t)) }

  for (const [dom, d] of Object.entries(fixture.powercap ?? {})) {
    const dir = path.join(sys, 'sys/class/powercap', dom)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'name'), d.name + '\n')
    fs.writeFileSync(path.join(dir, 'energy_uj'), '123456\n')
    fs.chmodSync(path.join(dir, 'energy_uj'), parseInt(d.mode, 8))
  }
  ;(fixture.drm_vendors ?? []).forEach((v, i) => {
    const dir = path.join(sys, `sys/class/drm/card${i}/device`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'vendor'), v + '\n')
  })
  fs.mkdirSync(path.join(sys, 'dev/dri'), { recursive: true })
  for (const d of fixture.dri ?? []) fs.writeFileSync(path.join(sys, 'dev/dri', d), '')
  // Render nodes with the vendor of the GPU behind them and their mode, as /dev/dri and sysfs show them.
  for (const [r, info] of Object.entries(fixture.render ?? {})) {
    fs.writeFileSync(path.join(sys, 'dev/dri', r), '')
    fs.chmodSync(path.join(sys, 'dev/dri', r), parseInt(info.mode, 8))
    // With a PCI address, the device is a link to the PCI device, as in real sysfs.
    let dev = path.join(sys, 'sys/class/drm', r, 'device')
    if (info.pci) {
      const pci = path.join(sys, 'sys/bus/pci/devices', info.pci)
      fs.mkdirSync(pci, { recursive: true })
      fs.mkdirSync(path.dirname(dev), { recursive: true })
      fs.symlinkSync(pci, dev)
      dev = pci
      fs.writeFileSync(path.join(dev, 'device'), (info.device ?? '0x0000') + '\n')
    } else fs.mkdirSync(dev, { recursive: true })
    fs.writeFileSync(path.join(dev, 'vendor'), info.vendor + '\n')
  }
  if (fixture.ceph) { fs.mkdirSync(path.join(sys, 'etc/pve'), { recursive: true }); fs.writeFileSync(path.join(sys, 'etc/pve/ceph.conf'), '') }
  fs.mkdirSync(path.join(sys, 'etc/udev/rules.d'), { recursive: true })
  for (const f of fixture.udev_rules ?? []) fs.writeFileSync(path.join(sys, 'etc/udev/rules.d', f.name), f.content)

  const lspci = path.join(root, 'lspci.txt')
  fs.writeFileSync(lspci, fixture.lspci ?? '')
  for (const c of fixture.commands ?? []) {
    fs.writeFileSync(path.join(bin, c), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  }
  const answers = path.join(root, 'answering')
  fs.mkdirSync(answers)
  for (const [port, body] of Object.entries(fixture.answering ?? {})) fs.writeFileSync(path.join(answers, port), body + '\n')
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
for a in "$@"; do case "$a" in http://127.0.0.1:*) p="\${a#http://127.0.0.1:}"; p="\${p%%/*}";; esac; done
[ -n "\${p:-}" ] && [ -f "${answers}/$p" ] && exec cat "${answers}/$p"
exit 7
`, { mode: 0o755 })

  const env = { PATH: bin, HPX_SYSROOT: sys, HPX_LSPCI: lspci, HOME: root, LANG: 'C' }
  const run = (script, args = []) => spawnSync('/bin/bash', ['-s', '--', ...args], { input: script, env, encoding: 'utf8', timeout: 60_000 })
  return { root, sys, bin, env, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function loadFixtures() {
  const dir = path.join(__dirname, 'fixtures')
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
}

module.exports = { fakeNode, loadFixtures }
