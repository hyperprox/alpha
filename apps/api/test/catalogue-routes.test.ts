// Catalogue install jobs: owned like wizard jobs (ownerOf), read only by their owner, with unguessable ids.
import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { buildCatalogueRoutes } from "../src/routes/catalogue"
import { getInstallJob } from "../src/lib/catalogue-installer"
import { requestContext } from "../src/lib/auth"
import { FakePve, deps, INPUT } from "./fakes/catalogue-pve"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function install(a: ReturnType<typeof Fastify>) {
  const pv = await a.inject({ method: "POST", url: "/wizard/preview", payload: INPUT() })
  assert.equal(pv.statusCode, 200, pv.body)
  return a.inject({ method: "POST", url: "/wizard/apply", payload: { previewId: pv.json().data.previewId } })
}

test("a catalogue job is read only by the user who started it, and its id is a UUID", async () => {
  let user = "a@example.com"
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => user, wizard: deps(new FakePve()) }))
  const res = await install(a)
  assert.equal(res.statusCode, 200, res.body)
  const { jobId } = res.json().data
  assert.match(jobId, UUID)
  assert.equal(getInstallJob(jobId)!.owner, "a@example.com")
  assert.equal((await a.inject({ method: "GET", url: `/jobs/${jobId}` })).statusCode, 200)
  user = "b@example.com"
  assert.equal((await a.inject({ method: "GET", url: `/jobs/${jobId}` })).statusCode, 404, "another user's job reads as no job")
  user = ""
  assert.equal((await a.inject({ method: "GET", url: `/jobs/${jobId}` })).statusCode, 404)
})

test("with nobody to own it, a preview and an apply are refused before anything starts", async () => {
  const f = new FakePve()
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => "", wizard: deps(f) }))
  assert.equal((await a.inject({ method: "POST", url: "/wizard/preview", payload: INPUT() })).statusCode, 401)
  assert.equal((await a.inject({ method: "POST", url: "/wizard/apply", payload: { previewId: "x" } })).statusCode, 401)
  assert.equal(f.creates.length, 0)
})

test("by default the owner is ownerOf the request: an API token by its id, not its name", async () => {
  const a = Fastify()
  // As the gate does: the rest of the request runs inside the caller's context.
  a.addHook("onRequest", (_req, _res, done) => requestContext.run({ sid: "token:abc", email: "token:deploy-bot", role: "admin" } as any, done))
  a.register(buildCatalogueRoutes({ wizard: deps(new FakePve()) }))
  const res = await install(a)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(getInstallJob(res.json().data.jobId)!.owner, "token:abc")
})
