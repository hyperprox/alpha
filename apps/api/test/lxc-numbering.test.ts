// +LXC form: a cluster whose guests are numbered <node#><two digits> <-> .2<digits> is offered that ID and address,
// through the same route the form calls (POST /wizard/propose), unless saved settings say otherwise.
import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { buildCatalogueRoutes } from "../src/routes/catalogue"
import { FakePve, deps, GB } from "./fakes/catalogue-pve"

/** Nodes pve1/pve3 on 192.0.2.0/24; guests follow node + address numbering. */
class ConventionPve extends FakePve {
  constructor() {
    super()
    this.guests = [
      { vmid: 112, type: "lxc", node: "pve1", name: "a", status: "running" },
      { vmid: 130, type: "lxc", node: "pve1", name: "b", status: "running" },
      { vmid: 342, type: "lxc", node: "pve3", name: "c", status: "running" },
      { vmid: 341, type: "qemu", node: "pve3", name: "d", status: "stopped" },
    ]
    const cfg = (ip: string) => ({ net0: `name=eth0,bridge=vmbr0,ip=${ip}/24,gw=192.0.2.1`, nameserver: "192.0.2.53" })
    this.configs = { 112: cfg("192.0.2.212"), 130: cfg("192.0.2.230"), 342: cfg("192.0.2.242"), 341: cfg("192.0.2.241") }
    this.live = { 112: [{ name: "eth0", inet: "192.0.2.212/24" }], 130: [{ name: "eth0", inet: "192.0.2.230/24" }], 342: [{ name: "eth0", inet: "192.0.2.242/24" }], 341: null }
  }
  async answer(p: string, m: string, body?: string): Promise<any> {
    if (p === "/nodes") return [
      { node: "pve1", status: "online", maxcpu: 4, cpu: 0.1, maxmem: 16 * GB, mem: 4 * GB },
      { node: "pve3", status: "online", maxcpu: 4, cpu: 0.1, maxmem: 16 * GB, mem: 4 * GB },
    ]
    if (p === "/cluster/status") return [{ type: "node", name: "pve1", ip: "192.0.2.11" }, { type: "node", name: "pve3", ip: "192.0.2.13" }]
    if (/\/network$/.test(p)) return [{ iface: "vmbr0", type: "bridge", cidr: "192.0.2.11/24", gateway: "192.0.2.1" }]
    return super.answer(p, m, body)
  }
}

const propose = async (node: string, saved: any = null, ping = async () => false) => {
  const f = new ConventionPve()
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => "a@example.com", wizard: deps(f, { readNaming: async () => saved, ping }) }))
  const r = await a.inject({ method: "POST", url: "/wizard/propose", payload: { node } })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().data
}

test("+LXC proposal: a cluster that follows the numbering gets the convention ID and address for the chosen node", async () => {
  const p1 = await propose("pve1")
  assert.equal(p1.source, "detected")
  assert.equal(p1.ip, "192.0.2.200/24")
  assert.equal(p1.vmid, 100)
  assert.equal(p1.gateway, "192.0.2.1")
  assert.match(p1.label, /CT 1xx ↔ 192\.0\.2\.2xx/)
  const p3 = await propose("pve3")
  assert.equal(p3.source, "detected")
  assert.deepEqual([p3.ip, p3.vmid], ["192.0.2.200/24", 300])
})

test("+LXC proposal: never an address in use or one that answers a ping", async () => {
  const p = await propose("pve1", null, async (_n: any, ip: string) => ip === "192.0.2.200" as any)
  assert.equal(p.ip, "192.0.2.201/24"); assert.equal(p.vmid, 101)
  const q = await propose("pve1")
  assert.notEqual(q.ip, "192.0.2.212/24")
})
