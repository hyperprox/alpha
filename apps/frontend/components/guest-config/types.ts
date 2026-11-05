// Shapes the guest config API answers with (apps/api/src/routes/guest-config.ts).

export type GuestType = 'lxc' | 'qemu'

export interface VpnStatus {
  state: 'not-available' | 'none' | 'connected' | 'disconnected' | 'unknown'
  provider?: string; address?: string; hostname?: string; lastSeen?: string; detail?: string
}

export interface GuestRow {
  vmid: number; type: GuestType; node: string; name: string; status: string
  template: boolean; lock: string | null
  cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number
  tags: string[]; ip: string | null
  ha: { managed: boolean; state?: string; status?: string | null }
  gpu: { vendors: string[]; via: string[]; toggle: 'on' | 'off' | 'raw-only' | 'none' }
  vpn: VpnStatus
}

export interface Change { key: string; label: string; before: string | null; after: string | null; words: string; restart: 'live' | 'restart' | 'maybe' }

export interface PreviewData {
  previewId: string; kind: string
  guest: { node: string; type: GuestType; vmid: number; name: string; running: boolean; haManaged: boolean }
  expiresAt: number; quorate: boolean
  changes: Change[]; warnings: string[]; errors: string[]; checks: string[]
  restartNeeded: boolean; pendingBefore: string[]
  counts: { raw: number; unknown: number }
  extraConfirm: string[]; confirmName: boolean
  deviceChecks: Array<{ path: string; present: boolean }>
  canApply: boolean
}

export interface RestartResult {
  via: 'ha' | 'direct'; ok: boolean; steps: string[]; pendingAfter: string[]; rawSurvived: boolean | null
  devices: Array<{ path: string; expected: boolean; seen: boolean | null }>; problems: string[]
}

export interface ApplyData {
  ok: boolean
  outcome: { ok: boolean; problems: string[]; pendingKeys: string[]; rawBefore: number; rawAfter: number; unknownBefore: number; unknownAfter: number } | null
  pendingKeys: string[]; restartOffered: boolean; historyId: string | null
  restart?: RestartResult
}

export interface GpuEntry { key: string; value: string; via: 'devN' | 'lxc cgroup' | 'lxc mount' | 'hostpci'; device: string; vendor: string; assumed?: boolean }

export interface GuestView {
  guest: { node: string; type: GuestType; vmid: number; name: string; running: boolean; haManaged: boolean }
  config: Record<string, any>
  digest: string
  secretKeys: string[]
  keys: { modelled: string[]; raw: Array<{ key: string; value: string }>; unknown: Array<{ key: string; value: string }>; rawCount: number; unknownCount: number }
  pending: { keys: string[]; rows: Array<{ key: string; value?: any; pending?: any; delete?: number }> }
  gpu: { vendors: string[]; entries: GpuEntry[]; rawCount: number; toggle: 'on' | 'off' | 'raw-only' | 'none'; offSince: string | null; managed: Record<string, string> }
  sharers: Array<{ device: string; users: string[] }>
  historyCount: number
}

export interface DeviceUse { vmid: number; type: GuestType; name: string; running: boolean; via: string; key: string }

export interface Device {
  id: string; node: string; kind: 'gpu' | 'render' | 'usb' | 'serial' | 'video' | 'tpu' | 'tun' | 'pci'
  name: string; product: string; purpose: string; vendor?: string
  vendorProduct?: string; serial?: string; stableRef?: string; port?: string; pciAddress?: string
  paths: string[]; bootDisplay?: boolean; driver?: string; vfio?: boolean
  iommuGroup?: number; iommuClean?: boolean; driverVersion?: string; vram?: string; resetRisk?: string
  unknown?: boolean; shareAs: string[]; usedBy: DeviceUse[]; notes: string[]; needsExtraConfirm: boolean
}

export interface NodeInventory { node: string; devices: Device[]; nvidiaDriver?: string; collectedAt: number; problem?: string }

export interface HistoryItem { id: string; kind: string; tag: string | null; actor: string; outcome: 'ok' | 'failed'; createdAt: string; changes: Array<{ key: string; words: string }>; problems: string[] }

export const API = '/api/infra/guest-config'
export const gpath = (g: { node: string; type: GuestType; vmid: number }) => `${API}/guests/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}`

export const VENDOR_LABEL: Record<string, string> = { nvidia: 'NVIDIA', intel: 'Intel', amd: 'AMD', other: 'GPU', unknown: 'GPU' }

export const SHARE_LABEL: Record<string, string> = {
  'lxc-dev-shared': 'LXC device (shareable)', 'lxc-dev-exclusive': 'LXC device (one guest)', 'vm-usb': 'VM USB', 'vm-serial': 'VM serial', 'vm-hostpci': 'VM PCI passthrough (exclusive)',
}
