// The Proxmox client must follow the token as it arrives from (and leaves with) the vault, not keep the
// empty one from start-up. Regression: the Storage page showed 0 B after the vault gate went live.
import { test } from "node:test"
import assert from "node:assert/strict"
import { pveFromEnv, livePve } from "../src/lib/pve-env"

test("locked (no token): a clear error, not a client with an empty token", () => {
  delete process.env.PROXMOX_TOKEN_SECRET
  process.env.PROXMOX_HOST = "192.168.1.5"
  assert.throws(() => pveFromEnv(), /locked/)
})

test("a client built before unlock picks up the token once it arrives, and follows a change", () => {
  delete process.env.PROXMOX_TOKEN_SECRET
  const pve = livePve()                         // what a route does at registration time
  assert.throws(() => pve.getNodes, /locked/)
  process.env.PROXMOX_TOKEN_SECRET = "first"
  const a = pveFromEnv()
  assert.equal(typeof pve.getNodes, "function")
  assert.equal(pveFromEnv(), a, "reused while the values stay the same")
  process.env.PROXMOX_TOKEN_SECRET = "second"
  assert.notEqual(pveFromEnv(), a, "rebuilt when the token changes")
})
