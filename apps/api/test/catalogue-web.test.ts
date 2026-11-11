// Web hosting: the Static site and WordPress recipes, their scripts, the website publish plan and run, the
// clean-up that removes only what a run made, and the one-time WordPress admin sign-in.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  CATALOGUE, CATEGORY_LABELS, findRecipe, checkOptions, healthProblem, wizardRecipes,
  STATIC_SITE_SCRIPT, WORDPRESS_SCRIPT, WP_LOGIN_MU_PLUGIN,
} from "../src/lib/catalogue"
import { installScript, manualCommands } from "../src/lib/install-script"
import {
  planPublish, runPublish, cleanupPublish, makeAdminLogin, listSites, ADMIN_LINK_TTL_S,
  type PublishDeps, type PublishLedger, type DnsLike,
} from "../src/lib/sites"
import { previewInstall, applyPreview, removeFailedInstall } from "../src/lib/catalogue-installer"
import { requiredRole, needsReconfirm } from "../src/lib/roles"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

// ── Recipes ─────────────────────────────────────────────────────────────────

test("web recipes: a web category with a label, real health paths, and the six-point gaps said out loud", () => {
  const web = CATALOGUE.filter(r => r.category === "web").map(r => r.id)
  assert.deepEqual(web, ["static-site", "wordpress"])
  assert.equal(CATEGORY_LABELS.web, "Web hosting")
  for (const r of CATALOGUE) assert.ok(CATEGORY_LABELS[r.category], r.id)
  const s = findRecipe("static-site")!, w = findRecipe("wordpress")!
  assert.equal(s.healthPath, "/")
  assert.equal(w.healthPath, "/wp-login.php")
  for (const r of [s, w]) {
    assert.equal(r.port, 80)
    assert.ok(r.firstLogin, r.id)
    assert.ok(r.notes!.some(n => /^Not automatic yet: a backup job, monitoring with alerts, a place under the update policy and a plug-in panel/.test(n)), r.id)
  }
  // Static has no login and no first-run page, so the AI assistant may publish it; WordPress's generated
  // admin password cannot be handed back by the assistant, so it is not offered there.
  assert.ok(wizardRecipes().includes(s))
  assert.ok(!wizardRecipes().includes(w))
  assert.deepEqual(w.firstRun, { kind: "env-admin", passwordEnv: "WP_ADMIN_PASSWORD", user: "admin", userOption: "WP_ADMIN_USER",
    secrets: [{ env: "WP_DB_PASSWORD", vaultKey: "db_password" }] })
})

test("WordPress health needs PHP and the database: the login form, never PHP source or the database error", () => {
  const w = findRecipe("wordpress")!
  const form = '<form name="loginform" id="loginform" action="/wp-login.php" method="post">'
  assert.equal(healthProblem(w, 200, `<html>${form}</html>`), null)
  assert.match(healthProblem(w, 200, `<?php /* source */ ?>${form}`)!, /contains <\?php/)
  assert.match(healthProblem(w, 200, "<h1>Error establishing a database connection</h1>")!, /does not contain id="loginform"/)
  assert.match(healthProblem(w, 500, form)!, /answered 500/)
  assert.match(healthProblem(w, 200)!, /could not be read/)
  assert.match(healthProblem(w, null)!, /did not answer/)
  assert.equal(healthProblem(findRecipe("static-site")!, 200), null, "a recipe without healthBody needs only the status")
})

// ── Options ─────────────────────────────────────────────────────────────────

test("options: defaults fill in, unknown keys are dropped, and each kind refuses what a script must not see", () => {
  const s = findRecipe("static-site")!
  assert.deepEqual(checkOptions(s, {}), { values: { SITE_TITLE: "My site", SITE_REPO: "", SITE_BRANCH: "main", SITE_DIR: "", SITE_PULL_MINUTES: "0" }, errors: [] })
  assert.deepEqual(checkOptions(s, { SITE_REPO: " https://git.example.com/team/site.git ", SITE_PULL_MINUTES: 15, EVIL: "x" }).values,
    { SITE_TITLE: "My site", SITE_REPO: "https://git.example.com/team/site.git", SITE_BRANCH: "main", SITE_DIR: "", SITE_PULL_MINUTES: "15" })
  const bad = (o: Record<string, unknown>, re: RegExp) => assert.match(checkOptions(s, o).errors.join(" | "), re)
  bad({ SITE_REPO: "https://user:pw@git.example.com/x.git" }, /no user name, password/)
  bad({ SITE_REPO: "http://git.example.com/x.git" }, /https:\/\//)
  bad({ SITE_REPO: "https://git.example.com/x.git; rm -rf /" }, /https:\/\//)
  bad({ SITE_REPO: "--upload-pack=touch /tmp/x" }, /https:\/\//)
  bad({ SITE_BRANCH: "-x" }, /not a branch/)
  bad({ SITE_BRANCH: "a..b" }, /not a branch/)
  bad({ SITE_DIR: "../etc" }, /no "\.\."/)
  bad({ SITE_DIR: "/etc" }, /no "\.\."/)
  bad({ SITE_PULL_MINUTES: "1441" }, /between 0 and 1440/)
  bad({ SITE_PULL_MINUTES: "5; reboot" }, /whole number/)
  bad({ SITE_REPO: { x: 1 } }, /not a value/)

  const w = findRecipe("wordpress")!
  assert.match(checkOptions(w, {}).errors.join(" | "), /Admin user name is required.*Admin email is required/)
  const ok = checkOptions(w, { WP_TITLE: "It's “quoted” $HOME", WP_ADMIN_USER: "owner", WP_ADMIN_EMAIL: "owner@example.com", WP_REDIS: false })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.values.WP_REDIS, "0")
  assert.equal(ok.values.WP_TITLE, "It's “quoted” $HOME")
  assert.match(checkOptions(w, { WP_TITLE: "a\nb", WP_ADMIN_USER: "owner", WP_ADMIN_EMAIL: "o@example.com" }).errors.join(), /one line/)
  assert.match(checkOptions(w, { WP_ADMIN_USER: "Owner Name", WP_ADMIN_EMAIL: "o@example.com" }).errors.join(), /lowercase/)
  assert.match(checkOptions(w, { WP_ADMIN_USER: "owner", WP_ADMIN_EMAIL: "not-an-email" }).errors.join(), /not an email/)
})

// ── Scripts ─────────────────────────────────────────────────────────────────

const WP_ENV = { WP_TITLE: "Blog", WP_ADMIN_USER: "owner", WP_ADMIN_EMAIL: "o@example.com", WP_URL: "", WP_REDIS: "1",
  WP_ADMIN_PASSWORD: "ADMINsecretVALUE123", WP_DB_PASSWORD: "DBsecretVALUE456" }

test("no secret on any command line: generated passwords appear once, in an export, and reach commands on stdin", () => {
  const sh = installScript(findRecipe("wordpress")!, "debian", WP_ENV)
  for (const v of [WP_ENV.WP_ADMIN_PASSWORD, WP_ENV.WP_DB_PASSWORD]) {
    const lines = sh.split("\n").filter(l => l.includes(v))
    assert.equal(lines.length, 1, v)
    assert.match(lines[0], /^export WP_(ADMIN|DB)_PASSWORD='/)
  }
  // Out of every child's environment straight away.
  assert.match(WORDPRESS_SCRIPT, /^export -n WP_ADMIN_PASSWORD WP_DB_PASSWORD$/m)
  // Every use of the shell copies is a here-string, or inside the SQL heredoc fed to mariadb on stdin.
  const sqlStart = WORDPRESS_SCRIPT.indexOf("mariadb <<SQL"), sqlEnd = WORDPRESS_SCRIPT.indexOf("\nSQL\n", sqlStart)
  WORDPRESS_SCRIPT.split("\n").forEach((line, i, all) => {
    if (!/\$(ADMIN_PW|DB_PW)\b/.test(line)) return
    if (/^(ADMIN_PW|if \[ -z)/.test(line)) return // the copy, and the empty check
    const at = all.slice(0, i).join("\n").length
    if (at > sqlStart && at < sqlEnd) return
    assert.match(line, /<<<"\$(ADMIN_PW|DB_PW)"/, `secret used outside stdin: ${line}`)
  })
  assert.doesNotMatch(WORDPRESS_SCRIPT, /--(admin_password|dbpass|user_pass)=/)
  // The manual commands never carry a generated value.
  const manual = manualCommands(findRecipe("wordpress")!, "debian").join("\n")
  assert.doesNotMatch(manual, /ADMINsecret|DBsecret/)
})

test("an env-admin script recipe refuses to build without every generated secret", () => {
  const w = findRecipe("wordpress")!
  const { WP_DB_PASSWORD: _d, ...noDb } = WP_ENV
  assert.throws(() => installScript(w, "debian", noDb), /WP_DB_PASSWORD/)
  const { WP_ADMIN_PASSWORD: _a, ...noAdmin } = WP_ENV
  assert.throws(() => installScript(w, "debian", noAdmin), /WP_ADMIN_PASSWORD/)
})

test("scripts are safe to run again: nothing is created twice and nothing a person put there is overwritten", () => {
  // Static: the placeholder only into an empty folder, the repository fetched into place, links forced.
  assert.match(STATIC_SITE_SCRIPT, /elif \[ -z "\$\(ls -A \/var\/www\/site\)" \]; then/)
  assert.match(STATIC_SITE_SCRIPT, /\[ -d "\$SRC\/\.git" \] \|\| git -C "\$SRC" init -q/)
  assert.match(STATIC_SITE_SCRIPT, /git -C "\$SRC" remote remove origin 2>\/dev\/null \|\| true/)
  assert.match(STATIC_SITE_SCRIPT, /ln -sf \/etc\/nginx\/sites-available\/site/)
  assert.match(STATIC_SITE_SCRIPT, /systemctl disable --now site-pull\.timer 2>\/dev\/null \|\| true/)
  assert.doesNotMatch(STATIC_SITE_SCRIPT, /rm -rf/)
  // Settings are written quoted, so sourcing them runs nothing.
  assert.match(STATIC_SITE_SCRIPT, /printf 'SITE_REPO=%q\\n' "\$SITE_REPO"/)
  // WordPress: database and user if missing, core only once, the admin password reset on a re-run.
  assert.match(WORDPRESS_SCRIPT, /CREATE DATABASE IF NOT EXISTS wordpress/)
  assert.match(WORDPRESS_SCRIPT, /CREATE USER IF NOT EXISTS 'wordpress'@'localhost'/)
  assert.match(WORDPRESS_SCRIPT, /ALTER USER 'wordpress'@'localhost' IDENTIFIED BY '\$DB_PW'/)
  assert.match(WORDPRESS_SCRIPT, /if ! \[ -f \$WP_DIR\/wp-load\.php \]; then/)
  assert.match(WORDPRESS_SCRIPT, /if wpc core is-installed 2>\/dev\/null; then/)
  assert.match(WORDPRESS_SCRIPT, /wpc user update "\$WP_ADMIN_USER" --prompt=user_pass <<<"\$ADMIN_PW"/)
  assert.match(WORDPRESS_SCRIPT, /grep -q HTTP_X_FORWARDED_PROTO/)
  assert.match(WORDPRESS_SCRIPT, /wpc redis enable --force/)
  // Both run under umask 022: the installer's 077 would leave files nginx cannot read.
  for (const s of [STATIC_SITE_SCRIPT, WORDPRESS_SCRIPT]) assert.match(s, /^umask 022$/m)
})

test("hardening and headers are in the scripts, and only the web server listens beyond localhost", () => {
  for (const s of [STATIC_SITE_SCRIPT, WORDPRESS_SCRIPT]) {
    assert.match(s, /listen 80 default_server;/)
    assert.match(s, /X-Content-Type-Options "nosniff" always/)
    assert.match(s, /gzip on;/)
    assert.match(s, /Cache-Control "public, max-age=2592000"/)
    assert.match(s, /location ~ \/\\\.\(\?!well-known\/\) \{ return 404; \}/)
    assert.match(s, /server_tokens off;/)
  }
  assert.match(STATIC_SITE_SCRIPT, /add_header Cache-Control "no-cache";/)
  assert.match(WORDPRESS_SCRIPT, /config set DISALLOW_FILE_EDIT true --raw/)
  assert.match(WORDPRESS_SCRIPT, /config set WP_AUTO_UPDATE_CORE minor/)
  assert.match(WORDPRESS_SCRIPT, /location = \/xmlrpc\.php \{ return 403; \}/)
  assert.match(WORDPRESS_SCRIPT, /sha512sum -c --quiet/)
  assert.match(WORDPRESS_SCRIPT, /sha1sum -c --quiet/)
  assert.doesNotMatch(WORDPRESS_SCRIPT, /bind-address|0\.0\.0\.0:3306/)
})

test("the static starter page escapes the site title for HTML", () => {
  assert.match(STATIC_SITE_SCRIPT, /sed -e 's\/&\/\\&amp;\/g' -e 's\/<\/\\&lt;\/g'/)
  assert.match(STATIC_SITE_SCRIPT, /"<h1>\$TITLE<\/h1>"/)
})

test("a script recipe's options reach it quoted, and unset ones are exported empty", () => {
  const sh = installScript(findRecipe("static-site")!, "debian", { SITE_REPO: "https://git.example.com/a.git" })
  assert.match(sh, /^export SITE_REPO='https:\/\/git\.example\.com\/a\.git'$/m)
  assert.match(sh, /^export SITE_BRANCH='main'$/m)
  assert.match(sh, /^export SITE_DIR=''$/m)
  const t = installScript(findRecipe("wordpress")!, "debian", { ...WP_ENV, WP_TITLE: "It's $(reboot)" })
  assert.match(t, /^export WP_TITLE='It'\\''s \$\(reboot\)'$/m)
})

// ── Publishing ──────────────────────────────────────────────────────────────

class FakeDns implements DnsLike {
  records: Record<string, Array<{ type: string; name: string; data: string; ttl?: number }>> = {
    "example.com": [{ type: "A", name: "@", data: "198.51.100.1" }, { type: "CNAME", name: "www", data: "example.com" }],
    "shop.example.com": [],
  }
  created: any[] = []; deleted: any[] = []
  async getDomains() { return [{ domain: "example.com", status: "ACTIVE" }, { domain: "shop.example.com", status: "ACTIVE" }] }
  async getRecords(z: string) { return structuredClone(this.records[z] ?? []) }
  async createRecord(z: string, r: any) { this.created.push([z, r]); this.records[z].push({ ...r }) }
  async deleteRecord(z: string, type: string, name: string) { this.deleted.push([z, type, name]); this.records[z] = this.records[z].filter(r => !(r.type === type && r.name === name)) }
}

function publishDeps(o: Partial<PublishDeps> & { dnsFake?: FakeDns } = {}) {
  const dns = o.dnsFake ?? new FakeDns()
  const calls: string[] = []
  const d: PublishDeps = {
    dns: async () => dns,
    proxy: {
      instances: async () => [
        { id: "npm-1", name: "Edge NPM", kind: "npm", status: "ok", certificates: "request" },
        { id: "caddy-1", name: "Caddy", kind: "caddy", status: "ok", certificates: "provider" },
        { id: "ha-1", name: "HAProxy", kind: "haproxy", status: "ok", certificates: "none" },
        { id: "locked-1", name: "Locked", kind: "npm", status: "locked", certificates: "request" },
      ],
      createHost: async (i, spec) => { calls.push(`host ${i} ${spec.domains.join()} -> ${spec.forwardHost}:${spec.forwardPort}`); return { hostId: "77" } },
      attachCertificate: async (i, h, c) => { calls.push(`attach ${i} ${h} ${c}`) },
      deleteHost: async (i, h) => { calls.push(`delete-host ${i} ${h}`) },
      requestCertificate: async (i, names) => { calls.push(`cert ${i} ${names.join()}`); return { id: "9" } },
    },
    wanIp: async () => "203.0.113.7",
    resolve4: async () => ["203.0.113.7"],
    letsEncryptEmail: () => "ops@example.com",
    fetchPublic: async () => ({ status: 200, body: '<form id="loginform">' }),
    wait: async () => {},
    ...o,
  }
  return { d, dns, calls }
}

test("publish plan: says the exact record, and refuses an existing record, an unlisted zone and a proxy that cannot do HTTPS", async () => {
  const { d } = publishDeps()
  const ok = await planPublish({ zone: "example.com", name: "blog", instanceId: "npm-1" }, d)
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.plan, { domain: "blog.example.com", zone: "example.com", name: "blog", instanceId: "npm-1", instanceName: "Edge NPM",
    record: { type: "A", name: "blog", data: "203.0.113.7", ttl: 600 }, certificate: "request" })
  assert.ok(ok.checks.some(c => c === "DNS: A record blog in example.com → 203.0.113.7 (TTL 600)."))

  const no = async (input: any, re: RegExp, dd = d) => {
    const r = await planPublish(input, dd)
    assert.equal(r.plan, undefined)
    assert.match(r.errors.join(" | "), re)
    return r
  }
  const www = await no({ zone: "example.com", name: "www", instanceId: "npm-1" }, /www\.example\.com already has a DNS record \(CNAME example\.com\)/)
  assert.deepEqual(www.existing, [{ type: "CNAME", data: "example.com" }])
  await no({ zone: "example.com", name: "", instanceId: "npm-1" }, /example\.com already has a DNS record \(A 198\.51\.100\.1\)/)
  await no({ zone: "other.org", name: "x", instanceId: "npm-1" }, /not one of the domains/)
  await no({ zone: "example.com", name: "a.shop", instanceId: "npm-1" }, /belongs to shop\.example\.com/)
  await no({ zone: "example.com", name: "Bad_Name", instanceId: "npm-1" }, /not a usable name/)
  await no({ zone: "example.com", name: "blog", instanceId: "ha-1" }, /cannot be asked for a certificate/)
  await no({ zone: "example.com", name: "blog", instanceId: "locked-1" }, /locked in the vault/)
  await no({ zone: "example.com", name: "blog", instanceId: "nope" }, /Pick the proxy/)
  await no({ zone: "example.com", name: "blog", instanceId: "npm-1" }, /No DNS provider/, { ...d, dns: async () => null })
  await no({ zone: "example.com", name: "blog", instanceId: "npm-1" }, /records of example\.com could not be read/,
    { ...d, dns: async () => ({ ...new FakeDns(), getDomains: new FakeDns().getDomains, getRecords: async () => { throw new Error("x") } }) as any })
  await no({ zone: "example.com", name: "blog", instanceId: "npm-1" }, /Let's Encrypt email/, { ...d, letsEncryptEmail: () => "" })

  // The apex is allowed when free, with a warning; a provider that gets its own certificate is not asked.
  const apex = await planPublish({ zone: "shop.example.com", name: "@", instanceId: "caddy-1" }, d)
  assert.equal(apex.plan?.name, "@")
  assert.equal(apex.plan?.certificate, "provider")
  assert.match(apex.warnings.join(), /is the domain itself/)
})

test("publish run: host, record, propagation, certificate, then the PUBLIC address; the ledger names each thing", async () => {
  const { d, dns, calls } = publishDeps()
  const plan = (await planPublish({ zone: "example.com", name: "blog", instanceId: "npm-1" }, d)).plan!
  const steps: Record<string, any> = {}
  const ledger: PublishLedger = {}
  const fetched: string[] = []
  const url = await runPublish(plan, findRecipe("wordpress")!, "192.0.2.80", "a@example.com", ledger,
    { step: id => (steps[id] = { status: "running" }), save: () => {} },
    { ...d, fetchPublic: async u => { fetched.push(u); return { status: 200, body: '<form id="loginform">' } } })
  assert.equal(url, "https://blog.example.com")
  assert.deepEqual(calls, ["host npm-1 blog.example.com -> 192.0.2.80:80", "cert npm-1 blog.example.com", "attach npm-1 77 9"])
  assert.deepEqual(dns.created, [["example.com", { type: "A", name: "blog", data: "203.0.113.7", ttl: 600 }]])
  assert.deepEqual(fetched, ["https://blog.example.com/wp-login.php"])
  assert.deepEqual(ledger, { proxyHost: { instanceId: "npm-1", hostId: "77" },
    dnsRecord: { zone: "example.com", type: "A", name: "blog", data: "203.0.113.7", ttl: 600 }, certificate: { instanceId: "npm-1", id: "9" } })
  assert.deepEqual(Object.values(steps).map(s => s.status), ["done", "done", "done", "done", "done"])
})

test("publish run: a record made after the plan is not touched, and a site whose public page fails is not passed", async () => {
  const { d, dns } = publishDeps()
  const plan = (await planPublish({ zone: "example.com", name: "blog", instanceId: "npm-1" }, d)).plan!
  dns.records["example.com"].push({ type: "AAAA", name: "blog", data: "2001:db8::1" })
  const ledger: PublishLedger = {}
  const hooks = { step: () => ({ status: "running" }), save: () => {} }
  await assert.rejects(runPublish(plan, findRecipe("static-site")!, "192.0.2.80", "a", ledger, hooks, d), /got a AAAA record since the plan/)
  assert.deepEqual(dns.created, [])
  assert.deepEqual(Object.keys(ledger), ["proxyHost"])

  const e = publishDeps()
  const l2: PublishLedger = {}
  await assert.rejects(runPublish(plan, findRecipe("static-site")!, "192.0.2.80", "a", l2, hooks,
    { ...e.d, resolve4: async () => [] }), /did not resolve .* Stopped before the certificate/)
  assert.equal(l2.certificate, undefined)
  const f = publishDeps()
  await assert.rejects(runPublish(plan, findRecipe("wordpress")!, "192.0.2.80", "a", {}, hooks,
    { ...f.d, fetchPublic: async () => ({ status: 200, body: "<?php echo 1;" }) }), /https:\/\/blog\.example\.com\/wp-login\.php answered 200, but the page does not contain/)
})

test("clean-up scope: only the ledger's host and record, and a record that changed since is kept", async () => {
  const { d, dns, calls } = publishDeps()
  dns.records["example.com"].push({ type: "A", name: "blog", data: "203.0.113.7" })
  const ledger: PublishLedger = { proxyHost: { instanceId: "npm-1", hostId: "77" },
    dnsRecord: { zone: "example.com", type: "A", name: "blog", data: "203.0.113.7" }, certificate: { instanceId: "npm-1", id: "9" } }
  const lines = await cleanupPublish(ledger, "a", d)
  assert.deepEqual(dns.deleted, [["example.com", "A", "blog"]])
  assert.deepEqual(calls, ["delete-host npm-1 77"])
  assert.match(lines.join(" "), /Removed the DNS record blog\.example\.com → 203\.0\.113\.7\. Removed the proxy host\. The certificate was left/)
  assert.equal(ledger.dnsRecord, undefined); assert.equal(ledger.proxyHost, undefined)
  // The root record and the www CNAME were never touched.
  assert.deepEqual(dns.records["example.com"].map(r => r.name), ["@", "www"])

  const g = publishDeps()
  g.dns.records["example.com"].push({ type: "A", name: "blog", data: "198.51.100.99" })
  const kept: PublishLedger = { dnsRecord: { zone: "example.com", type: "A", name: "blog", data: "203.0.113.7" } }
  assert.match((await cleanupPublish(kept, "a", g.d)).join(), /was kept: it no longer holds only 203\.0\.113\.7/)
  assert.deepEqual(g.dns.deleted, [])
  assert.deepEqual(await cleanupPublish({}, "a", g.d), [], "an empty ledger removes nothing")
})

// ── Through the catalogue wizard ────────────────────────────────────────────

const WP_INPUT = (o: any = {}) => INPUT({ recipeId: "wordpress", hostname: "blog", memoryMb: 2048, diskGb: 10,
  options: { WP_TITLE: "Blog", WP_ADMIN_USER: "owner", WP_ADMIN_EMAIL: "o@example.com" },
  publish: { zone: "example.com", name: "blog", instanceId: "npm-1" }, ...o })

test("wizard: a website preview holds the options and the exact publish plan, and the run publishes and lists the site", async () => {
  const f = new FakePve()
  const p = publishDeps()
  const saved: any[] = []
  let script = ""
  const d = deps(f, { publish: p.d, saveSecrets: async (c, pr, v) => { saved.push([c, pr, Object.keys(v)]) },
    exec: async (o: any) => { script = o.script; return { code: 0, output: "", timedOut: false } as any },
    probe: async () => ({ status: 200, body: '<form id="loginform">' }) })
  const r = await previewInstall(WP_INPUT(), "a@example.com", d)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.preview!.plan.options, { WP_TITLE: "Blog", WP_TAGLINE: "", WP_ADMIN_USER: "owner", WP_ADMIN_EMAIL: "o@example.com", WP_URL: "", WP_REDIS: "1" })
  assert.equal(r.preview!.plan.publish!.record.data, "203.0.113.7")
  assert.equal(p.dns.created.length, 0, "a preview writes nothing")

  const job = await settled((await applyPreview(r.preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.equal(job.url, "https://blog.example.com")
  assert.deepEqual(job.steps.map(s => s.id), ["container", "network", "install", "verify", "wire", "proxy", "dns", "propagate", "cert", "public"])
  // Both generated secrets in one vault item; the admin user is the one chosen.
  assert.deepEqual(saved, [["apps", "wordpress-102", ["admin_user", "admin_password", "db_password"]]])
  assert.match(script, /^export WP_ADMIN_USER='owner'$/m)
  assert.equal(job.adminCredential?.user, "owner")
  const site = (await listSites()).find(s => s.jobId === job.jobId)!
  assert.deepEqual([site.domain, site.url, site.localUrl, site.adminUser, site.vault], ["blog.example.com", "https://blog.example.com",
    "http://192.0.2.50:80", "owner", { category: "apps", provider: "wordpress-102" }])
})

test("wizard: a non-website cannot be published, and a record made between preview and apply refuses the apply", async () => {
  const f = new FakePve(), p = publishDeps()
  const d = deps(f, { publish: p.d })
  const k = await previewInstall(INPUT({ publish: { zone: "example.com", name: "kuma", instanceId: "npm-1" } } as any), "a@example.com", d)
  assert.match(k.errors.join(), /only websites are/)
  const r = await previewInstall(WP_INPUT(), "a@example.com", d)
  p.dns.records["example.com"].push({ type: "A", name: "blog", data: "198.51.100.5" })
  await assert.rejects(applyPreview(r.preview!.id, "a@example.com", d), (e: any) => e.code === "changed" && /already has a DNS record/.test(e.problems.join()))
  assert.equal(f.creates.length, 0)
})

test("wizard clean-up after a failed publish removes the container, the proxy host and the record this run made, nothing else", async () => {
  const f = new FakePve(), p = publishDeps()
  const d = deps(f, { publish: { ...p.d, fetchPublic: async () => null },
    probe: async () => ({ status: 200, body: '<form id="loginform">' }) })
  const r = await previewInstall(WP_INPUT(), "a@example.com", d)
  const job = await settled((await applyPreview(r.preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "failed")
  assert.match(job.error!, /did not answer/)
  assert.equal(job.steps.find(s => s.id === "public")!.status, "failed")
  const msg = await removeFailedInstall(job.jobId, "a@example.com", d)
  assert.match(msg, /CT 102 was removed.*Removed the DNS record blog\.example\.com.*Removed the proxy host\. The certificate was left/)
  assert.deepEqual(f.deletes, ["102"])
  assert.deepEqual(p.dns.deleted, [["example.com", "A", "blog"]])
  assert.deepEqual(p.calls.filter(c => c.startsWith("delete-host")), ["delete-host npm-1 77"])
})

// ── The one-time admin sign-in ──────────────────────────────────────────────

const SITE = { id: "s1", recipeId: "wordpress", name: "blog.example.com", vmid: 102, node: "node-a", url: "https://blog.example.com",
  adminUser: "owner", jobId: "j", owner: "a", createdAt: 0 }

test("admin sign-in: a 256-bit token, only its hash in the script, 60 seconds, POSTed to the site", () => {
  const now = Date.UTC(2026, 0, 1)
  const a = makeAdminLogin(SITE, now), b = makeAdminLogin(SITE, now)
  assert.notEqual(a.token, b.token)
  assert.equal(Buffer.from(a.token, "base64url").length, 32)
  assert.ok(!a.script.includes(a.token), "the token never goes into the container")
  assert.ok(a.script.includes(createHash("sha256").update(a.token).digest("hex")))
  assert.equal(a.expiresAt, now + ADMIN_LINK_TTL_S * 1000)
  assert.equal(ADMIN_LINK_TTL_S, 60)
  assert.equal(a.postUrl, "https://blog.example.com/wp-login.php?action=hyperprox")
  assert.ok(!a.postUrl.includes(a.token), "never in a URL, where access logs keep it")
  // The stored value goes to WP-CLI on standard input, not as an argument.
  assert.match(a.script, /option update hyperprox_login --format=json --autoload=no >\/dev\/null <<'HP_LOGIN'\n\{"hash":"[0-9a-f]{64}","exp":\d+,"user":"owner"\}\nHP_LOGIN/)
  assert.throws(() => makeAdminLogin({ ...SITE, recipeId: "static-site" }), /Only a WordPress site/)
  assert.throws(() => makeAdminLogin({ ...SITE, adminUser: "x'; DROP" }), /no admin user/)
})

test("the sign-in plug-in: POST only, burned before it is compared, expiry checked, administrators only", () => {
  const p = WP_LOGIN_MU_PLUGIN
  assert.match(p, /add_action\('login_form_hyperprox'/)
  assert.match(p, /\$_SERVER\['REQUEST_METHOD'\] !== 'POST'/)
  assert.ok(p.indexOf("delete_option('hyperprox_login')") < p.indexOf("hash_equals"), "single use, right or wrong")
  assert.match(p, /time\(\) > \(int\) \$saved\['exp'\]/)
  assert.match(p, /user_can\(\$user, 'manage_options'\)/)
  assert.match(WORDPRESS_SCRIPT, /mu-plugins\/hyperprox-login\.php <<'PHP'\n<\?php/)
})

test("roles: every /api/sites route is admin, and the admin sign-in needs the master password again", () => {
  assert.equal(requiredRole("GET", "/api/sites"), "admin")
  assert.equal(requiredRole("GET", "/api/sites/s1/health"), "admin")
  assert.equal(requiredRole("POST", "/api/sites/s1/pull"), "admin")
  assert.equal(needsReconfirm("POST", "/api/sites/s1/admin-login"), true)
  assert.equal(needsReconfirm("POST", "/api/sites/s1/pull"), false)
})

test("the AI assistant matches the static site by name, and never WordPress", async () => {
  const { matchRecipe } = await import("../src/lib/catalogue")
  for (const n of ["static site", "Static-Site", "static-site"]) assert.equal(matchRecipe(n).recipe?.id, "static-site")
  const ids = wizardRecipes().map(r => r.id)
  assert.ok(ids.includes("static-site"))
  assert.ok(!ids.includes("wordpress"), "the assistant cannot hand back a generated admin password")
})
