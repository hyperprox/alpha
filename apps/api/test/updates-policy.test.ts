// Policy loading. Unknown keys must fail the load with their path, so a typo cannot quietly drop a safeguard;
// without a file the defaults are the safe ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePolicy, loadPolicy, nodePolicy, guestPolicy, policyStatus, nodePolicyView } from '../src/lib/updates/policy'

const EXAMPLE = path.resolve(__dirname, '../../../config/updates.example.yaml')

test('no file: not loaded, safe defaults, schedule off', () => {
  const l = loadPolicy('/nonexistent/updates.yaml')
  assert.equal(l.loaded, false)
  assert.match(l.error!, /No policy file/)
  assert.deepEqual(nodePolicy(l.policy, 'node-a'), { upgrade: 'upgrade', reboot: 'manual', requireHolds: [] })
  const g = guestPolicy(l.policy, 101)
  assert.equal(g.apt, true); assert.equal(g.docker, 'none'); assert.equal(g.reboot, 'never'); assert.equal(g.excluded, false)
  const s = policyStatus(l)
  assert.equal(s.loaded, false)
  assert.equal(s.schedule.enabled, false)
  assert.equal(s.schedule.nextRun, null)
})

test('unknown keys are rejected with their path, at every level', () => {
  const cases: Array<[string, RegExp]> = [
    ['shedule: { enabled: true }', /shedule: unknown key/],
    ['schedule: { enabled: true, windw_hours: 4 }', /schedule\.windw_hours: unknown key/],
    ['nodes:\n  gpu-node: { upgrade: upgrade, requre_pin: 7.0.1-1-pve }', /nodes\.gpu-node\.requre_pin: unknown key/],
    ['guests:\n  "205": { dokker: auto }', /guests\.205\.dokker: unknown key/],
    ['guests:\n  web: { apt: true }', /guests\.web: unknown key/],
    ['quiet: { plex_streams_block_reboot: true }', /quiet\.plex_streams_block_reboot: unknown key/],
    ['self: { node_order: last, vmid: 101, extra: 1 }', /self\.extra: unknown key/],
  ]
  for (const [yaml, re] of cases) assert.throws(() => parsePolicy(yaml), re, yaml)
})

test('bad values are rejected with their path', () => {
  assert.throws(() => parsePolicy('nodes:\n  default: { upgrade: full-upgrade }'), /nodes\.default\.upgrade/)
  assert.throws(() => parsePolicy('schedule: { cron: "0 8 * * WED" }'), /schedule\.cron/)
  assert.throws(() => parsePolicy('guests:\n  exclude: [abc]'), /guests\.exclude/)
  assert.throws(() => parsePolicy('guests:\n  "205": { docker: auto }'), /compose_dirs/)
  assert.throws(() => parsePolicy('batch_size: 0'), /batch_size/)
  assert.throws(() => parsePolicy('- just\n- a list'), /mapping/)
  assert.throws(() => parsePolicy('a: [unclosed'), /YAML/)
})

test('a broken file loads as not-loaded with the reason, never half-applied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-upd-'))
  const f = path.join(dir, 'updates.yaml')
  fs.writeFileSync(f, 'nodes:\n  default: { upgrade: dist-upgrade, reboot: auto }\n  gpu-node: { upgarde: upgrade }\n')
  const l = loadPolicy(f)
  assert.equal(l.loaded, false)
  assert.match(l.error!, /nodes\.gpu-node\.upgarde: unknown key/)
  assert.equal(nodePolicy(l.policy, 'node-a').upgrade, 'upgrade', 'the safe default, not the half-read file')
  fs.rmSync(dir, { recursive: true })
})

test('defaults and per-machine overrides merge', () => {
  const p = parsePolicy(`
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
  node-a: { reboot: manual, order: last }
  gpu-node: { upgrade: upgrade, require_holds: [proxmox-default-kernel], require_pin: 7.0.1-1-pve }
guests:
  default: { reboot: if-required }
  exclude: [110, 147]
  205: { docker: auto, compose_dirs: [/opt/stack] }
  "301": { check: "http://127.0.0.1:8080/health" }
`)
  assert.deepEqual(nodePolicy(p, 'node-b'), { upgrade: 'dist-upgrade', reboot: 'auto', requireHolds: [] })
  assert.deepEqual(nodePolicy(p, 'node-a'), { upgrade: 'dist-upgrade', reboot: 'manual', order: 'last', requireHolds: [] })
  assert.deepEqual(nodePolicyView(p, 'gpu-node'), { upgrade: 'upgrade', reboot: 'auto', requireHolds: ['proxmox-default-kernel'], requirePin: '7.0.1-1-pve' })
  assert.equal(guestPolicy(p, 110).excluded, true)
  assert.deepEqual(guestPolicy(p, 205).composeDirs, ['/opt/stack'])
  assert.equal(guestPolicy(p, 205).reboot, 'if-required')
  assert.equal(guestPolicy(p, 301).check, 'http://127.0.0.1:8080/health')
  assert.equal(p.batchSize, 3)
})

test('the shipped example file loads cleanly and keeps the schedule off', () => {
  const l = loadPolicy(EXAMPLE)
  assert.equal(l.loaded, true, l.error)
  assert.equal(l.policy.schedule.enabled, false)
  const s = policyStatus({ ...l, policy: { ...l.policy, schedule: { ...l.policy.schedule, enabled: true } } }, new Date('2026-10-24T12:00:00'))
  assert.ok(s.schedule.nextRun)
})
