// The Immich and Open WebUI plug-in routes through the real gate and auth: who may read the overview, that a fix is an
// admin's act confirmed on the page and never an API token's, that the confirmation is bound to the exact request and the
// audit row is written before anything runs, and that no key or address reaches the browser. Fake plug-in clients stand in
// for the two services. Names and addresses are made up.
import { test, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeBroker } from "./fakes/fake-broker"
import { resetLock, signIn } from "./fakes/app"
import { registerGate } from "../src/lib/gate"
import { authRoutes } from "../src/routes/auth"
import { buildImmichRoutes } from "../src/routes/immich"
import { buildOpenWebuiRoutes } from "../src/routes/openwebui"
import { setBroker } from "../src/lib/vault/broker"
import { setCredentialTable } from "../src/lib/credentials"
import { setAuditSink, auditOrThrow } from "../src/lib/audit"
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from "../src/lib/api-tokens"
import { requiredRole, needsConfirm, needsPassword } from "../src/lib/roles"
import { describeAction } from "../src/lib/confirm-text"
import { clearConfirms } from "../src/lib/confirm"

const ADMIN = "admin@example.com", ADMIN_PW = "admin master password"
const OPERATOR = "operator@example.com", OPERATOR_PW = "operator master password"
const VIEWER = "viewer@example.com", VIEWER_PW = "viewer master password"
const broker = new FakeBroker()
broker.addUser(ADMIN, ADMIN_PW, "admin"); broker.addUser(OPERATOR, OPERATOR_PW, "operator"); broker.addUser(VIEWER, VIEWER_PW, "viewer")

const events: string[] = []
let auditFails = false

// An Immich with one queue holding failed jobs; an Open WebUI with sign-up open.
const immich = { failed: 3, paused: false, puts: [] as string[] }
const owui = { signup: true, posts: [] as string[] }
const immichClient = async () => ({
  get: async (p: string) => {
    if (p === "/api/server/statistics") return { photos: 10, videos: 2, usage: 1024, usagePhotos: 900, usageVideos: 124, usageByUser: [{ userName: "Ana", photos: 10, videos: 2, usage: 1024 }] }
    if (p === "/api/server/version") return { major: 3, minor: 4, patch: 2, prerelease: null }
    if (p === "/api/server/version-check") return { checkedAt: null, releaseVersion: null }
    if (p === "/api/queues") return [{ name: "videoConversion", isPaused: false, statistics: { active: 0, waiting: 0, failed: immich.failed, delayed: 0 } }]
    if (p === "/api/queues/videoConversion") return { name: "videoConversion", isPaused: false, statistics: { active: 0, waiting: 0, failed: immich.failed, delayed: 0 } }
    throw new Error("unexpected " + p)
  },
  put: async (p: string, body: any) => { events.push(`immich ${p} ${JSON.stringify(body)}`); if (body.command === "clear-failed") immich.failed = 0; return {} },
})
const owuiClient = async () => ({
  get: async (p: string) => {
    if (p === "/api/version") return { version: "0.13.4" }
    if (p === "/ollama/config") return { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ["http://10.0.0.20:11434"] }
    if (p === "/ollama/api/tags") return { models: [{ name: "llama3:8b", size: 5e9 }] }
    if (p === "/api/v1/auths/admin/config") return { ENABLE_SIGNUP: owui.signup, WEBUI_URL: "x" }
    throw new Error("unexpected " + p)
  },
  post: async (p: string, body: any) => { events.push(`owui ${p}`); if (p === "/api/v1/auths/admin/config") owui.signup = body.ENABLE_SIGNUP; return {} },
})

async function build(): Promise<FastifyInstance> {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = "/nonexistent/hyperprox-test.env"
  const app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: "/api/auth" })
  const audit = (a: string, d: Record<string, unknown>) => auditOrThrow(a, "plugin:test", d)
  await app.register(buildImmichRoutes({ client: immichClient as any, audit, wait: async () => {} }), { prefix: "/api/plugins/immich" })
  await app.register(buildOpenWebuiRoutes({ client: owuiClient as any, known: async () => "http://10.0.0.20:11434", audit }), { prefix: "/api/plugins/openwebui" })
  await app.ready()
  return app
}
const appP = build()
let tokens: MemoryApiTokenStore
beforeEach(async () => {
  await resetLock(); clearConfirms(); events.length = 0; auditFails = false
  immich.failed = 3; owui.signup = true
  tokens = new MemoryApiTokenStore(); setApiTokenStore(tokens)
  setAuditSink({ async write(r) { if (auditFails) throw new Error("database down"); events.push(`audit ${r.action}`) } })
})
after(async () => { await resetLock(); setApiTokenStore(null); setAuditSink(null); await (await appP).close() })
const cookieFor = async (email: string, pw: string) => { const r = await signIn(await appP, email, pw); assert.equal(r.res.statusCode, 200, r.res.body); return r.cookie }

const FIX = "/api/plugins/immich/actions", OVERVIEW = "/api/plugins/immich/overview"
const OFIX = "/api/plugins/openwebui/actions", OOVERVIEW = "/api/plugins/openwebui/overview"

test("rules: the overview and every fix are an admin's; each fix is confirmed on the page, never with the master password; a token is refused both", () => {
  for (const id of ["immich", "openwebui"]) {
    assert.equal(requiredRole("GET", `/api/plugins/${id}/overview`), "admin", "the overview names users, so it is admin")
    assert.equal(requiredRole("POST", `/api/plugins/${id}/actions`), "admin")
    assert.equal(needsConfirm("POST", `/api/plugins/${id}/actions`), true)
    assert.equal(needsPassword("POST", `/api/plugins/${id}/actions`), false)
    assert.equal(needsConfirm("GET", `/api/plugins/${id}/overview`), false, "reads are never confirmed")
    assert.equal(tokenForbidden("POST", `/api/plugins/${id}/actions`), true)
    assert.equal(tokenForbidden("GET", `/api/plugins/${id}/overview`), true, "a token cannot read the page that names users")
    assert.equal(requiredRole("GET", `/api/plugins/${id}/data`) !== "admin", true, "the gallery card stays a viewer read")
  }
  assert.equal(describeAction("POST", FIX, FIX, {}, { action: "clear-failed", queue: "videoConversion" }),
    "Clear Immich's failed jobs on the videoConversion queue? Only the failed entries are removed; no photo or video is changed.")
  assert.match(describeAction("POST", FIX, FIX, {}, { action: "restart-queue", queue: "search" }), /^Restart the Immich job queue on the search queue\?/)
  assert.match(describeAction("POST", FIX, FIX, {}, { action: "resume-queue", queue: "../../etc" }), /^Resume the Immich job queue\? Its waiting/, "a queue name that is not a plain name is not echoed")
  assert.match(describeAction("POST", OFIX, OFIX, {}, { action: "close-signup" }), /^Turn off open sign-up in Open WebUI\?/)
  assert.match(describeAction("POST", OFIX, OFIX, {}, { action: "reconnect-ollama" }), /Ollama HyperProx knows/)
})

test("overview: a viewer and an operator are refused, an admin reads it, and nothing in it holds a key or an address", async () => {
  const app = await appP
  for (const [url, label] of [[OVERVIEW, "immich"], [OOVERVIEW, "openwebui"]] as const) {
    assert.ok([401, 423].includes((await app.inject({ method: "GET", url })).statusCode), `${label}: no session is refused (signed out, or HyperProx locked)`)
    for (const [e, pw] of [[VIEWER, VIEWER_PW], [OPERATOR, OPERATOR_PW]]) assert.equal((await app.inject({ method: "GET", url, headers: { cookie: await cookieFor(e, pw) } })).statusCode, 403, `${label}: ${e}`)
    const ok = await app.inject({ method: "GET", url, headers: { cookie: await cookieFor(ADMIN, ADMIN_PW) } })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.doesNotMatch(ok.body, /x-api-key|Bearer|sk-|10\.0\.0\.|http:\/\//, `${label}: no key or address`)
  }
  const o = (await app.inject({ method: "GET", url: OVERVIEW, headers: { cookie: await cookieFor(ADMIN, ADMIN_PW) } })).json().data
  assert.deepEqual([o.photos, o.users[0].name, o.problems[0].fix.action], [10, "Ana", "clear-failed"])
  const w = (await app.inject({ method: "GET", url: OOVERVIEW, headers: { cookie: await cookieFor(ADMIN, ADMIN_PW) } })).json().data
  assert.deepEqual([w.version, w.models[0].name, w.signupOpen, w.problems[0].fix.action], ["0.13.4", "llama3:8b", true, "close-signup"])
})

test("an API token, even an admin's, can neither read the overview nor run a fix, and is handed no confirmation", async () => {
  const app = await appP
  await cookieFor(ADMIN, ADMIN_PW)
  const { token } = await createApiToken({ name: "auto", role: "admin" }, "test", tokens)
  for (const [method, url, payload] of [["GET", OVERVIEW], ["GET", OOVERVIEW], ["POST", FIX, { action: "clear-failed", queue: "videoConversion" }], ["POST", OFIX, { action: "close-signup" }]] as const) {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any })
    assert.equal(r.statusCode, 403, `${method} ${url}`); assert.equal(r.json().code, "token_forbidden"); assert.equal(r.json().confirm, undefined)
  }
  // A confirmation a person was given does not help a token.
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const t = (await app.inject({ method: "POST", url: FIX, headers: { cookie }, payload: { action: "clear-failed", queue: "videoConversion" } })).json().confirm.token
  const r = await app.inject({ method: "POST", url: FIX, headers: { authorization: `Bearer ${token}`, "x-hyperprox-confirm": t }, payload: { action: "clear-failed", queue: "videoConversion" } })
  assert.equal(r.json().code, "token_forbidden")
  assert.deepEqual(events.filter(e => !e.startsWith("audit security.")), [], "nothing ran")
  assert.equal(immich.failed, 3); assert.equal(owui.signup, true)
})

test("an Immich fix: asked once, the page gets a plain sentence and nothing has run; confirmed, the confirmation is audited, then the fix is audited, then it runs, and it cannot be replayed or bent", async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const body = { action: "clear-failed", queue: "videoConversion" }
  const first = await app.inject({ method: "POST", url: FIX, headers: { cookie }, payload: body })
  assert.equal(first.statusCode, 403); assert.equal(first.json().code, "confirm_required")
  assert.match(first.json().confirm.summary, /^Clear Immich's failed jobs on the videoConversion queue\?/)
  assert.deepEqual(events, [])
  // Bound to the exact body: another queue or action cannot use it.
  const other = await app.inject({ method: "POST", url: FIX, headers: { cookie, "x-hyperprox-confirm": first.json().confirm.token }, payload: { action: "restart-queue", queue: "videoConversion" } })
  assert.equal(other.json().code, "confirm_required"); assert.equal(immich.failed, 3)
  const t = (await app.inject({ method: "POST", url: FIX, headers: { cookie }, payload: body })).json().confirm.token
  const ok = await app.inject({ method: "POST", url: FIX, headers: { cookie, "x-hyperprox-confirm": t }, payload: body })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(events, ["audit action.confirmed", "audit immich.clear-failed", 'immich /api/jobs/videoConversion {"command":"clear-failed"}'])
  assert.match(ok.json().data.message, /Cleared 3 failed jobs/)
  assert.equal((await app.inject({ method: "POST", url: FIX, headers: { cookie, "x-hyperprox-confirm": t }, payload: body })).statusCode, 403, "single use")
})

test("an Immich fix with a bad body is refused in plain words after the confirmation, and when the audit cannot be written nothing is changed", async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const confirmed = async (payload: unknown) => {
    const t = (await app.inject({ method: "POST", url: FIX, headers: { cookie }, payload: payload as any })).json().confirm.token
    return app.inject({ method: "POST", url: FIX, headers: { cookie, "x-hyperprox-confirm": t }, payload: payload as any })
  }
  for (const bad of [{ action: "delete-everything", queue: "search" }, { action: "clear-failed", queue: "../x" }, { action: "clear-failed" }]) {
    const r = await confirmed(bad)
    assert.equal(r.statusCode, 400, JSON.stringify(bad)); assert.equal(r.json().code, "bad_request")
  }
  assert.equal(immich.failed, 3)
  events.length = 0; auditFails = true
  const t = (await app.inject({ method: "POST", url: FIX, headers: { cookie }, payload: { action: "clear-failed", queue: "videoConversion" } })).json().confirm.token
  const r = await app.inject({ method: "POST", url: FIX, headers: { cookie, "x-hyperprox-confirm": t }, payload: { action: "clear-failed", queue: "videoConversion" } })
  assert.equal(r.statusCode, 503); assert.equal(r.json().code, "audit_unavailable")
  assert.equal(immich.failed, 3); assert.deepEqual(events, [])
})

test("an Open WebUI fix: confirmed on the page, audited before it runs, and read back", async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const first = await app.inject({ method: "POST", url: OFIX, headers: { cookie }, payload: { action: "close-signup" } })
  assert.equal(first.json().code, "confirm_required"); assert.equal(owui.signup, true)
  const ok = await app.inject({ method: "POST", url: OFIX, headers: { cookie, "x-hyperprox-confirm": first.json().confirm.token }, payload: { action: "close-signup" } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(events.slice(0, 3), ["audit action.confirmed", "audit openwebui.close-signup", "owui /api/v1/auths/admin/config"])
  assert.equal(owui.signup, false); assert.equal(ok.json().data.overview.signupOpen, false)
  const bad = await app.inject({ method: "POST", url: OFIX, headers: { cookie }, payload: { action: "reconnect-ollama" } })
  const r = await app.inject({ method: "POST", url: OFIX, headers: { cookie, "x-hyperprox-confirm": bad.json().confirm.token }, payload: { action: "reconnect-ollama" } })
  assert.equal(r.statusCode, 200, r.body); assert.match(r.json().data.message, /connected to the Ollama HyperProx knows/)
})

test("a plug-in that is not connected answers in plain words, not with a failure", async () => {
  const app = Fastify({ logger: false }); await registerGate(app); await app.register(authRoutes, { prefix: "/api/auth" })
  await app.register(buildImmichRoutes({ client: async () => null }), { prefix: "/api/plugins/immich" })
  await app.ready()
  const cookie = (await signIn(app, ADMIN, ADMIN_PW)).cookie
  const r = await app.inject({ method: "GET", url: OVERVIEW, headers: { cookie } })
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "not_connected"); assert.match(r.json().error, /Install it from the Catalogue/)
  await app.close()
})
