// The catalogue installer's create step against a fake Proxmox: always unprivileged, nesting only.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createContainer } from "../src/lib/catalogue-installer"
import { findRecipe } from "../src/lib/catalogue"

const GB = 1024 ** 3
function fakePve(volids = ["tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"]) {
  const calls: { create?: any; waited?: any[] } = {}
  const pve: any = {
    getNodes: async () => [{ node: "pve1", status: "online", maxmem: 16 * GB, mem: 4 * GB }],
    fetchStrict: async (p: string) => { if (p === "/cluster/nextid") return "120"; throw new Error("unexpected " + p) },
    fetchNode: async (p: string) => {
      if (p.includes("storage?content=vztmpl")) return [{ storage: "tmpl" }]
      if (p.includes("/content?content=vztmpl")) return volids.map(volid => ({ volid }))
      if (p.includes("storage?content=rootdir")) return [{ storage: "pool", type: "rbd", enabled: 1, active: 1, avail: 100 * GB }]
      return null
    },
    createLXC: async (_n: string, params: any) => { calls.create = params; return "UPID:pve1:1:2:3:vzcreate:120:tok@pve:" },
    waitForTask: async (...a: any[]) => { (calls.waited ??= []).push(a) },
    downloadTemplate: async () => { throw new Error("no download expected") },
  }
  return { pve, calls }
}
const SIZES = { cores: 2, memoryMb: 1024, diskGb: 8 }

test("a Docker recipe is created unprivileged with nesting only", async () => {
  const fake = fakePve()
  const made = await createContainer(findRecipe("nginx-proxy-manager")!, SIZES, undefined, fake.pve)
  assert.equal(fake.calls.create.unprivileged, true)
  assert.equal(fake.calls.create.features, "nesting=1")
  assert.equal(fake.calls.create.onboot, true)
  assert.equal(fake.calls.create.net0, "name=eth0,bridge=vmbr0,ip=dhcp,firewall=1")
  assert.deepEqual([made.vmid, made.node, made.distro], [120, "pve1", "debian"])
  assert.equal(fake.calls.waited!.length, 1)
})

test("a non-Docker recipe is created the same way", async () => {
  const fake = fakePve()
  await createContainer(findRecipe("ollama")!, SIZES, undefined, fake.pve)
  assert.equal(fake.calls.create.unprivileged, true)
  assert.equal(fake.calls.create.features, "nesting=1")
})

test("the distro comes from the template that was chosen", async () => {
  const fake = fakePve(["tmpl:vztmpl/ubuntu-24.04-standard_24.04-1_amd64.tar.zst"])
  assert.equal((await createContainer(findRecipe("gitea")!, SIZES, undefined, fake.pve)).distro, "ubuntu")
})

test("no Debian or Ubuntu template is refused before anything is created", async () => {
  const fake = fakePve(["tmpl:vztmpl/alpine-3.20-default_amd64.tar.xz"])
  await assert.rejects(createContainer(findRecipe("gitea")!, SIZES, undefined, fake.pve), /No Debian or Ubuntu template/)
  assert.equal(fake.calls.create, undefined)
})
