// The one install-recipe source: the script built from a recipe, distro detection and service-name matching.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CATALOGUE, findRecipe, matchRecipe, wizardRecipes } from "../src/lib/catalogue"
import { installScript, distroOf, manualCommands, hostEnv, DOCKER_PACKAGES } from "../src/lib/install-script"

test("installScript: set -e, noninteractive, distro packages, quiet pull, no || fallback", () => {
  const deb = installScript(findRecipe("uptime-kuma")!, "debian")
  assert.equal(deb.split("\n")[0], "set -e")
  assert.match(deb, /DEBIAN_FRONTEND=noninteractive/)
  assert.match(deb, /apt-get install -y -qq ca-certificates curl docker\.io docker-compose$/m)
  assert.doesNotMatch(deb, /docker-compose-v2|\|\|/)
  assert.match(deb, /docker compose up -d --quiet-pull/)
  assert.match(installScript(findRecipe("uptime-kuma")!, "ubuntu"), /docker-compose-v2/)
})

test("a script recipe gets set -e and no Docker packages", () => {
  const s = installScript(findRecipe("ollama")!, "debian")
  assert.equal(s.split("\n")[0], "set -e")
  assert.equal(s.match(/^set -e$/gm)!.length, 1)
  assert.doesNotMatch(s, /docker\.io/)
})

test("distroOf reads template volids and ostype", () => {
  assert.equal(distroOf("tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"), "debian")
  assert.equal(distroOf("ubuntu"), "ubuntu")
  assert.equal(distroOf("alpine-3.20-default"), null)
  assert.equal(distroOf("tmpl:vztmpl/alpine-3.20-default_amd64.tar.xz"), null)
})

test("matchRecipe normalises, suggests, and never matches prototype keys", () => {
  for (const n of ["uptime kuma", "Uptime-Kuma", "UPTIME KUMA "]) assert.equal(matchRecipe(n).recipe?.id, "uptime-kuma")
  const k = matchRecipe("kuma")
  assert.equal(k.recipe, undefined)
  assert.equal(k.suggestions[0].id, "uptime-kuma")
  for (const n of ["toString", "__proto__", "constructor", ""]) assert.equal(matchRecipe(n).recipe, undefined)
})

test("every wizard recipe has a health path, an expected status and a first-run kind", () => {
  const w = wizardRecipes()
  assert.deepEqual(w.map(r => r.id).sort(),
    ["gitea", "homepage", "jellyfin", "nextcloud", "static-site", "uptime-kuma"])
  for (const r of w) {
    assert.ok(r.healthPath.startsWith("/"), r.id)
    assert.ok(r.expectStatus.length > 0, r.id)
    assert.ok(["none", "setup-url", "env-admin"].includes(r.firstRun.kind), r.id)
    // Compose, or a script recipe with no Docker (the static site is nginx on the container itself).
    assert.ok(r.install.kind === "compose" || !r.needsDocker, r.id)
  }
  assert.deepEqual(findRecipe("uptime-kuma")!.expectStatus, [200, 302])
  for (const id of ["nginx-proxy-manager", "ollama", "tautulli", "grafana", "vaultwarden", "wordpress"]) assert.equal(findRecipe(id)!.wizard, false)
  // The wizard cannot hand a generated admin secret back yet, so no wizard recipe needs one.
  for (const r of w) assert.notEqual(r.firstRun.kind, "env-admin", r.id)
  assert.equal(CATALOGUE.length, 15)
})

test("env values reach the script quoted, in a private .env, and bad names are refused", () => {
  const g = installScript(findRecipe("grafana")!, "debian", { GF_SECURITY_ADMIN_PASSWORD: "it's $x" })
  assert.match(g, /umask 077\ncat > \.env <<'HP_ENV'\nGF_SECURITY_ADMIN_PASSWORD=it's \$x\nHP_ENV/)
  const o = installScript(findRecipe("ollama")!, "debian", { A: "it's" })
  assert.match(o, /export A='it'\\''s'/)
  assert.throws(() => installScript(findRecipe("ollama")!, "debian", { "A;rm": "x" }), /Invalid environment/)
})

test("manual commands carry the distro's packages and no secrets", () => {
  const c = manualCommands(findRecipe("gitea")!, "ubuntu").join("\n")
  assert.match(c, new RegExp(DOCKER_PACKAGES.ubuntu.join(" ")))
  assert.doesNotMatch(c, /docker-compose( |$)/m)
})

test("an env-admin recipe refuses to build a script without its admin password", () => {
  assert.throws(() => installScript(findRecipe("grafana")!, "debian"), /GF_SECURITY_ADMIN_PASSWORD/)
  assert.doesNotMatch(findRecipe("grafana")!.install.kind === "compose" ? (findRecipe("grafana")!.install as any).compose : "", /:-admin/)
  assert.doesNotMatch(manualCommands(findRecipe("grafana")!, "debian").join("\n"), /GF_SECURITY_ADMIN_PASSWORD=(?!\$\{)\S/)
})

test("Homepage is told the Host it is reached by: its own address and port, plus the public name", () => {
  const r = findRecipe("homepage")!
  assert.equal(r.install.kind, "compose")
  assert.match((r.install as any).compose, /HOMEPAGE_ALLOWED_HOSTS=\$\{HOMEPAGE_ALLOWED_HOSTS:\?/)
  assert.deepEqual(hostEnv(r, { ip: "10.0.0.37" }), { HOMEPAGE_ALLOWED_HOSTS: "10.0.0.37:3000" })
  assert.deepEqual(hostEnv(r, { ip: "10.0.0.37", domain: "home.example.com" }), { HOMEPAGE_ALLOWED_HOSTS: "10.0.0.37:3000,home.example.com" })
  assert.throws(() => hostEnv(r, {}), /address/)
  assert.deepEqual(hostEnv(findRecipe("gitea")!, {}), {}, "a recipe that does not check Host needs nothing")
  const s = installScript(r, "debian", hostEnv(r, { ip: "10.0.0.37" }))
  assert.match(s, /\nHOMEPAGE_ALLOWED_HOSTS=10\.0\.0\.37:3000\n/)
  assert.throws(() => installScript(r, "debian"), /HOMEPAGE_ALLOWED_HOSTS/, "never started on a default that refuses its own health check")
  assert.match(manualCommands(r, "debian").join("\n"), /HOMEPAGE_ALLOWED_HOSTS/)
})

test("Vaultwarden starts with sign-ups off and a generated admin token, never a default", () => {
  const r = findRecipe("vaultwarden")!
  assert.deepEqual(r.firstRun, { kind: "env-admin", passwordEnv: "ADMIN_TOKEN", user: "/admin" })
  const compose = (r.install as any).compose as string
  assert.match(compose, /- SIGNUPS_ALLOWED=false$/m)
  assert.match(compose, /- ADMIN_TOKEN=\$\{ADMIN_TOKEN:\?the installer sets this\}/)
  assert.throws(() => installScript(r, "debian"), /ADMIN_TOKEN/)
  const s = installScript(r, "debian", { ADMIN_TOKEN: "tok" })
  assert.match(s, /\nADMIN_TOKEN=tok\n/)
  assert.match(s, /SIGNUPS_ALLOWED=false/)
})
