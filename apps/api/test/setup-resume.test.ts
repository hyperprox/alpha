// A reload used to drop the setup wizard back to step 1 whatever it had already done. The step now comes
// from what .env records; these pin the decision and the /api/setup/state answer the page resumes from.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const setup = require("../../setup/setup.js")

const connected = { PROXMOX_HOST: "10.0.0.5", PROXMOX_USER: "root@pam", PROXMOX_TOKEN_ID: "hyperprox-node-a", PROXMOX_TOKEN_SECRET: "s" }

test("nothing saved: step 0 (Proxmox)", () => {
  assert.equal(setup.resumeStep({}, false), 0)
})

test("connected and the token works: step 1 (Cluster), from which the service scan reruns", () => {
  assert.equal(setup.resumeStep(connected, true), 1)
})

test("connected but the saved token no longer authenticates: back to step 0", () => {
  assert.equal(setup.resumeStep(connected, false), 0)
  assert.equal(setup.resumeStep({ ...connected, INSTALL_PROMETHEUS: "true" }, false), 0)
})

test("install choices saved: step 3 (Providers), whichever way they were answered", () => {
  assert.equal(setup.resumeStep({ ...connected, INSTALL_PROMETHEUS: "true" }, true), 3)
  assert.equal(setup.resumeStep({ ...connected, INSTALL_PROMETHEUS: "false" }, true), 3)
})

test("install choices map onto compose profiles", () => {
  assert.equal(setup.composeProfiles({ INSTALL_PROMETHEUS: "true", INSTALL_GRAFANA: "true", INSTALL_NPM: "false" }), "monitoring")
  assert.equal(setup.composeProfiles({ INSTALL_PROMETHEUS: "true", INSTALL_NPM: "true" }), "monitoring,npm")
  assert.equal(setup.composeProfiles({ INSTALL_PROMETHEUS: "false", INSTALL_GRAFANA: "false", INSTALL_NPM: "false" }), "")
})

// ── The route itself, against the real server and a throwaway .env ──────────────────────────────────────
const KEY = "c".repeat(64)
const procs: ChildProcess[] = []
after(() => procs.forEach((p) => p.kill()))

/** Starts the setup server on a throwaway .env; returns a GET for /api/setup/state, with or without the key. */
async function serve(env: string) {
  const dir = mkdtempSync(join(tmpdir(), "hpx-setup-resume-"))
  const envFile = join(dir, ".env")
  writeFileSync(envFile, `SETUP_SECRET=${KEY}\nENCRYPTION_KEY=${"b".repeat(64)}\n${env}`)
  const port = 39000 + Math.floor(Math.random() * 1000)
  procs.push(spawn(process.execPath, [join(__dirname, "..", "..", "setup", "setup.js")], {
    env: { ...process.env, SETUP_PORT: String(port), SETUP_BIND: "127.0.0.1", ENV_FILE_PATH: envFile, SETUP_COMPLETE: "false" },
    stdio: "ignore",
  }))
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  return async (withKey = true) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/setup/state`, { headers: withKey ? { "x-setup-key": KEY } : {} })
    return { status: r.status, body: (await r.json()) as any }
  }
}

test("state on a fresh install: step 0, nothing prefilled", async () => {
  const state = await serve("")
  const { status, body } = await state()
  assert.equal(status, 200)
  assert.equal(body.step, 0)
  assert.equal(body.proxmox.host, "")
  assert.equal(body.cluster, null)
  assert.equal(body.error, null)
  assert.equal((await state(false)).status, 401, "and only with the setup key")
})

test("state with a saved token Proxmox refuses: step 0, address prefilled, a reason, and no secret in the answer", async () => {
  // Port 1 on loopback: nothing listens, so the saved connection fails the way a dead one does.
  const state = await serve(
    "PROXMOX_HOST=127.0.0.1\nPROXMOX_PORT=1\nPROXMOX_USER=root@pam\nPROXMOX_TOKEN_ID=hyperprox-node-a\n" +
    "PROXMOX_TOKEN_SECRET=do-not-leak\nINSTALL_PROMETHEUS=true\nINSTALL_GRAFANA=true\nINSTALL_NPM=false\n" +
    "GODADDY_ENABLED=true\nGODADDY_API_KEY=enc-key\nGODADDY_API_SECRET=enc-secret\n")
  const { body } = await state()
  assert.equal(body.step, 0)
  assert.equal(body.proxmox.host, "127.0.0.1")
  assert.equal(body.proxmox.tokenId, "root@pam!hyperprox-node-a")
  assert.match(body.error, /no longer works/)
  assert.deepEqual(body.installs, { npm: false, grafana: true, prometheus: true })
  assert.deepEqual(body.providers, { godaddy: { enabled: true } })
  const text = JSON.stringify(body)
  for (const secret of ["do-not-leak", "enc-key", "enc-secret"]) assert.ok(!text.includes(secret), `${secret} not returned`)
})
