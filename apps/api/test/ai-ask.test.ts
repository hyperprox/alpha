import { test } from "node:test"
import assert from "node:assert/strict"
import { answerQuestion, selectSources, promptText, indexText, lineAnswer, LOCKED_NOTE, type AskSource } from "../src/lib/ai/ask"
import {
  clusterAnswer, clusterSummary, gatherClusterSummary, backupSummary, gatherBackups, certSummary, certAnswer,
  coreSources, pluginSources, type ClusterSummary, type CertLite,
} from "../src/lib/ai/ask-sources"
import { homeAssistantPlugin } from "../src/plugins/home-assistant"
import { isQuestionPrompt } from "../src/lib/ai/intent"
import { startLoop } from "../src/lib/ai/loop"
import { ModelCallError } from "../src/lib/ai/providers"
import type { ModelCall } from "../src/lib/ai/extract"
import type { Plugin } from "../src/lib/plugin-host"

const cluster = (over: Partial<ClusterSummary> = {}): ClusterSummary => ({
  nodes: [{ node: "a", online: true, cores: 8, memUsedMb: 4096, memTotalMb: 16384 }, { node: "b", online: false, cores: 4, memUsedMb: 0, memTotalMb: 16384 }],
  guests: [
    { vmid: 1, node: "a", type: "lxc", name: "web", running: true }, { vmid: 2, node: "a", type: "lxc", name: "db", running: false },
    { vmid: 3, node: "a", type: "qemu", name: "win", running: true },
  ],
  storages: [{ storage: "ceph", node: "a", shared: true, usedPct: 5, totalGb: 100 }, { storage: "ceph", node: "b", shared: true, usedPct: 5, totalGb: 100 }],
  ceph: "HEALTH_OK", ha: { total: 2, problems: ["ct:9"] }, version: "9.9.9", partial: [], ...over,
})

const never: ModelCall = async () => { throw new Error("the model must not be called") }

test("cluster: counts, running vs stopped, memory, storage are exact", () => {
  const s = cluster()
  assert.match(clusterAnswer("How many containers do I have?", s)!, /2 containers, 1 running and 1 stopped/)
  assert.match(clusterAnswer("how many VMs", s)!, /1 VM, 1 running and 0 stopped/)
  assert.match(clusterAnswer("How many guests are there?", s)!, /3 guests: 2 containers and 1 VM\. 2 are running and 1 stopped/)
  assert.match(clusterAnswer("how many are running", s) ?? "x", /x|guests/)
  assert.match(clusterAnswer("How much free memory do I have?", s)!, /12\.0 GB of 16\.0 GB .* 1 online node/)
  assert.match(clusterAnswer("how full is my storage?", s)!, /^Storage used: ceph 5%\.$/)   // a shared storage once
  assert.equal(clusterAnswer("what is a container?", s), null)
})

test("cluster: an unread resource list is said, not counted", () => {
  const a = clusterAnswer("how many containers?", cluster({ guests: [], nodes: [], partial: ["resources"] }))!
  assert.match(a, /could not read/)
})

test("cluster summary: headline, HA, version, no names beyond stopped guests", () => {
  const sum = clusterSummary(cluster())
  assert.match(sum.headline, /1\/2 nodes online, 2\/3 guests running, Ceph HEALTH_OK/)
  const text = sum.lines.join("\n")
  assert.match(text, /HyperProx 9\.9\.9/); assert.match(text, /in trouble: ct:9/); assert.match(text, /Stopped: db \(2\)/)
})

test("gatherClusterSummary reads one resources call and tolerates missing Ceph/HA", async () => {
  const fetchStrict = async (p: string) => {
    if (p === "/cluster/resources") return [{ type: "node", node: "a", status: "online", maxcpu: 4, mem: 1, maxmem: 2 ** 30 },
      { type: "lxc", vmid: 5, node: "a", name: "x", status: "running" }, { type: "lxc", vmid: 6, node: "a", template: 1, status: "stopped" },
      { type: "storage", storage: "s", node: "a", disk: 1, maxdisk: 4 }]
    throw new Error("no ceph")
  }
  const s = await gatherClusterSummary(fetchStrict as never)
  assert.equal(s.guests.length, 1); assert.equal(s.ceph, null); assert.equal(s.ha, null); assert.equal(s.storages[0].usedPct, 25)
  const bad = await gatherClusterSummary((async () => { throw new Error("x") }) as never)
  assert.deepEqual(bad.partial, ["resources"])
})

test("backups: the latest run's result, and none in three days", async () => {
  const now = 1_000_000
  const tasks = [
    { type: "vzdump", id: "1", node: "a", status: "OK", endtime: now - 3600 },
    { type: "vzdump", id: "2", node: "a", status: "job errors", endtime: now - 3700 },
    { type: "vzdump", id: "3", node: "a", status: "OK", endtime: now - 100 * 3600 },   // older than the window
    { type: "qmstart", id: "9", node: "a", status: "OK", endtime: now - 10 },
  ]
  const runs = await gatherBackups((async () => tasks) as never, now * 1000)
  assert.equal(runs.length, 2)
  const sum = backupSummary(runs)
  assert.match(sum.lines[0], /1 ok, 1 failed/); assert.match(sum.lines[1], /Failed guests: 2/)
  assert.match(backupSummary([]).lines[0], /No backup job finished/)
})

test("certificates: expiring within 30 days, none, and counts", () => {
  const c = (n: string, d: number | null): CertLite => ({ names: [n], daysLeft: d, notAfter: "2026-01-01T00:00:00Z", verdict: "ok", source: "npm" })
  const sum = certSummary([c("a.test", 5), c("b.test", 90), c("c.test", null)])
  assert.match(certAnswer("which certs expire soon", sum)!, /1 certificate expires within 30 days: a\.test in 5 days/)
  assert.match(certAnswer("when do certs expire", certSummary([c("b.test", 90)]))!, /No certificate expires within the next 30 days/)
  assert.equal(certAnswer("how many certificates", sum), null)
  assert.match(sum.headline, /3, 1 expiring/)
})

test("dns and proxy sources read the facts and name what was partial", async () => {
  const facts: any = { zones: ["a.test"], records: { "a.test": ["@", "www"] }, proxyHosts: ["x.a.test", "y.a.test"], hasReverseProxy: true, partial: ["records:a.test", "proxy"] }
  const src = coreSources({ fetchStrict: (async () => []) as never, facts, certs: async () => [], unlocked: () => true })
  const dns = await src.find(s => s.id === "dns")!.load()
  assert.match(dns.lines[0], /a\.test: 2 records/); assert.deepEqual(dns.unread, ["the records of a.test"])
  const proxy = src.find(s => s.id === "proxy")!
  const p = await proxy.load()
  assert.match(p.headline, /2 hosts/); assert.deepEqual(p.unread, ["the proxy host list"])
  assert.equal(proxy.answer!("how many proxy hosts do I have", p), null)     // unread: never an exact count
})

test("certificates are locked, not failed, while the vault is locked", async () => {
  const facts: any = { zones: [], records: {}, proxyHosts: [], hasReverseProxy: false, partial: [] }
  const src = coreSources({ fetchStrict: (async () => []) as never, facts, certs: async () => { throw new Error("must not read") }, unlocked: () => false })
  const a = await answerQuestion("which certificates expire soon", { sources: src, call: never, fallback: "x" })
  assert.match(a, /locked/i)
})

// ---- plug-ins -------------------------------------------------------------

const states = [
  { entity_id: "light.outside", state: "on", attributes: { friendly_name: "Outside light" } },
  { entity_id: "light.hall", state: "off", attributes: { friendly_name: "Hall light" } },
  { entity_id: "switch.vault_code", state: "on", attributes: { friendly_name: "Alarm code switch" } },
  { entity_id: "sensor.t", state: "20", attributes: { friendly_name: "Temp", device_class: "temperature" } },
]

test("Home Assistant summary: names and states only, nothing credential-like", async () => {
  const r = await homeAssistantPlugin.summary!({ get: async () => states } as never)
  const text = r.lines.join("\n")
  assert.match(text, /Outside light: on/); assert.match(text, /1 lights on/)
  assert.doesNotMatch(text, /code/i); assert.doesNotMatch(text, /Temp/)
})

const ha = (unlocked = true, run?: () => Promise<{ title: string; lines: string[] }>) => pluginSources({
  plugins: [homeAssistantPlugin, { manifest: { id: "bare", name: "Bare Thing", description: "No summary" } } as unknown as Plugin],
  unlocked: () => unlocked,
  run: run ?? (p => p.summary!({ get: async () => states } as never)),
})

test("plug-in source: 'Is the outside light on?' is answered from its lines with no model call", async () => {
  assert.equal(await answerQuestion("Is the outside light on?", { sources: ha(), call: never, fallback: "x" }), "Outside light: on")
  assert.equal(await answerQuestion("is the hall light on", { sources: ha(), call: never, fallback: "x" }), "Hall light: off")
})

test("plug-in source: locked while the vault is locked; one without a hook says so", async () => {
  assert.match(await answerQuestion("is the outside light on?", { sources: ha(false), call: never, fallback: "x" }), /locked/i)
  const bare = ha().find(s => s.id === "plugin:bare")!
  assert.match((await bare.load()).unread![0], /no summary/)
})

test("a plug-in that throws is unread, and the question is not answered from nothing", async () => {
  const a = await answerQuestion("is the outside light on?", { sources: ha(true, async () => { throw new Error("connect refused") }), call: never, fallback: "x" })
  assert.match(a, /could not read Home Assistant/)
})

// ---- selection and the prompt ---------------------------------------------

const fake = (id: string, aliases: RegExp, lines: string[]): AskSource => ({ id, title: id, blurb: `the ${id}`, aliases, load: async () => ({ headline: `${id}: fine.`, lines }) })

test("selection picks at most three sources, best match first, and none when nothing matches", () => {
  const all = [fake("a", /alpha/, []), fake("b", /beta/, []), fake("c", /gamma/, []), fake("d", /delta/, [])]
  assert.deepEqual(selectSources("alpha beta gamma delta", all).length, 3)
  assert.deepEqual(selectSources("beta beta alpha", all).map(s => s.id), ["b", "a"])
  assert.deepEqual(selectSources("what is the weather", all), [])
})

test("the model sees the index and only the selected sources, within about 500 tokens", async () => {
  const big = Array.from({ length: 200 }, (_, i) => `line ${i} of the alpha source`)
  const sources = [fake("alpha", /alpha/, big), fake("beta", /beta/, ["BETA SECRET LINE"])]
  let seen = ""
  const call: ModelCall = async r => { seen = (r as any).user; return { answer: "ok" } as never }
  assert.equal(await answerQuestion("tell me about alpha", { sources, call, fallback: "x" }), "ok")
  assert.match(seen, /Attached: alpha \(the alpha\); beta \(the beta\)/)
  assert.doesNotMatch(seen, /BETA SECRET/)
  assert.ok(seen.length < 2600, `prompt is ${seen.length} characters`)
})

test("an unanswerable question goes to the model with the index only, told to answer from the summary", async () => {
  let req: any
  const call: ModelCall = async r => { req = r; return { answer: "I do not have that." } as never }
  const out = await answerQuestion("what is the weather", { sources: [fake("alpha", /alpha/, ["x"])], call, fallback: "x" })
  assert.equal(out, "I do not have that.")
  assert.match(req.system, /Answer only from the SUMMARY/); assert.match(req.system, /plainly that you do not have/)
  assert.match(req.system, /cannot change anything/); assert.match(req.system, /2 or 3 short sentences/)
  assert.doesNotMatch(req.user, /x\n/)
})

test("an overview lists the index and each source's headline, with locked and unread said", async () => {
  const bad: AskSource = { ...fake("bad", /bad/, []), load: async () => { throw new Error("down") } }
  const locked: AskSource = { ...fake("vault", /vault/, []), load: async () => ({ headline: "x", lines: [], locked: true }) }
  const out = await answerQuestion("What can you see?", { sources: [fake("alpha", /alpha/, []), bad, locked], call: never, fallback: "x" })
  assert.match(out, /^Attached: alpha \(the alpha\); bad \(the bad\); vault/); assert.match(out, /alpha: fine\./)
  assert.match(out, /vault: locked\./); assert.match(out, /could not read bad/)
})

test("no provider: the typed reason, then the canned text; a refusal is shown as is", async () => {
  const src = [fake("alpha", /alpha/, ["x"])]
  const down: ModelCall = async () => { throw new ModelCallError("Ollama is not reachable at http://x.", "unreachable") }
  assert.equal(await answerQuestion("alpha?", { sources: src, call: down, fallback: "CANNED" }), "Ollama is not reachable at http://x. CANNED")
  const generic: ModelCall = async () => { throw new Error("no provider configured") }
  assert.match(await answerQuestion("alpha?", { sources: src, call: generic, fallback: "CANNED" }), /^The AI provider failed: no provider configured\. CANNED$/)
})

test("lineAnswer needs every content word, and stays quiet on many matches", () => {
  assert.equal(lineAnswer("is the garage door open", ["Garage door: closed", "Front door: closed"]), "Garage door: closed")
  assert.equal(lineAnswer("is a light on", ["A light: on", "B light: off", "C light: on", "D light: on"]), null)
  assert.equal(lineAnswer("is it on", ["x: on"]), null)
})

test("promptText: index and unread notes always survive trimming", () => {
  const long = fake("alpha", /a/, Array.from({ length: 300 }, (_, i) => `row ${i}`))
  const t = promptText(indexText([long]), [{ s: long, sum: { headline: "", lines: Array.from({ length: 300 }, (_, i) => `row ${i}`), unread: ["the thing"] } }])
  assert.match(t, /^Attached:/); assert.match(t, /more not shown/); assert.match(t, /Could not read: the thing/)
})

// ---- the loop --------------------------------------------------------------

test("isQuestionPrompt: questions only; tasks and removals are not", () => {
  for (const p of ["How many containers do I have?", "How much free memory?", "what is the weather today", "Is the outside light on?", "Did last night's backup work?"])
    assert.equal(isQuestionPrompt(p), true, p)
  for (const p of ["Deploy Uptime Kuma", "remove the Grafana container", "what is Gitea? deploy it", "hello"]) assert.equal(isQuestionPrompt(p), false, p)
})

test("startLoop answers a question from ask with no intent call, and falls through on null", async () => {
  const deps: any = {
    facts: {}, settings: {}, now: () => new Date(0), extract: async () => { throw new Error("no") },
    intent: async () => { throw new Error("the intent call must not be made") },
    ask: async () => "You have 3 containers.",
  }
  const s = await startLoop("How many containers do I have?", deps)
  assert.equal(s.state, "answer"); assert.equal(s.answer, "You have 3 containers.")
  let intent = 0
  const s2 = await startLoop("How many containers do I have?", { ...deps, ask: async () => null, intent: async () => { intent++; return { template: "none", question: true, answer: "old" } } })
  assert.equal(s2.answer, "old"); assert.equal(intent, 1)
  intent = 0
  await startLoop("Deploy Uptime Kuma", { ...deps, ask: async () => { throw new Error("never asked for a task") }, intent: async () => { intent++; return { template: "none", question: false, answer: "" } } })
  assert.equal(intent, 1)
})

test("locked note is plain", () => assert.match(LOCKED_NOTE, /locked/))
