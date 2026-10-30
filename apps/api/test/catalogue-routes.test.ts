// Catalogue install jobs: owned like wizard jobs (ownerOf), read only by their owner, with unguessable ids.
import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { buildCatalogueRoutes } from "../src/routes/catalogue"
import { startInstall, getInstallJob, type InstallDeps } from "../src/lib/catalogue-installer"
import { requestContext } from "../src/lib/auth"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function fake(): InstallDeps {
  const client: any = {
    getClusterResources: async () => [{ vmid: 130, type: "lxc", node: "pve1", status: "running" }],
    getNodes: async () => [], fetchStrict: async () => { throw new Error("no create expected") },
    createLXC: async () => { throw new Error("no create expected") }, waitForTask: async () => {}, downloadTemplate: async () => "",
    fetchNode: async (p: string) => {
      if (p.endsWith("/config")) return { ostype: "debian" }
      if (p.endsWith("/interfaces")) return [{ name: "eth0", inet: "10.0.0.30/24" }]
      if (p === "/cluster/status") return [{ type: "node", name: "pve1", ip: "10.0.0.1" }]
      return null
    },
  }
  return {
    client, wait: async () => {}, credential: async () => ({ id: "c" }), probe: async () => 200,
    exec: async () => ({ code: 0, output: "", timedOut: false }) as any,
    vaultOpen: async () => true, saveSecrets: async () => {}, readSecrets: async () => ({}),
  }
}

function app(over: Parameters<typeof buildCatalogueRoutes>[0]) {
  const a = Fastify()
  a.register(buildCatalogueRoutes({ start: o => startInstall(o, fake()), ...over }))
  return a
}

test("a catalogue job is read only by the user who started it, and its id is a UUID", async () => {
  let user = "a@example.com"
  const a = app({ whoami: () => user })
  const res = await a.inject({ method: "POST", url: "/install", payload: { recipeId: "gitea", intoVmid: 130 } })
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

test("with nobody to own it, an install is refused before anything starts", async () => {
  let started = 0
  const a = app({ whoami: () => "", start: async () => { started++; throw new Error("not reached") } })
  const res = await a.inject({ method: "POST", url: "/install", payload: { recipeId: "gitea", intoVmid: 130 } })
  assert.equal(res.statusCode, 401)
  assert.equal(started, 0)
})

test("by default the owner is ownerOf the request: an API token by its id, not its name", async () => {
  const a = Fastify()
  // As the gate does: the rest of the request runs inside the caller's context.
  a.addHook("onRequest", (_req, _res, done) => requestContext.run({ sid: "token:abc", email: "token:deploy-bot", role: "admin" } as any, done))
  a.register(buildCatalogueRoutes({ start: o => startInstall(o, fake()) }))
  const res = await a.inject({ method: "POST", url: "/install", payload: { recipeId: "gitea", intoVmid: 130 } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(getInstallJob(res.json().data.jobId)!.owner, "token:abc")
})
