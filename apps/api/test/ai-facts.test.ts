// Template facts against a fake Proxmox: per-node arch, bridges, storage, templates and guest addresses.
import { test } from "node:test"
import assert from "node:assert/strict"
import { gatherTemplateFacts, gatherFacts } from "../src/lib/ai/facts"
import { isHostAddress, bridgeInfo } from "../src/lib/wizard-placement"

const GB = 1024 ** 3
function deps(over: Record<string, unknown> = {}) {
  const route = (p: string): any => {
      if (p === "/nodes") return [
        { node: "pve1", status: "online", maxcpu: 4, maxmem: 16 * GB, mem: 4 * GB },
        { node: "pve2", status: "online", maxcpu: 4, maxmem: 8 * GB, mem: 2 * GB },
        { node: "pve3", status: "offline" },
      ]
      if (p === "/cluster/nextid") return "120"
      if (p === "/nodes/pve2/aplinfo") return []
      if (p === "/nodes/pve1/status") return { "current-kernel": { machine: "x86_64" } }
      if (p === "/nodes/pve2/status") return { "current-kernel": { machine: "aarch64" } }
      if (p === "/nodes/pve1/network") return [
        { iface: "vmbr0", type: "bridge", cidr: "10.0.0.2/24", gateway: "10.0.0.1" },
        { iface: "vmbr1", type: "bridge", cidr: "10.1.0.2/16" },
        { iface: "eth0", type: "eth" },
      ]
      if (p === "/nodes/pve2/network") return [{ iface: "vmbr0", type: "bridge", cidr: "10.0.0.3/24", gateway: "10.0.0.1" }]
      if (p === "/nodes/pve1/storage") return [
        { storage: "pool", type: "rbd", content: "rootdir,images", active: 1, shared: 1, avail: 100 * GB },
        { storage: "tmpl", type: "dir", content: "vztmpl,iso", active: 1, shared: 0, avail: 10 * GB },
      ]
      if (p === "/nodes/pve2/storage") return [{ storage: "pool", type: "rbd", content: "rootdir", active: 1, shared: 1, avail: 100 * GB }]
      if (p === "/nodes/pve1/storage/tmpl/content?content=vztmpl") return [
        { volid: "tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst" },
        { volid: "tmpl:vztmpl/ubuntu-24.04-standard_24.04-2_arm64.tar.zst" },
      ]
      if (p === "/nodes/pve1/aplinfo") return [{ template: "debian-12-standard_12.7-1_amd64.tar.zst" }]
      if (p === "/cluster/resources?type=vm") return [
        { vmid: 105, node: "pve1", type: "lxc", name: "web" }, { vmid: 106, node: "pve2", type: "qemu", name: "vm" },
      ]
      if (p === "/nodes/pve1/lxc/105/config") return { net0: "name=eth0,bridge=vmbr0,ip=10.0.0.45/24,gw=10.0.0.1" }
      if (p === "/nodes/pve2/qemu/106/config") return { ipconfig0: "ip=dhcp" }
      return null
  }
  // Like the real client: fetchNode resolves null on a failed read; fetchStrict rejects.
  const pve: any = {
    fetchNode: async (p: string) => route(p),
    fetchStrict: async (p: string) => {
      const v = route(p)
      if (v == null) throw new Error("Proxmox GET " + p + ": HTTP 500")
      return v
    },
  }
  return { pve, zones: async () => ["example.com"], proxyHosts: async () => ["a.example.com"],
           hasReverseProxy: async () => true, hasLogin: async (n: string) => n === "pve1",
           records: async (z: string) => (z === "example.com" ? ["@", "www"] : []), ...over } as any
}

test("node arch comes from the running kernel", async () => {
  const f = await gatherTemplateFacts(deps())
  assert.equal(f.nodes.find(n => n.node === "pve1")!.arch, "amd64")
  assert.equal(f.nodes.find(n => n.node === "pve2")!.arch, "arm64")
  assert.equal(f.nodes.find(n => n.node === "pve3")!.online, false)
  assert.equal(f.nodes.find(n => n.node === "pve1")!.hasLogin, true)
})

test("bridges carry gateway and prefix; a bridge with no gateway is kept with gateway ''", async () => {
  const f = await gatherTemplateFacts(deps())
  assert.deepEqual(f.nodes.find(n => n.node === "pve1")!.bridges, [
    { iface: "vmbr0", gateway: "10.0.0.1", prefix: 24 }, { iface: "vmbr1", gateway: "", prefix: 16 },
  ])
})

test("storage is per node, with content and free space", async () => {
  const f = await gatherTemplateFacts(deps())
  const pool = f.storages.filter(s => s.storage === "pool")
  assert.deepEqual(pool.map(s => s.node), ["pve1", "pve2"])
  assert.deepEqual(pool[0], { storage: "pool", node: "pve1", type: "rbd", content: ["rootdir", "images"], active: true, shared: true, freeGb: 100 })
})

test("templates carry their arch (none named is amd64) and distro; downloadable likewise", async () => {
  const f = await gatherTemplateFacts(deps())
  assert.deepEqual(f.templates.map(t => [t.arch, t.distro]), [["amd64", "debian"], ["arm64", "ubuntu"]])
  assert.deepEqual(f.downloadable, [{ node: "pve1", name: "debian-12-standard_12.7-1_amd64.tar.zst", arch: "amd64", distro: "debian" }])
})

test("guest addresses come from each guest's config", async () => {
  const f = await gatherTemplateFacts(deps())
  assert.deepEqual(f.guests.find(g => g.vmid === 105)!.addresses, ["10.0.0.45"])
  assert.deepEqual(f.guests.find(g => g.vmid === 106)!.addresses, [])
  assert.equal(f.nextVmid, 120)
})

test("one unreachable source empties only its own fact and is named in partial", async () => {
  const f = await gatherTemplateFacts(deps({ zones: async () => { throw new Error("dns down") } }))
  assert.deepEqual(f.zones, [])
  assert.deepEqual(f.partial, ["zones"])
  assert.equal(f.nodes.length, 3)
  assert.deepEqual(f.proxyHosts, ["a.example.com"])
})

test("bridgeInfo: missing bridge or address is null", () => {
  assert.equal(bridgeInfo([], "vmbr0"), null)
  assert.equal(bridgeInfo([{ iface: "vmbr0" }], "vmbr0"), null)
  assert.equal(bridgeInfo(null), null)
})

test("isHostAddress refuses network, broadcast and gateway", () => {
  assert.equal(isHostAddress("10.0.0.0", "10.0.0.1", 24), false)
  assert.equal(isHostAddress("10.0.0.255", "10.0.0.1", 24), false)
  assert.equal(isHostAddress("10.0.0.1", "10.0.0.1", 24), false)
  assert.equal(isHostAddress("10.0.0.37", "10.0.0.1", 24), true)
  assert.equal(isHostAddress("10.0.1.37", "10.0.0.1", 24), false)
})

// fetchNode never rejects, so a source read through it can never be reported failed. These return null the way it does.
function nullFor(...paths: string[]) {
  const d = deps(); const full = d.pve.fetchStrict
  d.pve.fetchStrict = async (p: string) => {
    if (paths.includes(p)) return null            // a 2xx with no data, as well as a rejection, is a failed read
    return full(p)
  }
  return d
}
test("template facts: every source that reads null or throws is named in partial", async () => {
  const f = await gatherTemplateFacts(Object.assign(nullFor(
    "/cluster/resources?type=vm", "/nodes/pve1/lxc/105/config", "/nodes/pve1/aplinfo", "/nodes/pve2/network", "/nodes/pve1/storage/tmpl/content?content=vztmpl"),
    { hasLogin: async (n: string) => { if (n === "pve2") throw new Error("vault locked"); return true } }))
  for (const want of ["resources", "aplinfo:pve1", "network:pve2", "login:pve2", "templates:pve1/tmpl"])
    assert.ok(f.partial.includes(want), want + " in " + f.partial.join())
  const g = await gatherTemplateFacts(Object.assign(nullFor("/nodes/pve1/lxc/105/config")))
  assert.deepEqual(g.partial, ["config:105"])
  const n = await gatherTemplateFacts(nullFor("/nodes"))
  assert.ok(n.partial.includes("nodes"))
})

test("per-guest config reads run at most 8 at a time", async () => {
  const d = deps(); const full = d.pve.fetchStrict
  let live = 0, peak = 0
  d.pve.fetchStrict = async (p: string) => {
    if (p === "/cluster/resources?type=vm") return Array.from({ length: 30 }, (_, i) => ({ vmid: 200 + i, node: "pve1", type: "lxc", name: "g" + i }))
    if (/\/lxc\/2\d\d\/config$/.test(p)) { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return {} }
    return full(p)
  }
  const f = await gatherTemplateFacts(d)
  assert.equal(f.guests.length, 30)
  assert.ok(peak <= 8 && peak > 1, "peak " + peak)
})

test("template arch: only known tokens count; an unknown token is amd64; aarch64 is arm64", async () => {
  const d = deps(); const full = d.pve.fetchStrict
  d.pve.fetchStrict = async (p: string) => p === "/nodes/pve1/storage/tmpl/content?content=vztmpl"
    ? [{ volid: "tmpl:vztmpl/debian-13-standard_13.1-2_weird.tar.zst" }, { volid: "tmpl:vztmpl/debian-12-standard_12.7-1_aarch64.tar.zst" }]
    : full(p)
  const f = await gatherTemplateFacts(d)
  assert.deepEqual(f.templates.map(t => t.arch), ["amd64", "arm64"])
})

test("legacy gatherFacts: a source that reads null or throws lands in partial", async () => {
  const run = async (nul: string[], over: Record<string, unknown> = {}) => {
    const d = deps(); const full = d.pve.fetchStrict
    d.pve.fetchStrict = async (p: string) => nul.includes(p) ? null : full(p)
    return gatherFacts({ pve: d.pve, zones: d.zones, proxyHosts: d.proxyHosts, ...over } as any)
  }
  assert.deepEqual((await run([])).partial, [])
  assert.ok((await run(["/cluster/resources?type=vm"])).partial.includes("resources"))
  assert.ok((await run(["/nodes"])).partial.includes("nodes"))
  assert.ok((await run(["/nodes/pve1/storage"])).partial.includes("storage"))
  assert.ok((await run(["/cluster/nextid"])).partial.includes("nextid"))
  assert.ok((await run([], { zones: async () => { throw new Error("dns") } })).partial.includes("dns"))
})

test("DNS record names are read per managed zone; a zone that cannot be listed is named in partial", async () => {
  const f = await gatherTemplateFacts(deps({ zones: async () => ["example.com", "example.net"] }))
  assert.deepEqual(f.records["example.com"], ["@", "www"])
  assert.deepEqual(f.records["example.net"], [])
  const g = await gatherTemplateFacts(deps({ zones: async () => ["example.com", "example.net"],
    records: async (z: string) => { if (z === "example.net") throw new Error("dns"); return ["@"] } }))
  assert.deepEqual(g.partial, ["records:example.net"])
  assert.equal(g.records["example.net"], undefined)
})

test("a reverse-proxy check that fails is a failed source, not \"none configured\"", async () => {
  const f = await gatherTemplateFacts(deps({ hasReverseProxy: async () => { throw new Error("vault") } }))
  assert.equal(f.hasReverseProxy, false)
  assert.deepEqual(f.partial, ["proxy"])
})
