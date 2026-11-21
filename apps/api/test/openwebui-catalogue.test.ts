// The Open WebUI catalogue entry: the recipe and its compose file, which Ollama it is pointed at (and the offer to install
// one), the setup chores against a fake Open WebUI (key, plug-in, sign-up check, Ollama check), the plug-in's readings and
// its two fixes with their read-backs, and the install wizard end to end on a fake cluster. Names and addresses are made up.
import { test } from "node:test"
import assert from "node:assert/strict"
import yaml from "js-yaml"
import { findRecipe, checkOptions } from "../src/lib/catalogue"
import { OPENWEBUI_RECIPE, OPENWEBUI_COMPOSE, OPENWEBUI_VERSION, OPENWEBUI_OPTIONS, cleanOllamaUrl, checkOpenWebuiOptions } from "../src/lib/openwebui/recipe"
import { openwebuiPreview, askOllama } from "../src/lib/openwebui/preview"
import { runOpenWebuiSetup } from "../src/lib/openwebui/setup"
import { readOverview, runAction, parseAction, problemsOf, OpenWebuiRefusal } from "../src/lib/openwebui/service"
import { openWebuiPlugin, tileOf, detailOf } from "../src/plugins/openwebui"
import { installScript } from "../src/lib/install-script"
import { previewInstall, applyPreview } from "../src/lib/catalogue-installer"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const OWNER = "a@example.com"
const OLLAMA = "http://10.0.0.20:11434"

// ── The recipe ──────────────────────────────────────────────────────────────

test("recipe: a pinned release, sign-up off, API keys on, an admin from the vault, and the words people search for", () => {
  assert.equal(findRecipe("open-webui"), OPENWEBUI_RECIPE)
  assert.match(OPENWEBUI_VERSION, /^v\d+\.\d+\.\d+$/)
  const y: any = yaml.load(OPENWEBUI_COMPOSE)
  const env: string[] = y.services["open-webui"].environment.filter((e: string) => !e.startsWith("#"))
  assert.equal(y.services["open-webui"].image, `ghcr.io/open-webui/open-webui:${OPENWEBUI_VERSION}`)
  for (const e of ["ENABLE_SIGNUP=false", "DEFAULT_USER_ROLE=pending", "ENABLE_API_KEYS=true", "OLLAMA_BASE_URL=${OWUI_OLLAMA_URL}", "WEBUI_ADMIN_PASSWORD=${OWUI_ADMIN_PASSWORD}", "WEBUI_SECRET_KEY=${OWUI_SECRET_KEY}"]) assert.ok(env.includes(e), e)
  assert.doesNotMatch(OPENWEBUI_COMPOSE, /:latest|:main\b/)
  assert.deepEqual(y.services["open-webui"].ports, ["8080:8080"]); assert.deepEqual(y.services["open-webui"].volumes, ["./data:/app/backend/data"])
  assert.equal(OPENWEBUI_RECIPE.category, "ai"); assert.equal(OPENWEBUI_RECIPE.publishable, true)
  assert.ok(OPENWEBUI_RECIPE.keywords!.includes("chatgpt"))
  assert.match(OPENWEBUI_RECIPE.proxyAdvanced!, /proxy_buffering off;/)
  assert.deepEqual(OPENWEBUI_RECIPE.minimum, { cores: 2, memoryMb: 2048, diskGb: 12 })
  const fr: any = OPENWEBUI_RECIPE.firstRun
  assert.deepEqual([fr.kind, fr.passwordEnv, fr.userEnv, fr.secrets[0].vaultKey], ["env-admin", "OWUI_ADMIN_PASSWORD", "OWUI_ADMIN_EMAIL", "secret_key"])
  // Compose reads the values from a private .env the installer writes; the passwords are never in the file's own text.
  const run = installScript(OPENWEBUI_RECIPE, "debian", { OWUI_ADMIN_PASSWORD: "pw-secret-1", OWUI_SECRET_KEY: "sk-secret-1", OWUI_ADMIN_EMAIL: "me@example.com", OWUI_OLLAMA_URL: OLLAMA, OWUI_OLLAMA_ENABLED: "1" })
  assert.match(run, /umask 077\ncat > \.env <<'HP_ENV'\n[\s\S]*OWUI_ADMIN_PASSWORD=pw-secret-1[\s\S]*HP_ENV/)
  assert.ok(!OPENWEBUI_COMPOSE.includes("pw-secret-1"))
  assert.throws(() => installScript(OPENWEBUI_RECIPE, "debian", {}), /needs OWUI_ADMIN_PASSWORD/)
})

test("options: a menu refuses any other answer; the address is checked; the preview's own fields are hidden", () => {
  const v = (o: any = {}) => checkOptions(OPENWEBUI_RECIPE, { OWUI_ADMIN_EMAIL: "me@example.com", ...o })
  assert.deepEqual(v().errors, []); assert.equal(v().values.OWUI_OLLAMA, "auto")
  assert.match(v({ OWUI_OLLAMA: "cloud" }).errors.join(" "), /Which Ollama to use: pick one of/)
  assert.match(v({ OWUI_OLLAMA: "address" }).errors.join(" "), /Give the Ollama's address/)
  assert.match(v({ OWUI_OLLAMA: "address", OWUI_OLLAMA_ADDRESS: "ftp://x" }).errors.join(" "), /http:\/\/ or https:\/\/ address/)
  assert.deepEqual(v({ OWUI_OLLAMA: "address", OWUI_OLLAMA_ADDRESS: OLLAMA }).errors, [])
  assert.equal(cleanOllamaUrl("http://u:p@host:1/"), null); assert.equal(cleanOllamaUrl("http://host:1/api"), null); assert.equal(cleanOllamaUrl("http://host:11434/"), "http://host:11434")
  assert.deepEqual(checkOpenWebuiOptions({ OWUI_OLLAMA: "none" }), [])
  assert.deepEqual(OPENWEBUI_OPTIONS.filter(o => o.hidden).map(o => o.key), ["OWUI_OLLAMA_URL", "OWUI_OLLAMA_ENABLED"])
  assert.deepEqual(OPENWEBUI_OPTIONS.find(o => o.key === "OWUI_OLLAMA_ADDRESS")!.showWhen, { key: "OWUI_OLLAMA", value: "address" })
})

// ── Which Ollama ────────────────────────────────────────────────────────────

const tags = (n: number) => ({ status: 200, headers: {}, body: JSON.stringify({ models: Array.from({ length: n }, (_, i) => ({ name: `m${i}` })) }) })
const ollamaHttp = (up: Record<string, number>) => async (r: any) => {
  const u = new URL(r.url)
  return u.pathname === "/api/tags" && up[u.origin] !== undefined ? tags(up[u.origin]) : { status: 502, headers: {}, body: "" }
}
const vals = (o: any = {}) => checkOptions(OPENWEBUI_RECIPE, { OWUI_ADMIN_EMAIL: "me@example.com", ...o }).values

test("preview: the Ollama HyperProx knows is used when it answers, an address is asked to list its models, and a request's own resolved fields are dropped", async () => {
  const auto = await openwebuiPreview({ ...vals(), OWUI_OLLAMA_URL: "http://evil:1", OWUI_OLLAMA_ENABLED: "1" }, { http: ollamaHttp({ [OLLAMA]: 3 }) as any, knownOllama: async () => OLLAMA + "/" })
  assert.deepEqual(auto.errors, []); assert.deepEqual([auto.options.OWUI_OLLAMA_URL, auto.options.OWUI_OLLAMA_ENABLED, auto.offerOllama], [OLLAMA, "1", false])
  assert.ok(auto.checks.some(c => /lists 3 models/.test(c)))
  const empty = await openwebuiPreview(vals(), { http: ollamaHttp({ [OLLAMA]: 0 }) as any, knownOllama: async () => OLLAMA })
  assert.ok(empty.warnings.some(w => /no models yet/.test(w)))
  const addr = await openwebuiPreview(vals({ OWUI_OLLAMA: "address", OWUI_OLLAMA_ADDRESS: "http://10.0.0.21:11434" }), { http: ollamaHttp({ "http://10.0.0.21:11434": 1 }) as any, knownOllama: async () => OLLAMA })
  assert.equal(addr.options.OWUI_OLLAMA_URL, "http://10.0.0.21:11434")
  const wrong = await openwebuiPreview(vals({ OWUI_OLLAMA: "address", OWUI_OLLAMA_ADDRESS: "http://10.0.0.22:11434" }), { http: ollamaHttp({}) as any, knownOllama: async () => OLLAMA })
  assert.match(wrong.errors.join(" "), /No Ollama answered at http:\/\/10\.0\.0\.22:11434/)
  assert.equal(await askOllama(OLLAMA, (async () => { throw new Error("down") }) as any), null)
})

test("preview: with no Ollama known the install is offered Ollama next, and a known one that is down is said; none starts with the model server off", async () => {
  const none = await openwebuiPreview(vals(), { http: ollamaHttp({}) as any, knownOllama: async () => null })
  assert.deepEqual([none.errors, none.offerOllama, none.options.OWUI_OLLAMA_ENABLED, none.options.OWUI_OLLAMA_URL], [[], true, "0", ""])
  assert.match(none.warnings.join(" "), /does not know an Ollama yet.*offers to install Ollama next/)
  const down = await openwebuiPreview(vals(), { http: ollamaHttp({}) as any, knownOllama: async () => OLLAMA })
  assert.equal(down.offerOllama, true); assert.match(down.warnings.join(" "), /knows an Ollama at .* did not answer/)
  const off = await openwebuiPreview(vals({ OWUI_OLLAMA: "none" }), { http: ollamaHttp({}) as any, knownOllama: async () => OLLAMA })
  assert.deepEqual([off.offerOllama, off.options.OWUI_OLLAMA_ENABLED], [false, "0"])
  for (const r of [none, down, off]) assert.ok(r.checks.some(c => /Open sign-up is off/.test(c)))
})

// ── A fake Open WebUI ───────────────────────────────────────────────────────

class FakeWebui {
  pw: string | null = "pw-1"; signup = false; ollamaEnabled = true; urls: string[] = [OLLAMA]; ollamaUp = true; keepConfig = true; signinFailsFor = 0
  models = [{ name: "llama3:8b", size: 5 * 1024 ** 3 }, { name: "tiny:1b", size: 700 * 1024 ** 2 }]
  posts: Array<{ path: string; body: any }> = []; order: string[] = []; signins = 0; version = "0.13.4"; adminConfigPosts = 0
  http = async (r: any) => {
    const u = new URL(r.url), p = u.pathname, auth = r.headers?.authorization
    const ok = (body: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) })
    this.order.push(`${r.method} ${p}`)
    if (p === "/health") return ok({ status: true })
    if (p === "/api/v1/auths/signin") { this.signins++; return this.signins <= this.signinFailsFor || (this.pw !== null && r.json.password !== this.pw) ? ok({}, 400) : ok({ token: "jwt-1" }) }
    if (p === "/api/v1/auths/api_key") return auth === "Bearer jwt-1" ? ok({ api_key: "sk-key-1" }) : ok({}, 401)
    if (auth !== "Bearer sk-key-1") return ok({}, 401)
    if (p === "/api/v1/auths/admin/config" && r.method === "GET") return ok({ ENABLE_SIGNUP: this.signup, DEFAULT_USER_ROLE: "pending", WEBUI_URL: "x" })
    if (p === "/api/v1/auths/admin/config" && r.method === "POST") { this.adminConfigPosts++; if (this.keepConfig) this.signup = r.json.ENABLE_SIGNUP; this.posts.push({ path: p, body: r.json }); return ok(r.json) }
    if (p === "/api/version") return ok({ version: this.version })
    if (p === "/ollama/config" && r.method === "GET") return ok({ ENABLE_OLLAMA_API: this.ollamaEnabled, OLLAMA_BASE_URLS: this.urls, OLLAMA_API_CONFIGS: {} })
    if (p === "/ollama/config/update") { this.posts.push({ path: p, body: r.json }); if (this.keepConfig) { this.ollamaEnabled = r.json.ENABLE_OLLAMA_API; this.urls = r.json.OLLAMA_BASE_URLS } return ok(r.json) }
    if (p === "/ollama/verify") return (r.json.url === OLLAMA && this.ollamaUp) || (r.json.url === this.urls[0] && this.ollamaUp) ? ok({ ok: true }) : ok({ detail: "cannot connect" }, 500)
    if (p === "/ollama/api/tags") return ok({ models: this.ollamaEnabled && this.ollamaUp ? this.models : [] })
    return ok({}, 404)
  }
}
const steps = () => { const m: Record<string, any> = {}; return { step: (id: string) => (m[id] ??= { status: "running" }), m } }
const sdeps = (f: FakeWebui, store: { vault: any[]; plugin: Record<string, Record<string, string>> }) => ({
  http: f.http as any, wait: async () => {},
  saveSecrets: async (c: string, p: string, v: Record<string, string>) => { f.order.push("vault"); store.vault.push([c, p, v]) },
  savePluginSettings: async (id: string, v: Record<string, string>) => { f.order.push("plugin"); store.plugin[id] = v },
  pluginSettings: async (id: string) => store.plugin[id] ?? {},
})
const input = (o: any = {}) => ({ ip: "10.0.0.51", admin: { email: "me@example.com", password: "pw-1" }, ollama: true, vault: { category: "apps", provider: "open-webui-911" }, ...o })

test("setup: signs in once, makes the key, keeps it in the vault before the plug-in has it, proves it, checks sign-up is off and the Ollama answers", async () => {
  const f = new FakeWebui(); f.signinFailsFor = 2; const store = { vault: [] as any[], plugin: {} as any }; const s = steps()
  const out = await runOpenWebuiSetup(input(), s.step, sdeps(f, store))
  assert.deepEqual(out, { url: "http://10.0.0.51:8080", models: 2, connected: true })
  assert.deepEqual(store.vault, [["apps", "open-webui-911", { api_key: "sk-key-1" }]])
  assert.deepEqual(store.plugin.openwebui, { url: "http://10.0.0.51:8080", token: "sk-key-1" })
  assert.ok(f.order.indexOf("vault") < f.order.indexOf("plugin"))
  assert.deepEqual(Object.values(s.m).map((x: any) => x.status), ["done", "done", "done", "done"])
  assert.match(s.m["owui-ollama"].detail, /lists 2 models/)
  assert.doesNotMatch(JSON.stringify(s.m), /sk-key-1|jwt-1|pw-1/)
})

test("setup: open sign-up is an error, a missing Ollama is said and not fatal, a refused sign-in or key stops it, and another connected Open WebUI is left alone", async () => {
  const open = new FakeWebui(); open.signup = true
  await assert.rejects(runOpenWebuiSetup(input(), steps().step, sdeps(open, { vault: [], plugin: {} })), /Open sign-up is still on/)
  const down = new FakeWebui(); down.ollamaUp = false; const s = steps()
  const out = await runOpenWebuiSetup(input(), s.step, sdeps(down, { vault: [], plugin: {} }))
  assert.equal(out.models, 0)
  const tagsDown = new FakeWebui(); const real = tagsDown.http
  tagsDown.http = (async (r: any) => r.url.endsWith("/ollama/api/tags") ? { status: 500, headers: {}, body: "" } : real(r)) as any
  const s2 = steps(); await runOpenWebuiSetup(input(), s2.step, sdeps(tagsDown, { vault: [], plugin: {} }))
  assert.equal(s2.m["owui-ollama"].status, "failed"); assert.match(s2.m["owui-ollama"].detail, /Reconnect/)
  const no = steps(); await runOpenWebuiSetup(input({ ollama: false }), no.step, sdeps(new FakeWebui(), { vault: [], plugin: {} }))
  assert.equal(no.m["owui-ollama"].status, "skipped")
  const bad = new FakeWebui(); bad.signinFailsFor = 1000
  await assert.rejects(runOpenWebuiSetup(input(), steps().step, sdeps(bad, { vault: [], plugin: {} })), /could not sign in \(it answered 400\)/)
  const mine = { vault: [] as any[], plugin: { openwebui: { url: "http://10.0.0.9:8080", token: "old" } } as any }
  const st = steps()
  assert.equal((await runOpenWebuiSetup(input(), st.step, sdeps(new FakeWebui(), mine))).connected, false)
  assert.deepEqual(mine.plugin.openwebui, { url: "http://10.0.0.9:8080", token: "old" }); assert.equal(mine.vault[0][2].api_key, "sk-key-1")
  assert.match(st.m["owui-key"].detail, /already follows another Open WebUI/)
})

// ── The plug-in's readings and fixes ────────────────────────────────────────

const client = (f: FakeWebui) => ({
  get: (p: string) => f.http({ method: "GET", url: `http://x${p}`, headers: { authorization: "Bearer sk-key-1" } }).then(r => { if (r.status >= 400) throw new Error(`HTTP ${r.status}`); return JSON.parse(r.body) }),
  post: (p: string, body: any) => f.http({ method: "POST", url: `http://x${p}`, headers: { authorization: "Bearer sk-key-1" }, json: body }).then(r => { if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${r.body}`); return JSON.parse(r.body) }),
})

test("overview: the models, the Ollama and whether it answers, sign-up, and each problem with its fix only when HyperProx knows an Ollama", async () => {
  const f = new FakeWebui()
  const ok = await readOverview(client(f), OLLAMA)
  assert.deepEqual([ok.version, ok.models.length, ok.ollama.answering, ok.signupOpen, ok.problems.length], ["0.13.4", 2, true, false, 0])
  assert.equal((ok.ollama as any).urls, undefined, "the Ollama's address does not reach the browser"); assert.equal(ok.ollama.connected, true)
  assert.doesNotMatch(JSON.stringify(ok), /10\.0\.0\./)
  f.ollamaUp = false; f.signup = true
  const bad = await readOverview(client(f), OLLAMA)
  assert.deepEqual(bad.problems.map(p => p.id), ["ollama-down", "signup-open"])
  assert.equal(bad.problems[0].fix!.action, "reconnect-ollama"); assert.equal(bad.problems[1].fix!.action, "close-signup")
  assert.equal((await readOverview(client(f), null)).problems[0].fix, null, "nothing to reconnect to")
  f.ollamaEnabled = false
  assert.equal((await readOverview(client(f), OLLAMA)).problems.find(p => p.id === "ollama-off")!.fix!.action, "reconnect-ollama")
  assert.equal(problemsOf({ ollama: { enabled: true, urls: ["http://other:11434"], answering: true, error: null }, signupOpen: false }, OLLAMA)[0].id, "ollama-other")
  await assert.rejects(readOverview({ get: async () => { throw new Error("down") }, post: async () => { throw new Error("down") } }), /did not answer/)
})

test("plug-in: its card and details carry counts and model names, and its key goes in the Authorization header", async () => {
  const o = await readOverview(client(new FakeWebui()), OLLAMA)
  assert.equal(tileOf(o).headline, "2 models available"); assert.equal(tileOf(o).tone, "good")
  assert.equal(detailOf(o).tables![0].rows[0].name, "llama3:8b")
  assert.deepEqual(openWebuiPlugin.manifest.auth, { kind: "header", header: "Authorization", fromSetting: "token", prefix: "Bearer " })
  assert.equal(openWebuiPlugin.manifest.settings.find(x => x.key === "token")!.type, "secret")
  const f = new FakeWebui(); f.ollamaUp = false
  assert.equal(tileOf(await readOverview(client(f), OLLAMA)).tone, "bad")
  const sum = await openWebuiPlugin.summary!({ get: (p: string) => client(new FakeWebui()).get(p), post: (p: string, b: any) => client(new FakeWebui()).post(p, b), option: () => undefined, from() { return this }, has: () => true } as any)
  assert.match(sum.lines.join(" "), /llama3:8b/)
})

test("fixes: reconnect checks the address from Open WebUI first, audits, saves, and reads back; closing sign-up reads the settings, changes one field and reads back", async () => {
  const f = new FakeWebui(); f.urls = ["http://10.0.0.99:11434"]; f.ollamaEnabled = false
  const audits: any[] = []
  const d = { client: client(f), known: async () => OLLAMA, audit: async (a: string, x: any) => { audits.push([a, x]); f.order.push("AUDIT") } }
  const r = await runAction({ action: "reconnect-ollama" }, "admin@example.com", d)
  assert.match(r.message, /connected to the Ollama HyperProx knows and lists 2 models/)
  assert.deepEqual(f.posts[0], { path: "/ollama/config/update", body: { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: [OLLAMA], OLLAMA_API_CONFIGS: {} } })
  assert.ok(f.order.indexOf("POST /ollama/verify") < f.order.indexOf("AUDIT") && f.order.indexOf("AUDIT") < f.order.indexOf("POST /ollama/config/update"), "checked, then audited, then changed")
  assert.deepEqual(audits[0], ["openwebui.reconnect-ollama", { by: "admin@example.com", target: OLLAMA }])
  // An Ollama Open WebUI cannot reach is never saved.
  const dead = new FakeWebui(); dead.ollamaUp = false; dead.urls = []; dead.ollamaEnabled = false
  await assert.rejects(runAction({ action: "reconnect-ollama" }, "a", { ...d, client: client(dead) }), (e: any) => e instanceof OpenWebuiRefusal && e.code === "unreachable")
  assert.equal(dead.posts.length, 0)
  await assert.rejects(runAction({ action: "reconnect-ollama" }, "a", { ...d, known: async () => null }), (e: any) => e.code === "no_ollama")
  // A save Open WebUI does not keep is an error.
  const lying = new FakeWebui(); lying.keepConfig = false; lying.urls = []; lying.ollamaEnabled = false
  await assert.rejects(runAction({ action: "reconnect-ollama" }, "a", { ...d, client: client(lying) }), (e: any) => e.code === "not_applied")
  const s = new FakeWebui(); s.signup = true
  const closed = await runAction({ action: "close-signup" }, "a", { ...d, client: client(s) })
  assert.match(closed.message, /sign-up is off/); assert.equal(s.signup, false)
  assert.deepEqual(s.posts[0].body, { ENABLE_SIGNUP: false, DEFAULT_USER_ROLE: "pending", WEBUI_URL: "x" }, "every other setting is sent back as it was")
  const keep = new FakeWebui(); keep.signup = true; keep.keepConfig = false
  await assert.rejects(runAction({ action: "close-signup" }, "a", { ...d, client: client(keep) }), (e: any) => e.code === "not_applied")
  const g = new FakeWebui(); g.signup = true
  await assert.rejects(runAction({ action: "close-signup" }, "a", { ...d, client: client(g), audit: async () => { throw new Error("audit down") } }), /audit down/)
  assert.equal(g.adminConfigPosts, 0, "nothing changed when the audit failed")
  for (const bad of [null, {}, { action: "delete-everything" }, "x"]) assert.throws(() => parseAction(bad), (e: any) => e instanceof OpenWebuiRefusal && e.code === "bad_request")
})

// ── The wizard, end to end on a fake cluster ────────────────────────────────

function wizard(known: string | null = OLLAMA, up: Record<string, number> = { [OLLAMA]: 2 }) {
  const pve = new FakePve(); const f = new FakeWebui(); f.pw = null; const store = { vault: [] as any[], plugin: {} as Record<string, Record<string, string>> }
  const scripts: string[] = []; const vault = new Map<string, Record<string, string>>()
  const d = deps(pve, {
    arr: () => ({ http: (async (r: any) => (new URL(r.url).port === "8080" ? f.http(r) : ollamaHttp(up)(r))) as any, nodeRun: async () => ({ code: 0, output: "" }),
      pluginSettings: async (id: string) => store.plugin[id] ?? {}, savePluginSettings: async (id: string, v: any) => { store.plugin[id] = v }, localAddressTo: async () => null, mediaServer: async () => null }) as any,
    knownOllama: async () => known,
    exec: async (o: any) => { scripts.push(o.script); return { code: 0, output: "", timedOut: false } as any },
    saveSecrets: async (c: string, p: string, v: Record<string, string>) => { vault.set(`${c}/${p}`, { ...(vault.get(`${c}/${p}`) ?? {}), ...v }) },
    readSecrets: async (c: string, p: string) => vault.get(`${c}/${p}`) ?? {}, deleteSecrets: async (c: string, p: string) => { vault.delete(`${c}/${p}`) },
    probe: async () => ({ status: 200, body: "{}" }),
  })
  return { pve, f, store, scripts, vault, d }
}
const base = (o: any = {}) => ({ ...INPUT({ recipeId: "open-webui", hostname: "chat", vmid: 911, cores: 2, memoryMb: 4096, diskGb: 20, ip: "192.0.2.61/24" }), options: { OWUI_ADMIN_EMAIL: "me@example.com", ...o }}) as any

test("wizard: installs in an unprivileged container with the known Ollama, the generated password only in the vault and the private .env, and the plug-in connected", async () => {
  const w = wizard()
  const r = await previewInstall(base(), OWNER, w.d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  assert.equal(r.preview!.plan.options!.OWUI_OLLAMA_URL, OLLAMA); assert.equal(r.preview!.plan.offerOllama, undefined)
  const job = await settled((await applyPreview(r.preview!.id, OWNER, w.d)).jobId)
  assert.equal(job.status, "completed", `${job.error} ${JSON.stringify(job.steps.filter(x => x.status !== "done"))}`)
  assert.equal(w.pve.creates[0].body.get("unprivileged"), "1"); assert.equal(w.pve.creates[0].body.get("features"), "nesting=1")
  const item = w.vault.get("apps/open-webui-911")!
  assert.deepEqual(Object.keys(item).sort(), ["admin_password", "admin_user", "api_key", "secret_key"])
  const script = w.scripts.find(s => s.includes("HP_ENV"))!
  assert.ok(script.includes(`OWUI_ADMIN_PASSWORD=${item.admin_password}`) && script.includes(`OWUI_OLLAMA_URL=${OLLAMA}`) && script.includes("OWUI_OLLAMA_ENABLED=1"))
  assert.deepEqual(w.store.plugin.openwebui, { url: "http://192.0.2.61:8080", token: "sk-key-1" })
  assert.deepEqual(job.connected, { plugin: "openwebui" })
  assert.equal(job.tcFollowUp, undefined)
  assert.ok(!JSON.stringify(job).includes(item.admin_password) && !JSON.stringify(job).includes("sk-key-1"))
})

test("wizard: with no Ollama the install still completes and offers to install Ollama next; sign-up left open fails it", async () => {
  const w = wizard(null)
  const r = await previewInstall(base(), OWNER, w.d)
  assert.deepEqual(r.errors, []); assert.equal(r.preview!.plan.offerOllama, true)
  const job = await settled((await applyPreview(r.preview!.id, OWNER, w.d)).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.deepEqual(job.tcFollowUp, { recipeId: "ollama", label: "Install Ollama next", url: "", options: {} })
  assert.equal(job.steps.find(s => s.id === "owui-ollama")!.status, "skipped")
  const open = wizard(); open.f.signup = true
  const r2 = await previewInstall(base(), OWNER, open.d)
  const j2 = await settled((await applyPreview(r2.preview!.id, OWNER, open.d)).jobId)
  assert.equal(j2.status, "failed"); assert.match(j2.error!, /Open sign-up is still on/)
})

test("wizard: a vault that is locked refuses the plan; an Ollama address that does not answer refuses it", async () => {
  const w = wizard()
  assert.match((await previewInstall(base(), OWNER, { ...w.d, vaultOpen: async () => false })).errors.join(" "), /vault is locked/)
  const bad = await previewInstall(base({ OWUI_OLLAMA: "address", OWUI_OLLAMA_ADDRESS: "http://10.0.0.77:11434" }), OWNER, w.d)
  assert.match(bad.errors.join(" "), /No Ollama answered/)
  assert.equal(w.pve.creates.length, 0)
})
