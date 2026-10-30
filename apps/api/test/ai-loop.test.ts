// The question loop: pure functions over fake intent/extract.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  startLoop, answerLoop, editFields, settle, FieldLockedError, MAX_QUESTIONS,
  type LoopDeps, type Extraction, type IntentResult,
} from "../src/lib/ai/loop"
import type { TemplateFacts } from "../src/lib/ai/templates/types"

const facts = (): TemplateFacts =>
  JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))
const task: IntentResult = { template: "deploy-service", question: false, answer: "" }
const ext = (values: Record<string, unknown> = {}, invalid: Extraction["invalid"] = []): Extraction => ({ values, dropped: [], invalid })

function deps(extractions: Extraction[], intent: IntentResult = task) {
  const calls = { extract: 0, intent: 0 }
  const d: LoopDeps = {
    facts: facts(), settings: { bridge: "vmbr0" },
    intent: async () => { calls.intent++; return intent },
    extract: async () => extractions[Math.min(calls.extract++, extractions.length - 1)] ?? ext(),
    now: () => new Date("2026-01-01T00:00:00Z"),
  }
  return { d, calls }
}

test("one question at a time, in field order", async () => {
  const { d } = deps([ext({ service: "uptime-kuma" })])
  const s = await startLoop("deploy uptime kuma", d)
  assert.equal(s.state, "asking")
  assert.equal(s.pending!.field, "exposure")
  assert.deepEqual(s.pending!.choices, ["public", "lan"])
  assert.equal(s.asked, 1)
  assert.equal(s.transcript.length, 2)
  assert.equal(s.transcript[1].text, s.pending!.question)
})

test("a button answer is coerced and merged without a model call", async () => {
  const { d, calls } = deps([ext({ service: "uptime-kuma" })])
  let s = await startLoop("deploy uptime kuma", d)
  assert.equal(calls.extract, 1)
  s = await answerLoop(s, { field: "exposure", value: "lan" }, d)
  assert.equal(calls.extract, 1, "no model call for a button")
  assert.equal(s.fields.exposure.value, "lan")
  assert.equal(s.fields.exposure.source, "user")
  assert.equal(s.state, "ready")
  assert.ok(s.steps!.length > 0)
  assert.equal(s.pending, undefined)
  s = await startLoop("x", deps([ext({ service: "gitea", exposure: "lan" })]).d)
  const t = await answerLoop({ ...s, state: "asking" }, { field: "vmid", value: "238" }, d)
  assert.equal(t.fields.vmid.value, 238, "numeric string coerced")
})

test("a later answer wins for the fields it names; null keeps the earlier value", async () => {
  const { d } = deps([ext({ service: "gitea", exposure: "lan", memory_mb: 1024 }), ext({ memory_mb: 2048, exposure: null })])
  let s = await startLoop("deploy gitea lan 1024mb", d)
  s = { ...s, state: "asking" }
  s = await answerLoop(s, { text: "make it 2048" }, d)
  assert.equal(s.fields.memory_mb.value, 2048)
  assert.equal(s.fields.exposure.value, "lan")
})

test("an invalid user value is asked again, not replaced", async () => {
  const { d } = deps([ext({ service: "gitea", exposure: "lan", vmid: 101 })])
  const s = await startLoop("deploy gitea as 101", d)
  assert.equal(s.state, "asking")
  assert.equal(s.pending!.field, "vmid")
  assert.equal(s.fields.vmid.value, 101, "the user's value is still there")
  assert.match(s.pending!.question, /taken by another guest/)
})

test("after 8 questions the session is blocked and lists what is missing", async () => {
  const { d } = deps([ext({ service: "uptime-kuma" })])
  let s = await startLoop("deploy uptime kuma", d)
  for (let i = 0; i < 20 && s.state === "asking"; i++) s = await answerLoop(s, { text: "dunno" }, d)
  assert.equal(s.state, "blocked")
  assert.equal(s.asked, MAX_QUESTIONS)
  const last = s.transcript[s.transcript.length - 1]
  assert.equal(last.role, "assistant")
  assert.match(last.text, /reachable from the internet/)
  assert.equal(s.pending, undefined)
})

test("a non-task prompt is an answer with no fields", async () => {
  const { d, calls } = deps([], { template: "none", question: false, answer: "I can deploy services." })
  const s = await startLoop("what time is it", d)
  assert.equal(s.state, "answer"); assert.equal(s.answer, "I can deploy services."); assert.deepEqual(s.fields, {})
  assert.equal(calls.extract, 0)
  const q = await startLoop("what is kuma?", deps([], { template: "deploy-service", question: true, answer: "A monitor." }).d)
  assert.equal(q.state, "answer")
})

test("fact and fixed fields cannot be edited", async () => {
  const { d } = deps([ext({ service: "gitea", exposure: "lan" })])
  const s = await startLoop("deploy gitea", d)
  assert.equal(s.state, "ready")
  assert.throws(() => editFields(s, { gateway: "10.0.0.9" }, d), FieldLockedError)
  assert.throws(() => editFields(s, { features: "keyctl=1" }, d), FieldLockedError)
  assert.throws(() => editFields(s, { nope: 1 }, d), FieldLockedError)
  const e = editFields(s, { memory_mb: 2048 }, d)
  assert.equal(e.fields.memory_mb.value, 2048); assert.equal(e.state, "ready")
})

test("settle does not mutate its input", async () => {
  const { d } = deps([ext({ service: "gitea" })])
  const s = await startLoop("deploy gitea", d)
  const before = JSON.stringify(s)
  settle(s, d)
  assert.equal(JSON.stringify(s), before)
})

test("a domain with exposure lan asks once; answering lan clears the domain instead of looping", async () => {
  const { d } = deps([ext({ service: "gitea", exposure: "lan", domain: "git.example.com" }), ext({ exposure: "lan" })])
  let s = await startLoop("deploy gitea lan at git.example.com", d)
  assert.equal(s.state, "asking"); assert.equal(s.pending!.field, "exposure")
  assert.deepEqual(s.pending!.choices, ["public", "lan"])
  const viaButton = await answerLoop(s, { field: "exposure", value: "lan" }, d)
  assert.equal(viaButton.state, "ready"); assert.equal(viaButton.fields.domain, undefined)
  const viaText = await answerLoop(s, { text: "lan" }, d)
  assert.equal(viaText.state, "ready"); assert.equal(viaText.fields.domain, undefined)
  const viaEdit = editFields(s, { exposure: "lan" }, d)
  assert.equal(viaEdit.state, "ready")
  const pub = await answerLoop(s, { field: "exposure", value: "public" }, d)
  assert.equal(pub.fields.domain.value, "git.example.com", "public keeps the hostname")
})
