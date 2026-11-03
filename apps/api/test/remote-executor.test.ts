// The production executor's transports: every script goes on stdin and is never part of a command line,
// and each kind of machine is reached the documented way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productionRemoteExecutor, type TransportDeps } from '../src/lib/remote/executor'

const SCRIPT = "HP_KEY='tskey-auth-SECRET'\necho hi"

function setup(o: { agent?: boolean; vmLogin?: { username: string; port: number } | null } = {}) {
  const calls: Array<{ host: string; port?: number; user: string; command: string; input?: string }> = []
  const pveCalls: Array<{ path: string; method?: string; body?: string }> = []
  const pve: any = {
    fetchStrict: async (path: string, method?: string, body?: string) => {
      pveCalls.push({ path, method, body })
      if (path === '/cluster/status') return [{ type: 'cluster', quorate: 1 }, { type: 'node', name: 'pve-a', ip: '192.0.2.11', online: 1 }]
      if (path.startsWith('/cluster/resources')) return [
        { type: 'lxc', vmid: 101, name: 'web', node: 'pve-a', status: 'running' },
        { type: 'qemu', vmid: 102, name: 'app', node: 'pve-a', status: 'running' },
        { type: 'qemu', vmid: 9000, name: 'tpl', node: 'pve-a', status: 'stopped', template: 1 },
      ]
      if (path.endsWith('/qemu/102/config')) return { ostype: 'l26' }
      if (path.endsWith('/agent/ping')) { if (o.agent) return {}; throw new Error('QEMU guest agent is not running') }
      return {}
    },
  }
  const t: TransportDeps = {
    ssh: (async (x: any) => {
      calls.push({ host: x.host, port: x.port, user: x.cred.username, command: x.command, input: x.input })
      if (x.command.startsWith('qm guest exec')) return { code: 0, output: JSON.stringify({ exited: 1, exitcode: 0, 'out-data': 'hi\n' }), timedOut: false }
      return { code: 0, output: 'hi\n', timedOut: false }
    }) as any,
    nodeCredential: (async () => ({ username: 'root', port: 22, password: 'x' })) as any,
    loadCredential: (async (id: string) => (id === 'qemu-102' && o.vmLogin !== null ? { username: o.vmLogin?.username ?? 'admin', port: o.vmLogin?.port ?? 2222, password: 'y' } : id === 'ssh-nas' ? { username: 'root', port: 22, password: 'z' } : null)) as any,
    listManualHosts: (async () => [{ id: 'ssh-nas', name: 'nas', address: '192.0.2.50', port: 22 }]) as any,
    listHostAddresses: (async () => ({ 'qemu-102': '192.0.2.102' })) as any,
  }
  return { ex: productionRemoteExecutor(pve, t), calls, pveCalls }
}

test('listMachines: nodes, guests without templates, manual hosts; VMs carry their ostype', async () => {
  const { ex } = setup()
  const ms = await ex.listMachines()
  assert.deepEqual(ms.map(m => m.id), ['node-pve-a', 'lxc-101', 'qemu-102', 'host-ssh-nas'])
  assert.equal(ms.find(m => m.id === 'qemu-102')!.ostype, 'l26')
  assert.equal(ms[0].address, '192.0.2.11')
})

test('every transport sends the script on stdin and never on a command line', async () => {
  for (const agent of [true, false]) {
    const { ex, calls } = setup({ agent })
    const ms = await ex.listMachines()
    for (const m of ms) await ex.run(m, SCRIPT)
    for (const c of calls) {
      assert.equal(c.input, SCRIPT)
      assert.doesNotMatch(c.command, /SECRET|HP_KEY|echo/)
    }
    const cmds = calls.map(c => `${c.user}@${c.host}:${c.port ?? 22} ${c.command}`)
    assert.equal(cmds[0], 'root@192.0.2.11:22 bash -s')
    assert.equal(cmds[1], 'root@192.0.2.11:22 pct exec 101 -- bash -s')
    if (agent) assert.match(cmds[2], /^root@192\.0\.2\.11:22 qm guest exec 102 --timeout \d+ --pass-stdin 1 -- bash$/)
    else assert.equal(cmds[2], 'admin@192.0.2.102:2222 sudo -n bash -s', 'no agent: the Terminal login, with sudo when not root')
    assert.equal(cmds[3], 'root@192.0.2.50:22 bash -s')
  }
})

test('the guest agent answer is unwrapped into exit code and output', async () => {
  const { ex } = setup({ agent: true })
  const vm = (await ex.listMachines()).find(m => m.id === 'qemu-102')!
  let seen = ''
  const r = await ex.run(vm, SCRIPT, { onData: c => { seen += c } })
  assert.deepEqual(r, { code: 0, output: 'hi\n', timedOut: false })
  assert.equal(seen, 'hi\n')
})

test('a VM with no agent and no Terminal login is refused with what to do', async () => {
  const { ex } = setup({ agent: false, vmLogin: null })
  const vm = (await ex.listMachines()).find(m => m.id === 'qemu-102')!
  await assert.rejects(ex.run(vm, SCRIPT), /No login saved for qemu-102 in the Terminal/)
})

test('container config is changed through the Proxmox API with a PUT, never by editing a file', async () => {
  const { ex, pveCalls } = setup()
  const ct = (await ex.listMachines()).find(m => m.id === 'lxc-101')!
  await ex.setLxcConfig(ct, { dev0: '/dev/net/tun' })
  const put = pveCalls.at(-1)!
  assert.deepEqual(put, { path: '/nodes/pve-a/lxc/101/config', method: 'PUT', body: 'dev0=%2Fdev%2Fnet%2Ftun' })
})
