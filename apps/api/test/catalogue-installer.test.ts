// The catalogue installer's create step against a fake Proxmox: always unprivileged, nesting only.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createContainer } from "../src/lib/catalogue-installer"
import { findRecipe } from "../src/lib/catalogue"

const GB = 1024 ** 3
function fakePve(volids = ["tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"]) {
  const calls: { create?: any; waited?: any[] } = {}
  const pve: any = {
    getNodes: async () => [{ node: "pve1", status: "online", maxmem: 16 * GB, mem: 4 * GB }],
    fetchStrict: async (p: string) => { if (p === "/cluster/nextid") return "120"; throw new Error("unexpected " + p) },
    fetchNode: async (p: string) => {
      if (p.includes("storage?content=vztmpl")) return [{ storage: "tmpl" }]
      if (p.includes("/content?content=vztmpl")) return volids.map(volid => ({ volid }))
      if (p.includes("storage?content=rootdir")) return [{ storage: "pool", type: "rbd", enabled: 1, active: 1, avail: 100 * GB }]
      return null
    },
    createLXC: async (_n: string, params: any) => { calls.create = params; return "UPID:pve1:1:2:3:vzcreate:120:tok@pve:" },
    waitForTask: async (...a: any[]) => { (calls.waited ??= []).push(a) },
    downloadTemplate: async () => { throw new Error("no download expected") },
  }
  return { pve, calls }
}
const SIZES = { cores: 2, memoryMb: 1024, diskGb: 8 }

test("a Docker recipe is created unprivileged with nesting only", async () => {
  const fake = fakePve()
  const made = await createContainer(findRecipe("nginx-proxy-manager")!, SIZES, undefined, fake.pve)
  assert.equal(fake.calls.create.unprivileged, true)
  assert.equal(fake.calls.create.features, "nesting=1")
  assert.equal(fake.calls.create.onboot, true)
  assert.equal(fake.calls.create.net0, "name=eth0,bridge=vmbr0,ip=dhcp,firewall=1")
  assert.deepEqual([made.vmid, made.node, made.distro], [120, "pve1", "debian"])
  assert.equal(fake.calls.waited!.length, 1)
})

test("a non-Docker recipe is created the same way", async () => {
  const fake = fakePve()
  await createContainer(findRecipe("ollama")!, SIZES, undefined, fake.pve)
  assert.equal(fake.calls.create.unprivileged, true)
  assert.equal(fake.calls.create.features, "nesting=1")
})

test("the distro comes from the template that was chosen", async () => {
  const fake = fakePve(["tmpl:vztmpl/ubuntu-24.04-standard_24.04-1_amd64.tar.zst"])
  assert.equal((await createContainer(findRecipe("gitea")!, SIZES, undefined, fake.pve)).distro, "ubuntu")
})

test("no Debian or Ubuntu template is refused before anything is created", async () => {
  const fake = fakePve(["tmpl:vztmpl/alpine-3.20-default_amd64.tar.xz"])
  await assert.rejects(createContainer(findRecipe("gitea")!, SIZES, undefined, fake.pve), /No Debian or Ubuntu template/)
  assert.equal(fake.calls.create, undefined)
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
