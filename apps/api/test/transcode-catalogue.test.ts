// The catalogue's Unmanic and Tdarr entries: the recipes, the hardware choice per node, the compose files per hardware
// type, the library layout shared with the Arr Stack, the setup chores with their read-backs, the install wizard end to
// end on a fake cluster, and the clean-up touching only what an install made.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import yaml from "js-yaml"
import { CATALOGUE, findRecipe, checkOptions } from "../src/lib/catalogue"
import { DETECT } from "../src/lib/catalogue-detect"
import { TRANSCODE_RECIPES, TRANSCODE_IDS, parseMainUrl, UNMANIC_RECIPE, TDARR_RECIPE, UNMANIC_WORKER_RECIPE, TDARR_NODE_RECIPE } from "../src/lib/transcode/recipes"
import {
  HARDWARE_SCRIPT, parseHardware, resolveAccel, autoAccel, deviceSettings, groupAdd, type NodeHardware,
} from "../src/lib/transcode/hardware"
import { composeFile, scriptEnv, NVIDIA_RUN_SHA256, TC_SCRIPT, UNMANIC_IMAGE, TDARR_VERSION, tdarrImages } from "../src/lib/transcode/compose"
import { layoutFromOptions, mediaProbeScript, judgeMedia, prepareNoLibraryScript, LIBRARY_DIR } from "../src/lib/transcode/media"
import {
  waitForUnmanic, setUnmanicLibrary, setUnmanicWorkers, linkWorker, unlinkWorker, wireUnmanicPlugin, tdarrNodeSeen, waitForTdarrNode,
  type TcSetupDeps,
} from "../src/lib/transcode/setup"
import { tcPreview, tcInstallEnv, tcJobSteps, kindOf } from "../src/lib/transcode/catalogue"
import { prepareScript, unmountScript, fstabEditScript, hostMountPoint, layoutOf } from "../src/lib/arr/storage"
import type { ArrDeps } from "../src/lib/arr/catalogue"
import { previewInstall, applyPreview, removeFailedInstall } from "../src/lib/catalogue-installer"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const OWNER = "a@example.com"

// ── What a node looks like to the read-only probe ───────────────────────────

const INTEL = [
  "##lspci",
  "0000:00:02.0 VGA compatible controller [0300]: Intel Corporation UHD Graphics 630 [8086:3e92] (rev 02)",
  "\tKernel driver in use: i915",
  "##dri",
  "/dev/dri/card0|0000:00:02.0|e2:0",
  "/dev/dri/renderD128|0000:00:02.0|e2:80",
  "##tcgroups",
  "render:x:993:",
  "video:x:44:",
  "##end",
].join("\n")
const NVIDIA = [
  "##lspci",
  "0000:0a:00.0 VGA compatible controller [0300]: NVIDIA Corporation GP104 [GeForce GTX 1070 Ti] [10de:1b82] (rev a1)",
  "\tKernel driver in use: nvidia",
  "##nvidia",
  "00000000:0A:00.0, NVIDIA GeForce GTX 1070 Ti, 580.173.02, 8192 MiB",
  "##nvdev",
  "/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools", "/dev/nvidia-modeset",
  "##nvmodule",
  "580.173.02",
  "##tcgroups",
  "render:x:992:",
  "video:x:44:",
  "##end",
].join("\n")
const BARE = "##lspci\n##tcgroups\nrender:x:993:\nvideo:x:44:\n##end\n"

test("hardware: Intel graphics are offered as VAAPI with the node's own render group", () => {
  const h = parseHardware("n", INTEL)
  assert.deepEqual(h.vaapi?.renderNodes, ["/dev/dri/renderD128"])
  assert.deepEqual(h.vaapi?.cardNodes, ["/dev/dri/card0"])
  assert.equal(h.vaapi?.renderGid, 993)
  assert.equal(h.nvidia, null)
  assert.equal(autoAccel(h), "vaapi")
  assert.deepEqual(deviceSettings("vaapi", h), [["--dev0", "/dev/dri/renderD128,gid=993"]], "the render node only, never the card")
  assert.deepEqual(groupAdd("vaapi", h), [993])
})

test("hardware: an NVIDIA card counts only with its driver loaded, and the container is told the version to match", () => {
  const h = parseHardware("n", NVIDIA)
  assert.equal(h.vaapi, null)
  assert.equal(h.nvidia?.driver, "580.173.02")
  assert.equal(autoAccel(h), "nvidia")
  assert.deepEqual(deviceSettings("nvidia", h), [["--dev0", "/dev/nvidiactl"], ["--dev1", "/dev/nvidia-uvm"], ["--dev2", "/dev/nvidia0"]], "control, compute and the first card only")
  assert.deepEqual(groupAdd("nvidia", h), [])
  // The same card with no driver loaded is nothing to share.
  const noDriver = NVIDIA.replace(/##nvidia\n.*\n/, "").replace("##nvmodule\n580.173.02\n", "").replace(/##nvdev\n(.*\n)+?(?=##)/, "")
  assert.equal(parseHardware("n", noDriver).nvidia, null)
  const r = resolveAccel("nvidia", h, "n")
  assert.ok(r.warnings.some(w => /exactly version 580\.173\.02/.test(w)))
})

test("hardware: nothing to share means CPU, and an explicit choice the node cannot honour is an error, never a quiet fallback", () => {
  const h = parseHardware("n", BARE)
  assert.deepEqual(h, { vaapi: null, nvidia: null })
  assert.equal(autoAccel(h), "cpu")
  assert.equal(resolveAccel("auto", h, "n").accel, "cpu")
  assert.deepEqual(deviceSettings("cpu", h), [])
  for (const c of ["vaapi", "nvidia"]) assert.equal(resolveAccel(c, h, "n").errors.length, 1, c)
  assert.match(resolveAccel("nvidia", h, "n").errors[0], /never installs one there/)
  // An unknown word is the automatic choice, not an NVIDIA one.
  assert.equal(resolveAccel("rocket", parseHardware("n", NVIDIA), "n").accel, "nvidia")
})

test("hardware: the node probe is the existing read-only one plus a group lookup, and changes nothing", () => {
  assert.match(HARDWARE_SCRIPT, /##nvidia/)
  assert.match(HARDWARE_SCRIPT, /getent group render video/)
  assert.ok(HARDWARE_SCRIPT.trimEnd().endsWith("echo '##end'"))
  assert.doesNotMatch(HARDWARE_SCRIPT, /\b(rm|mv|chmod|chown|apt|modprobe|pct set|tee)\b|>\s*\/etc/)
})

// ── The recipes ─────────────────────────────────────────────────────────────

test("recipes: four entries, listed once, Docker, no generated login, each option key an environment name", () => {
  assert.deepEqual(TRANSCODE_RECIPES.map(r => r.id), [...TRANSCODE_IDS])
  for (const r of TRANSCODE_RECIPES) {
    assert.equal(CATALOGUE.filter(x => x.id === r.id).length, 1, r.id)
    assert.equal(r.stack, "transcode"); assert.equal(r.needsDocker, true); assert.equal(r.wizard, false); assert.equal(r.category, "media")
    assert.deepEqual(r.firstRun, { kind: "none" }, "neither app has a login here, so nothing is generated or kept")
    assert.equal(r.wantsGpu, true)
    assert.equal(r.install.kind, "script")
    for (const o of r.options!) assert.match(o.key, /^(TC|UNMANIC)_[A-Z_]+$/)
    assert.ok(r.notes!.some(n => /No sign-in/.test(n)), `${r.id} says plainly that it has no sign-in`)
  }
  assert.deepEqual(UNMANIC_RECIPE.satisfies, { kind: "plugin", id: "unmanic", setting: "url" })
  assert.equal(TDARR_RECIPE.satisfies, undefined, "there is no Tdarr plug-in to connect")
  assert.ok(TDARR_RECIPE.notes!.some(n => /no Tdarr plug-in yet/.test(n)))
  assert.ok(DETECT.unmanic.length && DETECT.tdarr.length)
  assert.equal(UNMANIC_RECIPE.detect, DETECT.unmanic)
})

test("recipes: Tdarr's recipe says every node must see the library at the same text path, and that /temp is on the container's disk", () => {
  const notes = TDARR_RECIPE.notes!.join("\n")
  assert.match(notes, /exactly \/data\/media/)
  assert.match(notes, /never in your library/)
  assert.match(TDARR_NODE_RECIPE.notes!.join("\n"), /exactly \/data\/media/)
})

test("recipes: detection matches only the real thing", () => {
  const ans = (status: number, body: string) => ({ status, headers: {}, body })
  assert.ok(DETECT.unmanic[0].match(ans(200, JSON.stringify({ workers_status: [] }))))
  assert.equal(DETECT.unmanic[0].match(ans(200, JSON.stringify({ workers: [] }))), null)
  assert.equal(DETECT.unmanic[0].match(ans(404, JSON.stringify({ workers_status: [] }))), null)
  assert.ok(DETECT.tdarr[0].match(ans(200, "<html><title>Tdarr</title>")))
  assert.equal(DETECT.tdarr[0].match(ans(200, "<html><title>Sonarr</title>")), null)
})

test("options: a worker's main address is a plain address; anything else is refused", () => {
  assert.deepEqual(parseMainUrl("10.0.0.30", 8888), { host: "10.0.0.30", port: 8888 })
  assert.deepEqual(parseMainUrl("http://unmanic.lan:9000/", 8888), { host: "unmanic.lan", port: 9000 })
  for (const bad of ["", "https://x:1", "10.0.0.300", "10.0.0.1:99999", "a b", "10.0.0.1/../x", "10.0.0.1:80;rm", "ftp://10.0.0.1"]) assert.equal(parseMainUrl(bad, 1), null, bad)
  assert.ok(checkOptions(UNMANIC_WORKER_RECIPE, { TC_MAIN_URL: "nope nope" }).errors.length)
  assert.deepEqual(checkOptions(UNMANIC_WORKER_RECIPE, { TC_MAIN_URL: "10.0.0.30" }).errors, [])
  assert.ok(checkOptions(UNMANIC_RECIPE, { TC_ACCEL: "rocket" }).errors.length)
  assert.ok(checkOptions(UNMANIC_RECIPE, { UNMANIC_WORKERS: "0" }).errors.length)
  assert.ok(checkOptions(UNMANIC_RECIPE, { TC_MEDIA: "ftp" }).errors.length)
  assert.deepEqual(checkOptions(UNMANIC_RECIPE, {}).errors, [])
  assert.equal(checkOptions(UNMANIC_RECIPE, {}).values.UNMANIC_WORKERS, "2")
})

// ── The compose files, per hardware type ────────────────────────────────────

const doc = (s: string) => yaml.load(s) as any

test("compose (Unmanic): VAAPI shares /dev/dri and the render group; the library is /data/media at /data; scratch is local", () => {
  const c = doc(composeFile({ kind: "unmanic", accel: "vaapi", groups: [993, 44] }))
  const u = c.services.unmanic
  assert.equal(u.image, UNMANIC_IMAGE)
  assert.deepEqual(u.devices, ["/dev/dri:/dev/dri"])
  assert.deepEqual(u.group_add, ["993", "44"])
  assert.ok(u.environment.includes("PUID=1000") && u.environment.includes("PGID=1000"))
  assert.deepEqual(u.volumes, ["./config:/config", "./cache:/tmp/unmanic", "/data:/data"])
  assert.deepEqual(u.ports, ["8888:8888"])
  assert.equal(u.runtime, undefined)
})

test("compose (Unmanic): NVIDIA uses the runtime and the video capabilities, with no device list; CPU has neither", () => {
  const n = doc(composeFile({ kind: "unmanic", accel: "nvidia" })).services.unmanic
  assert.equal(n.runtime, "nvidia")
  assert.ok(n.environment.includes("NVIDIA_VISIBLE_DEVICES=all") && n.environment.includes("NVIDIA_DRIVER_CAPABILITIES=compute,video,utility"))
  assert.equal(n.devices, undefined)
  const c = doc(composeFile({ kind: "unmanic", accel: "cpu" })).services.unmanic
  assert.equal(c.devices, undefined); assert.equal(c.runtime, undefined); assert.equal(c.group_add, undefined)
})

test("compose (Unmanic worker): no library is mounted, because files travel to a worker", () => {
  const w = doc(composeFile({ kind: "unmanic-worker", accel: "vaapi", groups: [993] })).services.unmanic
  assert.deepEqual(w.volumes, ["./config:/config", "./cache:/tmp/unmanic"])
})

test("compose (Tdarr): a server and a node in one file, the same library path and a shared /temp, the server with no encoder", () => {
  const c = doc(composeFile({ kind: "tdarr", accel: "vaapi", groups: [993, 44], nodeName: "tdarr" })).services
  assert.equal(c.tdarr.image, tdarrImages(TDARR_VERSION).server)
  assert.equal(c["tdarr-node"].image, tdarrImages(TDARR_VERSION).node)
  assert.ok(c.tdarr.environment.includes("internalNode=false"), "the server does no encoding")
  assert.ok(c.tdarr.environment.includes("serverIP=0.0.0.0"))
  assert.deepEqual(c.tdarr.ports, ["8265:8265", "8266:8266"])
  for (const s of [c.tdarr, c["tdarr-node"]]) {
    assert.ok(s.volumes.includes("/data:/data"), "the library is at the same text path in both")
    assert.ok(s.volumes.includes("./temp:/temp"), "one scratch folder, on the container's disk")
  }
  assert.ok(c["tdarr-node"].environment.includes("serverIP=tdarr") && c["tdarr-node"].environment.includes("nodeName=tdarr"))
  assert.equal(c.tdarr.devices, undefined, "only the node gets the GPU")
  assert.deepEqual(c["tdarr-node"].devices, ["/dev/dri:/dev/dri"])
  assert.deepEqual(c["tdarr-node"].group_add, ["993", "44"])
})

test("compose (Tdarr node): host networking so the server can call back, the server's address, its own version, no published ports", () => {
  const c = doc(composeFile({ kind: "tdarr-node", accel: "nvidia", server: { host: "10.0.0.30", port: 8266 }, nodeIp: "10.0.0.31", nodeName: "node-b", version: "2.90.01" })).services["tdarr-node"]
  assert.equal(c.image, "ghcr.io/haveagitgat/tdarr_node:2.90.01")
  assert.equal(c.network_mode, "host")
  assert.equal(c.ports, undefined)
  for (const e of ["serverIP=10.0.0.30", "serverPort=8266", "nodeIP=10.0.0.31", "nodePort=8267", "nodeName=node-b"]) assert.ok(c.environment.includes(e), e)
  assert.equal(c.runtime, "nvidia")
  assert.ok(c.volumes.includes("/data:/data"))
})

test("compose: values that are not fixed text are checked, and nothing is a moving tag or a secret", () => {
  assert.throws(() => composeFile({ kind: "tdarr-node", accel: "cpu", nodeIp: "10.0.0.31" }), /server/)
  assert.throws(() => composeFile({ kind: "tdarr-node", accel: "cpu", server: { host: "10.0.0.30; id", port: 8266 }, nodeIp: "10.0.0.31" }), /server/)
  assert.throws(() => composeFile({ kind: "tdarr-node", accel: "cpu", server: { host: "10.0.0.30", port: 8266 }, nodeIp: "x y" }), /own address/)
  assert.throws(() => composeFile({ kind: "tdarr", accel: "cpu", version: "latest" }), /version/)
  assert.throws(() => composeFile({ kind: "tdarr", accel: "vaapi", groups: [-1] }), /group/)
  assert.throws(() => composeFile({ kind: "tdarr", accel: "cpu", nodeName: "a b" }), /name/)
  for (const kind of ["unmanic", "unmanic-worker", "tdarr", "tdarr-node"] as const) {
    const f = composeFile({ kind, accel: "vaapi", groups: [993], server: { host: "10.0.0.30", port: 8266 }, nodeIp: "10.0.0.31", nodeName: "n" })
    assert.doesNotMatch(f, /:latest|password|secret|token|apikey/i, kind)
    for (const m of f.matchAll(/image: (\S+)/g)) assert.match(m[1], /:\d+\.\d+/, m[1])
  }
})

// ── The install script ──────────────────────────────────────────────────────

test("script: valid shell, never deletes anything, never prompts (so end of input cannot be taken for a yes)", () => {
  const r = spawnSync("bash", ["-n"], { input: TC_SCRIPT })
  assert.equal(r.status, 0, r.stderr.toString())
  assert.doesNotMatch(TC_SCRIPT, /\brm -rf\b|\brm -r\b|\bmkfs\b|\bdd\b/)
  // No `read`, and every package install is non-interactive with an explicit -y.
  assert.doesNotMatch(TC_SCRIPT, /(^|[;&|\s])read\s/m)
  for (const line of TC_SCRIPT.split("\n").filter(l => /apt-get install/.test(l))) assert.match(line, / -y /)
  // The library write test runs as the apps' own user and stops the install with a clear message.
  assert.match(TC_SCRIPT, /as_puid sh -c .*hyperprox-write-test/)
  assert.match(TC_SCRIPT, /exit 4/)
  // Only the folders the app owns are chowned; the library is not recursed into.
  assert.doesNotMatch(TC_SCRIPT, /chown -R[^\n]*\/data/)
})

test("script: with a closed standard input the generated script text still runs to its own checks (no prompt waits)", () => {
  // The part before apt (variables and the library test) is exercised for real on a scratch folder is not possible
  // off a container, so this proves the text has no interactive construct a closed input could answer.
  assert.doesNotMatch(TC_SCRIPT, /\bselect\b|\bwhiptail\b|\bdialog\b|\[\s*-t\s+0\s*\]/)
})

test("script env: carries the compose file whole and the hardware, and refuses an NVIDIA run with no version", () => {
  const env = scriptEnv({ kind: "unmanic", accel: "vaapi", groups: [993], library: true, name: "Unmanic" })
  assert.equal(env.TC_ACCEL, "vaapi"); assert.equal(env.TC_LIBRARY, "1"); assert.equal(env.TC_APP_DIR, "/opt/unmanic")
  assert.match(Buffer.from(env.TC_COMPOSE_B64, "base64").toString(), /josh5\/unmanic:/)
  assert.throws(() => scriptEnv({ kind: "unmanic", accel: "nvidia", library: true, name: "Unmanic" }), /driver version/)
  assert.throws(() => scriptEnv({ kind: "unmanic", accel: "nvidia", nvidiaVersion: "580;id", library: true, name: "Unmanic" }), /driver version/)
  assert.equal(scriptEnv({ kind: "unmanic-worker", accel: "cpu", library: false, name: "Unmanic" }).TC_LIBRARY, "0")
  const nv = scriptEnv({ kind: "tdarr", accel: "nvidia", nvidiaVersion: "580.173.02", library: true, name: "Tdarr" })
  assert.equal(nv.TC_NVIDIA_VERSION, "580.173.02"); assert.match(nv.TC_NVIDIA_SHA256, /^[0-9a-f]{64}$/)
  assert.equal(nv.TC_NVIDIA_SHA256, NVIDIA_RUN_SHA256["580.173.02"])
  assert.throws(() => scriptEnv({ kind: "tdarr", accel: "nvidia", nvidiaVersion: "999.99.99", library: true, name: "Tdarr" }), /no pinned checksum/)
  assert.equal(scriptEnv({ kind: "tdarr", accel: "cpu", library: true, name: "Tdarr" }).TC_NVIDIA_SHA256, "")
})

test("script: the NVIDIA installer is hash-checked against the pinned value before it is run, and /data is re-owned only when it did not exist", () => {
  const check = TC_SCRIPT.indexOf('sha256sum -c -')
  const run = TC_SCRIPT.indexOf('sh /tmp/nvidia.run')
  assert.ok(check > 0 && run > check, "sha256sum -c comes before the installer runs")
  assert.match(TC_SCRIPT, /echo "\$TC_NVIDIA_SHA256  \/tmp\/nvidia\.run" \| sha256sum -c - \|\| \{ rm -f \/tmp\/nvidia\.run; echo "checksum mismatch" >&2; exit 7; \}/)
  assert.doesNotMatch(TC_SCRIPT, /\.sha256sum|\.sha256\b/, "no hash fetched from the same host")
  assert.match(TC_SCRIPT, /download\.nvidia\.com/)
  assert.match(TC_SCRIPT, /if \[ ! -d \/data \]; then mkdir -p \/data; chown/)
  assert.doesNotMatch(TC_SCRIPT, /^\s*chown \$TC_PUID:\$TC_PGID \/data/m)
  for (const v of Object.values(NVIDIA_RUN_SHA256)) assert.match(v, /^[0-9a-f]{64}$/)
})

test("preview: an NVIDIA driver with no pinned installer hash is refused with a way forward, and nothing is planned", async () => {
  const pve = new FakePve()
  const odd = NVIDIA.split("580.173.02").join("999.99.99")
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": { hardware: odd } }, []) })
  const r = await previewInstall({ ...INPUT({ recipeId: "unmanic", hostname: "unmanic", vmid: 920, ip: "192.0.2.70/24" }) } as any, OWNER, d)
  assert.ok(r.errors.some(e => /999\.99\.99/.test(e) && /no pinned checksum/.test(e) && /Intel \/ AMD or CPU only/.test(e) && /NVIDIA_RUN_SHA256/.test(e)), JSON.stringify(r.errors))
  assert.equal(r.preview, undefined); assert.equal(pve.creates.length, 0)
})

test("options: a main address may not be this machine or a link-local or unspecified address", () => {
  for (const bad of ["127.0.0.1", "127.9.9.9:8888", "localhost", "LOCALHOST:8888", "0.0.0.0", "169.254.169.254", "169.254.1.1:80", "[::1]", "::1", "fe80::1"]) assert.equal(parseMainUrl(bad, 8888), null, bad)
  assert.deepEqual(parseMainUrl("10.0.0.30", 8888), { host: "10.0.0.30", port: 8888 })
  assert.ok(checkOptions(UNMANIC_WORKER_RECIPE, { TC_MAIN_URL: "169.254.169.254" }).errors.length)
  assert.ok(checkOptions(TDARR_NODE_RECIPE, { TC_MAIN_URL: "127.0.0.1:8265" }).errors.length)
})

test("notes: removing a worker later leaves its link on the main Unmanic, and the notes and README say so", () => {
  assert.ok(UNMANIC_WORKER_RECIPE.notes!.some(n => /Removing a worker later does not remove its link/.test(n)))
  assert.match(readFileSync(join(__dirname, "..", "..", "..", "README.md"), "utf8"), /Removing a worker later does not remove its link on the main Unmanic/)
})

// ── The library ─────────────────────────────────────────────────────────────

test("library: the TC_ options read exactly as the Arr Stack's layout, with downloads never apart, mounted at /data", () => {
  const l = layoutFromOptions({ TC_MEDIA: "nfs", TC_NFS_HOST: "10.0.0.20", TC_NFS_EXPORT: "/Media" }).layout!
  assert.equal(l.media, "nfs"); assert.equal(l.downloads, "together"); assert.equal(l.nfs!.source, "10.0.0.20:/Media")
  assert.equal(LIBRARY_DIR, "/data/media")
  assert.deepEqual(layoutFromOptions({ TC_MEDIA: "path", TC_HOST_PATH: "/etc" }).layout, undefined)
  assert.match(layoutFromOptions({ TC_MEDIA: "nfs", TC_NFS_HOST: "smb://x", TC_NFS_EXPORT: "/m" }).errors[0], /SMB/)
  assert.equal(layoutFromOptions({ TC_MEDIA: "disk", TC_MEDIA_GB: "5" }).errors.length, 1)
  const same = layoutOf({ ARR_MEDIA: "nfs", ARR_NFS_HOST: "10.0.0.20", ARR_NFS_EXPORT: "/Media", ARR_DOWNLOADS: "together" }).layout
  assert.deepEqual(l, same, "one layout for both entries")
})

test("library: a folder is also written to as the container's user, and a folder it cannot write is an error before anything is made", () => {
  const l = layoutFromOptions({ TC_MEDIA: "path", TC_HOST_PATH: "/mnt/media" }).layout!
  const s = mediaProbeScript(l, 905)
  assert.match(s, /setpriv --reuid=101000 --regid=101000 --clear-groups/)
  assert.match(s, /\.hyperprox-write-test/)
  assert.equal(spawnSync("bash", ["-n"], { input: s }).status, 0)
  const ro = judgeMedia("@@arr resolved /mnt/media\n@@arr reachable\n@@arr owner 0:0\n@@arr space 1073741824 2147483648\n@@arr fstype ceph\n@@arr readonly /mnt/media\n", l, 905)
  assert.ok(ro.errors.some(e => /not writable by the container's user \(uid 1000 inside, 101000 on the node\)/.test(e)), JSON.stringify(ro))
  const ok = judgeMedia("@@arr resolved /mnt/media\n@@arr reachable\n@@arr owner 101000:101000\n@@arr space 1073741824 2147483648\n@@arr fstype ext4\n@@arr writable\n", l, 905)
  assert.deepEqual(ok.errors, [])
  assert.ok(ok.checks.some(c => /can write there/.test(c)))
  // An NFS export is mounted read-only to look at: the probe never writes there.
  const nfs = layoutFromOptions({ TC_MEDIA: "nfs", TC_NFS_HOST: "10.0.0.20", TC_NFS_EXPORT: "/Media" }).layout!
  assert.doesNotMatch(mediaProbeScript(nfs, 905), /write-test/)
})

test("library: the NAS mount is the Arr Stack's: this container's marker, matched at the end of the line, so 905 never matches 9050", () => {
  const l = layoutFromOptions({ TC_MEDIA: "nfs", TC_NFS_HOST: "10.0.0.20", TC_NFS_EXPORT: "/Media" }).layout!
  const p = prepareScript({ vmid: 905, layout: l, storage: "pool", tun: false, extra: [["--dev0", "/dev/dri/renderD128,gid=993"]] })
  assert.match(p, /# hyperprox-arr 905/)
  assert.match(p, /--features nesting=1,keyctl=1/)
  assert.match(p, /--dev0 '\/dev\/dri\/renderD128,gid=993'/)
  assert.doesNotMatch(p, /\/dev\/net\/tun/, "no VPN device")
  assert.match(fstabEditScript(905, null), /K=' # hyperprox-arr 905\$'/)
  assert.match(unmountScript(905), /rmdir "\$M"/, "the folder is removed with rmdir only: never a recursive delete")
  assert.doesNotMatch(unmountScript(905), /rm -rf/)
  assert.throws(() => prepareScript({ vmid: 905, layout: l, storage: "pool", tun: false, extra: [["--hookscript", "x"]] }), /only device settings/)
  assert.throws(() => prepareScript({ vmid: 905, layout: l, storage: "pool", tun: false, extra: [["--dev0", "/dev/x; reboot"]] }), /safe/)
  assert.equal(hostMountPoint(905), "/mnt/hyperprox-arr/905")
})

test("prepare without a library (a worker): only features and devices, both read back by the caller", () => {
  const s = prepareNoLibraryScript({ vmid: 906, extra: [["--dev0", "/dev/dri/renderD128,gid=993"]] })
  assert.match(s, /pct set "\$V" --features nesting=1,keyctl=1 --dev0 '\/dev\/dri\/renderD128,gid=993'/)
  assert.doesNotMatch(s, /-mp0|fstab|mount/)
  assert.throws(() => prepareNoLibraryScript({ vmid: 906, extra: [["--net0", "x"]] }), /only device settings/)
  assert.equal(spawnSync("bash", ["-n"], { input: s }).status, 0)
})

// ── The setup chores, against a fake Unmanic and Tdarr ──────────────────────

class FakeUnmanic {
  libraries = [{ id: 1, name: "Default", path: "/library", enable_scanner: false, enable_inotify: false, tags: [] as string[] }]
  libPlugins: any[] = []
  group = { id: 1, locked: false, name: "Default", number_of_workers: 1, worker_event_schedules: [] as any[], tags: [] as string[] }
  remotes: any[] = []
  up = true
  uuid = "11111111-1111-1111-1111-111111111111"
  calls: string[] = []
  noKeep = false
  http = async (r: { method: string; url: string; json?: any }) => {
    const path = new URL(r.url).pathname.replace("/unmanic/api/v2", "")
    this.calls.push(`${r.method} ${path}`)
    const ok = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) })
    if (!this.up) throw new Error("down")
    if (path === "/settings/read") return ok({ settings: { remote_installations: this.remotes } })
    if (path === "/settings/libraries") return ok({ libraries: this.libraries.map(l => ({ id: l.id, name: l.name, path: l.path })) })
    if (path === "/settings/library/read") return ok({ library_config: this.libraries.find(l => l.id === r.json.id), plugins: { enabled_plugins: this.libPlugins } })
    if (path === "/settings/library/write") {
      if (!this.noKeep) this.libraries = this.libraries.map(l => (l.id === r.json.library_config.id ? { ...l, ...r.json.library_config } : l))
      this.libPlugins = r.json.plugins.enabled_plugins
      return ok({ success: true })
    }
    if (path === "/settings/worker_groups") return ok({ worker_groups: [this.group] })
    if (path === "/settings/worker_group/write") { if (!this.noKeep) this.group = { ...this.group, ...r.json }; return ok({ success: true }) }
    if (path === "/settings/worker_group/read") return ok(this.group)
    if (path === "/settings/link/validate") return ok({ installation: { uuid: this.uuid, name: "x", version: "0.4.1" } })
    if (path === "/settings/link/write") { this.remotes.push(r.json.link_config); return ok({ success: true }) }
    if (path === "/settings/link/remove") { this.remotes = this.remotes.filter(x => x.uuid !== r.json.uuid); return ok({ success: true }) }
    return { status: 404, headers: {}, body: "" }
  }
}
const sdeps = (u: FakeUnmanic, plugins: Record<string, Record<string, string>> = {}): TcSetupDeps => ({
  http: u.http as any, wait: async () => {},
  pluginSettings: async id => ({ ...(plugins[id] ?? {}) }), savePluginSettings: async (id, v) => { plugins[id] = { ...v } },
})

test("setup (Unmanic): the library is /data/media with no plug-in enabled, the workers are set, and each is read back", async () => {
  const u = new FakeUnmanic()
  const d = sdeps(u)
  await waitForUnmanic(d, "http://x:8888").catch(() => { throw new Error("should answer") })
  const lib = await setUnmanicLibrary(d, "http://x:8888", true)
  assert.match(lib, /\/data\/media/); assert.match(lib, /No plug-in is enabled/)
  assert.equal(u.libraries[0].path, "/data/media"); assert.equal(u.libraries[0].name, "Media"); assert.equal(u.libraries[0].enable_scanner, true)
  assert.deepEqual(u.libPlugins, [], "nothing is enabled, so nothing is changed in the library until the person chooses")
  assert.match(await setUnmanicWorkers(d, "http://x:8888", 2), /^2 workers/)
  assert.equal(u.group.number_of_workers, 2)
  assert.equal(u.group.name, "Default", "the rest of the group is kept as it was")
  // An Unmanic that does not keep a setting is a failed step, not a done one.
  const lazy = new FakeUnmanic(); lazy.noKeep = true
  await assert.rejects(setUnmanicLibrary(sdeps(lazy), "http://x:8888", true), /did not keep the library/)
  await assert.rejects(setUnmanicWorkers(sdeps(lazy), "http://x:8888", 3), /did not keep the worker count/)
  // A library the person already put plug-ins on keeps them.
  const had = new FakeUnmanic(); had.libPlugins = [{ plugin_id: "ignore_hardlinked_files" }]
  assert.match(await setUnmanicLibrary(sdeps(had), "http://x:8888", false), /1 plug-in\(s\) already enabled/)
  assert.equal(had.libPlugins.length, 1)
})

test("setup (Unmanic): a server that never answers fails with a plain sentence", async () => {
  const u = new FakeUnmanic(); u.up = false
  await assert.rejects(waitForUnmanic(sdeps(u), "http://x:8888", 3), /did not answer after two minutes/)
})

test("setup (worker): links both sides; a link the main one already had is left alone and never recorded for undo", async () => {
  const main = new FakeUnmanic(), worker = new FakeUnmanic()
  worker.uuid = "22222222-2222-2222-2222-222222222222"
  const byBase: Record<string, FakeUnmanic> = { "http://main:8888": main, "http://worker:8888": worker }
  const d: TcSetupDeps = { ...sdeps(main), http: (r => byBase[new URL(r.url).origin].http(r as any)) as any }
  const recorded: any[] = []
  const a = await linkWorker(d, { main: "http://main:8888", mainAddress: "main:8888", worker: "http://worker:8888", workerAddress: "worker:8888" }, r => recorded.push(r))
  assert.equal(main.remotes[0].address, "worker:8888"); assert.equal(main.remotes[0].enable_sending_tasks, true); assert.equal(main.remotes[0].enable_receiving_tasks, false)
  assert.equal(worker.remotes[0].address, "main:8888"); assert.equal(worker.remotes[0].enable_receiving_tasks, true); assert.equal(worker.remotes[0].enable_sending_tasks, false)
  assert.deepEqual(a.made, { mainUrl: "http://main:8888", uuid: main.uuid })
  assert.deepEqual(recorded, [a.made])
  assert.match(a.detail, /cross the network|travel over the network/)
  // Undo removes that one link by its id.
  assert.match(await unlinkWorker(d, a.made!), /was undone/)
  assert.deepEqual(main.remotes, [])
  // The main one already had it: nothing added there, nothing recorded.
  const main2 = new FakeUnmanic(); main2.remotes = [{ address: "worker:8888", uuid: "pre-existing", enable_sending_tasks: false }]
  const worker2 = new FakeUnmanic()
  const by2: Record<string, FakeUnmanic> = { "http://main:8888": main2, "http://worker:8888": worker2 }
  const rec2: any[] = []
  const b = await linkWorker({ ...d, http: (r => by2[new URL(r.url).origin].http(r as any)) as any }, { main: "http://main:8888", mainAddress: "main:8888", worker: "http://worker:8888", workerAddress: "worker:8888" }, r => rec2.push(r))
  assert.equal(b.made, null); assert.deepEqual(rec2, [])
  assert.deepEqual(main2.remotes, [{ address: "worker:8888", uuid: "pre-existing", enable_sending_tasks: false }], "the existing link is exactly as it was")
  assert.ok(!main2.calls.some(c => /link\/(write|remove)/.test(c)))
})

test("setup (plug-in): the first empty slot is used, a taken slot is never replaced, an address already there is left alone", async () => {
  const u = new FakeUnmanic()
  const plugins: Record<string, Record<string, string>> = {}
  const d = sdeps(u, plugins)
  assert.equal((await wireUnmanicPlugin(d, "http://a:8888", "a")).status, "done")
  assert.deepEqual(plugins.unmanic, { url: "http://a:8888", label: "a" })
  assert.equal((await wireUnmanicPlugin(d, "http://b:8888", "b")).status, "done")
  assert.equal(plugins.unmanic.url, "http://a:8888"); assert.equal(plugins.unmanic.url2, "http://b:8888"); assert.equal(plugins.unmanic.label2, "b")
  assert.match((await wireUnmanicPlugin(d, "http://a:8888", "a")).detail, /already reads/)
  assert.equal((await wireUnmanicPlugin(d, "http://c:8888", "c")).status, "done")
  const full = await wireUnmanicPlugin(d, "http://d:8888", "d")
  assert.equal(full.status, "skipped"); assert.match(full.detail, /room for/)
  assert.equal(plugins.unmanic.url3, "http://c:8888")
})

test("setup (Tdarr): the node counts as registered only when the server lists it by name; an unreadable list is said, not failed", async () => {
  const mk = (status: number, body: string): TcSetupDeps => ({ ...sdeps(new FakeUnmanic()), http: (async () => ({ status, headers: {}, body })) as any })
  const list = JSON.stringify({ abc: { nodeName: "tdarr", _id: "abc" } })
  assert.deepEqual(await tdarrNodeSeen(mk(200, list), "http://x:8265", "tdarr"), { seen: true })
  assert.deepEqual(await tdarrNodeSeen(mk(200, list), "http://x:8265", "other"), { seen: false, readable: true })
  assert.deepEqual(await tdarrNodeSeen(mk(404, ""), "http://x:8265", "tdarr"), { seen: false, readable: false })
  assert.deepEqual(await tdarrNodeSeen(mk(200, "<html>"), "http://x:8265", "tdarr"), { seen: false, readable: false })
  const step: any = { status: "pending" }
  await waitForTdarrNode(mk(404, ""), "http://x:8265", "tdarr", step)
  assert.equal(step.status, "skipped"); assert.match(step.detail, /Nodes tab/)
  const s2: any = { status: "pending" }
  await waitForTdarrNode(mk(200, list), "http://x:8265", "tdarr", s2)
  assert.equal(s2.status, "done")
  await assert.rejects(waitForTdarrNode(mk(200, JSON.stringify({})), "http://x:8265", "tdarr", { status: "pending" }, 2), /did not register/)
})

// ── The preview and the wizard, end to end on a fake cluster ─────────────────

interface Node { hardware: string; reach?: boolean; writable?: boolean }

/** A node login that answers each script the way a node would, and records what was run. */
function nodeRunner(pve: FakePve, hw: Record<string, Node>, calls: string[]) {
  return async (node: string, script: string) => {
    calls.push(script)
    const n = hw[node] ?? { hardware: BARE }
    if (script.includes("##tcgroups")) return { code: 0, output: n.hardware }
    if (script.includes("@@arr prepared")) {
      const vmid = Number(/V=(\d+)/.exec(script)![1])
      const mp0 = /-mp0 '([^']+)'/.exec(script)?.[1]?.replace(/^pool:(\d+)/, "pool:vm-$1-disk-1")
      const devs = Object.fromEntries([...script.matchAll(/--dev(\d+) '([^']+)'/g)].map(m => [`dev${m[1]}`, m[2]]))
      pve.configs[vmid] = { ...pve.configs[vmid], features: "nesting=1,keyctl=1", ...(mp0 ? { mp0 } : {}), ...devs }
      return { code: 0, output: `${script.includes("fstab") ? "@@arr mounted\n" : ""}@@arr prepared\n` }
    }
    if (script.includes("@@arr unmounted")) return { code: 0, output: "@@arr unmounted\n" }
    if (script.includes("@@tc")) return { code: 0, output: n.reach === false ? "@@tc noreach\n" : "@@tc reach\n" }
    return { code: 0, output: `@@arr resolved /mnt/media\n@@arr reachable\n@@arr owner 101000:101000\n@@arr space 1099511627776 2199023255552\n@@arr fstype ext4\n${n.writable === false ? "@@arr readonly /mnt/media\n" : "@@arr writable\n"}` }
  }
}

function arrDeps(pve: FakePve, hw: Record<string, Node>, calls: string[], opts: { main?: FakeUnmanic; tdarr?: { nodes: any; version?: string | null }; plugins?: Record<string, Record<string, string>>; mainUrl?: string; worker?: FakeUnmanic } = {}): ArrDeps {
  const plugins = opts.plugins ?? {}
  const unm = opts.main ?? new FakeUnmanic()
  const fakeHttp = async (r: any) => {
    const u = new URL(r.url)
    if (u.pathname.startsWith("/unmanic/api/v2/workers/status")) return { status: 200, headers: {}, body: JSON.stringify({ workers_status: [] }) }
    if (u.hostname === "10.0.0.30" && u.port === "8265") {
      if (u.pathname === "/") return { status: 200, headers: {}, body: "<html><title>Tdarr</title></html>" }
      if (u.pathname === "/api/v2/status") return { status: 200, headers: {}, body: JSON.stringify(opts.tdarr?.version === null ? {} : { version: opts.tdarr?.version ?? TDARR_VERSION }) }
      if (u.pathname === "/api/v2/get-nodes") return { status: 200, headers: {}, body: JSON.stringify(opts.tdarr?.nodes ?? {}) }
    }
    if (u.hostname === "10.0.0.30" && u.port === "8888") return unm.http(r)
    if (u.port === "8888") return (opts.worker ?? unm).http(r)
    if (u.port === "8265") {
      if (u.pathname === "/") return { status: 200, headers: {}, body: "<html><title>Tdarr</title></html>" }
      if (u.pathname === "/api/v2/get-nodes") return { status: 200, headers: {}, body: JSON.stringify(opts.tdarr?.nodes ?? { n1: { nodeName: "tdarr" } }) }
    }
    return { status: 404, headers: {}, body: "" }
  }
  return {
    http: fakeHttp as any,
    nodeRun: nodeRunner(pve, hw, calls),
    pluginSettings: async id => ({ ...(plugins[id] ?? {}) }), savePluginSettings: async (id, v) => { plugins[id] = { ...(plugins[id] ?? {}), ...v } },
    localAddressTo: async () => "192.0.2.5", mediaServer: async () => null,
  }
}

test("preview (Unmanic): the hardware is resolved against the node and the plan keeps the concrete choice, never a request's own driver version", async () => {
  const pve = new FakePve(); const calls: string[] = []
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": { hardware: INTEL }, "node-b": { hardware: NVIDIA } }, calls) })
  const base = { ...INPUT({ recipeId: "unmanic", hostname: "unmanic", vmid: 910, cores: 4, memoryMb: 4096, diskGb: 40 }) }
  const r = await previewInstall({ ...base, options: { TC_NVIDIA_VERSION: "1.2.3" } } as any, OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  assert.equal(r.preview!.plan.options!.TC_ACCEL, "vaapi")
  assert.equal(r.preview!.plan.options!.TC_NVIDIA_VERSION, "", "the request's version is dropped")
  assert.ok(r.checks.some(c => /Intel Corporation UHD Graphics 630|UHD Graphics 630/.test(c) && /renderD128/.test(c)))
  assert.ok(r.checks.some(c => /keyctl/.test(c)) && r.checks.some(c => /no public name and no port forward/.test(c)))
  // On the NVIDIA node, auto picks NVIDIA and records the driver version to match.
  const n = await previewInstall({ ...base, node: "node-b", ip: "192.0.2.51/24" } as any, OWNER, d)
  assert.deepEqual(n.errors, [], JSON.stringify(n))
  assert.equal(n.preview!.plan.options!.TC_ACCEL, "nvidia"); assert.equal(n.preview!.plan.options!.TC_NVIDIA_VERSION, "580.173.02")
  assert.ok(n.warnings.some(w => /exactly version 580\.173\.02/.test(w)))
  // A choice the node cannot honour is refused, not replaced.
  const bad = await previewInstall({ ...base, options: { TC_ACCEL: "vaapi" }, node: "node-b", ip: "192.0.2.52/24" } as any, OWNER, d)
  assert.ok(bad.errors.some(e => /no Intel or AMD graphics/.test(e)), JSON.stringify(bad.errors))
  // A node with nothing: CPU, with the slow warning, and more than one worker is warned about.
  const cpu = await previewInstall({ ...base, options: { UNMANIC_WORKERS: "3" }, ip: "192.0.2.53/24" } as any, OWNER, deps(pve, { arr: () => arrDeps(pve, { "node-a": { hardware: BARE } }, []) }))
  assert.equal(cpu.preview!.plan.options!.TC_ACCEL, "cpu")
  assert.ok(cpu.warnings.some(w => /several times slower/.test(w)) && cpu.warnings.some(w => /every worker uses all the cores/.test(w)))
})

test("preview (Unmanic): a folder the container's user cannot write is refused before anything is created", async () => {
  const pve = new FakePve(); const calls: string[] = []
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": { hardware: INTEL, writable: false } }, calls) })
  const r = await previewInstall({ ...INPUT({ recipeId: "unmanic", hostname: "unmanic", vmid: 911 }), options: { TC_MEDIA: "path", TC_HOST_PATH: "/mnt/media" } } as any, OWNER, d)
  assert.ok(r.errors.some(e => /not writable by the container's user/.test(e)), JSON.stringify(r.errors))
  assert.equal(r.preview, undefined); assert.equal(pve.creates.length, 0)
})

test("wizard (Unmanic): preview then apply makes the container, hands it the GPU and the library, sets Unmanic up, and connects the plug-in", async () => {
  const pve = new FakePve(); const calls: string[] = []; const scripts: string[] = []
  const vault: Record<string, any> = {}
  const plugins: Record<string, Record<string, string>> = {}
  const unm = new FakeUnmanic()
  const d = deps(pve, {
    arr: () => arrDeps(pve, { "node-a": { hardware: INTEL } }, calls, { main: unm, plugins }),
    saveSecrets: async (c, p, v) => { vault[`${c}/${p}`] = v },
    exec: async (o: any) => { scripts.push(o.script); return { code: 0, output: "", timedOut: false } as any },
  })
  const r = await previewInstall({ ...INPUT({ recipeId: "unmanic", hostname: "unmanic", vmid: 912, cores: 4, memoryMb: 4096, diskGb: 40, ip: "192.0.2.60/24" }),
    options: { TC_MEDIA: "nfs", TC_NFS_HOST: "10.0.0.20", TC_NFS_EXPORT: "/Media", UNMANIC_WORKERS: "2" } } as any, OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  const job = await applyPreview(r.preview!.id, OWNER, d)
  assert.deepEqual(job.steps.map(s => s.id), ["container", "network", "install", "tc-ready", "tc-library", "tc-workers", "tc-plugin"])
  const done = await settled(job.jobId)
  assert.equal(done.status, "completed", `${done.error} ${JSON.stringify(done.steps)}`)
  assert.ok(done.steps.every(s => s.status === "done"), JSON.stringify(done.steps))
  // keyctl, the render node with the node's own render group, and the NAS mount: over the node login, then read back.
  const prep = calls.find(c => c.includes("@@arr prepared"))!
  assert.match(prep, /--features nesting=1,keyctl=1/)
  assert.match(prep, /--dev0 '\/dev\/dri\/renderD128,gid=993'/)
  assert.match(prep, /-mp0 '\/mnt\/hyperprox-arr\/912,mp=\/data,backup=0'/)
  assert.deepEqual(done.arrHostMount, { node: "node-a", vmid: 912 })
  assert.match(done.steps[0].detail!, /hardware: Intel\/AMD graphics \(VAAPI\); library on 10\.0\.0\.20:\/Media/)
  assert.deepEqual(done.tcGroups, [993])
  // The install script carried the compose file with the group, and no secret was made or kept.
  const install = scripts.find(s => s.includes("TC_COMPOSE_B64"))!
  const compose = Buffer.from(/TC_COMPOSE_B64='([^']+)'/.exec(install)![1], "base64").toString()
  assert.match(compose, /group_add:\n\s+- "993"\n/)
  assert.doesNotMatch(compose, /- "44"/)
  assert.deepEqual(vault, {}, "nothing generated, so nothing in the vault")
  assert.equal(done.adminCredential, undefined)
  // Unmanic is set up and read back, and the plug-in reads it.
  assert.equal(unm.libraries[0].path, "/data/media"); assert.equal(unm.group.number_of_workers, 2)
  assert.deepEqual(plugins.unmanic, { url: "http://192.0.2.60:8888", label: "unmanic" })
  assert.equal(done.url, "http://192.0.2.60:8888")
  assert.deepEqual(done.arrApps, [{ id: "unmanic", name: "Open Unmanic", url: "http://192.0.2.60:8888" }])
  assert.equal(done.tcFollowUp?.recipeId, "unmanic-worker")
  // Never published: no DNS or proxy call of any kind.
  assert.equal(done.ledger, undefined); assert.equal(done.publish, undefined)
})

test("wizard (Unmanic): a failed install's clean-up removes the NAS mount line it made and nothing else", async () => {
  const pve = new FakePve(); const calls: string[] = []
  const unm = new FakeUnmanic(); unm.noKeep = true
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": { hardware: INTEL } }, calls, { main: unm }) })
  const r = await previewInstall({ ...INPUT({ recipeId: "unmanic", hostname: "unmanic", vmid: 913, ip: "192.0.2.61/24" }), options: { TC_MEDIA: "nfs", TC_NFS_HOST: "10.0.0.20", TC_NFS_EXPORT: "/Media" } } as any, OWNER, d)
  const done = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(done.status, "failed"); assert.match(done.error!, /did not keep the library/)
  const msg = await removeFailedInstall(done.jobId, OWNER, d)
  assert.match(msg, /CT 913 was removed/); assert.match(msg, /NAS mount on node-a was undone/)
  const un = calls.filter(c => c.includes("@@arr unmounted"))
  assert.equal(un.length, 1)
  assert.match(un[0], /# hyperprox-arr 913/)
  assert.doesNotMatch(un[0], /hyperprox-arr 91\b|rm -rf/)
  assert.equal(pve.deletePaths.length, 1); assert.match(pve.deletePaths[0], /purge=1$/)
})

test("wizard (Unmanic worker): links both sides, wires the plug-in's second slot, and rolls back only the link this install made", async () => {
  const pve = new FakePve(); const calls: string[] = []
  const main = new FakeUnmanic(); const worker = new FakeUnmanic(); worker.uuid = "22222222-2222-2222-2222-222222222222"
  const plugins: Record<string, Record<string, string>> = { unmanic: { url: "http://10.0.0.30:8888", label: "main" } }
  const a = arrDeps(pve, { "node-a": { hardware: INTEL } }, calls, { main, plugins, worker })
  const d = deps(pve, { arr: () => a })
  const r = await previewInstall({ ...INPUT({ recipeId: "unmanic-worker", hostname: "unmanic-w", vmid: 914, ip: "192.0.2.62/24" }), options: { TC_MAIN_URL: "10.0.0.30" } } as any, OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  assert.equal(r.preview!.plan.options!.TC_MAIN_URL, "http://10.0.0.30:8888")
  assert.ok(r.checks.some(c => /main Unmanic answers at http:\/\/10\.0\.0\.30:8888/.test(c)))
  const done = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(done.status, "completed", `${done.error} ${JSON.stringify(done.steps)}`)
  assert.deepEqual(done.steps.map(s => s.id), ["container", "network", "install", "tc-ready", "tc-workers", "tc-link", "tc-plugin"])
  assert.equal(main.remotes.length, 1); assert.equal(main.remotes[0].address, "192.0.2.62:8888")
  assert.deepEqual(done.tcLink, { mainUrl: "http://10.0.0.30:8888", uuid: main.uuid })
  assert.equal(plugins.unmanic.url, "http://10.0.0.30:8888", "the first slot is untouched"); assert.equal(plugins.unmanic.url2, "http://192.0.2.62:8888")
  // No library: no mountpoint, no NAS mount on the node.
  assert.ok(!calls.some(c => /-mp0|fstab/.test(c)))
  assert.equal(done.arrHostMount, undefined)
  // The worker's own compose has no library volume.
  assert.ok(calls.some(c => c.includes("--dev0")))
  // A completed install is not cleaned up by HyperProx; mimic a failure after the link to prove the rollback.
  done.status = "failed"; done.created = true
  const msg = await removeFailedInstall(done.jobId, OWNER, d)
  assert.match(msg, /The link on http:\/\/10\.0\.0\.30:8888 to the removed worker was undone/)
  assert.deepEqual(main.remotes, [], "the one link this install made is gone")
  assert.equal(done.tcLink, undefined)
})

test("wizard (Unmanic worker): an unreachable main Unmanic is refused before anything is made", async () => {
  const pve = new FakePve()
  const a = arrDeps(pve, { "node-a": { hardware: INTEL } }, [])
  const d = deps(pve, { arr: () => ({ ...a, http: (async () => { throw new Error("no route") }) as any }) })
  const r = await previewInstall({ ...INPUT({ recipeId: "unmanic-worker", hostname: "unmanic-w", vmid: 915, ip: "192.0.2.63/24" }), options: { TC_MAIN_URL: "10.0.0.30" } } as any, OWNER, d)
  assert.ok(r.errors.some(e => /No Unmanic answered at http:\/\/10\.0\.0\.30:8888/.test(e)), JSON.stringify(r.errors))
  assert.equal(pve.creates.length, 0)
})

test("wizard (Tdarr): a server and its node in one container, the library and /temp the same for both, the node waited for", async () => {
  const pve = new FakePve(); const calls: string[] = []; const scripts: string[] = []
  const d = deps(pve, {
    arr: () => arrDeps(pve, { "node-a": { hardware: INTEL } }, calls, { tdarr: { nodes: { n1: { nodeName: "tdarr" } } } }),
    exec: async (o: any) => { scripts.push(o.script); return { code: 0, output: "", timedOut: false } as any },
  })
  const r = await previewInstall({ ...INPUT({ recipeId: "tdarr", hostname: "tdarr", vmid: 916, cores: 4, memoryMb: 6144, diskGb: 40, ip: "192.0.2.64/24" }) } as any, OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  const job = await applyPreview(r.preview!.id, OWNER, d)
  assert.deepEqual(job.steps.map(s => s.id), ["container", "network", "install", "tc-ready", "tc-node", "tc-plugin"])
  const done = await settled(job.jobId)
  assert.equal(done.status, "completed", `${done.error} ${JSON.stringify(done.steps)}`)
  assert.equal(done.steps.find(s => s.id === "tc-node")!.status, "done")
  const tp = done.steps.find(s => s.id === "tc-plugin")!
  assert.equal(tp.status, "skipped"); assert.match(tp.detail!, /no Tdarr plug-in yet/)
  assert.equal(done.url, "http://192.0.2.64:8265")
  assert.equal(done.tcFollowUp?.recipeId, "tdarr-node")
  const compose = Buffer.from(/TC_COMPOSE_B64='([^']+)'/.exec(scripts.find(s => s.includes("TC_COMPOSE_B64"))!)![1], "base64").toString()
  const c = doc(compose).services
  assert.ok(c.tdarr.volumes.includes("/data:/data") && c["tdarr-node"].volumes.includes("/data:/data"))
  assert.ok(c["tdarr-node"].environment.includes("nodeName=tdarr"))
  assert.match(calls.find(c => c.includes("@@arr prepared"))!, /-mp0 'pool:\d+,mp=\/data,backup=0'/)
})

test("wizard (Tdarr node): takes the server's own version, checks the server's node port from the node, and uses its own address", async () => {
  const pve = new FakePve(); const calls: string[] = []; const scripts: string[] = []
  const mk = (reach?: boolean, version?: string | null) => deps(pve, {
    arr: () => arrDeps(pve, { "node-a": { hardware: INTEL, reach } }, calls, { tdarr: { nodes: { n1: { nodeName: "tdarr-n" } }, version } }),
    exec: async (o: any) => { scripts.push(o.script); return { code: 0, output: "", timedOut: false } as any },
  })
  const input = { ...INPUT({ recipeId: "tdarr-node", hostname: "tdarr-n", vmid: 917, ip: "192.0.2.65/24" }), options: { TC_MAIN_URL: "10.0.0.30" } }
  const blocked = await previewInstall(input as any, OWNER, mk(false))
  assert.ok(blocked.errors.some(e => /cannot reach the Tdarr server's node port \(10\.0\.0\.30:8266\)/.test(e)), JSON.stringify(blocked.errors))
  const d = mk(true, "2.90.01")
  const r = await previewInstall(input as any, OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  assert.equal(r.preview!.plan.options!.TC_VERSION, "2.90.01")
  assert.ok(r.checks.some(c => /Tdarr 2\.90\.01, the server's own version/.test(c)))
  const done = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(done.status, "completed", `${done.error} ${JSON.stringify(done.steps)}`)
  const compose = Buffer.from(/TC_COMPOSE_B64='([^']+)'/.exec(scripts.find(s => s.includes("TC_COMPOSE_B64"))!)![1], "base64").toString()
  const n = doc(compose).services["tdarr-node"]
  assert.equal(n.image, "ghcr.io/haveagitgat/tdarr_node:2.90.01")
  for (const e of ["serverIP=10.0.0.30", "serverPort=8266", "nodeIP=192.0.2.65", "nodePort=8267"]) assert.ok(n.environment.includes(e), e)
  assert.equal(n.network_mode, "host")
  // A server that does not say its version: the pinned one, with a warning.
  const un = await previewInstall({ ...input, hostname: "tdarr-n2", vmid: 918, ip: "192.0.2.66/24" } as any, OWNER, mk(true, null))
  assert.deepEqual(un.errors, [], JSON.stringify(un))
  assert.equal(un.preview!.plan.options!.TC_VERSION, TDARR_VERSION)
  assert.ok(un.warnings.some(w => /did not say which version/.test(w)))
})

test("wizard: a transcoder cannot be installed into an existing container, because only the wizard sets up its hardware and library", async () => {
  const { startInstall } = await import("../src/lib/catalogue-installer")
  await assert.rejects(startInstall({ recipeId: "unmanic", intoVmid: 100, owner: OWNER }), /only the install wizard does/)
  await assert.rejects(startInstall({ recipeId: "tdarr", intoVmid: 100, owner: OWNER }), /planned in the install wizard|only the install wizard/)
})

test("steps: each entry's own chores replace the generic check and wiring, in order", () => {
  const generic = [{ id: "container", label: "c", status: "pending" }, { id: "network", label: "n", status: "pending" }, { id: "install", label: "i", status: "pending" },
    { id: "verify", label: "v", status: "pending" }, { id: "wire", label: "w", status: "pending" }]
  assert.deepEqual(tcJobSteps(generic, "unmanic").map(s => s.id), ["container", "network", "install", "tc-ready", "tc-library", "tc-workers", "tc-plugin"])
  assert.deepEqual(tcJobSteps(generic, "tdarr-node").map(s => s.id), ["container", "network", "install", "tc-node"])
  assert.throws(() => kindOf("arr-stack"), /not a transcoder/)
  assert.throws(() => tcInstallEnv("unmanic", { options: { TC_ACCEL: "auto" }, groups: [], ip: "1.2.3.4", hostname: "u" }), /resolved hardware/)
})

// ── Public repo: nothing of the live cluster in what ships ───────────────────

test("public repo: the new files name no node, address, guest or site of any real cluster", () => {
  const root = join(__dirname, "..", "..")
  const files: string[] = []
  const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { if (!/node_modules|\.next/.test(p)) walk(p) } else files.push(p) } }
  walk(join(root, "api", "src", "lib", "transcode"))
  files.push(join(root, "api", "test", "transcode-catalogue.test.ts"))
  for (const f of ["TranscodePicker.tsx", "MediaSource.tsx"]) files.push(join(root, "frontend", "components", "catalogue", f))
  const bad = new RegExp(["grif" + "finit", "fyr" + "lux", "titan" + "[0-9]", "192\\.168", "hm" + "server"].join("|"), "i")
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), bad, f)
})
