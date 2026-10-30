// The scenario runner itself: matchers, answer checking, recording replay.
import { test } from "node:test"
import assert from "node:assert/strict"
import { matchField, runPlanOnly, checkScenario, type Scenario, type Recording } from "./scenarios/runner"

const base: Scenario = {
  id: "t-1", prompt: "Deploy Uptime Kuma", facts: "fixtures/three-node-cluster.json", answers: [],
  expect: { state: "asking", questions: ["exposure"] }, found_by: "test",
}
const task = { template: "deploy-service", question: false, answer: "" }
const rec = (extractions: Array<Record<string, unknown>>): Recording => ({ intent: task, extractions })

test("matchField: literals, bounds and source assertions", () => {
  assert.equal(matchField(">=8", { value: 8, source: "derived" }), null)
  assert.equal(matchField(">=8", { value: 4, source: "derived" }), "4 is not >= 8")
  assert.equal(matchField("<=8", { value: 8, source: "user" }), null)
  assert.notEqual(matchField("<=8", { value: 9, source: "user" }), null)
  assert.equal(matchField(237, { value: 237, source: "user" }), null)
  assert.notEqual(matchField(237, { value: "237", source: "user" }), null)
  assert.equal(matchField("{fact}", { value: "10.0.0.1", source: "fact" }), null)
  assert.match(matchField("{fact}", { value: "10.0.0.1", source: "derived" })!, /fact.*derived/)
  assert.equal(matchField("{derived}", { value: 102, source: "derived" }), null)
  assert.notEqual(matchField("{derived}", { value: 102, source: "user" }), null)
  assert.equal(matchField(null, undefined), null)
  assert.notEqual(matchField(null, { value: "x", source: "user" }), null)
  assert.match(matchField("x", undefined)!, /missing/)
})

test("a recorded run asks the first question and stops", async () => {
  const r = await runPlanOnly(base, rec([{ service: "uptime-kuma" }]))
  assert.equal(r.state.state, "asking")
  assert.deepEqual(r.questions, ["exposure"])
  assert.deepEqual(checkScenario(base, r), [])
})

test("an answer for a different field than the one asked fails", async () => {
  const s: Scenario = { ...base, answers: [{ field: "domain", value: "kuma.example.com" }] }
  await assert.rejects(runPlanOnly(s, rec([{ service: "uptime-kuma" }])), /asked exposure, answered domain/)
})

test("a recording with calls left over fails; one with too few fails", async () => {
  await assert.rejects(runPlanOnly(base, rec([{ service: "uptime-kuma" }, { exposure: "lan" }])), /1 recorded extraction.*unused/)
  const s: Scenario = { ...base, answers: [{ text: "lan" }] }
  await assert.rejects(runPlanOnly(s, rec([{ service: "uptime-kuma" }])), /recording has no extraction/)
})

test("keys the model returns that are not fields are reported as dropped", async () => {
  const s: Scenario = { ...base, expect: { state: "asking", questions: ["exposure"], dropped: ["gateway", "steps"] } }
  const r = await runPlanOnly(s, rec([{ service: "uptime-kuma", gateway: "10.9.9.9", steps: [] }]))
  assert.deepEqual(r.dropped, ["gateway", "steps"])
  assert.deepEqual(checkScenario(s, r), [])
})

test("checkScenario reports each mismatch", async () => {
  const r = await runPlanOnly(base, rec([{ service: "uptime-kuma" }]))
  const bad: Scenario = { ...base, expect: { state: "ready", questions: ["vmid"], fields: { service: "gitea" } } }
  const fails = checkScenario(bad, r)
  assert.equal(fails.length, 3)
})

test("an unsupported expectation is a failure, not silently ignored", async () => {
  const r = await runPlanOnly(base, rec([{ service: "uptime-kuma" }]))
  assert.match(checkScenario({ ...base, expect: { ...base.expect, preflight: "all-pass" } }, r).join("\n"), /preflight/)
})
