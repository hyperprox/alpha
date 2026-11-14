// The pieces of the +LXC / +VM form that are decisions rather than markup, kept CSS-free so they can be tested.

export interface FormNode { node: string; status?: string; cpu?: number; mem?: number; maxmem?: number }

const load = (n: FormNode) => {
  const cpu = Math.max(0, Math.min(1, n.cpu ?? 0))
  const mem = n.maxmem ? Math.max(0, Math.min(1, (n.mem ?? 0) / n.maxmem)) : 0
  return (cpu + mem) / 2
}

/** The node the form starts on: the one being looked at (when it is online), else the least loaded online node. */
export function defaultNode(nodes: FormNode[], viewed?: string | null): string {
  const online = nodes.filter(n => !n.status || n.status === 'online')
  const pool = online.length ? online : nodes
  if (viewed && pool.some(n => n.node === viewed)) return viewed
  return [...pool].sort((a, b) => load(a) - load(b) || a.node.localeCompare(b.node))[0]?.node ?? ''
}

// Container templates name the CPU architecture they were built for: debian-13-standard_13.1-2_amd64.tar.zst.
const ARCH_SUFFIX = /_(amd64|arm64|armhf|i386|ppc64el|riscv64|s390x)\.tar\.(?:zst|gz|xz|bz2|lzo)$/

export function templateArch(volidOrName: string): string | null {
  return ARCH_SUFFIX.exec(volidOrName)?.[1] ?? null
}

/** The kernel's machine name ("x86_64", "aarch64") as the architecture templates use. */
export function hostArch(machine: string | null | undefined): string | null {
  switch ((machine ?? '').toLowerCase()) {
    case 'x86_64': case 'amd64': return 'amd64'
    case 'aarch64': case 'arm64': return 'arm64'
    case 'armv7l': case 'armhf': return 'armhf'
    case 'i686': case 'i386': return 'i386'
    case 'ppc64le': return 'ppc64el'
    case 'riscv64': return 'riscv64'
    case 's390x': return 's390x'
    default: return null
  }
}

/** Templates this host can run. A template that names no architecture, or a host whose architecture is unknown, is kept. */
export function templatesForArch<T extends { volid?: string; name?: string }>(templates: T[], arch: string | null): T[] {
  if (!arch) return templates
  return templates.filter(t => {
    const a = templateArch(t.volid ?? t.name ?? '')
    return a === null || a === arch
  })
}

export interface FormStorage { storage: string; shared?: number | boolean; content?: string; avail?: number; active?: number; node?: string }

/** Storages a guest's disk can live on: rootdir for a container, images for a VM. */
export function storagesFor(type: 'lxc' | 'qemu', storages: FormStorage[], node?: string): FormStorage[] {
  const want = type === 'lxc' ? 'rootdir' : 'images'
  return storages.filter(s => (!node || s.node === node) && s.active !== 0 && (s.content ?? '').split(',').includes(want))
}

/**
 * The storage a new disk starts on: shared storage first (the guest can then move between nodes and fail over),
 * then the one with the most room. Never chosen just because it is first in the list, which put local-lvm there.
 */
export function pickRootStorage(storages: FormStorage[]): string | null {
  const rank = (s: FormStorage) => (Number(s.shared) === 1 || s.shared === true ? 1 : 0)
  return [...storages].sort((a, b) => rank(b) - rank(a) || (b.avail ?? 0) - (a.avail ?? 0) || a.storage.localeCompare(b.storage))[0]?.storage ?? null
}

export interface FormProposal { vmid: number; ip: string; gateway?: string; bridge?: string; vlan?: number }

/** The net0 value a proposal stands for: its bridge, a fixed address (with gateway and VLAN) or DHCP. */
export function proposedNet0(p: FormProposal): string {
  return `name=eth0,bridge=${p.bridge || 'vmbr0'},ip=${p.ip}${p.ip !== 'dhcp' && p.gateway ? `,gw=${p.gateway}` : ''}${p.vlan ? `,tag=${p.vlan}` : ''}`
}

/**
 * The form after the server's proposal arrives: its ID and network, except for the field the person already
 * typed in. (Typing the ID used to freeze the network too, and the reverse.)
 */
export function applyProposal<F extends { vmid: string; net0: string }>(f: F, p: FormProposal, touched: { id: boolean; net: boolean }): F {
  return { ...f, ...(touched.id ? {} : { vmid: String(p.vmid) }), ...(touched.net ? {} : { net0: proposedNet0(p) }) }
}
