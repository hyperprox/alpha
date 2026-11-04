// The Prisma proxy store on a real Postgres. Opt-in: HP_PROXY_PG_URL=postgresql://… of a throwaway database
// that `prisma migrate deploy` has been run against (the migration drops the old proxy tables and creates
// ProxyInstance). Never point it at a database that matters: it creates and deletes rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const URL_ = process.env.HP_PROXY_PG_URL

if (!URL_) {
  test('Prisma proxy store (set HP_PROXY_PG_URL to a throwaway, migrated database to run)', { skip: true }, () => {})
} else {
  test('Prisma proxy store: create, list, update (managed set and cleared), audit, remove', async () => {
    const { PrismaClient } = await import('@prisma/client')
    const { PrismaProxyStore } = await import('../src/lib/proxy/store')
    const db = new PrismaClient({ datasources: { db: { url: URL_ } } })
    try {
      const tables = await db.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
      const names = tables.map(t => t.table_name)
      assert.ok(names.includes('ProxyInstance'))
      assert.equal(names.includes('ProxyProvider'), false, 'the old table with plaintext secret columns is gone')
      assert.equal(names.includes('ProxyHost'), false)
      const s = new PrismaProxyStore(db)
      const id = `px-${Date.now().toString(36).slice(-10).padStart(10, '0')}`
      const row = await s.create({ id, kind: 'caddy', name: 'pg test', url: 'http://192.0.2.1:2019', mode: 'managed',
        managed: { node: 'node1', vmid: 9001, recipe: 'caddy' }, settings: { server: 'srv0' }, createdBy: 'test@example.invalid' })
      assert.deepEqual(row.managed, { node: 'node1', vmid: 9001, recipe: 'caddy' })
      assert.ok((await s.list()).some(r => r.id === id))
      const u = await s.update(id, { mode: 'byo', managed: null, settings: { server: 'srv1' } })
      assert.equal(u.managed, null)
      assert.equal(u.settings.server, 'srv1')
      await s.audit('proxy.test', `proxy:${id}`, { ok: true })
      await s.remove(id)
      assert.equal(await s.get(id), null)
      await db.auditLog.deleteMany({ where: { resource: `proxy:${id}` } })
    } finally { await db.$disconnect() }
  })
}
