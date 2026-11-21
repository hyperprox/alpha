// =============================================================================
//  HyperProx — Home Assistant: the machine and its chores
//
//  What the install does for a virtual machine, in the order it does it. Proxmox makes the machine from the plan through
//  its API (createHaVm); the disk is then imported on the node over its login (an API token cannot import a disk or pass
//  a USB device in), after the official image is downloaded and checked against the SHA-256 pinned in recipe.ts; the
//  machine starts; and once Home Assistant answers, onboarding.ts does the owner, the home and the token. Every outside
//  call goes through deps, so the tests stand in for the node, Proxmox and Home Assistant.
// =============================================================================

import type { Http, StepRef } from '../arr/setup'
import type { HaSocket } from './ws'
import { HAOS_IMAGES, HAOS_VERSION, usbList, type HaosImage } from './recipe'
import { haUrl, hasHttpSection, onboard, setStaticAddress, waitForHomeAssistant, withTrust } from './onboarding'
import { HAVM_USB_SCRIPT, parseUsb, resolveUsb } from './usb'

const enc = encodeURIComponent
const sq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`
const STORAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA = /^[0-9a-f]{64}$/
const USB = /^(?:[0-9a-f]{4}:[0-9a-f]{4}|\d{1,3}-\d{1,3}(?:\.\d{1,3}){0,5})$/

/** The image for a node's processor, or null when Proxmox cannot run it (HyperProx makes x86 machines only). */
export function imageFor(arch: string): HaosImage | null { return arch === 'amd64' ? HAOS_IMAGES.amd64 : null }

/** Where Home Assistant keeps its configuration, as the guest agent sees the machine's own disk. */
export const CONFIG_PATH = '/mnt/data/supervisor/homeassistant/configuration.yaml'

export interface ImportInput { vmid: number; storage: string; image: HaosImage; diskGb: number; usb: string[] }

/**
 * The script run on the node: download, check the checksum, unpack, import the disk, attach it, grow it, pass the USB
 * devices in. Everything a person chose is checked here as it is put in; the image is the only thing downloaded, from the
 * address pinned in the recipe, and it is used only if its SHA-256 matches the one pinned beside it.
 */
export function importScript(i: ImportInput): string {
  if (!Number.isInteger(i.vmid) || i.vmid < 100) throw new Error('Bad machine id.')
  if (!STORAGE.test(i.storage)) throw new Error('Not a storage name.')
  if (!SHA.test(i.image.sha256)) throw new Error('Bad checksum.')
  if (!/^https:\/\/github\.com\/home-assistant\/operating-system\/releases\/download\/[0-9.]+\/[A-Za-z0-9._-]+\.qcow2\.xz$/.test(i.image.url)) throw new Error('The image address is not the pinned release.')
  for (const u of i.usb) if (!USB.test(u)) throw new Error('Bad USB id.')
  return [
    'set -eu',
    `V=${i.vmid}`, `S=${sq(i.storage)}`, 'F="/var/tmp/hyperprox-haos-$V.qcow2"',
    'trap \'rm -f "$F" "$F.xz"\' EXIT',
    // The download and the unpacked image are a few GB on the node's own disk until the import is done.
    'avail=$(df --output=avail -k /var/tmp | tail -1 | tr -d " ")',
    '[ "$avail" -ge 4194304 ] || { echo "@@ha space"; exit 3; }',
    `curl -fsSL --retry 3 --connect-timeout 20 -o "$F.xz" ${sq(i.image.url)}`,
    `printf '%s  %s\\n' ${sq(i.image.sha256)} "$F.xz" | sha256sum -c - >/dev/null || { echo "@@ha badsum"; exit 4; }`,
    'echo "@@ha checked"',
    'xz -dc "$F.xz" > "$F"', 'rm -f "$F.xz"',
    'qm disk import "$V" "$F" "$S" --format raw >/dev/null',
    'D=$(qm config "$V" | sed -n "s/^unused0: //p")',
    '[ -n "$D" ] || { echo "@@ha nodisk"; exit 5; }',
    'qm set "$V" --scsi0 "$D,discard=on,ssd=1" --boot order=scsi0 >/dev/null',
    // The image's disk is 32 GB; a bigger plan grows it (a resize to the same size is an error, so it is skipped).
    ...(i.diskGb > 32 ? [`qm resize "$V" scsi0 ${i.diskGb}G >/dev/null`] : []),
    ...i.usb.map((u, n) => `qm set "$V" --usb${n} host=${u} >/dev/null`),
    'echo "@@ha imported"',
  ].join('\n') + '\n'
}

export interface HaPlan { node: string; vmid: number; hostname: string; cores: number; memoryMb: number; diskGb: number; storage: string; bridge: string; vlan?: number }

/** The machine, through Proxmox's API: no disk yet (the import adds it), a UEFI one with its own EFI disk, behind the node firewall. */
export async function createHaVm(
  plan: HaPlan, description: string,
  client: { fetchStrict<T>(path: string, method?: string, body?: string): Promise<T>; waitForTask(node: string, upid: string, o: { timeoutMs: number }): Promise<unknown> },
  onCreated: () => void = () => {},
): Promise<void> {
  const body = new URLSearchParams()
  const set = (k: string, v: string | number) => body.set(k, String(v))
  set('vmid', plan.vmid); set('name', plan.hostname); set('memory', plan.memoryMb); set('cores', plan.cores); set('sockets', 1)
  set('cpu', 'x86-64-v2-AES'); set('machine', 'q35'); set('bios', 'ovmf'); set('ostype', 'l26'); set('scsihw', 'virtio-scsi-pci')
  set('efidisk0', `${plan.storage}:1,efitype=4m,pre-enrolled-keys=0`)
  set('net0', `virtio,bridge=${plan.bridge},firewall=1${plan.vlan ? `,tag=${plan.vlan}` : ''}`)
  set('agent', 'enabled=1'); set('onboot', 1); set('start', 0); set('tags', 'hyperprox'); set('description', description)
  const upid = await client.fetchStrict<string>(`/nodes/${enc(plan.node)}/qemu`, 'POST', body.toString())
  onCreated()
  await client.waitForTask(plan.node, upid, { timeoutMs: 5 * 60_000 })
}

/** The machine's IPv4 address from the guest agent: the first real interface, not loopback, link-local or Home Assistant's own Docker networks. */
export function agentAddress(result: unknown): string | undefined {
  const list: any[] = Array.isArray((result as any)?.result) ? (result as any).result : Array.isArray(result) ? result as any[] : []
  for (const nic of list) {
    if (!nic || nic.name === 'lo' || /^(docker|hassio|veth|br-)/.test(String(nic.name))) continue
    for (const a of nic['ip-addresses'] ?? []) {
      const ip = String(a?.['ip-address'] ?? '')
      if (a?.['ip-address-type'] === 'ipv4' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith('169.254.') && !ip.startsWith('127.') && !ip.startsWith('172.30.')) return ip
    }
  }
  return undefined
}

export interface HaSetupInput {
  node: string; vmid: number
  plan: { storage: string; diskGb: number; ip: string; gateway?: string; dns?: string }
  image: HaosImage
  name: string; units: 'metric' | 'us_customary'; timeZone: string
  owner: { name: string; username: string; password: string }
  usb: string[]
  vault: { category: string; provider: string }
  /** The plan will publish a name, so Home Assistant must trust the proxy first. */
  publishing: boolean
  /** The reverse proxy's own address (IPv4): the only address Home Assistant is told to trust. */
  proxyIp?: string
}

export interface HaSetupDeps {
  client: { fetchStrict<T>(path: string, method?: string, body?: string): Promise<T>; waitForTask(node: string, upid: string, o: { timeoutMs: number }): Promise<unknown> }
  nodeRun(node: string, script: string, timeoutMs: number): Promise<{ code: number; output: string }>
  http: Http
  socket(ip: string, accessToken: string): Promise<HaSocket>
  wait(ms: number): Promise<unknown>
  saveSecrets(category: string, provider: string, values: Record<string, string>): Promise<void>
  /** The Home Assistant plug-in's instances (its first is the plug-in's own settings). */
  connect(o: { name: string; url: string; token: string }): Promise<{ id: string; name: string }>
  /** The machine's own files through the guest agent. Absent or failing: the proxy step says what to add by hand. */
  agentFile?: { read(node: string, vmid: number, path: string): Promise<{ content: string; truncated: boolean }>; write(node: string, vmid: number, path: string, content: string): Promise<void> }
}

export interface HaSetupResult { ip: string; url: string; token: string; instance: { id: string; name: string }; trusted: boolean; trustNote: string }

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Let Home Assistant trust the reverse proxy, and only it: the proxy's own address with /32. The configuration is read through
 * the guest agent (a read that was cut short is never written back), the block is added, checked, applied with a restart, and Home
 * Assistant must come back; anything else puts the file back. The proof that Home Assistant accepts the proxy is the public check
 * that follows: it goes through the proxy itself. A forwarded request sent from HyperProx would prove nothing about the proxy.
 */
export async function trustProxy(i: { node: string; vmid: number; ip: string; token: string; proxyIp?: string }, d: Pick<HaSetupDeps, 'agentFile' | 'http' | 'wait'>): Promise<{ ok: boolean; note: string }> {
  const who = i.proxyIp && IPV4.test(i.proxyIp) ? `${i.proxyIp}/32` : '<the proxy\'s address>'
  const manual = (why: string) => ({ ok: false, note: `${why} Add these lines to Home Assistant's configuration.yaml (the File editor add-on does it), then restart Home Assistant: http: / use_x_forwarded_for: true / trusted_proxies: [${who}]. Then give it its public name from the Proxy page.` })
  if (!i.proxyIp || !IPV4.test(i.proxyIp)) return manual('HyperProx does not know the proxy\'s address, so it cannot tell Home Assistant which proxy to trust.')
  if (!d.agentFile) return manual('HyperProx cannot edit the machine\'s files.')
  let before: string
  try {
    const r = await d.agentFile.read(i.node, i.vmid, CONFIG_PATH)
    // The agent cuts a long read short; writing back a cut-short file would destroy the rest of the configuration.
    if (r.truncated) return manual('Home Assistant\'s configuration is larger than the guest agent will read in one go, so HyperProx did not touch it.')
    before = r.content
  } catch { return manual('The machine\'s guest agent would not let HyperProx read Home Assistant\'s configuration (Proxmox 9 needs the VM.GuestAgent.FileRead and FileWrite privileges for HyperProx\'s token).') }
  if (hasHttpSection(before)) return manual('Home Assistant\'s configuration already has an "http:" section, which HyperProx will not edit.')
  const auth = { authorization: `Bearer ${i.token}` }
  const restart = async () => {
    await d.http({ method: 'POST', url: `${haUrl(i.ip)}/api/services/homeassistant/restart`, headers: auth, json: {}, timeoutMs: 20_000 }).catch(() => null)
    await d.wait(15_000)
    for (let n = 0; n < 40; n++) { const s = await d.http({ method: 'GET', url: `${haUrl(i.ip)}/manifest.json`, timeoutMs: 6000 }).catch(() => null); if (s?.status === 200) return true; await d.wait(5000) }
    return false
  }
  const restore = async () => { await d.agentFile!.write(i.node, i.vmid, CONFIG_PATH, before).catch(() => {}); await restart() }
  try {
    await d.agentFile.write(i.node, i.vmid, CONFIG_PATH, withTrust(before, `${i.proxyIp}/32`))
    const check = await d.http({ method: 'POST', url: `${haUrl(i.ip)}/api/config/core/check_config`, headers: auth, json: {}, timeoutMs: 60_000 }).catch(() => null)
    if (!check || check.status !== 200 || !/"result"\s*:\s*"valid"/.test(check.body)) { await d.agentFile.write(i.node, i.vmid, CONFIG_PATH, before).catch(() => {}); return manual('Home Assistant did not accept the change when it checked it, so it was put back.') }
    if (!await restart()) { await restore(); return manual('Home Assistant did not come back after the change, so it was put back.') }
    return { ok: true, note: `Home Assistant trusts the proxy at ${i.proxyIp} only; the public name's own check goes through it.` }
  } catch (e: any) {
    await restore()
    return manual(`The change failed (${String(e?.message ?? e).slice(0, 100)}) and was put back.`)
  }
}

/** Everything after the machine exists: disk, start, address, first start, onboarding, token, plug-in, fixed address, proxy trust. */
export async function runHaSetup(i: HaSetupInput, step: (id: string) => StepRef, d: HaSetupDeps, setIp: (ip: string) => void): Promise<HaSetupResult> {
  const base = `/nodes/${enc(i.node)}/qemu/${i.vmid}`

  // The USB devices are looked at again now, as at the preview: still there, still ones the node can do without, still one device each.
  let usbHosts: string[] = []
  if (i.usb.length) {
    const seen = await d.nodeRun(i.node, HAVM_USB_SCRIPT, 30_000)
    const r = resolveUsb(parseUsb(seen.output), i.usb, i.node)
    if (r.errors.length) throw new Error(`${r.errors.join(' ')} Nothing was imported.`)
    usbHosts = r.hosts
  }
  const s1 = step('ha-image')
  const run = await d.nodeRun(i.node, importScript({ vmid: i.vmid, storage: i.plan.storage, image: i.image, diskGb: i.plan.diskGb, usb: usbHosts }), 25 * 60_000)
  if (/@@ha space/.test(run.output)) throw new Error(`${i.node} has less than 4 GB free in /var/tmp, which the image needs while it is unpacked. Free some space there or pick another node.`)
  if (/@@ha badsum/.test(run.output)) throw new Error('The downloaded Home Assistant OS image did not match its published checksum, so it was not used and nothing was imported.')
  if (!/@@ha checked/.test(run.output)) throw new Error('The Home Assistant OS image could not be downloaded to the node. Check that the node can reach github.com.')
  s1.status = 'done'; s1.detail = `Home Assistant OS ${HAOS_VERSION} (${i.image.file}) matched its pinned SHA-256.`

  const s2 = step('ha-disk')
  if (run.code !== 0 || !/@@ha imported/.test(run.output)) throw new Error(`The disk could not be imported into VM ${i.vmid} (exit ${run.code}).`)
  const cfg = await d.client.fetchStrict<Record<string, unknown>>(`${base}/config`)
  const bad: string[] = []
  if (!/^[^,]+:vm-\d+-disk-\d+/.test(String(cfg?.scsi0 ?? ''))) bad.push('the disk (scsi0)')
  if (String(cfg?.bios) !== 'ovmf') bad.push('UEFI')
  usbHosts.forEach((u, n) => { if (!String(cfg?.[`usb${n}`] ?? '').includes(u)) bad.push(`USB device ${u}`) })
  if (bad.length) throw new Error(`VM ${i.vmid}'s settings did not read back: ${bad.join(', ')}.`)
  await d.client.waitForTask(i.node, await d.client.fetchStrict<string>(`${base}/status/start`, 'POST'), { timeoutMs: 3 * 60_000 })
  s2.status = 'done'; s2.detail = `Disk imported${usbHosts.length ? `, ${usbHosts.length} USB device${usbHosts.length === 1 ? '' : 's'} passed in` : ''}; the machine is starting.`

  const s3 = step('network')
  let ip: string | undefined
  for (let n = 0; n < 60 && !ip; n++) {
    await d.wait(5000)
    ip = agentAddress(await d.client.fetchStrict<any>(`${base}/agent/network-get-interfaces`).catch(() => null))
  }
  if (!ip) throw new Error('The machine did not report an address. Home Assistant OS needs a DHCP server on its network for its first start; check the machine\'s console in Proxmox.')
  setIp(ip); s3.status = 'done'; s3.detail = ip

  const s4 = step('ha-ready')
  const ready = await waitForHomeAssistant(ip, d)
  if (ready === null) throw new Error('Home Assistant did not answer within thirty minutes. Its first start downloads Home Assistant from the internet: check the machine\'s console in Proxmox and that it can reach the internet.')
  if (ready === 'finished') throw new Error('Home Assistant is already set up, so HyperProx did not make its owner. Remove this install and start again.')
  s4.status = 'done'; s4.detail = 'Home Assistant answers and waits for its owner.'

  const s5 = step('ha-onboard')
  const { accessToken } = await onboard({ ip, name: i.name, owner: i.owner, timeZone: i.timeZone, units: i.units }, { http: d.http, socket: d.socket })
  s5.status = 'done'; s5.detail = `${i.owner.username} is the owner (the password is in the vault); the home is "${i.name}", ${i.timeZone}, ${i.units === 'metric' ? 'metric' : 'US customary'} units.`

  // Kept first: a token that exists only in this process is lost.
  const s6 = step('ha-token')
  await d.saveSecrets(i.vault.category, i.vault.provider, { access_token: accessToken })

  // A fixed address is set through Home Assistant's own network settings, then waited for.
  const s7 = step('ha-address')
  if (i.plan.ip === 'dhcp') { s7.status = 'skipped'; s7.detail = 'The address stays the one DHCP gave.' }
  else {
    const want = i.plan.ip.split('/')[0]
    if (want !== ip) {
      const sock = await d.socket(ip, accessToken)
      // The call cannot be answered from the old address once it works, so a cut or silent socket is "maybe applied": the new address decides.
      try { await setStaticAddress(sock, { address: i.plan.ip, gateway: i.plan.gateway, dns: i.plan.dns?.split(/\s+/).filter(Boolean) }) } finally { try { sock.close() } catch { /* already cut */ } }
      let at = false
      for (let n = 0; n < 60 && !at; n++) { await d.wait(5000); at = (await waitForHomeAssistant(want, { http: d.http, wait: async () => {} }, 1)) !== null }
      if (!at) throw new Error(`Home Assistant did not come back at ${want} after its address was changed. Its token is in the vault as access_token; look at the machine's console in Proxmox.`)
      ip = want; setIp(ip)
    }
    s7.status = 'done'; s7.detail = `${i.plan.ip}`
  }
  const url = haUrl(ip)
  const instance = await d.connect({ name: i.name, url, token: accessToken })
  s6.status = 'done'; s6.detail = `The token is in the vault, and the Home Assistant plug-in is connected as "${instance.name}".`

  const s8 = step('ha-trust')
  let trusted = false, trustNote = 'No public name was asked for, so Home Assistant was left as it is.'
  if (i.publishing) {
    const t = await trustProxy({ node: i.node, vmid: i.vmid, ip, token: accessToken, proxyIp: i.proxyIp }, d)
    trusted = t.ok; trustNote = t.note
    s8.status = t.ok ? 'done' : 'skipped'; s8.detail = t.note
  } else { s8.status = 'skipped'; s8.detail = trustNote }
  return { ip, url, token: accessToken, instance, trusted, trustNote }
}

export { usbList }
