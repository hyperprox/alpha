// The WebSocket handshake check against RFC 6455's own worked example, so a typo in the GUID can never again
// make every real Home Assistant look "odd" while the fake one (sharing the typo) still passes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wsAccept, WS_GUID } from '../src/lib/ha-control/client'

test('wsAccept matches the RFC 6455 section 1.3 example', () => {
  assert.equal(wsAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('the GUID is the one RFC 6455 defines', () => {
  assert.equal(WS_GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
})
