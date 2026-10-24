// The setup wizard's connect step used to mint a new `hyperprox-<host>-<random>` token on every attempt, so
// each retry left another live token on the user. It now keeps one name per install and changes the cluster
// only when it has to. These drive the decision against a fake Proxmox that records every call.
import { test } from "node:test"
import assert from "node:assert/strict"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const setup = require("../../setup/setup.js")

type Token = { tokenid: string; secret: string }

/** A user's token list on a pretend cluster, the way connectWithLogin's adapter presents it. */
function fakePve(userid: string, tokens: Token[]) {
  const calls: string[] = []
  let n = 0
  const pve = {
    calls,
    tokens,
    async listTokens() {
      calls.push("list")
      return tokens.map((t) => ({ tokenid: t.tokenid, comment: "" }))
    },
    async deleteToken(name: string) {
      calls.push(`delete ${name}`)
      const i = tokens.findIndex((t) => t.tokenid === name)
      if (i < 0) throw Object.assign(new Error("PVE 404: no such token"), { status: 404 })
      tokens.splice(i, 1)
    },
    async createToken(name: string) {
      calls.push(`create ${name}`)
      if (tokens.some((t) => t.tokenid === name)) throw new Error("PVE 500: Token already exists")
      const secret = `secret-${++n}`
      tokens.push({ tokenid: name, secret })
      return { "full-tokenid": `${userid}!${name}`, value: secret }
    },
    async tokenWorks(fullId: string, secret: string) {
      calls.push(`test ${fullId}`)
      const [user, name] = fullId.split("!")
      return user === userid && tokens.some((t) => t.tokenid === name && t.secret === secret)
    },
  }
  return pve
}

const USER = "root@pam"
const NAME = setup.tokenName("node-a")

test("the token name is deterministic per install hostname, with no random part", () => {
  assert.equal(setup.tokenName("node-a"), "hyperprox-node-a")
  assert.equal(setup.tokenName("node-a"), setup.tokenName("node-a"))
  assert.equal(setup.tokenName("My Host.lan"), "hyperprox-my-host-lan")
  assert.equal(setup.tokenName("***"), "hyperprox-install")
})

test("first connect: no token yet, so exactly one is created", async () => {
  const pve = fakePve(USER, [])
  const r = await setup.ensureToken(pve, { userid: USER, name: NAME, held: null })
  assert.equal(r.action, "create")
  assert.equal(r.tokenId, `${USER}!${NAME}`)
  assert.deepEqual(pve.calls, ["list", `create ${NAME}`])
  assert.equal(pve.tokens.length, 1)
})

test("re-connect while HyperProx still holds a working secret: reused, nothing changes on the cluster", async () => {
  const pve = fakePve(USER, [{ tokenid: NAME, secret: "kept" }])
  const r = await setup.ensureToken(pve, { userid: USER, name: NAME, held: { tokenId: `${USER}!${NAME}`, secret: "kept" } })
  assert.equal(r.action, "reuse")
  assert.equal(r.tokenSecret, "kept")
  assert.deepEqual(pve.calls, [`test ${USER}!${NAME}`])
})

test("re-connect ten times in a row leaves one token, not ten", async () => {
  const pve = fakePve(USER, [])
  let held: { tokenId: string; secret: string } | null = null
  for (let i = 0; i < 10; i++) {
    const r = await setup.ensureToken(pve, { userid: USER, name: NAME, held })
    held = { tokenId: r.tokenId, secret: r.tokenSecret }
  }
  assert.equal(pve.tokens.length, 1)
  assert.equal(pve.calls.filter((c) => c.startsWith("create")).length, 1)
})

test("token exists but the secret is lost: that one token is deleted and recreated", async () => {
  const pve = fakePve(USER, [{ tokenid: NAME, secret: "gone" }])
  const r = await setup.ensureToken(pve, { userid: USER, name: NAME, held: null })
  assert.equal(r.action, "recreate")
  assert.deepEqual(pve.calls, ["list", `delete ${NAME}`, `create ${NAME}`])
  assert.notEqual(r.tokenSecret, "gone")
})

test("a held secret that no longer authenticates counts as lost", async () => {
  const pve = fakePve(USER, [{ tokenid: NAME, secret: "current" }])
  const r = await setup.ensureToken(pve, { userid: USER, name: NAME, held: { tokenId: `${USER}!${NAME}`, secret: "stale" } })
  assert.equal(r.action, "recreate")
  assert.deepEqual(pve.calls, [`test ${USER}!${NAME}`, "list", `delete ${NAME}`, `create ${NAME}`])
})

test("never deletes any other token: another install's, an old random one, or a user's own", async () => {
  const others = ["hyperprox-node-b", "hyperprox-node-a-1f2e", "hyperprox", "backup", "monitoring"]
  const pve = fakePve(USER, [...others.map((t) => ({ tokenid: t, secret: "x" })), { tokenid: NAME, secret: "lost" }])
  await setup.ensureToken(pve, { userid: USER, name: NAME, held: null })
  assert.deepEqual(pve.calls.filter((c) => c.startsWith("delete")), [`delete ${NAME}`])
  for (const t of others) assert.ok(pve.tokens.some((x) => x.tokenid === t), `${t} survived`)
})

test("a working token .env already holds under another name (e.g. made by bootstrap) is reused, not duplicated", async () => {
  const pve = fakePve(USER, [{ tokenid: "hyperprox", secret: "boot" }])
  const r = await setup.ensureToken(pve, { userid: USER, name: NAME, held: { tokenId: `${USER}!hyperprox`, secret: "boot" } })
  assert.equal(r.action, "reuse")
  assert.equal(r.tokenId, `${USER}!hyperprox`)
  assert.equal(pve.tokens.length, 1)
})

test("a held token for a different user is not reused for this one", async () => {
  const pve = fakePve("admin@pve", [])
  const r = await setup.ensureToken(pve, { userid: "admin@pve", name: NAME, held: { tokenId: `${USER}!${NAME}`, secret: "s" } })
  assert.equal(r.action, "create")
  assert.ok(!pve.calls.some((c) => c.startsWith("test")), "the other user's secret is not even tried")
})

test("heldToken only offers .env's token for the same Proxmox address and port", () => {
  const env = { PROXMOX_HOST: "10.0.0.5", PROXMOX_PORT: "8006", PROXMOX_USER: USER, PROXMOX_TOKEN_ID: NAME, PROXMOX_TOKEN_SECRET: "s" }
  assert.deepEqual(setup.heldToken(env, "10.0.0.5", "8006"), { tokenId: `${USER}!${NAME}`, secret: "s" })
  assert.equal(setup.heldToken(env, "10.0.0.6", "8006"), null)
  assert.equal(setup.heldToken(env, "10.0.0.5", "8007"), null)
  assert.equal(setup.heldToken({ ...env, PROXMOX_TOKEN_SECRET: "" }, "10.0.0.5", "8006"), null)
})
