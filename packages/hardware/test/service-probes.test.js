'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { isProbeAddress, isUnicastV4, guestAddresses, scanHosts, PROBES } = require('../service-probes')

test('isProbeAddress: only RFC1918 IPv4 and ULA IPv6', () => {
  for (const ok of ['10.0.2.5', '172.16.0.1', '172.31.255.254', '192.168.1.9', 'fd00::1', 'fc12:3456::9']) assert.equal(isProbeAddress(ok), true, ok)
  for (const bad of ['0.0.0.0', '0.1.2.3', '127.0.0.1', '169.254.1.1', '224.0.0.1', '239.1.1.1', '255.255.255.255', '172.15.0.1', '172.32.0.1',
    '8.8.8.8', '100.64.0.1', '192.0.2.5', 'fe80::1', 'ff02::1', '::1', '::', '2001:db8::1', 'fe80::1%eth0', 'example.com', '', '10.0.2']) assert.equal(isProbeAddress(bad), false, bad)
})

test('isUnicastV4: public passes, the special ranges do not', () => {
  assert.equal(isUnicastV4('8.8.8.8'), true)
  for (const bad of ['0.0.0.0', '127.0.0.1', '169.254.0.5', '224.0.0.251', '255.255.255.255']) assert.equal(isUnicastV4(bad), false, bad)
})

test('guestAddresses: config wins over what the agent reports; dedupes; falls back when config has none', () => {
  assert.deepEqual(guestAddresses(['10.0.2.5', '10.0.2.5'], ['172.17.0.1', '10.0.2.5']), ['10.0.2.5'])
  assert.deepEqual(guestAddresses([], ['172.17.0.1', '169.254.3.3', '10.0.2.7', '10.0.2.7']), ['172.17.0.1', '10.0.2.7'])
  assert.deepEqual(guestAddresses(['8.8.8.8'], ['10.0.2.7']), ['10.0.2.7'])
})

test('scanHosts: never asks a non-private address, brackets IPv6', async () => {
  const asked = []
  const get = async (url) => { asked.push(url); return null }
  await scanHosts(['0.0.0.0', '127.0.0.1', '169.254.1.1', '224.0.0.1', '255.255.255.255', '8.8.8.8', 'fe80::1', 'host.example', 'fd00::5', '10.0.2.9']
    .map(address => ({ address, source: 's' })), get, { probes: PROBES.filter(p => p.key === 'npm') })
  assert.deepEqual(asked.sort(), ['http://10.0.2.9:81/', 'http://[fd00::5]:81/'].sort())
})
