// /api/vpn: admin only, reads included; every change, reveal or rotation needs a re-confirmation, which also
// keeps API tokens out; previews do not. Answers that carry a config are never cached.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requiredRole, needsReconfirm } from '../src/lib/roles'

test('every WireGuard route is admin; changes are re-confirmed, previews are not', () => {
  for (const p of ['/api/vpn/wg', '/api/vpn/wg/router', '/api/vpn/wg/servers/abc/status', '/api/vpn/wg/router/firewall/wg-home']) {
    assert.equal(requiredRole('GET', p), 'admin', p)
    assert.equal(needsReconfirm('GET', p), false, p)
  }
  for (const [m, p] of [
    ['POST', '/api/vpn/wg/servers'], ['POST', '/api/vpn/wg/servers/adopt'], ['POST', '/api/vpn/wg/servers/abc/backup-key'],
    ['POST', '/api/vpn/wg/servers/abc/devices'], ['PATCH', '/api/vpn/wg/peers/abc'], ['DELETE', '/api/vpn/wg/peers/abc'],
    ['POST', '/api/vpn/wg/peers/abc/reveal'], ['POST', '/api/vpn/wg/peers/abc/rotate'], ['POST', '/api/vpn/wg/peers/abc/rollback'],
    ['POST', '/api/vpn/wg/machines/lxc-101/connect'], ['POST', '/api/vpn/wg/router/devices'], ['DELETE', '/api/vpn/wg/router/peers/*B1'],
    ['POST', '/api/vpn/wg/router/firewall/wg-home'],
  ] as const) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
  }
  assert.equal(needsReconfirm('POST', '/api/vpn/wg/router/peers/preview'), false)
})
