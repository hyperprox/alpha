// Home Assistant, the visual Devices page: wall switches named as lights are lights (and everyday), indicator-LED
// companion switches are hidden, security words still win, and rooms are worked out from names when Home
// Assistant does not share its areas. Names here are made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_POLICY, alwaysSecurity, inferRoom, isLightSwitch, isNetworkGear, isPlugDevice, kindOf, ledCompanions, tierOf, displayState, type HAState,
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

test('LED companions match with untidy whitespace', () => {
  const states = [sw('fire', 'Fireplace'), sw('fire_led', 'Fireplace  LED'), sw('den', 'Den  Light'), sw('den_led', 'Den Light   LED ')]
  assert.deepEqual([...ledCompanions(states)].sort(), ['switch.den_led', 'switch.fire_led'])
})

const TPL = (model: string) => ({ manufacturer: 'TP-Link', model, platform: 'tplink', originalName: null })

test('TP-Link plugs and strips are plug sockets by model; wall switches are not', () => {
  for (const m of ['KP115', 'KP125M', 'HS103(US)', 'HS105', 'HS110', 'EP10', 'EP25', 'KP400', 'KP401', 'HS300', 'KP303']) {
    assert.equal(isPlugDevice(TPL(m)), true, m)
  }
  for (const m of ['HS200', 'HS210', 'HS220', 'KS200M', 'KS230', 'KL130']) assert.equal(isPlugDevice(TPL(m)), false, m)
  // The integration alone is enough to call it TP-Link.
  assert.equal(isPlugDevice({ manufacturer: null, model: 'KP115', platform: 'tplink' }), true)
  // Another maker's KP-looking model is not read as TP-Link...
  assert.equal(isPlugDevice({ manufacturer: 'Acme', model: 'KP115', platform: 'acme' }), false)
  // ...but any registry model or original name saying plug, outlet or strip is.
  assert.equal(isPlugDevice({ manufacturer: 'Acme', model: 'Smart Plug Mini' }), true)
  assert.equal(isPlugDevice({ manufacturer: 'Acme', model: 'X1', originalName: 'Outlet 2' }), true)
  assert.equal(isPlugDevice({ manufacturer: 'Acme', model: 'Power Strip 4' }), true)
  assert.equal(isPlugDevice(null), false)
})

test('every TP-Link switch is everyday: plugs (outlet kind) and wall switches whatever their name', () => {
  const plug = sw('tv_plug', 'TV')
  assert.equal(tierOf(plug, DEFAULT_POLICY), 'security', 'without the registry nothing is inferred')
  assert.equal(tierOf(plug, DEFAULT_POLICY, TPL('HS103(US)')), 'normal')
  assert.equal(kindOf(plug, TPL('HS103(US)')), 'outlet')
  // A wall switch that is not light-named is still everyday, and drawn as a switch.
  assert.equal(tierOf(sw('w', 'Den'), DEFAULT_POLICY, TPL('HS200')), 'normal')
  assert.equal(kindOf(sw('w', 'Den'), TPL('HS200')), 'switch')
  assert.equal(tierOf(sw('w', 'Porch'), DEFAULT_POLICY, { manufacturer: 'TP-Link', model: 'KS230' }), 'normal', 'maker alone')
  assert.equal(tierOf(sw('w', 'Porch'), DEFAULT_POLICY, { platform: 'tplink' }), 'normal', 'integration alone')
  assert.equal(kindOf(sw('w', 'Den Light'), TPL('HS220')), 'light')
  // Another maker's unnamed switch keeps the old rule.
  assert.equal(tierOf(sw('w', 'Den'), DEFAULT_POLICY, { manufacturer: 'Acme', model: 'W1', platform: 'acme' }), 'security')
})

test('security words and protection still win over TP-Link', () => {
  const plug = sw('tv_plug', 'TV')
  assert.equal(tierOf(sw('g', 'Garage Door'), DEFAULT_POLICY, TPL('HS200')), 'security')
  assert.equal(tierOf(sw('g', 'Garage opener'), DEFAULT_POLICY, TPL('KP115')), 'security')
  assert.equal(tierOf(sw('g', 'Front gate'), DEFAULT_POLICY, TPL('HS200')), 'security')
  assert.equal(tierOf(plug, { ...DEFAULT_POLICY, protected: ['switch.tv_plug'] }, TPL('KP115')), 'security')
  assert.equal(tierOf(plug, { ...DEFAULT_POLICY, securityDomains: ['switch'] }, TPL('KP115')), 'security')
})

test('network gear (routers, access points) is always security, whatever the maker, name or everyday mark', () => {
  const guest = st('switch.router_guest_wifi', 'off', { friendly_name: 'Guest Wi-Fi' })
  const reboot = st('button.router_reboot', 'unknown', { friendly_name: 'Reboot' })
  for (const platform of ['asuswrt', 'asusrouter', 'mikrotik', 'unifi', 'tplink_omada', 'tplink_deco', 'netgear', 'fritz', 'openwrt']) {
    assert.equal(isNetworkGear({ platform }), true, platform)
    assert.equal(tierOf(guest, DEFAULT_POLICY, { platform }), 'security', platform)
    assert.equal(tierOf(reboot, DEFAULT_POLICY, { platform }), 'security', platform)
  }
  // A light-sounding name or a TP-Link maker does not move a router's switch.
  assert.equal(tierOf(st('switch.ap_led', 'on', { friendly_name: 'AP Status Light' }), DEFAULT_POLICY, { platform: 'unifi', manufacturer: 'Ubiquiti' }), 'security')
  assert.equal(tierOf(guest, DEFAULT_POLICY, { manufacturer: 'TP-Link', model: 'EAP245', platform: 'tplink_omada' }), 'security')
  assert.equal(tierOf(guest, DEFAULT_POLICY, { manufacturer: 'TP-Link', model: 'Deco X20', platform: 'tplink' }), 'security', 'TP-Link network model')
  assert.equal(tierOf(guest, DEFAULT_POLICY, { manufacturer: 'TP-Link', model: 'Archer AX55', platform: 'tplink' }), 'security')
  // ...and neither does an owner's everyday mark.
  const marked = { ...DEFAULT_POLICY, everyday: [{ entity_id: guest.entity_id, domain: 'switch', device_class: null, friendly_name: 'Guest Wi-Fi' }] }
  assert.equal(tierOf(guest, marked), 'normal', 'the mark works on its own')
  assert.equal(tierOf(guest, marked, { platform: 'asuswrt' }), 'security', 'but never for network gear')
  assert.equal(isNetworkGear(TPL('KP115')), false)
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

function stubClient(states: HAState[], registry: boolean | (() => any)): HAClient {
  return {
    states: async () => states,
    state: async id => states.find(s => s.entity_id === id) ?? null,
    config: async () => ({}),
    errorLog: async () => '',
    callService: async () => {},
    registry: async () => {
      if (typeof registry === 'function') return registry()
      if (!registry) throw new Error('not shared')
      return { areas: [{ area_id: 'k', name: 'Cook space' }], devices: [], entities: [{ entity_id: 'switch.kitchen', area_id: 'k', device_id: null }] }
    },
    currentUser: async () => ({ name: 'hp', isAdmin: false, isOwner: false }),
  }
}

async function svcWith(states: HAState[], registry: boolean | (() => any)) {
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

test('service: TP-Link switches from the device registry are everyday, a router\'s switch is not', async () => {
  const states = [sw('tv_plug', 'TV'), sw('den', 'Den'), sw('den_lamp', 'Den Lamp'), sw('wifi', 'Guest Wi-Fi')]
  const reg = () => ({
    areas: [], devices: [
      { id: 'd1', area_id: null, manufacturer: 'TP-Link', model: 'KP115(US)' },
      { id: 'd2', area_id: null, manufacturer: 'TP-Link', model: 'HS200(US)' },
      { id: 'd3', area_id: null, manufacturer: 'TP-Link', model: 'HS220(US)' },
    ],
    entities: [
      { entity_id: 'switch.tv_plug', area_id: null, device_id: 'd1', platform: 'tplink', original_name: null },
      { entity_id: 'switch.den', area_id: null, device_id: 'd2', platform: 'tplink', original_name: null },
      { entity_id: 'switch.den_lamp', area_id: null, device_id: 'd3', platform: 'tplink', original_name: null },
      { entity_id: 'switch.wifi', area_id: null, device_id: null, platform: 'asusrouter', original_name: 'Guest Wi-Fi' },
    ],
  })
  const svc = await svcWith(states, reg)
  const all = (await svc.devices(DEFAULT_ID)).areas.flatMap(a => a.devices)
  const by = (id: string) => all.find(x => x.entityId === id)!
  assert.deepEqual([by('switch.tv_plug').tier, by('switch.tv_plug').kind], ['normal', 'outlet'])
  assert.deepEqual([by('switch.den').tier, by('switch.den').kind], ['normal', 'switch'])
  assert.deepEqual([by('switch.den_lamp').tier, by('switch.den_lamp').kind], ['normal', 'light'])
  assert.equal(by('switch.wifi').tier, 'security')
  const op = { sid: 's2', email: 'op@example.com', role: 'operator' as const, token: null }
  const r = await svc.act(DEFAULT_ID, { entityId: 'switch.tv_plug', action: 'turn_on' }, op, false)
  assert.equal(r.tier, 'normal')
  assert.equal((await svc.act(DEFAULT_ID, { entityId: 'switch.den', action: 'turn_on' }, op, false)).tier, 'normal')
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'switch.wifi', action: 'turn_on' }, op, false), (e: any) => e.code === 'security_action', 'router switch')
})

test('service: when the registry cannot be read, a plug is not guessed and stays security', async () => {
  const svc = await svcWith([sw('tv_plug', 'TV')], false)
  const op = { sid: 's3', email: 'op@example.com', role: 'operator' as const, token: null }
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'switch.tv_plug', action: 'turn_on' }, op, false), (e: any) => e.code === 'security_action')
})
