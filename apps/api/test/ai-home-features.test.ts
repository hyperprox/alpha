// The assistant and what is attached to HyperProx: each NAS, the alerts, notification channels, every Home
// Assistant house, the websites and their visitor figures; pulling a static site and a SMART test, prepared and
// confirmed; a new website planned through the New website wizard's own code. Everything outside is a fake, and
// the model must never be called: each answer here is worked out by code.
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildAiRoutes } from "../src/routes/ai"
import { PreparedStore } from "../src/lib/ai/prepared"
import { promptText, indexText, type AskSource } from "../src/lib/ai/ask"
import { coreSources, pluginSources } from "../src/lib/ai/ask-sources"
import { perClusterSources, networkStorageSummary } from "../src/lib/ai/cluster-sources"
import {
  qnapSource, alertsSource, notifySource, housesSource, sitesSource, siteMetricsSource, toChannelLite, sixPoints,
  ADMIN_ONLY_NOTIFY, ADMIN_ONLY_SITES, METRICS_NOT_COLLECTED, type NasEntry, type HouseRead, type SiteLite, type ChannelLite,
} from "../src/lib/ai/home-sources"
import { NOT_COLLECTED, type SiteMetricsSource, type SiteMetrics } from "../src/lib/ai/site-metrics"
import { parseHomeAction, BY_HAND, TOKEN_SAY, type HomePlan } from "../src/lib/ai/home-actions"
import { isWebsiteRequest, extractWebsite, nextQuestion, adminUserFrom, WebsiteDrafts, WEBSITE_TOKEN } from "../src/lib/ai/templates/website"
import { visualLines } from "../src/lib/ai/visual-lines"
import { HOME_ID } from "../src/lib/clusters/registry"
import type { ClusterRef } from "../src/lib/ai/clusters"
import type { ModelCall } from "../src/lib/ai/extract"
import type { Role } from "../src/lib/roles"
import type { QnapReading } from "../src/lib/qnap/parse"
import type { PromAlert, ForwarderState } from "../src/lib/alerts/forwarder"
import type { ClusterPanel } from "../src/lib/clusters/overview"
import type { ActionPlan } from "../src/lib/ai/actions"
import type { CertLite } from "../src/lib/ai/ask-sources"

const HOME: ClusterRef = { id: HOME_ID, name: "Home cluster", kind: "home" }
const never: ModelCall = async () => { throw new Error("the model must not be called") }

// What must never reach a prompt or an answer.
const SECRETS = ["00:11:22:33:44:55", "10.0.0.5", "10.0.0.9", "nas1-host", "hunter2", "https://hooks.example.com/abc", "chat-12345", "token-sekret", "192.0.2.10"]
const SERIAL = "S3RIAL-XYZ"

// ---------------------------------------------------------------------------
//  The world
// ---------------------------------------------------------------------------

function reading(over: Partial<QnapReading> = {}): QnapReading {
  return {
    fetchedAt: "2026-11-11T10:00:00Z", generation: "storage-v2", model: "TS-453D", hostname: "nas1-host", serial: "NASSERIAL",
    firmware: { version: "5.2.1", build: "20261001", number: null }, update: { available: false, version: null, checkedAt: null },
    uptimeSec: 864000, health: "good", cpuPct: 5, memTotalMB: 8192, memFreeMB: 4096, sysTempC: 41, cpuTempC: 50,
    thresholds: { sysWarnC: null, sysErrC: null, diskWarnC: null, diskErrC: null, ssdWarnC: null },
    fans: [{ index: 1, rpm: 800, ok: true }],
    disks: [
      { bay: 1, model: "WD Red 4TB", capacity: "3.64 TB", sizeBytes: 4e12, tempC: 36, smart: "good", smartText: "OK", lastTest: { status: "Completed", type: "Quick", time: null }, serial: "GOODSERIAL", firmware: null },
      { bay: 3, model: "ST4000VN", capacity: "3.64 TB", sizeBytes: 4e12, tempC: 39, smart: "bad", smartText: "Abnormal", lastTest: { status: "Failed", type: "Quick", time: null }, serial: SERIAL, firmware: null },
    ],
    volumes: [{ id: "1", name: "DataVol1", health: "good", status: "Ready", degraded: false, totalBytes: 8e12, freeBytes: 2e12, usedBytes: 6e12, disks: [1, 3], pool: null }],
    pools: [], shares: [],
    interfaces: [{ name: "eth0", up: true, speedMbps: 1000, ip: "10.0.0.5", mask: "255.255.255.0", mac: "00:11:22:33:44:55", mode: null, rxPackets: null, txPackets: null, errors: null, rxBps: null, txBps: null }],
    missing: [], ...over,
  }
}

const NAS: NasEntry[] = [
  { id: "n1", name: "nas1", beside: null, diskTempWarnC: null, reading: reading(), error: null },
  { id: "n2", name: "backup-nas", beside: "Remote server", diskTempWarnC: null, reading: reading({ disks: [reading().disks[0]], hostname: "nas1-host" }), error: null },
]

const now = Date.parse("2026-11-11T12:00:00Z")
const ALERTS: PromAlert[] = [
  { labels: { alertname: "FanStuckAtMax", node: "node2", severity: "warning", chip: "x", sensor: "pwm1" }, state: "firing", activeAt: "2026-11-11T11:00:00Z",
    annotations: { title: "Fan stuck at full speed", plain: "A fan has run at full speed for 15 minutes: something is hot, or a sensor or GPU has hung." } },
  { labels: { alertname: "CPUHot", node: "node2", severity: "warning" }, state: "firing", activeAt: "2026-11-11T11:10:00Z",
    annotations: { title: "Processor hot", plain: "The processor has been above 90 °C for 5 minutes (now 94 °C). Check its fans and airflow." } },
  { labels: { alertname: "MonitoringTargetDown", job: "pve", instance: "10.0.0.9:9221", severity: "warning" }, state: "firing", activeAt: "2026-11-11T11:30:00Z",
    annotations: { summary: "pve target 10.0.0.9:9221 is down" } },
  { labels: { alertname: "NodeHighCPU", node: "node1", severity: "warning" }, state: "pending", annotations: { summary: "High CPU on node1" } },
]
const FWD: ForwarderState = { firing: { a: { alertname: "FanStuckAtMax", severity: "warning", title: "Fan stuck at full speed on node2", place: "node2", since: "2026-11-11T11:00:00Z" } },
  prometheus: { seenOk: true, failingSince: null, announced: false } }

// A full channel view, secrets and all, as lib/notify hands it out: only the cut-down one may be read.
const CHANNEL_VIEW = {
  id: "c1", name: "Ops", kind: "discord", enabled: true, minSeverity: "warning", eventFilter: ["backups", "updates"], quietHours: { start: "22:00", end: "07:00", criticalBreaksThrough: true },
  lanOverride: false, usableWhileLocked: false, private: true, chatId: "chat-12345", mask: "https://hooks.example.com/abc", secretReadable: true, hasToken: true, hasSigningSecret: false,
  lastResult: { ok: false, status: 404, code: "http_404", at: "2026-11-11T11:00:00Z", text: "token-sekret" }, lastSentAt: "2026-11-11T11:00:00Z", failingSince: "2026-11-11T09:00:00Z",
  seededFrom: null, createdBy: "a@example.com", createdAt: "x", updatedAt: "x",
}

function houses(viewer: boolean): HouseRead[] {
  const sec = (name: string, domain: string, kind: string, state: string) => ({ name, domain, kind, tier: "security" as const, unavailable: false, state: viewer ? "hidden" : state })
  return [
    { name: "Home", beside: null, error: null, areas: [
      { name: "Living room", devices: [
        { name: "Ceiling light", domain: "light", kind: "light", tier: "normal", unavailable: false, state: "on" },
        { name: "Floor lamp", domain: "light", kind: "light", tier: "normal", unavailable: false, state: "off" },
        { name: "Reading lamp", domain: "switch", kind: "light", tier: "normal", unavailable: false, state: "on" },
      ] },
      { name: "Hall", devices: [sec("Front door", "lock", "lock", "unlocked"), sec("House alarm", "alarm_control_panel", "alarm", "armed_away")] },
    ] },
    { name: "Cabin", beside: "Remote server", error: null, areas: [{ name: "Kitchen", devices: [{ name: "Kitchen light", domain: "light", kind: "light", tier: "normal", unavailable: false, state: "on" }] }] },
  ]
}

const SITES: SiteLite[] = [
  { id: "s1", name: "blog", kind: "wordpress", kindName: "WordPress", domain: "blog.example.com", url: "https://blog.example.com", vmid: 150, node: "node1", hasVault: true },
  { id: "s2", name: "docs", kind: "static-site", kindName: "Static site", domain: "docs.example.com", url: "https://docs.example.com", vmid: 151, node: "node2", hasVault: false },
]
const CERTS: CertLite[] = [
  { names: ["blog.example.com"], daysLeft: 40, notAfter: "2026-12-21T00:00:00Z", verdict: "ok", source: "npm" },
  { names: ["docs.example.com"], daysLeft: 12, notAfter: "2026-11-23T00:00:00Z", verdict: "warn", source: "npm" },
]
const metric = (range: SiteMetrics["range"], visitors: number, pageViews: number): SiteMetrics =>
  ({ range, visitors, pageViews, errorRate: 0.005, p95Ms: 210, topPages: [{ path: "/", views: 200 }, { path: "/about", views: 40 }], topReferrers: [{ source: "search.example.org", visits: 30 }], uptimePct: 99.95 })
const METRICS: SiteMetricsSource = {
  available: () => true,
  siteMetrics: async (id, range) => (id === "s1" ? metric(range, range === "today" ? 120 : range === "week" ? 900 : 3500, range === "today" ? 340 : 2500) : null),
}

const PANEL = {
  id: HOME_ID, name: "Home cluster", kind: "home", reachable: true, latencyMs: 1, nodes: { online: 2, total: 2 }, quorum: "ok", guests: { running: 2, total: 2 },
  cpuPct: 5, memPct: 20, storagePct: 30, gpus: [], gpuNote: null, lastBackup: null, attention: [], monitoring: true,
  networkStorage: [{ server: "192.0.2.10", shares: 2, volumes: 1, names: ["qnap-media"], usedBytes: 6e12, totalBytes: 8e12, pct: 75 }],
} as unknown as ClusterPanel

interface Opts { role?: Role; metrics?: SiteMetricsSource; unlocked?: boolean }

function homeSources(o: Opts = {}): AskSource[] {
  const role = o.role ?? "admin"
  const unlocked = () => o.unlocked ?? true
  return [
    qnapSource({ list: async () => NAS, role, unlocked }),
    alertsSource({ fetch: async () => ALERTS, state: () => FWD, notForwarded: () => ["CephHealthWarning"], clusterName: () => null, now: () => now }),
    notifySource({ role, channels: async () => [toChannelLite(CHANNEL_VIEW as any)], now: () => now }),
    housesSource({ houses: async v => houses(v), role, unlocked }),
    sitesSource({ role, sites: async () => SITES, certs: async () => CERTS,
      health: async id => (id === "s1" ? { container: true, public: { ok: true, detail: "answered 200" } } : { container: true, public: { ok: false, detail: "answered 502" } }) }, SITES.map(s => s.domain!)),
    siteMetricsSource({ metrics: o.metrics ?? METRICS, sites: async () => SITES, role }),
  ]
}

const facts = () => JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))

function allSources(o: Opts = {}): AskSource[] {
  const core = coreSources({ fetchStrict: async () => { throw new Error("not read here") }, facts: facts(), certs: async () => CERTS, unlocked: () => true, role: o.role ?? "admin" })
    .filter(s => s.id === "certs")
  const per = perClusterSources(HOME, {
    inCluster: (_id, fn) => fn(), fetchStrict: async () => { throw new Error("x") }, panel: async () => PANEL, copies: async () => [],
    scan: async () => ({ nodes: [], summary: "", note: null }), monitoring: () => ({}), nameOf: () => "x",
  }).filter(s => s.id === "network-storage")
  return [...core, ...homeSources(o), ...per]
}

// ---------------------------------------------------------------------------
//  The app
// ---------------------------------------------------------------------------

let role: Role = "admin", sid = "s1", unlocked = true, reconfirmed = false, ownerOverride: string | null = null
let homePlans: PreparedStore<HomePlan>
const ran: string[] = []
const audits: Array<{ action: string; details: Record<string, unknown> }> = []
let previewInputs: any[] = []
let metrics: SiteMetricsSource = METRICS

beforeEach(() => { ownerOverride = null; role = "admin"; sid = "s1"; unlocked = true; reconfirmed = false; ran.length = 0; audits.length = 0; previewInputs = []; metrics = METRICS })

function app() {
  const f = Fastify()
  homePlans = new PreparedStore<HomePlan>()
  f.register(buildAiRoutes({
    whoami: () => ownerOverride ?? (sid.startsWith("token:") ? sid : "admin@example.com"),
    session: () => ({ sid, role, email: "admin@example.com" }),
    activeProvider: async () => "anthropic", listProviders: async () => [], saveModel: async () => {},
    facts: async () => facts(),
    sources: () => allSources({ role, metrics }),
    clusterSources: () => allSources({ role, metrics }),
    askCall: () => never,
    intent: async () => ({ template: "none", question: false, answer: "INTENT-FALLBACK" }),
    clusters: () => [HOME], currentCluster: () => HOME_ID, inCluster: (_id, fn) => fn(),
    actionPlans: new PreparedStore<ActionPlan>(),
    prepareDeps: () => ({ inCluster: (_i, fn) => fn(), pve: () => ({ fetchStrict: async () => [] }) as any, row: () => null, connection: () => "k", unlocked: () => unlocked,
      backupStorages: async () => [], monitoringPreview: async () => ({ planId: "m", steps: [] }), copyPreview: async () => ({ previewId: "p", words: "" }), nodes: async () => [], now: () => new Date() }),
    applyDeps: () => ({ row: () => null, connection: () => "k", unlocked: () => unlocked, reconfirmed: () => reconfirmed, inCluster: (_i, fn) => fn(), pve: () => ({}) as any,
      ops: {} as any, applyMonitoring: async () => ({ ok: false, results: [], checks: [] }), startCopy: async () => ({ id: "", state: "" }), audit: async () => {} }),
    homePlans,
    homeNames: async () => ({ nas: NAS.map(n => n.name), sites: SITES.flatMap(s => [s.name, s.domain!]) }),
    homePrepareDeps: () => ({
      unlocked: () => unlocked,
      sites: async () => SITES.map(s => ({ id: s.id, name: s.name, recipeId: s.kind, domain: s.domain })),
      nas: async () => NAS.map(n => ({ id: n.id, name: n.name, disks: n.reading!.disks.map(d => ({ bay: d.bay, model: d.model })) })),
    }),
    homeApplyDeps: () => ({
      unlocked: () => unlocked, reconfirmed: () => reconfirmed,
      site: async id => { const s = SITES.find(x => x.id === id); return s ? { id: s.id, name: s.name, recipeId: s.kind, domain: s.domain } : undefined },
      pull: async id => { ran.push(`pull:${id}`); return { code: 0, output: "Fetching origin\nHEAD is now at abc123 from https://git.example.com/site.git" } },
      smart: async (nasId, bay, actor) => { ran.push(`smart:${nasId}:${bay}:${actor.role}`); return { message: `Quick SMART test started on disk ${bay} of nas1.` } },
      audit: async (action, _r, details) => { audits.push({ action, details }) },
    }),
    websiteDrafts: new WebsiteDrafts(),
    websiteDeps: () => ({
      recipe: id => ({ id, name: id === "wordpress" ? "WordPress" : "Static site", defaults: { cores: 1, memoryMb: 512, diskGb: 4, swapMb: 256 },
        sizes: { small: { cores: 1, memoryMb: 256, diskGb: 2 }, medium: { cores: id === "wordpress" ? 2 : 1, memoryMb: id === "wordpress" ? 2048 : 512, diskGb: 10 }, large: { cores: 4, memoryMb: 4096, diskGb: 30 } } }) as any,
      domains: async () => ["example.com"],
      proxies: async () => [{ id: "npm1", name: "NPM", kind: "npm", certificates: "request" }],
      place: async () => ({ node: "node2", storage: "local-lvm", bridge: "vmbr0", vmid: 160, reason: "node2 has the most memory left." }),
      preview: async (input, owner) => {
        previewInputs.push({ input, owner })
        return { errors: [], warnings: [], preview: { id: "pv-1", expiresAt: 1, checks: ["blog.example.com has no A, AAAA or CNAME record yet."], warnings: [],
          plan: { ...input, publish: input.publish ? { domain: `${input.publish.name}.${input.publish.zone}`, zone: input.publish.zone, name: input.publish.name, instanceName: "NPM", record: { type: "A", name: input.publish.name, data: "203.0.113.7", ttl: 600 } } : undefined } } }
      },
    }),
  }))
  return {
    plan: (prompt: string) => f.inject({ method: "POST", url: "/wizard/plan", payload: { prompt } }),
    apply: (body: Record<string, unknown>) => f.inject({ method: "POST", url: "/actions/apply", payload: body }),
  }
}

const text = (r: any) => r.action ? [r.action.title, r.action.words, ...r.action.steps].join("\n") : r.website ? [r.website.title, ...r.website.steps].join("\n") : String(r.message)

// ---------------------------------------------------------------------------
//  The real-scenario inventory: test/scenarios/home-features/*.yaml
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require("js-yaml") as { load(src: string): unknown }

interface HomeScenario {
  id: string; prompt: string; then?: string[]; role?: Role; token?: boolean; metrics?: "none"; found_by: string
  expect: { kind: "answer" | "action" | "website"; action?: string; role?: string; needs_reconfirm?: boolean; includes?: string[]; excludes?: string[]; choices?: string[] }
}

const DIR = join(__dirname, "scenarios", "home-features")
for (const file of readdirSync(DIR).filter(f => /\.ya?ml$/.test(f)).sort()) {
  const s = yaml.load(readFileSync(join(DIR, file), "utf8")) as HomeScenario
  test(`scenario ${s.id}`, async () => {
    const a = app()
    if (s.role) role = s.role
    if (s.token) sid = "token:t1"
    if (s.metrics === "none") metrics = NOT_COLLECTED
    let r: any
    for (const p of [s.prompt, ...(s.then ?? [])]) {
      const res = await a.plan(p)
      r = res.json()
      assert.equal(r.ok, true, res.body)
    }
    const e = s.expect
    if (e.kind === "action") {
      assert.equal(r.conversational, false, r.message)
      assert.equal(r.action.action, e.action)
      if (e.role) assert.equal(r.action.role, e.role)
      if (e.needs_reconfirm !== undefined) assert.equal(r.action.needsReconfirm, e.needs_reconfirm)
    } else if (e.kind === "website") {
      assert.ok(r.website, r.message)
      assert.equal(r.website.link, "/sites?preview=pv-1")
    } else assert.equal(r.conversational, true)
    const t = text(r)
    assert.ok(!t.includes("INTENT-FALLBACK"), `${s.id}: fell through to the intent call:\n${t}`)
    for (const w of e.includes ?? []) assert.ok(t.includes(w), `${s.id}: expected "${w}" in:\n${t}`)
    for (const w of [...(e.excludes ?? []), ...SECRETS]) assert.ok(!t.includes(w), `${s.id}: did not expect "${w}" in:\n${t}`)
    if (e.choices) assert.deepEqual(r.choices.map((c: any) => c.label), e.choices)
    assert.deepEqual(ran, [], "preparing never acts")
  })
}

// ---------------------------------------------------------------------------
//  No secrets in prompts, and what a viewer may see
// ---------------------------------------------------------------------------

async function builtPrompt(role: Role): Promise<string> {
  const sources = allSources({ role })
  const loaded = await Promise.all(sources.map(async s => ({ s, sum: await s.load() })))
  // Each source's prompt on its own too: the budget trims a long one, which would hide a leak.
  return [promptText(indexText(sources), loaded), ...loaded.map(l => promptText("", [l]).replace(/\n\(more not shown\)/, "")), ...loaded.flatMap(l => l.sum.lines)].join("\n")
}

test("no secret, address, MAC, channel URL, chat id or host name is in any built prompt, for any role", async () => {
  for (const r of ["viewer", "operator", "admin", "owner"] as Role[]) {
    const p = await builtPrompt(r)
    for (const s of SECRETS) assert.ok(!p.includes(s), `${r}: "${s}" reached the prompt`)
    assert.ok(!p.includes("NASSERIAL") && !p.includes("GOODSERIAL"), "a healthy disk's or the NAS's own serial is never read")
  }
})

test("viewer vs admin: serials, security states, notification channels and websites", async () => {
  const viewer = await builtPrompt("viewer"), admin = await builtPrompt("admin")
  assert.ok(!viewer.includes(SERIAL), "a viewer never sees a disk serial")
  assert.ok(admin.includes(SERIAL), "an admin sees the failing disk's serial, to replace it")
  assert.ok(viewer.includes("Front door state hidden for viewers") && !viewer.includes("unlocked"), "a viewer sees no security state")
  assert.ok(admin.includes("Front door unlocked") && admin.includes("House alarm armed (away)"))
  assert.ok(viewer.includes(ADMIN_ONLY_NOTIFY) && !viewer.includes("Ops (discord)"))
  assert.ok(admin.includes("Ops (discord): on; receives warning and above, backups, updates events; quiet 22:00-07:00; private"))
  assert.ok(viewer.includes(ADMIN_ONLY_SITES) && !viewer.includes("blog.example.com"))
  assert.ok(admin.includes("blog: WordPress, https://blog.example.com, CT 150 on node1"))
})

test("a channel view is cut down before the assistant reads it", () => {
  const lite = toChannelLite(CHANNEL_VIEW as any) as Record<string, unknown>
  for (const k of ["mask", "chatId", "secretReadable", "hasToken", "createdBy", "id"]) assert.equal(k in lite, false, k)
  assert.equal(JSON.stringify(lite).includes("token-sekret"), false, "the result text is not carried")
})

test("locked: the NAS and the houses say locked, never read", async () => {
  const s = homeSources({ unlocked: false })
  assert.equal((await s.find(x => x.id === "qnap")!.load()).locked, true)
  assert.equal((await s.find(x => x.id === "houses")!.load()).locked, true)
})

// ---------------------------------------------------------------------------
//  Templates: the gates
// ---------------------------------------------------------------------------

test("an API token can never apply a prepared pull or SMART test, whatever its role", async () => {
  const a = app()
  for (const prompt of ["pull docs.example.com now", "run a quick SMART test on disk 3 of nas1"]) {
    const card = (await a.plan(prompt)).json().action
    assert.ok(card?.planId, prompt)
    // Even holding the person's own plan id and owner name, a token is refused.
    sid = "token:t1"; role = "owner"; ownerOverride = "admin@example.com"
    const r = await a.apply({ planId: card.planId })
    assert.equal(r.statusCode, 403, r.body)
    assert.equal(r.json().code, "token_forbidden")
    sid = "s1"; role = "admin"; ownerOverride = null
    // The refusal used the plan up: the person asks again.
    assert.equal((await a.apply({ planId: card.planId })).statusCode, 404)
  }
  assert.deepEqual(ran, [])
  assert.ok(audits.every(x => x.details.ok === false && x.details.via === "assistant"))
})

test("a token is told plainly when it asks, and nothing is prepared", async () => {
  sid = "token:t1"
  const a = app()
  assert.equal((await a.plan("pull docs.example.com now")).json().message, TOKEN_SAY)
  assert.equal((await a.plan("create a WordPress website at blog.example.com")).json().message, WEBSITE_TOKEN)
  assert.equal(homePlans.size(), 0)
})

test("the role of the same action by hand: a viewer cannot prepare a SMART test, an operator can but cannot pull a site", async () => {
  const a = app()
  role = "viewer"
  assert.match((await a.plan("run a quick SMART test on disk 3 of nas1")).json().message, /needs the operator role/)
  role = "operator"
  const card = (await a.plan("run a quick SMART test on disk 3 of nas1")).json().action
  assert.equal(card.role, "operator")
  assert.equal(card.needsReconfirm, false)
  assert.match((await a.plan("pull docs.example.com now")).json().message, /needs the admin role/)
  const ok = await a.apply({ planId: card.planId })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(ran, ["smart:n1:3:operator"])
})

test("pull now: applied once, through the same script, audited, with no address in the answer", async () => {
  const a = app()
  const card = (await a.plan("pull docs.example.com now")).json().action
  const r = await a.apply({ planId: card.planId })
  assert.equal(r.statusCode, 200, r.body)
  assert.match(r.json().words, /^Pulled docs\.example\.com\./)
  assert.ok(!r.json().words.includes("https://git.example.com"), "a URL in the output is taken out")
  assert.deepEqual(ran, ["pull:s2"])
  assert.deepEqual(audits.map(x => [x.action, x.details.ok, x.details.via]), [["site.pull", true, "assistant"]])
  assert.equal((await a.apply({ planId: card.planId })).statusCode, 404, "a plan works once")
})

test("the ask-for-missing loop: kind, then name, then title, then email; a wrong name is asked again; cancel drops it", async () => {
  const a = app()
  let r = (await a.plan("I want a new website")).json()
  assert.match(r.message, /static site .* or WordPress/)
  assert.deepEqual(r.choices.map((c: any) => c.label), ["A static site", "WordPress"])
  r = (await a.plan("WordPress")).json()
  assert.match(r.message, /What name should it answer on\? It must be under one of your domains: example\.com/)
  r = (await a.plan("blog.other.org")).json()
  assert.match(r.message, /blog\.other\.org is not under a domain your DNS provider lists/)
  r = (await a.plan("blog.example.com")).json()
  assert.equal(r.message, "What is the site's title?")
  r = (await a.plan("Family Recipes")).json()
  assert.match(r.message, /Which email address should the WordPress admin account use/)
  // A question in the middle is answered, and the draft waits.
  const q = (await a.plan("what alerts are firing?")).json()
  assert.match(q.message, /3 alerts firing/)
  r = (await a.plan("cook@example.com")).json()
  assert.ok(r.website, JSON.stringify(r))
  const input = previewInputs[0].input
  assert.equal(previewInputs[0].owner, "admin@example.com")
  assert.deepEqual([input.recipeId, input.node, input.vmid, input.hostname, input.ip, input.bridge, input.storage], ["wordpress", "node2", 160, "blog", "dhcp", "vmbr0", "local-lvm"])
  assert.deepEqual(input.options, { WP_TITLE: "Family Recipes", WP_ADMIN_USER: "cook", WP_ADMIN_EMAIL: "cook@example.com", WP_URL: "https://blog.example.com" })
  assert.deepEqual(input.publish, { zone: "example.com", name: "blog", instanceId: "npm1" })
  assert.match(r.website.steps.join(" "), /Install there asks for your master password/)
  // Cancel
  await a.plan("make me a website")
  assert.equal((await a.plan("never mind")).json().message, "Cancelled. Nothing was planned.")
})

test("website request words: what comes here and what does not", () => {
  for (const p of ["Create a website at blog.example.com", "Make a WordPress blog", "Install WordPress at blog.example.com", "I want a new website", "Set up a static site called \"Docs\" at docs.example.com"])
    assert.equal(isWebsiteRequest(p), true, p)
  for (const p of ["Deploy a static site at docs.example.com", "deploy homepage at home.example.com", "is my website up?", "pull docs.example.com now", "how many visitors did blog.example.com get today", "Deploy Uptime Kuma at status.example.com"])
    assert.equal(isWebsiteRequest(p), false, p)
  assert.deepEqual(extractWebsite('Create a WordPress site "My Blog" at blog.example.com for me@example.com'), { kind: "wordpress", adminEmail: "me@example.com", domain: "blog.example.com", title: "My Blog" })
  assert.deepEqual(extractWebsite("a static site, LAN only"), { kind: "static-site", domain: "lan" })
  assert.equal(nextQuestion({ kind: "static-site", domain: "lan", title: "x" }, { domains: null }), null, "a static LAN site needs no email")
  assert.equal(adminUserFrom("Admin@example.com"), "site-admin")
  assert.equal(adminUserFrom("j.doe+x@example.com"), "j.doex")
})

test("by hand, said plainly: NAS restart, WordPress sign-in, Home Assistant security and devices", () => {
  const ctx = { nas: ["nas1"], sites: ["blog.example.com"] }
  assert.deepEqual(parseHomeAction("restart nas1", ctx), { kind: "by-hand", message: BY_HAND.nasPower })
  assert.deepEqual(parseHomeAction("shut down the NAS", ctx), { kind: "by-hand", message: BY_HAND.nasPower })
  assert.deepEqual(parseHomeAction("log me into wordpress admin", ctx), { kind: "by-hand", message: BY_HAND.wpLogin })
  assert.deepEqual(parseHomeAction("unlock the front door", ctx), { kind: "by-hand", message: BY_HAND.haSecurity })
  assert.deepEqual(parseHomeAction("open the garage", ctx), { kind: "by-hand", message: BY_HAND.haSecurity })
  assert.deepEqual(parseHomeAction("turn on the living room lights", ctx), { kind: "by-hand", message: BY_HAND.haDevice })
  for (const p of ["is the front door locked?", "restart plex", "turn on ct 101", "start gitea"]) assert.equal(parseHomeAction(p, ctx), null, p)
})

// ---------------------------------------------------------------------------
//  Sources, one by one
// ---------------------------------------------------------------------------

test("network storage is named by its Proxmox storage, never its server's address", async () => {
  const s = networkStorageSummary(HOME, PANEL)
  assert.deepEqual(s.lines, ["qnap-media: 2 shares on 1 volume, 75% used (5.5 TB of 7.3 TB)."])
  const unnamed = networkStorageSummary(HOME, { ...PANEL, networkStorage: [{ ...PANEL.networkStorage[0], names: [] }] } as ClusterPanel)
  assert.match(unnamed.lines[0], /^A NAS mount \(not a Proxmox storage\)/)
  assert.ok(!JSON.stringify(unnamed.lines).includes("192.0.2.10"))
})

test("plug-in visuals are read in words when a plug-in has no summary; qnap is skipped there", async () => {
  const visual = { kind: "plex", sessions: [{ title: "Show", episode: "Pilot", number: "S1 · E1", year: null, mediaType: "episode", user: "sam", player: "TV", quality: "1080p", mode: "direct play", state: "playing", progress: 42 }],
    counts: { streams: 1, transcodes: 0, direct: 1 }, bandwidth: { totalMbps: 8, lanMbps: 8, wanMbps: 0 }, topWatchers: [], topTitles: [], recent: [] } as any
  const plex = { manifest: { id: "plex", name: "Plex", description: "Plex activity." }, detail: async () => ({ tables: [], visual }) } as any
  const qnap = { manifest: { id: "qnap", name: "QNAP", description: "NAS." }, detail: async () => ({ tables: [] }) } as any
  const src = pluginSources({ plugins: [plex, qnap], unlocked: () => true, run: async () => ({ title: "", lines: [] }), detail: p => p.detail(), skip: ["qnap"] })
  assert.deepEqual(src.map(s => s.id), ["plugin:plex"])
  const sum = await src[0].load()
  assert.deepEqual(sum.lines, ["1 stream now: 0 transcoding, 1 direct; 8 Mb/s.", 'sam is watching Show S1 · E1 "Pilot" on TV: direct play, playing, 42%, 1080p.'])
  const router = visualLines({ kind: "mikrotik", router: { name: "rb", model: "RB5009", version: "7.20", uptime: "3d" }, wans: [{ name: "ether1", downBps: 8e6, upBps: 1e6 }], total: { downBps: 8e6, upBps: 1e6 },
    health: { cpuPct: 3, cpuCores: 4, memPct: 20, tempC: 40, voltage: null }, subnets: [{ net: "10.0.0.0/24", uplink: null, devices: 3, downBps: 0, upBps: 0 }],
    talkers: [{ name: null, ip: "10.0.0.5", downBps: 1, upBps: 1, source: "none" }], forwards: [], forwardsActive: 2, log: [] } as any)
  assert.ok(router.every(l => !l.includes("10.0.0")), router.join("\n"))
  assert.match(router.join(" "), /Internet now: down 8\.0 Mb\/s, up 1\.0 Mb\/s/)
})

test("site metrics: not collected says so, a fake answers per range, and a site must be named when there are several", async () => {
  const off = siteMetricsSource({ metrics: NOT_COLLECTED, sites: async () => SITES, role: "admin" })
  const s0 = await off.load()
  assert.equal(off.answer!("how many visitors did blog.example.com get today", s0), METRICS_NOT_COLLECTED)
  const on = siteMetricsSource({ metrics: METRICS, sites: async () => SITES, role: "admin" })
  const s1 = await on.load()
  assert.equal(on.answer!("how many visitors did blog.example.com get this week", s1), "blog.example.com had 900 visitors and 2500 page views this week (error rate 0.5%, p95 210 ms, uptime 99.95%).")
  assert.match(on.answer!("how many visitors today", s1)!, /^Which site\?/)
  assert.equal(on.answer!("top pages on blog.example.com this month", s1), "blog.example.com's top pages this month: / (200), /about (40).")
})

test("the six-point standard says what a site has and what is not automatic yet", () => {
  assert.deepEqual(sixPoints(SITES[0]), { has: ["a public address, proxy host and certificate", "its login in the vault"], missing: ["a backup job", "monitoring with alerts", "a place under the update policy", "a plug-in panel"] })
  assert.deepEqual(sixPoints({ ...SITES[1], domain: null, url: null }).has, ["no login to keep (a static site has none)"])
})
