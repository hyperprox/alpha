// Where the install wizard puts a container: node scoring, container IDs and the ID pattern, address collisions.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  scoreNodes, recommend, rootStorages, nextFreeVmid, patternProblem, nodeDigit, ipLastDigits, deriveVmid,
  reverseVmid, withOctetDigits, ipConflicts, liveAddresses, configUsesGpu, pciHasDiscreteGpu,
  type PlacementNode, type PlacementStorage,
} from "../src/lib/wizard-placement"

const node = (o: Partial<PlacementNode> & { node: string }): PlacementNode => ({
  online: true, cores: 4, cpuLoad: 0.2, memTotalMb: 16384, memUsedMb: 4096, runningGuests: 3, hasGpu: false, hasLogin: true, ...o,
})
const store = (o: Partial<PlacementStorage> & { storage: string; node: string }): PlacementStorage => ({
  type: "lvmthin", content: ["rootdir", "images"], active: true, shared: false, freeGb: 200, ...o,
})
const SMALL = { cores: 1, memoryMb: 512, diskGb: 8 }

// node-a: roomy, shared storage. node-b: GPU node with even more RAM. node-c: short on RAM.
// node-d: offline. node-e: local storage only.
const NODES = [
  node({ node: "node-a", memTotalMb: 32768, memUsedMb: 8192 }),
  node({ node: "node-b", memTotalMb: 98304, memUsedMb: 20480, cores: 24, hasGpu: true }),
  node({ node: "node-c", memUsedMb: 16000 }),
  node({ node: "node-d", online: false, memUsedMb: 0 }),
  node({ node: "node-e", memTotalMb: 32768, memUsedMb: 8192 }),
]
const SHARED = (n: string) => store({ storage: "pool", node: n, type: "rbd", shared: true, freeGb: 900 })
const STORES = [
  SHARED("node-a"), SHARED("node-b"), SHARED("node-c"), SHARED("node-d"),
  store({ storage: "local-lvm", node: "node-a" }), store({ storage: "local-lvm", node: "node-e", freeGb: 900 }),
]

test("placement: offline and RAM-short nodes are ineligible, each with its reason", () => {
  const v = scoreNodes(NODES, STORES, SMALL)
  const d = v.find(x => x.node === "node-d")!, c = v.find(x => x.node === "node-c")!
  assert.equal(d.eligible, false); assert.deepEqual(d.why, ["offline"])
  assert.equal(c.eligible, false); assert.match(c.why.join(" "), /not enough RAM: 384 MB free, this needs 512 MB/)
  assert.deepEqual(v.slice(-2).map(x => x.eligible), [false, false], "ineligible nodes sort last")
})

test("placement: a GPU node is passed over for an app that does not need it, even with the most RAM", () => {
  const v = scoreNodes(NODES, STORES, SMALL)
  assert.equal(v[0].node, "node-a")
  const b = v.find(x => x.node === "node-b")!
  assert.equal(b.eligible, true)
  assert.match(b.notes.join(" "), /GPU this app does not need/)
})

test("placement: an app that needs a GPU goes to the GPU node and nowhere else", () => {
  const v = scoreNodes(NODES, STORES, { ...SMALL, needsGpu: true })
  assert.equal(v[0].node, "node-b")
  assert.deepEqual(v.filter(x => x.eligible).map(x => x.node), ["node-b"])
  assert.match(v.find(x => x.node === "node-a")!.why.join(" "), /no GPU/)
})

test("placement: shared storage beats local storage on otherwise identical nodes", () => {
  const v = scoreNodes(NODES, STORES, SMALL)
  const a = v.find(x => x.node === "node-a")!, e = v.find(x => x.node === "node-e")!
  assert.ok(a.score > e.score, `${a.score} > ${e.score}`)
  assert.equal(a.storage!.storage, "pool", "the shared pool is chosen over local-lvm on the same node")
  assert.match(e.notes.join(" "), /local storage only/)
})

test("placement: rootStorages prefers shared, then block, then room; file shares and non-rootdir stores last or out", () => {
  const s = [
    store({ storage: "nas", node: "n", type: "cifs", shared: true, freeGb: 5000 }),
    store({ storage: "iso", node: "n", type: "dir", content: ["iso"], freeGb: 9000 }),
    store({ storage: "local-lvm", node: "n", freeGb: 100 }),
    store({ storage: "pool", node: "n", type: "rbd", shared: true, freeGb: 50 }),
    store({ storage: "nfs", node: "n", type: "nfs", shared: true, freeGb: 50 }),
  ]
  assert.deepEqual(rootStorages(s, "n").map(x => x.storage), ["pool", "nfs", "local-lvm", "nas"])
})

test("placement: not enough disk anywhere on a node makes it ineligible; a chosen storage is honoured", () => {
  const v = scoreNodes([node({ node: "node-a" })], [store({ storage: "local-lvm", node: "node-a", freeGb: 9 })], SMALL)
  assert.equal(v[0].eligible, false)
  assert.match(v[0].why.join(" "), /not enough disk: no container storage has the 10 GB free/)
  const w = scoreNodes(NODES, STORES, { ...SMALL, storage: "local-lvm" })
  assert.equal(w[0].node, "node-e")
  assert.equal(w.find(x => x.node === "node-b")!.eligible, false)
})

test("placement: too many cores, and a node with no login, are ineligible", () => {
  const v = scoreNodes([node({ node: "node-a", hasLogin: false })], [SHARED("node-a")], { ...SMALL, cores: 8 })
  assert.match(v[0].why.join(" "), /no node login/)
  assert.match(v[0].why.join(" "), /has 4 cores, this asks for 8/)
})

test("placement: dropping below 20% RAM free costs heavily; many guests cost a little", () => {
  const tight = node({ node: "node-a", memUsedMb: 12800 })
  const v = scoreNodes([tight], [SHARED("node-a")], { ...SMALL, memoryMb: 1024 })
  assert.equal(v[0].eligible, true)
  assert.match(v[0].notes.join(" "), /less than 20% of its RAM free/)
  const quiet = scoreNodes([node({ node: "x", runningGuests: 0 })], [SHARED("x")], SMALL)[0].score
  const busy = scoreNodes([node({ node: "x", runningGuests: 30 })], [SHARED("x")], SMALL)[0].score
  assert.equal(Math.round((quiet - busy) * 10) / 10, 10, "the guest penalty is capped at 10")
})

test("recommend: the top pick and a one-line reason", () => {
  const r = recommend(scoreNodes(NODES, STORES, SMALL), NODES)!
  assert.equal(r.node, "node-a")
  assert.equal(r.storage, "pool")
  assert.match(r.reason, /^node-a: RAM free after install \(23\.5 GB\), shared storage \(pool\)/)
  assert.match(r.reason, /keeps the GPU node free/)
  assert.equal(recommend(scoreNodes([NODES[3]], STORES, SMALL), NODES), null)
})

test("GPU detection: passthrough in a guest config, or an NVIDIA display controller on the bus; /dev/dri is not one", () => {
  assert.equal(configUsesGpu({ hostpci0: "0000:0a:00,pcie=1" }), true)
  assert.equal(configUsesGpu({ dev0: "/dev/nvidia0" }), true)
  assert.equal(configUsesGpu({ lxc: [["lxc.cgroup2.devices.allow", "c 195:* rwm"]] }), true)
  assert.equal(configUsesGpu({ dev0: "/dev/dri/renderD128" }), false)
  assert.equal(configUsesGpu(null), false)
  assert.equal(pciHasDiscreteGpu([{ class: "0x030000", vendor: "0x10de" }]), true)
  assert.equal(pciHasDiscreteGpu([{ class: "0x030000", vendor: "0x8086" }, { class: "0x020000", vendor: "0x10de" }]), false)
  assert.equal(pciHasDiscreteGpu(null), false)
})

// ── Container IDs ───────────────────────────────────────────────────────────

test("next free ID skips every CT and VM ID, and never goes below 100", () => {
  assert.equal(nextFreeVmid([]), 100)
  assert.equal(nextFreeVmid([100, 101, 103]), 102)
  assert.equal(nextFreeVmid([100, 101], 50), 102)
  assert.equal(nextFreeVmid([500, 501], 500), 502)
})

test("pattern: only the three tokens and digits, each token once", () => {
  assert.equal(patternProblem("{node_digit}{ip_last2}"), null)
  assert.equal(patternProblem("9{ip_last3}"), null)
  assert.match(patternProblem("")!, /empty/)
  assert.match(patternProblem("123")!, /at least one/)
  assert.match(patternProblem("{node_digit}-{ip_last2}")!, /only digits/)
  assert.match(patternProblem("{vmid}{ip_last2}")!, /only digits/)
  assert.match(patternProblem("{ip_last2}{ip_last3}")!, /not both/)
  assert.match(patternProblem("{node_digit}{node_digit}{ip_last2}")!, /once/)
})

test("pattern: node digit is the trailing number, IP digits are the final octet's, zero-padded", () => {
  assert.equal(nodeDigit("node-3"), "3")
  assert.equal(nodeDigit("pve12"), "12")
  assert.equal(nodeDigit("node-a"), null)
  assert.equal(ipLastDigits("192.0.2.242", 2), "42")
  assert.equal(ipLastDigits("192.0.2.5/24", 2), "05")
  assert.equal(ipLastDigits("192.0.2.5", 3), "005")
})

test("pattern: node and address give the ID, and say why when they cannot", () => {
  assert.deepEqual(deriveVmid("{node_digit}{ip_last2}", { node: "node-7", ip: "192.0.2.242" }), { vmid: 742 })
  assert.deepEqual(deriveVmid("{node_digit}{ip_last3}", { node: "node-1", ip: "192.0.2.5" }), { vmid: 1005 })
  assert.match((deriveVmid("{node_digit}{ip_last2}", { node: "node-a", ip: "192.0.2.42" }) as any).error, /no trailing number/)
  assert.match((deriveVmid("{node_digit}{ip_last2}", { node: "node-7" }) as any).error, /static address/)
  assert.match((deriveVmid("{ip_last2}", { node: "node-7", ip: "192.0.2.42" }) as any).error, /not a legal ID/)
})

test("pattern: the reverse, an ID gives the node and the address digits", () => {
  const nodes = ["node-1", "node-2", "node-7"]
  assert.deepEqual(reverseVmid("{node_digit}{ip_last2}", 742, nodes), { node: "node-7", octetDigits: "42", width: 2 })
  assert.match((reverseVmid("{node_digit}{ip_last2}", 942, nodes) as any).error, /does not fit/)
  assert.deepEqual(reverseVmid("9{ip_last3}", 9010, nodes), { node: undefined, octetDigits: "010", width: 3 })
  assert.equal(withOctetDigits("192.0.2.205", "42", 2), "192.0.2.242")
  assert.equal(withOctetDigits("192.0.2.1", "42", 2), "192.0.2.42")
  assert.equal(withOctetDigits("192.0.2.1", "010", 3), "192.0.2.10")
  assert.equal(withOctetDigits("192.0.2.250", "60", 2), null, "260 is not an octet")
})

test("pattern: a derived ID that is taken is caught by the same free check as any other", () => {
  const used = [742, 100]
  const d = deriveVmid("{node_digit}{ip_last2}", { node: "node-7", ip: "192.0.2.242" }) as { vmid: number }
  assert.ok(used.includes(d.vmid))
  assert.equal(nextFreeVmid(used, d.vmid), 743, "the next free above it is offered instead")
})

// ── Address collisions ──────────────────────────────────────────────────────

test("IP collision: a guest config, a running guest's live address, or a node's own address", () => {
  const configs = [
    { vmid: 101, name: "web", config: { net0: "name=eth0,bridge=vmbr0,ip=192.0.2.21/24,gw=192.0.2.1" } },
    { vmid: 102, name: "vm", config: { ipconfig0: "ip=192.0.2.22/24" } },
    { vmid: 103, name: "dhcp", config: { net0: "name=eth0,bridge=vmbr0,ip=dhcp" } },
  ]
  const live = [{ vmid: 103, name: "dhcp", addresses: ["192.0.2.23"] }]
  const nodes = [{ node: "node-a", ip: "192.0.2.10" }]
  assert.deepEqual(ipConflicts("192.0.2.21", { configs, live, nodes }).map(s => [s.vmid, s.source]), [[101, "config"]])
  assert.deepEqual(ipConflicts("192.0.2.22", { configs, live, nodes }).map(s => [s.vmid, s.source]), [[102, "config"]])
  assert.deepEqual(ipConflicts("192.0.2.23", { configs, live, nodes }).map(s => [s.vmid, s.source]), [[103, "live"]])
  assert.deepEqual(ipConflicts("192.0.2.10", { configs, live, nodes }).map(s => [s.node, s.source]), [["node-a", "node"]])
  assert.deepEqual(ipConflicts("192.0.2.99", { configs, live, nodes }), [])
  assert.deepEqual(ipConflicts("192.0.2.2", { configs, live, nodes }), [], "a prefix of a used address is not a match")
})

test("live addresses read both the LXC interfaces answer and the QEMU agent answer, IPv4 only, no loopback", () => {
  assert.deepEqual(liveAddresses([{ name: "lo", inet: "127.0.0.1/8" }, { name: "eth0", inet: "192.0.2.30/24", inet6: "fe80::1/64" }]), ["192.0.2.30"])
  assert.deepEqual(liveAddresses({ result: [{ name: "ens18", "ip-addresses": [
    { "ip-address-type": "ipv4", "ip-address": "192.0.2.31" }, { "ip-address-type": "ipv6", "ip-address": "2001:db8::1" }] }] }), ["192.0.2.31"])
  assert.deepEqual(liveAddresses(null), [])
})
