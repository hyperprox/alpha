// deploy-service: every field held against the cluster, and the questions asked in HyperProx's own words.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deployService } from "../src/lib/ai/templates/deploy-service"
import { zoneFor } from "../src/lib/dns-zones"
import type { FieldValue, Fields, TemplateFacts } from "../src/lib/ai/templates/types"

const facts = (): TemplateFacts =>
  JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))
const u = (value: unknown): FieldValue => ({ value, source: "user" })
const full: Fields = {
  service: u("uptime-kuma"), exposure: u("public"), domain: u("kuma.example.com"), admin_setup: u("now"),
  node: u("pve1"), vmid: u(237), ip: u("10.0.0.37/24"), memory_mb: u(1024), disk_gb: u(8), cores: u(1),
}
const v = (f: Fields, fx: TemplateFacts = facts()) => deployService.validate(deployService.derive(f, fx, { bridge: "vmbr0" }), fx)
const without = (k: string): Fields => { const f = { ...full }; delete f[k]; return f }
const fields = (f: Fields, fx?: TemplateFacts) => v(f, fx).map(i => i.field)

test("a full valid request has no issues", () => {
  assert.deepEqual(v(full), [])
  assert.deepEqual(v({ service: u("gitea"), exposure: u("lan") }), [], "everything else derives to something valid")
})

test("unknown service asks with suggestions first", () => {
  const [i] = v({ ...full, service: u("kuma") })
  assert.equal(i.field, "service")
  assert.equal(i.choices![0], "uptime-kuma")
  assert.match(i.message, /^Which service\? I can install: .*Uptime Kuma/)
  assert.equal(new Set(i.choices).size, i.choices!.length, "a suggestion is not offered twice")
  const [m] = v(without("service"))
  assert.equal(m.field, "service"); assert.equal(m.kind, "missing")
  assert.equal(v({ ...full, service: u("toString") })[0].field, "service")
})

test("exposure: asked when unstated; public needs a reverse proxy and a managed zone", () => {
  const [i] = v({ service: u("uptime-kuma") })
  assert.equal(i.message, "Should this be reachable from the internet, or only on your network?")
  assert.deepEqual(i.choices, ["public", "lan"])
  const fx = facts(); fx.hasReverseProxy = false
  assert.equal(v(full, fx)[0].field, "exposure")
  const fz = facts(); fz.zones = []
  assert.equal(v(full, fz)[0].field, "exposure")
  assert.deepEqual(v({ ...without("domain"), exposure: u("lan") }, fx), [], "a LAN deploy needs neither")
  const fp = facts(); fp.partial = ["proxy"]
  const [p] = v(full, fp)
  assert.equal(p.field, "exposure"); assert.doesNotMatch(p.message, /none configured/)
})

test("ip: bare address gets the bridge prefix; wrong prefix, gateway, network and broadcast are refused", () => {
  assert.deepEqual(v({ ...full, ip: u("10.0.0.37") }), [])
  for (const ip of ["10.0.0.37/16", "10.0.0.1/24", "10.0.0.0/24", "10.0.0.255/24", "10.5.0.9/24"]) {
    const [i] = v({ ...full, ip: u(ip) })
    assert.equal(i?.field, "ip", ip)
    assert.deepEqual(i.choices, ["dhcp"])
  }
})

test("an ip used by another guest names the guest and offers DHCP", () => {
  const [i] = v({ ...full, ip: u("10.0.0.45/24") })
  assert.equal(i.message, "10.0.0.45 is already used by guest 105. Which address, or DHCP?")
  assert.deepEqual(i.choices, ["dhcp"])
})

test("a static ip on a bridge with no gateway is refused, offering DHCP", () => {
  const fx = facts(); fx.nodes[0].bridges[0].gateway = ""
  const [i] = v(full, fx)
  assert.equal(i.field, "ip"); assert.deepEqual(i.choices, ["dhcp"])
  assert.deepEqual(v({ ...full, ip: u("dhcp") }, fx), [])
})

test("a taken vmid offers the next free one", () => {
  const [i] = v({ ...full, vmid: u(101) })
  assert.equal(i.message, "Container ID 101 is taken by another guest. Use 102 instead?")
  assert.deepEqual(i.choices, ["102"])
  const fx = facts(); fx.guests.push({ vmid: 102, node: "pve3", type: "qemu", name: "x", addresses: [] })
  assert.equal(v({ ...full, vmid: u(105) }, fx)[0].message, "Container ID 105 is taken by another guest. Use 103 instead?")
})

test("a vmid outside 100..999999999 is refused", () => {
  for (const n of [0, 99, 1_000_000_000]) assert.equal(v({ ...full, vmid: u(n) })[0]?.field, "vmid", String(n))
  assert.deepEqual(v({ ...full, vmid: u(999_999_999) }), [])
})

test("a domain outside the managed zones is asked again, listing zones; one already proxied is refused", () => {
  for (const d of ["kuma.example.net", "evil-example.com"]) {
    const [i] = v({ ...full, domain: u(d) })
    assert.equal(i.field, "domain")
    assert.equal(i.message, "Which hostname should it answer on? Zones I manage: example.com")
  }
  const [p] = v({ ...full, domain: u("old.example.com") })
  assert.equal(p.field, "domain"); assert.match(p.message, /old\.example\.com is already a proxy host/)
  const [m] = v(without("domain"))
  assert.equal(m.field, "domain"); assert.equal(m.kind, "missing")
  assert.deepEqual(v({ ...full, domain: u(" Kuma.Example.com. ") }), [], "trimmed, lowercased and the trailing dot dropped")
})

test("a user disk below the Docker floor asks to use 8", () => {
  const [i] = v({ ...full, disk_gb: u(2) })
  assert.equal(i.message, "Docker needs at least 8 GB. Use 8?"); assert.deepEqual(i.choices, ["8"])
  const [m] = v({ ...full, memory_mb: u(256) })
  assert.equal(m.message, "Docker needs at least 512 MB. Use 512?"); assert.deepEqual(m.choices, ["512"])
})

test("sizes must fit: memory on the node, cores on the node, disk on its storage", () => {
  assert.equal(v({ ...full, memory_mb: u(7000) })[0].field, "node")
  assert.deepEqual(v({ ...full, memory_mb: u(7000), node: u("pve2") }), [])
  const [c] = v({ ...full, cores: u(6) })
  assert.equal(c.field, "cores"); assert.deepEqual(c.choices, ["4"])
  assert.equal(v({ ...full, cores: u(0) })[0].field, "cores")
  assert.deepEqual(v({ ...full, disk_gb: u(900) })[0].choices, ["750"], "the largest disk that fits is offered")
})

test("node: must exist, be online, have a stored login and a known CPU", () => {
  assert.equal(v({ ...full, node: u("pve9") })[0].field, "node")
  const fx = facts(); fx.nodes[0].online = false
  assert.equal(v(full, fx)[0].field, "node")
  const fl = facts(); fl.nodes[0].hasLogin = false
  assert.equal(v(full, fl)[0].field, "node")
  const fa = facts(); fa.nodes[0].arch = ""
  assert.equal(v(full, fa)[0].field, "node")
  const none = facts(); for (const n of none.nodes) n.freeMemMb = 100
  const [i] = v(without("node"), none)
  assert.equal(i.field, "node"); assert.equal(i.kind, "missing")
})

test("admin_setup is required only for public setup-url recipes", () => {
  const [i] = v(without("admin_setup"))
  assert.equal(i.field, "admin_setup")
  assert.equal(i.message, "This app's first visitor becomes its admin. Create the admin account now, or keep it LAN-only until you do?")
  assert.deepEqual(i.choices, ["now", "lock"], "both answers the question offers are buttons")
  assert.deepEqual(v({ ...without("admin_setup"), domain: undefined as any, exposure: u("lan") }), [])
  assert.deepEqual(v({ ...without("admin_setup"), service: u("homepage") }), [], "no first-run setup")
  const [l] = v({ ...full, admin_setup: u("lock") })
  assert.equal(l.message, "Keeping it LAN-only until setup needs proxy access lists, which HyperProx does not support yet. Choose now, or make it LAN-only.")
})

test("hostname: an override must be one RFC 1123 label and not another guest's name", () => {
  assert.equal(v({ ...full, hostname: u("web") })[0].field, "hostname")
  assert.equal(v({ ...full, hostname: u("bad_name") })[0].field, "hostname")
  assert.equal(v({ ...full, hostname: u("a.b") })[0].field, "hostname")
  assert.deepEqual(v({ ...full, hostname: u("status") }), [])
})

test("an unreadable fact source is an issue on the field it feeds, never a silent default", () => {
  const with_ = (p: string) => { const fx = facts(); fx.partial = [p]; return fx }
  assert.ok(fields(full, with_("resources")).includes("vmid"), "a vmid cannot be shown free")
  assert.ok(fields(full, with_("resources")).includes("ip"), "nor an address unused")
  assert.ok(fields(full, with_("resources")).includes("hostname"), "nor a name")
  assert.ok(fields(full, with_("config:105")).includes("ip"))
  assert.deepEqual(v({ ...full, ip: u("dhcp") }, with_("config:105")), [], "DHCP needs no address check")
  assert.ok(fields(full, with_("zones")).includes("domain"))
  assert.ok(fields(full, with_("proxy")).includes("domain"))
  assert.deepEqual(v({ ...without("domain"), exposure: u("lan") }, with_("zones")), [], "a LAN deploy does not read zones")
  assert.ok(fields(full, with_("nodes")).includes("node"))
  assert.ok(fields(full, with_("status:pve1")).includes("node"))
  assert.ok(fields(full, with_("login:pve1")).includes("node"))
  assert.ok(fields(full, with_("network:pve1")).includes("bridge"))
  assert.ok(fields(full, with_("storage:pve1")).includes("storage"))
  assert.ok(fields(full, with_("templates:pve1/share")).includes("template"))
  assert.deepEqual(v(full, with_("storage:pve2")), [], "another node's failure does not touch this one")
})

test("a template for another CPU is never accepted for a node", () => {
  const fx = facts()
  fx.nodes[0].arch = "arm64"
  const f = deployService.derive(full, facts(), { bridge: "vmbr0" }) // derived against amd64: an amd64 template
  assert.equal(deployService.validate(f, fx).find(i => i.field === "template")?.field, "template")
})

test("issues come in field order", () => {
  const order = deployService.fields.map(s => s.name)
  const got = fields({ ...full, vmid: u(101), ip: u("10.0.0.45/24"), disk_gb: u(2), domain: u("x.example.net") })
  assert.deepEqual(got, ["domain", "vmid", "ip", "disk_gb"])
  assert.deepEqual([...got].sort((a, b) => order.indexOf(a) - order.indexOf(b)), got)
})

test("zoneFor picks the longest zone, not the last two labels", () => {
  assert.deepEqual(zoneFor("a.b.example.co.uk", ["co.uk", "example.co.uk"]), { zone: "example.co.uk", name: "a.b" })
  assert.equal(zoneFor("evil-example.com", ["example.com"]), null)
  assert.deepEqual(zoneFor("example.com", ["example.com"]), { zone: "example.com", name: "@" })
  assert.deepEqual(zoneFor("Kuma.Example.COM.", ["example.com"]), { zone: "example.com", name: "kuma" })
  assert.equal(zoneFor("", ["example.com"]), null)
})

test("the apex of a zone is refused: it would replace the zone's main address", () => {
  const [i] = v({ ...full, domain: u("example.com") })
  assert.equal(i.field, "domain")
  assert.equal(i.message, "That would replace the main address of example.com. Pick a name under it, like uptime-kuma.example.com?")
  assert.deepEqual(i.choices, ["uptime-kuma.example.com"])
})

test("a name that already has a DNS record is refused, never overwritten; an unreadable zone is an issue", () => {
  const [i] = v({ ...full, domain: u("www.example.com") })
  assert.equal(i.field, "domain")
  assert.equal(i.message, "www.example.com already has a DNS record. Pick another name under example.com, like uptime-kuma.example.com?")
  assert.deepEqual(i.choices, ["uptime-kuma.example.com"])
  const fx = facts(); fx.records["example.com"].push("uptime-kuma")
  const [j] = v({ ...full, domain: u("www.example.com") }, fx)
  assert.equal(j.choices, undefined, "a suggestion that is itself taken is not offered")
  const fp = facts(); delete (fp.records as any)["example.com"]; fp.partial = ["records:example.com"]
  assert.equal(v(full, fp)[0]?.field, "domain")
  const fm = facts(); delete (fm.records as any)["example.com"]
  assert.equal(v(full, fm)[0]?.field, "domain", "no record list at all is not 'no records'")
})

test("LAN only with a domain asks which was meant, instead of dropping the name", () => {
  const [i] = v({ ...full, exposure: u("lan"), domain: u("kuma.example.com") })
  assert.equal(i.field, "exposure")
  assert.equal(i.message, "You gave kuma.example.com but asked for LAN only. Should it be reachable from the internet at that name, or LAN only without a name?")
  assert.deepEqual(i.choices, ["public", "lan"])
})

test("a template's architecture is read the way facts read it: aarch64 is arm64", () => {
  const fx = facts(); fx.nodes[0].arch = "arm64"
  const f = deployService.derive(full, fx, { bridge: "vmbr0" })
  f.template = { value: "share:vztmpl/debian-13-standard_13.1-2_aarch64.tar.zst", source: "fact" }
  assert.equal(deployService.validate(f, fx).find(i => i.field === "template"), undefined)
})

test("plain wording: no '0 MB' without a recipe, an unreachable node said so, storage asked as a question", () => {
  const fx = facts(); for (const n of fx.nodes) n.online = false
  const n = v({ service: u("nope"), exposure: u("lan") }, fx).find(i => i.field === "node")!
  assert.doesNotMatch(n.message, /\b0 MB/)
  const fl = facts(); fl.partial = ["login:pve1"]
  const all = v(full, fl)
  assert.equal(all[0].message, "HyperProx couldn't reach node pve1 to check it. Try again in a moment.")
  for (const x of [...all, ...v(full, (() => { const f = facts(); f.nodes[0].hasLogin = false; return f })())])
    assert.doesNotMatch(x.message, /stored login/)
  const [s] = v({ ...full, disk_gb: u(900) })
  assert.match(s.message, /\?$/); assert.ok(s.choices?.length, "with buttons")
})

test("a malformed or wildcard domain is asked again in plain words, never accepted", () => {
  for (const d of ["*.example.com", "a..example.com", "foo_bar.example.com", "x y.example.com"]) {
    const [i] = v({ ...full, domain: u(d) })
    assert.equal(i?.field, "domain", d)
    assert.equal(i.kind, "invalid", d)
    assert.ok(i.message.includes(d), `${d}: ${i.message}`)
    assert.match(i.message, /Which hostname should it answer on\? Zones I manage: example\.com/, d)
  }
  assert.match(v({ ...full, domain: u("*.example.com") })[0].message, /wildcard/)
  assert.match(v({ ...full, domain: u("kuma.*.example.com") })[0].message, /wildcard/, "a * label anywhere")
  assert.equal(v({ ...full, domain: u(42) })[0]?.field, "domain", "a number is not a hostname")
})
