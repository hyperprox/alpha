// deploy-service: what derive fills in, what it never touches, and the fixed step list.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deployService, buildDeployService, toDeployFields } from "../src/lib/ai/templates/deploy-service"
import { TEMPLATES, getTemplate } from "../src/lib/ai/templates"
import { findRecipe } from "../src/lib/catalogue"
import { DOCKER_PACKAGES } from "../src/lib/install-script"
import type { Fields, TemplateFacts } from "../src/lib/ai/templates/types"

const facts = (): TemplateFacts =>
  JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))
const user = (o: Record<string, unknown>): Fields =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, source: "user" as const }]))
const settings = { bridge: "vmbr0" }
const d = (o: Record<string, unknown>, fx: TemplateFacts = facts(), t = deployService) =>
  t.derive(user({ service: "uptime-kuma", ...o }), fx, settings)

test("a domain implies public without asking", () => {
  assert.deepEqual(d({ service: "uptime-kuma", domain: "kuma.example.com" }).exposure, { value: "public", source: "derived" })
  assert.equal(d({}).exposure, undefined)
  assert.deepEqual(d({ exposure: "lan", domain: "kuma.example.com" }).exposure, { value: "lan", source: "user" })
})

test("a model-supplied gateway is discarded; the bridge's is used for a static ip", () => {
  const f = d({ ip: "10.0.0.37/24", gateway: "10.9.9.9" })
  assert.deepEqual(f.gateway, { value: "10.0.0.1", source: "fact" })
  assert.equal(d({ gateway: "10.9.9.9" }).gateway, undefined, "dhcp has no gateway, and the model's is not kept")
})

test("a bare address takes the bridge prefix", () => {
  const f = d({ ip: "10.0.0.37" })
  assert.equal(f.ip.value, "10.0.0.37/24")
  assert.equal(f.ip.source, "user")
  assert.equal(f.ip.note, "prefix /24 from vmbr0")
})

test("unstated vmid and ip derive to nextid and dhcp", () => {
  const f = d({})
  assert.deepEqual(f.vmid, { value: 102, source: "derived" })
  assert.deepEqual(f.ip, { value: "dhcp", source: "derived" })
})

test("a stated node, vmid and ip are kept exactly", () => {
  const f = d({ node: "pve3", vmid: 250, ip: "10.0.0.60/24" })
  assert.deepEqual(f.node, { value: "pve3", source: "user" })
  assert.deepEqual(f.vmid, { value: 250, source: "user" })
  assert.deepEqual(f.ip, { value: "10.0.0.60/24", source: "user" })
})

test("node: most free memory among online nodes with a login, enough for the request; none leaves it empty", () => {
  assert.deepEqual(d({}).node, { value: "pve2", source: "derived" })
  const fx = facts(); fx.nodes[1].hasLogin = false
  assert.equal(d({}, fx).node.value, "pve1")
  fx.nodes[0].online = false
  assert.equal(d({ memory_mb: 4000 }, fx).node, undefined)
})

test("node: derive skips any node validate would refuse — unreadable, unknown CPU, or without the bridge", () => {
  for (const spoil of [
    (fx: TemplateFacts) => { fx.partial = ["status:pve2"] },
    (fx: TemplateFacts) => { fx.partial = ["login:pve2"] },
    (fx: TemplateFacts) => { fx.partial = ["network:pve2"] },
    (fx: TemplateFacts) => { fx.nodes[1].arch = "" },
    (fx: TemplateFacts) => { fx.nodes[1].bridges = [] },
  ]) {
    const fx = facts(); spoil(fx)
    assert.equal(d({}, fx).node.value, "pve1", spoil.toString())
    assert.deepEqual(deployService.validate(d({ exposure: "lan" }, fx), fx), [], spoil.toString())
  }
})

test("derived sizes are raised to the Docker floor with a note; user sizes are not touched", () => {
  const tiny = { ...findRecipe("uptime-kuma")!, id: "tiny", name: "Tiny", defaults: { cores: 1, memoryMb: 256, diskGb: 2 } }
  const t = buildDeployService({ recipes: () => [tiny] })
  const f = d({ service: "tiny" }, facts(), t)
  assert.deepEqual(f.disk_gb, { value: 8, source: "derived", note: "raised to the Docker minimum of 8 GB" })
  assert.deepEqual(f.memory_mb, { value: 512, source: "derived", note: "raised to the Docker minimum of 512 MB" })
  assert.deepEqual(f.cores, { value: 1, source: "derived" })
  const g = d({ service: "tiny", disk_gb: 2, memory_mb: 128 }, facts(), t)
  assert.deepEqual(g.disk_gb, { value: 2, source: "user" })
  assert.deepEqual(g.memory_mb, { value: 128, source: "user" })
  const k = d({})
  assert.deepEqual(k.disk_gb, { value: 8, source: "derived" }, "a recipe default at the floor carries no note")
})

test("storage prefers block storage over a larger file share", () => {
  assert.deepEqual(d({}).storage, { value: "fast", source: "derived" })
  // Not enough room for disk x 1.2 on the block storage: the share is next.
  assert.equal(d({ disk_gb: 350 }).storage.value, "share")
  assert.equal(d({ disk_gb: 800 }).storage, undefined)
})

test("template is for the node's arch; an arm64-only list offers an amd64 download", () => {
  assert.deepEqual(d({}).template, { value: "share:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst", source: "fact" })
  const fx = facts()
  for (const t of fx.templates) { t.volid = t.volid.replace("amd64", "arm64"); t.arch = "arm64" }
  assert.deepEqual(d({}, fx).template,
    { value: "share:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst", source: "fact", note: "download" })
  fx.downloadable = []
  assert.deepEqual(d({}, fx).template, { value: "", source: "fact" })
})

test("an arm64 node is never given an amd64 template, local or downloadable", () => {
  const fx = facts()
  for (const n of fx.nodes) n.arch = "arm64"
  assert.equal(d({}, fx).template.value, "")
  fx.downloadable.push({ node: "pve2", name: "debian-13-standard_13.1-2_arm64.tar.zst", arch: "arm64", distro: "debian" })
  assert.equal(d({}, fx).template.value, "share:vztmpl/debian-13-standard_13.1-2_arm64.tar.zst")
  fx.templates.push({ node: "pve2", storage: "share", volid: "share:vztmpl/debian-12-standard_12.7-1_arm64.tar.zst", arch: "arm64", distro: "debian" })
  assert.deepEqual(d({}, fx).template, { value: "share:vztmpl/debian-12-standard_12.7-1_arm64.tar.zst", source: "fact" })
  // A node whose architecture could not be read is given no template at all.
  for (const n of fx.nodes) n.arch = ""
  assert.equal(d({}, fx).node, undefined, "and is never picked")
  assert.equal(d({ node: "pve2" }, fx).template.value, "")
})

test("features and packages are fixed; packages follow the template's distro", () => {
  const f = d({ features: "nesting=1,keyctl=1", packages: ["evil"] })
  assert.deepEqual(f.features, { value: "nesting=1", source: "fixed" })
  assert.deepEqual(f.packages, { value: [...DOCKER_PACKAGES.debian], source: "fixed" })
  const fx = facts()
  fx.templates = fx.templates.map(t => ({ ...t, volid: "share:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst", distro: "ubuntu" as const }))
  assert.deepEqual(d({}, fx).packages, { value: [...DOCKER_PACKAGES.ubuntu], source: "fixed" })
  assert.equal(deployService.constants.features, "nesting=1")
  assert.equal(deployService.constants.unprivileged, 1)
})

test("hostname comes from the recipe id and steps around a name already in use", () => {
  assert.deepEqual(d({}).hostname, { value: "uptime-kuma", source: "derived" })
  const fx = facts(); fx.guests.push({ vmid: 110, node: "pve1", type: "lxc", name: "uptime-kuma", addresses: [] })
  assert.equal(d({}, fx).hostname.value, "uptime-kuma-2")
})

test("a service written as its display name becomes the recipe id; a prototype key does not match", () => {
  assert.equal(d({ service: "Uptime Kuma" }).service.value, "uptime-kuma")
  assert.equal(d({ service: "toString" }).service.value, "toString")
  assert.equal(d({ service: "toString" }).hostname, undefined)
})

test("derive is idempotent: a second pass changes nothing", () => {
  const once = d({ domain: "kuma.example.com", ip: "10.0.0.37" })
  assert.deepEqual(deployService.derive(once, facts(), settings), once)
})

test("lan stops after health_check; public adds the four publishing steps", () => {
  const ids = (o: Record<string, unknown>) => deployService.steps(d(o)).map(s => s.id)
  assert.deepEqual(ids({ exposure: "lan" }), ["create_lxc", "start_and_verify", "install_service", "health_check"])
  assert.deepEqual(ids({ domain: "kuma.example.com" }), ["create_lxc", "start_and_verify", "install_service", "health_check",
    "configure_proxy", "create_dns", "wait_propagation", "request_ssl"])
})

test("toDeployFields gives typed fields and refuses an incomplete set", () => {
  const f = toDeployFields(d({ domain: "kuma.example.com", admin_setup: "now", ip: "10.0.0.37" }))
  assert.equal(f.vmid, 102); assert.equal(f.gateway, "10.0.0.1"); assert.equal(f.features, "nesting=1")
  assert.equal(f.node, "pve2"); assert.equal(f.storage, "fast"); assert.equal(f.domain, "kuma.example.com")
  assert.throws(() => toDeployFields(d({ domain: "kuma.example.com" })), /admin_setup/)
  assert.throws(() => toDeployFields(d({ service: "nope" })), /memory_mb|service/)
})

test("the registry holds deploy-service at version 1", () => {
  assert.equal(TEMPLATES["deploy-service"], deployService)
  assert.equal(getTemplate("deploy-service")?.version, 1)
  assert.equal(getTemplate("toString"), undefined)
})

test("enums: wizard recipe ids, online node names, and the fixed choices", () => {
  const fx = facts(); fx.nodes[2].online = false
  const e = deployService.enums(fx)
  assert.ok(e.service.includes("uptime-kuma")); assert.ok(!e.service.includes("ollama"))
  assert.deepEqual(e.node, ["pve1", "pve2"]); assert.deepEqual(e.exposure, ["public", "lan"])
  assert.deepEqual(e.admin_setup, ["now", "lock"])
})
