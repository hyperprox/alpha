// The catalogue's Plex Media Server entry: the recipe and its pinned package, the install script's checks, Plex's own answers
// (recorded from a real install, with invented identifiers), the setup chores with read-backs, the claim through a Sign in
// with Plex made in the wizard (the account token held in memory only and dropped after use), the preview and the wizard
// end to end on a fake cluster, the no-sign-in and failed-claim paths, and nothing of a real cluster in what ships.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { CATALOGUE, findRecipe, checkOptions } from "../src/lib/catalogue"
import { DETECT } from "../src/lib/catalogue-detect"
import { PLEX_RECIPE, PLEX_ID, TRANSCODE_IDS } from "../src/lib/transcode/recipes"
import { PLEX_SCRIPT, PLEX_VERSION, PLEX_DEB_SHA256, PLEX_KEY_SHA256, plexScriptEnv, NVIDIA_RUN_SHA256 } from "../src/lib/transcode/compose"
import { PlexAuthRefused, parseIdentity, waitForPlex, claimServer, enableHardwareTranscoding, addLibraries, browse, plexUrl, type PlexClaimDeps } from "../src/lib/transcode/plex"
import { tcInstallEnv, tcJobSteps, tcRunSetup } from "../src/lib/transcode/catalogue"
import { judgeMedia } from "../src/lib/transcode/media"
import { layoutFromOptions } from "../src/lib/transcode/media"
import { installScript } from "../src/lib/install-script"
import { PlexSignin, PlexSigninError, CLAIM_HOLD_MS, type PlexHttp } from "../src/lib/plex-signin"
import type { ArrDeps } from "../src/lib/arr/catalogue"
import { previewInstall, applyPreview, removeFailedInstall } from "../src/lib/catalogue-installer"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const OWNER = "a@example.com"
const FX = join(__dirname, "fixtures", "plex-pms")
const fx = (n: string) => readFileSync(join(FX, n), "utf8")
const MACHINE = "0123456789abcdef0123456789abcdef01234567"

// ── The recipe ──────────────────────────────────────────────────────────────

test("recipe: Plex is one catalogue entry on the transcode stack, a package and not Docker, pinned, satisfying the Plex plug-in", () => {
  assert.equal(CATALOGUE.filter(r => r.id === PLEX_ID).length, 1)
  assert.equal(findRecipe("plex"), PLEX_RECIPE)
  assert.ok((TRANSCODE_IDS as readonly string[]).includes("plex"))
  assert.equal(PLEX_RECIPE.stack, "transcode"); assert.equal(PLEX_RECIPE.needsDocker, false)
  assert.equal(PLEX_RECIPE.port, 32400); assert.equal(PLEX_RECIPE.healthPath, "/identity")
  assert.deepEqual(PLEX_RECIPE.satisfies, { kind: "plugin", id: "plex", setting: "plex_url" })
  assert.deepEqual(PLEX_RECIPE.firstRun, { kind: "none" })
  assert.equal(PLEX_RECIPE.wizard, false, "the AI assistant cannot sign anyone in to Plex")
  assert.equal(PLEX_RECIPE.wantsGpu, true)
  assert.match(PLEX_VERSION, /^\d+\.\d+\.\d+\.\d+-[0-9a-f]{9}$/)
  assert.match(PLEX_DEB_SHA256, /^[0-9a-f]{64}$/); assert.match(PLEX_KEY_SHA256, /^[0-9a-f]{64}$/)
  assert.ok(PLEX_RECIPE.notes!.some(n => n.includes(PLEX_VERSION)), "the notes say which build is installed")
  assert.ok(PLEX_RECIPE.notes!.some(n => /Plex Pass/.test(n)), "the notes say hardware transcoding needs a Plex Pass")
  assert.ok(PLEX_RECIPE.notes!.some(n => /vault/.test(n)))
  for (const o of PLEX_RECIPE.options!) assert.match(o.key, /^(TC|PLEX)_[A-Z_]+$/)
  assert.equal(PLEX_RECIPE.detect, DETECT.plex)
})

test("recipe: its options keep the sign-in to an id and refuse anything else", () => {
  const ok = checkOptions(PLEX_RECIPE, { PLEX_SIGNIN: "3f2b9c1e-5d4a-4c1b-9e2f-0a1b2c3d4e5f" })
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(checkOptions(PLEX_RECIPE, {}).errors, [])
  assert.ok(checkOptions(PLEX_RECIPE, { PLEX_SIGNIN: "claim-abcdef0123456789" }).errors.some(e => /not one HyperProx made/.test(e)))
  assert.ok(checkOptions(PLEX_RECIPE, { PLEX_SIGNIN: "x".repeat(41) }).errors.length > 0)
  assert.ok(checkOptions(PLEX_RECIPE, { TC_ACCEL: "magic" }).errors.length > 0)
})

test("detection: Plex's identity answer matches as JSON or XML, and nothing else does", () => {
  const f = DETECT.plex[0]
  assert.equal(f.path, "/identity")
  const ans = (status: number, body: string) => ({ status, headers: {}, body })
  assert.deepEqual(f.match(ans(200, fx("identity.json"))), { version: "1.43.5.11079-b3b13e506" })
  assert.deepEqual(f.match(ans(200, fx("identity.xml"))), { version: "1.43.5.11079-b3b13e506" })
  assert.equal(f.match(ans(404, fx("identity.json"))), null)
  assert.equal(f.match(ans(200, "<html><title>Tautulli</title></html>")), null)
  assert.equal(f.match(ans(200, JSON.stringify({ MediaContainer: { size: 0 } }))), null)
  assert.equal(f.match(ans(200, "not json")), null)
})

// ── The install script ──────────────────────────────────────────────────────

test("script: valid shell, never deletes data or prompts, installs the exact build and checks the key and package by hash", () => {
  const r = spawnSync("bash", ["-n"], { input: PLEX_SCRIPT })
  assert.equal(r.status, 0, r.stderr.toString())
  assert.doesNotMatch(PLEX_SCRIPT, /\brm -rf\b|\brm -r\b|\bmkfs\b|\bdd\b|apt-key/)
  assert.doesNotMatch(PLEX_SCRIPT, /(^|[;&|\s])read\s/m)
  for (const line of PLEX_SCRIPT.split("\n").filter(l => /apt-get install/.test(l))) assert.match(line, / -y /)
  // The exact build, never "latest" or an unversioned install.
  assert.match(PLEX_SCRIPT, /"plexmediaserver=\$PLEX_VERSION"/)
  assert.doesNotMatch(PLEX_SCRIPT, /apt-get install[^\n]*\bplexmediaserver\s*$/m)
  // The signing key is checked by hash before it is trusted, and the fallback package by hash before it is installed.
  assert.ok(PLEX_SCRIPT.indexOf('sha256sum -c') < PLEX_SCRIPT.indexOf("gpg --dearmor"))
  assert.match(PLEX_SCRIPT, /PLEX_KEY_SHA256  \/tmp\/plex\.key/)
  assert.match(PLEX_SCRIPT, /PLEX_DEB_SHA256  \/tmp\/plex\.deb/)
  assert.match(PLEX_SCRIPT, /signed-by=\/usr\/share\/keyrings\/plexmediaserver\.gpg\] https:\/\/repo\.plex\.tv\/deb public main/)
  // The repository file is written in its signed form again after the package, and checked.
  assert.ok(PLEX_SCRIPT.lastIndexOf("signed-by=/usr/share/keyrings/plexmediaserver.gpg") > PLEX_SCRIPT.indexOf('"plexmediaserver=$PLEX_VERSION"'))
  assert.match(PLEX_SCRIPT, /grep -q 'signed-by=\/usr\/share\/keyrings\/plexmediaserver\.gpg'/)
  // Plex runs as the stack's own uid and gid, and a library that cannot be written is not a failure (Plex only reads).
  assert.match(PLEX_SCRIPT, /useradd -u "\$TC_PUID" -g "\$TC_PGID"/)
  assert.doesNotMatch(PLEX_SCRIPT, /exit 4/)
  assert.doesNotMatch(PLEX_SCRIPT, /chown -R[^\n]*\/data/)
  // The graphics card: the render group of the node joins Plex's user; NVIDIA libraries are hash-checked before they run.
  assert.match(PLEX_SCRIPT, /usermod -aG "\$g" "\$PLEX_USER"/)
  assert.ok(PLEX_SCRIPT.indexOf("NVIDIA_SHA256  /tmp/nvidia.run") < PLEX_SCRIPT.indexOf("sh /tmp/nvidia.run"))
})

test("script: the generated install carries the pinned values and every option exported, in an environment a shell accepts", () => {
  const env = tcInstallEnv("plex", { options: { TC_ACCEL: "vaapi" }, groups: [993], ip: "192.0.2.60", hostname: "plex" })
  assert.equal(env.PLEX_VERSION, PLEX_VERSION); assert.equal(env.TC_GROUPS, "993"); assert.equal(env.TC_LIBRARY, "1")
  assert.equal(env.TC_PUID, "1000"); assert.equal(env.TC_PGID, "1000"); assert.equal(env.TC_NVIDIA_SHA256, "")
  const script = installScript(PLEX_RECIPE, "debian", env)
  const r = spawnSync("bash", ["-n"], { input: script })
  assert.equal(r.status, 0, r.stderr.toString())
  assert.match(script, /export PLEX_KEY_SHA256='9fa24313/)
  assert.doesNotMatch(script, /docker/i, "no Docker packages for a package install")
})

test("script env: NVIDIA needs the node's version and a hash pinned in HyperProx; any other version is refused", () => {
  assert.throws(() => plexScriptEnv({ accel: "nvidia", library: true }), /missing or not a version/)
  assert.throws(() => plexScriptEnv({ accel: "nvidia", library: true, nvidiaVersion: "999.99.99" }), /no pinned checksum/)
  const v = Object.keys(NVIDIA_RUN_SHA256)[0]
  const e = plexScriptEnv({ accel: "nvidia", library: true, nvidiaVersion: v })
  assert.equal(e.TC_NVIDIA_VERSION, v); assert.equal(e.TC_NVIDIA_SHA256, NVIDIA_RUN_SHA256[v])
  assert.throws(() => plexScriptEnv({ accel: "vaapi", library: true, groups: [-1] }), /Bad group id/)
  assert.equal(plexScriptEnv({ accel: "cpu", library: false }).TC_LIBRARY, "0")
})

// ── Plex's own answers ──────────────────────────────────────────────────────

test("identity: JSON and XML are read the same, claimed or not, and anything else is not a Plex server", () => {
  assert.deepEqual(parseIdentity(200, fx("identity.json")), { machineId: MACHINE, version: "1.43.5.11079-b3b13e506", claimed: false })
  assert.deepEqual(parseIdentity(200, fx("identity.xml")), { machineId: MACHINE, version: "1.43.5.11079-b3b13e506", claimed: false })
  assert.equal(parseIdentity(200, fx("identity-claimed.json"))!.claimed, true)
  assert.equal(parseIdentity(500, fx("identity.json")), null)
  assert.equal(parseIdentity(200, "<html></html>"), null)
  assert.equal(parseIdentity(200, JSON.stringify({ MediaContainer: { size: 0 } })), null)
})

type Answer = { status: number; body?: string }
/** A pretend Plex server: the recorded answers, a library list that grows when one is added, and a log of every call. */
function fakePlex(o: { startClaimed?: boolean; claimable?: boolean; startAfter?: number; libraries?: "empty" | "two"; folders?: "both" | "none"; claimRefuses?: boolean; hardwareStatus?: number } = {}) {
  const st = { calls: [] as string[], claimed: o.startClaimed === true, refused: [] as string[], tries: 0, sections: o.libraries === "two" ? JSON.parse(fx("sections-two.json")) : JSON.parse(fx("sections-empty.json")), created: [] as string[], claimUrls: [] as string[] }
  const http = async (r: any) => {
    const u = new URL(r.url); const path = u.pathname + u.search
    st.calls.push(`${r.method} ${path}`)
    const ans = (a: Answer) => ({ status: a.status, headers: {}, body: a.body ?? "" })
    // A claimed server turns away every request but /identity and the claim itself unless it carries its own token.
    if (st.claimed && u.pathname !== "/identity" && u.pathname !== "/myplex/claim" && r.headers?.["X-Plex-Token"] !== SERVER_TOKEN) { st.refused.push(`${r.method} ${u.pathname}`); return ans({ status: 401, body: "<h1>401 Unauthorized</h1>" }) }
    if (u.pathname === "/identity") {
      if (st.tries++ < (o.startAfter ?? 0)) throw new Error("connect ECONNREFUSED")
      return ans({ status: 200, body: st.claimed ? fx("identity-claimed.json") : fx("identity.json") })
    }
    if (u.pathname === "/myplex/claim" && r.method === "POST") {
      st.claimUrls.push(r.url)
      if (o.claimRefuses) return ans({ status: 500, body: "<html><title>Internal Server Error</title></html>" })
      st.claimed = o.claimable !== false
      return ans({ status: 200 })
    }
    if (u.pathname === "/:/prefs" && r.method === "PUT") return ans({ status: o.hardwareStatus ?? 200 })
    if (u.pathname === "/library/sections" && r.method === "GET") return ans({ status: 200, body: JSON.stringify(st.sections) })
    if (u.pathname === "/library/sections" && r.method === "POST") {
      const name = u.searchParams.get("name")!
      st.created.push(`${name}|${u.searchParams.get("type")}|${u.searchParams.get("agent")}|${u.searchParams.get("scanner")}|${u.searchParams.get("location")}`)
      const dirs = st.sections.MediaContainer.Directory ?? []
      st.sections.MediaContainer.Directory = [...dirs, { title: name, Location: [{ path: u.searchParams.get("location") }] }]
      return ans({ status: 200 })
    }
    if (u.pathname.startsWith("/services/browse/")) {
      if (u.searchParams.get("includeFiles") !== "0") return ans({ status: 400, body: "<h1>400 Bad Request</h1>" })
      const path = Buffer.from(u.pathname.slice("/services/browse/".length), "base64").toString()
      if (path === "/data/media") return ans({ status: 200, body: fx(o.folders === "none" ? "browse-empty.json" : "browse-media.json") })
      return ans({ status: 200, body: fx("browse-empty.json") })
    }
    return ans({ status: 404 })
  }
  return { st, http }
}
const sd = (http: any, extra: object = {}) => ({ http, wait: async () => {}, pluginSettings: async () => ({}), savePluginSettings: async () => {}, ...extra })

test("setup: waits for Plex to answer, and says plainly when it never does", async () => {
  const p = fakePlex({ startAfter: 3 })
  const id = await waitForPlex(sd(p.http), "http://192.0.2.60:32400")
  assert.equal(id.machineId, MACHINE); assert.equal(p.st.tries, 4)
  await assert.rejects(waitForPlex(sd(fakePlex({ startAfter: 99 }).http), "http://192.0.2.60:32400", 3), /did not answer after three minutes/)
})

test("setup: the claim is read back from /identity, and a refused or ignored claim is said in words", async () => {
  const p = fakePlex()
  await claimServer(sd(p.http), plexUrl("192.0.2.60"), "claim-AbCdEf0123456789xyz")
  assert.equal(p.st.claimed, true)
  assert.match(p.st.claimUrls[0], /\/myplex\/claim\?token=claim-AbCdEf0123456789xyz$/)
  await assert.rejects(claimServer(sd(fakePlex({ claimRefuses: true }).http), "http://x:32400", "claim-AbCdEf0123456789xyz"), /refused the claim \(HTTP 500\)/)
  await assert.rejects(claimServer(sd(fakePlex({ claimable: false }).http), "http://x:32400", "claim-AbCdEf0123456789xyz", 2), /does not say it is claimed yet/)
  await assert.rejects(claimServer(sd(p.http), "http://x:32400", "not-a-claim"), /not in the form Plex gives/)
  await assert.rejects(claimServer(sd(p.http), "http://x:32400", "claim-" + "a".repeat(80)), /not in the form/)
})

test("setup: hardware transcoding is switched on, and a server that will not take it is reported, not fatal", async () => {
  const ok = await enableHardwareTranscoding(sd(fakePlex().http), "http://x:32400")
  assert.equal(ok.status, "done"); assert.match(ok.detail, /Plex Pass/)
  const no = await enableHardwareTranscoding(sd(fakePlex({ hardwareStatus: 500 }).http), "http://x:32400")
  assert.equal(no.status, "skipped"); assert.match(no.detail, /HTTP 500/)
})

test("setup: Plex's folder browser is asked the way the real server needs (base64 path, includeFiles=0)", async () => {
  const p = fakePlex()
  assert.deepEqual(await browse(sd(p.http), "http://x:32400", "/data/media"), ["/data/media/movies", "/data/media/tv"])
  assert.equal(p.st.calls[0], `GET /services/browse/${Buffer.from("/data/media").toString("base64")}?includeFiles=0`)
})

test("setup: a Movies and a TV Shows library are added where the folders exist, each read back, and run again changes nothing", async () => {
  const p = fakePlex()
  const first = await addLibraries(sd(p.http), "http://x:32400")
  assert.equal(first.status, "done"); assert.match(first.detail, /Added Movies and TV Shows/)
  assert.deepEqual(p.st.created, [
    "Movies|movie|tv.plex.agents.movie|Plex Movie|/data/media/movies",
    "TV Shows|show|tv.plex.agents.series|Plex TV Series|/data/media/tv",
  ])
  const again = await addLibraries(sd(p.http), "http://x:32400")
  assert.match(again.detail, /already existed/); assert.equal(p.st.created.length, 2)
  // Libraries the person already made, with the same folders, are left exactly as they are.
  const had = fakePlex({ libraries: "two" })
  assert.match((await addLibraries(sd(had.http), "http://x:32400")).detail, /already existed/); assert.deepEqual(had.st.created, [])
})

test("setup: with no movies or tv folder there is nothing to point at, and that is said, not failed", async () => {
  const p = fakePlex({ folders: "none" })
  const r = await addLibraries(sd(p.http), "http://x:32400")
  assert.equal(r.status, "skipped"); assert.match(r.detail, /No \/data\/media\/movies or \/data\/media\/tv folder/); assert.deepEqual(p.st.created, [])
  const broken = await addLibraries(sd(async () => ({ status: 500, headers: {}, body: "" })), "http://x:32400")
  assert.equal(broken.status, "skipped"); assert.match(broken.detail, /would not list its libraries/)
})

test("setup: a claimed server turns a tokenless request away, and the same request with the server's token works", async () => {
  const p = fakePlex({ startClaimed: true })
  const d = sd(async (r: any) => p.http(r))
  await assert.rejects(addLibraries(d, "http://x:32400"), PlexAuthRefused)
  await assert.rejects(enableHardwareTranscoding(d, "http://x:32400"), PlexAuthRefused)
  await assert.rejects(browse(d, "http://x:32400", "/data/media"), PlexAuthRefused)
  assert.deepEqual(p.st.created, [])
  assert.equal((await enableHardwareTranscoding(d, "http://x:32400", SERVER_TOKEN)).status, "done")
  assert.match((await addLibraries(d, "http://x:32400", SERVER_TOKEN)).detail, /Added Movies and TV Shows/)
  assert.equal(p.st.created.length, 2)
})

// ── The claim: Sign in with Plex made in the wizard ──────────────────────────

const ACCOUNT = "ACCOUNT-TOKEN-never-kept"
const SERVER_TOKEN = "SERVER-TOKEN-of-the-new-server"
const CLAIM = "claim-Zx9Qw8Er7Ty6"

function plexTv(o: { listed?: boolean; claimStatus?: number; claimBody?: unknown } = {}) {
  const st = { calls: [] as Array<{ method: string; url: string; token?: string }>, resourcesCalls: 0, authorised: true }
  const res = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body })
  const http: PlexHttp = async (method, url, headers) => {
    st.calls.push({ method, url, token: headers["X-Plex-Token"] })
    const u = new URL(url)
    if (u.host === "plex.tv") {
      if (u.pathname === "/api/v2/pins" && method === "POST") return res(201, { id: u.searchParams.get("strong") === "true" ? 202 : 101, code: u.searchParams.get("strong") === "true" ? "strongcode" : "K7QX", expiresIn: 900 })
      if (u.pathname.startsWith("/api/v2/pins/")) return res(200, st.authorised ? { authToken: ACCOUNT } : {})
      if (u.pathname === "/api/v2/user") return res(200, { username: "casey" })
      if (u.pathname === "/api/claim/token.json") return res(o.claimStatus ?? 200, o.claimBody ?? { token: CLAIM })
      if (u.pathname === "/api/v2/resources") {
        st.resourcesCalls++
        const here = o.listed === false || st.resourcesCalls < 3
        return res(200, here ? [] : [{ name: "New server", provides: "server", owned: true, clientIdentifier: MACHINE, accessToken: SERVER_TOKEN, productVersion: "1.43.5",
          connections: [{ protocol: "http", address: "192.0.2.60", port: 32400, uri: "http://192.0.2.60:32400", local: true }] }])
      }
    }
    if (u.host !== "plex.tv" && u.pathname === "/identity") return res(headers["X-Plex-Token"] === SERVER_TOKEN ? 200 : 401, { MediaContainer: { machineIdentifier: MACHINE } })
    throw new Error(`unexpected ${method} ${url}`)
  }
  return { st, http }
}

function signinWith(tv: ReturnType<typeof plexTv>, saved: Array<[string, string]>, audits: Array<Record<string, unknown>>, now = () => 1_000_000) {
  return new PlexSignin({
    http: tv.http, clientId: async () => "client-1", save: async (u, t) => { saved.push([u, t]) },
    audit: async (_a, d) => { audits.push(d) }, now, schedule: () => undefined, expire: () => undefined, cancel: () => {},
  })
}

test("claim sign-in: signed in, it holds the account token in memory only, hands out a claim code, and connects the new server with ITS token", async () => {
  const tv = plexTv(); const saved: Array<[string, string]> = []; const audits: Array<Record<string, unknown>> = []
  const s = signinWith(tv, saved, audits)
  const f = await s.start("sid-1", null, OWNER)
  assert.equal(s.claimReady(f.id, OWNER), null, "not signed in yet")
  await assert.rejects(s.claimToken(f.id, OWNER), (e: any) => e instanceof PlexSigninError && e.code === "not_signed_in")
  await s.tick(f.id)
  const view = s.status(f.id, "sid-1")
  assert.equal(view.state, "signed-in"); assert.equal(view.user, "casey")
  assert.equal(JSON.stringify(view).includes(ACCOUNT), false, "no token reaches the page")
  assert.equal(view.servers, undefined, "a claim sign-in lists no servers")
  assert.deepEqual(s.claimReady(f.id, OWNER), { user: "casey" })
  assert.equal(s.claimReady(f.id, "someone@example.com"), null, "only the person who made it")
  assert.equal(await s.claimToken(f.id, OWNER), CLAIM)
  // The server must appear under the account on plex.tv (the third read does), and answers /identity with its own token.
  const out = await s.connectClaimed(f.id, OWNER, { machineId: MACHINE, url: "http://192.0.2.60:32400", by: "casey@example.com", wait: async () => {} })
  assert.equal(out.server, "New server"); assert.equal(out.user, "casey")
  assert.deepEqual(saved, [["http://192.0.2.60:32400", SERVER_TOKEN]], "the SERVER's token is what is saved, never the account's")
  assert.equal(JSON.stringify([saved, audits]).includes(ACCOUNT), false)
  assert.equal(audits.length, 1); assert.match(String(audits[0].message), /claimed by casey/)
  assert.equal(s.size, 0, "the sign-in ends with the claim")
  await assert.rejects(s.claimToken(f.id, OWNER), (e: any) => e.code === "no_signin")
})

test("claim sign-in: a different person, an ended sign-in, a plex.tv refusal and a server that never lists are each refused in words", async () => {
  const tv = plexTv({ listed: false }); const saved: Array<[string, string]> = []
  const s = signinWith(tv, saved, [])
  const f = await s.start("sid-1", null, OWNER); await s.tick(f.id)
  await assert.rejects(s.claimToken(f.id, "other@example.com"), (e: any) => e.code === "no_signin")
  await assert.rejects(s.connectClaimed(f.id, OWNER, { machineId: MACHINE, url: "http://192.0.2.60:32400", by: OWNER, tries: 2, wait: async () => {} }), (e: any) => e.code === "not_listed" && /has not listed the new server/.test(e.message))
  assert.deepEqual(saved, []); assert.equal(s.size, 0, "dropped even on failure")
  const bad = signinWith(plexTv({ claimStatus: 401 }), [], [])
  const g = await bad.start("sid-2", null, OWNER); await bad.tick(g.id)
  await assert.rejects(bad.claimToken(g.id, OWNER), /did not give a claim code/)
  const odd = signinWith(plexTv({ claimBody: { token: "../../etc/passwd" } }), [], [])
  const h = await odd.start("sid-3", null, OWNER); await odd.tick(h.id)
  await assert.rejects(odd.claimToken(h.id, OWNER), /without a usable claim code/)
  // An ordinary sign-in (no claim) can never be used to claim.
  const plain = signinWith(plexTv(), [], []); const p = await plain.start("sid-4", null)
  await plain.tick(p.id); await assert.rejects(plain.claimToken(p.id, OWNER), (e: any) => e.code === "no_signin")
})

test("claim sign-in: it is dropped when it expires and when HyperProx locks, and the token goes with it", async () => {
  let t = 1_000_000
  const tv = plexTv(); const s = signinWith(tv, [], [], () => t)
  const f = await s.start("sid-1", null, OWNER); await s.tick(f.id)
  assert.ok(s.claimReady(f.id, OWNER))
  t += CLAIM_HOLD_MS + 1
  assert.equal(s.claimReady(f.id, OWNER), null); assert.equal(s.size, 0)
  const g = await s.start("sid-1", null, OWNER); await s.tick(g.id)
  s.dropAll(); assert.equal(s.size, 0); assert.equal(s.claimReady(g.id, OWNER), null)
  const h = await s.start("sid-1", null, OWNER); await s.tick(h.id)
  s.endClaim(h.id, "someone-else"); assert.ok(s.claimReady(h.id, OWNER), "another person cannot end it")
  s.endClaim(h.id, OWNER); assert.equal(s.size, 0)
})

// ── Library check: Plex only reads ──────────────────────────────────────────

test("library: a read-only folder is fine for Plex (a warning), where an app that replaces files refuses it", () => {
  const l = layoutFromOptions({ TC_MEDIA: "path", TC_HOST_PATH: "/mnt/media" }).layout!
  const out = "@@arr resolved /mnt/media\n@@arr reachable\n@@arr owner 0:0\n@@arr space 1099511627776 2199023255552\n@@arr fstype ext4\n@@arr readonly /mnt/media\n"
  assert.ok(judgeMedia(out, l, 900).errors.some(e => /not writable by the container's user/.test(e)))
  const plex = judgeMedia(out, l, 900, false)
  assert.deepEqual(plex.errors, []); assert.ok(plex.warnings.some(w => /read-only/.test(w) && /fine for reading/.test(w)))
})

// ── The preview and the wizard, end to end on a fake cluster ─────────────────

const INTEL = ["##lspci", "0000:00:02.0 VGA compatible controller [0300]: Intel Corporation UHD Graphics 630 [8086:3e92] (rev 02)", "\tKernel driver in use: i915",
  "##dri", "/dev/dri/card0|0000:00:02.0|e2:0", "/dev/dri/renderD128|0000:00:02.0|e2:80", "##tcgroups", "render:x:993:", "video:x:44:", "##end"].join("\n")
const NVIDIA = ["##lspci", "0000:0a:00.0 VGA compatible controller [0300]: NVIDIA Corporation GP104 [GeForce GTX 1070 Ti] [10de:1b82] (rev a1)", "\tKernel driver in use: nvidia",
  "##nvidia", "00000000:0A:00.0, NVIDIA GeForce GTX 1070 Ti, 580.173.02, 8192 MiB", "##nvdev", "/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm", "##nvmodule", "580.173.02",
  "##tcgroups", "render:x:992:", "video:x:44:", "##end"].join("\n")
const NVIDIA_OLD = NVIDIA.replaceAll("580.173.02", "470.99.01")
const BARE = "##lspci\n##tcgroups\nrender:x:993:\nvideo:x:44:\n##end\n"

function nodeRunner(pve: FakePve, hw: Record<string, string>, calls: string[], o: { writable?: boolean } = {}) {
  return async (node: string, script: string) => {
    calls.push(script)
    if (script.includes("##tcgroups")) return { code: 0, output: hw[node] ?? BARE }
    if (script.includes("@@arr prepared")) {
      const vmid = Number(/V=(\d+)/.exec(script)![1])
      const mp0 = /-mp0 '([^']+)'/.exec(script)?.[1]?.replace(/^pool:(\d+)/, "pool:vm-$1-disk-1")
      const devs = Object.fromEntries([...script.matchAll(/--dev(\d+) '([^']+)'/g)].map(m => [`dev${m[1]}`, m[2]]))
      pve.configs[vmid] = { ...pve.configs[vmid], ...(script.includes("--features") ? { features: "nesting=1,keyctl=1" } : {}), ...(mp0 ? { mp0 } : {}), ...devs }
      return { code: 0, output: `${script.includes("fstab") ? "@@arr mounted\n" : ""}@@arr prepared\n` }
    }
    return { code: 0, output: `@@arr resolved /mnt/media\n@@arr reachable\n@@arr owner 101000:101000\n@@arr space 1099511627776 2199023255552\n@@arr fstype ext4\n${o.writable === false ? "@@arr readonly /mnt/media\n" : "@@arr writable\n"}` }
  }
}

/** The claim service a wizard install reaches: the real PlexSignin on a pretend plex.tv, signed in once. */
async function claimService(saved: Array<[string, string]>) {
  const tv = plexTv(); const s = signinWith(tv, saved, [])
  const f = await s.start("sid-1", null, OWNER); await s.tick(f.id)
  const claim: PlexClaimDeps = {
    claimReady: (id, owner) => s.claimReady(id, owner), claimToken: (id, owner) => s.claimToken(id, owner),
    connectClaimed: (id, owner, o) => s.connectClaimed(id, owner, o), endClaim: (id, owner) => s.endClaim(id, owner),
  }
  return { s, tv, flow: f.id, claim }
}

function arrDeps(pve: FakePve, hw: Record<string, string>, calls: string[], o: { plex: ReturnType<typeof fakePlex>; plugins?: Record<string, Record<string, string>>; claim?: PlexClaimDeps; writable?: boolean }): ArrDeps {
  const plugins = o.plugins ?? {}
  return {
    http: o.plex.http as any, nodeRun: nodeRunner(pve, hw, calls, { writable: o.writable }),
    pluginSettings: async id => ({ ...(plugins[id] ?? {}) }), savePluginSettings: async (id, v) => { plugins[id] = { ...(plugins[id] ?? {}), ...v } },
    localAddressTo: async () => "192.0.2.5", mediaServer: async () => null, plexClaim: o.claim,
  }
}

const planInput = (vmid: number, ip: string, options: Record<string, string> = {}) =>
  ({ ...INPUT({ recipeId: "plex", hostname: "plex", vmid, cores: 4, memoryMb: 4096, diskGb: 24, ip: `${ip}/24` }), options } as any)

test("preview: the hardware is resolved against the node; NVIDIA only with a driver version HyperProx has a pinned installer for", async () => {
  const pve = new FakePve(); const calls: string[] = []; const plex = fakePlex()
  const d = (hw: Record<string, string>) => deps(pve, { arr: () => arrDeps(pve, hw, calls, { plex }) })
  const intel = await previewInstall(planInput(930, "192.0.2.70"), OWNER, d({ "node-a": INTEL }))
  assert.deepEqual(intel.errors, [], JSON.stringify(intel))
  assert.equal(intel.preview!.plan.options!.TC_ACCEL, "vaapi")
  assert.ok(intel.checks.some(c => /renderD128/.test(c)))
  assert.ok(intel.checks.some(c => /no Plex sign-in|No Plex sign-in/.test(c)) && intel.warnings.some(w => /not claimed/.test(w)))
  // Plex is a package: the container is not made a Docker host, and the preview says so.
  assert.ok(!intel.checks.some(c => /Docker needs both/.test(c)))
  assert.ok(intel.checks.some(c => /neither nesting nor keyctl/.test(c)))
  const nv = await previewInstall(planInput(931, "192.0.2.71", { TC_ACCEL: "nvidia" }), OWNER, d({ "node-a": NVIDIA }))
  assert.deepEqual(nv.errors, [], JSON.stringify(nv)); assert.equal(nv.preview!.plan.options!.TC_NVIDIA_VERSION, "580.173.02")
  const old = await previewInstall(planInput(932, "192.0.2.72", { TC_ACCEL: "nvidia" }), OWNER, d({ "node-a": NVIDIA_OLD }))
  assert.ok(old.errors.some(e => /no pinned checksum for that version/.test(e)), JSON.stringify(old.errors)); assert.equal(old.preview, undefined)
  const cpu = await previewInstall(planInput(933, "192.0.2.73"), OWNER, d({ "node-a": BARE }))
  assert.equal(cpu.preview!.plan.options!.TC_ACCEL, "cpu"); assert.equal(pve.creates.length, 0, "a preview creates nothing")
})

test("preview: a sign-in that has ended, or is someone else's, is refused before anything is made", async () => {
  const pve = new FakePve(); const plex = fakePlex(); const saved: Array<[string, string]> = []
  const c = await claimService(saved)
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": INTEL }, [], { plex, claim: c.claim }) })
  const ok = await previewInstall(planInput(934, "192.0.2.74", { PLEX_SIGNIN: c.flow }), OWNER, d)
  assert.deepEqual(ok.errors, [], JSON.stringify(ok)); assert.ok(ok.checks.some(x => /claimed to casey's Plex account/.test(x)))
  const other = await previewInstall(planInput(935, "192.0.2.75", { PLEX_SIGNIN: c.flow }), "other@example.com", d)
  assert.ok(other.errors.some(e => /sign-in has ended or is not finished/.test(e)), JSON.stringify(other.errors)); assert.equal(other.preview, undefined)
  const gone = await previewInstall(planInput(936, "192.0.2.76", { PLEX_SIGNIN: "3f2b9c1e-5d4a-4c1b-9e2f-0a1b2c3d4e5f" }), OWNER, d)
  assert.ok(gone.errors.some(e => /sign-in has ended or is not finished/.test(e)))
  assert.equal(pve.creates.length, 0)
})

test("preview: a read-only library folder is allowed for Plex and said", async () => {
  const pve = new FakePve(); const plex = fakePlex()
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": INTEL }, [], { plex, writable: false }) })
  const r = await previewInstall(planInput(937, "192.0.2.77", { TC_MEDIA: "path", TC_HOST_PATH: "/mnt/media" }), OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors)); assert.ok(r.warnings.some(w => /read-only/.test(w)))
})

test("wizard (Plex): preview then apply makes the container with its graphics and library, installs, claims, adds the libraries and connects the plug-in", async () => {
  const pve = new FakePve(); const calls: string[] = []; const scripts: string[] = []; const plugins: Record<string, Record<string, string>> = {}
  const saved: Array<[string, string]> = []; const vault: Record<string, any> = {}
  const c = await claimService(saved)
  // The plug-in's saved settings are what the claim service's own save() wrote: the same call the plug-in's settings take.
  const plex = fakePlex()
  const d = deps(pve, {
    arr: () => arrDeps(pve, { "node-a": INTEL }, calls, { plex, plugins, claim: { ...c.claim, connectClaimed: async (id, owner, o) => { const r = await c.s.connectClaimed(id, owner, o); plugins.plex = { plex_url: saved[0][0], plex_token: saved[0][1] }; return r } } }),
    saveSecrets: async (cat, p, v) => { vault[`${cat}/${p}`] = v },
    exec: async (o: any) => { scripts.push(o.script); return { code: 0, output: "", timedOut: false } as any },
  })
  const r = await previewInstall(planInput(940, "192.0.2.80", { TC_MEDIA: "nfs", TC_NFS_HOST: "10.0.0.20", TC_NFS_EXPORT: "/Media", PLEX_SIGNIN: c.flow }), OWNER, d)
  assert.deepEqual(r.errors, [], JSON.stringify(r))
  const job = await applyPreview(r.preview!.id, OWNER, d)
  assert.deepEqual(job.steps.map(s => s.id), ["container", "network", "install", "tc-ready", "tc-hardware", "tc-libraries", "tc-claim", "tc-plugin"])
  const done = await settled(job.jobId)
  assert.equal(done.status, "completed", `${done.error} ${JSON.stringify(done.steps)}`)
  assert.ok(done.steps.every(s => s.status === "done"), JSON.stringify(done.steps))
  // The node login gave the container the render node with the node's group, and the NAS mount: never shared.
  const prep = calls.find(x => x.includes("@@arr prepared"))!
  assert.doesNotMatch(prep, /--features/, "no nesting or keyctl for a package install")
  assert.equal(pve.creates[0].body.get("features"), null, "the create call sets no features either")
  assert.equal(pve.configs[940].features, undefined)
  assert.match(prep, /--dev0 '\/dev\/dri\/renderD128,gid=993'/); assert.match(prep, /-mp0 '\/mnt\/hyperprox-arr\/940,mp=\/data,backup=0'/)
  assert.doesNotMatch(prep, /shared=1/)
  assert.deepEqual(done.tcGroups, [993])
  // The install script is Plex's, with the node's render group, and carries no claim code and no token.
  const install = scripts.find(s => s.includes("PLEX_VERSION"))!
  assert.match(install, /export TC_GROUPS='993'/); assert.doesNotMatch(install, /docker/i); assert.doesNotMatch(install, new RegExp(`${ACCOUNT}|${CLAIM}|${SERVER_TOKEN}`))
  // Claimed through the real claim path: the code went to Plex's own address, once, and the account token never left plex.tv calls.
  assert.equal(plex.st.claimed, true); assert.equal(plex.st.claimUrls.length, 1); assert.ok(plex.st.claimUrls[0].startsWith("http://192.0.2.80:32400/myplex/claim?token=" + CLAIM))
  assert.ok(plex.st.created.length === 2)
  assert.deepEqual(plex.st.refused, [], "the chores ran before the claim, so the claimed server never had to turn one away")
  assert.deepEqual(saved, [["http://192.0.2.80:32400", SERVER_TOKEN]])
  assert.deepEqual(plugins.plex, { plex_url: "http://192.0.2.80:32400", plex_token: SERVER_TOKEN })
  assert.deepEqual(vault, {}, "nothing generated, so nothing in the vault")
  assert.equal(done.url, "http://192.0.2.80:32400"); assert.deepEqual(done.arrApps, [{ id: "plex", name: "Open Plex", url: "http://192.0.2.80:32400/web" }])
  assert.equal(done.ledger, undefined); assert.equal(done.publish, undefined, "no public name")
  assert.equal(c.s.size, 0, "the sign-in is over")
  assert.equal(JSON.stringify(done).includes(ACCOUNT) || JSON.stringify(done).includes(SERVER_TOKEN) || JSON.stringify(done).includes(CLAIM), false, "no token anywhere in the job")
})

test("wizard (Plex): without a Plex sign-in the server is installed and left unclaimed, and each skipped chore says why", async () => {
  const pve = new FakePve(); const plugins: Record<string, Record<string, string>> = {}; const plex = fakePlex()
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": BARE }, [], { plex, plugins }) })
  const r = await previewInstall(planInput(941, "192.0.2.81"), OWNER, d)
  const done = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(done.status, "completed", `${done.error} ${JSON.stringify(done.steps)}`)
  const by = Object.fromEntries(done.steps.map(s => [s.id, s]))
  assert.equal(by["tc-ready"].status, "done"); assert.equal(by["tc-claim"].status, "skipped"); assert.match(by["tc-claim"].detail!, /not claimed/)
  assert.equal(by["tc-hardware"].status, "skipped"); assert.match(by["tc-hardware"].detail!, /CPU only/)
  assert.equal(by["tc-libraries"].status, "done"); assert.equal(by["tc-plugin"].status, "skipped"); assert.match(by["tc-plugin"].detail!, /Sign in with Plex on the Plex plug-in/)
  assert.equal(plex.st.claimUrls.length, 0); assert.equal(plugins.plex, undefined)
})

test("wizard (Plex): a claim Plex refuses does not fail an installed server: it is reported, the server stays unclaimed, the plug-in waits", async () => {
  const pve = new FakePve(); const plugins: Record<string, Record<string, string>> = {}; const saved: Array<[string, string]> = []
  const c = await claimService(saved); const plex = fakePlex({ claimRefuses: true })
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": BARE }, [], { plex, plugins, claim: c.claim }) })
  const r = await previewInstall(planInput(942, "192.0.2.82", { PLEX_SIGNIN: c.flow }), OWNER, d)
  const done = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(done.status, "completed", `${done.error}`)
  const by = Object.fromEntries(done.steps.map(s => [s.id, s]))
  assert.equal(by["tc-claim"].status, "skipped"); assert.match(by["tc-claim"].detail!, /Claiming the server did not finish: Plex refused the claim \(HTTP 500\)/)
  assert.equal(by["tc-plugin"].status, "skipped"); assert.deepEqual(saved, []); assert.equal(plugins.plex, undefined)
  assert.equal(c.s.size, 0, "the sign-in is ended whatever happened")
})

test("wizard (Plex): a server that never answers fails the install in words, and clean-up removes only the container it made", async () => {
  const pve = new FakePve(); const plex = fakePlex({ startAfter: 9999 })
  const d = deps(pve, { arr: () => arrDeps(pve, { "node-a": BARE }, [], { plex }) })
  const r = await previewInstall(planInput(943, "192.0.2.83"), OWNER, d)
  const done = await settled((await applyPreview(r.preview!.id, OWNER, d)).jobId)
  assert.equal(done.status, "failed"); assert.match(done.error!, /Plex did not answer after three minutes/)
  assert.match(await removeFailedInstall(done.jobId, OWNER, d), /CT 943 was removed/)
})

test("wizard (Plex): it cannot be installed into an existing container, because only the wizard sets up its graphics and library", async () => {
  const { startInstall } = await import("../src/lib/catalogue-installer")
  await assert.rejects(startInstall({ recipeId: "plex", intoVmid: 100, owner: OWNER }), /only the install wizard does/)
})

test("steps: Plex's own chores replace the generic check and wiring, in order", () => {
  const generic = [{ id: "container", label: "c", status: "pending" }, { id: "network", label: "n", status: "pending" }, { id: "install", label: "i", status: "pending" },
    { id: "verify", label: "v", status: "pending" }, { id: "wire", label: "w", status: "pending" }]
  assert.deepEqual(tcJobSteps(generic, "plex").map(s => s.id), ["container", "network", "install", "tc-ready", "tc-hardware", "tc-libraries", "tc-claim", "tc-plugin"])
  assert.throws(() => tcInstallEnv("plex", { options: { TC_ACCEL: "auto" }, groups: [], ip: "192.0.2.4", hostname: "p" }), /resolved hardware/)
})

test("setup: chores a claimed server refuses are tried again with its own token once the plug-in is connected", async () => {
  const p = fakePlex({ startClaimed: true }); const settings: Record<string, string> = {}
  const claim: PlexClaimDeps = {
    claimReady: () => ({ user: "casey" }), claimToken: async () => CLAIM, endClaim: () => {},
    connectClaimed: async (_i, _o, o) => { settings.plex_url = o.url; settings.plex_token = SERVER_TOKEN; return { server: "New server", user: "casey" } },
  }
  const arr: any = { http: p.http, nodeRun: async () => ({ code: 0, output: "" }), pluginSettings: async () => ({ ...settings }), savePluginSettings: async () => {}, plexClaim: claim }
  const steps: Record<string, any> = {}
  await tcRunSetup({ kind: "plex", ip: "192.0.2.91", hostname: "plex", owner: OWNER, options: { PLEX_SIGNIN: "3f2b9c1e-5d4a-4c1b-9e2f-0a1b2c3d4e5f", TC_ACCEL: "vaapi", PLEX_LIBRARIES: "1" }, onLink: () => {} },
    id => (steps[id] ??= { status: "pending" }), { arr: () => arr, wait: async () => {} })
  assert.deepEqual(p.st.refused.sort(), ["GET /library/sections", "PUT /:/prefs"], "refused first, without a token")
  assert.equal(steps["tc-hardware"].status, "done"); assert.equal(steps["tc-libraries"].status, "done"); assert.match(steps["tc-libraries"].detail, /Added Movies and TV Shows/)
  assert.equal(steps["tc-plugin"].status, "done"); assert.equal(p.st.created.length, 2)
})

test("setup: tcRunSetup for Plex ends the claim sign-in even when the server never answers", async () => {
  const ended: string[] = []
  const claim: PlexClaimDeps = { claimReady: () => ({ user: "x" }), claimToken: async () => CLAIM, connectClaimed: async () => ({ server: "s", user: "u" }), endClaim: (id, o) => { ended.push(`${id}|${o}`) } }
  const arr: any = { http: fakePlex({ startAfter: 9999 }).http, nodeRun: async () => ({ code: 0, output: "" }), pluginSettings: async () => ({}), savePluginSettings: async () => {}, plexClaim: claim }
  await assert.rejects(tcRunSetup({ kind: "plex", ip: "192.0.2.90", hostname: "plex", owner: OWNER, options: { PLEX_SIGNIN: "3f2b9c1e-5d4a-4c1b-9e2f-0a1b2c3d4e5f" }, onLink: () => {} }, id => ({ status: "pending" }) as any, { arr: () => arr, wait: async () => {} }), /did not answer/)
  assert.deepEqual(ended, [`3f2b9c1e-5d4a-4c1b-9e2f-0a1b2c3d4e5f|${OWNER}`])
})

// ── Public repo: nothing of the live cluster in what ships ───────────────────

test("public repo: the Plex files name no node, address, guest or site of any real cluster", () => {
  const root = join(__dirname, "..", "..")
  const files = [join(root, "api", "src", "lib", "transcode", "plex.ts"), join(root, "api", "src", "lib", "plex-signin-shared.ts"), join(root, "api", "test", "plex-catalogue.test.ts")]
  for (const e of readdirSync(FX)) files.push(join(FX, e))
  const bad = new RegExp(["grif" + "finit", "fyr" + "lux", "titan" + "[0-9]", "192\\.168", "hm" + "server"].join("|"), "i")
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), bad, f)
})
