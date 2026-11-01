// The model picked on the AI page is the one the plan uses, and the provider status says when it is not installed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import Fastify from "fastify"
import { buildAiRoutes } from "../src/routes/ai"
import { PreparedStore } from "../src/lib/ai/prepared"
import { modelInstalled, ollamaTags, ollamaProviderState } from "../src/lib/ai/providers"
import type { TemplateFacts } from "../src/lib/ai/templates/types"

const fixture = (): TemplateFacts =>
  JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))

function harness(active: "ollama" | "anthropic" = "ollama") {
  const seen = { intent: [] as Array<[string | undefined, string | undefined]>, extract: [] as Array<string | undefined>, saved: [] as string[] }
  const app = Fastify()
  app.register(buildAiRoutes({
    facts: async () => fixture(),
    settings: async () => ({ bridge: "vmbr0" }),
    intent: async (_p: string, provider?: string, model?: string) => { seen.intent.push([provider, model]); return { template: "deploy-service", question: false, answer: "" } },
    extract: async (_t: unknown, _x: string, _f: unknown, opts?: { model?: string }) => { seen.extract.push(opts?.model); return { values: { service: "uptime-kuma", exposure: "lan" }, dropped: [], invalid: [] } },
    saveModel: async (m: string) => { seen.saved.push(m) },
    prepared: new PreparedStore(),
    whoami: () => "admin@example.com",
    activeProvider: async () => active,
    listProviders: async () => [],
  }))
  const plan = (body: unknown) => app.inject({ method: "POST", url: "/wizard/plan", payload: body as any })
  return { seen, plan }
}

test("the model sent with a plan request reaches the intent call, the extract call and the stored setting", async () => {
  const h = harness()
  const r = await h.plan({ prompt: "deploy uptime kuma", provider: "ollama", model: "qwen3:4b" })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(h.seen.intent, [["ollama", "qwen3:4b"]])
  assert.deepEqual(h.seen.extract, ["qwen3:4b"])
  assert.deepEqual(h.seen.saved, ["qwen3:4b"])
})

test("a model is ignored for a cloud provider and never stored", async () => {
  const h = harness("anthropic")
  await h.plan({ prompt: "deploy uptime kuma", provider: "anthropic", model: "qwen3:4b" })
  assert.deepEqual(h.seen.intent, [["anthropic", undefined]])
  assert.deepEqual(h.seen.extract, [undefined])
  assert.deepEqual(h.seen.saved, [])
})

test("a request without a model uses the stored one", async () => {
  const h = harness()
  await h.plan({ prompt: "deploy uptime kuma", provider: "ollama" })
  assert.deepEqual(h.seen.extract, [undefined])
  assert.deepEqual(h.seen.saved, [])
})

test("modelInstalled: an exact name, or a bare name for its latest tag", () => {
  assert.equal(modelInstalled("qwen3:4b", ["qwen3:4b", "phi4:latest"]), true)
  assert.equal(modelInstalled("llama3.2:3b", ["qwen3:4b"]), false)
  assert.equal(modelInstalled("phi4", ["phi4:latest"]), true)
  assert.equal(modelInstalled("qwen3", ["qwen3:4b"]), false, "a bare name is the latest tag, not any tag")
})

test("ollamaTags lists the installed names, and says so when the server does not answer", async () => {
  const ok = async () => new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }, { name: "phi4:latest" }] }))
  assert.deepEqual(await ollamaTags("http://x:11434/", ok as any), { up: true, models: ["qwen3:4b", "phi4:latest"] })
  const down = async () => { throw new TypeError("fetch failed") }
  assert.deepEqual(await ollamaTags("http://x:11434", down as any), { up: false, models: [] })
  const bad = async () => new Response("no", { status: 500 })
  assert.equal((await ollamaTags("http://x:11434", bad as any)).up, false)
})

test("provider status: a stored model that is not installed is not 'configured'", () => {
  const s = ollamaProviderState("http://x:11434", "llama3.2:3b", { up: true, models: ["qwen3:4b"] })
  assert.equal(s.configured, false)
  assert.match(s.missing.join(" "), /llama3\.2:3b is not installed/)
  assert.match(s.missing.join(" "), /Models/)
  const good = ollamaProviderState("http://x:11434", "qwen3:4b", { up: true, models: ["qwen3:4b"] })
  assert.deepEqual([good.configured, good.missing], [true, []])
  const down = ollamaProviderState("http://x:11434", "qwen3:4b", { up: false, models: [] })
  assert.equal(down.configured, false)
  assert.match(down.missing[0], /does not answer/)
  assert.equal(ollamaProviderState("", "qwen3:4b", { up: false, models: [] }).missing[0], "server address")
})

import { pickOllamaModel } from "../../frontend/lib/ollama-model"

test("the AI page sends the model it shows: the stored one if installed, else the first installed", () => {
  assert.equal(pickOllamaModel("llama3.2:3b", ["qwen3:4b", "phi4:latest"]), "qwen3:4b", "the 404 case: default never downloaded")
  assert.equal(pickOllamaModel("phi4:latest", ["qwen3:4b", "phi4:latest"]), "phi4:latest")
  assert.equal(pickOllamaModel("phi4", ["qwen3:4b", "phi4:latest"]), "phi4")
  assert.equal(pickOllamaModel("", ["qwen3:4b"]), "qwen3:4b")
  assert.equal(pickOllamaModel("llama3.2:3b", []), "llama3.2:3b", "nothing installed: nothing to pick")
})
