// The catalogue's Arr Stack: the recipe, the rules between its apps, the compose file it writes, the storage
// layout and NFS mount, the setup chores with their read-backs, and the install wizard end to end on a fake cluster.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, statSync, rmSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import yaml from "js-yaml"
import { CATALOGUE, findRecipe, checkOptions } from "../src/lib/catalogue"
import { installScript } from "../src/lib/install-script"
import { DETECT } from "../src/lib/catalogue-detect"
import { APPS, DEFAULT_SELECTION, selectionOf, selectionProblems, totals, type Selection } from "../src/lib/arr/components"
import { composeFile, dataDirs, scriptEnv, startServices, vpnEnv } from "../src/lib/arr/compose"
import {
  NFS_OPTIONS, nfsOptions, cleanNfsSource, cleanHostPath, fstabLine, layoutOf, sameFilesystem, mountpointSpec, prepareScript,
  unmountScript, probeScript, parseProbe, judgeProbe, configProblems, SMB_REFUSAL, fstabEditScript, hostPathRefusal,
} from "../src/lib/arr/storage"
import { runArrSetup, setupSteps, keysScript, markers, type ArrSetupDeps } from "../src/lib/arr/setup"
import { checkArrOptions, checkVpnSecrets, arrJobSteps, arrPreview, arrRunSetup, pendingVpnItem, redact, PENDING_INDEX, type ArrDeps } from "../src/lib/arr/catalogue"
import { ARR_SCRIPT } from "../src/lib/arr/compose"
import { previewInstall, applyPreview, removeFailedInstall } from "../src/lib/catalogue-installer"
import { FakeStack } from "./fakes/arr-stack"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const sel = (apps: string[], vpn = false): Selection => ({ apps: apps as any, vpn })
const recipe = () => findRecipe("arr-stack")!
const values = (o: Record<string, unknown> = {}) => checkOptions(recipe(), o).values

// ── The recipe ──────────────────────────────────────────────────────────────

test("recipe: listed once, Docker, generated sign-in, defaults that are the default selection's cost", () => {
  const r = recipe()
  assert.equal(CATALOGUE.filter(x => x.id === "arr-stack").length, 1)
  assert.equal(r.needsDocker, true)
  assert.equal(r.stack, "arr")
  assert.equal(r.wizard, false, "the AI assistant cannot hand the generated sign-in back, so it does not install this")
  assert.deepEqual(r.firstRun, { kind: "env-admin", passwordEnv: "ARR_ADMIN_PASSWORD", user: "admin", userOption: "ARR_ADMIN_USER" })
  const t = totals(DEFAULT_SELECTION)
  assert.deepEqual({ cores: r.defaults.cores, memoryMb: r.defaults.memoryMb, diskGb: r.defaults.diskGb }, t)
  assert.deepEqual(r.satisfies, { kind: "plugin", id: "arrstack", setting: "sonarr_url" })
  // Every option key is a usable environment name and every app has its switch.
  for (const o of r.options!) assert.match(o.key, /^ARR_[A-Z_]+$/)
  for (const a of APPS) assert.ok(r.options!.some(o => o.key === a.option && o.kind === "boolean"), a.id)
})

test("recipe: every image is pinned to an exact release, never latest or a moving tag", () => {
  for (const a of APPS) {
    const tag = a.image.split(":").pop()!
    assert.ok(a.image.includes(":"), a.id)
    assert.doesNotMatch(tag, /^(latest|develop|nightly|v?\d+)$/, `${a.id}: ${a.image}`)
    assert.match(tag, /\d+\.\d+/, a.id)
  }
})

test("recipe: defaults turn on Sonarr, Radarr, Prowlarr and qBittorrent only, and the install script gets what it needs", () => {
  const v = values()
  assert.deepEqual(selectionOf(v), { apps: ["sonarr", "radarr", "prowlarr", "qbittorrent"], vpn: false })
  assert.equal(v.ARR_MEDIA, "disk"); assert.equal(v.ARR_DOWNLOADS, "together")
  // Without its generated password the script is refused, so nothing starts on a default.
  assert.throws(() => installScript(recipe(), "debian", v), /ARR_ADMIN_PASSWORD/)
  const env = { ...v, ARR_ADMIN_PASSWORD: "x", ...scriptEnv(selectionOf(v), { downloads: "together" }) }
  const s = installScript(recipe(), "debian", env)
  assert.match(s, /^set -e/)
  assert.match(s, /export ARR_COMPOSE_B64='[A-Za-z0-9+/=]+'/)
  assert.match(s, /docker compose up -d \$ARR_START/)
  assert.match(s, /unset ARR_ADMIN_PASSWORD/)
})

test("detect: a Sonarr, Radarr or Prowlarr behind a proxy shows the Arr Stack as installed; others do not", () => {
  const fps = DETECT["arr-stack"]
  const hit = (path: string, body: string, status = 200) => fps.filter(f => f.path === path).some(f => f.match({ status, headers: {}, body }))
  assert.ok(hit("/login", "<html><head><title>Login - Sonarr</title>"))
  assert.ok(hit("/", "<title>Radarr</title>"))
  assert.ok(hit("/login", "<title>Prowlarr</title>"))
  assert.ok(!hit("/login", "<title>Login - Lidarr</title>"), "only the three named")
  assert.ok(!hit("/", "<title>Sonarrish</title>"))
  assert.ok(!hit("/", "<title>Sonarr</title>", 500))
})

// ── The rules between the apps ──────────────────────────────────────────────

test("rules: Prowlarr is required with Sonarr or Radarr (and Lidarr), and the VPN only goes with qBittorrent", () => {
  assert.deepEqual(selectionProblems(sel(["sonarr", "radarr", "prowlarr", "qbittorrent"])).errors, [])
  assert.match(selectionProblems(sel(["sonarr", "qbittorrent"])).errors.join(), /Sonarr finds releases through Prowlarr/)
  assert.match(selectionProblems(sel(["sonarr", "radarr", "qbittorrent"])).errors.join(), /Sonarr and Radarr find releases through Prowlarr/)
  assert.match(selectionProblems(sel(["radarr", "qbittorrent"])).errors.join(), /Prowlarr is needed/)
  assert.match(selectionProblems(sel(["lidarr", "qbittorrent"])).errors.join(), /Prowlarr is needed/)
  assert.deepEqual(selectionProblems(sel(["qbittorrent"], true)).errors, [], "a VPN'd qBittorrent on its own is fine")
  assert.match(selectionProblems(sel(["sonarr", "prowlarr", "sabnzbd"], true)).errors.join(), /The VPN only covers qBittorrent/)
  assert.match(selectionProblems(sel(["bazarr"])).errors.join(), /works? with Sonarr or Radarr/)
  assert.match(selectionProblems(sel(["prowlarr", "flaresolverr"].slice(1))).errors.join(), /FlareSolverr helps Prowlarr/)
  assert.match(selectionProblems(sel([])).errors.join(), /at least one app/)
  assert.match(selectionProblems(sel(["sonarr", "prowlarr"])).warnings.join(), /No download client/)
})

test("rules: the options are checked as a whole, whatever sends them", () => {
  assert.deepEqual(checkArrOptions(values()).errors, [])
  assert.match(checkArrOptions(values({ ARR_PROWLARR: "0" })).errors.join(), /Prowlarr is needed/)
  assert.match(checkArrOptions(values({ ARR_QBITTORRENT: "0", ARR_VPN: "1", ARR_VPN_PROVIDER: "mullvad" })).errors.join(), /VPN only covers qBittorrent/)
  assert.match(checkArrOptions(values({ ARR_VPN: "1", ARR_VPN_PROVIDER: "nope" })).errors.join(), /Pick your VPN provider/)
  const pf = checkArrOptions(values({ ARR_VPN: "1", ARR_VPN_PROVIDER: "protonvpn" }))
  assert.deepEqual(pf.errors, []); assert.equal(pf.vpn!.portForwarding, true)
  assert.match(checkArrOptions(values({ ARR_VPN: "1", ARR_VPN_PROVIDER: "mullvad" })).warnings.join(), /does not offer port forwarding/)
  assert.match(checkArrOptions(values({ ARR_MEDIA: "elsewhere" })).errors.join(), /Pick where the library goes/)
})

test("rules: the VPN login is checked for its shape before it goes anywhere", () => {
  const key = "a".repeat(42) + "A="
  assert.deepEqual(checkVpnSecrets("wireguard", { wireguard_private_key: key, wireguard_addresses: "10.2.0.2/32" }).errors, [])
  assert.match(checkVpnSecrets("wireguard", { wireguard_private_key: "short" }).errors.join(), /44-character key/)
  assert.match(checkVpnSecrets("wireguard", { wireguard_private_key: key, wireguard_addresses: "10.2.0.2" }).errors.join(), /Address line/)
  assert.deepEqual(checkVpnSecrets("openvpn", { openvpn_user: "u", openvpn_password: "p" }).errors, [])
  assert.match(checkVpnSecrets("openvpn", { openvpn_user: "u\nx", openvpn_password: "p" }).errors.join(), /user name/)
  // A newline can never end a .env entry early.
  assert.equal(vpnEnv({ openvpn_password: "a\nB=1" }).VPN_OPENVPN_PASSWORD, "aB=1")
})

test("totals: whole cores, RAM in 256 MB steps, and local downloads add their room to the disk", () => {
  assert.deepEqual(totals(sel(["sonarr", "radarr", "prowlarr", "qbittorrent"])), { cores: 3, memoryMb: 2304, diskGb: 14 })
  const all = totals(sel(APPS.map(a => a.id), true))
  assert.ok(all.cores >= 6 && all.memoryMb % 256 === 0)
  assert.equal(totals(sel(["qbittorrent"]), 100).diskGb, totals(sel(["qbittorrent"])).diskGb + 100)
})

// ── The compose file ────────────────────────────────────────────────────────

const parse = (s: Selection, vpn?: any) => yaml.load(composeFile(s, { downloads: "together" }, vpn)) as any

test("compose: the default selection, every app on /data with one PUID/PGID and its own port", () => {
  const c = parse(sel(["sonarr", "radarr", "prowlarr", "qbittorrent"]))
  assert.deepEqual(Object.keys(c.services), ["sonarr", "radarr", "prowlarr", "qbittorrent"])
  for (const [id, svc] of Object.entries<any>(c.services)) {
    assert.ok(svc.environment.includes("PUID=1000") && svc.environment.includes("PGID=1000"), id)
    assert.equal(svc.restart, "unless-stopped")
    assert.doesNotMatch(svc.image, /:latest$/)
  }
  assert.ok(c.services.sonarr.volumes.includes("/data:/data"))
  assert.ok(!c.services.prowlarr.volumes.includes("/data:/data"), "Prowlarr never touches files")
  assert.equal(parse(sel(["prowlarr", "flaresolverr"])).services.flaresolverr.ports, undefined, "FlareSolverr is reached only inside Docker")
  assert.deepEqual(c.services.qbittorrent.ports, ["8080:8080", "6881:6881", "6881:6881/udp"])
  assert.ok(!c.services.gluetun)
  assert.ok(!composeFile(sel(["sonarr", "prowlarr"]), { downloads: "together" }).match(/PASSWORD|PRIVATE_KEY/))
})

test("compose: with the VPN, qBittorrent lives in Gluetun's network and its page is published there", () => {
  const c = parse(sel(["sonarr", "prowlarr", "qbittorrent"], true), { provider: "protonvpn", type: "wireguard", portForwarding: true })
  assert.deepEqual(Object.keys(c.services)[0], "gluetun")
  assert.equal(c.services.qbittorrent.network_mode, "service:gluetun")
  assert.equal(c.services.qbittorrent.ports, undefined)
  assert.deepEqual(c.services.qbittorrent.depends_on, { gluetun: { condition: "service_healthy" } })
  assert.deepEqual(c.services.gluetun.ports, ["8080:8080"])
  assert.deepEqual(c.services.gluetun.cap_add, ["NET_ADMIN"])
  assert.ok(c.services.gluetun.environment.includes("VPN_PORT_FORWARDING=on"))
  assert.ok(c.services.gluetun.environment.some((e: string) => e.startsWith("VPN_PORT_FORWARDING_UP_COMMAND=") && e.includes("{{PORTS}}")))
  assert.ok(c.services.gluetun.environment.includes("WIREGUARD_PRIVATE_KEY=${WIREGUARD_PRIVATE_KEY:?the installer sets this}"), "the secret comes from .env, never the file")
  const ovpn = parse(sel(["qbittorrent"], true), { provider: "mullvad", type: "openvpn", portForwarding: false })
  assert.ok(ovpn.services.gluetun.environment.includes("OPENVPN_PASSWORD=${OPENVPN_PASSWORD:?the installer sets this}"))
  assert.ok(!ovpn.services.gluetun.environment.some((e: string) => e.startsWith("VPN_PORT_FORWARDING")))
  assert.throws(() => composeFile(sel(["qbittorrent"], true), { downloads: "together" }), /settings are missing/)
})

test("compose: everything picked, with Seerr and FlareSolverr run as the same user and Seerr started last by setup", () => {
  const all = sel(APPS.map(a => a.id))
  const c = parse(all)
  assert.deepEqual(Object.keys(c.services), APPS.map(a => a.id))
  assert.equal(c.services.seerr.user, "1000:1000")
  assert.equal(c.services.flaresolverr.user, "1000:1000")
  assert.deepEqual(c.services.sabnzbd.ports, ["8085:8080"], "qBittorrent has 8080, so SABnzbd is on 8085 outside")
  assert.ok(!startServices(all).includes("seerr"))
  assert.ok(dataDirs(all).includes("/data/usenet/complete/tv") && dataDirs(all).includes("/data/torrents/movies"))
  assert.ok(!dataDirs(sel(["sonarr", "prowlarr", "sabnzbd"])).some(d => d.startsWith("/data/torrents")))
  // The file goes to the script base64 encoded: nothing in it is ever read as shell.
  const env = scriptEnv(all, { downloads: "together" })
  assert.equal(Buffer.from(env.ARR_COMPOSE_B64, "base64").toString(), composeFile(all, { downloads: "together" }))
  assert.equal(env.ARR_START.split(" ").includes("seerr"), false)
})

// ── Storage: the layout, the same-filesystem warning and the NFS mount ──────

test("storage: downloads with the library share a filesystem; on the container's disk they do not, and it says so", () => {
  assert.deepEqual(sameFilesystem({ downloads: "together" }), { same: true })
  const split = sameFilesystem({ downloads: "local" })
  assert.equal(split.same, false)
  assert.match(split.warning!, /different filesystems.*hardlinks and instant moves will not work/)
  assert.match(checkArrOptions(values({ ARR_DOWNLOADS: "local", ARR_DOWNLOAD_GB: "50" })).warnings.join(), /different filesystems/)
  assert.deepEqual(checkArrOptions(values()).warnings, [])
})

test("storage: the NFS options are fixed, and the fstab line is marked with the container", () => {
  assert.equal(NFS_OPTIONS, "rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail")
  assert.equal(nfsOptions(["noatime"]), `${NFS_OPTIONS},noatime`)
  assert.equal(nfsOptions(["hard"]), NFS_OPTIONS, "no option twice")
  assert.throws(() => nfsOptions(["rw;reboot"]), /not an NFS mount option/)
  const src = cleanNfsSource("10.0.0.20", "/Media/")
  assert.deepEqual(src, { host: "10.0.0.20", path: "/Media", source: "10.0.0.20:/Media" })
  assert.equal(fstabLine(src, 905), "10.0.0.20:/Media /mnt/hyperprox-arr/905 nfs rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail 0 0 # hyperprox-arr 905")
  assert.throws(() => cleanNfsSource("10.0.0.20", "//nas/media"), (e: Error) => e.message === SMB_REFUSAL)
  assert.throws(() => cleanNfsSource("smb://nas", "/m"), (e: Error) => e.message === SMB_REFUSAL)
  assert.throws(() => cleanNfsSource("nas;rm", "/m"), /IP address or name/)
  assert.throws(() => cleanNfsSource("nas", "/m/../etc"), /export is the folder/)
  assert.throws(() => cleanNfsSource("fe80::1", "/m"), /IPv4/)
})

test("storage: host folders are full paths, never system folders", () => {
  assert.equal(cleanHostPath("/mnt/media/"), "/mnt/media")
  for (const bad of ["/", "/etc", "/etc/pve", "/var/lib/vz", "mnt/media", "/mnt/../etc", "/mnt/my media"]) assert.throws(() => cleanHostPath(bad), bad)
})

test("storage: the mountpoint, the prepare script and its read-back", () => {
  const nfs = layoutOf(values({ ARR_MEDIA: "nfs", ARR_NFS_HOST: "nas.lan", ARR_NFS_EXPORT: "/media" })).layout!
  const disk = layoutOf(values({ ARR_MEDIA_GB: "500" })).layout!
  const local = layoutOf(values({ ARR_MEDIA: "path", ARR_HOST_PATH: "/mnt/media", ARR_DOWNLOADS: "local", ARR_DOWNLOAD_GB: "80" })).layout!
  assert.equal(mountpointSpec(disk, 905, "pool"), "pool:500,mp=/data,backup=0")
  assert.equal(mountpointSpec(nfs, 905, "pool"), "/mnt/hyperprox-arr/905,mp=/data,backup=0")
  assert.equal(mountpointSpec(local, 905, "pool"), "/mnt/media,mp=/data/media,backup=0", "local downloads: only the library is mounted")
  const p = prepareScript({ vmid: 905, layout: nfs, storage: "pool", tun: true })
  assert.match(p, /pct set "\$V" --features nesting=1,keyctl=1 -mp0 '\/mnt\/hyperprox-arr\/905,mp=\/data,backup=0' --dev0 \/dev\/net\/tun/)
  assert.match(p, /grep -v -- "\$K" "\$FS" > "\$T"/)
  assert.match(p, /mv -f "\$T" "\$FS"/)
  assert.doesNotMatch(p, />> \/etc\/fstab$/m, "fstab is renamed into place, never appended in place")
  assert.ok(p.indexOf("mount \"$M\"") < p.indexOf("pct set"), "mounted before it is handed in")
  assert.doesNotMatch(prepareScript({ vmid: 905, layout: disk, storage: "pool", tun: false }), /fstab|dev0/)
  assert.match(unmountScript(905), /umount -l "\$M"/)
  assert.deepEqual(configProblems({ features: "nesting=1,keyctl=1", mp0: "pool:vm-905-disk-1,mp=/data,backup=0,size=500G" }, { layout: disk, storage: "pool", vmid: 905, tun: false }), [])
  assert.match(configProblems({ features: "nesting=1", mp0: "pool:vm-905-disk-1,mp=/data" }, { layout: disk, storage: "pool", vmid: 905, tun: false }).join(), /not nesting=1,keyctl=1/)
  assert.match(configProblems({ features: "nesting=1,keyctl=1", mp0: "/mnt/hyperprox-arr/905,mp=/data" }, { layout: nfs, storage: "pool", vmid: 905, tun: true }).join(), /tun/)
})

test("storage: the NAS probe is read-only and its answer becomes checks, warnings or a refusal", () => {
  const nfs = layoutOf(values({ ARR_MEDIA: "nfs", ARR_NFS_HOST: "10.0.0.20", ARR_NFS_EXPORT: "/media" })).layout!
  const ps = probeScript(nfs)
  assert.match(ps, /mount -t nfs -o ro,/)
  assert.doesNotMatch(ps, /fstab|pct /)
  const good = judgeProbe(parseProbe("@@arr reachable\n@@arr space 2199023255552 4398046511104\n"), nfs)
  assert.deepEqual(good.errors, [])
  assert.match(good.checks.join(), /reachable over NFS.*2048 GB free/)
  assert.match(good.warnings.join(), /uid 101000/)
  assert.match(judgeProbe(parseProbe("@@arr mountfail access denied by server\n"), nfs).errors.join(), /could not be mounted.*access denied/)
  assert.match(judgeProbe(parseProbe("@@arr nonfs\n"), nfs).errors.join(), /no NFS client/)
  const path = layoutOf(values({ ARR_MEDIA: "path", ARR_HOST_PATH: "/mnt/media" })).layout!
  assert.match(judgeProbe(parseProbe("@@arr missing\n"), path).errors.join(), /not a folder on the chosen node/)
})

// ── The setup chores ────────────────────────────────────────────────────────

function setupDeps(f: FakeStack, over: Partial<ArrSetupDeps> = {}) {
  const vault: Record<string, Record<string, string>> = {}
  const plugins: Record<string, Record<string, string>> = {}
  const d: ArrSetupDeps & { vault: typeof vault; plugins: typeof plugins } = {
    vault, plugins,
    http: f.http, sh: f.sh, wait: async () => {},
    saveSecrets: async (c, p, v) => { vault[`${c}/${p}`] = { ...(vault[`${c}/${p}`] ?? {}), ...v } },
    readSecrets: async (c, p) => ({ ...(vault[`${c}/${p}`] ?? {}) }),
    pluginSettings: async id => ({ ...(plugins[id] ?? {}) }),
    savePluginSettings: async (id, v) => { plugins[id] = { ...(plugins[id] ?? {}), ...v } },
    localAddressTo: async () => "192.0.2.5",
    mediaServer: async () => null,
    ...over,
  }
  return d
}
const INPUT_S = (s: Selection) => ({ ip: "192.0.2.60", selection: s, admin: { user: "media-abc", password: "pw-generated" }, vault: { category: "apps", provider: "arr-stack-905" } })
function stepper() {
  const order: string[] = []
  const steps: Record<string, { status: string; detail?: string }> = {}
  return { order, steps, step: (id: string) => { order.push(id); return (steps[id] = { status: "running" }) } }
}

test("setup: runs its steps in order, and every app ends signed-in, connected and read back", async () => {
  const f = new FakeStack()
  const all = sel(["sonarr", "radarr", "prowlarr", "qbittorrent", "sabnzbd", "bazarr", "lidarr", "flaresolverr"])
  const d = setupDeps(f)
  const st = stepper()
  const out = await runArrSetup(INPUT_S(all), st.step, d)
  assert.deepEqual(st.order, setupSteps(all).map(x => x.id))
  assert.deepEqual(st.order, ["arr-start", "arr-storage", "arr-keys", "arr-auth", "arr-qbit", "arr-sab", "arr-folders", "arr-clients", "arr-prowlarr", "arr-bazarr", "arr-plugin"])
  for (const [id, s] of Object.entries(st.steps)) assert.equal(s.status, "done", `${id}: ${s.detail}`)
  // API keys: read, proved and in the vault.
  const v = d.vault["apps/arr-stack-905"]
  for (const a of ["sonarr", "radarr", "prowlarr", "lidarr", "bazarr", "sabnzbd"]) assert.equal(v[`${a}_api_key`], f.key(a), a)
  // Sign-in everywhere.
  for (const a of ["sonarr", "radarr", "prowlarr", "lidarr"]) assert.equal(f.servarr[a].auth, "forms", a)
  assert.equal(f.bazarr.auth.type, "form")
  assert.equal(f.qbit.password, "pw-generated"); assert.equal(f.qbit.user, "media-abc")
  assert.equal(f.sab.misc.username, "media-abc")
  // Library, clients, Prowlarr, Bazarr.
  assert.deepEqual(f.servarr.sonarr.folders.map(x => x.path), ["/data/media/tv"])
  assert.deepEqual(f.servarr.lidarr.folders.map(x => x.path), ["/data/media/music"])
  const qc = f.servarr.radarr.clients.find(c => c.implementation === "QBittorrent")
  assert.equal(qc.fields.find((x: any) => x.name === "movieCategory").value, "movies")
  assert.equal(qc.fields.find((x: any) => x.name === "host").value, "qbittorrent")
  assert.equal(f.servarr.sonarr.clients.find(c => c.implementation === "Sabnzbd").fields.find((x: any) => x.name === "apiKey").value, f.key("sabnzbd"))
  assert.deepEqual(f.servarr.prowlarr.apps.map(a => a.implementation), ["Sonarr", "Radarr", "Lidarr"])
  assert.equal(f.servarr.prowlarr.apps[0].fields.find((x: any) => x.name === "baseUrl").value, "http://sonarr:8989")
  assert.equal(f.servarr.prowlarr.proxies[0].fields.find((x: any) => x.name === "host").value, "http://flaresolverr:8191/")
  assert.deepEqual(f.servarr.prowlarr.proxies[0].tags, [7])
  assert.deepEqual(Object.keys(f.qbit.cats).sort(), ["movies", "music", "tv"])
  assert.equal(f.qbit.prefs.save_path, "/data/torrents")
  assert.equal(f.qbit.prefs.bypass_auth_subnet_whitelist, "192.0.2.5/32", "only HyperProx's own address skips the password")
  assert.equal(f.bazarr.sonarr.apikey, f.key("sonarr"))
  // HyperProx's plug-in.
  assert.equal(d.plugins.arrstack.sonarr_url, "http://192.0.2.60:8989")
  assert.equal(d.plugins.arrstack.qbit_url, "http://192.0.2.60:8080")
  assert.ok(out.apps.some(a => a.id === "sabnzbd" && a.url === "http://192.0.2.60:8085"))
  assert.ok(!out.apps.some(a => a.id === "flaresolverr"), "FlareSolverr has no page to open")
  // Nothing secret on a step.
  for (const s of Object.values(st.steps)) assert.doesNotMatch(String(s.detail), /pw-generated|0000/)
})

test("setup: with the VPN, qBittorrent is reached as gluetun and bound to the tunnel", async () => {
  const f = new FakeStack()
  const s = sel(["sonarr", "prowlarr", "qbittorrent"], true)
  const st = stepper()
  await runArrSetup({ ...INPUT_S(s), vpnPortForwarding: true }, st.step, setupDeps(f))
  assert.equal(f.qbit.prefs.current_network_interface, "tun0")
  assert.equal(f.qbit.prefs.bypass_local_auth, true, "Gluetun tells qBittorrent its port from inside the shared network")
  assert.equal(f.servarr.sonarr.clients[0].fields.find((x: any) => x.name === "host").value, "gluetun")
})

test("setup: a read-back that disagrees fails the step, it is never reported done", async () => {
  const f = new FakeStack()
  f.ignoreAuth.add("radarr")
  const st = stepper()
  await assert.rejects(runArrSetup(INPUT_S(sel(["sonarr", "radarr", "prowlarr"])), st.step, setupDeps(f)), /Radarr did not keep its sign-in settings/)
  assert.equal(st.steps["arr-auth"].status, "running", "left for the installer to mark failed")
})

test("setup: an app still open after its sign-in is set (and one restart) fails the install", async () => {
  const f = new FakeStack()
  f.stayOpen.add("sonarr")
  await assert.rejects(runArrSetup(INPUT_S(sel(["sonarr", "prowlarr"])), stepper().step, setupDeps(f)), /Sonarr still answers without signing in/)
  assert.deepEqual(f.restarts, ["sonarr"])
})

test("setup: downloads on another filesystem are reported, not hidden", async () => {
  const f = new FakeStack()
  f.devs = { media: "51", torrents: "50" } as any
  const st = stepper()
  const out = await runArrSetup(INPUT_S(sel(["sonarr", "prowlarr", "qbittorrent"])), st.step, setupDeps(f))
  assert.match(st.steps["arr-storage"].detail!, /different filesystem.*copied, not hardlinked/)
  assert.ok(out.notes.some(n => /different filesystem/.test(n)))
})

test("setup: a plug-in already reading a stack is left alone; Seerr without a Plex server is never started", async () => {
  const f = new FakeStack()
  const d = setupDeps(f)
  d.plugins.arrstack = { sonarr_url: "http://192.0.2.9:8989", sonarr_key: "k" }
  const st = stepper()
  await runArrSetup(INPUT_S(sel(["sonarr", "prowlarr", "seerr"])), st.step, d)
  assert.equal(st.steps["arr-plugin"].status, "skipped")
  assert.equal(d.plugins.arrstack.sonarr_url, "http://192.0.2.9:8989")
  assert.equal(st.steps["arr-seerr"].status, "skipped")
  assert.match(st.steps["arr-seerr"].detail!, /belongs to whoever opens it first/)
  assert.ok(!f.log.some(l => l.includes("seerr")), "nothing asked of Seerr")
})

test("setup: the key script reads each app's own file, and markers ignore anything else", () => {
  const k = keysScript(sel(["sonarr", "bazarr", "sabnzbd"]))
  assert.match(k, /\/opt\/arr\/config\/sonarr\/config.xml/)
  assert.match(k, /bazarr\/config\/config.yaml/)
  assert.match(k, /sabnzbd\/sabnzbd.ini/)
  assert.doesNotMatch(k, /radarr/)
  assert.deepEqual(markers("noise\n@@key sonarr abc\n@@key bad\n  @@key radarr def  \n", "key"), { sonarr: "abc", radarr: "def" })
})

// ── The install wizard, end to end on a fake cluster ────────────────────────

function arrDeps(f: FakeStack, pve: FakePve, calls: string[], plugins: Record<string, Record<string, string>> = {}): ArrDeps {
  return {
    http: f.http,
    nodeRun: async (_node, script) => {
      calls.push(script)
      if (script.includes("@@arr prepared")) {
        const vmid = Number(/V=(\d+)/.exec(script)![1])
        const mp0 = /-mp0 '([^']+)'/.exec(script)![1].replace(/^pool:(\d+)/, "pool:vm-$1-disk-1")
        pve.configs[vmid] = { ...pve.configs[vmid], features: "nesting=1,keyctl=1", mp0, ...(script.includes("--dev0") ? { dev0: "/dev/net/tun" } : {}) }
        return { code: 0, output: `${script.includes("fstab") ? "@@arr mounted\n" : ""}@@arr prepared\n` }
      }
      if (script.includes("@@arr unmounted")) return { code: 0, output: "@@arr unmounted\n" }
      return { code: 0, output: "@@arr reachable\n@@arr space 1099511627776 2199023255552\n" }
    },
    pluginSettings: async id => ({ ...(plugins[id] ?? {}) }), savePluginSettings: async (id, v) => { plugins[id] = { ...(plugins[id] ?? {}), ...v } },
    localAddressTo: async () => "192.0.2.5", mediaServer: async () => null,
  }
}

test("wizard: preview checks the apps and library, keeps the VPN login in the vault (not the plan), and applies to a working stack", async () => {
  const pve = new FakePve()
  const f = new FakeStack()
  const calls: string[] = []
  const vault: Record<string, Record<string, string>> = {}
  const scripts: string[] = []
  const d = deps(pve, {
    arr: () => arrDeps(f, pve, calls),
    saveSecrets: async (c, p, v) => { vault[`${c}/${p}`] = { ...(vault[`${c}/${p}`] ?? {}), ...v } },
    readSecrets: async (c, p) => ({ ...(vault[`${c}/${p}`] ?? {}) }),
    deleteSecrets: async (c, p) => { delete vault[`${c}/${p}`] },
    exec: async (o: any) => { scripts.push(o.script); return { ...(await f.sh(o.script)), timedOut: false } },
  })
  const key = "b".repeat(42) + "E="
  const input = {
    ...INPUT({ recipeId: "arr-stack", hostname: "arr", vmid: 905, cores: 3, memoryMb: 2304, diskGb: 14 }),
    options: { ARR_VPN: "1", ARR_VPN_PROVIDER: "protonvpn", ARR_MEDIA: "nfs", ARR_NFS_HOST: "10.0.0.20", ARR_NFS_EXPORT: "/media" },
    arrVpn: { wireguard_private_key: key, wireguard_addresses: "10.2.0.2/32" },
  }
  // A pending login from a preview nobody applied, long lapsed, is swept by the next preview.
  vault[`apps/${PENDING_INDEX.provider}`] = { refs: JSON.stringify({ "00000000-0000-4000-8000-000000000000": 1 }) }
  vault["apps/arr-vpn-pending-00000000-0000-4000-8000-000000000000"] = { wireguard_private_key: "old" }
  const r = await previewInstall({ ...input, options: { ...input.options, ARR_VPN_REF: "00000000-0000-4000-8000-000000000000" } } as any, "a@example.com", d)
  assert.deepEqual(r.errors, [])
  const plan = r.preview!.plan
  assert.equal(vault["apps/arr-vpn-pending-00000000-0000-4000-8000-000000000000"], undefined, "a lapsed pending login is deleted")
  assert.notEqual(plan.options!.ARR_VPN_REF, "00000000-0000-4000-8000-000000000000", "a request cannot name the pending item")
  assert.match(plan.options!.ARR_ADMIN_USER, /^media-[0-9a-f]{6}$/, "a sign-in name is made up, never admin")
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(key), "the VPN key is never in the plan")
  const ref = plan.options!.ARR_VPN_REF
  assert.match(ref, /^[0-9a-f-]{36}$/, "the VPN login is kept per preview")
  assert.equal(vault[`apps/${pendingVpnItem(ref).provider}`].wireguard_private_key, key)
  assert.ok(JSON.parse(vault[`apps/${PENDING_INDEX.provider}`].refs)[ref] > Date.now())
  assert.ok(r.checks.some(c => /reachable over NFS/.test(c)))
  assert.ok(r.checks.some(c => /keyctl/.test(c)))
  assert.ok(calls.some(c => c.includes("mount -t nfs -o ro")), "the NAS was looked at from the node")

  const job = await applyPreview(r.preview!.id, "a@example.com", d)
  assert.deepEqual(job.steps.map(s => s.id), ["container", "network", "install", ...setupSteps(sel(["sonarr", "radarr", "prowlarr", "qbittorrent"], true)).map(s => s.id)])
  const done = await settled(job.jobId)
  assert.equal(done.status, "completed", `${done.error} ${JSON.stringify(done.steps)}`)
  // Created with nesting by the API, then keyctl, tun and the NAS mount over the node login, read back.
  assert.equal(pve.creates[0].body.get("features"), "nesting=1")
  assert.ok(calls.some(c => c.includes("--features nesting=1,keyctl=1") && c.includes("--dev0 /dev/net/tun") && c.includes("fstab")))
  assert.match(done.steps[0].detail!, /^CT 905 on node-a: nesting and keyctl on, \/dev\/net\/tun for the VPN; library on 10.0.0.20:\/media/)
  assert.deepEqual(done.arrHostMount, { node: "node-a", vmid: 905 })
  // The install script carried the compose file and the VPN key (from the vault), which then moved to the stack's item.
  const install = scripts.find(s => s.includes("ARR_COMPOSE_B64"))!
  assert.ok(install.includes(`export VPN_WIREGUARD_PRIVATE_KEY='${key}'`))
  assert.equal(vault[`apps/${pendingVpnItem(ref).provider}`], undefined, "the preview's copy is gone")
  assert.equal(JSON.parse(vault[`apps/${PENDING_INDEX.provider}`].refs)[ref], undefined)
  const item = vault["apps/arr-stack-905"]
  assert.equal(item.vpn_wireguard_private_key, key)
  assert.equal(item.admin_user, plan.options!.ARR_ADMIN_USER)
  assert.equal(item.sonarr_api_key, f.key("sonarr"))
  assert.ok(done.steps.every(s => s.status === "done"), JSON.stringify(done.steps))
  assert.ok(done.arrApps!.some(a => a.id === "radarr" && a.url.endsWith(":7878")))
  assert.ok(done.adminCredential && done.adminCredential.vault.provider === "arr-stack-905")
})

test("wizard: a hand-made request that breaks the rules is refused before anything is made", async () => {
  const pve = new FakePve()
  const d = deps(pve, { arr: () => arrDeps(new FakeStack(), pve, []) })
  const r = await previewInstall({ ...INPUT({ recipeId: "arr-stack", hostname: "arr", vmid: 905 }), options: { ARR_PROWLARR: "0" } } as any, "a@example.com", d)
  assert.equal(r.preview, undefined)
  assert.match(r.errors.join(), /Prowlarr is needed/)
  const v = await previewInstall({ ...INPUT({ recipeId: "arr-stack", hostname: "arr", vmid: 905 }), options: { ARR_VPN: "1", ARR_VPN_PROVIDER: "mullvad" }, arrVpn: { wireguard_private_key: "nope" } } as any, "a@example.com", d)
  assert.match(v.errors.join(), /44-character key/)
  assert.equal(pve.creates.length, 0)
})

test("wizard: a failed Arr Stack's clean-up also undoes its NAS mount", async () => {
  const pve = new FakePve()
  const f = new FakeStack()
  f.stayOpen.add("sonarr")
  const calls: string[] = []
  const vault: Record<string, Record<string, string>> = {}
  const d = deps(pve, {
    arr: () => arrDeps(f, pve, calls), exec: async (o: any) => ({ ...(await f.sh(o.script)), timedOut: false }),
    saveSecrets: async (c, p, v) => { vault[`${c}/${p}`] = { ...(vault[`${c}/${p}`] ?? {}), ...v } },
    readSecrets: async (c, p) => ({ ...(vault[`${c}/${p}`] ?? {}) }),
  })
  const r = await previewInstall({ ...INPUT({ recipeId: "arr-stack", hostname: "arr", vmid: 906 }), options: { ARR_MEDIA: "nfs", ARR_NFS_HOST: "10.0.0.20", ARR_NFS_EXPORT: "/media" } } as any, "a@example.com", d)
  assert.deepEqual(r.errors, [])
  const job = await applyPreview(r.preview!.id, "a@example.com", d)
  const done = await settled(job.jobId)
  assert.equal(done.status, "failed")
  assert.match(done.error!, /Sonarr still answers without signing in\. Every app was stopped, so nothing is left running half set up/)
  assert.equal(f.stops.length, 1, "docker compose stop ran before the job was marked failed")
  assert.equal(done.steps.find(s => s.id === "arr-auth")!.status, "failed")
  const msg = await removeFailedInstall(job.jobId, "a@example.com", d)
  assert.match(msg, /CT 906 was removed/)
  assert.match(msg, /NAS mount on node-a was undone/)
  assert.ok(calls.some(c => c.includes("@@arr unmounted")))
})

test("wizard: arrJobSteps swaps the generic check and wiring for the setup steps, before publishing", () => {
  const base = ["container", "network", "install", "verify", "wire"].map(id => ({ id, label: id, status: "pending" }))
  const steps = arrJobSteps(base, values({ ARR_BAZARR: "1" }), [{ app: "sonarr", plan: { domain: "tv.example.com" } as any }])
  assert.deepEqual(steps.map(s => s.id), ["container", "network", "install", ...setupSteps(sel(["sonarr", "radarr", "prowlarr", "qbittorrent", "bazarr"])).map(s => s.id), "arr-publish-sonarr"])
})

test("wizard: download clients are never published, and two apps cannot share a name", async () => {
  const pub = { dns: async () => null } as any
  const r = await arrPreview({ node: "node-a", owner: "a", storage: "pool", diskGb: 20, values: values(),
    publish: { zone: "example.com", instanceId: "npm", names: { qbittorrent: "torrents" } } }, { publish: pub, saveSecrets: async () => {} }, () => "abc123")
  assert.match(r.errors.join(), /qBittorrent is never given a public name/)
  const two = await arrPreview({ node: "node-a", owner: "a", storage: "pool", diskGb: 20, values: values(),
    publish: { zone: "example.com", instanceId: "npm", names: { sonarr: "media", radarr: "media" } } }, { publish: pub, saveSecrets: async () => {} }, () => "abc123")
  assert.match(two.errors.join(), /media is given to two apps/)
})

// ── Review fixes: fstab, node folders, failure, secrets, .env ───────────────

const bash = (script: string, env: Record<string, string> = {}) => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } })

test("fstab: only this container's line changes, 101 never touches 1010, and the file is renamed into place with its mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "hpx-arr-fstab-"))
  try {
    const fs = join(dir, "fstab")
    writeFileSync(fs, "UUID=x / ext4 defaults 0 1\nnas:/a /mnt/hyperprox-arr/1010 nfs rw 0 0 # hyperprox-arr 1010\nnas:/old /mnt/hyperprox-arr/101 nfs rw 0 0 # hyperprox-arr 101\n")
    chmodSync(fs, 0o640)
    const line = fstabLine(cleanNfsSource("nas", "/new"), 101)
    assert.equal(bash(fstabEditScript(101, line, fs)).status, 0)
    assert.equal(readFileSync(fs, "utf8"), `UUID=x / ext4 defaults 0 1\nnas:/a /mnt/hyperprox-arr/1010 nfs rw 0 0 # hyperprox-arr 1010\n${line}\n`)
    assert.equal(statSync(fs).mode & 0o777, 0o640, "the mode is kept")
    // Again: replaced, never doubled.
    bash(fstabEditScript(101, line, fs))
    assert.equal(readFileSync(fs, "utf8").split("\n").filter(l => l.endsWith("# hyperprox-arr 101")).length, 1)
    // Removal (as unmount does) leaves 1010 alone.
    assert.equal(bash(fstabEditScript(101, null, fs)).status, 0)
    assert.equal(readFileSync(fs, "utf8"), "UUID=x / ext4 defaults 0 1\nnas:/a /mnt/hyperprox-arr/1010 nfs rw 0 0 # hyperprox-arr 1010\n")
    assert.match(unmountScript(1010, fs), /# hyperprox-arr 1010\$/)
    // An unreadable fstab (grep exit 2) stops it and changes nothing.
    const r = bash(fstabEditScript(101, line, join(dir, "missing")))
    assert.equal(r.status, 4); assert.match(r.stdout, /@@arr fstabfail/)
    assert.deepEqual(execFileSync("ls", ["-A", dir], { encoding: "utf8" }).trim().split("\n"), ["fstab"], "no temp file left behind")
    assert.throws(() => fstabEditScript(101, fstabLine(cleanNfsSource("nas", "/x"), 1010), fs), /not this container/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("node folders: refused by what they resolve to, symlinks included", () => {
  for (const p of ["/", "/etc", "/etc/pve", "/root", "/root/.ssh", "/var", "/var/lib/ceph", "/var/lib/vz/images", "/var/lib/pve-cluster",
    "/usr/local", "/lib64", "/libx32", "/opt/media", "/tmp/x", "/run/media", "/boot/efi", "/mnt/hyperprox-arr/1010", "/mnt/hyperprox-pbs/200"]) {
    assert.ok(hostPathRefusal(p, 101), p)
  }
  for (const p of ["/mnt/media", "/srv/media", "/data", "/media/usb", "/mnt/hyperprox-arr/101"]) assert.equal(hostPathRefusal(p, 101), null, p)
  assert.throws(() => cleanHostPath("/root/.ssh"), /system folder/)
  const dir = mkdtempSync(join(tmpdir(), "hpx-arr-path-"))
  try {
    for (const [name, to] of [["etc", "/etc"], ["home-of-root", "/root"], ["var", "/var"]]) {
      symlinkSync(to, join(dir, name))
      // Built directly: the wizard's own check already refuses anything typed under /tmp, where scratch folders live.
      const l = { media: "path" as const, downloads: "together" as const, hostPath: join(dir, name) }
      // The preview's look from the node: resolved, then refused there and here.
      const pr = parseProbe(bash(probeScript(l, 101)).stdout)
      assert.equal(pr.refused, to, name)
      assert.match(judgeProbe(pr, l, 101).errors.join(), new RegExp(`is ${to} on the node`), name)
      // The prepare script resolves again and refuses before it stops or changes anything (pct here is a stand-in).
      const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, "pct"), `#!/bin/sh\necho "pct $*" >> ${join(dir, "pct.log")}\n`); chmodSync(join(bin, "pct"), 0o755)
      const run = bash(prepareScript({ vmid: 101, layout: l, storage: "pool", tun: false }), { PATH: `${bin}:${process.env.PATH}` })
      assert.equal(run.status, 5, name); assert.match(run.stdout, new RegExp(`@@arr refused ${to}$`, "m"))
      assert.throws(() => readFileSync(join(dir, "pct.log")), "pct was never called")
    }
    // Scratch folders live under /tmp, which is itself refused, so a real folder that resolves is shown this way:
    // the pct line takes the resolved path R, never the path as typed.
    const l = layoutOf(values({ ARR_MEDIA: "path", ARR_HOST_PATH: "/mnt/link-to-media" })).layout!
    const set = prepareScript({ vmid: 101, layout: l, storage: "pool", tun: false }).split("\n").find(x => x.startsWith("pct set"))!
    assert.equal(bash(`pct() { echo "pct $*"; }; V=101; R=/srv/media; ${set}`).stdout.trim(), "pct set 101 --features nesting=1,keyctl=1 -mp0 /srv/media,mp=/data,backup=0")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("failure: any failed setup stops the apps first, says so, and keeps secrets out of the message", async () => {
  const f = new FakeStack()
  f.ignoreAuth.add("sonarr")
  const vault: Record<string, string> = {}
  const d = {
    arr: () => ({ http: f.http, nodeRun: async () => ({ code: 0, output: "" }), pluginSettings: async () => ({}), savePluginSettings: async () => {},
      localAddressTo: async () => null, mediaServer: async () => null }),
    sh: f.sh, wait: async () => {}, publish: {} as any,
    saveSecrets: async (_c: string, _p: string, v: Record<string, string>) => { Object.assign(vault, v) },
    readSecrets: async () => ({ ...vault }),
  }
  const o = { ip: "192.0.2.60", owner: "a", options: values(), admin: { user: "media-x", password: "pw-generated-123" }, vault: { category: "apps", provider: "arr-stack-905" },
    recipe: recipe(), ledgers: {}, save: () => {} }
  await assert.rejects(arrRunSetup(o, () => ({ status: "running" }), d), /did not keep its sign-in settings\. Every app was stopped/)
  assert.equal(f.stops.length, 1)
  // When Compose cannot stop them, the whole container is stopped.
  const f2 = new FakeStack(); f2.ignoreAuth.add("sonarr"); f2.stopFails = true
  let ctStopped = false
  await assert.rejects(arrRunSetup(o, () => ({ status: "running" }), { ...d, arr: () => ({ ...d.arr(), http: f2.http }), sh: f2.sh, stopContainer: async () => (ctStopped = true) }), /the whole container was stopped/)
  assert.equal(ctStopped, true)
  assert.equal(redact("got pw-generated-123 and KEYKEYKEY back", ["pw-generated-123", "KEYKEYKEY", "x"]), "got [hidden] and [hidden] back")
})

test("secrets: SABnzbd's key and password never travel in a URL; Bazarr's page is checked for its key", async () => {
  const f = new FakeStack()
  await runArrSetup({ ip: "192.0.2.60", selection: sel(["sonarr", "prowlarr", "sabnzbd", "bazarr"]), admin: { user: "media-x", password: "pw-generated-123" }, vault: { category: "apps", provider: "p" } },
    () => ({ status: "running" }), setupDeps(f))
  assert.ok(!f.urls.some(u => u.includes("pw-generated-123") || u.includes(f.key("sabnzbd"))), f.urls.filter(u => u.includes("8085")).join(" "))
  // Bazarr left handing out its key on its page fails the check.
  const g = new FakeStack(); g.stayOpen.add("bazarr")
  await assert.rejects(runArrSetup({ ip: "192.0.2.60", selection: sel(["sonarr", "prowlarr", "bazarr"]), admin: { user: "media-x", password: "pw-generated-123" }, vault: { category: "apps", provider: "p" } },
    () => ({ status: "running" }), setupDeps(g)), /Bazarr still answers without signing in/)
})

test("setup: an app's error page never reaches the job: only its status", async () => {
  const f = new FakeStack()
  const http = async (r: any) => (r.url.includes("/config/host") && r.method === "PUT" ? { status: 400, headers: {}, body: `{"error":"bad","apiKey":"${f.key("sonarr")}"}` } : f.http(r))
  await assert.rejects(runArrSetup(INPUT_S(sel(["sonarr", "prowlarr"])), stepper().step, setupDeps(f, { http })), (e: Error) => {
    assert.match(e.message, /Saving Sonarr's sign-in answered 400 \(the app refused the settings\)\.$/)
    assert.ok(!e.message.includes(f.key("sonarr")))
    return true
  })
})

test(".env: every value single-quoted, so a $ or a quote in a VPN password reaches Compose as typed", () => {
  const fn = /envq\(\) \{.*\}/.exec(ARR_SCRIPT)![0]
  const out = bash(`${fn}\nenvq OPENVPN_PASSWORD "$PW"`, { PW: `a$HOME'b"c\\d` }).stdout
  assert.equal(out, `OPENVPN_PASSWORD='a$HOME\\'b"c\\d'\n`)
})

test("wizard: Seerr waiting is never told to be started by hand", async () => {
  const f = new FakeStack()
  const st = stepper()
  await runArrSetup(INPUT_S(sel(["sonarr", "prowlarr", "seerr"])), st.step, setupDeps(f))
  assert.match(st.steps["arr-seerr"].detail!, /Connect Plex in HyperProx, then press "Finish Seerr"/)
  assert.doesNotMatch(st.steps["arr-seerr"].detail!, /docker compose up/)
})
