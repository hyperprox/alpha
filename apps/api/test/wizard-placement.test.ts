// The wizard's placement rules: which node, which template, whether an ID or address is free.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chooseNode, pickTemplate, pickDownloadable, assertVmidFree, parseCidr, sameSubnet,
  configAddresses, findIpUser, bridgeGateway,
} from "../src/lib/wizard-placement"

const GB = 1024 ** 3
const nodes = [
  { node: "alpha", status: "online",  maxmem: 16 * GB, mem: 2 * GB },
  { node: "beta",  status: "online",  maxmem: 16 * GB, mem: 14 * GB },
  { node: "gamma", status: "offline", maxmem: 64 * GB, mem: 0 },
]

test("no node named: the online node with the most free memory", () => {
  assert.equal(chooseNode(nodes, "", 512), "alpha")
})

test("a named node is honoured even when another has more room", () => {
  assert.equal(chooseNode([nodes[0], { ...nodes[1], mem: 4 * GB }], "beta", 512), "beta")
})

test("a named node must exist, be online and have the memory", () => {
  assert.throws(() => chooseNode(nodes, "delta", 512), /not in this cluster/)
  assert.throws(() => chooseNode(nodes, "gamma", 512), /not online/)
  assert.throws(() => chooseNode(nodes, "beta", 4096), /less than the 4096 MB/)
})

test("template: newest Debian standard wins, then older Debian, then Ubuntu, else none", () => {
  const t = (n: string) => `store:vztmpl/${n}.tar.zst`
  assert.equal(
    pickTemplate([t("debian-12-standard_12.7-1_amd64"), t("debian-13-standard_13.1-2_amd64"), t("ubuntu-22.04-standard_22.04-1_amd64")]),
    t("debian-13-standard_13.1-2_amd64"))
  assert.equal(pickTemplate([t("debian-12-standard_12.2-1_amd64"), t("debian-12-standard_12.7-1_amd64")]), t("debian-12-standard_12.7-1_amd64"))
  assert.equal(pickTemplate([t("ubuntu-24.04-standard_24.04-2_amd64")]), t("ubuntu-24.04-standard_24.04-2_amd64"))
  assert.equal(pickTemplate([t("alpine-3.20-default_20240908_amd64")]), "")
})

test("download candidate: the newest Debian standard template on offer", () => {
  assert.equal(pickDownloadable([
    { template: "debian-12-standard_12.7-1_amd64.tar.zst" },
    { template: "debian-13-standard_13.1-2_amd64.tar.zst" },
    { template: "turnkey-core_18.1-1_amd64.tar.gz" },
  ]), "debian-13-standard_13.1-2_amd64.tar.zst")
})

test("vmid: must be in range and not already taken", () => {
  assert.doesNotThrow(() => assertVmidFree([{ vmid: 100 }], 250))
  assert.throws(() => assertVmidFree([{ vmid: 250 }], 250), /already used/)
  assert.throws(() => assertVmidFree([], 99), /not valid/)
  assert.throws(() => assertVmidFree([], 1.5), /not valid/)
})

test("CIDR parsing rejects what is not an IPv4 address with a prefix", () => {
  assert.deepEqual(parseCidr("10.0.0.5/24"), { ip: "10.0.0.5", prefix: 24 })
  for (const bad of ["10.0.0.5", "10.0.0.300/24", "10.0.0.5/0", "10.0.0.5/33", "dhcp", ""]) {
    assert.equal(parseCidr(bad), null, bad)
  }
})

test("subnet check", () => {
  assert.equal(sameSubnet("10.0.0.5", "10.0.0.1", 24), true)
  assert.equal(sameSubnet("10.0.1.5", "10.0.0.1", 24), false)
  assert.equal(sameSubnet("10.0.1.5", "10.0.0.1", 16), true)
})

test("an address is found in LXC netN and cloud-init ipconfigN, not matched by prefix", () => {
  const guests = [
    { vmid: 101, config: { net0: "name=eth0,bridge=vmbr0,ip=10.0.0.50/24,gw=10.0.0.1" } },
    { vmid: 102, config: { ipconfig0: "ip=10.0.0.60/24,gw=10.0.0.1" } },
    { vmid: 103, config: { net0: "name=eth0,bridge=vmbr0,ip=dhcp" } },
    { vmid: 104, config: null },
  ]
  assert.deepEqual(configAddresses(guests[0].config), ["10.0.0.50"])
  assert.equal(findIpUser(guests, "10.0.0.50"), 101)
  assert.equal(findIpUser(guests, "10.0.0.60"), 102)
  assert.equal(findIpUser(guests, "10.0.0.5"), undefined)
})

test("gateway comes from the bridge's network config only", () => {
  const net = [{ iface: "eno1", type: "eth" }, { iface: "vmbr0", type: "bridge", gateway: "10.0.0.1" }]
  assert.equal(bridgeGateway(net), "10.0.0.1")
  assert.equal(bridgeGateway([{ iface: "vmbr0", type: "bridge" }]), "")
  assert.equal(bridgeGateway(null), "")
})

test('pickTemplate skips images built for another CPU', () => {
  const v = [
    'store:vztmpl/debian-13-standard_13.6-1_arm64.tar.zst',
    'store:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst',
    'store:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
  ]
  assert.equal(pickTemplate(v), 'store:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst')
  assert.equal(pickTemplate(['store:vztmpl/debian-13-standard_13.6-1_arm64.tar.zst']), '')
})
