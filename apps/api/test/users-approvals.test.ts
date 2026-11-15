// A past approval stays backed while its approver is still at least admin: an owner counts as an admin
// (lib/users/approvals.ts), in their session, in the role record and in the audit log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approverChanged } from '../src/lib/users/approvals'
import { approverChanged as fromRoutes } from '../src/routes/placement'

const since = Date.UTC(2026, 5, 10)
const audit = (rows: any[]) => ({ auditLog: { findMany: async (q: any) => rows.filter(r => q.where.action.in.includes(r.action) && r.createdAt >= q.where.createdAt.gte) } })
const none = () => [] as any[]
const after = (action: string, details: Record<string, unknown>) => ({ action, details, createdAt: new Date(since + 1) })

test('the routes use the shared check', () => {
  assert.equal(fromRoutes, approverChanged)
})

test('an owner\'s own session is an admin\'s: not "no longer admin"', async () => {
  assert.equal(await approverChanged(audit([]), 'o@example.com', since, () => [{ email: 'O@example.com', role: 'owner' }], () => null), null)
  assert.match((await approverChanged(audit([]), 'o@example.com', since, () => [{ email: 'o@example.com', role: 'operator' }], () => null))!, /now operator, not admin/)
})

test('a role record of owner or admin stands; anything lower does not', async () => {
  assert.equal(await approverChanged(audit([]), 'o@example.com', since, none, () => 'owner'), null)
  assert.equal(await approverChanged(audit([]), 'o@example.com', since, none, () => 'admin'), null)
  assert.match((await approverChanged(audit([]), 'o@example.com', since, none, () => 'viewer'))!, /now viewer/)
})

test('a promotion to owner (or admin) since the approval lowers nobody; a demotion still counts', async () => {
  assert.equal(await approverChanged(audit([after('users.role', { role: 'owner' })]), 'a@example.com', since, none, () => null), null)
  assert.equal(await approverChanged(audit([after('users.role', { role: 'admin' })]), 'a@example.com', since, none, () => null), null)
  assert.match((await approverChanged(audit([after('users.role', { role: 'operator' })]), 'a@example.com', since, none, () => null))!, /cannot tell whose/)
  // An unreadable role in the row is not taken for an admin.
  assert.match((await approverChanged(audit([after('users.role', { role: 'superuser' })]), 'a@example.com', since, none, () => null))!, /cannot tell whose/)
  // The approver's own live owner session settles a lowering they cannot have been the subject of.
  assert.equal(await approverChanged(audit([after('users.role', { role: 'viewer' })]), 'o@example.com', since, () => [{ email: 'o@example.com', role: 'owner' }], () => null), null)
  assert.match((await approverChanged(audit([after('users.remove', { email: 'O@example.com' })]), 'o@example.com', since, () => [{ email: 'o@example.com', role: 'owner' }], () => null))!, /removed/)
})
