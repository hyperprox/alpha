// A Catalogue recipe that is a proxy HyperProx drives (registersProxy) goes on the Proxy page by itself once it answers:
// the script gets a fresh secret, the registration gets the container, and a failure leaves the install standing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CATALOGUE, type CatalogueRecipe } from "../src/lib/catalogue"
import { startInstall, getInstallJob, type InstallDeps } from "../src/lib/catalogue-installer"
import type { ManagedProxyRegistration } from "../src/lib/proxy/managed-recipes"

const RECIPE: CatalogueRecipe = {
  id: "test-proxy-register", name: "Test proxy", summary: "A proxy for this test.", category: "proxy",
  port: 80, healthPath: "/", expectStatus: [200], needsDocker: false,
  defaults: { cores: 1, memoryMb: 256, diskGb: 4 }, minimum: { cores: 1, memoryMb: 128, diskGb: 2 },
  firstRun: { kind: "none" }, wizard: false, registersProxy: "caddy",
  install: { kind: "script", script: "echo installing" },
}

function deps(scripts: string[], probe: number | null, register?: InstallDeps["registerProxy"]): InstallDeps {
  const pve: any = {
    getClusterResources: async () => [{ vmid: 9100, type: "lxc", node: "pve1", status: "running" }],
    fetchStrict: async () => { throw new Error("no create expected") },
    fetchNode: async (p: string) => {
      if (p.endsWith("/config")) return { ostype: "debian" }
      if (p.endsWith("/interfaces")) return [{ name: "eth0", inet: "10.0.0.30/24" }]
      if (p === "/cluster/status") return [{ type: "node", name: "pve1", ip: "10.0.0.1" }]
      return null
    },
  }
  return {
    client: pve, wait: async () => {}, credential: async () => ({ id: "c" }), probe: async () => probe,
    vaultOpen: async () => true, saveSecrets: async () => {}, readSecrets: async () => ({}), deleteSecrets: async () => {},
    publish: {} as any,
    exec: async o => { scripts.push(o.script); return { code: 0, output: "", timedOut: false } as any },
    registerProxy: register,
  }
}
async function done(id: string) {
  for (let i = 0; i < 200 && getInstallJob(id)!.status === "running"; i++) await new Promise(r => setTimeout(r, 5))
  return getInstallJob(id)!
}

test("setup", () => { CATALOGUE.push(RECIPE) })

test("a proxy recipe that answers is registered with its container, address and the secret its script was given", async () => {
  const scripts: string[] = [], seen: ManagedProxyRegistration[] = []
  const job = await done((await startInstall({ recipeId: RECIPE.id, intoVmid: 9100, owner: "admin@example.invalid" },
    deps(scripts, 200, async o => { seen.push(o); return "Added to the Proxy page." }))).jobId)
  assert.equal(job.status, "completed")
  assert.equal(seen.length, 1)
  assert.deepEqual({ ...seen[0], secret: "x" }, {
    kind: "caddy", recipeId: RECIPE.id, name: "Test proxy on CT 9100", ip: "10.0.0.30", node: "pve1", vmid: 9100, secret: "x", owner: "admin@example.invalid",
  })
  assert.match(seen[0].secret, /^[A-Za-z0-9_-]{16,}$/)
  // The same secret went to the script (exported, quoted), so a login the script sets up matches the vault's.
  assert.ok(scripts[0].includes(`export HPX_PROXY_SECRET='${seen[0].secret}'`))
  const s = job.steps.find(x => x.id === "proxy")!
  assert.equal(s.status, "done")
  assert.equal(s.detail, "Added to the Proxy page.")
})

test("a proxy that does not answer is not registered", async () => {
  let called = false
  const job = await done((await startInstall({ recipeId: RECIPE.id, intoVmid: 9100 }, deps([], null, async () => { called = true; return "" }))).jobId)
  assert.equal(called, false)
  assert.equal(job.steps.find(x => x.id === "proxy")!.status, "skipped")
})

test("a registration that fails leaves the install standing and says what to do", async () => {
  const job = await done((await startInstall({ recipeId: RECIPE.id, intoVmid: 9100 }, deps([], 200, async () => { throw new Error("the vault is locked") }))).jobId)
  assert.equal(job.status, "completed")
  const s = job.steps.find(x => x.id === "proxy")!
  assert.equal(s.status, "failed")
  assert.match(s.detail!, /installed and answering.*the vault is locked.*Managed instance/)
})

test("a recipe that is not a proxy gets no secret and no proxy step", async () => {
  const scripts: string[] = []
  const job = await done((await startInstall({ recipeId: "ollama", intoVmid: 9100 }, deps(scripts, 200, async () => { throw new Error("not expected") }))).jobId)
  assert.equal(job.steps.some(x => x.id === "proxy"), false)
  assert.doesNotMatch(scripts[0], /HPX_PROXY_SECRET/)
})

test("teardown", () => { CATALOGUE.splice(CATALOGUE.indexOf(RECIPE), 1) })
