import { captureIds, deadManScript, planBlock, planForward, planLease, readInputs } from '../src/lib/mikrotik-change'
import { makeRouter } from './fakes/fake-mikrotik'
const r = makeRouter({ '/ip/firewall/filter': [
  { '.id': '*i1', chain: 'input', action: 'accept', 'connection-state': 'established,related' },
  { '.id': '*b1', chain: 'forward', action: 'drop', 'src-mac-address': '00:00:5E:00:53:40', 'out-interface-list': 'WAN', time: '22:00:00-06:00:00,mon,tue', comment: 'HyperProx block: tv [hpx-abcdef]', disabled: 'false' },
] });
(async () => {
const i = await readInputs(r, ['ether1'])
const plans: Record<string, any> = {
  'lease.make-static': planLease(i, { action: 'make-static', mac: '00:00:5E:00:53:31' }),
  'lease.add': planLease(i, { action: 'add', mac: '00:00:5E:00:53:50', address: '10.0.0.50', comment: 'printer' }),
  'lease.edit': planLease(i, { action: 'edit', id: '*l2', address: '10.0.0.21', comment: 'storage' }),
  'lease.remove': planLease(i, { action: 'remove', id: '*l2' }),
  'forward.add': planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '8123', name: 'cam' }),
  'forward.edit': planForward(i, { action: 'edit', id: '*f1', address: '10.0.0.20', proto: 'tcp', extPort: '444', name: 'web2' }),
  'forward.toggle': planForward(i, { action: 'toggle', id: '*f1', disabled: true }),
  'forward.remove': planForward(i, { action: 'remove', id: '*f1' }),
  'block.block': planBlock(i, { action: 'block', mac: '00:00:5E:00:53:31', schedule: { from: '22:00', to: '06:00', days: ['mon'] } }),
  'block.unblock': planBlock(i, { action: 'unblock', id: '*b1' }),
  'block.schedule': planBlock(i, { action: 'schedule', id: '*b1', schedule: null }),
  'block.schedule2': planBlock(i, { action: 'schedule', id: '*b1', schedule: { from: '23:00', to: '05:00' } }),
}
for (const [k, p] of Object.entries(plans)) { const c = await captureIds(r, p); console.log('== ' + k); process.stdout.write(deadManScript('a1b2c3d4', c.steps.slice().reverse().flatMap((s: any) => s.inverse))) }
})()
