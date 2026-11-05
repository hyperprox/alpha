// Stand-in for the setup wizard's SSH (HPX_SETUP_NODE_RUNNER): the probe runs against a fake node built
// from a detection fixture; node steps are recorded and answered, not run.
const fs = require('fs')
const { fakeNode, loadFixtures } = require('../../../../packages/hardware/test/harness')
const FX = Object.fromEntries(loadFixtures().map(f => [f.file.replace(/\.json$/, ''), f]))
const MAP = JSON.parse(process.env.HPX_TEST_NODES)          // { address: fixture }
const NAMES = JSON.parse(process.env.HPX_TEST_NAMES)        // { address: node name }
const made = {}
module.exports = async function run(host, cred, script) {
  fs.appendFileSync(process.env.HPX_TEST_LOG, JSON.stringify({ node: NAMES[host], kind: /^pveversion/.test(script) ? 'login' : /^# HyperProx hardware probe/m.test(script) ? 'probe' : 'step', step: (/^# (node_exporter|Power|Intel GPU|NVIDIA GPU)/m.exec(script) || [])[1] || null }) + '\n')
  if (cred.password !== process.env.HPX_TEST_PASSWORD) throw new Error('All configured authentication methods failed')
  if (/^pveversion/.test(script)) return { code: 0, output: 'pve-manager/9.1.0/abc (running kernel: 7.0.0-1-pve)\n' }
  if (/^# HyperProx hardware probe/m.test(script)) {
    made[host] = made[host] || fakeNode(FX[MAP[host]])
    const r = made[host].run(script)
    return { code: r.status, output: r.stdout }
  }
  return { code: 0, output: `HPX-RESULT\tdone\tset up on ${NAMES[host]}\n` }
}
