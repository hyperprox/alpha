// The setup wizard's "Install with HyperProx" step no longer offers Nginx Proxy Manager (it needs ports 80
// and 443, which HyperProx's own nginx holds, so the bundled one could never start), and it no longer
// points at Prometheus or Grafana ports that are now loopback-only. The connect step also gives the PVE
// exporter its own read-only token. These drive the real page, the real server and setupExporter.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import vm from "node:vm"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const setup = require("../../setup/setup.js")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared = require("../../setup/pve-exporter.js")

test("the install step offers Prometheus and Grafana, not Nginx Proxy Manager", () => {
  const html: string = setup.WIZARD_HTML
  assert.doesNotMatch(html, /key:'npm'/, "no npm install card")
  assert.match(html, /key:'prometheus'/)
  assert.match(html, /key:'grafana'/)
  assert.match(html, /installs: \{ grafana: true, prometheus: true \}/)
  assert.match(html, /Install it from the <strong>Catalogue<\/strong>/, "points to the Catalogue instead")
})

test("the page's script still compiles, and puts Proxmox's error text in the page escaped", () => {
  const html: string = setup.WIZARD_HTML
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(scripts.length > 0)
  for (const src of scripts) assert.doesNotThrow(() => new vm.Script(src))
  assert.match(html, /could not be made \(\$\{escHtml\(S\.exporter\.error\)\}\)/)
})

test("the page no longer names the monitoring ports, which are loopback-only now", () => {
  const html: string = setup.WIZARD_HTML
  assert.doesNotMatch(html, /:9090/)
  assert.doesNotMatch(html, /port 3003|:3003/)
  assert.match(html, /\/grafana\/ \(after you sign in\)/)
})

// ── The server: save-installs and state, on a throwaway .env ───────────────────────────────────────────
const KEY = "d".repeat(64)
const procs: ChildProcess[] = []
after(() => procs.forEach((p) => p.kill()))

async function serve(env: string) {
  const dir = mkdtempSync(join(tmpdir(), "hpx-setup-installs-"))
  const envFile = join(dir, ".env")
  writeFileSync(envFile, `SETUP_SECRET=${KEY}\nENCRYPTION_KEY=${"b".repeat(64)}\n${env}`)
  const port = 40000 + Math.floor(Math.random() * 1000)
  procs.push(spawn(process.execPath, [join(__dirname, "..", "..", "setup", "setup.js")], {
    env: { ...process.env, SETUP_PORT: String(port), SETUP_BIND: "127.0.0.1", ENV_FILE_PATH: envFile, SETUP_COMPLETE: "false" },
    stdio: "ignore",
  }))
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  const call = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/setup/${route}`, {
      method, headers: { "x-setup-key": KEY, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    })
    return (await r.json()) as any
  }
  return { call, env: () => readFileSync(envFile, "utf8") }
}

test("save-installs records Prometheus and Grafana, and nothing for npm even if a client still sends it", async () => {
  const { call, env } = await serve("")
  assert.equal((await call("POST", "save-installs", { installs: { npm: true, grafana: true, prometheus: false } })).ok, true)
  const e = env()
  assert.match(e, /^INSTALL_GRAFANA=true$/m)
  assert.match(e, /^INSTALL_PROMETHEUS=false$/m)
  assert.doesNotMatch(e, /INSTALL_NPM/)
  assert.equal(setup.composeProfiles(Object.fromEntries(e.split("\n").filter(Boolean).map((l) => l.split("=")))), "monitoring")
})

test("state from an old .env with INSTALL_NPM=true reports no npm choice", async () => {
  const { call } = await serve("INSTALL_PROMETHEUS=true\nINSTALL_GRAFANA=true\nINSTALL_NPM=true\n")
  const body = await call("GET", "state")
  assert.deepEqual(body.installs, { grafana: true, prometheus: true })
})

// ── The exporter's read-only token, as the connect step makes it ───────────────────────────────────────
function fakePve(userid: string, tokens: Array<{ tokenid: string; secret: string; comment?: string; privsep?: number }>) {
  const calls: string[] = []
  const acls: Array<{ path: string; roleid: string; type: string; ugid: string }> = []
  let n = 0
  return {
    calls, acls, tokens,
    async listTokens() { calls.push("list"); return tokens.map((t) => ({ tokenid: t.tokenid, comment: t.comment ?? "" })) },
    async deleteToken(name: string) { calls.push(`delete ${name}`); tokens.splice(tokens.findIndex((t) => t.tokenid === name), 1) },
    async createToken(name: string, o: { privsep: number; comment: string }) {
      calls.push(`create ${name} privsep=${o.privsep}`)
      const secret = `exp-secret-${++n}`
      tokens.push({ tokenid: name, secret, comment: o.comment, privsep: o.privsep })
      return { "full-tokenid": `${userid}!${name}`, value: secret }
    },
    async setAcl(a: { path: string; role: string; token: string }) {
      calls.push(`acl ${a.path} ${a.role} ${a.token}`)
      acls.push({ path: a.path, roleid: a.role, type: "token", ugid: a.token })
    },
    async getToken(name: string, u = userid) {
      calls.push(`get ${u}!${name}`)
      const t = tokens.find((x) => x.tokenid === name)
      if (!t) throw new Error("PVE 500: no such token")
      return { privsep: t.privsep ?? 0 }
    },
    async listAcl() { calls.push("acls"); return acls },
    async tokenWorks(fullId: string, secret: string) {
      const [u, name] = fullId.split("!")
      return u === userid && tokens.some((t) => t.tokenid === name && t.secret === secret)
    },
  }
}

test("connect: the exporter gets <token>-exporter, privilege-separated, PVEAuditor on /, in pve.yml 0600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hpx-setup-exporter-"))
  const file = join(dir, "config", "pve-exporter", "pve.yml")
  mkdirSync(file, { recursive: true })          // the directory Docker makes for a missing bind-mount source
  const pve = fakePve("root@pam", [{ tokenid: "hyperprox-node-a-0a1b2c3d", secret: "admin" }])
  let restarts = 0
  const r = await setup.setupExporter(pve, "root@pam", "hyperprox-node-a-0a1b2c3d", file, () => { restarts++ })
  assert.deepEqual(r, { ok: true, action: "create", tokenId: "root@pam!hyperprox-node-a-0a1b2c3d-exporter" })
  assert.deepEqual(pve.calls, ["list", "create hyperprox-node-a-0a1b2c3d-exporter privsep=1",
    "acl / PVEAuditor root@pam!hyperprox-node-a-0a1b2c3d-exporter",
    "get root@pam!hyperprox-node-a-0a1b2c3d-exporter", "acls"])
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(shared.readPveYml(file), { user: "root@pam", tokenName: "hyperprox-node-a-0a1b2c3d-exporter", secret: "exp-secret-1" })
  assert.equal(restarts, 1)

  // Connecting again (a reload, a second attempt) keeps the token and does not restart the exporter.
  pve.calls.length = 0
  const again = await setup.setupExporter(pve, "root@pam", "hyperprox-node-a-0a1b2c3d", file, () => { restarts++ })
  assert.equal(again.action, "reuse")
  assert.deepEqual(pve.calls, ["get root@pam!hyperprox-node-a-0a1b2c3d-exporter", "acls"], "checked, nothing written")
  assert.equal(restarts, 1)
})

test("connect: an exporter token someone else made is left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hpx-setup-exporter-"))
  const file = join(dir, "pve.yml")
  const pve = fakePve("root@pam", [{ tokenid: "hyperprox-exporter", secret: "theirs", comment: "mine, not HyperProx's" }])
  await assert.rejects(setup.setupExporter(pve, "root@pam", "hyperprox", file, () => {}), /was not made by HyperProx/)
  assert.ok(!pve.calls.some((c) => c.startsWith("delete")), "nothing deleted")
})
