// Value-level redaction: secrets inside values (OCI env, lxc.environment, descriptions, hook args, tokens, keys).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactValue, redactConfig, redactText, redactConfFile, REDACTED } from '../src/lib/guest-config/secrets'

const M = 'PLANTED-7f3e9c'

test('secret-looking key names lose their whole value', () => {
  const c = redactConfig({ cipassword: M, sshkeys: `ssh-ed25519 ${M}`, memory: 512 } as any)
  assert.equal(c.cipassword, REDACTED); assert.equal(c.sshkeys, REDACTED); assert.equal(c.memory, 512)
})

test('OCI env values and lxc.environment lines keep the names, never the values', () => {
  const c = redactConfig({ env: `DB_PASSWORD=${M}\u0000TZ=UTC`, lxc: [['lxc.environment', `API_TOKEN=${M}`], ['lxc.environment', `PLAIN=${M}`], ['lxc.mount.entry', '/dev/x dev/x none bind']] } as any)
  assert.ok(!JSON.stringify(c).includes(M))
  assert.match(String(c.env), /DB_PASSWORD=\*\*redacted\*\*/)
  assert.match(String(c.env), /TZ=\*\*redacted\*\*/)
  assert.deepEqual((c.lxc as any)[0], ['lxc.environment', `API_TOKEN=${REDACTED}`])
  assert.deepEqual((c.lxc as any)[2], ['lxc.mount.entry', '/dev/x dev/x none bind'])
})

test('values that look like secrets are redacted wherever they are: description, hook args, tokens, private keys', () => {
  for (const v of [`db password=${M}`, `token: ${M}`, `--api-key ${M}`, `ghp_${'a'.repeat(36)}`, 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----', `hpx_${'Z'.repeat(30)}`]) {
    const r = redactValue('description', v)
    assert.ok(!r.includes(M) && r.includes(REDACTED), `${v} → ${r}`)
  }
  assert.equal(redactValue('description', 'Media server; ask before rebooting'), 'Media server; ask before rebooting')
  assert.equal(redactValue('net0', 'name=eth0,bridge=vmbr0,ip=192.0.2.5/24'), 'name=eth0,bridge=vmbr0,ip=192.0.2.5/24')
})

test('a whole config file is redacted line by line, snapshot sections included', () => {
  const f = `arch: amd64\ndescription: password%3D${M}\nlxc.environment: SECRET=${M}\nmemory: 512\n\n[snap1]\nlxc.environment: SECRET=${M}\nmemory: 256\n`
  const r = redactConfFile(f)
  assert.ok(!r.includes(M))
  assert.ok(r.includes('memory: 512') && r.includes('[snap1]') && r.includes('memory: 256'))
  assert.ok(!redactText(`moved and token=${M}`).includes(M))
})
