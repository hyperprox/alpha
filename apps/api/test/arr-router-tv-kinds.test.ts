// Arr Stack router: the show-kind conditions (anime, preschool, adult animation, documentary series, live-action kids
// and teens): each one, the priority order, missing metadata, and that settings saved before them behave identically.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRESCHOOL_NETWORKS, SHOW_CONDITIONS, CONDITION_LABEL, conditionsFor, defaultSettings, orderedRules, parseSettings, pickFolder, showMatch, showOf, withMissingRules,
  type AppSettings, type Rule, type Show,
} from '../src/lib/arr-router/rules'

const T = '/data/tv/'
const show = (over: Partial<Show> = {}): Show => ({
  id: 1, tvdbId: 1, title: 'A Made-up Show', year: 2020, genres: [], seriesType: 'standard', status: 'continuing',
  certification: '', network: '', language: '', root: `${T}Main`, path: `${T}Main/A Made-up Show`, added: '2026-11-18T11:59:00Z', tags: [], files: 0, aired: 0, ...over,
})
const rule = (condition: any, folder: string | null = `${T}${condition}`, enabled = true): Rule => ({ condition, folder, enabled })
const settings = (...rules: Rule[]) => ({ rules, photoreal: [] as number[] })

test('showOf reads certification, network and original language from Sonarr', () => {
  const s = showOf({ id: 3, certification: 'tv-ma', network: ' Example Net ', originalLanguage: { id: 8, name: 'Japanese' } })
  assert.equal(s.certification, 'TV-MA'); assert.equal(s.network, 'Example Net'); assert.equal(s.language, 'japanese')
  const bare = showOf({ id: 4 })
  assert.deepEqual([bare.certification, bare.network, bare.language], ['', '', ''])
})

test('anime: series type, Anime genre, or East Asian animation; not a Western cartoon', () => {
  assert.equal(showMatch('anime', show({ seriesType: 'anime' })), 'series type anime')
  assert.ok(showMatch('anime', show({ genres: ['Anime'] })))
  assert.ok(showMatch('anime', show({ genres: ['Animation'], language: 'korean' })))
  assert.ok(showMatch('anime', show({ genres: ['Animation'], language: 'zh' })))
  assert.equal(showMatch('anime', show({ genres: ['Animation'], language: 'english' })), null)
  assert.equal(showMatch('anime', show({ genres: ['Drama'], language: 'japanese' })), null, 'live action Japanese drama is not anime')
  assert.equal(showMatch('anime', show()), null)
})

test('preschool: TV-Y, or TV-G children\'s show from a preschool network or genre', () => {
  assert.ok(showMatch('preschool', show({ certification: 'TV-Y' })))
  for (const n of PRESCHOOL_NETWORKS) assert.ok(showMatch('preschool', show({ certification: 'TV-G', genres: ['Children'], network: n.toUpperCase() })), n)
  assert.ok(showMatch('preschool', show({ certification: 'TV-G', genres: ['Children', 'Preschool'] })))
  assert.equal(showMatch('preschool', show({ certification: 'TV-G', genres: ['Children'], network: 'Example Net' })), null)
  assert.equal(showMatch('preschool', show({ certification: 'TV-G', network: 'PBS Kids' })), null, 'needs the Children genre')
  assert.equal(showMatch('preschool', show({ certification: 'TV-Y7', genres: ['Children'] })), null)
})

test('adult-animation: animated and TV-MA or TV-14, never anime', () => {
  assert.ok(showMatch('adult-animation', show({ genres: ['Animation'], certification: 'TV-MA' })))
  assert.ok(showMatch('adult-animation', show({ genres: ['Animation'], certification: 'TV-14' })))
  assert.equal(showMatch('adult-animation', show({ genres: ['Animation'], certification: 'TV-PG' })), null)
  assert.equal(showMatch('adult-animation', show({ genres: ['Drama'], certification: 'TV-MA' })), null)
  assert.equal(showMatch('adult-animation', show({ seriesType: 'anime', certification: 'TV-MA' })), null)
  assert.equal(showMatch('adult-animation', show({ genres: ['Animation'], certification: 'TV-MA', language: 'japanese' })), null)
})

test('docuseries: genre Documentary', () => {
  assert.equal(showMatch('docuseries', show({ genres: ['Documentary'] })), 'genre Documentary')
  assert.equal(showMatch('docuseries', show({ genres: ['Drama'] })), null)
})

test('kids-teens: live action, TV-Y7/TV-G/TV-PG, Children or Family genre', () => {
  assert.ok(showMatch('kids-teens', show({ certification: 'TV-PG', genres: ['Family'] })))
  assert.ok(showMatch('kids-teens', show({ certification: 'TV-Y7', genres: ['Children'] })))
  assert.ok(showMatch('kids-teens', show({ certification: 'TV-G', genres: ['Family', 'Comedy'] })))
  assert.equal(showMatch('kids-teens', show({ certification: 'TV-PG', genres: ['Drama'] })), null)
  assert.equal(showMatch('kids-teens', show({ certification: 'TV-14', genres: ['Family'] })), null)
  assert.equal(showMatch('kids-teens', show({ certification: 'TV-Y7', genres: ['Children', 'Animation'] })), null, 'animated shows are not live action')
})

test('missing metadata falls through to the older rules', () => {
  const s = settings(rule('anime'), rule('preschool'), rule('adult-animation'), rule('docuseries'), rule('kids-teens'), rule('ended'), rule('running'), rule('default'))
  assert.equal(pickFolder('sonarr', s, show())?.condition, 'running')
  assert.equal(pickFolder('sonarr', s, show({ status: 'ended' }))?.condition, 'ended')
  assert.equal(pickFolder('sonarr', s, show({ status: '' }))?.condition, 'default')
})

test('priority: preschool, anime, adult animation, documentary, kids, then animated, ended, running, default', () => {
  const all = settings(rule('animated'), rule('ended'), rule('running'), rule('default'), rule('kids-teens'), rule('docuseries'), rule('adult-animation'), rule('anime'), rule('preschool'))
  const pick = (o: Partial<Show>) => pickFolder('sonarr', all, show(o))?.condition
  assert.equal(pick({ seriesType: 'anime', certification: 'TV-Y', genres: ['Documentary'] }), 'preschool', 'a TV-Y anime is a kids\' show first')
  assert.equal(pick({ genres: ['Animation'], language: 'korean', certification: 'TV-Y' }), 'preschool')
  assert.equal(pick({ seriesType: 'anime', certification: 'TV-14' }), 'anime')
  assert.equal(pick({ certification: 'TV-Y', genres: ['Animation', 'Documentary'] }), 'preschool')
  assert.equal(pick({ certification: 'TV-MA', genres: ['Animation', 'Documentary'] }), 'adult-animation')
  assert.equal(pick({ certification: 'TV-PG', genres: ['Family', 'Documentary'] }), 'docuseries')
  assert.equal(pick({ certification: 'TV-PG', genres: ['Family'] }), 'kids-teens')
  assert.equal(pick({ genres: ['Animation'], certification: 'TV-PG' }), 'animated')
  assert.equal(pick({ status: 'ended' }), 'ended')
  assert.equal(pick({}), 'running')
})

test('a condition only applies when its rule is enabled and has a folder', () => {
  const s = settings(rule('anime', null, false), rule('preschool', `${T}Little`, false), rule('animated'), rule('default'))
  assert.equal(pickFolder('sonarr', s, show({ seriesType: 'anime', certification: 'TV-Y' }))?.condition, 'animated', 'with the new rules off, an anime is animated as before')
  assert.equal(pickFolder('sonarr', s, show({ genres: ['Animation'] }))?.condition, 'animated')
})

test('old saved settings: same picks, same order of the old rules, new conditions off', () => {
  const old = settings(rule('running'), rule('animated'), rule('ended'), rule('default'))
  assert.deepEqual(orderedRules('sonarr', old.rules), old.rules, 'the owner\'s order is kept')
  assert.equal(pickFolder('sonarr', old, show({ genres: ['Animation'] }))?.condition, 'running', 'running listed first still wins')
  assert.equal(pickFolder('sonarr', old, show({ certification: 'TV-Y', genres: ['Documentary'] }))?.condition, 'running')
  const parsed = parseSettings('sonarr', { enabled: false, defaultRoot: null, rules: old.rules }, null)
  assert.equal(typeof parsed, 'object')
  assert.deepEqual((parsed as AppSettings).rules, old.rules)
})

test('the conditions list and the page: every show condition has a plain label, and missing ones are offered switched off', () => {
  for (const c of SHOW_CONDITIONS) assert.ok(CONDITION_LABEL[c].length > 3, c)
  assert.deepEqual(conditionsFor('radarr').filter(c => (SHOW_CONDITIONS as readonly string[]).includes(c) && c !== 'default'), [])
  const saved = defaultSettings('sonarr', [`${T}Main`], `${T}Main`).rules
  const shown = withMissingRules('sonarr', saved)
  assert.equal(shown.length, SHOW_CONDITIONS.length)
  assert.deepEqual(shown.filter(r => !saved.some(x => x.condition === r.condition)).map(r => [r.folder, r.enabled]), [[null, false], [null, false], [null, false], [null, false], [null, false]])
  assert.deepEqual(shown.slice(0, 5).map(r => r.condition), ['preschool', 'anime', 'adult-animation', 'docuseries', 'kids-teens'])
  assert.deepEqual(withMissingRules('radarr', defaultSettings('radarr', [], null).rules).length, conditionsFor('radarr').length)
})
