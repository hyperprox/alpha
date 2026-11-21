// =============================================================================
//  HyperProx — Home Assistant as a catalogue recipe
//
//  Home Assistant OS in a virtual machine: the way Home Assistant itself recommends, because the add-on store and the
//  supervisor only exist there. HyperProx downloads the official image for the node's processor (a pinned release,
//  checked against its published SHA-256 before it is used), makes a UEFI machine, imports the disk and starts it.
//  Then it does the chores: the owner account (a generated password, kept in the vault), the home's name, time zone and
//  units, a long-lived token, and the existing Home Assistant plug-in connected with it.
//
//  This is the first recipe that is a virtual machine and not a container. The reusable part is small: the recipe's
//  install kind is 'vm', the wizard's checks (node, sizes, ID, address, naming) are the container's own with the storage
//  rule changed from "holds containers" to "holds disk images", and the job is its own list of steps (job.ts).
// =============================================================================

import type { CatalogueRecipe, RecipeOption } from '../catalogue'
import { DETECT } from '../catalogue-detect'

export const HA_RECIPE_ID = 'home-assistant'
/** The release this install runs. Home Assistant updates itself from inside after that (Settings → System → Updates). */
export const HAOS_VERSION = '18.4'
export const HA_PORT = 8123

export interface HaosImage { arch: 'amd64' | 'arm64'; file: string; url: string; sha256: string }

const base = (file: string) => `https://github.com/home-assistant/operating-system/releases/download/${HAOS_VERSION}/${file}`
/**
 * The official images for this release, with the SHA-256 GitHub publishes for each asset (read from the release on
 * 2026-11-21). Proxmox runs x86 machines only, so the Arm image is pinned for a node that ever reports Arm, and is
 * refused for now (job.ts imageFor).
 */
export const HAOS_IMAGES: Record<'amd64' | 'arm64', HaosImage> = {
  amd64: { arch: 'amd64', file: `haos_ova-${HAOS_VERSION}.qcow2.xz`, url: base(`haos_ova-${HAOS_VERSION}.qcow2.xz`), sha256: '756ec485b1b153099ca53e88a5eebd63a801d56b791afe5c6d63ef94a35dc02d' },
  arm64: { arch: 'arm64', file: `haos_generic-aarch64-${HAOS_VERSION}.qcow2.xz`, url: base(`haos_generic-aarch64-${HAOS_VERSION}.qcow2.xz`), sha256: '1616dd368542591f7b144fc4b21fae51c8d1d23b4545a5b3904011d11ed724a3' },
}

export const HA_OPTIONS: RecipeOption[] = [
  { key: 'HA_NAME', label: 'Name of your home', kind: 'text', default: 'Home', maxLength: 40, hint: 'Shown at the top of Home Assistant.' },
  { key: 'HA_OWNER_NAME', label: 'Your name', kind: 'text', default: 'Owner', maxLength: 60, hint: 'The name on the owner account.' },
  { key: 'HA_OWNER_USER', label: 'Owner user name', kind: 'username', default: 'owner', maxLength: 40, hint: 'What you type to sign in. The password is generated, kept in the vault and shown once after the install.' },
  { key: 'HA_UNITS', label: 'Units', kind: 'text', default: 'metric',
    choices: [{ value: 'metric', label: 'Metric (°C, km, kg)' }, { value: 'us_customary', label: 'US customary (°F, miles, lb)' }] },
  { key: 'HA_USB', label: 'USB devices to pass in', kind: 'text', default: '', maxLength: 200,
    hint: 'Optional: a Zigbee or Z-Wave stick plugged into the node, as vendor:product codes separated by commas (pick them from the list). The machine then cannot move to another node while it holds them.' },
]

/** A vendor:product code, or a bus-port (1-2.3) for one of several identical devices. */
const USB_ID = /^(?:[0-9a-f]{4}:[0-9a-f]{4}|\d{1,3}-\d{1,3}(?:\.\d{1,3}){0,5})$/

export function usbList(v: string): string[] {
  return v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

export function checkHaOptions(v: Record<string, string>): string[] {
  const out: string[] = []
  const list = usbList(v.HA_USB ?? '')
  for (const id of list) if (!USB_ID.test(id)) out.push(`USB device "${id.slice(0, 20)}": use the code from the list, like 10c4:ea60 (or a bus-port like 1-2.3 when two identical devices are plugged in).`)
  if (new Set(list).size !== list.length) out.push('A USB device is listed twice.')
  if (list.length > 4) out.push('Pass in at most four USB devices.')
  return out
}

export const HA_SETUP_STEPS = [
  { id: 'ha-image', label: 'Download and check the Home Assistant OS image' },
  { id: 'ha-disk', label: 'Import the disk and start the machine' },
  { id: 'network', label: 'Wait for an address' },
  { id: 'ha-ready', label: 'Wait for Home Assistant\'s first start' },
  { id: 'ha-onboard', label: 'Make the owner account and set up the home' },
  { id: 'ha-token', label: 'Make HyperProx\'s access token and connect the plug-in' },
  { id: 'ha-address', label: 'Set the fixed address' },
  { id: 'ha-trust', label: 'Let the proxy speak for visitors' },
] as const

export const HA_RECIPE: CatalogueRecipe = {
  id: HA_RECIPE_ID,
  detect: DETECT[HA_RECIPE_ID],
  name: 'Home Assistant',
  summary: 'Your smart home in one place: lights, switches, sensors, cameras and automations from hundreds of brands, running on your own machines. Home Assistant OS in its own virtual machine, set up for you.',
  keywords: ['smart home', 'home automation', 'domotics', 'iot', 'lights', 'zigbee', 'z-wave', 'zwave', 'hass', 'homeassistant', 'alexa', 'google home', 'thermostat'],
  category: 'apps',
  port: HA_PORT,
  healthPath: '/manifest.json',
  expectStatus: [200],
  needsDocker: false,
  publishable: true,
  defaults: { cores: 2, memoryMb: 4096, diskGb: 32 },
  minimum: { cores: 2, memoryMb: 2048, diskGb: 32 },
  sizes: { small: { cores: 2, memoryMb: 2048, diskGb: 32 }, medium: { cores: 2, memoryMb: 4096, diskGb: 32 }, large: { cores: 4, memoryMb: 8192, diskGb: 64 } },
  firstRun: { kind: 'env-admin', passwordEnv: 'HA_OWNER_PASSWORD', userEnv: 'HA_OWNER_USER', user: 'owner', userOption: 'HA_OWNER_USER' },
  wizard: false,
  firstLogin: 'Sign in with the owner user name you chose. Its password is generated, kept in the vault and shown once after the install.',
  notes: [
    `Pinned: Home Assistant OS ${HAOS_VERSION}, downloaded from the official release and checked against its published SHA-256. Home Assistant then updates itself from inside (Settings → System → Updates).`,
    'It is a virtual machine, not a container: the add-on store and backups only exist on Home Assistant OS. It starts on boot, with UEFI, 2 cores, 4 GB RAM and a 32 GB disk by default.',
    'The first start downloads Home Assistant itself from the internet and can take ten minutes or more; HyperProx waits up to thirty.',
    'Passing in a USB stick (Zigbee, Z-Wave) ties the machine to this node: Proxmox cannot move it while it holds the device.',
    'A public name works once Home Assistant trusts the proxy (its "use_x_forwarded_for" and "trusted_proxies" settings). HyperProx writes them through the machine\'s guest agent and proves they work before it makes the name; if it cannot, it says what to add and leaves the name for you.',
    'The machine\'s address comes from DHCP at first and is then set to the fixed address you chose (a fixed address is applied through Home Assistant\'s own network settings).',
  ],
  options: HA_OPTIONS,
  checkOptions: checkHaOptions,
  setup: 'homeassistant',
  install: { kind: 'vm' },
}
