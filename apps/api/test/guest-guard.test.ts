// The one "leave this guest alone" rule (lib/guest-guard.ts) and the address helpers it stands on (lib/net/ip.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IGNORE_TAG, parseTags, hasIgnoreTag, guestExcluded, exclusionReason, excludedMachineIds, setGuestExclusionSource,
} from '../src/lib/guest-guard'
import { addressIP, cidrContains, cidrOverlaps, hostOf, hostPort, inCidrs, invalidCidrs, originParts, parseCidr, parseIPv4, validCidr } from '../src/lib/net/ip'

test('tags: one splitter, any case, semicolons, commas and white space', () => {
  assert.deepEqual(parseTags('web;HyperProx-Ignore, db  prod\tx'), ['web', 'hyperprox-ignore', 'db', 'prod', 'x'])
  assert.deepEqual(parseTags(['A;b', 'C']), ['a', 'b', 'c'])
  assert.deepEqual(parseTags(undefined), [])
  assert.equal(hasIgnoreTag('keep;HYPERPROX-IGNORE'), true)
  assert.equal(hasIgnoreTag('hyperprox-ignored'), false)
  assert.equal(IGNORE_TAG, 'hyperprox-ignore')
})

test('IPv4-mapped IPv6 addresses count as the IPv4 they carry, in every form', () => {
  for (const a of ['::ffff:192.0.2.7', '::FFFF:192.0.2.7', '0:0:0:0:0:ffff:192.0.2.7', '::ffff:c000:207', '[::ffff:192.0.2.7]:8080', 'http://[::ffff:c000:207]:9000/x']) {
    assert.equal(parseIPv4(a), (192 << 24 >>> 0) + (0 << 16) + (2 << 8) + 7, a)
    assert.equal(inCidrs(a, ['192.0.2.0/24']), true, a)
    assert.equal(inCidrs(a, ['198.51.100.0/24']), false, a)
  }
  // A mapped network covers the IPv4 addresses too.
  assert.equal(inCidrs('192.0.2.9', ['::ffff:192.0.2.0/120']), true)
  assert.equal(cidrContains('192.0.2.0/24', '::ffff:192.0.2.1'), true)
})

test('host:port and URLs are read for their host; names never match', () => {
  assert.equal(hostOf('192.0.2.5:8443'), '192.0.2.5')
  assert.equal(hostOf('https://Example.org:8443/a'), 'example.org')
  assert.equal(hostOf('[2001:db8::1]:22'), '2001:db8::1')
  assert.equal(inCidrs('192.0.2.5:8443', ['192.0.2.0/28']), true)
  assert.equal(inCidrs('https://192.0.2.5/admin', ['192.0.2.0/28']), true)
  assert.equal(inCidrs('http://192.0.2.200:80', ['192.0.2.0/28']), false)
  assert.equal(inCidrs('nas.example.org:80', ['0.0.0.0/0']), false)
  assert.equal(inCidrs('2001:db8::5', ['2001:db8::/64']), true)
  assert.equal(inCidrs('[2001:db8:1::5]:443', ['2001:db8::/64']), false)
  assert.equal(addressIP('not an address'), null)
  assert.deepEqual(hostPort('https://x.example.org/'), { scheme: 'https', host: 'x.example.org', port: 443 })
  assert.equal(originParts('192.0.2.5:8080')?.port, '8080')
})

test('networks: parsing, overlap and validation rules', () => {
  assert.deepEqual(parseCidr('192.0.2.77/24'), { v: 4, base: BigInt((192 << 24 >>> 0) + (2 << 8)), bits: 24 })
  assert.equal(parseCidr('192.0.2.0/33'), null)
  assert.equal(parseCidr('nonsense/8'), null)
  assert.equal(cidrOverlaps('198.51.100.0/25', '198.51.100.0/24'), true)
  assert.equal(cidrOverlaps('198.51.100.0/24', '2001:db8::/32'), false)
  assert.equal(validCidr('192.0.2.0/24', { v4Only: true, minBits: 8 }), true)
  assert.equal(validCidr('192.0.2.0/7', { v4Only: true, minBits: 8 }), false)
  assert.equal(validCidr('2001:db8::/32', { v4Only: true }), false)
  assert.equal(validCidr('2001:db8::/32'), true)
  assert.equal(validCidr('192.0.2.1'), false)
  assert.deepEqual(invalidCidrs(['192.0.2.0/24', '300.0.0.0/8', 'x'], { v4Only: true }), ['300.0.0.0/8', 'x'])
})

test('guestExcluded: the tag, the list, and an excluded subnet, with the reason in words', () => {
  const ctx = { excludedMachines: new Set(['qemu-200']), excludedSubnets: ['198.51.100.0/24'] }
  assert.equal(guestExcluded({ id: 'lxc-101', tags: 'Web;HyperProx-Ignore' }, ctx), 'the hyperprox-ignore tag')
  assert.equal(guestExcluded({ kind: 'qemu', vmid: 200 }, ctx), "Remote access's exclusion list")
  assert.equal(guestExcluded({ id: 'qemu-200' }, { excludedMachines: ['qemu-200'] }), "Remote access's exclusion list")
  assert.equal(guestExcluded({ id: 'lxc-102', addresses: [null, 'http://[::ffff:198.51.100.4]:8080'] }, ctx), 'an excluded subnet')
  assert.equal(guestExcluded({ id: 'lxc-103', addresses: ['192.0.2.4'] }, ctx), null)
  assert.equal(exclusionReason({ id: 'lxc-101', tags: ['HYPERPROX-IGNORE'] }), 'tag')
  // No subnets known: an address alone never excludes.
  assert.equal(guestExcluded({ id: 'lxc-102', addresses: ['198.51.100.4'] }, { excludedMachines: [] }), null)
})

test('the list source fails closed: unset or failing means the list is unknown', async () => {
  setGuestExclusionSource(null)
  await assert.rejects(excludedMachineIds(), (e: any) => e.name === 'ExclusionsUnknownRefusal' && e.status === 503)
  setGuestExclusionSource(async () => { throw new Error('database down') })
  await assert.rejects(excludedMachineIds(), (e: any) => e.name === 'ExclusionsUnknownRefusal')
  setGuestExclusionSource(async () => ['lxc-101'])
  assert.deepEqual(await excludedMachineIds(), ['lxc-101'])
  setGuestExclusionSource(null)
})

test('Nextcloud: a person\'s detect, add or action never enters a guest on the "never look inside" list', async () => {
  const { nextcloudExec } = await import('../src/lib/nextcloud')
  let ran = 0
  const rows = (excluded: string[] | null) => Promise.resolve([
    { kind: 'lxc' as const, vmid: 120, name: 'cloud', node: 'pve-a', running: true, ignored: !!excluded?.includes('lxc-120'), excludedBy: excluded?.includes('lxc-120') ? "Remote access's exclusion list" : null },
    { kind: 'lxc' as const, vmid: 121, name: 'cloud2', node: 'pve-a', running: true, ignored: false },
  ])
  const executor = { run: async () => { ran++; return { code: 0, output: 'ok', timedOut: false } } }
  const exec = nextcloudExec({ guests: rows, exclusions: async () => ['lxc-120'], executor })
  await assert.rejects(exec({ kind: 'lxc', vmid: 120 }, 'echo hi'), (e: any) => e.name === 'GuestExcludedRefusal' && /exclusion list/.test(e.message))
  assert.equal(ran, 0)
  await exec({ kind: 'lxc', vmid: 121 }, 'echo hi')
  assert.equal(ran, 1)
  // The list cannot be read: nothing is entered at all.
  const closed = nextcloudExec({ guests: rows, exclusions: async () => { throw new Error('down') }, executor })
  await assert.rejects(closed({ kind: 'lxc', vmid: 121 }, 'echo hi'))
  assert.equal(ran, 1)
})
