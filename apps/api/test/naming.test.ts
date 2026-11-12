// Settings → Naming & addresses: validation, the node + address scheme, convention detection, the next-free
// picker, the DHCP policy, overrides that need a typed confirmation, and the reconfirm on save.
import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import {
  validateNaming, defaultNodeIndex, schemeVmid, schemeLabel, detectConvention, pickNext, managementFallback, namingPolicy,
  firstCandidate, inRange, type NamingSettings,
} from "../src/lib/naming"
import { previewInstall, applyPreview, proposeFor, readCluster, type WizardDeps } from "../src/lib/catalogue-installer"
import { buildCatalogueRoutes } from "../src/routes/catalogue"
import { needsReconfirm, requiredRole } from "../src/lib/roles"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const GOOD = {
  subnet: "192.0.2.0/24", rangeStart: "192.0.2.200", rangeEnd: "192.0.2.254", gateway: "192.0.2.1",
  dns: ["192.0.2.53"], bridge: "vmbr0", idScheme: "node-ip", nodeIndex: { pve1: 1, pve3: 3 }, dhcp: "never",
}
const settings = (o: Partial<NamingSettings> = {}): NamingSettings => ({ ...(validateNaming(GOOD).settings as NamingSettings), ...o })

// ── Validation ──────────────────────────────────────────────────────────────

test("settings: a good set is accepted and the subnet is normalised to its network address", () => {
  const r = validateNaming({ ...GOOD, subnet: "192.0.2.77/24", vlan: "20", dns: "192.0.2.53, 192.0.2.54" })
  assert.deepEqual(r.errors, [])
  assert.equal(r.settings!.subnet, "192.0.2.0/24")
  assert.equal(r.settings!.vlan, 20)
  assert.deepEqual(r.settings!.dns, ["192.0.2.53", "192.0.2.54"])
})

test("settings: the range must sit inside the subnet, in order, off the network and broadcast addresses", () => {
  const no = (o: Record<string, unknown>, re: RegExp) => {
    const r = validateNaming({ ...GOOD, ...o })
    assert.equal(r.settings, undefined)
    assert.match(r.errors.join(" | "), re)
  }
  no({ rangeStart: "198.51.100.200" }, /198\.51\.100\.200 is not a usable address in 192\.0\.2\.0\/24/)
  no({ rangeEnd: "192.0.2.255" }, /192\.0\.2\.255 is not a usable address/)
  no({ rangeStart: "192.0.2.250", rangeEnd: "192.0.2.210" }, /starts after it ends/)
  no({ subnet: "192.0.2.0" }, /address and prefix/)
  no({ subnet: "10.0.0.0/4" }, /between \/8 and \/30/)
})

test("settings: the gateway must be inside the subnet; VLAN, DNS, bridge and policy are checked", () => {
  const no = (o: Record<string, unknown>, re: RegExp) => assert.match(validateNaming({ ...GOOD, ...o }).errors.join(" | "), re)
  no({ gateway: "198.51.100.1" }, /gateway 198\.51\.100\.1 is not inside 192\.0\.2\.0\/24/)
  no({ gateway: "nope" }, /gateway is not an IPv4/)
  no({ vlan: 5000 }, /VLAN tag/)
  no({ dns: ["8.8.8"] }, /DNS server/)
  no({ bridge: "vm br0" }, /bridge name/)
  no({ dhcp: "sometimes" }, /DHCP policy/)
})

test("settings: node + address needs a range inside one block of a hundred and unique node indices", () => {
  assert.match(validateNaming({ ...GOOD, rangeStart: "192.0.2.150" }).errors.join(" "), /one block of a hundred/)
  assert.match(validateNaming({ ...GOOD, nodeIndex: { pve1: 3, pve3: 3 } }).errors.join(" "), /both have index 3/)
  assert.match(validateNaming({ ...GOOD, nodeIndex: {} }).errors.join(" "), /needs an index for at least one node/)
  // The free-ID scheme has no such limit.
  assert.deepEqual(validateNaming({ ...GOOD, idScheme: "next-free", rangeStart: "192.0.2.150", nodeIndex: {} }).errors, [])
})

// ── The scheme ──────────────────────────────────────────────────────────────

test("scheme: ID is the node's index then the last two digits of the address", () => {
  assert.deepEqual(defaultNodeIndex(["pve1", "pve3", "backup", "lab3"]), { lab3: 3, pve1: 1 })
  const s = settings()
  assert.deepEqual(schemeVmid(s, "pve3", "192.0.2.242/24"), { vmid: 342 })
  assert.deepEqual(schemeVmid(s, "pve1", "192.0.2.205"), { vmid: 105 })
  assert.match((schemeVmid(s, "other", "192.0.2.205") as any).error, /no index/)
  assert.equal(schemeLabel(s, "pve3"), "CT 3xx ↔ 192.0.2.2xx")
  assert.ok(inRange("192.0.2.254", s) && !inRange("192.0.2.199", s) && !inRange("198.51.100.210", s))
})

// ── Detection ───────────────────────────────────────────────────────────────

const net = (ip: string, gw = "192.0.2.1") => ({ net0: `name=eth0,bridge=vmbr0,ip=${ip}/24,gw=${gw}`, nameserver: "192.0.2.53" })
const NODES = [
  { node: "pve1", address: "192.0.2.11", bridges: [{ iface: "vmbr0", cidr: "192.0.2.11/24", gateway: "192.0.2.1" }] },
  { node: "pve3", address: "192.0.2.13", bridges: [{ iface: "vmbr0", cidr: "192.0.2.13/24", gateway: "192.0.2.1" }] },
]

test("detect: a cluster numbered node + address is detected, with the settings to save", () => {
  const d = detectConvention([
    { vmid: 112, node: "pve1", config: net("192.0.2.212") },
    { vmid: 342, node: "pve3", config: net("192.0.2.242") },
    { vmid: 341, node: "pve3", config: { net0: "name=eth0,bridge=vmbr0,ip=192.0.2.241/24,gw=192.0.2.1" } },
    { vmid: 900, node: "pve3", config: { net0: "name=eth0,bridge=vmbr0,ip=dhcp" } },
  ], NODES)
  assert.equal(d.verdict, "follows")
  assert.equal(d.matching, 3); assert.equal(d.considered, 3); assert.equal(d.total, 4)
  assert.deepEqual(d.proposal, {
    subnet: "192.0.2.0/24", rangeStart: "192.0.2.200", rangeEnd: "192.0.2.254", gateway: "192.0.2.1", dns: ["192.0.2.53"],
    bridge: "vmbr0", idScheme: "node-ip", nodeIndex: { pve1: 1, pve3: 3 }, dhcp: "never",
  })
  assert.deepEqual(validateNaming(d.proposal).errors, [])
})

test("detect: a cluster numbered any other way is not", () => {
  const d = detectConvention([
    { vmid: 100, node: "pve1", config: net("192.0.2.50") },
    { vmid: 101, node: "pve3", config: net("192.0.2.51") },
    { vmid: 102, node: "pve3", config: net("192.0.2.52") },
  ], NODES)
  assert.equal(d.verdict, "none")
  assert.equal(d.matching, 0)
  assert.equal(d.proposal, undefined)
})

test("detect: mixed numbering (a minority follows) is reported as mixed, not adopted", () => {
  const d = detectConvention([
    { vmid: 342, node: "pve3", config: net("192.0.2.242") },
    { vmid: 100, node: "pve1", config: net("192.0.2.50") },
    { vmid: 101, node: "pve3", config: net("192.0.2.51") },
  ], NODES)
  assert.equal(d.verdict, "mixed")
  assert.equal(d.matching, 1); assert.equal(d.considered, 3)
  // Two of four is not a majority either.
  const half = detectConvention([
    { vmid: 342, node: "pve3", config: net("192.0.2.242") }, { vmid: 112, node: "pve1", config: net("192.0.2.212") },
    { vmid: 100, node: "pve1", config: net("192.0.2.50") }, { vmid: 101, node: "pve3", config: net("192.0.2.51") },
  ], NODES)
  assert.equal(half.verdict, "mixed")
})

// ── The picker ──────────────────────────────────────────────────────────────

test("picker: passes over the gateway, config and live addresses, node addresses, used IDs and anything that answers", async () => {
  const s = settings({ rangeStart: "192.0.2.200", rangeEnd: "192.0.2.210", gateway: "192.0.2.200" })
  const pinged: string[] = []
  const r = await pickNext(s, {
    node: "pve3", usedIds: [303], nextId: 100,
    taken: ["192.0.2.201", "192.0.2.202/24", "192.0.2.204"],
    ping: async ip => { pinged.push(ip); return ip === "192.0.2.205" },
  })
  assert.deepEqual(r.skipped.map(x => `${x.ip.split(".")[3]} ${x.why}`), [
    "200 the gateway", "201 in use by a guest or a node", "202 in use by a guest or a node",
    "203 ID 303 is already used", "204 in use by a guest or a node", "205 something answers on it",
  ])
  assert.deepEqual(pinged, ["192.0.2.205", "192.0.2.206"])
  assert.equal(r.pick!.ip, "192.0.2.206/24")
  assert.equal(r.pick!.vmid, 306)
  assert.equal(r.pick!.quiet, true)
  assert.equal(r.pick!.gateway, "192.0.2.200")
})

test("picker: says so when the range is full, and when the node has no index", async () => {
  const s = settings({ rangeStart: "192.0.2.200", rangeEnd: "192.0.2.201" })
  const full = await pickNext(s, { node: "pve3", usedIds: [], taken: ["192.0.2.200", "192.0.2.201"] })
  assert.equal(full.pick, undefined)
  assert.match(full.problem!, /No address is left/)
  assert.match((await pickNext(s, { node: "lab", usedIds: [], taken: [] })).problem!, /lab has no index/)
  // The free-ID scheme takes the next free ID from Proxmox's range.
  const free = firstCandidate(settings({ idScheme: "next-free" }), { node: "lab", usedIds: [100, 101], nextId: 100, taken: [] })
  assert.deepEqual(free, { ip: "192.0.2.200/24", vmid: 102 })
})

test("picker: with nothing saved, the fallback stays on the node's own management subnet", () => {
  const f = managementFallback(NODES[1])!
  assert.equal(f.subnet, "192.0.2.0/24")
  assert.equal(f.rangeStart, "192.0.2.192"); assert.equal(f.rangeEnd, "192.0.2.254")
  assert.equal(f.bridge, "vmbr0"); assert.equal(f.gateway, "192.0.2.1")
  // A node whose address is unknown, or whose bridge has no gateway, gets no fallback (DHCP, with a warning).
  assert.equal(managementFallback({ node: "x" }), null)
  assert.equal(managementFallback({ node: "x", address: "192.0.2.9", bridges: [{ iface: "vmbr0", cidr: "192.0.2.9/24" }] }), null)
})

// ── The policy ──────────────────────────────────────────────────────────────

test("policy: DHCP is refused under never unless DHCP is typed, warned under warn, silent under allowed", () => {
  const plan = { node: "pve3", vmid: 342, ip: "dhcp" }
  const never = namingPolicy(settings(), plan)
  assert.match(never.errors.join(" "), /never allow DHCP.*Type DHCP to confirm/)
  const typed = namingPolicy(settings(), plan, "dhcp")
  assert.deepEqual(typed.errors, [])
  assert.deepEqual(typed.override, { kind: "dhcp", value: "dhcp" })
  assert.match(typed.warnings.join(" "), /audit log/)
  assert.match(namingPolicy(settings({ dhcp: "warn" }), plan).warnings.join(" "), /may come from another network/)
  assert.deepEqual(namingPolicy(settings({ dhcp: "allowed" }), plan), { errors: [], warnings: [] })
  // No settings saved: allowed, always with the warning that it may land on another network.
  const none = namingPolicy(null, plan)
  assert.deepEqual(none.errors, [])
  assert.match(none.warnings.join(" "), /bridge can carry more than one network/)
})

test("policy: an address outside the range needs the address typed; an off-scheme ID is a warning", () => {
  const out = namingPolicy(settings(), { node: "pve3", vmid: 350, ip: "192.0.2.50/24" })
  assert.match(out.errors.join(" "), /192\.0\.2\.50 is outside your range 192\.0\.2\.200–192\.0\.2\.254\. Type 192\.0\.2\.50/)
  assert.match(namingPolicy(settings(), { node: "pve3", vmid: 350, ip: "192.0.2.50/24" }, "192.0.2.51").errors.join(" "), /Type 192\.0\.2\.50/)
  const ok = namingPolicy(settings(), { node: "pve3", vmid: 350, ip: "192.0.2.50/24" }, "192.0.2.50")
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.override, { kind: "outside-range", value: "192.0.2.50" })
  const off = namingPolicy(settings(), { node: "pve3", vmid: 999, ip: "192.0.2.242/24" })
  assert.deepEqual(off.errors, [])
  assert.match(off.warnings.join(" "), /ID 999 does not follow your numbering: .* would be 342/)
})

// ── In the wizard ───────────────────────────────────────────────────────────

/** FakePve's nodes are node-a and node-b; these settings give node-a index 1. */
const fakeNaming = (o: Partial<NamingSettings> = {}): NamingSettings => ({
  subnet: "192.0.2.0/24", rangeStart: "192.0.2.100", rangeEnd: "192.0.2.120", gateway: "192.0.2.1", dns: [], bridge: "vmbr0",
  idScheme: "node-ip", nodeIndex: { "node-a": 1, "node-b": 2 }, dhcp: "never", ...o,
})
const withNaming = (f: FakePve, s: NamingSettings | null, over: Partial<WizardDeps> = {}) => {
  const audits: any[] = []
  return { audits, d: deps(f, { readNaming: async () => s, saveNaming: async () => {}, audit: async (...a: any[]) => { audits.push(a) }, ...over }) }
}

test("wizard: under never, a DHCP plan is refused until DHCP is typed, and the override is audited at apply", async () => {
  const f = new FakePve()
  const { d, audits } = withNaming(f, fakeNaming())
  const dhcp = INPUT({ ip: "dhcp", gateway: undefined, vmid: 105 })
  const refused = await previewInstall(dhcp, "a@example.com", d)
  assert.equal(refused.preview, undefined)
  assert.match(refused.errors.join(" "), /never allow DHCP/)
  const ok = await previewInstall({ ...dhcp, namingConfirm: "DHCP" }, "a@example.com", d)
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.preview!.plan.namingConfirm, "DHCP")
  assert.equal(audits.length, 0, "a preview alone is not an override")
  const job = await settled((await applyPreview(ok.preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.equal(audits.length, 1)
  assert.equal(audits[0][0], "naming.override")
  assert.equal(audits[0][1], "ct/105")
  assert.deepEqual({ kind: audits[0][2].kind, owner: audits[0][2].owner }, { kind: "dhcp", owner: "a@example.com" })
})

test("wizard: an address in the range passes and says so; outside it needs the address typed; VLAN reaches net0", async () => {
  const f = new FakePve()
  const { d } = withNaming(f, fakeNaming({ vlan: 30 }))
  const inside = await previewInstall(INPUT({ ip: "192.0.2.105/24", vmid: 105, vlan: 30 }), "a@example.com", d)
  assert.deepEqual(inside.errors, [])
  assert.ok(inside.checks.some(c => /inside your range 192\.0\.2\.100–192\.0\.2\.120/.test(c)))
  const job = await settled((await applyPreview(inside.preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.equal(f.creates[0].body.get("net0"), "name=eth0,bridge=vmbr0,ip=192.0.2.105/24,gw=192.0.2.1,firewall=1,tag=30")
  const outside = await previewInstall(INPUT({ vmid: 106, hostname: "kuma-2" }), "a@example.com", d)
  assert.match(outside.errors.join(" "), /192\.0\.2\.50 is outside your range.*Type 192\.0\.2\.50/)
  const confirmed = await previewInstall(INPUT({ vmid: 106, hostname: "kuma-2", namingConfirm: "192.0.2.50" }), "a@example.com", d)
  assert.deepEqual(confirmed.errors, [])
})

test("wizard: with nothing saved, DHCP still installs, with the warning that it may land on another network", async () => {
  const f = new FakePve()
  const { d } = withNaming(f, null)
  const r = await previewInstall(INPUT({ ip: "dhcp", gateway: undefined }), "a@example.com", d)
  assert.deepEqual(r.errors, [])
  assert.match(r.warnings.join(" "), /bridge can carry more than one network/)
})

test("propose: the saved scheme's next free ID and address, passing over a guest's and a node's address and what answers", async () => {
  const f = new FakePve()
  f.guests.push({ vmid: 150, type: "lxc", node: "node-a", name: "stopped-one", status: "stopped" })
  f.configs[150] = { net0: "name=eth0,bridge=vmbr0,ip=192.0.2.100/24" }
  const view = await readCluster(f.client, async () => true)
  const pings: string[] = []
  const p = await proposeFor("node-a", view, { seen: [{ vmid: 100, name: "web", addresses: ["192.0.2.101"] }], unknown: [] },
    fakeNaming(), async (_n, ip) => { pings.push(ip); return ip === "192.0.2.102" })
  assert.equal(p.source, "settings")
  assert.equal(p.ip, "192.0.2.103/24")
  assert.equal(p.vmid, 103)
  assert.equal(p.label, "CT 1xx ↔ 192.0.2.1xx (your numbering)")
  assert.deepEqual(pings, ["192.0.2.102", "192.0.2.103"])
  assert.deepEqual(p.warnings, [])
})

test("propose: no settings and no convention: a free address on the node's management subnet, never DHCP silently", async () => {
  const f = new FakePve()
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => "a@example.com", wizard: withNaming(f, null).d }))
  const r = await a.inject({ method: "POST", url: "/wizard/propose", payload: { node: "node-a" } })
  assert.equal(r.statusCode, 200, r.body)
  const p = r.json().data
  assert.equal(p.source, "subnet")
  assert.equal(p.ip, "192.0.2.192/24")
  assert.equal(p.gateway, "192.0.2.1")
  assert.equal(p.vmid, 102)
  // A node whose address cannot be read: DHCP, and the proposal says why.
  f.failing.add("/cluster/status")
  const dh = (await a.inject({ method: "POST", url: "/wizard/propose", payload: { node: "node-a" } })).json().data
  assert.equal(dh.ip, "dhcp")
  assert.match(dh.warnings.join(" "), /DHCP may hand out an address on another network/)
})

// ── Saving ──────────────────────────────────────────────────────────────────

test("save: admin only, needs the master password again, refuses bad settings and records who saved", async () => {
  assert.equal(requiredRole("PUT", "/api/catalogue/wizard/naming"), "admin")
  assert.equal(requiredRole("GET", "/api/catalogue/wizard/naming"), "admin")
  assert.equal(requiredRole("POST", "/api/catalogue/wizard/naming/detect"), "admin")
  assert.equal(needsReconfirm("PUT", "/api/catalogue/wizard/naming"), true)
  assert.equal(needsReconfirm("GET", "/api/catalogue/wizard/naming"), false)
  assert.equal(needsReconfirm("POST", "/api/catalogue/wizard/naming/detect"), false)

  let saved: NamingSettings | null = null
  const audits: any[] = []
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => "a@example.com", wizard: deps(new FakePve(), {
    readNaming: async () => saved, saveNaming: async s => { saved = s }, audit: async (...x: any[]) => { audits.push(x) },
  }) }))
  const bad = await a.inject({ method: "PUT", url: "/wizard/naming", payload: { settings: { ...GOOD, gateway: "198.51.100.1" } } })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().problems.join(" "), /not inside/)
  assert.equal(saved, null)
  const ok = await a.inject({ method: "PUT", url: "/wizard/naming", payload: { settings: GOOD } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(saved!.updatedBy, "a@example.com")
  assert.equal(audits[0][0], "naming.saved")
  assert.equal((await a.inject({ method: "GET", url: "/wizard/naming" })).json().data.settings.rangeStart, "192.0.2.200")
})

test("detect route: fills the settings from the cluster's guests and counts who follows", async () => {
  const f = new FakePve()
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => "a@example.com", wizard: withNaming(f, null).d }))
  const r = (await a.inject({ method: "POST", url: "/wizard/naming/detect" })).json().data
  assert.equal(r.verdict, "none")
  assert.equal(r.considered, 1)
  assert.equal(r.total, 2)
  assert.deepEqual(r.nodes.map((n: any) => n.node), ["node-a", "node-b", "node-c"])
})
