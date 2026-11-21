// The Immich catalogue entry: the recipe and its questions, the compose file per hardware type, the preview's hardware and
// library checks, the setup chores against a fake Immich (administrator, API key, hardware conversion, read-backs), the
// plug-in's readings and fixes, and the install wizard end to end on a fake cluster. Names and addresses are made up.
import { test } from "node:test"
import assert from "node:assert/strict"
import yaml from "js-yaml"
import { CATALOGUE, findRecipe, checkOptions } from "../src/lib/catalogue"
import {
  IMMICH_RECIPE, IMMICH_VERSION, IMMICH_OPTIONS, IMMICH_SCRIPT, IMMICH_KEY_PERMISSIONS, composeFile, immichScriptEnv, checkImmichOptions, ffmpegAccel,
  accelOf, asTranscodeOptions, POSTGRES_IMAGE, VALKEY_IMAGE,
} from "../src/lib/immich/recipe"
import { immichPreview } from "../src/lib/immich/preview"
import { runImmichSetup, waitForImmich } from "../src/lib/immich/setup"
import { readOverview, runAction, parseAction, problemsOf, versionOf, queueOf, ImmichRefusal, QUEUE_NAMES } from "../src/lib/immich/service"
import { immichPlugin, tileOf, detailOf } from "../src/plugins/immich"
import { parseHardware } from "../src/lib/transcode/hardware"
import { NVIDIA_RUN_SHA256, TC_SCRIPT } from "../src/lib/transcode/compose"
import { installScript } from "../src/lib/install-script"
import { previewInstall, applyPreview, removeFailedInstall } from "../src/lib/catalogue-installer"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const OWNER = "a@example.com"

const INTEL = ["##lspci", "0000:00:02.0 VGA compatible controller [0300]: Intel Corporation UHD Graphics 630 [8086:3e92] (rev 02)", "\tKernel driver in use: i915",
  "##dri", "/dev/dri/card0|0000:00:02.0|e2:0", "/dev/dri/renderD128|0000:00:02.0|e2:80", "##tcgroups", "render:x:993:", "video:x:44:", "##end"].join("\n")
const AMD = INTEL.replace("Intel Corporation UHD Graphics 630 [8086:3e92]", "Advanced Micro Devices, Inc. [AMD/ATI] Radeon RX 6600 [1002:73ff]")
const NVIDIA = ["##lspci", "0000:0a:00.0 VGA compatible controller [0300]: NVIDIA Corporation GP104 [GeForce GTX 1070 Ti] [10de:1b82] (rev a1)", "\tKernel driver in use: nvidia",
  "##nvidia", "00000000:0A:00.0, NVIDIA GeForce GTX 1070 Ti, 580.173.02, 8192 MiB", "##nvdev", "/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools",
  "##nvmodule", "580.173.02", "##tcgroups", "render:x:992:", "video:x:44:", "##end"].join("\n")
const BARE = "##lspci\n##tcgroups\nrender:x:993:\nvideo:x:44:\n##end\n"

// ── The recipe ──────────────────────────────────────────────────────────────

test("recipe: a pinned release, an admin from the vault, the settings it asks, and the words people search for", () => {
  assert.equal(findRecipe("immich"), IMMICH_RECIPE)
  assert.match(IMMICH_VERSION, /^v\d+\.\d+\.\d+$/)
  assert.equal(IMMICH_RECIPE.setup, "immich")
  assert.equal(IMMICH_RECIPE.firstRun.kind, "env-admin")
  assert.equal((IMMICH_RECIPE.firstRun as any).secrets[0].vaultKey, "db_password")
  assert.equal(IMMICH_RECIPE.publishable, true)
  assert.match(IMMICH_RECIPE.proxyAdvanced!, /client_max_body_size 0;/)
  assert.match(IMMICH_RECIPE.proxyAdvanced!, /proxy_read_timeout 600s;/)
  assert.ok(IMMICH_RECIPE.keywords!.includes("google photos"))
  assert.equal(CATALOGUE.filter(r => r.id === "immich").length, 1)
  // Resource requirements are shown before anything runs.
  assert.deepEqual(IMMICH_RECIPE.minimum, { cores: 2, memoryMb: 4096, diskGb: 16 })
  assert.deepEqual(IMMICH_RECIPE.defaults, { cores: 4, memoryMb: 6144, diskGb: 24, swapMb: 1024 })
  // The administrator's key may read the numbers and look after the queues, and cannot read a photo.
  assert.ok(!IMMICH_KEY_PERMISSIONS.some(p => /^asset\.|^album/.test(p)))
  assert.ok(IMMICH_KEY_PERMISSIONS.includes("queue.update" as any))
})

test("options: a menu refuses any other answer, and a NAS or a folder needs its address", () => {
  const ok = checkOptions(IMMICH_RECIPE, { IMMICH_ADMIN_EMAIL: "me@example.com" })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.values.IMMICH_LIBRARY, "disk"); assert.equal(ok.values.IMMICH_ACCEL, "cpu"); assert.equal(ok.values.IMMICH_LIBRARY_GB, "200")
  assert.match(checkOptions(IMMICH_RECIPE, { IMMICH_ADMIN_EMAIL: "me@example.com", IMMICH_ACCEL: "tpu" }).errors.join(" "), /Hardware acceleration: pick one of/)
  assert.match(checkOptions(IMMICH_RECIPE, { IMMICH_ADMIN_EMAIL: "me@example.com", IMMICH_LIBRARY: "usb" }).errors.join(" "), /Where the photos live: pick one of/)
  assert.match(checkOptions(IMMICH_RECIPE, {}).errors.join(" "), /Administrator email is required/)
  assert.match(checkOptions(IMMICH_RECIPE, { IMMICH_ADMIN_EMAIL: "not an email" }).errors.join(" "), /not an email address/)
  assert.deepEqual(checkImmichOptions({ IMMICH_LIBRARY: "nfs" }), ["A NAS folder needs the NAS address and the export."])
  assert.deepEqual(checkImmichOptions({ IMMICH_LIBRARY: "path" }), ["An existing folder needs its path on the node."])
  assert.deepEqual(checkImmichOptions({ IMMICH_LIBRARY: "disk" }), [])
  // Each conditional question names the answer that shows it.
  const when = (k: string) => IMMICH_OPTIONS.find(o => o.key === k)!.showWhen
  assert.deepEqual(when("IMMICH_NFS_HOST"), { key: "IMMICH_LIBRARY", value: "nfs" })
  assert.deepEqual(when("IMMICH_HOST_PATH"), { key: "IMMICH_LIBRARY", value: "path" })
  assert.deepEqual(when("IMMICH_LIBRARY_GB"), { key: "IMMICH_LIBRARY", value: "disk" })
  // The wizard's library answers reach the transcoders' own layout code under its names.
  assert.deepEqual(asTranscodeOptions({ IMMICH_LIBRARY: "nfs", IMMICH_NFS_HOST: "nas", IMMICH_NFS_EXPORT: "/p", IMMICH_ACCEL: "vaapi" }).TC_MEDIA, "nfs")
  assert.equal(accelOf({ IMMICH_ACCEL: "nvidia" }), "nvidia"); assert.equal(accelOf({ IMMICH_ACCEL: "x" }), "cpu")
})

// ── The compose file ────────────────────────────────────────────────────────

const parse = (c: string): any => yaml.load(c)

test("compose: four services pinned by version and digest, a database password that is never in the file, one user for the library", () => {
  const c = composeFile({ accel: "cpu" })
  const y = parse(c)
  assert.deepEqual(Object.keys(y.services), ["immich-server", "immich-machine-learning", "redis", "database"])
  assert.equal(y.services["immich-server"].image, "ghcr.io/immich-app/immich-server:${IMMICH_VERSION}")
  assert.equal(y.services["immich-machine-learning"].image, "ghcr.io/immich-app/immich-machine-learning:${IMMICH_VERSION}")
  assert.match(POSTGRES_IMAGE, /@sha256:[0-9a-f]{64}$/); assert.match(POSTGRES_IMAGE, /vectorchord/)
  assert.match(VALKEY_IMAGE, /@sha256:[0-9a-f]{64}$/)
  assert.equal(y.services.database.image, POSTGRES_IMAGE); assert.equal(y.services.redis.image, VALKEY_IMAGE)
  assert.doesNotMatch(c, /:latest|:release\b/)
  assert.match(c, /DB_PASSWORD: \$\{DB_PASSWORD\}/)
  assert.deepEqual(y.services["immich-server"].volumes, ["/data/immich:/data", "/etc/localtime:/etc/localtime:ro"])
  assert.equal(y.services["immich-server"].user, "1000:1000")
  assert.deepEqual(y.services["immich-server"].ports, ["2283:2283"])
  assert.equal(y.services["immich-server"].devices, undefined); assert.equal(y.services["immich-server"].runtime, undefined)
})

test("compose: Intel graphics share /dev/dri with both services and run recognition on OpenVINO; AMD shares it for video only; NVIDIA uses its runtime and the CUDA build", () => {
  const intel = parse(composeFile({ accel: "vaapi", groups: [993], intel: true }))
  assert.deepEqual(intel.services["immich-server"].devices, ["/dev/dri:/dev/dri"]); assert.deepEqual(intel.services["immich-server"].group_add, ["993"])
  assert.equal(intel.services["immich-machine-learning"].image, "ghcr.io/immich-app/immich-machine-learning:${IMMICH_VERSION}-openvino")
  assert.deepEqual(intel.services["immich-machine-learning"].devices, ["/dev/dri:/dev/dri"])
  const amd = parse(composeFile({ accel: "vaapi", groups: [993], intel: false }))
  assert.deepEqual(amd.services["immich-server"].devices, ["/dev/dri:/dev/dri"])
  assert.equal(amd.services["immich-machine-learning"].image, "ghcr.io/immich-app/immich-machine-learning:${IMMICH_VERSION}", "AMD recognition stays on the processor")
  assert.equal(amd.services["immich-machine-learning"].devices, undefined)
  const nv = parse(composeFile({ accel: "nvidia" }))
  assert.equal(nv.services["immich-server"].runtime, "nvidia"); assert.equal(nv.services["immich-machine-learning"].runtime, "nvidia")
  assert.equal(nv.services["immich-machine-learning"].image, "ghcr.io/immich-app/immich-machine-learning:${IMMICH_VERSION}-cuda")
  assert.equal(nv.services["immich-server"].environment.NVIDIA_DRIVER_CAPABILITIES, "compute,video,utility")
  assert.throws(() => composeFile({ accel: "vaapi", groups: [-1] }), /Bad group id/)
})

test("script and environment: the node's driver version needs a pinned checksum, and nothing secret is in the script's own text", () => {
  const env = immichScriptEnv({ accel: "cpu" })
  assert.equal(env.TC_ACCEL, "cpu"); assert.equal(env.IMMICH_TAG, IMMICH_VERSION)
  assert.ok(parse(Buffer.from(env.IMMICH_COMPOSE_B64, "base64").toString()).services)
  const nv = immichScriptEnv({ accel: "nvidia", nvidiaVersion: "580.173.02" })
  assert.equal(nv.TC_NVIDIA_SHA256, NVIDIA_RUN_SHA256["580.173.02"])
  assert.throws(() => immichScriptEnv({ accel: "nvidia" }), /missing or not a version/)
  assert.throws(() => immichScriptEnv({ accel: "nvidia", nvidiaVersion: "999.99.99" }), /no pinned checksum/)
  // The shared NVIDIA block is the same text the transcoders run.
  const block = TC_SCRIPT.slice(TC_SCRIPT.indexOf("# NVIDIA: the node's driver"), TC_SCRIPT.indexOf("printf '%s' \"$TC_COMPOSE_B64\""))
  assert.ok(block.length > 500 && IMMICH_SCRIPT.includes(block.trim()), "one NVIDIA block, shared")
  assert.doesNotMatch(IMMICH_SCRIPT, /PASSWORD=[A-Za-z0-9]{6,}/)
  assert.match(IMMICH_SCRIPT, /umask 077; \{ printf 'IMMICH_VERSION=%s\\n'/)
  assert.match(IMMICH_SCRIPT, /for s in \$\(docker compose config --services\)/)
  const run = installScript(IMMICH_RECIPE, "debian", { ...immichScriptEnv({ accel: "cpu" }), IMMICH_DB_PASSWORD: "db-secret-1", IMMICH_ADMIN_PASSWORD: "admin-secret-1" })
  assert.match(run, /^export IMMICH_DB_PASSWORD='db-secret-1'$/m)
  assert.throws(() => installScript(IMMICH_RECIPE, "debian", {}), /needs IMMICH_ADMIN_PASSWORD/)
  assert.deepEqual([ffmpegAccel("nvidia", {} as any), ffmpegAccel("cpu", {} as any), ffmpegAccel("vaapi", parseHardware("n", INTEL)), ffmpegAccel("vaapi", parseHardware("n", AMD))], ["nvenc", "disabled", "qsv", "vaapi"])
})

// ── The preview ─────────────────────────────────────────────────────────────

function arrFor(hw: Record<string, string>, over: { writable?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    arr: (): any => ({
      http: async () => ({ status: 404, headers: {}, body: "" }),
      nodeRun: async (node: string, script: string) => {
        calls.push(script)
        if (script.includes("##tcgroups")) return { code: 0, output: hw[node] ?? BARE }
        return { code: 0, output: `@@arr resolved /mnt/photos\n@@arr reachable\n@@arr owner 101000:101000\n@@arr space 1099511627776 2199023255552\n@@arr fstype ext4\n${over.writable === false ? "@@arr readonly /mnt/photos\n" : "@@arr writable\n"}` }
      },
      pluginSettings: async () => ({}), savePluginSettings: async () => {}, localAddressTo: async () => null, mediaServer: async () => null,
    }),
  }
}
const values = (o: Record<string, string> = {}) => checkOptions(IMMICH_RECIPE, { IMMICH_ADMIN_EMAIL: "me@example.com", ...o }).values
const pin = { node: "node-a", vmid: 910, storage: "pool", diskGb: 24, storageFreeGb: 500 }

test("preview: no acceleration is the default and looks at nothing on the node's hardware", async () => {
  const f = arrFor({ "node-a": NVIDIA })
  const r = await immichPreview({ ...pin, values: values() }, { arr: f.arr })
  assert.deepEqual(r.errors, [])
  assert.equal(r.options.IMMICH_ACCEL, "cpu"); assert.equal(r.options.IMMICH_FFMPEG, "disabled")
  assert.ok(r.checks.some(c => /acceleration is off/.test(c)))
  assert.ok(!f.calls.some(c => c.includes("##tcgroups")), "the hardware was not looked at")
  assert.ok(r.checks.some(c => /new 200 GB disk on pool/.test(c)) && r.checks.some(c => /keyctl/.test(c)))
})

test("preview: a choice is resolved against the node; Intel, AMD and NVIDIA each say what runs where; one the node cannot honour is refused, and the request's driver version is dropped", async () => {
  const intel = await immichPreview({ ...pin, values: values({ IMMICH_ACCEL: "vaapi" }) }, { arr: arrFor({ "node-a": INTEL }).arr })
  assert.deepEqual(intel.errors, [])
  assert.deepEqual([intel.options.IMMICH_ACCEL, intel.options.IMMICH_FFMPEG, intel.options.IMMICH_INTEL], ["vaapi", "qsv", "1"])
  assert.ok(intel.checks.some(c => /Quick Sync/.test(c) && /OpenVINO/.test(c)))
  const amd = await immichPreview({ ...pin, values: values({ IMMICH_ACCEL: "vaapi" }) }, { arr: arrFor({ "node-a": AMD }).arr })
  assert.deepEqual([amd.options.IMMICH_FFMPEG, amd.options.IMMICH_INTEL], ["vaapi", "0"])
  assert.ok(amd.checks.some(c => /recognition stays on the processor/.test(c)))
  const nv = await immichPreview({ ...pin, values: { ...values({ IMMICH_ACCEL: "nvidia" }), TC_NVIDIA_VERSION: "1.2.3" } }, { arr: arrFor({ "node-a": NVIDIA }).arr })
  assert.deepEqual([nv.options.TC_NVIDIA_VERSION, nv.options.IMMICH_FFMPEG], ["580.173.02", "nvenc"])
  assert.ok(nv.warnings.some(w => /exactly version 580\.173\.02/.test(w)))
  assert.ok(!nv.warnings.some(w => /CPU/.test(w)))
  const none = await immichPreview({ ...pin, values: values({ IMMICH_ACCEL: "nvidia" }) }, { arr: arrFor({ "node-a": BARE }).arr })
  assert.match(none.errors.join(" "), /no NVIDIA card with a loaded driver/)
  const noIntel = await immichPreview({ ...pin, values: values({ IMMICH_ACCEL: "vaapi" }) }, { arr: arrFor({ "node-a": BARE }).arr })
  assert.match(noIntel.errors.join(" "), /no Intel or AMD graphics/)
  const driver = await immichPreview({ ...pin, values: values({ IMMICH_ACCEL: "nvidia" }) }, { arr: arrFor({ "node-a": NVIDIA.replace(/580\.173\.02/g, "590.99.01") }).arr })
  assert.match(driver.errors.join(" "), /no pinned checksum/)
})

test("preview: a new disk must fit, and a folder the container's user cannot write is refused before anything is made", async () => {
  const small = await immichPreview({ ...pin, storageFreeGb: 100, values: values() }, { arr: arrFor({}).arr })
  assert.match(small.errors.join(" "), /pool has 100 GB free: not enough for the 24 GB container and a 200 GB photo disk/)
  const ro = await immichPreview({ ...pin, values: values({ IMMICH_LIBRARY: "path", IMMICH_HOST_PATH: "/mnt/photos" }) }, { arr: arrFor({}, { writable: false }).arr })
  assert.match(ro.errors.join(" "), /not writable by the container's user/)
  const ok = await immichPreview({ ...pin, values: values({ IMMICH_LIBRARY: "path", IMMICH_HOST_PATH: "/mnt/photos" }) }, { arr: arrFor({}).arr })
  assert.deepEqual(ok.errors, [])
  assert.ok(ok.checks.some(c => /"immich" folder inside that library/.test(c)))
  const bad = await immichPreview({ ...pin, values: values({ IMMICH_LIBRARY: "path", IMMICH_HOST_PATH: "../etc" }) }, { arr: arrFor({}).arr })
  assert.ok(bad.errors.length)
  assert.match((await immichPreview({ ...pin, values: values() }, {})).errors.join(" "), /cannot reach the node/)
})

// ── The setup chores, against a fake Immich ─────────────────────────────────

class FakeImmich {
  loginFails = false; pw = ""; admins = 0; signIns = 0; keys: any[] = []; config: any = { ffmpeg: { accel: "disabled", accelDecode: false, crf: 23 }, server: {} }
  puts: any[] = []; refuseKey = false; refuseUp = false; keepConfig = true; readsBeforeUp = 0; order: string[] = []
  http = async (r: any) => {
    const u = new URL(r.url), p = u.pathname
    const ok = (status: number, body: unknown) => ({ status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) })
    this.order.push(`${r.method} ${p}`)
    if (p === "/api/server/ping") return this.readsBeforeUp-- > 0 ? ok(503, "") : ok(200, { res: "pong" })
    if (p === "/api/auth/admin-sign-up") { if (this.admins || this.refuseUp) return ok(400, { message: "The server already has an admin" }); this.admins++; this.pw = r.json.password; assert.equal(r.json.email, "me@example.com"); return ok(201, { id: "u1" }) }
    if (p === "/api/auth/login") { this.signIns++; return !this.loginFails && r.json.password === this.pw ? ok(201, { accessToken: "jwt-1" }) : ok(401, {}) }
    if (p === "/api/api-keys") { if (this.refuseKey) return ok(403, {}); assert.equal(r.headers.authorization, "Bearer jwt-1"); this.keys.push(r.json); return ok(201, { secret: "key-abc", apiKey: {} }) }
    if (p === "/api/server/statistics") return r.headers["x-api-key"] === "key-abc" ? ok(200, { photos: 1 }) : ok(401, {})
    if (p === "/api/system-config" && r.method === "GET") return ok(200, structuredClone(this.config))
    if (p === "/api/system-config" && r.method === "PUT") { this.puts.push(r.json); if (this.keepConfig) this.config = r.json; return ok(200, r.json) }
    return ok(404, "")
  }
}
const steps = () => { const m: Record<string, any> = {}; return { step: (id: string) => (m[id] ??= { status: "running" }), m } }
const sdeps = (f: FakeImmich, store: { vault: any[]; plugin: Record<string, Record<string, string>> }) => ({
  http: f.http as any, wait: async () => {},
  saveSecrets: async (c: string, p: string, v: Record<string, string>) => { f.order.push("vault"); store.vault.push([c, p, v]) },
  savePluginSettings: async (id: string, v: Record<string, string>) => { f.order.push("plugin"); store.plugin[id] = v },
  pluginSettings: async (id: string) => store.plugin[id] ?? {},
})
const input = (o: any = {}) => ({ ip: "10.0.0.50", admin: { email: "me@example.com", name: "Me", password: "pw-1" }, ffmpeg: "disabled" as const, vault: { category: "apps", provider: "immich-910" }, ...o })

test("setup: waits for Immich, makes the administrator, makes a key that cannot read a photo, keeps it in the vault, connects the plug-in and proves the key", async () => {
  const f = new FakeImmich(); f.readsBeforeUp = 3; const store = { vault: [] as any[], plugin: {} as any }; const s = steps()
  const out = await runImmichSetup(input(), s.step, sdeps(f, store))
  assert.deepEqual(out, { url: "http://10.0.0.50:2283", keyName: "HyperProx", connected: true })
  assert.deepEqual(f.keys[0].permissions, [...IMMICH_KEY_PERMISSIONS]); assert.equal(f.keys[0].name, "HyperProx")
  assert.deepEqual(store.vault, [["apps", "immich-910", { api_key: "key-abc" }]])
  assert.deepEqual(store.plugin.immich, { url: "http://10.0.0.50:2283", key: "key-abc" })
  assert.ok(f.order.indexOf("vault") < f.order.indexOf("plugin"), "the vault holds the key before the plug-in is given it")
  assert.ok(f.order.indexOf("plugin") < f.order.indexOf("GET /api/server/statistics"), "the key is proved after it is stored")
  assert.deepEqual(Object.values(s.m).map((x: any) => x.status), ["done", "done", "done", "skipped"])
  assert.doesNotMatch(JSON.stringify(Object.values(s.m)), /key-abc|jwt-1|pw-1/, "no secret in the step details")
})

test("setup: hardware video conversion is set in Immich's own settings and read back; a setting it does not keep is an error", async () => {
  const f = new FakeImmich(); const store = { vault: [] as any[], plugin: {} as any }
  const s = steps()
  await runImmichSetup(input({ ffmpeg: "qsv" }), s.step, sdeps(f, store))
  assert.deepEqual([f.config.ffmpeg.accel, f.config.ffmpeg.accelDecode, f.config.ffmpeg.crf], ["qsv", true, 23], "only the two fields change")
  assert.equal(s.m["immich-hw"].status, "done"); assert.match(s.m["immich-hw"].detail, /Quick Sync/)
  const g = new FakeImmich(); g.keepConfig = false
  await assert.rejects(runImmichSetup(input({ ffmpeg: "nvenc" }), steps().step, sdeps(g, { vault: [], plugin: {} })), /did not keep the hardware conversion setting/)
})

test("setup: an Immich that already has an administrator is never taken over, a refused key is said, and a bad answer to the sign-in stops it", async () => {
  const taken = new FakeImmich(); taken.refuseUp = true
  await assert.rejects(runImmichSetup(input(), steps().step, sdeps(taken, { vault: [], plugin: {} })), /already has an administrator/)
  assert.equal(taken.keys.length, 0)
  const k = new FakeImmich(); k.refuseKey = true; const store = { vault: [] as any[], plugin: {} as any }
  await assert.rejects(runImmichSetup(input(), steps().step, sdeps(k, store)), /would not make HyperProx's API key \(it answered 403\)/)
  assert.deepEqual(store.vault, [], "nothing was kept for a key that was never made")
  const bl = new FakeImmich(); bl.loginFails = true
  await assert.rejects(runImmichSetup(input(), steps().step, sdeps(bl, { vault: [], plugin: {} })), /could not sign in \(Immich answered 401\)/)
  const slow = new FakeImmich(); slow.readsBeforeUp = 10_000
  assert.equal(await waitForImmich("10.0.0.50", { http: slow.http as any, wait: async () => {} }, 3), false)
})

test("setup: a plug-in that already follows another Immich is left alone; the new key is still in the vault", async () => {
  const f = new FakeImmich(); const store = { vault: [] as any[], plugin: { immich: { url: "http://10.0.0.9:2283", key: "old" } } as any }
  const s = steps()
  const out = await runImmichSetup(input(), s.step, sdeps(f, store))
  assert.equal(out.connected, false)
  assert.deepEqual(store.plugin.immich, { url: "http://10.0.0.9:2283", key: "old" })
  assert.equal(store.vault[0][2].api_key, "key-abc")
  assert.match(s.m["immich-key"].detail, /already follows another Immich/)
})

// ── The plug-in's readings and fixes ────────────────────────────────────────

const q = (name: string, o: any = {}) => ({ name, isPaused: false, statistics: { active: 0, waiting: 0, failed: 0, delayed: 0, completed: 5, paused: 0, ...o } })
function fakeClient(queues: any[], over: Partial<Record<string, any>> = {}) {
  const calls: string[] = []
  const state = new Map(queues.map(x => [x.name, structuredClone(x)]))
  return {
    calls, state,
    client: {
      get: async (path: string) => {
        calls.push(`GET ${path}`)
        if (path === "/api/server/statistics") return over.stats ?? { photos: 1200, videos: 30, usage: 5 * 1024 ** 3, usagePhotos: 3 * 1024 ** 3, usageVideos: 2 * 1024 ** 3, usageByUser: [{ userName: "Ana", photos: 1000, videos: 20, usage: 4 * 1024 ** 3, quotaSizeInBytes: null }, { userName: "Ben", photos: 200, videos: 10, usage: 1024 ** 3, quotaSizeInBytes: 10 * 1024 ** 3 }] }
        if (path === "/api/server/version") return over.version ?? { major: 3, minor: 4, patch: 2, prerelease: null }
        if (path === "/api/server/version-check") return over.check ?? { checkedAt: "2026-11-20T00:00:00Z", releaseVersion: "v3.4.2" }
        if (path === "/api/queues") return [...state.values()]
        const m = /^\/api\/queues\/(\w+)$/.exec(path)
        if (m) return structuredClone(state.get(m[1]))
        throw new Error(`unexpected ${path}`)
      },
      put: async (path: string, body: any) => {
        calls.push(`PUT ${path} ${JSON.stringify(body)}`)
        let m = /^\/api\/queues\/(\w+)$/.exec(path)
        if (m) { state.get(m[1]).isPaused = body.isPaused; return {} }
        m = /^\/api\/jobs\/(\w+)$/.exec(path)
        if (m && body.command === "clear-failed" && !over.stuckFailed) { state.get(m[1]).statistics.failed = 0; return {} }
        if (m) return {}
        throw new Error(`unexpected ${path}`)
      },
    },
  }
}

test("overview: the numbers, who uses what, the version and the update, and each queue's trouble with its fix", async () => {
  const f = fakeClient([q("thumbnailGeneration", { active: 2, waiting: 10 }), q("videoConversion", { failed: 3 }), { ...q("smartSearch", { waiting: 4 }), isPaused: true }, q("library"), { name: "bogus", statistics: {} }])
  const o = await readOverview(f.client)
  assert.deepEqual([o.photos, o.videos, o.bytes, o.version], [1200, 30, 5 * 1024 ** 3, "v3.4.2"])
  assert.equal(o.users[0].name, "Ana"); assert.equal(o.users[1].quotaBytes, 10 * 1024 ** 3)
  assert.equal(o.queues.length, 4, "an unknown queue name is dropped")
  assert.deepEqual(o.problems.map(p => p.id), ["failed:videoConversion", "paused:smartSearch"])
  assert.deepEqual(o.problems[0].fix, { action: "clear-failed", queue: "videoConversion", label: "Clear the failed jobs", confirm: o.problems[0].fix!.confirm })
  assert.match(o.problems[0].fix!.confirm, /Only the failed entries are removed; no photo or video is changed/)
  assert.equal(o.problems[1].fix!.action, "resume-queue")
  assert.equal(o.update.available, false)
  const newer = await readOverview(fakeClient([], { check: { checkedAt: "x", releaseVersion: "v3.5.0" } }).client)
  assert.equal(newer.update.available, true); assert.match(newer.problems[0].title, /v3\.5\.0 is available/); assert.equal(newer.problems[0].fix, null)
  // A queue with work waiting and nothing running is offered a restart.
  assert.equal(problemsOf([queueOf(q("search", { waiting: 3 }))!], { latest: null, available: false, checkedAt: null }, "v3.4.2")[0].fix!.action, "restart-queue")
  assert.equal(versionOf({ major: 3, minor: 4, patch: 2, prerelease: 1 }), "v3.4.2-rc.1"); assert.equal(versionOf({}), null)
  // A reading that fails for the statistics is an error, not an empty page.
  await assert.rejects(readOverview({ get: async () => { throw new Error("down") } }), /down/)
})

test("plug-in: its card and details carry totals only, and its key goes in a header Immich reads", async () => {
  const f = fakeClient([q("videoConversion", { failed: 3 })])
  const o = await readOverview(f.client)
  const tile = tileOf(o)
  assert.equal(tile.headline, "1 problem to fix"); assert.equal(tile.tone, "bad")
  assert.ok(tile.rows.some(r => /1,200 photos/.test(r.value)))
  const d = detailOf(o)
  assert.doesNotMatch(JSON.stringify(d), /Ana|Ben/, "no user names in the viewer's detail")
  assert.equal(d.tables![0].rows[0].failed, 3)
  assert.deepEqual(immichPlugin.manifest.auth, { kind: "header", header: "x-api-key", fromSetting: "key" })
  assert.equal(immichPlugin.manifest.settings.find(x => x.key === "key")!.type, "secret")
  const sum = await immichPlugin.summary!({ get: (p: string) => f.client.get(p), post: async () => ({}), option: () => undefined, from() { return this }, has: () => true } as any)
  assert.ok(sum.lines.length >= 2 && !/key|secret/i.test(sum.lines.join(" ")))
})

test("fixes: audited before anything changes, one queue at a time, and read back after", async () => {
  const f = fakeClient([q("videoConversion", { failed: 3 }), { ...q("smartSearch", { waiting: 4 }), isPaused: true }, q("search", { waiting: 2 })])
  const audits: any[] = []
  const d = { client: f.client, audit: async (a: string, x: any) => { audits.push([a, x]); f.calls.push("AUDIT") }, wait: async () => {} }
  const cleared = await runAction({ action: "clear-failed", queue: "videoConversion" }, "admin@example.com", d)
  assert.match(cleared.message, /Cleared 3 failed jobs on the Video conversion queue/)
  assert.ok(f.calls.indexOf("AUDIT") < f.calls.findIndex(c => c.startsWith("PUT")), "the audit row comes first")
  assert.deepEqual(audits[0], ["immich.clear-failed", { queue: "videoConversion", by: "admin@example.com", failed: 3, waiting: 0, paused: false }])
  assert.equal(f.state.get("videoConversion").statistics.failed, 0)
  assert.equal((await runAction({ action: "resume-queue", queue: "smartSearch" }, "a", d)).queue.paused, false)
  f.calls.length = 0
  await runAction({ action: "restart-queue", queue: "search" }, "a", d)
  assert.deepEqual(f.calls.filter(c => c.startsWith("PUT")), ['PUT /api/queues/search {"isPaused":true}', 'PUT /api/queues/search {"isPaused":false}'])
  // A fix Immich does not keep is an error, not a success.
  const stuck = fakeClient([q("videoConversion", { failed: 3 })], { stuckFailed: true })
  await assert.rejects(runAction({ action: "clear-failed", queue: "videoConversion" }, "a", { ...d, client: stuck.client }), (e: any) => e instanceof ImmichRefusal && e.code === "not_applied")
  // When the audit cannot be written nothing is changed.
  const g = fakeClient([q("videoConversion", { failed: 3 })])
  await assert.rejects(runAction({ action: "clear-failed", queue: "videoConversion" }, "a", { client: g.client, audit: async () => { throw new Error("audit down") } }), /audit down/)
  assert.ok(!g.calls.some(c => c.startsWith("PUT")))
})

test("fixes: the body names an action and a queue from fixed lists and nothing else", () => {
  for (const bad of [null, [], "x", {}, { action: "delete-all", queue: "search" }, { action: "clear-failed" }, { action: "clear-failed", queue: "../../x" }, { action: "clear-failed", queue: "Search" }]) {
    assert.throws(() => parseAction(bad), (e: any) => e instanceof ImmichRefusal && e.code === "bad_request", JSON.stringify(bad))
  }
  assert.deepEqual(parseAction({ action: "clear-failed", queue: "search", extra: "ignored" }), { action: "clear-failed", queue: "search" })
  assert.equal(QUEUE_NAMES.length, 19)
})

// ── The wizard, end to end on a fake cluster ────────────────────────────────

function wizard(hw: Record<string, string> = {}) {
  const pve = new FakePve(); const f = new FakeImmich(); const store = { vault: [] as any[], plugin: {} as Record<string, Record<string, string>> }
  const calls: string[] = []; const scripts: string[] = []
  const vault = new Map<string, Record<string, string>>()
  const a = arrFor(hw).arr()
  const d = deps(pve, {
    arr: () => ({ ...a, http: f.http as any,
      nodeRun: async (node: string, script: string, ms: number) => {
        calls.push(script)
        if (script.includes("@@arr prepared")) {
          const vmid = Number(/V=(\d+)/.exec(script)![1])
          const mp0 = /-mp0 '([^']+)'/.exec(script)?.[1]?.replace(/^pool:(\d+)/, "pool:vm-$1-disk-1")
          const devs = Object.fromEntries([...script.matchAll(/--dev(\d+) '([^']+)'/g)].map(m => [`dev${m[1]}`, m[2]]))
          pve.configs[vmid] = { ...pve.configs[vmid], features: "nesting=1,keyctl=1", ...(mp0 ? { mp0 } : {}), ...devs }
          return { code: 0, output: "@@arr prepared\n" }
        }
        return a.nodeRun(node, script, ms)
      },
      pluginSettings: async (id: string) => store.plugin[id] ?? {}, savePluginSettings: async (id: string, v: any) => { store.plugin[id] = v } }) as any,
    exec: async (o: any) => { scripts.push(o.script); return { code: 0, output: "", timedOut: false } as any },
    saveSecrets: async (c: string, p: string, v: Record<string, string>) => { vault.set(`${c}/${p}`, { ...(vault.get(`${c}/${p}`) ?? {}), ...v }) },
    readSecrets: async (c: string, p: string) => vault.get(`${c}/${p}`) ?? {},
    deleteSecrets: async (c: string, p: string) => { vault.delete(`${c}/${p}`) },
    probe: async () => ({ status: 200, body: JSON.stringify({ res: "pong" }) }),
  })
  return { pve, f, store, calls, scripts, vault, d }
}
const base = (o: any = {}) => ({ ...INPUT({ recipeId: "immich", hostname: "immich", vmid: 910, cores: 4, memoryMb: 6144, diskGb: 24, ip: "192.0.2.60/24" }), options: { IMMICH_ADMIN_EMAIL: "me@example.com", ...(o.options ?? {}) }, ...(o.rest ?? {}) }) as any

test("wizard: the container is made unprivileged with keyctl and its photo disk, Docker runs the compose file, and the administrator, key and plug-in are done by themselves", async () => {
  const w = wizard({ "node-a": INTEL })
  const r = await previewInstall(base({ options: { IMMICH_ACCEL: "vaapi" } }), OWNER, w.d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  assert.equal(r.preview!.plan.options!.IMMICH_FFMPEG, "qsv")
  const job = await settled((await applyPreview(r.preview!.id, OWNER, w.d)).jobId)
  assert.equal(job.status, "completed", `${job.error} ${JSON.stringify(job.steps.filter(x => x.status !== "done"))}`)
  assert.equal(w.pve.creates.length, 1)
  assert.equal(w.pve.creates[0].body.get("unprivileged"), "1")
  const cfg = w.pve.configs[910]
  assert.equal(cfg.features, "nesting=1,keyctl=1"); assert.match(cfg.mp0, /^pool:vm-910-disk-1,mp=\/data,backup=0$|mp=\/data/); assert.match(cfg.dev0, /renderD128/)
  // The compose file the install ran is the Intel one, with the render group the node reported.
  const script = w.scripts.find(s => s.includes("IMMICH_COMPOSE_B64"))!
  const compose = parse(Buffer.from(/IMMICH_COMPOSE_B64='([^']+)'/.exec(script)![1], "base64").toString())
  assert.equal(compose.services["immich-machine-learning"].image, "ghcr.io/immich-app/immich-machine-learning:${IMMICH_VERSION}-openvino")
  assert.deepEqual(compose.services["immich-server"].group_add, ["993"])
  assert.match(script, /^export IMMICH_DB_PASSWORD='[A-Za-z0-9_-]{20,}'$/m)
  // The vault holds the generated login, the database password and the key; the plug-in is connected with the key.
  const item = w.vault.get("apps/immich-910")!
  assert.deepEqual(Object.keys(item).sort(), ["admin_password", "admin_user", "api_key", "db_password"])
  assert.equal(item.admin_user, "me@example.com"); assert.equal(item.api_key, "key-abc")
  assert.deepEqual(w.store.plugin.immich, { url: "http://192.0.2.60:2283", key: "key-abc" })
  assert.deepEqual(job.connected, { plugin: "immich" })
  assert.equal(job.steps.find(s => s.id === "immich-hw")!.status, "done")
  assert.equal(job.steps.find(s => s.id === "verify")!.status, "done")
  assert.ok(!JSON.stringify(job).includes(item.admin_password) && !JSON.stringify(job).includes("key-abc"), "no secret in the job")
  assert.equal(job.adminCredential!.vault.key, "admin_password")
})

test("wizard: the plan is refused before anything is created when the vault is locked, the node lacks the card, or the photo folder is read-only", async () => {
  const w = wizard({ "node-a": BARE })
  const locked = await previewInstall(base(), OWNER, { ...w.d, vaultOpen: async () => false })
  assert.match(locked.errors.join(" "), /vault, and the vault is locked/)
  const nocard = await previewInstall(base({ options: { IMMICH_ACCEL: "nvidia" } }), OWNER, w.d)
  assert.match(nocard.errors.join(" "), /no NVIDIA card/)
  const ro = wizard(); ro.d.arr = () => ({ ...arrFor({}, { writable: false }).arr() })
  const folder = await previewInstall(base({ options: { IMMICH_LIBRARY: "path", IMMICH_HOST_PATH: "/mnt/photos" } }), OWNER, ro.d)
  assert.match(folder.errors.join(" "), /not writable/)
  assert.equal(w.pve.creates.length + ro.pve.creates.length, 0)
})

test("wizard: a public name is allowed for Immich, and its proxy host gets no upload limit and long timeouts", async () => {
  const w = wizard({})
  const hosts: any[] = []
  const publish: any = {
    dns: async () => ({ getDomains: async () => [{ domain: "example.test" }], getRecords: async () => [], createRecord: async () => {}, deleteRecord: async () => {} }),
    proxy: { instances: async () => [{ id: "p1", name: "npm", kind: "npm", certificates: "request" }], createHost: async (_i: string, spec: any) => { hosts.push(spec); return { hostId: "h1" } }, attachCertificate: async () => {}, deleteHost: async () => {}, requestCertificate: async () => ({ id: "c1" }) },
    wanIp: async () => "203.0.113.7", resolve4: async () => ["203.0.113.7"], letsEncryptEmail: () => "ops@example.test",
    fetchPublic: async () => ({ status: 200, body: JSON.stringify({ res: "pong" }) }), wait: async () => {},
  }
  const r = await previewInstall({ ...base(), publish: { zone: "example.test", name: "photos", instanceId: "p1" } }, OWNER, { ...w.d, publish })
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  const job = await settled((await applyPreview(r.preview!.id, OWNER, { ...w.d, publish })).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.equal(hosts[0].npm.advanced_config, IMMICH_RECIPE.proxyAdvanced)
  assert.equal(hosts[0].websockets, true); assert.equal(hosts[0].forwardPort, 2283)
  assert.equal(job.url, "https://photos.example.test")
  // Another app is still not published by the wizard.
  const k = await previewInstall({ ...INPUT({ ip: "192.0.2.61/24", vmid: 911 }), recipeId: "uptime-kuma", publish: { zone: "example.test", name: "kuma", instanceId: "p1" } } as any, OWNER, { ...w.d, publish })
  assert.match(k.errors.join(" "), /only websites are/)
})

test("clean-up: a failed install is removed with the plug-in connection it made and the generated login, and nothing it did not make", async () => {
  const w = wizard({})
  w.f.refuseKey = false
  const failing = { ...w.d, exec: async () => ({ code: 7, output: "boom", timedOut: false }) as any }
  const r = await previewInstall(base(), OWNER, failing)
  const job = await settled((await applyPreview(r.preview!.id, OWNER, failing)).jobId)
  assert.equal(job.status, "failed")
  assert.match(await removeFailedInstall(job.jobId, OWNER, failing), /CT 910 was removed.*generated login \(apps\/immich-910\) was removed from the vault/)
  assert.equal(w.vault.has("apps/immich-910"), false)
})
