// The Removed guests notice and Clean up, and Disconnect in a plug-in's settings: the sentence, the exact backup-job
// line, the proxy/DNS choice unticked by default, an emptied job never deleted unless ticked, and each page that holds
// something for a removed guest showing the notice.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/removed-guests.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { CleanUpChoices, CleanUpResults, RemovedGuestRow } from '../components/removed-guests/RemovedGuestsNotice'
import { forPlugin, jobLine, plan, resultSummary, type RemovedGuest } from '../components/removed-guests/logic'
import { DisconnectPlugin } from '../components/plugins/DisconnectPlugin'

const G: RemovedGuest = {
  vmid: 105, type: 'lxc', name: 'dash', removedAt: Date.UTC(2026, 10, 16), dateFrom: 'task', noticedAt: Date.UTC(2026, 10, 16), reused: null, unread: [],
  words: 'dash (container 105) was removed from Proxmox on 2026-11-16. HyperProx still has: The Homepage plug-in\'s connection to dash; Backup job "daily" (backup-daily, 02:00) still lists 105.',
  holdings: [
    { id: 'homepage:h1', kind: 'homepage', group: 'hyperprox', plugin: 'homepage', label: 'The Homepage plug-in\'s connection to dash', change: 'forgotten', vault: ['homepage/h1'] },
    { id: 'backup-job:backup-daily', kind: 'backup-job', group: 'cluster', label: 'Backup job "daily" (backup-daily, 02:00) still lists 105', change: 'its guest list becomes 100, 110', job: { id: 'backup-daily', before: [100, 105, 110], after: [100, 110], empty: false, schedule: '02:00', comment: 'daily' } },
    { id: 'backup-job:backup-only', kind: 'backup-job', group: 'cluster', label: 'Backup job (backup-only) still lists 105', change: 'it would back up nothing: deleted only if you tick it', job: { id: 'backup-only', before: [105], after: [], empty: true, schedule: null, comment: null } },
    { id: 'published:install:j1:0', kind: 'published', group: 'published', label: 'What its install published: the DNS record dash.example.com and its proxy host', change: 'removed' },
  ],
}

test('the notice row says what was removed and what HyperProx still has, with one Clean up', () => {
  const html = renderToStaticMarkup(<RemovedGuestRow g={G} onClean={() => {}} />)
  assert.match(html, /dash \(container 105\) was removed from Proxmox on 2026-11-16\. HyperProx still has:/)
  assert.equal((html.match(/>Clean up</g) ?? []).length, 1)
  assert.match(html, /container 105/)
  const reused = renderToStaticMarkup(<RemovedGuestRow g={{ ...G, reused: { name: 'other', type: 'qemu', at: 1 } }} />)
  assert.match(reused, /ID 105 now belongs to other, which is left alone/)
})

test('Clean up shows each backup job\'s exact change, asks before deleting an emptied job, and keeps the name unless ticked', () => {
  const html = renderToStaticMarkup(<CleanUpChoices g={G} published={false} onPublished={() => {}} deleteJobs={[]} onDeleteJob={() => {}} />)
  assert.match(html, /backup-daily: vmid 100,105,110 → 100,110/)
  assert.match(html, /backup-only: vmid 105 → \(nothing left\)/)
  assert.match(html, /Delete backup job backup-only/)
  assert.match(html, /Also remove the proxy host and DNS record its install made/)
  assert.match(html, /keep the name for a new install/)
  assert.match(html, /Vault items deleted with them: homepage\/h1/)
  // Both choices start unticked.
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2)
  assert.ok(!/checked=""/.test(html), 'nothing is ticked by default')
  const p = plan(G)
  assert.deepEqual(p.emptyJobs, ['backup-only'])
  assert.equal(jobLine(G.holdings[1]), 'vmid 100,105,110 → 100,110')
})

test('a plug-in page shows only the removed guests holding something of that plug-in', () => {
  const other: RemovedGuest = { ...G, vmid: 333, holdings: [G.holdings[1]] }
  assert.deepEqual(forPlugin([G, other], 'homepage').map(g => g.vmid), [105])
  assert.deepEqual(forPlugin([G, other], 'nextcloud'), [])
  assert.equal(forPlugin([G, other]).length, 2)
})

test('the results say what was cleaned, kept and failed', () => {
  const r = [{ id: 'a', kind: 'homepage', outcome: 'removed' as const, words: 'Homepage forgot dash.' }, { id: 'b', kind: 'backup-job', outcome: 'kept' as const, words: 'Backup job backup-only lists only 105, so it was left as it is.' }]
  assert.equal(resultSummary(r), '1 cleaned up, 1 kept.')
  assert.match(renderToStaticMarkup(<CleanUpResults results={r} />), /Homepage forgot dash\./)
})

test('Disconnect: offered when something is saved; a plug-in with its own device list points to its page; nothing when not set up', () => {
  const on = renderToStaticMarkup(<DisconnectPlugin plugin={{ id: 'arrstack', name: 'Arr Stack', configured: true }} onDisconnect={async () => null} />)
  assert.match(on, />Disconnect</)
  const half = renderToStaticMarkup(<DisconnectPlugin plugin={{ id: 'arrstack', name: 'Arr Stack', configured: false, settings: [{ isSet: true }] }} onDisconnect={async () => null} />)
  assert.match(half, />Disconnect</)
  const own = renderToStaticMarkup(<DisconnectPlugin plugin={{ id: 'homepage', name: 'Homepage', configured: true }} onDisconnect={async () => null} />)
  assert.match(own, /Disconnect each dashboard on the Homepage page/)
  assert.match(own, /href="\/plugins\/homepage"/)
  assert.equal(renderToStaticMarkup(<DisconnectPlugin plugin={{ id: 'arrstack', name: 'Arr Stack', configured: false }} onDisconnect={async () => null} />), '')
})

test('the notice is on the dashboard, the Plug-ins page, and the Homepage and Nextcloud pages (each only its own)', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  assert.match(read('app/dashboard/page.tsx'), /<RemovedGuestsNotice\/>/)
  assert.match(read('app/plugins/page.tsx'), /<RemovedGuestsNotice\/>/)
  assert.match(read('components/plugins/homepage/HomepagePage.tsx'), /<RemovedGuestsNotice plugin="homepage" \/>/)
  assert.match(read('components/plugins/nextcloud/NextcloudPage.tsx'), /<RemovedGuestsNotice plugin="nextcloud" \/>/)
  // The settings dialog carries Disconnect, and the guest delete carries the proxy/DNS choice (unticked).
  assert.match(read('app/plugins/page.tsx'), /<DisconnectPlugin plugin=\{plugin\} onDisconnect=\{onDisconnect\} \/>/)
  const ga = read('components/clusters/GuestActions.tsx')
  assert.match(ga, /useState\(false\)/)
  assert.match(ga, /confirmName: typed, removePublished/)
})
