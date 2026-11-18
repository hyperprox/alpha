// The Arr Stack's "Sort requests into the right folder" pieces, rendered to HTML: the rules as a flow (controls only
// for an admin), the "not cartoons" list, a library test (the ring, the paired bars, the grouped disagreements), a
// Recently sorted card with "Move to…", and the page's words. All titles and folders are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { GroupCard, JobView, MoveCard, PhotorealList, RuleFlow, TestView } from '../components/plugins/arr/Router'
import {
  agreementWord, draftBody, allMoves, groupTicked, jobWord, leftAloneWord, libraryWord, toggleGroup, toggleItem, type LibraryJob, type LibraryPreview, type PlanGroup, folderName, graduateWord, moveRule, moveState, moveWord, parseTmdb, ruleLine, suggestedWord, switchOnWord, tickWord,
  type LibraryTest, type Move, type RouterAppStatus, type RouterSettings,
} from '../components/plugins/arr/router-view'

const noop = () => {}
const NOW = Date.parse('2026-11-18T12:00:00Z')
const F = '/data/films/'
const settings: RouterSettings = {
  enabled: false, defaultRoot: `${F}Main Films`, photoreal: [], graduate: false, enabledAt: null,
  rules: [
    { condition: 'curated', folder: `${F}Cinema Picks`, enabled: true },
    { condition: 'horror', folder: `${F}Frights`, enabled: true },
    { condition: 'superhero', folder: null, enabled: false },
    { condition: 'default', folder: `${F}Main Films`, enabled: true },
  ],
}
const st: RouterAppStatus = {
  app: 'radarr', label: 'Films', name: 'Radarr', configured: true, roots: [`${F}Main Films`, `${F}Frights`, `${F}Cinema Picks`],
  conditions: [{ id: 'curated', label: 'Hand-picked (never sorted into)' }, { id: 'horror', label: 'Horror' }, { id: 'superhero', label: 'Marvel and DC' }, { id: 'default', label: 'Everything else' }],
  settings, saved: false, lastTick: null,
}

test('the rules as a flow: where requests arrive, then each rule in order; controls only for an admin', () => {
  const html = renderToStaticMarkup(<RuleFlow st={st} draft={settings} canEdit onChange={noop} />)
  assert.match(html, /Requests arrive in/)
  assert.match(html, /Horror → Frights/)
  assert.match(html, /Cinema Picks is hand-picked: nothing is ever sorted into it/)
  assert.match(html, /Marvel and DC: pick a folder/)
  assert.match(html, /aria-label="Move Horror up"/)
  assert.equal((html.match(/<li/g) ?? []).length, 5, 'the inlet and four rules')
  const viewer = renderToStaticMarkup(<RuleFlow st={st} draft={settings} canEdit={false} onChange={noop} />)
  assert.ok(!/<select|<button|<input/.test(viewer), 'a viewer sees the rules with no controls')
  assert.match(viewer, /Main Films/)
})

test('rules reorder; a rule line says what it does', () => {
  const up = moveRule(settings.rules, 1, -1)
  assert.deepEqual(up.map(r => r.condition), ['horror', 'curated', 'superhero', 'default'])
  assert.equal(moveRule(settings.rules, 0, -1), settings.rules, 'the first cannot go higher')
  assert.equal(ruleLine(st, { condition: 'horror', folder: `${F}Frights`, enabled: false }), 'Horror: off')
  assert.equal(folderName('/data/films/Frights/'), 'Frights')
})

test('not cartoons: the TMDB numbers the owner added, and only a real number can be added', () => {
  const html = renderToStaticMarkup(<PhotorealList draft={{ ...settings, photoreal: [123] }} canEdit onChange={noop} />)
  assert.match(html, /TMDB 123/); assert.match(html, /aria-label="Remove TMDB 123"/)
  assert.equal(parseTmdb(' 4567 '), 4567); assert.equal(parseTmdb('tmdb:89'), 89); assert.equal(parseTmdb('12a'), null); assert.equal(parseTmdb('0'), null)
})

test('a library test: the agreement ring, the folders now and with the rules, the disagreements with examples', () => {
  const t: LibraryTest = {
    app: 'radarr', testId: 'a'.repeat(24), at: new Date(NOW).toISOString(), scored: 16, agree: 13, agreement: 81.3, curated: 1,
    byFolder: [{ folder: `${F}Frights`, actual: 1, picked: 2 }, { folder: `${F}Main Films`, actual: 4, picked: 3 }],
    disagreements: [{ actual: `${F}Main Films`, pick: `${F}Frights`, condition: 'horror', count: 1, examples: ['Signal Lost (1986)'] }],
  }
  const html = renderToStaticMarkup(<TestView t={t} />)
  assert.match(html, /aria-label="Agree: 81%"/)
  assert.match(html, /81\.3% of 16 films are already where these rules would put them/)
  assert.match(html, /1 in hand-picked folders are left out of the score/)
  assert.match(html, /Read-only: nothing was moved/)
  assert.match(html, /Signal Lost \(1986\)/); assert.match(html, /by the rule for horror/)
  assert.equal(agreementWord({ ...t, agreement: null }), 'Nothing to compare yet: the library is empty.')
})

test('Recently sorted: from → to with why; "Move to…" for an admin only, with undo marked', () => {
  const m: Move = {
    key: 'k1', at: new Date(NOW - 120_000).toISOString(), app: 'radarr', id: 18, title: 'Harrow Lane Haunting', year: 2026,
    from: `${F}Main Films`, to: `${F}Frights`, kind: 'sorted', condition: 'horror', why: 'Horror → Frights', detail: 'genre Horror', by: 'hyperprox', ok: true,
  }
  const html = renderToStaticMarkup(<MoveCard m={m} st={st} canAct onMove={noop} />)
  assert.match(html, /Harrow Lane Haunting \(2026\)/); assert.match(html, /Horror → Frights/); assert.match(html, /Because: genre Horror/)
  assert.match(html, /Main Films \(undo\)/)
  const viewer = renderToStaticMarkup(<MoveCard m={m} st={st} canAct={false} onMove={noop} />)
  assert.ok(!/<select|<button/.test(viewer))
  const failed = renderToStaticMarkup(<MoveCard m={{ ...m, ok: false, error: 'Radarr did not move it: HTTP 500' }} st={st} canAct onMove={noop} />)
  assert.match(failed, /Not moved/); assert.match(failed, /did not move it/); assert.ok(!/<select/.test(failed), 'nothing to undo')
  const moving = renderToStaticMarkup(<MoveCard m={{ ...m, ok: false, files: 'pending', error: 'Radarr is still moving the files.' }} st={st} canAct onMove={noop} />)
  assert.match(moving, /Files moving/); assert.match(moving, /still moving the files/); assert.ok(!/<select/.test(moving), 'no Move to until the files are there')
  assert.equal(moveState({ ok: false, why: 'x', files: 'failed' }).text, 'Files not moved')
})

test('the words: switching on, moving, graduating, the last look; the body sent is only what the API reads', () => {
  assert.match(switchOnWord('radarr', settings), /^Sort new films into folders\? .* lands in Main Films .* Nothing already in your library moves\.$/)
  assert.equal(moveWord({ title: 'Harrow Lane Haunting', year: 2026 }, `${F}Main Films`), 'Move Harrow Lane Haunting (2026) to Main Films? Its files move with it.')
  assert.match(graduateWord({ previewId: 'x', from: '/tv/On Air', to: '/tv/Finished Runs', shows: [{ id: 1, title: 'Tidewater', year: 2015, files: 20, aired: 20 }] }), /^Move 1 finished show to Finished Runs\?/)
  assert.equal(tickWord(null), 'Not looked yet.')
  assert.equal(tickWord({ at: new Date(NOW - 30_000).toISOString(), looked: 2, moved: 1, failed: 0 }, NOW), 'Last look just now · 2 new · 1 sorted.')
  assert.equal(tickWord({ at: new Date(NOW - 30_000).toISOString(), looked: 1, moved: 0, failed: 0, waiting: 1 }, NOW), 'Last look just now · 1 new · 1 waiting for an import to finish.')
  assert.ok(!('enabledAt' in draftBody({ ...settings, enabledAt: '2026-11-18T00:00:00Z' })))
  assert.match(suggestedWord({ saved: false, suggestedFrom: 'seerr' })!, /where Seerr sends them/)
  assert.match(suggestedWord({ saved: false, suggestedFrom: 'guess' })!, /most new items went/)
  assert.equal(suggestedWord({ saved: true }), null)
})

const group: PlanGroup = {
  key: 'k', from: `${F}Main Films`, to: `${F}Frights`, condition: 'horror', count: 2, word: 'Horror in Main Films → Frights',
  items: [{ id: 14, title: 'Signal Lost', year: 1986, detail: 'genre Horror' }, { id: 31, title: 'Old Fright', year: 1990, detail: 'genre Horror' }],
}

test('Sort my library: a group card is from → to with its count; unticked by default; titles open with their own boxes', () => {
  const closed = renderToStaticMarkup(<GroupCard g={group} sel={new Set()} open={false} canAct onGroup={noop} onItem={noop} onOpen={noop} />)
  assert.match(closed, /Main Films<\/span><span class="arrow" aria-hidden="true">→<\/span><span class="folder">Frights/)
  assert.match(closed, /<b class="count">2<\/b>/); assert.match(closed, /data-ticked="none"/)
  assert.match(closed, /aria-label="Move all of Horror in Main Films → Frights"/); assert.ok(!/checked=""/.test(closed), 'unticked by default')
  assert.match(closed, /Show the 2 titles/); assert.ok(!/Signal Lost/.test(closed))
  const open = renderToStaticMarkup(<GroupCard g={group} sel={new Set([14])} open canAct onGroup={noop} onItem={noop} onOpen={noop} />)
  assert.match(open, /Signal Lost \(1986\)/); assert.match(open, /data-ticked="some"/); assert.match(open, /1 ticked/)
  const shows = renderToStaticMarkup(<GroupCard g={{ ...group, items: [{ id: 5, title: 'Tidewater', year: 2015, detail: 'it has ended', episodes: { files: 18, aired: 20 } }] }} sel={new Set()} open canAct onGroup={noop} onItem={noop} onOpen={noop} />)
  assert.match(shows, /18 of 20 episodes/)
  const viewer = renderToStaticMarkup(<GroupCard g={group} sel={new Set()} open canAct={false} onGroup={noop} onItem={noop} onOpen={noop} />)
  assert.ok(!/<input/.test(viewer), 'a viewer sees the groups with no boxes')
})

test('Sort my library: ticking groups and titles, the confirm, and the progress ring with Stop', () => {
  let sel = toggleGroup(new Set(), group, true)
  assert.equal(groupTicked(sel, group), 'all')
  sel = toggleItem(sel, 31, false)
  assert.equal(groupTicked(sel, group), 'some')
  const p: LibraryPreview = { previewId: 'p', app: 'radarr', total: 2, groups: [group] }
  assert.equal(libraryWord(p, sel), 'Move 1 item in your library into the folders your rules pick? Horror in Main Films → Frights (1). Their files move with them, 20 a minute.')
  const j: LibraryJob = { id: 'j', app: 'radarr', by: 'a', startedAt: '', state: 'running', total: 300, moved: 142, failed: 3, skipped: 0, remaining: 155, groups: ['Horror in Main Films → Frights (300)'] }
  assert.equal(jobWord(j), '142 of 300 moved, 3 failed. The rest move 20 a minute.')
  const html = renderToStaticMarkup(<JobView j={j} canAct onStop={noop} />)
  assert.match(html, /aria-label="Sorting: 48%"/); assert.match(html, />Stop</)
  assert.ok(!/>Stop</.test(renderToStaticMarkup(<JobView j={j} canAct={false} onStop={noop} />)))
  assert.match(jobWord({ ...j, state: 'done', moved: 297, rescan: 'Plex was asked to rescan 1 library.' }), /Finished\. Plex was asked to rescan 1 library\./)
  assert.match(jobWord({ ...j, state: 'stopped', stoppedBy: 'admin@example.com' }), /Stopped by admin@example.com; the rest stayed where they were/)
})

test('Sort my library: folders no rule fills are listed as left alone', () => {
  assert.equal(leftAloneWord({ folder: `${F}Old Picks`, count: 18 }), 'Left alone: Old Picks (18 items) — no rule fills this folder')
  assert.equal(leftAloneWord({ folder: `${F}Old Picks`, count: 1 }), 'Left alone: Old Picks (1 item) — no rule fills this folder')
})

test('Sort my library: undo button, undo wording, waiting for Plex, and both move lists newest first', () => {
  const j: LibraryJob = { id: 'j', app: 'radarr', by: 'a', startedAt: '', state: 'done', total: 3, moved: 3, failed: 0, skipped: 0, remaining: 0, groups: [], canUndo: 3 }
  assert.match(renderToStaticMarkup(<JobView j={j} canAct onUndo={noop} />), /Undo this sort \(3\)/)
  assert.ok(!/Undo this sort/.test(renderToStaticMarkup(<JobView j={{ ...j, canUndo: 0 }} canAct onUndo={noop} />)))
  assert.ok(!/Undo this sort/.test(renderToStaticMarkup(<JobView j={j} canAct={false} onUndo={noop} />)))
  assert.equal(jobWord({ ...j, kind: 'undo' }), 'Undo: 3 of 3 moved. Finished.')
  assert.equal(jobWord({ ...j, rescanPending: true }), '3 of 3 moved. Finished; Plex rescans once the files have finished moving.')
  const mv = (at: string, key: string) => ({ key, at, app: 'radarr' as const, id: 1, title: 't', year: 0, from: 'a', to: 'b', kind: 'sorted' as const, condition: null, why: '', detail: '', by: '', ok: true })
  assert.deepEqual(allMoves({ recent: [mv('2026-11-18T10:00:00Z', 'r1')], recentLibrary: [mv('2026-11-18T11:00:00Z', 'l1')] }).map(m => m.key), ['l1', 'r1'])
})
