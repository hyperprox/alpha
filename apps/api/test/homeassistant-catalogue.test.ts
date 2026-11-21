// The Home Assistant catalogue entry, the first that is a virtual machine: the recipe and its pinned image, the small
// WebSocket client (against a real local server), the import script and the machine's create body, Home Assistant's
// onboarding against a fake, the proxy trust that is proved before a name is made, and the install wizard end to end on a
// fake cluster (preview, apply, clean-up). Names and addresses are made up.
import { test } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import crypto from "node:crypto"
import { CATALOGUE, findRecipe, checkOptions } from "../src/lib/catalogue"
import { HA_RECIPE, HAOS_IMAGES, HAOS_VERSION, HA_SETUP_STEPS, checkHaOptions, usbList } from "../src/lib/homeassistant/recipe"
import { encodeFrame, decodeFrames, haSocket } from "../src/lib/homeassistant/ws"
import { importScript, createHaVm, agentAddress, imageFor, trustProxy, runHaSetup, CONFIG_PATH } from "../src/lib/homeassistant/job"
import { onboard, onboardingState, waitForHomeAssistant, withTrust, hasHttpSection, setStaticAddress, trustBlock } from "../src/lib/homeassistant/onboarding"
import { parseUsb, resolveUsb, whyRefused, HAVM_USB_SCRIPT } from "../src/lib/homeassistant/usb"
import { installScript, manualCommands } from "../src/lib/install-script"
import { previewInstall, applyPreview, removeFailedInstall, homeAssistantUsb } from "../src/lib/catalogue-installer"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const OWNER = "a@example.com"

// ── The recipe ──────────────────────────────────────────────────────────────

test("recipe: a virtual machine from a pinned official image with its published checksum; the questions; defaults of 2 cores, 4 GB and 32 GB", () => {
  assert.equal(findRecipe("home-assistant"), HA_RECIPE)
  assert.equal(HA_RECIPE.install.kind, "vm"); assert.equal(HA_RECIPE.needsDocker, false)
  assert.deepEqual([HA_RECIPE.defaults.cores, HA_RECIPE.defaults.memoryMb, HA_RECIPE.defaults.diskGb], [2, 4096, 32])
  assert.deepEqual(HA_RECIPE.minimum, { cores: 2, memoryMb: 2048, diskGb: 32 })
  assert.equal(HA_RECIPE.setup, "homeassistant"); assert.equal(HA_RECIPE.publishable, true)
  assert.ok(["smart home", "home automation", "zigbee"].every(k => HA_RECIPE.keywords!.includes(k)))
  assert.match(HAOS_VERSION, /^\d+\.\d+$/)
  for (const img of Object.values(HAOS_IMAGES)) {
    assert.match(img.sha256, /^[0-9a-f]{64}$/)
    assert.ok(img.url.startsWith(`https://github.com/home-assistant/operating-system/releases/download/${HAOS_VERSION}/`) && img.url.endsWith(img.file))
  }
  assert.equal(HAOS_IMAGES.amd64.file, `haos_ova-${HAOS_VERSION}.qcow2.xz`)
  assert.equal(imageFor("amd64"), HAOS_IMAGES.amd64); assert.equal(imageFor("arm64"), null, "Proxmox runs x86 machines only"); assert.equal(imageFor(""), null)
  assert.equal(CATALOGUE.filter(r => r.id === "home-assistant").length, 1)
  // A machine has no install script and no commands to run by hand.
  assert.throws(() => installScript(HA_RECIPE, "debian", {}), /virtual machine, not a container/)
  assert.match(manualCommands(HA_RECIPE, "debian")[0], /virtual machine/)
  // The job's steps, in order.
  assert.deepEqual(HA_SETUP_STEPS.map(s => s.id), ["ha-image", "ha-disk", "network", "ha-ready", "ha-onboard", "ha-token", "ha-address", "ha-trust"])
})

test("options: units are a menu, USB codes are vendor:product, at most four and never twice", () => {
  const v = (o: any = {}) => checkOptions(HA_RECIPE, o)
  assert.deepEqual(v().errors, []); assert.equal(v().values.HA_UNITS, "metric"); assert.equal(v().values.HA_OWNER_USER, "owner")
  assert.match(v({ HA_UNITS: "imperial" }).errors.join(" "), /Units: pick one of/)
  assert.deepEqual(v({ HA_USB: "10c4:ea60, 1A86:7523" }).errors, [])
  assert.deepEqual(usbList("10c4:ea60, 1A86:7523,"), ["10c4:ea60", "1a86:7523"])
  assert.match(v({ HA_USB: "/dev/ttyUSB0" }).errors.join(" "), /the code from the list/)
  assert.deepEqual(v({ HA_USB: "1-2.3, 10c4:ea60" }).errors, [], "a bus-port names one of several identical devices")
  assert.deepEqual(checkHaOptions({ HA_USB: "10c4:ea60,10c4:ea60" }), ["A USB device is listed twice."])
  assert.deepEqual(checkHaOptions({ HA_USB: "0001:0001,0002:0002,0003:0003,0004:0004,0005:0005" }), ["Pass in at most four USB devices."])
  assert.match(v({ HA_OWNER_USER: "Owner Name" }).errors.join(" "), /lowercase letters/)
})

// ── The WebSocket client, against a real local server ───────────────────────

/** A one-connection WebSocket server that speaks Home Assistant's auth and a few commands. */
function wsServer(handler: (m: any) => unknown, opts: { acceptToken?: string; fragment?: boolean } = {}) {
  const received: any[] = []; const socks = new Set<net.Socket>()
  const server = net.createServer(sock => {
    socks.add(sock); sock.on("error", () => {})
    let head = Buffer.alloc(0), up = false, buf: Buffer = Buffer.alloc(0)
    const frame = (opcode: number, fin: boolean, p: Buffer) => Buffer.concat([
      Buffer.from([(fin ? 0x80 : 0) | opcode, p.length < 126 ? p.length : 126]), ...(p.length < 126 ? [] : [Buffer.from([p.length >> 8, p.length & 255])]), p])
    const send = (obj: unknown) => {
      const text = Buffer.from(JSON.stringify(obj))
      if (opts.fragment && text.length > 10) sock.write(Buffer.concat([frame(0x1, false, text.subarray(0, 10)), frame(0x0, true, text.subarray(10))]))
      else sock.write(frame(0x1, true, text))
    }
    sock.on("data", chunk => {
      if (!up) {
        head = Buffer.concat([head, chunk]); const end = head.indexOf("\r\n\r\n"); if (end < 0) return
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head.toString("latin1"))![1]
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")}\r\n\r\n`)
        up = true; buf = head.subarray(end + 4); send({ type: "auth_required" }); chunk = Buffer.alloc(0)
      }
      const got = decodeFrames(Buffer.concat([buf, chunk])); buf = got.rest
      for (const f of got.frames) {
        if (f.opcode === 0x8) { sock.end(); continue }
        const m = JSON.parse(f.payload.toString()); received.push(m)
        if (m.type === "auth") send(m.access_token === (opts.acceptToken ?? "tok") ? { type: "auth_ok" } : { type: "auth_invalid" })
        else { const r: any = handler(m); send(r instanceof Error ? { id: m.id, type: "result", success: false, error: { message: r.message } } : { id: m.id, type: "result", success: true, result: r }) }
      }
    })
  })
  return new Promise<{ port: number; received: any[]; close: () => void }>(res => server.listen(0, "127.0.0.1", () => res({ port: (server.address() as net.AddressInfo).port, received, close: () => { for (const x of socks) x.destroy(); server.close() } })))
}

test("websocket: frames round-trip at every length, and a client frame is masked", () => {
  for (const n of [0, 5, 125, 126, 300, 70_000]) {
    const text = "x".repeat(n)
    const f = encodeFrame(text)
    assert.equal(f[1] & 0x80, 0x80, "masked")
    const got = decodeFrames(f)
    assert.equal(got.frames.length, 1); assert.equal(got.frames[0].payload.toString(), text); assert.equal(got.rest.length, 0)
  }
  const two = Buffer.concat([encodeFrame("a"), encodeFrame("bb").subarray(0, 3)])
  const half = decodeFrames(two); assert.equal(half.frames.length, 1); assert.ok(half.rest.length > 0, "a partial frame waits")
  assert.throws(() => decodeFrames(Buffer.from([0x81, 127, 0, 0, 0, 0, 0xff, 0, 0, 0])), /too large/)
})

test("websocket: signs in, answers calls by id, carries a refusal, joins a fragmented message, and refuses a bad token", async () => {
  const s = await wsServer(m => m.type === "boom" ? new Error("no way") : { echoed: m.type, long: "y".repeat(200) }, { fragment: true })
  try {
    const sock = await haSocket("127.0.0.1", s.port, "tok", 5000)
    assert.deepEqual(await sock.call({ type: "ping-me" }), { echoed: "ping-me", long: "y".repeat(200) })
    const [a, b] = await Promise.all([sock.call({ type: "one" }), sock.call({ type: "two" })])
    assert.deepEqual([a.echoed, b.echoed], ["one", "two"])
    await assert.rejects(sock.call({ type: "boom" }), /no way/)
    assert.equal(s.received.find(m => m.type === "auth").access_token, "tok")
    sock.close()
    await assert.rejects(haSocket("127.0.0.1", s.port, "wrong", 5000), /refused the access token/)
  } finally { s.close() }
  await assert.rejects(haSocket("127.0.0.1", 1, "tok", 500), /ECONNREFUSED|did not open/)
})

// ── The machine and its disk ────────────────────────────────────────────────

test("import script: checks the pinned checksum before using the image, grows only a bigger disk, passes USB devices in, and cleans up after itself", () => {
  const img = HAOS_IMAGES.amd64
  const s = importScript({ vmid: 920, storage: "pool", image: img, diskGb: 64, usb: ["10c4:ea60"] })
  assert.match(s, new RegExp(`sha256sum -c`)); assert.ok(s.includes(img.sha256)); assert.ok(s.includes(img.url))
  assert.ok(s.indexOf("sha256sum -c") < s.indexOf("xz -dc"), "checked before it is unpacked")
  assert.ok(s.indexOf("sha256sum -c") < s.indexOf("qm disk import"), "checked before it is imported")
  assert.match(s, /trap 'rm -f "\$F" "\$F\.xz"' EXIT/)
  assert.match(s, /qm resize "\$V" scsi0 64G/); assert.match(s, /qm set "\$V" --usb0 host=10c4:ea60/)
  assert.match(s, /--boot order=scsi0/)
  const plain = importScript({ vmid: 920, storage: "pool", image: img, diskGb: 32, usb: [] })
  assert.doesNotMatch(plain, /qm resize/); assert.doesNotMatch(plain, /--usb/)
  assert.throws(() => importScript({ vmid: 920, storage: "pool; rm -rf /", image: img, diskGb: 32, usb: [] }), /Not a storage name/)
  assert.throws(() => importScript({ vmid: 920, storage: "pool", image: { ...img, url: "https://evil.example/x.qcow2.xz" }, diskGb: 32, usb: [] }), /not the pinned release/)
  assert.throws(() => importScript({ vmid: 920, storage: "pool", image: { ...img, sha256: "abc" }, diskGb: 32, usb: [] }), /Bad checksum/)
  assert.throws(() => importScript({ vmid: 920, storage: "pool", image: img, diskGb: 32, usb: ["$(id)"] }), /Bad USB id/)
  assert.throws(() => importScript({ vmid: 5, storage: "pool", image: img, diskGb: 32, usb: [] }), /Bad machine id/)
})

test("create: a UEFI q35 machine with its own EFI disk, VirtIO network behind the node firewall, the agent on, starting with the node, marked, and no data disk yet", async () => {
  const calls: Array<{ path: string; method?: string; body?: string }> = []
  const client = { fetchStrict: async (path: string, method?: string, body?: string) => { calls.push({ path, method, body }); return "UPID:x" }, waitForTask: async () => {} } as any
  let created = false
  await createHaVm({ node: "node-a", vmid: 920, hostname: "ha", cores: 2, memoryMb: 4096, diskGb: 32, storage: "pool", bridge: "vmbr0", vlan: 30 }, "HA, installed.\nhyperprox-install: j1", client, () => { created = true })
  assert.equal(calls[0].path, "/nodes/node-a/qemu"); assert.equal(calls[0].method, "POST"); assert.ok(created)
  const b = new URLSearchParams(calls[0].body)
  assert.deepEqual(["vmid", "name", "memory", "cores", "machine", "bios", "ostype", "scsihw", "agent", "onboot", "start", "net0", "efidisk0"].map(k => b.get(k)),
    ["920", "ha", "4096", "2", "q35", "ovmf", "l26", "virtio-scsi-pci", "enabled=1", "1", "0", "virtio,bridge=vmbr0,firewall=1,tag=30", "pool:1,efitype=4m,pre-enrolled-keys=0"])
  assert.equal(b.get("scsi0"), null); assert.match(b.get("description")!, /hyperprox-install: j1/)
})

test("agent address: the first real IPv4 address, not loopback, link-local or Home Assistant's own Docker networks", () => {
  const nic = (name: string, ...ips: string[]) => ({ name, "ip-addresses": ips.map(ip => ({ "ip-address-type": ip.includes(":") ? "ipv6" : "ipv4", "ip-address": ip })) })
  assert.equal(agentAddress({ result: [nic("lo", "127.0.0.1"), nic("hassio", "172.30.32.1"), nic("docker0", "172.30.232.1"), nic("enp0s18", "fe80::1", "169.254.1.1", "10.0.0.50")] }), "10.0.0.50")
  assert.equal(agentAddress({ result: [nic("lo", "127.0.0.1")] }), undefined)
  assert.equal(agentAddress(null), undefined); assert.equal(agentAddress({ result: "no" }), undefined)
})

const U = (code: string, name: string, port: string, cls = "ff", drv = "", blk = 0, net = 0) => `@@usb ${code}|${name.split("|")[0]}|${name.split("|")[1] ?? ""}|${port}|${cls}|${drv}|${blk}|${net}\n`

test("usb: only what the node can do without is offered, each refusal says why, and the script only reads", () => {
  const out = U("10c4:ea60", "Silicon Labs|CP210x UART Bridge", "1-2", "00,ff", "cp210x") + U("1d6b:0002", "Linux Foundation|2.0 root hub", "1-1", "09") + U("10c4:ea60", "Silicon Labs|dup", "1-2") + U("1a86:7523", "|", "1-3", "ff", "ch341")
    + "noise\n@@usb bad|x|y\n"
  assert.deepEqual(parseUsb(out).map(d => [d.id, d.name, d.refused === null]), [["10c4:ea60", "Silicon Labs CP210x UART Bridge", true], ["1a86:7523", "USB device", true]], "root hubs and repeats are dropped")
  const why = (o: Partial<{ classes: string[]; drivers: string[]; blk: boolean; net: boolean }>) => whyRefused({ classes: ["00"], drivers: [], blk: false, net: false, ...o })
  assert.match(why({ classes: ["09"] })!, /hub/)
  assert.match(why({ classes: ["08"], drivers: ["usb-storage"] })!, /storage device/)
  assert.match(why({ drivers: ["uas"] })!, /storage device/)
  assert.match(why({ blk: true })!, /disk sits behind/)
  assert.match(why({ classes: ["e0"] })!, /wireless controller/)
  for (const d of ["r8152", "ax88179_178a", "cdc_ether", "rndis_host", "asix", "cdc_ncm"]) assert.match(why({ classes: ["02", "0a"], drivers: [d] })!, /network adapter/, d)
  assert.match(why({ net: true })!, /network adapter/)
  assert.match(why({ classes: ["02", "0a"], drivers: ["option"] })!, /modem or network device/)
  assert.equal(why({ classes: ["02", "0a"], drivers: ["cdc_acm", "cdc_acm"] }), null, "a CDC serial stick (Zigbee, Z-Wave) is what this is for")
  assert.equal(why({ drivers: ["cp210x"] }), null); assert.equal(why({ classes: ["03"], drivers: ["usbhid"] }), null)
  const mixed = parseUsb(U("0781:5581", "SanDisk|Ultra", "1-4", "00,08", "usb-storage", 1) + U("0bda:8153", "Realtek|LAN", "1-5", "00,ff", "r8152", 0, 1) + U("10c4:ea60", "Silicon Labs|CP210x", "1-2", "ff", "cp210x"))
  assert.deepEqual(mixed.map(d => d.refused === null), [false, false, true])
  assert.match(HAVM_USB_SCRIPT, /bInterfaceClass/); assert.match(HAVM_USB_SCRIPT, /\/sys\/block/); assert.match(HAVM_USB_SCRIPT, /\/sys\/class\/net/)
  assert.doesNotMatch(HAVM_USB_SCRIPT, /\b(rm|mv|chmod|tee)\b|[^2]>\s*\/(?!dev\/null)|qm /)
})

test("usb: a choice must still be plugged in and safe, and identical devices are told apart by bus-port", () => {
  const list = parseUsb(U("10c4:ea60", "Silicon Labs|CP210x", "1-2", "ff", "cp210x") + U("0781:5581", "SanDisk|Ultra", "1-4", "00,08", "usb-storage", 1))
  assert.deepEqual(resolveUsb(list, ["10c4:ea60"], "node-a"), { hosts: ["10c4:ea60"], errors: [] })
  assert.match(resolveUsb(list, ["0781:5581"], "node-a").errors.join(" "), /SanDisk Ultra \(0781:5581\) cannot be passed in: It is a storage device/)
  assert.match(resolveUsb(list, ["1a86:7523"], "node-a").errors.join(" "), /not plugged into node-a/)
  const two = parseUsb(U("10c4:ea60", "Silicon Labs|CP210x", "1-2", "ff", "cp210x") + U("10c4:ea60", "Silicon Labs|CP210x", "1-3.1", "ff", "cp210x"))
  assert.deepEqual(two.map(d => d.id), ["1-2", "1-3.1"], "identical devices are named by where they are plugged in")
  assert.deepEqual(resolveUsb(two, ["1-3.1"], "node-a"), { hosts: ["1-3.1"], errors: [] })
  assert.match(resolveUsb(two, ["10c4:ea60"], "node-a").errors.join(" "), /More than one device is 10c4:ea60; pick the one you mean/)
})

// ── Home Assistant, as a fake ───────────────────────────────────────────────

class FakeHa {
  stage: "down" | "waiting" | "done" = "waiting"; polls = 0; downPolls = 0
  trusted = false; config = "# Loads default set of integrations.\ndefault_config:\n"; restarts = 0; users: any[] = []
  cutOnUpdate = false; homeName = ""; tz = ""; steps: string[] = []; network: any[] = []; checkValid = true; keepsConfig = true
  http = async (r: any) => {
    const u = new URL(r.url), p = u.pathname, auth = r.headers?.authorization
    const ok = (body: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) })
    if (p === "/api/onboarding" && r.method === "GET") { if (this.polls++ < this.downPolls) throw new Error("ECONNREFUSED"); return this.stage === "done" ? ok({}, 404) : ok([{ step: "user", done: false }, { step: "core_config", done: false }]) }
    if (p === "/api/onboarding/users") { if (this.stage === "done") return ok({}, 403); this.users.push(r.json); assert.equal(r.json.client_id, `http://${u.host}/`); return ok({ auth_code: "code-1" }) }
    if (p === "/auth/token") { assert.equal(r.form.code, "code-1"); return ok({ access_token: "owner-token" }) }
    if (/^\/api\/onboarding\/(core_config|analytics|integration)$/.test(p)) { assert.equal(auth, "Bearer owner-token"); this.steps.push(p.split("/").pop()!); return ok({}) }
    if (p === "/api/config") return ok({ location_name: this.homeName, time_zone: this.tz })
    if (p === "/api/") return auth === "Bearer ll-token-0123456789abcdef" ? ok({ message: "API running." }) : ok({}, 401)
    if (p === "/manifest.json") return r.headers?.["x-forwarded-for"] && !this.trusted ? ok({}, 400) : ok({ name: "Home Assistant" })
    if (p === "/api/config/core/check_config") return ok({ result: this.checkValid ? "valid" : "invalid" })
    if (p === "/api/services/homeassistant/restart") { this.restarts++; this.trusted = /trusted_proxies/.test(this.config) && this.keepsConfig; return ok([]) }
    return ok({}, 404)
  }
  socket = async (_ip: string, token: string) => {
    assert.ok(token === "owner-token" || token === "ll-token-0123456789abcdef")
    const me = this
    return {
      calls: [] as any[],
      async call(m: any) {
        this.calls.push(m)
        if (m.type === "config/core/update") { me.homeName = m.location_name; me.tz = m.time_zone; return null }
        if (m.type === "auth/long_lived_access_token") return "ll-token-0123456789abcdef"
        if (m.type === "supervisor/api" && m.endpoint === "/network/info") return { interfaces: [{ interface: "enp0s18", primary: true, enabled: true }] }
        if (m.type === "supervisor/api") { me.network.push(m); if (me.cutOnUpdate) throw new Error("The connection to Home Assistant closed."); return {} }
        throw new Error("unexpected " + m.type)
      },
      close() {},
    }
  }
  agent = {
    reads: 0,
    truncated: false,
    read: async (_n: string, _v: number, path: string) => { assert.equal(path, CONFIG_PATH); return { content: this.config, truncated: this.agent.truncated } },
    write: async (_n: string, _v: number, path: string, content: string) => { assert.equal(path, CONFIG_PATH); this.config = content },
  }
}

test("onboarding: waits for Home Assistant, makes the owner, sets the home, finishes the steps, and makes a token it proves; an already set up one is never taken over", async () => {
  const ha = new FakeHa(); ha.downPolls = 3
  assert.equal(await waitForHomeAssistant("10.0.0.52", { http: ha.http as any, wait: async () => {} }), "waiting")
  assert.equal(await onboardingState("10.0.0.52", (async () => { throw new Error("x") }) as any), "down")
  const out = await onboard({ ip: "10.0.0.52", name: "Home", owner: { name: "Me", username: "owner", password: "pw-1" }, timeZone: "America/Toronto", units: "metric" }, { http: ha.http as any, socket: ha.socket as any })
  assert.deepEqual(out, { accessToken: "ll-token-0123456789abcdef" })
  assert.deepEqual(ha.users[0], { client_id: "http://10.0.0.52:8123/", name: "Me", username: "owner", password: "pw-1", language: "en" })
  assert.deepEqual([ha.homeName, ha.tz], ["Home", "America/Toronto"]); assert.deepEqual(ha.steps, ["core_config", "analytics", "integration"])
  const done = new FakeHa(); done.stage = "done"
  assert.equal(await onboardingState("10.0.0.52", done.http as any), "finished")
  await assert.rejects(onboard({ ip: "10.0.0.52", name: "Home", owner: { name: "Me", username: "owner", password: "pw-1" }, timeZone: "UTC", units: "metric" }, { http: done.http as any, socket: done.socket as any }), /already set up/)
  assert.equal(await waitForHomeAssistant("10.0.0.52", { http: (async () => { throw new Error("x") }) as any, wait: async () => {} }, 3), null)
})

test("static address: the primary interface is changed through Home Assistant's own network settings, with the gateway and DNS", async () => {
  const ha = new FakeHa(); const sock: any = await ha.socket("x", "owner-token")
  await setStaticAddress(sock, { address: "10.0.0.60/24", gateway: "10.0.0.1", dns: ["10.0.0.53"] })
  assert.deepEqual(ha.network[0], { type: "supervisor/api", endpoint: "/network/interface/enp0s18/update", method: "post", data: { ipv4: { method: "static", address: ["10.0.0.60/24"], gateway: "10.0.0.1", nameservers: ["10.0.0.53"] } } })
  const bad: any = { call: async () => ({ interfaces: [{ interface: "../x", primary: true, enabled: true }] }) }
  await assert.rejects(setStaticAddress(bad, { address: "10.0.0.60/24" }), /did not say which network interface/)
})

test("trust: only the proxy's own address, through the guest agent, checked and restarted; anything else puts the file back, and a cut-short read is never written back", async () => {
  assert.equal(trustBlock("10.0.0.5/32"), "http:\n  use_x_forwarded_for: true\n  trusted_proxies:\n    - 10.0.0.5/32\n")
  assert.equal(hasHttpSection("default_config:\nhttp:\n  x: 1\n"), true); assert.equal(hasHttpSection("default_config:\n# http: later\n"), false)
  const keep = withTrust("default_config:\n", "10.0.0.5/32"); assert.ok(keep.startsWith("default_config:\n") && keep.endsWith(trustBlock("10.0.0.5/32")))
  const T = { node: "node-a", vmid: 920, ip: "10.0.0.52", token: "ll-token-0123456789abcdef", proxyIp: "10.0.0.5" }
  const mk = (ha: FakeHa) => ({ agentFile: ha.agent, http: ha.http as any, wait: async () => {} })
  const ha = new FakeHa()
  const ok = await trustProxy(T, mk(ha))
  assert.equal(ok.ok, true); assert.match(ok.note, /10\.0\.0\.5 only/)
  assert.ok(ha.config.startsWith("# Loads default set of integrations.\ndefault_config:\n") && ha.config.includes("- 10.0.0.5/32") && ha.restarts === 1)
  assert.doesNotMatch(ha.config, /\/24|0\.0\.0\.0/, "no network around Home Assistant is trusted")
  const bad = new FakeHa(); bad.checkValid = false
  const r1 = await trustProxy(T, mk(bad))
  assert.equal(r1.ok, false); assert.match(r1.note, /put back/); assert.match(r1.note, /trusted_proxies: \[10\.0\.0\.5\/32\]/); assert.ok(!bad.config.includes("trusted_proxies")); assert.equal(bad.restarts, 0)
  const own = new FakeHa(); own.config = "http:\n  server_port: 8123\n"
  assert.match((await trustProxy(T, mk(own))).note, /already has an "http:" section/); assert.equal(own.config, "http:\n  server_port: 8123\n")
  // A read the agent cut short is never written back: that would destroy the rest of the file.
  const cut = new FakeHa(); cut.agent.truncated = true; const before = cut.config
  const r3 = await trustProxy(T, mk(cut))
  assert.equal(r3.ok, false); assert.match(r3.note, /larger than the guest agent will read/); assert.equal(cut.config, before); assert.equal(cut.restarts, 0)
  // No proxy address known, no agent, and a denied read each say what to add by hand (and the privileges Proxmox 9 needs).
  assert.match((await trustProxy({ ...T, proxyIp: undefined }, mk(new FakeHa()))).note, /does not know the proxy's address/)
  assert.match((await trustProxy({ ...T, proxyIp: "proxy.example" }, mk(new FakeHa()))).note, /does not know the proxy's address/)
  assert.match((await trustProxy(T, { http: own.http as any, wait: async () => {} })).note, /cannot edit the machine's files/)
  assert.match((await trustProxy(T, { agentFile: { read: async () => { throw new Error("denied") }, write: async () => {} }, http: own.http as any, wait: async () => {} })).note, /VM\.GuestAgent\.FileRead and FileWrite/)
  // A change Home Assistant does not come back from is put back.
  const dead = new FakeHa(); dead.http = (async (r: any) => (new URL(r.url).pathname === "/manifest.json" ? { status: 502, headers: {}, body: "" } : new FakeHa().http(r))) as any
  const r4 = await trustProxy(T, { agentFile: dead.agent, http: async (r: any) => (new URL(r.url).pathname === "/manifest.json" ? { status: 502, headers: {}, body: "" } : ha.http(r)), wait: async () => {} })
  assert.equal(r4.ok, false); assert.match(r4.note, /did not come back/); assert.ok(!dead.config.includes("trusted_proxies"))
})

// ── The whole job, with fakes ───────────────────────────────────────────────

const mkSteps = () => { const m: Record<string, any> = {}; return { step: (id: string) => (m[id] ??= { status: "running" }), m } }
function setup(o: { ha?: FakeHa; importOut?: string; ip?: string; cfg?: any; usbOut?: string } = {}) {
  const ha = o.ha ?? new FakeHa(); const calls: string[] = []; const vault: any[] = []; const connected: any[] = []; const requests: string[] = []
  const client = {
    fetchStrict: async (path: string, method = "GET") => {
      requests.push(`${method} ${path}`)
      if (path.endsWith("/config")) return o.cfg ?? { scsi0: "pool:vm-920-disk-1,discard=on", bios: "ovmf", usb0: "host=10c4:ea60" }
      if (path.endsWith("/status/start")) return "UPID:start"
      if (path.endsWith("/agent/network-get-interfaces")) return { result: [{ name: "enp0s18", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": o.ip ?? "10.0.0.52" }] }] }
      throw new Error("unexpected " + path)
    },
    waitForTask: async () => {},
  }
  const d: any = {
    client, http: ha.http, socket: ha.socket, wait: async () => {}, agentFile: ha.agent,
    nodeRun: async (_n: string, script: string) => { if (script.includes("bInterfaceClass")) return { code: 0, output: o.usbOut ?? U("10c4:ea60", "Silicon Labs|CP210x", "1-2", "ff", "cp210x") }; calls.push(script); return { code: 0, output: o.importOut ?? "@@ha checked\n@@ha imported\n" } },
    saveSecrets: async (c: string, p: string, v: any) => { vault.push([c, p, v]) },
    connect: async (x: any) => { connected.push(x); return { id: "default", name: x.name } },
  }
  return { ha, d, calls, vault, connected, requests }
}
const hin = (o: any = {}) => ({
  node: "node-a", vmid: 920, plan: { storage: "pool", diskGb: 32, ip: "dhcp" }, image: HAOS_IMAGES.amd64, name: "Home", units: "metric" as const, timeZone: "America/Toronto",
  owner: { name: "Me", username: "owner", password: "pw-1" }, usb: ["10c4:ea60"], vault: { category: "apps", provider: "home-assistant-920" }, publishing: false, proxyIp: "10.0.0.5", ...o,
})

test("job: disk, start, address, first start, owner, token (kept before the plug-in has it), plug-in, and no trust asked for when nothing is published", async () => {
  const s = setup(); const st = mkSteps(); let ip = ""
  const out = await runHaSetup(hin(), st.step, s.d, i => { ip = i })
  assert.deepEqual([out.ip, out.url, out.token, out.trusted, ip], ["10.0.0.52", "http://10.0.0.52:8123", "ll-token-0123456789abcdef", false, "10.0.0.52"])
  assert.equal(s.calls.length, 1); assert.match(s.calls[0], /--usb0 host=10c4:ea60/)
  assert.deepEqual(s.vault, [["apps", "home-assistant-920", { access_token: "ll-token-0123456789abcdef" }]])
  assert.deepEqual(s.connected, [{ name: "Home", url: "http://10.0.0.52:8123", token: "ll-token-0123456789abcdef" }])
  assert.deepEqual(Object.fromEntries(Object.entries(st.m).map(([k, v]: any) => [k, v.status])), { "ha-image": "done", "ha-disk": "done", network: "done", "ha-ready": "done", "ha-onboard": "done", "ha-token": "done", "ha-address": "skipped", "ha-trust": "skipped" })
  assert.ok(s.requests.indexOf("POST /nodes/node-a/qemu/920/status/start") > s.requests.indexOf("GET /nodes/node-a/qemu/920/config"), "started only after the disk read back")
  assert.doesNotMatch(JSON.stringify(st.m), /ll-token-0123456789abcdef|owner-token|pw-1/)
  assert.equal(s.ha.restarts, 0, "Home Assistant is left alone")
})

test("job: a name to publish gets the trust step, and a fixed address is applied and waited for at the new address", async () => {
  const s = setup(); const st = mkSteps(); let ip = ""
  s.ha.http = ((orig) => async (r: any) => (new URL(r.url).hostname === "10.0.0.60" ? orig({ ...r, url: r.url.replace("10.0.0.60", "10.0.0.52") }) : orig(r)))(s.ha.http)
  const out = await runHaSetup(hin({ publishing: true, plan: { storage: "pool", diskGb: 32, ip: "10.0.0.60/24", gateway: "10.0.0.1", dns: "10.0.0.53" } }), st.step, s.d, i => { ip = i })
  assert.deepEqual([out.ip, ip, out.trusted], ["10.0.0.60", "10.0.0.60", true])
  assert.equal(s.ha.network.length, 1); assert.equal(st.m["ha-address"].status, "done"); assert.equal(st.m["ha-trust"].status, "done")
  assert.deepEqual(s.connected[0].url, "http://10.0.0.60:8123", "the plug-in follows the fixed address")
})

test("job: each failure says what to do; a checksum that does not match is never imported; a disk that did not read back never starts", async () => {
  await assert.rejects(runHaSetup(hin(), mkSteps().step, setup({ importOut: "@@ha badsum\n" }).d, () => {}), /did not match its published checksum/)
  await assert.rejects(runHaSetup(hin(), mkSteps().step, setup({ importOut: "@@ha space\n" }).d, () => {}), /less than 4 GB free in \/var\/tmp/)
  await assert.rejects(runHaSetup(hin(), mkSteps().step, setup({ importOut: "" }).d, () => {}), /could not be downloaded to the node/)
  const noDisk = setup({ cfg: { bios: "ovmf" } })
  await assert.rejects(runHaSetup(hin({ usb: [] }), mkSteps().step, noDisk.d, () => {}), /did not read back: the disk \(scsi0\)/)
  assert.ok(!noDisk.requests.some(r => r.endsWith("/status/start")))
  const noUsb = setup({ cfg: { scsi0: "pool:vm-920-disk-1", bios: "ovmf" } })
  await assert.rejects(runHaSetup(hin(), mkSteps().step, noUsb.d, () => {}), /USB device 10c4:ea60/)
  const done = setup(); done.ha.stage = "done"
  await assert.rejects(runHaSetup(hin(), mkSteps().step, done.d, () => {}), /already set up/)
  assert.equal(done.connected.length, 0)
  const slow = setup(); slow.ha.downPolls = 100000
  slow.d.http = async () => { throw new Error("ECONNREFUSED") }
  await assert.rejects(runHaSetup(hin(), mkSteps().step, slow.d, () => {}), /did not answer within thirty minutes/)
})

// ── The wizard, end to end on a fake cluster ────────────────────────────────

/** FakePve that also makes, starts and removes virtual machines. */
class FakeVmPve extends FakePve {
  vmCreates: Array<{ node: string; body: URLSearchParams }> = []; vmDeletes: string[] = []; started: string[] = []; unsupported = false
  async answer(p: string, m: string, body?: string): Promise<any> {
    let r: RegExpExecArray | null
    if (p === "/nodes/node-a/storage") return [
      { storage: "pool", type: "rbd", content: "images,rootdir", active: 1, shared: 1, avail: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 },
      { storage: "tmpl", type: "dir", content: "vztmpl,iso", active: 1, shared: 0, avail: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
    ]
    if (this.unsupported && /^\/nodes\/[^/]+\/status$/.test(p)) return { "current-kernel": { machine: "aarch64" } }
    if (/^\/nodes\/[^/]+\/time$/.test(p)) return { timezone: "America/Toronto" }
    if ((r = /^\/nodes\/([^/]+)\/qemu$/.exec(p)) && m === "POST") {
      const b = new URLSearchParams(body); this.vmCreates.push({ node: r[1], body: b })
      const vmid = Number(b.get("vmid")); this.guests.push({ vmid, type: "qemu", node: r[1], name: b.get("name"), status: "stopped" })
      this.configs[vmid] = { description: b.get("description"), net0: b.get("net0"), bios: b.get("bios"), machine: b.get("machine") }
      return `UPID:${r[1]}:0:0:0:qmcreate:${vmid}:t@pve:`
    }
    if ((r = /^\/nodes\/([^/]+)\/qemu\/(\d+)\/status\/start$/.exec(p))) { this.started.push(r[2]); this.live[Number(r[2])] = { result: [{ name: "enp0s18", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "192.0.2.150" }] }] }; return "UPID:start" }
    if ((r = /^\/nodes\/([^/]+)\/qemu\/(\d+)\/status\/(current|stop)$/.exec(p))) { if (r[3] === "stop") { this.stops.push(r[2]); return "UPID:stop" } return { status: "stopped" } }
    if ((r = /^\/nodes\/([^/]+)\/qemu\/(\d+)\?purge=1/.exec(p)) && m === "DELETE") { this.vmDeletes.push(r[2]); this.guests = this.guests.filter(g => g.vmid !== Number(r![2])); return "UPID:del" }
    return super.answer(p, m, body)
  }
}

function wizard(over: { usbPlugged?: string; free?: number; ha?: FakeHa } = {}) {
  const pve = new FakeVmPve(); const ha = over.ha ?? new FakeHa(); const vault = new Map<string, Record<string, string>>()
  const imports: string[] = []; const connected: any[] = []
  const d = deps(pve, {
    arr: () => ({
      http: ha.http as any,
      nodeRun: async (_n: string, script: string) => {
        if (script.startsWith("df ")) return { code: 0, output: `${over.free ?? 20_000_000}\n` }
        if (script.includes("bInterfaceClass")) return { code: 0, output: over.usbPlugged ?? U("10c4:ea60", "Silicon Labs|CP210x", "1-2", "ff", "cp210x") }
        if (script.includes("qm disk import")) {
          imports.push(script)
          const vmid = Number(/^V=(\d+)/m.exec(script)![1])
          pve.configs[vmid] = { ...pve.configs[vmid], scsi0: `pool:vm-${vmid}-disk-1,discard=on,ssd=1`, ...Object.fromEntries([...script.matchAll(/--usb(\d) host=(\S+)/g)].map(m => [`usb${m[1]}`, `host=${m[2]}`])) }
          return { code: 0, output: "@@ha checked\n@@ha imported\n" }
        }
        throw new Error("unexpected node script")
      },
      pluginSettings: async () => ({}), savePluginSettings: async () => {}, localAddressTo: async () => null, mediaServer: async () => null,
    }) as any,
    ha: () => ({ socket: ha.socket as any, agentFile: ha.agent, timeZone: async () => "America/Toronto", connect: async o => { connected.push(o); return { id: "default", name: o.name } } }),
    saveSecrets: async (c: string, p: string, v: Record<string, string>) => { vault.set(`${c}/${p}`, { ...(vault.get(`${c}/${p}`) ?? {}), ...v }) },
    readSecrets: async (c: string, p: string) => vault.get(`${c}/${p}`) ?? {}, deleteSecrets: async (c: string, p: string) => { vault.delete(`${c}/${p}`) },
  })
  return { pve, ha, vault, imports, connected, d }
}
const input = (o: any = {}) => ({ ...INPUT({ recipeId: "home-assistant", hostname: "ha", vmid: 920, cores: 2, memoryMb: 4096, diskGb: 32, ip: "dhcp", gateway: undefined, dns: undefined }), ...o }) as any

test("wizard preview: a machine plan is checked like a container's, on a storage that holds disk images, with the image resolved from the node's processor", async () => {
  const w = wizard()
  const r = await previewInstall({ ...input(), options: { HA_USB: "10c4:ea60" } }, OWNER, w.d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  assert.equal(r.preview!.plan.template, HAOS_IMAGES.amd64.file)
  assert.ok(r.checks.some(c => /official haos_ova.*published SHA-256/.test(c)) && r.checks.some(c => /room to unpack/.test(c)) && r.checks.some(c => /USB device 10c4:ea60 is plugged into node-a/.test(c)))
  assert.ok(r.warnings.some(w => /ties the machine to node-a/.test(w)) && r.warnings.some(w => /DHCP/.test(w)))
  assert.equal(w.pve.vmCreates.length + w.pve.creates.length, 0, "nothing was made")
  // A storage that holds only containers is refused for a machine.
  const noImages = await previewInstall(input({ storage: "tmpl" }), OWNER, w.d)
  assert.match(noImages.errors.join(" "), /tmpl on node-a cannot hold virtual machine disks/)
  // A taken ID, a missing USB device, too little room on the node and an Arm node are each refused.
  assert.match((await previewInstall(input({ vmid: 101 }), OWNER, w.d)).errors.join(" "), /ID 101 is already used/)
  assert.match((await previewInstall({ ...input(), options: { HA_USB: "1a86:7523" } }, OWNER, w.d)).errors.join(" "), /1a86:7523 is not plugged into node-a/)
  assert.match((await previewInstall(input(), OWNER, wizard({ free: 1_000_000 }).d)).errors.join(" "), /needs about 4 GB while it is unpacked/)
  const arm = wizard(); arm.pve.unsupported = true
  assert.match((await previewInstall(input(), OWNER, arm.d)).errors.join(" "), /not an x86 machine/)
  assert.match((await previewInstall(input(), OWNER, { ...w.d, vaultOpen: async () => false })).errors.join(" "), /vault is locked/)
  assert.match((await previewInstall({ ...input(), options: { HA_USB: "nope" } }, OWNER, w.d)).errors.join(" "), /the code from the list/)
  assert.deepEqual(await homeAssistantUsb("node-a", w.d), [{ id: "10c4:ea60", code: "10c4:ea60", port: "1-2", name: "Silicon Labs CP210x", refused: null }])
})

test("wizard apply: makes the machine through the API, imports the disk, onboards by itself, keeps the owner's password in the vault, and connects the plug-in; no secret in the job", async () => {
  const w = wizard()
  const r = await previewInstall({ ...input(), options: { HA_NAME: "Cottage", HA_UNITS: "us_customary", HA_USB: "10c4:ea60" } }, OWNER, w.d)
  const job = await settled((await applyPreview(r.preview!.id, OWNER, w.d)).jobId)
  assert.equal(job.status, "completed", `${job.error} ${JSON.stringify(job.steps.filter(x => x.status !== "done" && x.status !== "skipped"))}`)
  assert.equal(job.guest, "vm"); assert.equal(w.pve.creates.length, 0, "no container was made"); assert.equal(w.pve.vmCreates.length, 1)
  assert.equal(w.pve.vmCreates[0].body.get("vmid"), "920")
  assert.deepEqual(w.pve.started, ["920"])
  assert.equal(w.ha.homeName, "Cottage"); assert.equal(w.ha.tz, "America/Toronto")
  const item = w.vault.get("apps/home-assistant-920")!
  assert.deepEqual(Object.keys(item).sort(), ["access_token", "admin_password", "admin_user"])
  assert.equal(item.admin_user, "owner"); assert.equal(w.ha.users[0].password, item.admin_password)
  assert.deepEqual(w.connected, [{ name: "Cottage", url: "http://192.0.2.150:8123", token: "ll-token-0123456789abcdef" }])
  assert.deepEqual(job.connected, { plugin: "home-assistant", instanceId: "default" })
  assert.equal(job.ip, "192.0.2.150"); assert.equal(job.url, "http://192.0.2.150:8123")
  assert.ok(!JSON.stringify(job).includes(item.admin_password) && !JSON.stringify(job).includes("ll-token-0123456789abcdef"))
  assert.equal(job.adminCredential!.vault.key, "admin_password")
})

test("wizard apply: a public name is made only once Home Assistant is proved to trust the proxy; otherwise it is left, with the lines to add", async () => {
  const publish = (hosts: any[]): any => ({
    dns: async () => ({ getDomains: async () => [{ domain: "example.test" }], getRecords: async () => [], createRecord: async () => {}, deleteRecord: async () => {} }),
    proxy: { instances: async () => [{ id: "p1", name: "npm", kind: "npm", certificates: "request" }], createHost: async (_i: string, spec: any) => { hosts.push(spec); return { hostId: "h1" } }, attachCertificate: async () => {}, deleteHost: async () => {}, requestCertificate: async () => ({ id: "c1" }), instanceAddress: async () => "10.0.0.5" },
    wanIp: async () => "203.0.113.7", resolve4: async () => ["203.0.113.7"], letsEncryptEmail: () => "ops@example.test",
    fetchPublic: async () => ({ status: 200, body: "{}" }), wait: async () => {},
  })
  const hosts: any[] = []; const w = wizard(); const d = { ...w.d, publish: publish(hosts) }
  const r = await previewInstall({ ...input(), publish: { zone: "example.test", name: "home", instanceId: "p1" } }, OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  const job = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.equal(job.url, "https://home.example.test"); assert.equal(hosts[0].forwardPort, 8123); assert.equal(hosts[0].websockets, true)
  assert.match(w.ha.config, /use_x_forwarded_for: true/); assert.match(w.ha.config, /- 10\.0\.0\.5\/32/); assert.equal(job.steps.find(s => s.id === "ha-trust")!.status, "done")
  // Home Assistant refuses the change: the name is not made, and the finished page says what to add.
  const hosts2: any[] = []; const bad = wizard({ ha: Object.assign(new FakeHa(), { checkValid: false }) }); const d2 = { ...bad.d, publish: publish(hosts2) }
  const r2 = await previewInstall({ ...input(), publish: { zone: "example.test", name: "home", instanceId: "p1" } }, OWNER, d2)
  const j2 = await settled((await applyPreview(r2.preview!.id, OWNER, d2)).jobId)
  assert.equal(j2.status, "completed", j2.error)
  assert.equal(hosts2.length, 0); assert.equal(j2.url, "http://192.0.2.150:8123"); assert.match(j2.haTrustNote!, /use_x_forwarded_for: true/)
  assert.deepEqual(["proxy", "dns", "propagate", "cert", "public"].map(id => j2.steps.find(s => s.id === id)!.status), ["skipped", "skipped", "skipped", "skipped", "skipped"])
})

test("clean-up: a failed machine install is removed through the machine's own API after its mark is checked, with its vault item and the plug-in connection", async () => {
  const w = wizard({ ha: Object.assign(new FakeHa(), { stage: "done" as const }) })
  const r = await previewInstall(input(), OWNER, w.d)
  const job = await settled((await applyPreview(r.preview!.id, OWNER, w.d)).jobId)
  assert.equal(job.status, "failed"); assert.match(job.error!, /already set up/); assert.equal(job.created, true)
  assert.ok(w.vault.has("apps/home-assistant-920"))
  const msg = await removeFailedInstall(job.jobId, OWNER, w.d)
  assert.match(msg, /VM 920 was removed from node-a/); assert.match(msg, /generated login \(apps\/home-assistant-920\) was removed from the vault/)
  assert.deepEqual(w.pve.vmDeletes, ["920"]); assert.deepEqual(w.pve.deletes, [], "no container delete")
  assert.equal(w.vault.has("apps/home-assistant-920"), false)
  await assert.rejects(removeFailedInstall(job.jobId, OWNER, w.d), (e: any) => e.code === "used")
})

test("clean-up: refuses a machine without this install's mark, and a container with the same ID", async () => {
  const w = wizard({ ha: Object.assign(new FakeHa(), { stage: "done" as const }) })
  const r = await previewInstall(input(), OWNER, w.d)
  const job = await settled((await applyPreview(r.preview!.id, OWNER, w.d)).jobId)
  w.pve.configs[920] = { description: "someone else's machine" }
  await assert.rejects(removeFailedInstall(job.jobId, OWNER, w.d), /does not carry this install's mark/)
  assert.deepEqual(w.pve.vmDeletes, [])
  w.pve.guests = w.pve.guests.map(g => (g.vmid === 920 ? { ...g, type: "lxc" } : g))
  await assert.rejects(removeFailedInstall(job.jobId, OWNER, w.d), /is now a container/)
})

test("job: the call that changes Home Assistant's address cannot be answered from the old one; a cut socket is carried on from, and only a new address that never answers fails", async () => {
  const s = setup(); s.ha.cutOnUpdate = true; const st = mkSteps(); let ip = ""
  s.ha.http = ((orig) => async (r: any) => (new URL(r.url).hostname === "10.0.0.60" ? orig({ ...r, url: r.url.replace("10.0.0.60", "10.0.0.52") }) : orig(r)))(s.ha.http)
  const out = await runHaSetup(hin({ plan: { storage: "pool", diskGb: 32, ip: "10.0.0.60/24", gateway: "10.0.0.1" } }), st.step, s.d, i => { ip = i })
  assert.deepEqual([out.ip, ip, st.m["ha-address"].status], ["10.0.0.60", "10.0.0.60", "done"])
  assert.equal(s.ha.network.length, 1, "the update was sent once")
  // The new address never answers: the one failure.
  const n = setup(); n.ha.cutOnUpdate = true
  n.d.http = (async (r: any) => (new URL(r.url).hostname === "10.0.0.60" ? Promise.reject(new Error("ECONNREFUSED")) : n.ha.http(r))) as any
  await assert.rejects(runHaSetup(hin({ plan: { storage: "pool", diskGb: 32, ip: "10.0.0.60/24" } }), mkSteps().step, n.d, () => {}), /did not come back at 10\.0\.0\.60/)
  assert.equal(n.connected.length, 0)
  const waits: number[] = []; n.d.wait = async (ms: number) => { waits.push(ms) }
  await assert.rejects(runHaSetup(hin({ plan: { storage: "pool", diskGb: 32, ip: "10.0.0.60/24" } }), mkSteps().step, n.d, () => {}), /did not come back/)
  assert.ok(waits.length < 1000, "the wait is bounded")
})

test("job: USB devices are looked at again at install time: one that left, or one the node needs, stops it before anything is imported", async () => {
  const gone = setup({ usbOut: "" })
  await assert.rejects(runHaSetup(hin(), mkSteps().step, gone.d, () => {}), /10c4:ea60 is not plugged into node-a.*Nothing was imported/)
  assert.equal(gone.calls.length, 0, "no import ran")
  const disk = setup({ usbOut: U("10c4:ea60", "SanDisk|Ultra", "1-2", "00,08", "usb-storage", 1) })
  await assert.rejects(runHaSetup(hin(), mkSteps().step, disk.d, () => {}), /cannot be passed in: It is a storage device/)
  assert.equal(disk.calls.length, 0)
  const twin = setup({ usbOut: U("10c4:ea60", "A|x", "1-2", "ff", "cp210x") + U("10c4:ea60", "A|x", "1-3", "ff", "cp210x") })
  await assert.rejects(runHaSetup(hin(), mkSteps().step, twin.d, () => {}), /More than one device is 10c4:ea60/)
  const byPort = setup({ usbOut: U("10c4:ea60", "A|x", "1-2", "ff", "cp210x") + U("10c4:ea60", "A|x", "1-3", "ff", "cp210x"), cfg: { scsi0: "pool:vm-920-disk-1", bios: "ovmf", usb0: "host=1-3" } })
  await runHaSetup(hin({ usb: ["1-3"] }), mkSteps().step, byPort.d, () => {})
  assert.match(byPort.calls[0], /--usb0 host=1-3 /, "one of two identical devices is passed in by its bus-port")
})

test("wizard: a plan that passes the preview is refused when the machine's USB device is a disk, and a vault that locks after the preview creates no machine", async () => {
  const w = wizard({ usbPlugged: U("10c4:ea60", "SanDisk|Ultra", "1-2", "00,08", "usb-storage", 1) })
  const r = await previewInstall({ ...input(), options: { HA_USB: "10c4:ea60" } }, OWNER, w.d)
  assert.match(r.errors.join(" "), /cannot be passed in: It is a storage device/); assert.equal(r.preview, undefined)
  const ok = wizard(); let calls = 0
  const d = { ...ok.d, vaultOpen: async () => ++calls < 3 }
  const p = await previewInstall(input(), OWNER, d)
  const job = await settled((await applyPreview(p.preview!.id, OWNER, d)).jobId)
  assert.equal(job.status, "failed"); assert.match(job.error!, /vault is locked/)
  assert.equal(ok.pve.vmCreates.length, 0, "no machine was made")
  assert.equal(job.created, undefined)
})

test("wizard: when the public check through the proxy fails, the error says which address Home Assistant was told to trust", async () => {
  const hosts: any[] = []; const w = wizard()
  const publish: any = {
    dns: async () => ({ getDomains: async () => [{ domain: "example.test" }], getRecords: async () => [], createRecord: async () => {}, deleteRecord: async () => {} }),
    proxy: { instances: async () => [{ id: "p1", name: "npm", kind: "npm", certificates: "request" }], createHost: async (_i: string, spec: any) => { hosts.push(spec); return { hostId: "h1" } }, attachCertificate: async () => {}, deleteHost: async () => {}, requestCertificate: async () => ({ id: "c1" }), instanceAddress: async () => "10.0.0.5" },
    wanIp: async () => "203.0.113.7", resolve4: async () => ["203.0.113.7"], letsEncryptEmail: () => "ops@example.test",
    fetchPublic: async () => ({ status: 400, body: "" }), wait: async () => {},
  }
  const d = { ...w.d, publish }
  const r = await previewInstall({ ...input(), publish: { zone: "example.test", name: "home", instanceId: "p1" } }, OWNER, d)
  const job = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(job.status, "failed"); assert.match(job.error!, /Home Assistant was told to trust 10\.0\.0\.5 only.*trusted_proxies/)
})

test("clean-up: the first Home Assistant instance's address and token go, only this install's entry leaves the instance list, and a plug-in that moved on is left alone", async () => {
  const mk = () => {
    const creds = new Map<string, string>([["home-assistant/url", "http://192.0.2.150:8123"], ["home-assistant/token", "ll"], ["home-assistant/instances", JSON.stringify([{ id: "default", name: "Cottage" }, { id: "h1234abcd", name: "Second home" }])]])
    return { creds, pluginCreds: {
      get: async (p: string, k: string) => creds.get(`${p}/${k}`) ?? null, set: async (p: string, k: string, v: string) => { creds.set(`${p}/${k}`, v) },
      del: async (p: string, k: string) => { creds.delete(`${p}/${k}`) }, delProvider: async (p: string) => { for (const k of [...creds.keys()]) if (k.startsWith(`${p}/`)) creds.delete(k) },
    } }
  }
  const failing = async (c: ReturnType<typeof mk>) => {
    const w = wizard(); const publish: any = {
      dns: async () => ({ getDomains: async () => [{ domain: "example.test" }], getRecords: async () => [], createRecord: async () => {}, deleteRecord: async () => {} }),
      proxy: { instances: async () => [{ id: "p1", name: "npm", kind: "npm", certificates: "request" }], createHost: async () => ({ hostId: "h1" }), attachCertificate: async () => {}, deleteHost: async () => {}, requestCertificate: async () => ({ id: "c1" }), instanceAddress: async () => "10.0.0.5" },
      wanIp: async () => "203.0.113.7", resolve4: async () => ["203.0.113.7"], letsEncryptEmail: () => "ops@example.test", fetchPublic: async () => ({ status: 400, body: "" }), wait: async () => {},
    }
    const d = { ...w.d, publish, pluginCreds: c.pluginCreds }
    const r = await previewInstall({ ...input(), publish: { zone: "example.test", name: "home", instanceId: "p1" } }, OWNER, d)
    const job = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
    assert.equal(job.status, "failed"); assert.deepEqual(job.connected, { plugin: "home-assistant", instanceId: "default" })
    return { job, d }
  }
  const a = mk(); const { job, d } = await failing(a)
  assert.match(await removeFailedInstall(job.jobId, OWNER, d), /Home Assistant plug-in connection this install made was removed/)
  assert.equal(a.creds.has("home-assistant/url"), false); assert.equal(a.creds.has("home-assistant/token"), false)
  assert.deepEqual(JSON.parse(a.creds.get("home-assistant/instances")!), [{ id: "h1234abcd", name: "Second home" }], "the other instance stays listed")
  const b = mk(); const f2 = await failing(b); b.creds.set("home-assistant/url", "http://192.0.2.9:8123")
  assert.match(await removeFailedInstall(f2.job.jobId, OWNER, f2.d), /no longer points at this install/)
  assert.equal(b.creds.get("home-assistant/url"), "http://192.0.2.9:8123"); assert.equal(b.creds.has("home-assistant/instances"), true)
})
