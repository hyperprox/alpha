// Send files: the known_hosts handed to rsync holds only the destination's confirmed host key, never the other keys
// the node printed about itself.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { utils } from 'ssh2'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, signIn, resetLock } from './fakes/app'
import { requestContext } from '../src/lib/auth'
import { getCredential, migrationSettled } from '../src/lib/credentials'
import { setClusterStore, loadClusters, createRemote, updateCluster, resetClustersForTests } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { runInCluster } from '../src/lib/clusters/context'
import { recordPin } from '../src/lib/hostkey-pins'
import { setupSending, pairProvider, pairField } from '../src/lib/clusters/files'
import { fingerprintOf } from '../src/lib/ssh-broker'
import { setAuditSink } from '../src/lib/audit'

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
const appP = buildTestApp(broker)
after(async () => { resetClustersForTests(); await resetLock(); await (await appP).close() })
let sid = ''
before(async () => {
  setAuditSink({ write: async () => undefined } as any)
  await signIn(await appP, 'owner@example.com', 'owner master password')
  sid = [...broker.sessions.values()].at(-1)!.sid
  await requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, () => migrationSettled())
})

const pub = (k: string) => k.trim().split(/\s+/)[1]

test('only the confirmed key goes into known_hosts', async () => {
  await requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, async () => {
    setClusterStore(new MemoryClusterStore()); await loadClusters()
    const tok = { tokenId: 'hyperprox@pve!main', tokenSecret: 'abcdef01-2345-6789-abcd-ef0123456789', by: 'owner@example.com' }
    const a = await createRemote({ name: 'Source', address: '198.51.100.10', port: 8006, fingerprint: 'AB'.repeat(32), ...tok })
    const b = await createRemote({ name: 'Dest', address: '198.51.100.20', port: 8006, fingerprint: 'CD'.repeat(32), ...tok })
    await updateCluster(b.id, { allowedRoots: ['/srv/media'], nodeAddresses: { dn: '198.51.100.21' } })
    const good = utils.generateKeyPairSync('ed25519').public, other = utils.generateKeyPairSync('ed25519').public
    const goodFp = fingerprintOf(Buffer.from(pub(good), 'base64'))
    await runInCluster(b.id, () => recordPin('198.51.100.21', 22, goodFp, 'confirmed'))
    const runner: any = {
      linkAddress: () => '100.64.0.21',
      sshAddress: async () => '198.51.100.21',
      run: async (_c: string, _n: string, script: string) => script.includes('RRSYNC')
        ? { code: 0, output: `RRSYNC /usr/bin/rrsync\n${other}\n${good}\nOK /srv/media` }
        : { code: 0, output: '1\n' },
    }
    await setupSending({ src: a.id, dst: b.id, dstNode: 'dn', root: '/srv/media', by: 'owner@example.com' }, runner)
    const key = JSON.parse((await getCredential('xfer-key', pairProvider(a.id, b.id), pairField('dn', '/srv/media')))!)
    assert.equal(key.knownHosts, `100.64.0.21 ssh-ed25519 ${pub(good)}\n`)
    assert.equal(key.knownHosts.includes(pub(other)), false)
  })
})
