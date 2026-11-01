// A prompt that plainly starts with a deploy verb needs no intent model call: the keyword match is final.
import { test } from "node:test"
import assert from "node:assert/strict"
import { matchIntent, confidentDeploy } from "../src/lib/ai/intent"
import type { ModelCall } from "../src/lib/ai/extract"

const counting = (reply: unknown) => {
  const n = { calls: 0 }
  const call: ModelCall = async () => { n.calls++; return reply as never }
  return { n, call }
}

test("confidentDeploy: a deploy verb opens a single plain request", () => {
  for (const p of ["Deploy Uptime Kuma.", "deploy kuma at example.com", "Install vaultwarden as container 250 on 10.0.0.50",
    "Set up Gitea on pve2", "please spin up Grafana, LAN only", "Deploy Uptime Kuma, make it public", "Provision a Homepage container"])
    assert.equal(confidentDeploy(p), true, p)
})

test("confidentDeploy: anything the model should judge is not confident", () => {
  for (const p of [
    "What is Uptime Kuma?", "Is Gitea running?", "remove the Grafana container", "hello",
    "Deploy Uptime Kuma, ok?",                      // a question mark: the person is asking
    "Deploy Gitea. Why is it slow?",                // a question in a later sentence
    "Deploy Gitea; then delete the old one",        // a removal in a later sentence
    "Can you deploy Uptime Kuma",                   // not opening with the verb
    "I want a Grafana container, LAN only",         // a task, but not opened by a deploy verb
    "create a backup of Gitea", "run a script on pve2", "add a user to Gitea",   // weak verbs the model must judge
    "",
  ]) assert.equal(confidentDeploy(p), false, p)
})

test("matchIntent makes no model call for a confident deploy", async () => {
  const { n, call } = counting({ template: "none", question: false, answer: "no" })
  const r = await matchIntent("Deploy Uptime Kuma, LAN only", { call })
  assert.deepEqual(r, { template: "deploy-service", question: false, answer: "" })
  assert.equal(n.calls, 0)
})

test("matchIntent still asks the model about everything else", async () => {
  const { n, call } = counting({ template: "none", question: true, answer: "It watches services." })
  const r = await matchIntent("What is Uptime Kuma?", { call })
  assert.equal(n.calls, 1)
  assert.equal(r.answer, "It watches services.")
  await matchIntent("create a backup of Gitea", { call })
  assert.equal(n.calls, 2)
})
