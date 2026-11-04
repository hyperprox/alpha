// Fix round: promised memory, no CIFS rootfs, integrated and AMD GPUs, vault clean-up, the address check's limits.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  scoreNodes, recommend, rootStorages, storageFor, pciGpus, configGpuKind, type PlacementNode, type PlacementStorage,
} from "../src/lib/wizard-placement"

const node = (o: Partial<PlacementNode> & { node: string }): PlacementNode => ({
  online: true, cores: 8, cpuLoad: 0.1, memTotalMb: 32768, memUsedMb: 8192, runningGuests: 2, hasLogin: true, ...o,
})
const pool = (n: string, o: Partial<PlacementStorage> = {}): PlacementStorage =>
  ({ storage: "pool", node: n, type: "rbd", content: ["rootdir"], active: true, shared: true, freeGb: 500, ...o })
const SMALL = { cores: 1, memoryMb: 512, diskGb: 8 }

test("RAM: the worse of in-use and promised decides the score and the headroom note", () => {
  const live = node({ node: "node-a", memUsedMb: 8192, memCommittedMb: 4096 })
  const promised = node({ node: "node-b", memUsedMb: 8192, memCommittedMb: 30000 })
  const v = scoreNodes([live, promised], [pool("node-a"), pool("node-b")], SMALL)
  assert.equal(v[0].node, "node-a")
  const b = v.find(x => x.node === "node-b")!
  assert.equal(b.eligible, true, "promised memory alone does not make a node ineligible")
  assert.equal(b.freeMemAfterMb, 32768 - 30000 - 512, "free after install is counted against the promise")
  assert.equal(b.freeMemAfterLiveMb, 32768 - 8192 - 512)
  assert.match(b.notes.join(" "), /promised to its guests/)
  assert.match(recommend(v, [live, promised])!.reason, /^node-a: /)
})

test("RAM: real use, not the promise, decides whether it fits at all", () => {
  const full = node({ node: "node-a", memUsedMb: 32500, memCommittedMb: 1000 })
  assert.match(scoreNodes([full], [pool("node-a")], SMALL)[0].why.join(" "), /not enough RAM/)
})

test("storage: CIFS/SMB never holds a container rootfs; NFS ranks below shared block", () => {
  const s = [
    pool("n", { storage: "smb", type: "cifs", freeGb: 9000 }),
    pool("n", { storage: "nfs", type: "nfs", freeGb: 9000 }),
    pool("n", { storage: "pool", freeGb: 50 }),
  ]
  assert.deepEqual(rootStorages(s, "n").map(x => x.storage), ["pool", "nfs"])
  assert.match(storageFor(s, "n", 8, "smb").why!, /CIFS\/SMB shares cannot hold a container's root disk/)
})

test("GPU: NVIDIA and AMD cards are discrete; Intel and AMD APU graphics are integrated", () => {
  assert.deepEqual(pciGpus([{ class: "0x030000", vendor: "0x10de", device_name: "GP104 [GeForce GTX 1070 Ti]" }]), { discrete: true, integrated: false })
  assert.deepEqual(pciGpus([{ class: "0x030000", vendor: "0x1002", device_name: "Navi 23 [Radeon RX 6600]" }]), { discrete: true, integrated: false })
  assert.deepEqual(pciGpus([{ class: "0x030000", vendor: "0x1002", device_name: "Picasso/Raven 2 [Radeon Vega Series / Radeon Vega Mobile Series]" }]), { discrete: false, integrated: true })
  assert.deepEqual(pciGpus([{ class: "0x030000", vendor: "0x8086", device_name: "HD Graphics 630" }]), { discrete: false, integrated: true })
  assert.deepEqual(pciGpus(null), { discrete: false, integrated: false })
  assert.equal(configGpuKind({ dev0: "/dev/dri/renderD128,gid=104" }), "integrated")
  assert.equal(configGpuKind({ lxc: [["lxc.mount.entry", "/dev/dri dev/dri none bind,optional,create=dir"]] }), "integrated")
  assert.equal(configGpuKind({ hostpci0: "0000:0a:00" }), "discrete")
  assert.equal(configGpuKind({ net0: "name=eth0" }), null)
})

test("GPU: an iGPU-only node is not penalised for ordinary apps; a transcoding app prefers any GPU", () => {
  const plain = node({ node: "node-a" })
  const igpu = node({ node: "node-b", hasIgpu: true })
  const dgpu = node({ node: "node-c", hasGpu: true })
  const stores = [pool("node-a"), pool("node-b"), pool("node-c")]
  const ordinary = scoreNodes([plain, igpu, dgpu], stores, SMALL)
  assert.equal(ordinary.find(x => x.node === "node-a")!.score, ordinary.find(x => x.node === "node-b")!.score)
  assert.ok(ordinary.find(x => x.node === "node-c")!.score < ordinary.find(x => x.node === "node-b")!.score)
  const transcode = scoreNodes([plain, igpu, dgpu], stores, { ...SMALL, wantsGpu: true })
  assert.notEqual(transcode[0].node, "node-a")
  assert.ok(transcode.find(x => x.node === "node-b")!.score > transcode.find(x => x.node === "node-a")!.score)
  assert.match(transcode.find(x => x.node === "node-b")!.notes.join(" "), /GPU for transcoding/)
})
