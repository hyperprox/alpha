// The AI deploy path and the Catalogue wizard place the same request on the same node, with the same ID.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deployService } from "../src/lib/ai/templates/deploy-service"
import { placementFor, nextIdOf, type ClusterView } from "../src/lib/catalogue-installer"
import { findRecipe } from "../src/lib/catalogue"
import type { Fields, TemplateFacts } from "../src/lib/ai/templates/types"

const base = (): TemplateFacts =>
  JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))
const bridge = { iface: "vmbr0", gateway: "192.0.2.1", prefix: 24 }

/** node-a: modest. node-b: the most RAM, but a GPU. node-c: tight. All on shared block storage. */
function cluster(): { facts: TemplateFacts; view: ClusterView } {
  const facts = base()
  const n = (node: string, cores: number, total: number, free: number, extra: object = {}) =>
    ({ node, online: true, cores, freeMemMb: free, totalMemMb: total, arch: "amd64" as const, hasLogin: true, bridges: [bridge], cpuLoad: 0.1, runningGuests: 2, ...extra })
  facts.nodes = [n("node-a", 8, 32000, 20000), n("node-b", 24, 96000, 70000, { hasGpu: true }), n("node-c", 4, 16000, 3000)]
  facts.storages = facts.nodes.map(x => ({ storage: "pool", node: x.node, type: "rbd", content: ["rootdir"], active: true, shared: true, freeGb: 400 }))
  facts.templates = facts.nodes.map(x => ({ node: x.node, storage: "local", volid: "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst", arch: "amd64", distro: "debian" as const }))
  facts.guests = [100, 101, 103].map(vmid => ({ vmid, node: "node-a", type: "lxc" as const, name: `g${vmid}`, addresses: [] }))
  facts.nextVmid = 102
  facts.partial = []
  const view: ClusterView = {
    nodes: facts.nodes.map(x => ({ node: x.node, online: true, cores: x.cores, cpuLoad: x.cpuLoad, memTotalMb: x.totalMemMb,
      memUsedMb: x.totalMemMb - x.freeMemMb, runningGuests: x.runningGuests, hasGpu: Boolean((x as any).hasGpu), hasLogin: true,
      bridges: [{ iface: "vmbr0", gateway: "192.0.2.1", prefix: 24, cidr: "192.0.2.10/24" }], haGuests: 0 })),
    storages: facts.storages, guests: facts.guests.map(g => ({ ...g, status: "running", config: null })), partial: [], nextId: 102,
  }
  return { facts, view }
}

const user = (o: Record<string, unknown>): Fields =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, source: "user" as const }]))

test("same cluster, same request: the AI path and the Catalogue pick the same node, not the GPU node", () => {
  const { facts, view } = cluster()
  const recipe = findRecipe("uptime-kuma")!
  const ai = deployService.derive(user({ service: "uptime-kuma" }), facts, { bridge: "vmbr0" })
  const cat = placementFor(recipe, { cores: recipe.defaults.cores, memoryMb: ai.memory_mb.value as number, diskGb: ai.disk_gb.value as number }, view)
  assert.equal(cat.recommendation!.node, "node-a")
  assert.equal(ai.node.value, cat.recommendation!.node)
  assert.equal(ai.storage.value, cat.recommendation!.storage)
})

test("same cluster: both suggest the next ID no CT or VM has", () => {
  const { facts, view } = cluster()
  facts.guests.push({ vmid: 102, node: "node-b", type: "qemu", name: "vm", addresses: [] })
  view.guests.push({ vmid: 102, node: "node-b", type: "qemu", name: "vm", status: "stopped", config: null })
  const ai = deployService.derive(user({ service: "uptime-kuma" }), facts, { bridge: "vmbr0" })
  assert.equal(ai.vmid.value, 104)
  assert.equal(nextIdOf(view), 104)
})
