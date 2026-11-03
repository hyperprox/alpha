// The setup wizard's "Install with HyperProx" step no longer offers Nginx Proxy Manager (it needs ports 80
// and 443, which HyperProx's own nginx holds, so the bundled one could never start), and it no longer
// points at Prometheus or Grafana ports that are now loopback-only. These drive the real page and server.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const setup = require("../../setup/setup.js")

test("the install step offers Prometheus and Grafana, not Nginx Proxy Manager", () => {
  const html: string = setup.WIZARD_HTML
  assert.doesNotMatch(html, /key:'npm'/, "no npm install card")
  assert.match(html, /key:'prometheus'/)
  assert.match(html, /key:'grafana'/)
  assert.match(html, /installs: \{ grafana: true, prometheus: true \}/)
  assert.match(html, /Install it from the <strong>Catalogue<\/strong>/, "points to the Catalogue instead")
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
