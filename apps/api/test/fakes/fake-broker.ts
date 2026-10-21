// In-memory VaultBroker for the gate tests. Behaves like the contract says the
// real broker does: users with master password + TOTP, one org, sessions by sid,
// items in one collection. Records calls so tests can assert write-through.

import { randomUUID } from 'crypto'
import { VaultAuthError, VaultSessionError, type Role, type SecretItem, type VaultBroker, type VaultSession, BootstrapNotPendingError } from '../../src/lib/vault/broker'

export const GOOD_CODE = '123456'

interface FakeUser { email: string; password: string; role: Role; totp: boolean; userId: string }

export class FakeBroker implements VaultBroker {
  users = new Map<string, FakeUser>()
  sessions = new Map<string, VaultSession>()
  items = new Map<string, SecretItem>()
  bootstrapped = false
  reachable = true
  calls: Array<{ fn: string; args: unknown[] }> = []
  failUpsert = false

  addUser(email: string, password: string, role: Role): void {
    this.users.set(email, { email, password, role, totp: true, userId: randomUUID() })
    this.bootstrapped = true
  }

  private rec(fn: string, ...args: unknown[]) { this.calls.push({ fn, args }) }
  callsTo(fn: string) { return this.calls.filter(c => c.fn === fn) }

  private session(sid: string): VaultSession {
    const s = this.sessions.get(sid)
    if (!s) throw new VaultSessionError()
    return s
  }

  async status() { return { reachable: this.reachable, bootstrapped: this.bootstrapped } }

  async bootstrapOwner(email: string, masterPassword: string) {
    this.rec('bootstrapOwner', email)
    this.users.set(email, { email, password: masterPassword, role: 'owner', totp: false, userId: randomUUID() })
    return { totpSecret: 'JBSWY3DPEHPK3PXP', otpauthUri: `otpauth://totp/HyperProx:${email}?secret=JBSWY3DPEHPK3PXP&issuer=HyperProx` }
  }

  async confirmOwnerTotp(email: string, masterPassword: string, code: string) {
    this.rec('confirmOwnerTotp', email)
    const u = this.users.get(email)
    if (!u || u.password !== masterPassword) throw new VaultAuthError('bad_credentials')
    if (u.totp) throw new BootstrapNotPendingError()   // the real broker forgets the pending step once used
    if (code !== GOOD_CODE) throw new VaultAuthError('totp_invalid')
    u.totp = true
    this.bootstrapped = true
    const s: VaultSession = { sid: randomUUID(), email, role: u.role, userId: u.userId }
    this.sessions.set(s.sid, s)
    return s
  }

  async signIn(email: string, masterPassword: string, totp: string) {
    this.rec('signIn', email)
    const u = this.users.get(email)
    if (!u || u.password !== masterPassword) throw new VaultAuthError('bad_credentials')
    if (u.totp && !totp) throw new VaultAuthError('totp_required')
    if (u.totp && totp !== GOOD_CODE) throw new VaultAuthError('totp_invalid')
    const s: VaultSession = { sid: randomUUID(), email, role: u.role, userId: u.userId }
    this.sessions.set(s.sid, s)
    return s
  }

  async verifyPassword(sid: string, masterPassword: string) {
    this.rec('verifyPassword', sid)
    const s = this.session(sid)
    return this.users.get(s.email)?.password === masterPassword
  }

  async signOut(sid: string) { this.rec('signOut', sid); this.sessions.delete(sid) }

  async signOutAll() { this.rec('signOutAll'); this.sessions.clear() }

  async listSecrets(sid: string) {
    this.rec('listSecrets', sid)
    this.session(sid)
    return [...this.items.values()].map(i => ({ ...i, fields: { ...i.fields } }))
  }

  async upsertSecrets(sid: string, items: Array<{ name: string; fields: Record<string, string>; notes?: string }>) {
    const out = []
    for (const i of items) out.push(await this.upsertSecret(sid, i.name, i.fields, i.notes))
    return out
  }

  async upsertSecret(sid: string, name: string, fields: Record<string, string>, notes?: string) {
    this.rec('upsertSecret', sid, name, { ...fields }, notes)
    this.session(sid)
    if (this.failUpsert) throw new Error('fake broker: upsert refused')
    const id = this.items.get(name)?.id ?? randomUUID()
    const item: SecretItem = { id, name, fields: { ...fields }, notes, revisionDate: new Date().toISOString() }
    this.items.set(name, item)
    return { ...item, fields: { ...item.fields } }
  }

  async deleteSecret(sid: string, name: string) {
    this.rec('deleteSecret', sid, name)
    this.session(sid)
    this.items.delete(name)
  }

  async createSend(sid: string, text: string, opts?: { hours?: number; maxViews?: number; password?: string }) {
    this.rec('createSend', sid, text, opts)
    this.session(sid)
    return { url: 'https://vault.example.com/#/send/abc/def', expiresAt: new Date(Date.now() + (opts?.hours ?? 24) * 3600_000).toISOString() }
  }
}
