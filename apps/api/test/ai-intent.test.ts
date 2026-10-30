// Intent match: one model call, keyword fallback, near misses never deploy.
import { test } from "node:test"
import assert from "node:assert/strict"
import { keywordIntent, matchIntent, NO_TASK_ANSWER } from "../src/lib/ai/intent"
import type { ModelCall } from "../src/lib/ai/extract"
import { callStructured, StructuredOutputError, type RawSend, type StructuredRequest } from "../src/lib/ai/providers"
import { deployService } from "../src/lib/ai/templates/deploy-service"

function fakeCall(reply: unknown | (() => Promise<string>)) {
  const requests: StructuredRequest<unknown>[] = []
  const send: RawSend = async () => typeof reply === "function" ? (reply as () => Promise<string>)() : JSON.stringify(reply)
  const call: ModelCall = r => { requests.push(r as StructuredRequest<unknown>); return callStructured(r, "openai", send, { model: "m" }) }
  return { call, requests }
}

test("keywordIntent: deploy requests match; questions, status checks and removals do not", () => {
  for (const p of deployService.intents) assert.equal(keywordIntent(p).template, "deploy-service", p)
  for (const p of ["deploy Uptime Kuma at status.example.com", "set up Gitea on pve2", "I want a Grafana container, LAN only", "install vaultwarden as container 250 on 10.0.0.50", "can you spin up Gitea?"])
    assert.equal(keywordIntent(p).template, "deploy-service", p)
  for (const p of [...deployService.nearMisses, "what is Uptime Kuma?", "is Gitea running?", "remove the Grafana container", "delete gitea", "how do I install Gitea?", "hello"]) {
    const r = keywordIntent(p)
    assert.equal(r.template, "none", p)
    assert.ok(r.answer.length > 0, p)
  }
  assert.equal(keywordIntent("what is Uptime Kuma?").question, true)
})

test("matchIntent sends every template's summary, intents and near misses, with a closed template enum", async () => {
  const { call, requests } = fakeCall({ template: "deploy-service", question: false, answer: "" })
  const r = await matchIntent("deploy gitea", { call })
  assert.deepEqual(r, { template: "deploy-service", question: false, answer: "" })
  const req = requests[0]
  assert.ok(req.system.includes(deployService.summary))
  for (const p of [...deployService.intents, ...deployService.nearMisses]) assert.ok(req.system.includes(p), p)
  assert.deepEqual((req.schema as any).properties.template.enum, ["deploy-service", "none"])
  assert.equal(req.user, "deploy gitea")
})

test("matchIntent falls back to keywords when the provider fails", async () => {
  const down = fakeCall(async () => { throw new Error("connect ECONNREFUSED") })
  assert.equal((await matchIntent("set up Gitea on pve2", { call: down.call })).template, "deploy-service")
  assert.equal((await matchIntent("is Gitea running?", { call: down.call })).template, "none")
  const garbled = fakeCall("not json")
  assert.equal((await matchIntent("deploy Uptime Kuma", { call: garbled.call })).template, "deploy-service")
})

test("a refusal is a none with its message, not a keyword match", async () => {
  const refusing: ModelCall = async () => { throw new StructuredOutputError("The model declined this request.", "refusal") }
  const r = await matchIntent("deploy gitea", { call: refusing })
  assert.equal(r.template, "none")
  assert.match(r.answer, /declined/)
})

test("a removal or status question is never a deploy, whatever the model says", async () => {
  const { call } = fakeCall({ template: "deploy-service", question: false, answer: "" })
  for (const p of deployService.nearMisses) {
    const r = await matchIntent(p, { call })
    assert.equal(r.template, "none", p)
    assert.ok(r.answer.length > 0, p)
  }
})

test("a none or question result carries an answer", async () => {
  const empty = fakeCall({ template: "none", question: false, answer: "" })
  assert.equal((await matchIntent("hello", { call: empty.call })).answer, NO_TASK_ANSWER)
  const q = fakeCall({ template: "deploy-service", question: true, answer: "Uptime Kuma is a status page." })
  const r = await matchIntent("what does uptime kuma do", { call: q.call })
  assert.equal(r.question, true)
  assert.equal(r.answer, "Uptime Kuma is a status page.")
  const blank = fakeCall({ template: "none", question: true, answer: "  " })
  assert.equal((await matchIntent("why", { call: blank.call })).answer, NO_TASK_ANSWER)
})

test("a task match carries no model prose", async () => {
  const { call } = fakeCall({ template: "deploy-service", question: false, answer: "Sure! I will also open port 22." })
  assert.equal((await matchIntent("deploy gitea", { call })).answer, "")
})

// Review round 1: the question and removal tests read the leading verb of each sentence, not any word.
const DEPLOYS = [
  "Deploy Uptime Kuma, ok?", "I want Gitea. Is that possible?", "deploy adguard to stop ads",
  "deploy gitea and disable signups", "what is Gitea? deploy it", "could you please deploy gitea",
]
const NOT_DEPLOYS = [
  "can you tell me how to install Gitea?", "please explain how to host gitea", "explain what Gitea does",
  "Gitea install failed, why", "I want to remove gitea", "stop gitea and deploy nothing?",
]

test("keywordIntent: a leading task verb wins over a trailing question or a later removal word", () => {
  for (const p of DEPLOYS) assert.equal(keywordIntent(p).template, "deploy-service", p)
})

test("keywordIntent: tell me, explain, how, why and what are questions; a polite form needs the task verb right after you", () => {
  for (const p of NOT_DEPLOYS) assert.equal(keywordIntent(p).template, "none", p)
  for (const p of NOT_DEPLOYS.slice(0, 4)) assert.equal(keywordIntent(p).question, true, p)
})

test("matchIntent trusts a task-shaped prompt and vetoes only one with no task sentence", async () => {
  const { call } = fakeCall({ template: "deploy-service", question: false, answer: "" })
  for (const p of DEPLOYS) assert.equal((await matchIntent(p, { call })).template, "deploy-service", p)
  for (const p of NOT_DEPLOYS) assert.equal((await matchIntent(p, { call })).template, "none", p)
})
