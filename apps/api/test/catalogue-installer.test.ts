// The catalogue installer's create step against a fake Proxmox: always unprivileged, nesting only, and
// created exactly as the checked plan says.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createFromPlan, type InstallPlan } from "../src/lib/catalogue-installer"
import { findRecipe } from "../src/lib/catalogue"

function fakePve() {
  const calls: { body?: URLSearchParams; path?: string; waited: any[]; downloaded?: any[] } = { waited: [] }
  const pve: any = {
    fetchStrict: async (p: string, m: string, body: string) => {
      if (m === "POST" && p === "/nodes/pve1/lxc") { calls.path = p; calls.body = new URLSearchParams(body); return "UPID:pve1:1:2:3:vzcreate:120:tok@pve:" }
      throw new Error("unexpected " + p)
    },
    fetchNode: async () => null,
    createLXC: async () => { throw new Error("createLXC is not used: the plan's create sends every value itself") },
    waitForTask: async (...a: any[]) => { calls.waited.push(a) },
    downloadTemplate: async (...a: any[]) => { calls.downloaded = a; return "UPID:dl" },
  }
  return { pve, calls }
}
const PLAN: InstallPlan = {
  recipeId: "nginx-proxy-manager", node: "pve1", vmid: 120, hostname: "npm", cores: 2, memoryMb: 1024, swapMb: 512,
  diskGb: 8, storage: "pool", bridge: "vmbr0", ip: "dhcp", template: "tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst",
  unprivileged: true,
}

test("a Docker recipe is created unprivileged with nesting only", async () => {
  const fake = fakePve()
  let created = false
  await createFromPlan(PLAN, findRecipe("nginx-proxy-manager")!, "job-1", fake.pve, () => { created = true })
  const b = fake.calls.body!
  assert.equal(b.get("unprivileged"), "1")
  assert.equal(b.get("features"), "nesting=1")
  assert.equal(b.get("onboot"), "1")
  assert.equal(b.get("net0"), "name=eth0,bridge=vmbr0,ip=dhcp,firewall=1")
  assert.deepEqual([b.get("vmid"), b.get("rootfs"), b.get("swap")], ["120", "pool:8", "512"])
  assert.equal(created, true)
  assert.equal(fake.calls.waited.length, 1)
})

test("a non-Docker recipe is created the same way", async () => {
  const fake = fakePve()
  await createFromPlan({ ...PLAN, recipeId: "ollama" }, findRecipe("ollama")!, "job-2", fake.pve)
  assert.equal(fake.calls.body!.get("unprivileged"), "1")
  assert.equal(fake.calls.body!.get("features"), "nesting=1")
})

test("a template the preview found only on offer is downloaded before the create", async () => {
  const fake = fakePve()
  await createFromPlan({ ...PLAN, downloadTemplate: true }, findRecipe("gitea")!, "job-3", fake.pve)
  assert.deepEqual(fake.calls.downloaded, ["pve1", "tmpl", "debian-13-standard_13.1-2_amd64.tar.zst"])
  assert.equal(fake.calls.waited.length, 2)
})

// ── startInstall: the reuse path and generated admin logins ──────────────────
import { startInstall, getInstallJob, readAdminCredential, ADMIN_CREDENTIAL_WINDOW_MS, type InstallDeps } from "../src/lib/catalogue-installer"
import { wizardRecipes } from "../src/lib/catalogue"

class FakeVault {
  open = true
  items = new Map<string, Record<string, string>>()
  deps = {
    vaultOpen:   async () => this.open,
    saveSecrets: async (c: string, p: string, v: Record<string, string>) => {
      if (!this.open) throw new Error("locked")
      this.items.set(`${c}/${p}`, { ...(this.items.get(`${c}/${p}`) ?? {}), ...v })
    },
    readSecrets: async (c: string, p: string) => {
      if (!this.open) throw new Error("locked")
      return { ...(this.items.get(`${c}/${p}`) ?? {}) }
    },
    deleteSecrets: async (c: string, p: string) => { this.items.delete(`${c}/${p}`) },
  }
}

function installDeps(ostype: string | undefined, scripts: string[], logged: string[] = [], vault = new FakeVault()): InstallDeps {
  const pve: any = {
    getClusterResources: async () => [{ vmid: 130, type: "lxc", node: "pve1", status: "running" }],
    getNodes: async () => [],
    fetchStrict: async () => { throw new Error("no create expected") },
    createLXC: async () => { throw new Error("no create expected") },
    fetchNode: async (p: string) => {
      if (p.endsWith("/config")) return ostype ? { ostype } : {}
      if (p.endsWith("/interfaces")) return [{ name: "eth0", inet: "10.0.0.30/24" }]
      if (p === "/cluster/status") return [{ type: "node", name: "pve1", ip: "10.0.0.1" }]
      return null
    },
  }
  return {
    ...vault.deps, client: pve, wait: async () => {}, credential: async () => ({ id: "c" }), probe: async () => 200,
    exec: async o => { scripts.push(o.script); o.onData("installing\n"); logged.push("installing\n"); return { code: 0, output: "", timedOut: false } as any },
  }
}
async function done(id: string) {
  for (let i = 0; i < 200 && getInstallJob(id)!.status === "running"; i++) await new Promise(r => setTimeout(r, 5))
  return getInstallJob(id)!
}

test("installing into an existing Ubuntu container uses the Ubuntu packages", async () => {
  const scripts: string[] = []
  const job = await done((await startInstall({ recipeId: "gitea", intoVmid: 130 }, installDeps("ubuntu", scripts))).jobId)
  assert.equal(job.status, "completed")
  assert.match(scripts[0], /docker-compose-v2/)
})

test("installing into an existing Debian container uses the Debian packages", async () => {
  const scripts: string[] = []
  await done((await startInstall({ recipeId: "gitea", intoVmid: 130 }, installDeps("debian", scripts))).jobId)
  assert.doesNotMatch(scripts[0], /docker-compose-v2/)
})

test("an unknown ostype is refused and nothing runs", async () => {
  const scripts: string[] = []
  for (const os of ["alpine", undefined]) {
    const job = await done((await startInstall({ recipeId: "gitea", intoVmid: 130 }, installDeps(os, scripts))).jobId)
    assert.equal(job.status, "failed")
    assert.match(job.error!, /neither Debian nor Ubuntu/)
  }
  assert.equal(scripts.length, 0)
})

test("a Grafana install passes a generated password, keeps it in the vault, and the job holds only a reference", async () => {
  const scripts: string[] = [], logged: string[] = [], vault = new FakeVault()
  const deps = installDeps("debian", scripts, logged, vault)
  const job = await done((await startInstall({ recipeId: "grafana", intoVmid: 130 }, deps)).jobId)
  const stored = vault.items.get("apps/grafana-130")!
  const pw = stored.admin_password
  assert.ok(pw.length >= 16); assert.notEqual(pw.toLowerCase(), "admin")
  assert.equal(stored.admin_user, "admin")
  assert.match(scripts[0], new RegExp(`GF_SECURITY_ADMIN_PASSWORD=${pw}\\n`))
  assert.doesNotMatch(scripts[0], /:-admin/)
  assert.ok(!JSON.stringify(job).includes(pw), "not in the job at all: log, steps or reference")
  assert.ok(!logged.join("").includes(pw))
  assert.deepEqual(job.adminCredential!.vault, { category: "apps", provider: "grafana-130", key: "admin_password" })
  assert.deepEqual(await readAdminCredential(job, deps), { user: "admin", password: pw })
  // Each install gets its own.
  await done((await startInstall({ recipeId: "grafana", intoVmid: 130 }, installDeps("debian", scripts, [], vault))).jobId)
  assert.ok(vault.items.get("apps/grafana-130")!.admin_password !== pw)
})

test("the admin login is served only while fresh and the vault is unlocked", async () => {
  const vault = new FakeVault(), deps = installDeps("debian", [], [], vault)
  const job = await done((await startInstall({ recipeId: "grafana", intoVmid: 130 }, deps)).jobId)
  const at = job.adminCredential!.issuedAt
  assert.ok(await readAdminCredential(job, deps, () => at + 1000))
  assert.equal(await readAdminCredential(job, deps, () => at + ADMIN_CREDENTIAL_WINDOW_MS + 1), undefined)
  vault.open = false
  assert.equal(await readAdminCredential(job, deps, () => at + 1000), undefined)
})

test("a locked vault refuses a Grafana install before anything runs", async () => {
  const scripts: string[] = [], vault = new FakeVault()
  vault.open = false
  await assert.rejects(startInstall({ recipeId: "grafana", intoVmid: 130 }, installDeps("debian", scripts, [], vault)), /vault is locked/)
  assert.equal(scripts.length, 0)
})

test("a vault write that fails stops the install before the script runs", async () => {
  const scripts: string[] = [], vault = new FakeVault(), deps = installDeps("debian", scripts, [], vault)
  deps.saveSecrets = async () => { throw new Error("vault write failed") }
  const job = await done((await startInstall({ recipeId: "grafana", intoVmid: 130 }, deps)).jobId)
  assert.equal(job.status, "failed"); assert.equal(scripts.length, 0); assert.equal(job.adminCredential, undefined)
})

test("a recipe with no environment admin returns no credential", async () => {
  const job = await done((await startInstall({ recipeId: "gitea", intoVmid: 130 }, installDeps("debian", []))).jobId)
  assert.equal(job.adminCredential, undefined)
})

test("Grafana is not offered to the wizard, and the installable list is wizard recipes only", () => {
  assert.equal(wizardRecipes().some(r => r.id === "grafana"), false)
})

test("a catalogue Homepage install allows the address it was given", async () => {
  const scripts: string[] = []
  const job = await done((await startInstall({ recipeId: "homepage", intoVmid: 130 }, installDeps("debian", scripts))).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.match(scripts[0], /\nHOMEPAGE_ALLOWED_HOSTS=10\.0\.0\.30:3000\n/)
})

test("a Vaultwarden install gets a generated ADMIN_TOKEN, kept in the vault and shown once, with sign-ups off", async () => {
  const scripts: string[] = [], logged: string[] = [], vault = new FakeVault()
  const deps = installDeps("debian", scripts, logged, vault)
  const job = await done((await startInstall({ recipeId: "vaultwarden", intoVmid: 130 }, deps)).jobId)
  assert.equal(job.status, "completed", job.error)
  const token = vault.items.get("apps/vaultwarden-130")!.admin_password
  assert.ok(token && token.length >= 24, "randomBytes(18) as base64url")
  assert.match(scripts[0], new RegExp(`\\nADMIN_TOKEN=${token}\\n`))
  assert.match(scripts[0], /SIGNUPS_ALLOWED=false/)
  assert.ok(!JSON.stringify(job).includes(token))
  assert.ok(!logged.join("").includes(token))
  assert.deepEqual(await readAdminCredential(job, deps), { user: "/admin", password: token })
})
