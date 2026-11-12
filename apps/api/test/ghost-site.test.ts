// Ghost as a website: the recipe and its checks, the compose file and settings it writes, the first run through
// Ghost's own setup API (in order, each step read back), the failure path that never leaves setup open, detection
// and adoption, the Sites card, and secrets that never reach a log, a message or a command line.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { CATALOGUE, findRecipe, checkOptions, healthProblem, wizardRecipes } from "../src/lib/catalogue"
import { installScript, manualCommands } from "../src/lib/install-script"
import {
  GHOST_IMAGE, MYSQL_IMAGE, GHOST_SCRIPT, GHOST_NGINX, GHOST_HOLDING_NGINX, GHOST_OPEN_SCRIPT, SETUP_LOCATION_RE, NO_MAIL,
  ghostCompose, ghostEnvFile, checkGhostOptions,
} from "../src/lib/ghost/recipe"
import {
  runGhostSetup, requestScript, parseAnswer, ghostOverShell, adminToken, ghostPreview, ghostInstallEnv, pendingSmtpItem,
  SETUP, SETUP_VARIANTS, openReadbackScript, parseOpenReadback, type GhostHttp, type GhostRequest, type StepRef,
} from "../src/lib/ghost/setup"
import { ghostStats, clearGhostStatsCache } from "../src/lib/ghost/stats"
import { DETECT } from "../src/lib/catalogue-detect"
import { LOG_FORMAT_LINE } from "../src/lib/site-metrics/log-format"
import { parseDiscover, inspectFor, buildCandidates } from "../src/lib/site-metrics/discovery"
import { kindOf } from "../src/lib/site-metrics/collector"
import { checkAdoptInput } from "../src/routes/site-metrics"
import { adminUrlOf } from "../src/routes/sites"
import { previewInstall, applyPreview } from "../src/lib/catalogue-installer"
import { listSites, type PublishDeps } from "../src/lib/sites"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const KEY_ID = "0123456789abcdef01234567"
const KEY_SECRET = "f".repeat(16) + "e".repeat(16) + "d".repeat(16) + "c".repeat(16)
const KEY = `${KEY_ID}:${KEY_SECRET}`
const OWNER_PW = "OWNERsecretPW123456"
const COOKIE = "ghost-admin-api-session=s%3AsessionSECRETvalue.abcdef"

// ── Recipe ──────────────────────────────────────────────────────────────────

test("recipe: a first-class website next to WordPress, sized like it, env-admin with both database passwords, never for the AI", () => {
  assert.deepEqual(CATALOGUE.filter(r => r.category === "web").map(r => r.id), ["static-site", "wordpress", "ghost"])
  const g = findRecipe("ghost")!
  assert.equal(g.name, "Ghost")
  assert.equal(g.port, 80, "the site's nginx answers, never Ghost itself")
  assert.equal(g.setup, "ghost")
  assert.equal(g.needsDocker, true)
  assert.deepEqual(g.defaults, { cores: 2, memoryMb: 2048, diskGb: 10, swapMb: 512 })
  assert.deepEqual(g.sizes!.medium, { cores: 2, memoryMb: 2048, diskGb: 10 })
  assert.ok(g.sizes!.small.memoryMb >= g.minimum.memoryMb)
  assert.deepEqual(g.firstRun, { kind: "env-admin", passwordEnv: "GHOST_ADMIN_PASSWORD", user: "owner", userOption: "GHOST_OWNER_EMAIL",
    secrets: [{ env: "GHOST_DB_PASSWORD", vaultKey: "db_password" }, { env: "GHOST_DB_ROOT_PASSWORD", vaultKey: "db_root_password" }] })
  assert.ok(!wizardRecipes().includes(g))
  assert.ok(g.detect?.length)
  assert.ok(g.notes!.some(n => /^Not automatic yet: a backup job/.test(n)))
  assert.ok(g.notes!.some(n => n.includes(GHOST_IMAGE.split(/[:@]/)[1]) && n.includes(MYSQL_IMAGE.split(/[:@]/)[1]) && /digest/.test(n)))
  assert.match(g.firstLogin!, /\/ghost/)
})

test("health: Ghost's site JSON with a version, never an error page or nginx's own 403", () => {
  const g = findRecipe("ghost")!
  assert.equal(g.healthPath, "/ghost/api/admin/site/")
  assert.equal(healthProblem(g, 200, '{"site":{"title":"x","url":"https://blog.example.com/","version":"6.77"}}'), null)
  assert.match(healthProblem(g, 200, "<html>502 Bad Gateway</html>")!, /does not contain/)
  assert.match(healthProblem(g, 502, "")!, /answered 502/)
})

test("options: owner and title required; SMTP host, user and sender checked; the SMTP reference is never the request's", async () => {
  const g = findRecipe("ghost")!
  assert.match(checkOptions(g, {}).errors.join(" | "), /Owner name is required.*Owner email is required/)
  const base = { GHOST_TITLE: "News", GHOST_OWNER_NAME: "Alex", GHOST_OWNER_EMAIL: "alex@example.com" }
  const ok = checkOptions(g, base)
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.values.GHOST_SMTP_PORT, "587")
  assert.equal(ok.values.GHOST_SMTP_SECURE, "0")
  const bad = (o: Record<string, unknown>, re: RegExp) => assert.match(checkOptions(g, { ...base, ...o }).errors.join(" | "), re)
  bad({ GHOST_SMTP_HOST: "smtp.example.com; reboot" }, /host name/)
  bad({ GHOST_SMTP_HOST: "smtp.example.com", GHOST_SMTP_USER: "a b" }, /SMTP user/)
  bad({ GHOST_SMTP_USER: "apikey" }, /needs an SMTP server/)
  bad({ GHOST_SMTP_FROM: "news@example.com" }, /needs an SMTP server/)
  bad({ GHOST_SMTP_PORT: "70000" }, /between 1 and 65535/)
  bad({ GHOST_OWNER_NAME: "<script>" }, /no < or >/)
  bad({ GHOST_TITLE: "a\nb" }, /one line/)
  assert.deepEqual(checkGhostOptions({ GHOST_SMTP_HOST: "smtp.example.com", GHOST_SMTP_USER: "news@example.com" }), [])

  // The preview replaces whatever reference was sent with its own (or none).
  const vault = new MemVault()
  const p = await ghostPreview({ ...ok.values, GHOST_SMTP_REF: "11111111-1111-1111-1111-111111111111" }, undefined, vault)
  assert.equal(p.options.GHOST_SMTP_REF, "")
  assert.ok(p.warnings.includes(NO_MAIL), "no SMTP server is said plainly")
})

// ── Compose, settings, script ───────────────────────────────────────────────

test("compose: pinned images, Ghost on loopback only, MySQL healthy first, every password a secret file", () => {
  const c = ghostCompose()
  assert.match(GHOST_IMAGE, /^ghost:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
  assert.match(MYSQL_IMAGE, /^mysql:8\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
  assert.ok(c.includes(`image: ${GHOST_IMAGE}`) && c.includes(`image: ${MYSQL_IMAGE}`))
  assert.doesNotMatch(c, /:latest|image: ghost\s*$|image: mysql\s*$/m)
  assert.match(c, /ports:\n\s+- "127\.0\.0\.1:2368:2368"/)
  assert.equal((c.match(/ports:/g) ?? []).length, 1, "MySQL publishes nothing")
  assert.match(c, /depends_on:\n\s+db:\n\s+condition: service_healthy/)
  assert.match(c, /MYSQL_PASSWORD_FILE: \/run\/secrets\/db_password/)
  assert.match(c, /MYSQL_ROOT_PASSWORD_FILE: \/run\/secrets\/db_root_password/)
  assert.match(c, /database__connection__password_FILE: \/run\/secrets\/db_password/)
  // No password value anywhere: only *_FILE pointers and the secrets' own names and files.
  for (const line of c.split("\n").filter(l => /password/i.test(l))) {
    assert.match(line, /_FILE: \/run\/secrets\/\w+$|^\s+secrets: \[|^\s+(db|db_root|smtp)_password:$|^\s+file: \.\/secrets\/\w+$/, line)
  }
  assert.match(c, /env_file: \.\/ghost\.env/)
  assert.match(c, /NODE_ENV: production/)
  for (const s of ["db_password", "db_root_password", "smtp_password"]) assert.match(c, new RegExp(`${s}:\\n\\s+file: \\./secrets/${s}`))
})

test("ghost.env: the url, sign-in codes off until setup, and mail only when asked, its password by file", () => {
  assert.equal(ghostEnvFile({ url: "https://blog.example.com" }), "url=https://blog.example.com\nsecurity__staffDeviceVerification=false\n")
  const m = ghostEnvFile({ url: "https://blog.example.com", smtpHost: "smtp.example.com", smtpPort: "465", smtpSecure: "1", smtpUser: "apikey", smtpFrom: "news@example.com" })
  assert.deepEqual(m.trim().split("\n"), [
    "url=https://blog.example.com", "security__staffDeviceVerification=false", "mail__transport=SMTP",
    "mail__options__host=smtp.example.com", "mail__options__port=465", "mail__options__secure=true",
    "mail__options__auth__user=apikey", "mail__options__auth__pass_FILE=/run/secrets/smtp_password", "mail__from=news@example.com",
  ])
  assert.match(ghostEnvFile({ url: "http://192.0.2.50" }, true), /staffDeviceVerification=true/)
})

const GHOST_ENV = { GHOST_TITLE: "News", GHOST_OWNER_NAME: "Alex", GHOST_OWNER_EMAIL: "alex@example.com",
  GHOST_URL: "https://blog.example.com", GHOST_ENV_FILE: ghostEnvFile({ url: "https://blog.example.com" }),
  GHOST_ADMIN_PASSWORD: OWNER_PW, GHOST_DB_PASSWORD: "DBsecretVALUE456", GHOST_DB_ROOT_PASSWORD: "ROOTsecretVALUE789", GHOST_SMTP_PASSWORD: "" }

test("script: secrets once, in an export, unset at once and written by the shell; metrics log format; setup closed in nginx", () => {
  const g = findRecipe("ghost")!
  const sh = installScript(g, "debian", GHOST_ENV)
  for (const v of [OWNER_PW, GHOST_ENV.GHOST_DB_PASSWORD, GHOST_ENV.GHOST_DB_ROOT_PASSWORD]) {
    const lines = sh.split("\n").filter(l => l.includes(v))
    assert.equal(lines.length, 1, v)
    assert.match(lines[0], /^export GHOST_(ADMIN|DB|DB_ROOT)_PASSWORD='/)
  }
  assert.match(GHOST_SCRIPT, /^unset GHOST_ADMIN_PASSWORD GHOST_DB_PASSWORD GHOST_DB_ROOT_PASSWORD GHOST_SMTP_PASSWORD$/m)
  // The copies reach files only through printf, a builtin, inside the root-only folder.
  for (const line of GHOST_SCRIPT.split("\n").filter(l => /\$(DB_PW|DB_ROOT_PW|SMTP_PW)\b/.test(l))) {
    if (/^(DB_PW=|if \[ -z|if \[ -n)/.test(line)) continue
    assert.match(line, /^\s*printf '%s' "\$(DB_PW|DB_ROOT_PW|SMTP_PW)" > \$D\/secrets\/\w+( \))?$/, line)
  }
  assert.match(GHOST_SCRIPT, /chmod 700 \$D\/secrets/)
  assert.match(GHOST_SCRIPT, /log_format hyperprox_metrics /)
  assert.match(GHOST_NGINX, /access_log \/var\/log\/nginx\/access\.log hyperprox_metrics;/)
  assert.match(GHOST_NGINX, /location ~\* \S+authentication\/setup \{\n\s+limit_except GET HEAD \{ deny all; \}/)
  assert.equal((GHOST_NGINX.match(/proxy_pass http:\/\/127\.0\.0\.1:2368;/g) ?? []).length, 2, "proxy_pass in the server block, where discovery reads it")
  assert.match(GHOST_SCRIPT, /case "\$GHOST_URL" in https:\/\/\*\) XFP=https ;; \*\) XFP='\$scheme' ;; esac/)
  assert.ok(sh.includes(ghostCompose().trim()), "the compose file goes in whole")
  assert.match(GHOST_SCRIPT, /if \[ -s \$D\/mysql\/ibdata1 \]/, "an existing database is never given new passwords")
  assert.doesNotMatch(manualCommands(g, "debian").join("\n"), /secretVALUE|OWNERsecret/)
  const { GHOST_DB_ROOT_PASSWORD: _r, ...noRoot } = GHOST_ENV
  assert.throws(() => installScript(g, "debian", noRoot), /GHOST_DB_ROOT_PASSWORD/)
})

// ── A fake Ghost ────────────────────────────────────────────────────────────

class FakeGhost {
  calls: string[] = []
  owner: any = null
  settings: Record<string, string> = { title: "Ghost", description: "Thoughts, stories and ideas." }
  sessions = new Set<string>()
  answering = true
  /** Answer the setup POST with this instead. */
  refuseOwner: { status: number; body: string } | null = null
  alreadySetUp = false
  /** Ghost's API sends an admin secret as the whole id:secret key; older answers may send only the secret. */
  plainSecret = false
  verifyToken(t?: string) {
    if (!t) return false
    const [h, p, sig] = t.split(".")
    const want = createHmac("sha256", Buffer.from(KEY_SECRET, "hex")).update(`${h}.${p}`).digest("base64url")
    const head = JSON.parse(Buffer.from(h, "base64url").toString()), body = JSON.parse(Buffer.from(p, "base64url").toString())
    return sig === want && head.kid === KEY_ID && body.aud === "/admin/" && body.exp - body.iat === 300
  }
  http: GhostHttp = async (r: GhostRequest) => {
    this.calls.push(`${r.method} ${r.path}${r.cookie ? " +cookie" : ""}${r.token ? " +token" : ""}`)
    if (!this.answering) return null
    const ok = (status: number, body: unknown, cookie?: string) => ({ status, body: JSON.stringify(body), ...(cookie ? { cookie } : {}) })
    if (r.path === SETUP && r.method === "GET") return ok(200, { setup: [{ status: this.alreadySetUp || !!this.owner }] })
    if (r.path === SETUP && r.method === "POST") {
      if (this.refuseOwner) return this.refuseOwner
      const s = (r.body as any).setup[0]
      this.owner = { name: s.name, email: s.email, password: s.password }
      this.settings.title = s.blogTitle
      if (s.description) this.settings.description = s.description
      return ok(201, { users: [{ email: s.email }] })
    }
    if (r.path === "/ghost/api/admin/session/" && r.method === "POST") {
      const b = r.body as any
      if (!this.owner || b.username !== this.owner.email || b.password !== this.owner.password) return ok(422, { errors: [{ message: "Your password is incorrect." }] })
      this.sessions.add(COOKIE); return ok(201, {}, COOKIE)
    }
    if (r.path === "/ghost/api/admin/session/" && r.method === "DELETE") { this.sessions.delete(r.cookie!); return ok(204, {}) }
    if (r.path === "/ghost/api/admin/integrations/?include=api_keys" && r.method === "POST") {
      if (!this.sessions.has(r.cookie!)) return ok(403, { errors: [{ message: "Authorization failed" }] })
      return ok(201, { integrations: [{ name: (r.body as any).integrations[0].name,
        api_keys: [{ type: "content", id: "c".repeat(24), secret: "1".repeat(26) }, { type: "admin", id: KEY_ID, secret: this.plainSecret ? KEY_SECRET : KEY }] }] })
    }
    if (r.path === "/ghost/api/admin/settings/" && r.method === "GET") {
      if (!this.verifyToken(r.token)) return ok(401, { errors: [{ message: "Invalid token" }] })
      return ok(200, { settings: Object.entries(this.settings).map(([key, value]) => ({ key, value })) })
    }
    return ok(404, { errors: [{ message: `fake: ${r.method} ${r.path}` }] })
  }
}

const steps = () => {
  const all = new Map<string, StepRef & { order: number }>()
  let n = 0
  return { all, step: (id: string) => { const s = { status: "running", order: n++ } as StepRef & { order: number }; all.set(id, s); return s } }
}
const INPUT_G = (o: any = {}) => ({
  url: "https://blog.example.com", owner: { name: "Alex", email: "alex@example.com", password: OWNER_PW },
  title: "News", description: "From the team", mail: false, vault: { category: "apps", provider: "ghost-102" }, ...o,
})
/**
 * nginx in the container, as far as the setup sees it: the holding page until the Ghost site is turned on, then the
 * real config's rules (the setup regex, matched as nginx does: slashes merged, case-insensitive).
 */
class FakeNginx {
  ghostOn = false
  refuseConfig = false
  answer(method: string, path: string): number {
    if (!this.ghostOn) return 503
    const p = path.replace(/\/{2,}/g, "/")
    if (new RegExp(SETUP_LOCATION_RE, "i").test(p) && !["GET", "HEAD"].includes(method)) return 403
    return 200
  }
}
/** The container's shell for the setup: stop, mail, the nginx switch and its read-back. Every script is kept. */
function fakeShell(n: FakeNginx, scripts: string[], o: { stopOk?: boolean } = {}) {
  return async (s: string) => {
    scripts.push(s)
    if (/docker compose stop/.test(s)) { if (o.stopOk === false) return { code: 1, output: "" }; n.ghostOn = false; return { code: 0, output: "@@ghost stopped\n" } }
    if (/staffDeviceVerification=true/.test(s)) return { code: 0, output: "@@ghost mail on\n" }
    if (s === GHOST_OPEN_SCRIPT) { if (n.refuseConfig) return { code: 1, output: "@@ghost nginx refused\n" }; n.ghostOn = true; return { code: 0, output: "@@ghost open\n" } }
    if (/^echo "HPXO site /m.test(s)) {
      const codes = [...s.matchAll(/-X (\w+) .*?'http:\/\/127\.0\.0\.1([^']*)'/g)].map(m => n.answer(m[1], m[2]))
      return { code: 0, output: `HPXO site ${codes[0]} setup ${codes.slice(1).join(" ")}\n` }
    }
    return { code: 0, output: "" }
  }
}
/** The scripts that change something (not the read-back). */
const acts = (scripts: string[]) => scripts.filter(x => !/^echo "HPXO site /m.test(x))

function setupDeps(g: FakeGhost, o: any = {}) {
  const saved: Array<[string, string, Record<string, string>]> = [], scripts: string[] = []
  const nginx: FakeNginx = o.nginx ?? new FakeNginx()
  return {
    saved, scripts, nginx,
    d: {
      http: g.http, wait: async () => {}, now: Date.now,
      saveSecrets: async (c: string, p: string, v: Record<string, string>) => { saved.push([c, p, v]) },
      sh: fakeShell(nginx, scripts),
      ...o,
    },
  }
}

// ── First run ───────────────────────────────────────────────────────────────

test("setup: waits for Ghost, makes the owner, reads it back, makes the key, reads the title back with it, ends the session", async () => {
  const g = new FakeGhost(), { saved, scripts, d } = setupDeps(g), st = steps()
  const out = await runGhostSetup(INPUT_G(), st.step, d)
  assert.equal(out.integration, "HyperProx")
  assert.deepEqual(g.calls, [
    `GET ${SETUP}`,
    `POST ${SETUP}`,
    `GET ${SETUP}`,                                          // read back: setup is done
    "POST /ghost/api/admin/session/",
    "POST /ghost/api/admin/integrations/?include=api_keys +cookie",
    "GET /ghost/api/admin/settings/ +token",                  // read back with the key itself
    "DELETE /ghost/api/admin/session/ +cookie",
  ])
  assert.deepEqual([...st.all.keys()], ["ghost-start", "ghost-owner", "ghost-open", "ghost-key", "ghost-mail"])
  assert.deepEqual([...st.all.values()].map(s => s.status), ["done", "done", "done", "done", "skipped"])
  assert.equal(st.all.get("ghost-mail")!.detail, NO_MAIL)
  assert.deepEqual(g.owner, { name: "Alex", email: "alex@example.com", password: OWNER_PW })
  assert.equal(g.settings.title, "News"); assert.equal(g.settings.description, "From the team")
  assert.deepEqual(saved, [["apps", "ghost-102", { admin_api_key: KEY }]])
  assert.equal(g.sessions.size, 0, "the owner's session was ended")
  assert.deepEqual(acts(scripts), [GHOST_OPEN_SCRIPT], "only the nginx switch: nothing was stopped and no mail change was made")
  for (const s of st.all.values()) assert.ok(!String(s.detail ?? "").includes(KEY_SECRET) && !String(s.detail ?? "").includes(OWNER_PW))
})

test("setup: an admin secret sent on its own is joined to its id into the same key", async () => {
  const g = new FakeGhost(); g.plainSecret = true
  const { saved, d } = setupDeps(g)
  await runGhostSetup(INPUT_G(), steps().step, d)
  assert.deepEqual(saved, [["apps", "ghost-102", { admin_api_key: KEY }]])
})

test("setup with mail: sign-in codes go back on after the session ends, and Ghost must come back", async () => {
  const g = new FakeGhost(), { scripts: all, d } = setupDeps(g), st = steps()
  await runGhostSetup(INPUT_G({ mail: true }), st.step, d)
  assert.equal(st.all.get("ghost-mail")!.status, "done")
  const scripts = acts(all).filter(x => x !== GHOST_OPEN_SCRIPT)
  assert.equal(scripts.length, 1)
  assert.match(scripts[0], /sed -i 's\/\^security__staffDeviceVerification=false\$\/security__staffDeviceVerification=true\/' ghost\.env/)
  assert.match(scripts[0], /docker compose up -d --quiet-pull ghost/)
  assert.ok(g.calls.indexOf("DELETE /ghost/api/admin/session/ +cookie") < g.calls.lastIndexOf(`GET ${SETUP}`), "mail is turned on after the sign-in is over")
})

test("never leave setup open: a refused owner stops Ghost and nginx, says why, and hides the password", async () => {
  const g = new FakeGhost()
  g.refuseOwner = { status: 422, body: JSON.stringify({ errors: [{ message: `Password ${OWNER_PW} is too weak.` }] }) }
  const { scripts, nginx, d } = setupDeps(g), st = steps()
  await assert.rejects(runGhostSetup(INPUT_G(), st.step, d), (e: any) => {
    assert.match(e.message, /Ghost refused the owner account \(422\): Password \[hidden\] is too weak\. Ghost and nginx were stopped/)
    assert.ok(!e.message.includes(OWNER_PW))
    return true
  })
  assert.equal(scripts.length, 1)
  assert.match(scripts[0], /^cd \/opt\/ghost && docker compose stop >\/dev\/null 2>&1 && systemctl stop nginx && echo "@@ghost stopped"/)
  assert.ok(!g.calls.some(c => c.includes("session")), "no sign-in after a failed owner")
  assert.ok(!scripts.includes(GHOST_OPEN_SCRIPT) && !nginx.ghostOn, "nginx never proxied to Ghost: the owner does not exist")
  assert.equal(st.all.get("ghost-open"), undefined)
})

test("never leave setup open: an owner HyperProx did not make is not touched; no answer stops Ghost; a failed stop stops the container", async () => {
  const g = new FakeGhost(); g.alreadySetUp = true
  const a = setupDeps(g)
  await assert.rejects(runGhostSetup(INPUT_G(), steps().step, a.d), /already has an owner that HyperProx did not make.*Ghost and nginx were stopped/)
  assert.deepEqual(g.calls, [`GET ${SETUP}`], "no setup POST")

  const silent = new FakeGhost(); silent.answering = false
  let stopped = false
  const b = setupDeps(silent, { sh: fakeShell(new FakeNginx(), [], { stopOk: false }), stopContainer: async () => { stopped = true; return true } })
  await assert.rejects(runGhostSetup(INPUT_G(), steps().step, b.d), /did not answer.*within five minutes.*the whole container was stopped/)
  assert.ok(stopped)

  const c = setupDeps(silent, { sh: async () => { throw new Error("ssh down") } })
  await assert.rejects(runGhostSetup(INPUT_G(), steps().step, c.d), /Ghost could not be stopped: stop the container yourself/)
})

test("never leave setup open: a key that does not read back stops Ghost, and the key and cookie are hidden", async () => {
  const g = new FakeGhost()
  g.verifyToken = () => false
  const { d } = setupDeps(g), st = steps()
  await assert.rejects(runGhostSetup(INPUT_G(), st.step, d), (e: any) => {
    assert.match(e.message, /The Admin API key did not work \(401\)\. Ghost and nginx were stopped/)
    for (const s of [KEY_SECRET, COOKIE, OWNER_PW]) assert.ok(!e.message.includes(s))
    return true
  })
  assert.equal(g.sessions.size, 0, "the session ends even when a step after sign-in fails")
})

test("nginx: the install serves only a holding page; Ghost is proxied only by the switch after the owner exists", () => {
  assert.doesNotMatch(GHOST_HOLDING_NGINX, /proxy_pass/)
  assert.match(GHOST_HOLDING_NGINX, /return 503/)
  assert.match(GHOST_HOLDING_NGINX, /access_log \/var\/log\/nginx\/access\.log hyperprox_metrics;/)
  assert.match(GHOST_SCRIPT, /^ln -sf \/etc\/nginx\/sites-available\/ghost-holding \/etc\/nginx\/sites-enabled\/ghost-holding$/m)
  assert.match(GHOST_SCRIPT, /^rm -f \/etc\/nginx\/sites-enabled\/default \/etc\/nginx\/sites-enabled\/ghost$/m)
  assert.ok(!GHOST_SCRIPT.split("\n").some(l => /^ln /.test(l) && /sites-enabled\/ghost$/.test(l)), "the install never turns the Ghost site on")
  assert.match(GHOST_OPEN_SCRIPT, /ln -sf \/etc\/nginx\/sites-available\/ghost \/etc\/nginx\/sites-enabled\/ghost/)
  assert.match(GHOST_OPEN_SCRIPT, /nginx -t/)
  assert.ok(GHOST_OPEN_SCRIPT.indexOf('systemctl reload nginx') < GHOST_OPEN_SCRIPT.indexOf('[ "$C" != 503 ]'), "waits for the reload to take over before saying it is open")
  assert.match(GHOST_OPEN_SCRIPT, /ghost-holding \/etc\/nginx\/sites-enabled\/ghost-holding\n  echo "@@ghost nginx refused"/, "a refused config puts the holding page back")
})

test("nginx: the setup regex catches upper case, versioned, slash-less and doubled-slash forms; nothing else", () => {
  const re = new RegExp(SETUP_LOCATION_RE, "i")
  for (const p of SETUP_VARIANTS) assert.ok(re.test(p.replace(/\/{2,}/g, "/")), p)
  for (const p of ["/ghost/api/admin/site/", "/ghost/api/admin/session/", "/ghost/api/content/posts/", "/blog/authentication/setup/", "/ghost/"]) assert.ok(!re.test(p), p)
  assert.ok(GHOST_NGINX.includes(`location ~* ${SETUP_LOCATION_RE} {\n    limit_except GET HEAD { deny all; }`))
  assert.ok(SETUP_VARIANTS.some(p => /v4/.test(p)) && SETUP_VARIANTS.some(p => p === p.toUpperCase()) && SETUP_VARIANTS.some(p => !p.endsWith("/")))
})

test("ghost-open: read back through nginx; one write that is not refused, or a refused config, stops Ghost", async () => {
  assert.equal(parseOpenReadback("HPXO site 200 setup 403 403\n")!.site, 200)
  assert.equal(parseOpenReadback("nothing"), null)
  const sh = openReadbackScript("https://blog.example.com")
  for (const p of SETUP_VARIANTS) for (const m of ["POST", "PUT"]) assert.ok(sh.includes(`-X ${m} `) && sh.includes(`'http://127.0.0.1${p}'`), `${m} ${p}`)
  assert.match(sh, /-H 'Host: blog\.example\.com' -H 'X-Forwarded-Proto: https'/)

  // Before the switch nginx answers 503 to all of it.
  const n = new FakeNginx()
  assert.deepEqual(SETUP_VARIANTS.map(p => n.answer("POST", p)), SETUP_VARIANTS.map(() => 503))

  // An nginx whose rule missed the versioned form: Ghost is stopped and the job says which form.
  class Leaky extends FakeNginx { answer(m: string, p: string) { return /\/v4\//.test(p) && this.ghostOn ? 201 : super.answer(m, p) } }
  const leaky = new Leaky(), a = setupDeps(new FakeGhost(), { nginx: leaky })
  a.d.sh = fakeShell(leaky, a.scripts)
  await assert.rejects(runGhostSetup(INPUT_G(), steps().step, a.d), /a write to \/ghost\/api\/v4\/admin\/authentication\/setup\/ answered 201, not 403.*Ghost and nginx were stopped/)
  assert.equal(leaky.ghostOn, false)

  const refused = new FakeNginx(); refused.refuseConfig = true
  const b = setupDeps(new FakeGhost(), { nginx: refused }); b.d.sh = fakeShell(refused, b.scripts)
  await assert.rejects(runGhostSetup(INPUT_G(), steps().step, b.d), /nginx refused the Ghost site's configuration, so the holding page was kept/)
})

test("ghost.env refuses a $ or quote in any value; the sender address kind already refuses $", () => {
  assert.throws(() => ghostEnvFile({ url: "https://blog.example.com", smtpHost: "smtp.example.com", smtpFrom: "a$b@example.com" }), /smtpFrom holds a character/)
  assert.throws(() => ghostEnvFile({ url: "https://blog.example.com", smtpHost: "smtp.example.com", smtpUser: "a'b" }), /smtpUser/)
  const g = findRecipe("ghost")!
  assert.match(checkOptions(g, { GHOST_TITLE: "N", GHOST_OWNER_NAME: "A", GHOST_OWNER_EMAIL: "a@example.com", GHOST_SMTP_HOST: "smtp.example.com", GHOST_SMTP_FROM: "x${HOME}@example.com" }).errors.join(), /Send mail from.*not an email/)
})

// ── Requests over the node login ────────────────────────────────────────────

test("request script: loopback only, Host/Origin/scheme of the site, password and cookie never on curl's command line", () => {
  const s = requestScript("https://blog.example.com", { method: "POST", path: "/ghost/api/admin/session/", body: { username: "a@example.com", password: OWNER_PW }, cookie: COOKIE })
  const curl = s.split("\n").find(l => l.includes("curl "))!
  assert.match(curl, /'http:\/\/127\.0\.0\.1:2368\/ghost\/api\/admin\/session\/'/)
  assert.match(curl, /-H @"\$T\/hdr" --data-binary @"\$T\/req"/)
  assert.ok(!curl.includes(OWNER_PW) && !curl.includes("sessionSECRET"))
  const lines = s.split("\n")
  const hdr = lines.slice(lines.indexOf(`cat > "$T/hdr" <<'HP_HDR'`) + 1, lines.indexOf("HP_HDR"))
  assert.deepEqual(hdr, ["Host: blog.example.com", "X-Forwarded-Proto: https", "Origin: https://blog.example.com", "Accept: application/json", "Content-Type: application/json", `Cookie: ${COOKIE}`])
  assert.equal(lines.filter(l => l.includes(OWNER_PW)).length, 1)
  assert.match(lines[lines.findIndex(l => l.includes(OWNER_PW)) - 1], /^cat > "\$T\/req" <<'HP_BODY'$/)
  assert.throws(() => requestScript("https://blog.example.com", { method: "GET", path: "/ghost/api/admin/x'; reboot/" }), /not a Ghost Admin API path/)
  assert.throws(() => requestScript("https://blog.example.com", { method: "GET", path: "/ghost/api/admin/site/", cookie: "a=b\nX: y" }), /not a Ghost session cookie/)
  assert.throws(() => requestScript("https://blog.example.com", { method: "GET", path: "/etc/passwd" }), /not a Ghost Admin API path/)
  const lan = requestScript("http://192.0.2.50", { method: "GET", path: SETUP })
  assert.match(lan, /^X-Forwarded-Proto: http$/m)
  assert.match(lan, /^Origin: http:\/\/192\.0\.2\.50$/m)
})

test("answers: status, cookie and body read back; a cut-off or unanswered request is no answer", async () => {
  const b64 = Buffer.from('{"setup":[{"status":false}]}').toString("base64")
  assert.deepEqual(parseAnswer(`HPXG1 status 201\nHPXG1 cookie ${COOKIE}\nHPXG1 body ${b64}\nHPXG1 end\n`), { status: 201, body: '{"setup":[{"status":false}]}', cookie: COOKIE })
  assert.equal(parseAnswer(`HPXG1 status 200\nHPXG1 body ${b64}\n`), null)
  assert.equal(parseAnswer("HPXG1 status 000\nHPXG1 body \nHPXG1 end\n"), null)
  const http = ghostOverShell("https://blog.example.com", async () => ({ code: 0, output: `HPXG1 status 200\nHPXG1 body ${b64}\nHPXG1 end\n` }))
  assert.equal((await http({ method: "GET", path: SETUP }))!.status, 200)
  assert.equal(await ghostOverShell("https://blog.example.com", async () => { throw new Error("x") })({ method: "GET", path: SETUP }), null)
})

test("admin token: HS256 over the hex secret, kid is the key id, five minutes, audience /admin/", () => {
  const t = adminToken(KEY, 1_700_000_000_000)
  const [h, p] = t.split(".")
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "HS256", typ: "JWT", kid: KEY_ID })
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), { iat: 1_700_000_000, exp: 1_700_000_300, aud: "/admin/" })
  assert.ok(new FakeGhost().verifyToken(t))
  assert.throws(() => adminToken("nope", 0), /not a Ghost Admin API key/)
})

// ── Detection and adoption ──────────────────────────────────────────────────

test("detection: Ghost's site JSON or its generator tag, with the version; WordPress and others are not Ghost", () => {
  const fp = DETECT.ghost
  const hit = (path: string, status: number, body: string) => fp.find(f => f.path === path)!.match({ status, headers: {}, body })
  assert.deepEqual(hit("/ghost/api/admin/site/", 200, '{"site":{"title":"News","url":"https://blog.example.com/","version":"6.77"}}'), { version: "6.77" })
  assert.equal(hit("/ghost/api/admin/site/", 301, ""), null)
  assert.equal(hit("/ghost/api/admin/site/", 200, '{"site":{"title":"x"}}'), null)
  assert.deepEqual(hit("/", 200, '<head><meta name="generator" content="Ghost 6.77"></head>'), { version: "6.77" })
  assert.equal(hit("/", 200, '<meta name="generator" content="WordPress 6.9" />'), null)
  assert.equal(findRecipe("ghost")!.detect, DETECT.ghost)
})

const b64 = (s: string) => Buffer.from(s).toString("base64")
const NGINX_T = LOG_FORMAT_LINE + "\n" + GHOST_NGINX.replace("@XFP@", "https").split("\n").filter(l => /[{}]|^\s*(server_name|access_log|log_format|root|listen|proxy_pass)\s/.test(l)).join("\n")

test("discovery: a proxied nginx with a Ghost container behind it is offered as Ghost; adoption keeps the label, metrics stay 'other'", () => {
  const out = parseDiscover(["HPXD1 listen 0050", "HPXD1 bin nginx", `HPXD1 nginx ${b64(NGINX_T)}`, "HPXD1 ghost docker", "HPXD1 end", ""].join("\n"))
  assert.equal(out.ghost, true)
  const ins = inspectFor(out, "blog.example.com", 80)
  assert.deepEqual([ins.server, ins.kind, ins.app, ins.logPath, ins.logFormat?.requestTime, ins.logFormat?.forwardedFor],
    ["nginx", "other", "ghost", "/var/log/nginx/access.log", true, true])
  const plain = inspectFor(parseDiscover(["HPXD1 bin nginx", `HPXD1 nginx ${b64(NGINX_T)}`, "HPXD1 end", ""].join("\n")), "blog.example.com", 80)
  assert.equal(plain.app, undefined, "a proxy with no Ghost behind it is just other")
  const cands = buildCandidates([{ key: "k", domains: ["blog.example.com"], tls: true, forward: { scheme: "http", host: "192.0.2.50", port: 80 },
    proxies: [{ instanceName: "Edge", kind: "npm" }], source: "proxy",
    guest: { vmid: 150, name: "blog", node: "node-a", type: "lxc", status: "running", addresses: ["192.0.2.50"] } }],
  new Map([[150, { ok: true as const, out }]]), [])
  assert.equal(cands[0].app, "ghost"); assert.equal(cands[0].adoptable, true)

  const a = checkAdoptInput({ vmid: 150, url: "https://blog.example.com", kind: "other", app: "ghost" })
  assert.deepEqual(a.errors, []); assert.equal(a.input!.app, "ghost")
  assert.match(checkAdoptInput({ vmid: 150, url: "https://blog.example.com", kind: "wordpress", app: "ghost" }).errors.join(), /Only an "other" site/)
  assert.equal(checkAdoptInput({ vmid: 150, url: "https://blog.example.com", kind: "other" }).input!.app, undefined)
  assert.equal(kindOf({ recipeId: "adopted-ghost" } as any), "other")
  assert.equal(kindOf({ recipeId: "ghost" } as any), "other")
})

test("admin link: /ghost/ on the public address (or the local one), for made and adopted Ghost sites", () => {
  assert.equal(adminUrlOf({ recipeId: "ghost", url: "https://blog.example.com", localUrl: "http://192.0.2.50:80" }), "https://blog.example.com/ghost/")
  assert.equal(adminUrlOf({ recipeId: "ghost", localUrl: "http://192.0.2.50" }), "http://192.0.2.50/ghost/")
  assert.equal(adminUrlOf({ recipeId: "adopted-ghost", url: "https://blog.example.com/" }), "https://blog.example.com/ghost/")
  assert.equal(adminUrlOf({ recipeId: "wordpress", url: "https://wp.example.com" }), "https://wp.example.com/wp-admin/")
  assert.equal(adminUrlOf({ recipeId: "static-site", url: "https://www.example.com" }), null)
})

// ── The Sites card ──────────────────────────────────────────────────────────

test("card: version, published posts and members with the vault's key; the key never in a message", async () => {
  clearGhostStatsCache()
  const site = { id: "g1", recipeId: "ghost", localUrl: "http://192.0.2.50:80", vault: { category: "apps", provider: "ghost-102" } }
  const asked: Array<[string, Record<string, string>]> = []
  const fake = new FakeGhost()
  const d = {
    readSecrets: async () => ({ admin_api_key: KEY }), now: () => 1_700_000_000_000,
    get: async (url: string, h: Record<string, string>) => {
      asked.push([url, h])
      if (url.endsWith("/site/")) return { status: 200, body: '{"site":{"version":"6.77"}}' }
      if (!fake.verifyToken(h.Authorization?.replace(/^Ghost /, ""))) return { status: 401, body: "" }
      return { status: 200, body: JSON.stringify({ meta: { pagination: { total: url.includes("/posts/") ? 12 : 340 } } }) }
    },
  }
  assert.deepEqual(await ghostStats(site, d), { version: "6.77", posts: 12, members: 340, checkedAt: 1_700_000_000_000 })
  assert.deepEqual(asked.map(a => a[0]), ["http://192.0.2.50:80/ghost/api/admin/site/",
    "http://192.0.2.50:80/ghost/api/admin/posts/?limit=1&fields=id&filter=status:published", "http://192.0.2.50:80/ghost/api/admin/members/?limit=1&fields=id"])
  assert.equal(asked[0][1].Authorization, undefined, "the public site endpoint gets no key")
  await ghostStats(site, d)
  assert.equal(asked.length, 3, "cached for five minutes")

  clearGhostStatsCache()
  await assert.rejects(ghostStats(site, { ...d, get: async () => ({ status: 401, body: "" }) }), /refused the Admin API key \(401\)/)
  await assert.rejects(ghostStats(site, { ...d, readSecrets: async () => { throw new Error("locked") } }), /vault is locked/)
  await assert.rejects(ghostStats({ ...site, recipeId: "wordpress" }, d), /Only a Ghost site/)
  await assert.rejects(ghostStats(site, { ...d, get: async () => { throw new Error(`boom ${KEY_SECRET}`) } }), (e: any) => !e.message.includes(KEY_SECRET) && /\[hidden\]/.test(e.message))
})

// ── Through the New website wizard ──────────────────────────────────────────

class MemVault {
  items: Record<string, Record<string, string>> = {}
  saveSecrets = async (c: string, p: string, v: Record<string, string>) => { this.items[`${c}/${p}`] = { ...(this.items[`${c}/${p}`] ?? {}), ...v } }
  readSecrets = async (c: string, p: string) => ({ ...(this.items[`${c}/${p}`] ?? {}) })
  deleteSecrets = async (c: string, p: string) => { delete this.items[`${c}/${p}`] }
}

function publishFake(): PublishDeps {
  const records: any[] = [{ type: "A", name: "@", data: "198.51.100.1" }]
  return {
    dns: async () => ({ getDomains: async () => [{ domain: "example.com", status: "ACTIVE" }], getRecords: async () => structuredClone(records),
      createRecord: async (_z, r) => { records.push(r) }, deleteRecord: async () => {} }),
    proxy: { instances: async () => [{ id: "npm-1", name: "Edge NPM", kind: "npm", status: "ok", certificates: "request" }],
      createHost: async () => ({ hostId: "77" }), attachCertificate: async () => {}, deleteHost: async () => {}, requestCertificate: async () => ({ id: "9" }) },
    wanIp: async () => "203.0.113.7", resolve4: async () => ["203.0.113.7"], letsEncryptEmail: () => "ops@example.com",
    fetchPublic: async () => ({ status: 200, body: '{"site":{"title":"News","version":"6.77"}}' }), wait: async () => {},
  }
}

const GHOST_INPUT = (o: any = {}) => INPUT({ recipeId: "ghost", hostname: "blog", cores: 2, memoryMb: 2048, diskGb: 10,
  options: { GHOST_TITLE: "News", GHOST_OWNER_NAME: "Alex", GHOST_OWNER_EMAIL: "alex@example.com",
    GHOST_SMTP_HOST: "smtp.example.com", GHOST_SMTP_USER: "apikey", GHOST_SMTP_REF: "11111111-1111-1111-1111-111111111111" },
  publish: { zone: "example.com", name: "blog", instanceId: "npm-1" }, ghostSmtpPassword: "SMTPsecretPW987", ...o })

test("wizard: the plan holds no SMTP password; the run sets url to the public https name, sets Ghost up, publishes, and lists the site", async () => {
  const f = new FakePve(), vault = new MemVault(), g = new FakeGhost()
  const scripts: string[] = []
  const nginx = new FakeNginx(), shell = fakeShell(nginx, scripts)
  let logged = ""
  const d = deps(f, {
    publish: publishFake(), saveSecrets: vault.saveSecrets, readSecrets: vault.readSecrets, deleteSecrets: vault.deleteSecrets,
    exec: async (o: any) => {
      if (/^set -e\nexport DEBIAN_FRONTEND/.test(o.script)) { scripts.push(o.script); o.onData("Ghost 6.77.0 and MySQL 8.4.13 are starting\n"); return { code: 0, output: "", timedOut: false } as any }
      return { ...(await shell(o.script)), timedOut: false } as any
    },
    probe: async () => ({ status: 200, body: '{"site":{"title":"News","version":"6.77"}}' }),
    ghostHttp: (url: string) => { logged = url; return g.http },
  })
  const r = await previewInstall(GHOST_INPUT(), "a@example.com", d)
  assert.deepEqual(r.errors, [])
  const plan = r.preview!.plan
  assert.notEqual(plan.options!.GHOST_SMTP_REF, "11111111-1111-1111-1111-111111111111", "the request's reference is dropped")
  assert.ok(!JSON.stringify(plan).includes("SMTPsecretPW987"), "the SMTP password is not in the plan")
  assert.deepEqual(vault.items[`apps/ghost-smtp-pending-${plan.options!.GHOST_SMTP_REF}`], { smtp_password: "SMTPsecretPW987" })
  assert.ok(r.checks.some(c => /SMTP password is in the vault/.test(c)))

  const job = await settled((await applyPreview(r.preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.deepEqual(job.steps.map(s => s.id), ["container", "network", "install", "ghost-start", "ghost-owner", "ghost-open", "ghost-key", "ghost-mail",
    "verify", "wire", "proxy", "dns", "propagate", "cert", "public"])
  assert.equal(job.url, "https://blog.example.com")
  assert.equal(logged, "https://blog.example.com", "Ghost's requests carry the public name")
  const install = scripts[0]
  assert.match(install, /^export GHOST_URL='https:\/\/blog\.example\.com'$/m)
  assert.match(install, /url=https:\/\/blog\.example\.com\nsecurity__staffDeviceVerification=false\nmail__transport=SMTP/)
  // One vault item: the generated passwords, the SMTP password moved in, and the Admin API key; the pending copy is gone.
  const item = vault.items["apps/ghost-102"]
  assert.deepEqual(Object.keys(item).sort(), ["admin_api_key", "admin_password", "admin_user", "db_password", "db_root_password", "smtp_password"])
  assert.equal(item.admin_user, "alex@example.com"); assert.equal(item.smtp_password, "SMTPsecretPW987"); assert.equal(item.admin_api_key, KEY)
  assert.ok(!Object.keys(vault.items).some(k => k.startsWith("apps/ghost-smtp-pending-")))
  assert.equal(g.owner.password, item.admin_password)
  // Mail was given, so the sign-in codes were turned on.
  assert.equal(job.steps.find(s => s.id === "ghost-mail")!.status, "done")
  assert.ok(scripts.some(s => /staffDeviceVerification=true/.test(s)))

  // Secrets never in the log, a step, the error or the stored job.
  const visible = JSON.stringify({ log: job.log, steps: job.steps, error: job.error, ledger: job.ledger })
  for (const s of [item.admin_password, item.db_password, item.db_root_password, KEY_SECRET, "SMTPsecretPW987", "sessionSECRET"]) assert.ok(!visible.includes(s), s)
  assert.match(job.log, /are starting/)
  const site = (await listSites()).find(s => s.jobId === job.jobId)!
  assert.deepEqual([site.recipeId, site.url, site.adminUser, site.vault], ["ghost", "https://blog.example.com", "alex@example.com", { category: "apps", provider: "ghost-102" }])
  assert.equal(site.localUrl, "http://192.0.2.50:80", "a published site keeps its own address, which the card reads")
  assert.ok(nginx.ghostOn)
})

test("wizard: a failed setup stops Ghost, fails the job before anything is published, and hides the password", async () => {
  const f = new FakePve(), vault = new MemVault(), g = new FakeGhost()
  g.refuseOwner = { status: 500, body: "" }
  const scripts: string[] = []
  let proxied = 0
  const pub = publishFake()
  const d = deps(f, {
    publish: { ...pub, proxy: { ...pub.proxy, createHost: async () => { proxied++; return { hostId: "77" } } } },
    saveSecrets: vault.saveSecrets, readSecrets: vault.readSecrets, deleteSecrets: vault.deleteSecrets,
    exec: async (o: any) => ({ ...(await fakeShell(new FakeNginx(), scripts)(o.script)), timedOut: false }) as any,
    ghostHttp: () => g.http,
  })
  const r = await previewInstall(GHOST_INPUT({ options: { GHOST_TITLE: "News", GHOST_OWNER_NAME: "Alex", GHOST_OWNER_EMAIL: "alex@example.com" }, ghostSmtpPassword: undefined }), "a@example.com", d)
  assert.deepEqual(r.errors, [])
  assert.ok(r.warnings.includes(NO_MAIL))
  const job = await settled((await applyPreview(r.preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "failed")
  assert.match(job.error!, /Ghost refused the owner account \(500\)\. Ghost and nginx were stopped/)
  assert.equal(job.steps.find(s => s.id === "ghost-owner")!.status, "failed")
  assert.equal(job.steps.find(s => s.id === "proxy")!.status, "pending")
  assert.equal(proxied, 0, "nothing was published")
  assert.ok(scripts.some(s => /docker compose stop/.test(s)))
  assert.ok(job.created, "clean-up is offered")
  assert.ok(!JSON.stringify(job).includes(vault.items["apps/ghost-102"].admin_password))
})

test("SMTP password: required with a user, kept only in the vault, and an install without the preview's item stops", async () => {
  const vault = new MemVault()
  const v = { GHOST_TITLE: "News", GHOST_OWNER_NAME: "Alex", GHOST_OWNER_EMAIL: "a@example.com", GHOST_SMTP_HOST: "smtp.example.com", GHOST_SMTP_PORT: "587", GHOST_SMTP_SECURE: "0", GHOST_SMTP_USER: "apikey", GHOST_SMTP_FROM: "", GHOST_DESCRIPTION: "" }
  assert.match((await ghostPreview(v, "", vault)).errors.join(), /Enter the SMTP password/)
  assert.match((await ghostPreview(v, "a\nb", vault)).errors.join(), /Enter the SMTP password/)
  const relay = await ghostPreview({ ...v, GHOST_SMTP_USER: "" }, undefined, vault)
  assert.deepEqual([relay.errors, relay.options.GHOST_SMTP_REF], [[], ""], "a relay with no login needs no password")
  await assert.rejects(ghostInstallEnv({ options: { ...v, GHOST_SMTP_REF: "" }, domain: "blog.example.com" }, vault), /No SMTP password is planned/)
  await assert.rejects(ghostInstallEnv({ options: { ...v, GHOST_SMTP_REF: "22222222-2222-2222-2222-222222222222" }, domain: "blog.example.com" }, vault), /no longer in the vault/)
  assert.throws(() => pendingSmtpItem("../x"), /No SMTP password is planned/)
  const lan = await ghostInstallEnv({ options: { ...v, GHOST_SMTP_HOST: "", GHOST_SMTP_USER: "" }, ip: "192.0.2.50" }, vault)
  assert.equal(lan.env.GHOST_URL, "http://192.0.2.50", "on the LAN only, url is the container's own address")
  await assert.rejects(ghostInstallEnv({ options: v }, vault), /needs its address/)
})

// ── The AI assistant's website template ─────────────────────────────────────

test("assistant: Ghost is a kind it offers, asks for the owner's email and name, and plans the Ghost options", async () => {
  const { isWebsiteRequest, extractWebsite, nextQuestion, mergeWebsite, planWebsite } = await import("../src/lib/ai/templates/website")
  assert.ok(isWebsiteRequest("Create a Ghost blog at news.example.com"))
  assert.match(nextQuestion({}, { domains: ["example.com"] })!.question, /static site.*WordPress, or Ghost/)
  assert.ok(nextQuestion({}, { domains: ["example.com"] })!.choices.includes("Ghost"))
  let f = extractWebsite('Create a Ghost blog called "News" at news.example.com')
  assert.deepEqual([f.kind, f.domain, f.title], ["ghost", "news.example.com", "News"])
  assert.equal(nextQuestion(f, { domains: ["example.com"] })!.field, "adminEmail")
  f = mergeWebsite(f, extractWebsite("alex@example.com", "adminEmail"))
  assert.equal(nextQuestion(f, { domains: ["example.com"] })!.field, "ownerName")
  f = mergeWebsite(f, extractWebsite("Alex Doe", "ownerName"))
  assert.equal(f.ownerName, "Alex Doe")
  assert.equal(nextQuestion(f, { domains: ["example.com"] }), null)
  let sent: any = null
  const r = await planWebsite(f as any, "a@example.com", ["example.com"], {
    recipe: id => findRecipe(id), domains: async () => ["example.com"],
    proxies: async () => [{ id: "npm-1", name: "Edge", kind: "npm", certificates: "request" }],
    place: async () => ({ node: "node-a", storage: "pool", bridge: "vmbr0", vmid: 102, reason: "" }),
    preview: async input => { sent = input; return { preview: { id: "p1", plan: { vmid: 102, hostname: "news", node: "node-a", cores: 2, memoryMb: 2048, diskGb: 10, storage: "pool" }, checks: [], warnings: [], expiresAt: 0 }, errors: [], warnings: [] } },
  })
  assert.equal(r.kind, "card")
  assert.equal(sent.recipeId, "ghost")
  assert.deepEqual(sent.options, { GHOST_TITLE: "News", GHOST_OWNER_EMAIL: "alex@example.com", GHOST_OWNER_NAME: "Alex Doe" })
  assert.deepEqual([sent.cores, sent.memoryMb, sent.diskGb], [2, 2048, 10])
})
