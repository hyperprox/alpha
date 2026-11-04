// A small fake Proxmox for the Catalogue install wizard: node-a (roomy), node-b (GPU passed to a guest),
// node-c (offline), and the deps the wizard reaches for.
import { getInstallJob, type WizardDeps, type WizardInput } from "../../src/lib/catalogue-installer"

export const GB = 1024 ** 3
export const TMPL = "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"

/** A small cluster: node-a (roomy), node-b (GPU passed to a guest), node-c (offline). */
export class FakePve {
  guests: any[] = [
    { vmid: 100, type: "lxc", node: "node-a", name: "web", status: "running" },
    { vmid: 101, type: "qemu", node: "node-b", name: "gpu-vm", status: "running" },
  ]
  configs: Record<number, any> = {
    100: { net0: "name=eth0,bridge=vmbr0,ip=192.0.2.21/24,gw=192.0.2.1" },
    101: { hostpci0: "0000:0a:00", agent: "1" },
  }
  live: Record<number, any> = { 100: [{ name: "eth0", inet: "192.0.2.21/24" }], 101: { result: [] } }
  creates: Array<{ node: string; body: URLSearchParams }> = []
  deletes: string[] = []
  deletePaths: string[] = []
  /** Paths that answer as a failed read. */
  failing = new Set<string>()
  /** Count of reads per path, to see what was cached. */
  reads = new Map<string, number>()
  stops: string[] = []
  createFails = false
  ha: any[] = []
  templates = [TMPL]
  offered: any[] = []
  client: any = {
    fetchStrict: (p: string, m = "GET", body?: string) => this.answer(p, m, body),
    fetchNode: (p: string, m = "GET", body?: string) => this.answer(p, m, body).catch(() => null),
    waitForTask: async (_n: string, upid: string) => { if (this.createFails && /vzcreate/.test(upid)) throw new Error("create task failed") },
    downloadTemplate: async () => "UPID:dl", getNodes: async () => [], createLXC: async () => { throw new Error("not used") },
    getClusterResources: async () => this.guests,
  }
  async answer(p: string, m: string, body?: string): Promise<any> {
    let r: RegExpExecArray | null
    this.reads.set(p, (this.reads.get(p) ?? 0) + 1)
    if (this.failing.has(p)) throw new Error(`fake: ${p} failed`)
    if (p === "/nodes") return [
      { node: "node-a", status: "online", maxcpu: 8, cpu: 0.1, maxmem: 32 * GB, mem: 8 * GB },
      { node: "node-b", status: "online", maxcpu: 24, cpu: 0.05, maxmem: 96 * GB, mem: 16 * GB },
      { node: "node-c", status: "offline", maxcpu: 4, maxmem: 16 * GB, mem: 0 },
    ]
    if (p === "/cluster/resources?type=vm") return this.guests
    if (p === "/cluster/status") return [{ type: "node", name: "node-a", ip: "192.0.2.10" }, { type: "node", name: "node-b", ip: "192.0.2.11" }]
    if (p === "/cluster/ha/status/current") return []
    if (p === "/cluster/ha/resources") return this.ha
    if ((r = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/config$/.exec(p))) return this.configs[Number(r[3])] ?? null
    if ((r = /^\/nodes\/([^/]+)\/storage$/.exec(p))) return [
      { storage: "pool", type: "rbd", content: "rootdir,images", active: 1, shared: 1, avail: 500 * GB, total: 1000 * GB },
      { storage: "local", type: "dir", content: "vztmpl,iso", active: 1, shared: 0, avail: 50 * GB, total: 100 * GB },
    ]
    if (/\/network$/.test(p)) return [{ iface: "vmbr0", type: "bridge", cidr: "192.0.2.10/24", gateway: "192.0.2.1" }, { iface: "eth0", type: "eth" }]
    if (/\/hardware\/pci$/.test(p)) throw new Error("HTTP 403")
    if (/^\/nodes\/[^/]+\/status$/.test(p)) return { "current-kernel": { machine: "x86_64" } }
    if (/\/content\?content=vztmpl$/.test(p)) return this.templates.map(volid => ({ volid }))
    if (/\/aplinfo$/.test(p)) return this.offered
    if ((r = /^\/nodes\/([^/]+)\/lxc$/.exec(p)) && m === "POST") {
      const b = new URLSearchParams(body)
      this.creates.push({ node: r[1], body: b })
      const vmid = Number(b.get("vmid"))
      this.guests.push({ vmid, type: "lxc", node: r[1], name: b.get("hostname"), status: "running" })
      this.configs[vmid] = { description: b.get("description"), net0: b.get("net0") }
      const ip = /ip=([\d.]+)/.exec(b.get("net0") ?? "")?.[1] ?? "192.0.2.77"
      this.live[vmid] = [{ name: "eth0", inet: `${ip}/24` }]
      return `UPID:${r[1]}:0:0:0:vzcreate:${vmid}:t@pve:`
    }
    if ((r = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/(interfaces|agent\/network-get-interfaces)$/.exec(p))) return this.live[Number(r[3])] ?? null
    if ((r = /^\/nodes\/([^/]+)\/lxc\/(\d+)\/status\/current$/.exec(p))) return { status: "running" }
    if ((r = /^\/nodes\/([^/]+)\/lxc\/(\d+)\/status\/stop$/.exec(p))) { this.stops.push(r[2]); return "UPID:stop" }
    if ((r = /^\/nodes\/([^/]+)\/lxc\/(\d+)\?purge=1/.exec(p)) && m === "DELETE") {
      this.deletes.push(r[2]); this.deletePaths.push(p); this.guests = this.guests.filter(g => g.vmid !== Number(r![2])); return "UPID:del"
    }
    throw new Error(`fake: unexpected ${m} ${p}`)
  }
}

export function deps(f: FakePve, over: Partial<WizardDeps> = {}): Partial<WizardDeps> {
  let rule: any = { kind: "next-free" }
  return {
    client: f.client, credential: async () => ({ id: "login" }) as any, wait: async () => {}, probe: async () => 200,
    exec: async () => ({ code: 0, output: "", timedOut: false }) as any,
    vaultOpen: async () => true, saveSecrets: async () => {}, readSecrets: async () => ({}), deleteSecrets: async () => {},
    ping: async () => false, readRule: async () => rule, saveRule: async r => { rule = r }, now: Date.now,
    ...over,
  }
}

export const INPUT = (o: Partial<WizardInput> = {}): WizardInput => ({
  recipeId: "uptime-kuma", node: "node-a", vmid: 102, hostname: "uptime-kuma",
  cores: 1, memoryMb: 512, swapMb: 512, diskGb: 8, storage: "pool", bridge: "vmbr0",
  ip: "192.0.2.50/24", gateway: "192.0.2.1", dns: "192.0.2.53", ...o,
})

export async function settled(id: string) {
  for (let i = 0; i < 400 && getInstallJob(id)!.status === "running"; i++) await new Promise(r => setTimeout(r, 5))
  return getInstallJob(id)!
}

