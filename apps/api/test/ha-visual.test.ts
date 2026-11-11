// Home Assistant, the visual Devices page: wall switches named as lights are lights (and everyday), indicator-LED
// companion switches are hidden, security words still win, and rooms are worked out from names when Home
// Assistant does not share its areas. Names here are made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_POLICY, alwaysSecurity, inferRoom, isLightSwitch, kindOf, ledCompanions, tierOf, displayState, type HAState,
} from '../src/lib/ha-control/catalog'
import { InstanceStore, DEFAULT_ID } from '../src/lib/ha-control/instances'
import { HAControlService } from '../src/lib/ha-control/service'
import type { HAClient } from '../src/lib/ha-control/client'
import { st, memIO, openResolver, TOKEN_A } from './ha-control-fake'

const sw = (id: string, name: string, extra: Record<string, any> = {}) => st(`switch.${id}`, 'off', { friendly_name: name, ...extra })

test('a switch named as a light is a light: everyday, light kind', () => {
  for (const name of ['Hallway Light', 'Porch Lights', 'Reading Lamp', 'stair light']) {
    const s = sw('x', name)
    assert.equal(isLightSwitch(s), true, name)
    assert.equal(tierOf(s, DEFAULT_POLICY), 'normal', name)
    assert.equal(kindOf(s), 'light', name)
  }
})

test('an ordinary switch is still security by default, and a word inside another word is not a light', () => {
  for (const name of ['Water Heater', 'Lighthouse model', 'Flashlights charger']) {
    const s = sw('x', name)
    assert.equal(isLightSwitch(s), false, name)
    assert.equal(tierOf(s, DEFAULT_POLICY), 'security', name)
    assert.equal(kindOf(s), 'switch', name)
  }
})

test('security words still win over "light"', () => {
  for (const name of ['Garage Light', 'Front Door Light', 'Gate lamp', 'Alarm light']) {
    const s = sw('x', name)
    assert.equal(alwaysSecurity(s), true, name)
    assert.equal(isLightSwitch(s), false, name)
    assert.equal(tierOf(s, DEFAULT_POLICY), 'security', name)
  }
  // ...and in the entity id too.
  assert.equal(tierOf(st('switch.garage_relay', 'off', { friendly_name: 'Shed Light' }), DEFAULT_POLICY), 'security')
})

test('a protected light switch is security, and an outlet stays an outlet', () => {
  const s = sw('hall', 'Hall Light')
  assert.equal(tierOf(s, { ...DEFAULT_POLICY, protected: ['switch.hall'] }), 'security')
  assert.equal(tierOf(s, { ...DEFAULT_POLICY, securityDomains: ['switch'] }), 'security')
  assert.equal(kindOf(sw('lamp_plug', 'Lamp plug', { device_class: 'outlet' })), 'outlet')
})

test('indicator-LED companions are found only when the base switch exists', () => {
  const states = [
    sw('kitchen', 'Kitchen Light'), sw('kitchen_led', 'Kitchen Light LED'),
    st('light.dimmer', 'on', { friendly_name: 'Den Dimmer' }), sw('dimmer_led', 'Den Dimmer LED'),
    sw('strip', 'Desk LED'),                     // no "Desk" switch: a real LED strip, kept
    st('light.led', 'on', { friendly_name: 'Shelf LED' }),   // a light, not a switch: kept
  ]
  assert.deepEqual([...ledCompanions(states)].sort(), ['switch.dimmer_led', 'switch.kitchen_led'])
})

test('rooms from names: room words, named rooms, a person\'s room, else nothing', () => {
  const cases: Array<[string, string | null]> = [
    ['Living Room speaker', 'Living Room'], ['TV - LIVING ROOM', 'Living Room'], ['Family Room TV', 'Family Room'],
    ['Kitchen Fan Light', 'Kitchen'], ['Dinning Room Light', 'Dining Room'], ['Dining table lamp', 'Dining Room'],
    ['Bedroom TV', 'Bedroom'], ['Bathroom speaker', 'Bathroom'], ['Basement speaker', 'Basement'],
    ['Laundry Room speaker', 'Laundry'], ['Hallway Light', 'Hallway'], ['Hall lamp', 'Hallway'], ['Stair Light', 'Stairs'],
    ['Office display', 'Office'], ['Garage door', 'Garage'], ['Outside Light', 'Outside'], ['Porch lights', 'Outside'],
    ['Back yard flood', 'Outside'], ["Alex's Room speaker", "Alex's Room"], ['Alex’s lamp', "Alex's Room"],
    ['Alex Fan', "Alex's Room"], ['Alex Fan Light', "Alex's Room"], ['Guest Room lamp', 'Guest Room'],
    ['Computer Room display', 'Computer Room'], ['Ceiling Fan', null], ['Air Conditioner', null], ['Corner Light', null],
  ]
  for (const [name, room] of cases) assert.equal(inferRoom(name), room, name)
})

test('climate reading: a number or nothing, never the attribute bag', () => {
  assert.equal(displayState(st('climate.ac', 'cool', { current_temperature: 23.5, secret_token: 'x' })).current, 23.5)
  assert.equal('current' in displayState(st('climate.ac', 'cool', { current_temperature: 'warm' })), false)
  assert.equal('current' in displayState(st('light.a', 'on', { current_temperature: 20 })), false)
  assert.equal(JSON.stringify(displayState(st('climate.ac', 'cool', { secret_token: 'x' }))).includes('secret'), false)
})

function stubClient(states: HAState[], registry: boolean): HAClient {
  return {
    states: async () => states,
    state: async id => states.find(s => s.entity_id === id) ?? null,
    config: async () => ({}),
    errorLog: async () => '',
    callService: async () => {},
    registry: async () => {
      if (!registry) throw new Error('not shared')
      return { areas: [{ area_id: 'k', name: 'Cook space' }], devices: [], entities: [{ entity_id: 'switch.kitchen', area_id: 'k', device_id: null }] }
    },
    currentUser: async () => ({ name: 'hp', isAdmin: false, isOwner: false }),
  }
}

async function svcWith(states: HAState[], registry: boolean) {
  const io = memIO({ 'plugin/home-assistant/url': 'http://127.0.0.1:8123', 'plugin/home-assistant/token': TOKEN_A })
  const store = new InstanceStore(io, () => false, openResolver)
  return new HAControlService({ store, clientFor: () => stubClient(states, registry), audit: async () => {}, sleep: async () => {}, readBack: { tries: 1, everyMs: 0 } })
}

const HOUSE = () => [
  sw('kitchen', 'Kitchen Light'), sw('kitchen_led', 'Kitchen Light LED'),
  st('fan.alex', 'on', { friendly_name: 'Alex Fan' }),
  st('media_player.basement', 'playing', { friendly_name: 'Basement speaker' }),
  st('climate.ac', 'cool', { friendly_name: 'Air Conditioner', current_temperature: 24, temperature: 22, min_temp: 16, max_temp: 30, hvac_modes: ['off', 'cool'] }),
  st('lock.front', 'locked', { friendly_name: 'Front door' }),
]

test('devices without shared areas: rooms inferred, "Other" last, LED companion hidden and counted', async () => {
  const svc = await svcWith(HOUSE(), false)
  const d = await svc.devices(DEFAULT_ID)
  assert.equal(d.areaSource, 'none')
  assert.equal(d.hiddenLed, 1)
  assert.deepEqual(d.areas.map(a => a.name), ["Alex's Room", 'Basement', 'Kitchen', 'Other'])
  const all = d.areas.flatMap(a => a.devices)
  assert.equal(all.some(x => x.entityId === 'switch.kitchen_led'), false)
  const k = all.find(x => x.entityId === 'switch.kitchen')!
  assert.equal(k.kind, 'light'); assert.equal(k.tier, 'normal')
  assert.equal(all.find(x => x.entityId === 'climate.ac')!.current, 24)
  const lock = all.find(x => x.entityId === 'lock.front')!
  assert.equal(lock.tier, 'security'); assert.equal(lock.kind, 'lock')
})

test('real Home Assistant areas win when they are shared', async () => {
  const svc = await svcWith(HOUSE(), true)
  const d = await svc.devices(DEFAULT_ID)
  assert.equal(d.areaSource, 'registry')
  assert.deepEqual(d.areas.map(a => a.name), ['Cook space', 'No area'])
})

test('a light-named switch is acted on through the everyday route, and still refused on the secure one', async () => {
  const svc = await svcWith(HOUSE(), false)
  const op = { sid: 's', email: 'op@example.com', role: 'operator' as const, token: null }
  const ok = await svc.act(DEFAULT_ID, { entityId: 'switch.kitchen', action: 'turn_on' }, op, false).catch(e => e)
  assert.equal(ok.tier, 'normal')
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'switch.kitchen', action: 'turn_on' }, op, true), (e: any) => e.code === 'not_security')
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'lock.front', action: 'unlock' }, op, false), (e: any) => e.code === 'security_action')
})
