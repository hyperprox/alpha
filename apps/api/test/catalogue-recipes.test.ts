// The one install-recipe source: the script built from a recipe, distro detection and service-name matching.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CATALOGUE, findRecipe, matchRecipe, wizardRecipes } from "../src/lib/catalogue"
import { installScript, distroOf, manualCommands, DOCKER_PACKAGES } from "../src/lib/install-script"

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
    ["gitea", "grafana", "homepage", "jellyfin", "nextcloud", "uptime-kuma", "vaultwarden"])
  for (const r of w) {
    assert.ok(r.healthPath.startsWith("/"), r.id)
    assert.ok(r.expectStatus.length > 0, r.id)
    assert.ok(["none", "setup-url", "env-admin"].includes(r.firstRun.kind), r.id)
    assert.equal(r.install.kind, "compose", r.id)
  }
  assert.deepEqual(findRecipe("uptime-kuma")!.expectStatus, [200, 302])
  for (const id of ["nginx-proxy-manager", "ollama", "tautulli"]) assert.equal(findRecipe(id)!.wizard, false)
  assert.equal(CATALOGUE.length, 10)
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
