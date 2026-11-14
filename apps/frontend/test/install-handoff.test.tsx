// The VPN page's pieces for what the installer set up, rendered to HTML: a server HyperProx adopted shows with
// its address and endpoint and asks for the first phone; entries still waiting say so, with the last error.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { InstallHandoffNotice, WgServerHeading } from '../components/remote-access/InstallHandoff'

test('an adopted WireGuard server renders with its tunnel, its endpoint and the call to add a phone', () => {
  const html = renderToStaticMarkup(<WgServerHeading name="hyperprox-wg" iface="hp-wg0" address="10.99.0.1/24"
    endpoint="vpn.example.com:51820" peers={0} add={<button>Add phone or laptop…</button>} />)
  assert.match(html, /hyperprox-wg · hp-wg0/)
  assert.match(html, /10\.99\.0\.1\/24 · vpn\.example\.com:51820/)
  assert.match(html, /Add phone or laptop/)
  assert.match(html, /data-testid="add-first-phone"/)
  assert.match(html, /forward UDP 51820/)
  assert.match(html, /reaches HyperProx/)
})

test('a server with peers does not ask for the first phone again', () => {
  const html = renderToStaticMarkup(<WgServerHeading name="hyperprox-wg" iface="hp-wg0" address="10.99.0.1/24"
    endpoint="vpn.example.com:51820" peers={2} add={<button>Add phone or laptop…</button>} />)
  assert.doesNotMatch(html, /add-first-phone/)
})

test('entries still waiting to be taken over are listed with their last error; none shows nothing', () => {
  const html = renderToStaticMarkup(<InstallHandoffNotice retry={<button>Retry now</button>} entries={[
    { kind: 'wireguard', ctid: 161, machineId: 'lxc-161', address: '10.99.0.1/24', endpoint: 'vpn.example.com:51820', lastError: 'hp-wg0 is not up on hyperprox-wg' },
    { kind: 'tailscale', ctid: 160, machineId: 'lxc-160', ip: '100.101.102.103', dnsName: 'hyperprox.example-tailnet.ts.net' },
  ]} />)
  assert.match(html, /WireGuard server in container 161 \(10\.99\.0\.1\/24, vpn\.example\.com:51820\)/)
  assert.match(html, /last try: hp-wg0 is not up/)
  assert.match(html, /Tailscale on this HyperProx \(container 160, hyperprox\.example-tailnet\.ts\.net\)/)
  assert.match(html, /Retry now/)
  assert.equal(renderToStaticMarkup(<InstallHandoffNotice retry={<button>Retry now</button>} entries={[]} />), '')
})
