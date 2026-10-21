import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { encrypt } from '../src/lib/crypto'
import { setCredentialTable, seedFromEnv, getCredential, migrationSettled, migrationStatus } from '../src/lib/credentials'

const KEY = 'a'.repeat(64)

function makeTable(rows: any[]) {
  const t = {
    rows,
    deleted: [] as string[],
    credential: {
      findMany: async () => t.rows.map(r => ({ ...r })),
      deleteMany: async ({ where }: any) => {
        const ids: string[] = where.id.in
        t.deleted.push(...ids)
        t.rows = t.rows.filter(r => !ids.includes(r.id))
        return { count: ids.length }
      },
    },
  }
  return t
}

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const appP = buildTestApp(broker)
beforeEach(resetLock)
after(async () => { await resetLock(); await (await appP).close() })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vg-gate-'))
  const envPath = join(dir, '.env')
  const original = [
    '# HyperProx',
    'PROXMOX_HOST=192.168.1.5',
    'PROXMOX_TOKEN_ID=hyperprox',
    'PROXMOX_TOKEN_SECRET=pve-token-from-env',
    `ENCRYPTION_KEY=${KEY}`,
    'JWT_SECRET=old-jwt-secret',
    'NPM_PASSWORD="npm-from-env"',
    'METRICS_TOKEN=keep-me',
    '',
  ].join('\n')
  writeFileSync(envPath, original)
  return { dir, envPath, original }
}

test('first Owner unlock moves Postgres rows + env values into the vault and blanks .env', async () => {
  const app = await appP
  const { dir, envPath, original } = setup()
  process.env.ENCRYPTION_KEY = KEY
  process.env.ENV_FILE_PATH = envPath
  for (const l of original.split('\n')) { const m = /^(\w+)="?([^"]*)"?$/.exec(l); if (m) process.env[m[1]] = m[2] }

  const table = makeTable([
    { id: '1', category: 'dns', provider: 'godaddy', key: 'api_key', value: encrypt('gd-key'), updatedAt: new Date() },
    { id: '2', category: 'dns', provider: 'godaddy', key: 'api_secret', value: encrypt('gd-secret'), updatedAt: new Date() },
    // Row beats env for the same setting.
    { id: '3', category: 'proxmox', provider: 'proxmox', key: 'token_secret', value: encrypt('pve-token-from-db'), updatedAt: new Date() },
    { id: '4', category: 'terminal', provider: 'ssh', key: 'node-a', value: encrypt('{"username":"root","password":"pw"}'), updatedAt: new Date() },
    // The retired HyperProx password is dropped, not migrated.
    { id: '5', category: 'system', provider: 'hyperprox', key: 'admin_password_hash', value: encrypt('scrypt$x$y'), updatedAt: new Date() },
  ])
  setCredentialTable(table)

  const v = await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.equal(v.res.statusCode, 200)
  assert.equal(table.deleted.length, 0, 'a non-owner unlock must not migrate')
  await resetLock()

  const { res } = await signIn(app, 'owner@example.com', 'owner master password')
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().migration.ok, true, res.body)
  assert.equal(res.json().migration.running, true, 'the sign-in does not wait for the vault writes')
  // Served from memory before the vault writes finish.
  assert.equal(await getCredential('dns', 'godaddy', 'api_key'), 'gd-key')
  await migrationSettled()
  assert.equal(migrationStatus().state, 'done')

  const it = (n: string) => broker.items.get(n)?.fields
  assert.deepEqual(it('hyperprox:dns/godaddy'), { api_key: 'gd-key', api_secret: 'gd-secret' })
  assert.equal(it('hyperprox:proxmox/proxmox')!.token_secret, 'pve-token-from-db')
  assert.equal(it('hyperprox:proxmox/proxmox')!.host, '192.168.1.5')
  assert.equal(it('hyperprox:proxy/npm')!.password, 'npm-from-env')
  assert.equal(it('hyperprox:terminal/ssh')!['node-a'], '{"username":"root","password":"pw"}')
  assert.equal(it('hyperprox:system/hyperprox')?.admin_password_hash, undefined)

  assert.deepEqual(table.deleted.sort(), ['1', '2', '3', '4', '5'])
  assert.equal(table.rows.length, 0)

  const env = readFileSync(envPath, 'utf8')
  assert.match(env, /^PROXMOX_TOKEN_SECRET=$/m)
  assert.match(env, /^ENCRYPTION_KEY=$/m)
  assert.match(env, /^JWT_SECRET=$/m)
  assert.match(env, /^NPM_PASSWORD=$/m)
  assert.match(env, /^PROXMOX_HOST=192\.168\.1\.5$/m, 'non-secret settings stay')
  assert.match(env, /^METRICS_TOKEN=keep-me$/m, 'unrelated keys stay')
  assert.match(env, /^# HyperProx$/m)

  const backup = envPath + '.pre-vault'
  assert.equal(readFileSync(backup, 'utf8'), original)
  assert.equal(statSync(backup).mode & 0o777, 0o600)

  assert.equal(process.env.ENCRYPTION_KEY, undefined)
  assert.equal(process.env.JWT_SECRET, undefined)
  assert.equal(await getCredential('proxmox', 'proxmox', 'token_secret'), 'pve-token-from-db')

  // Re-run: nothing left to do, nothing rewritten, no second backup.
  const upserts = broker.callsTo('upsertSecret').length
  const sid = [...broker.sessions.values()].at(-1)!.sid
  const again = await seedFromEnv(sid)
  assert.deepEqual(again, { migrated: 0, rowsDeleted: 0, envBlanked: [] })
  assert.equal(broker.callsTo('upsertSecret').length, upserts)
  assert.equal(readFileSync(envPath, 'utf8'), env)
  assert.deepEqual(readdirSync(dir).sort(), ['.env', '.env.pre-vault'])

  // And again after a restart-style lock + Owner unlock.
  await resetLock()
  const third = await signIn(app, 'owner@example.com', 'owner master password')
  assert.equal(third.res.json().migration, undefined)
})

test('a row that cannot be decrypted stops the migration and changes nothing', async () => {
  const app = await appP
  const { envPath, original } = setup()
  process.env.ENV_FILE_PATH = envPath
  process.env.ENCRYPTION_KEY = KEY
  const good = encrypt('fine')
  process.env.ENCRYPTION_KEY = 'b'.repeat(64)
  const table = makeTable([
    { id: '9', category: 'dns', provider: 'cloudflare', key: 'api_token', value: good, updatedAt: new Date() },
  ])
  setCredentialTable(table)
  const before = broker.callsTo('upsertSecret').length

  const { res } = await signIn(app, 'owner@example.com', 'owner master password')
  assert.equal(res.statusCode, 200, 'sign-in still succeeds')
  assert.equal(res.json().migration.ok, false)
  assert.match(res.json().migration.error, /cannot be decrypted/)
  await migrationSettled()
  assert.equal(table.deleted.length, 0)
  assert.equal(readFileSync(envPath, 'utf8'), original)
  assert.equal(existsSync(envPath + '.pre-vault'), false)
  assert.equal(broker.callsTo('upsertSecret').length, before)
})

test('a read-back mismatch stops before rows or .env are touched', async () => {
  const app = await appP
  const { envPath, original } = setup()
  process.env.ENV_FILE_PATH = envPath
  process.env.ENCRYPTION_KEY = KEY
  const table = makeTable([
    { id: '7', category: 'dns', provider: 'namecheap', key: 'api_key', value: encrypt('nc-key'), updatedAt: new Date() },
  ])
  setCredentialTable(table)
  const realList = broker.listSecrets.bind(broker)
  let calls = 0
  broker.listSecrets = async (sid: string) => {
    const items = await realList(sid)
    // first call is the unlock; the second is the read-back
    if (++calls >= 2) return items.map(i => i.name === 'hyperprox:dns/namecheap' ? { ...i, fields: { api_key: 'corrupted' } } : i)
    return items
  }
  try {
    const { res } = await signIn(app, 'owner@example.com', 'owner master password')
    assert.equal(res.json().migration.running, true)
    await migrationSettled()
    const st = migrationStatus()
    assert.equal(st.state, 'failed')
    assert.match((st as any).error, /read-back/)
  } finally { broker.listSecrets = realList }
  assert.equal(table.deleted.length, 0)
  assert.equal(readFileSync(envPath, 'utf8'), original)
})
