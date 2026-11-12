// A fake Arr Stack for the setup chores: Sonarr, Radarr, Prowlarr, Lidarr, qBittorrent, SABnzbd and Bazarr as one
// in-memory HTTP handler, plus the container's shell. Each app keeps what it was told, so the setup's read-backs
// read real state; switches make an app ignore a change, to prove a read-back catches it.
import type { HttpAnswer, HttpRequest } from "../../src/lib/arr/setup"

const PORTS: Record<number, string> = { 8989: "sonarr", 7878: "radarr", 9696: "prowlarr", 8686: "lidarr", 8080: "qbittorrent", 8085: "sabnzbd", 6767: "bazarr", 5055: "seerr", 8191: "flaresolverr" }
const KEY = (app: string) => (app.padEnd(32, "0").replace(/[^0-9a-f]/g, "a")).slice(0, 32)

interface Servarr { auth: string; required?: string; user?: string; folders: any[]; clients: any[]; apps: any[]; tags: any[]; proxies: any[] }

export class FakeStack {
  log: string[] = []
  /** Apps that keep answering without a sign-in, whatever they are told. */
  stayOpen = new Set<string>()
  /** Apps that drop a host-settings change on the floor. */
  ignoreAuth = new Set<string>()
  /** Device ids for /data/media, /data/torrents and /data/usenet, as `stat -c %d` gives them. */
  devs: Record<string, string> = { media: "51", torrents: "51", usenet: "51" }
  restarts: string[] = []
  servarr: Record<string, Servarr> = {}
  qbit = { password: "TEMPpw12", user: "admin", prefs: {} as any, cats: {} as Record<string, any> }
  sab = { misc: { host_whitelist: "abc123", username: "", complete_dir: "" } as any, cats: [] as any[] }
  bazarr = { general: {} as any, sonarr: {} as any, radarr: {} as any, auth: { type: "None", username: "" } }

  constructor() {
    for (const a of ["sonarr", "radarr", "prowlarr", "lidarr"]) this.servarr[a] = { auth: "none", folders: [], clients: [], apps: [], tags: [], proxies: [] }
  }

  key = KEY

  http = async (r: HttpRequest): Promise<HttpAnswer> => {
    const u = new URL(r.url)
    const app = PORTS[Number(u.port)]
    const path = u.pathname + u.search
    this.log.push(`${r.method} ${app} ${u.pathname}`)
    const j = (status: number, body: unknown, headers: Record<string, string> = {}): HttpAnswer => ({ status, headers, body: JSON.stringify(body) })
    const key = (r.headers?.["X-Api-Key"] ?? r.headers?.["X-API-KEY"] ?? u.searchParams.get("apikey")) === KEY(app)
    if (["sonarr", "radarr", "prowlarr", "lidarr"].includes(app)) {
      const s = this.servarr[app]
      if (u.pathname === "/ping") return j(200, { status: "OK" })
      if (u.pathname === "/") return s.auth === "forms" && !this.stayOpen.has(app) ? { status: 302, headers: { location: "/login?returnUrl=%2F" }, body: "" } : { status: 200, headers: {}, body: `<title>${app}</title>` }
      if (!key) return j(401, {})
      const api = u.pathname.replace(/^\/api\/v[13]/, "")
      if (api === "/system/status") return j(200, { appName: app, version: "1.0" })
      if (api === "/config/host" && r.method === "GET") return j(200, { id: 1, port: 8989, authenticationMethod: s.auth, authenticationRequired: s.required ?? "disabledForLocalAddresses", username: s.user ?? "" })
      if (api === "/config/host" && r.method === "PUT") {
        const b: any = r.json
        if (!this.ignoreAuth.has(app)) { s.auth = b.authenticationMethod; s.required = b.authenticationRequired; s.user = b.username }
        return j(202, b)
      }
      if (api === "/rootfolder" && r.method === "GET") return j(200, s.folders)
      if (api === "/rootfolder" && r.method === "POST") { s.folders.push({ id: s.folders.length + 1, ...(r.json as any) }); return j(201, r.json) }
      if (api === "/qualityprofile") return j(200, [{ id: 1, name: "Any" }])
      if (api === "/metadataprofile") return j(200, [{ id: 1, name: "Standard" }])
      if (api === "/downloadclient/schema") return j(200, ["QBittorrent", "Sabnzbd", "Transmission"].map(i => ({ implementation: i, fields: [
        { name: "host", value: "localhost" }, { name: "port", value: 0 }, { name: "username" }, { name: "password" }, { name: "apiKey" },
        { name: app === "sonarr" ? "tvCategory" : app === "radarr" ? "movieCategory" : "musicCategory", value: app }, { name: "useSsl", value: false },
      ] })))
      if (api === "/downloadclient" && r.method === "GET") return j(200, s.clients)
      if (api === "/downloadclient" && r.method === "POST") { s.clients.push({ id: s.clients.length + 1, ...(r.json as any) }); return j(201, r.json) }
      if (api === "/downloadclient/test") return j(200, {})
      if (api === "/applications/schema") return j(200, ["Sonarr", "Radarr", "Lidarr"].map(i => ({ implementation: i, fields: [{ name: "prowlarrUrl" }, { name: "baseUrl" }, { name: "apiKey" }, { name: "syncCategories", value: [5000] }] })))
      if (api === "/applications" && r.method === "GET") return j(200, s.apps)
      if (api === "/applications" && r.method === "POST") { s.apps.push(r.json); return j(201, r.json) }
      if (api === "/tag" && r.method === "GET") return j(200, s.tags)
      if (api === "/tag" && r.method === "POST") { const t = { id: 7, ...(r.json as any) }; s.tags.push(t); return j(201, t) }
      if (api === "/indexerProxy/schema") return j(200, [{ implementation: "FlareSolverr", fields: [{ name: "host" }, { name: "requestTimeout", value: 60 }] }])
      if (api === "/indexerProxy" && r.method === "GET") return j(200, s.proxies)
      if (api === "/indexerProxy" && r.method === "POST") { s.proxies.push(r.json); return j(201, r.json) }
      return j(404, { path })
    }
    if (app === "qbittorrent") {
      const q = this.qbit
      const cookie = r.headers?.Cookie === "QBT_SID_8080=good"
      if (u.pathname === "/api/v2/app/version") return cookie ? { status: 200, headers: {}, body: "v5.3.0" } : { status: 403, headers: {}, body: "Forbidden" }
      if (u.pathname === "/api/v2/auth/login") {
        const f = r.form ?? {}
        return f.username === q.user && f.password === q.password ? { status: 204, headers: { "set-cookie": "QBT_SID_8080=good; HttpOnly; SameSite=Lax; path=/" }, body: "" } : { status: 401, headers: {}, body: "Fails." }
      }
      if (!cookie) return { status: 403, headers: {}, body: "Forbidden" }
      if (u.pathname === "/api/v2/app/setPreferences") {
        const p = JSON.parse(r.form!.json)
        q.prefs = { ...q.prefs, ...p }
        if (p.web_ui_password) q.password = p.web_ui_password
        if (p.web_ui_username) q.user = p.web_ui_username
        return { status: 200, headers: {}, body: "" }
      }
      if (u.pathname === "/api/v2/app/preferences") return j(200, { save_path: q.prefs.save_path + "/", current_network_interface: q.prefs.current_network_interface ?? "" })
      if (u.pathname === "/api/v2/torrents/createCategory") {
        if (q.cats[r.form!.category]) return { status: 409, headers: {}, body: "" }
        q.cats[r.form!.category] = { name: r.form!.category, savePath: r.form!.savePath }; return { status: 200, headers: {}, body: "" }
      }
      if (u.pathname === "/api/v2/torrents/editCategory") { q.cats[r.form!.category] = { name: r.form!.category, savePath: r.form!.savePath }; return { status: 200, headers: {}, body: "" } }
      if (u.pathname === "/api/v2/torrents/categories") return j(200, q.cats)
      return j(404, {})
    }
    if (app === "sabnzbd") {
      if (u.pathname === "/") return this.sab.misc.username && !this.stayOpen.has(app) ? { status: 303, headers: { location: "/login/" }, body: "" } : { status: 200, headers: {}, body: "wizard" }
      const m = u.searchParams.get("mode")
      if (m === "version") return j(200, { version: "5.1.3" })
      if (!key) return j(200, { status: false, error: "API Key Required" })
      if (m === "get_config" && u.searchParams.get("section") === "misc") return j(200, { config: { misc: this.sab.misc } })
      if (m === "get_config" && u.searchParams.get("section") === "categories") return j(200, { config: { categories: this.sab.cats } })
      if (m === "set_config" && u.searchParams.get("section") === "misc") { this.sab.misc[u.searchParams.get("keyword")!] = u.searchParams.get("value"); return j(200, { status: true }) }
      if (m === "set_config" && u.searchParams.get("section") === "categories") { this.sab.cats.push({ name: u.searchParams.get("name"), dir: u.searchParams.get("dir") }); return j(200, { status: true }) }
      return j(404, {})
    }
    if (app === "bazarr") {
      if (u.pathname === "/") return { status: 200, headers: {}, body: "<title>Bazarr</title>" }
      if (!key) return j(401, {})
      if (u.pathname === "/api/system/status") return j(200, { data: { bazarr_version: "1.6.2" } })
      if (u.pathname === "/api/system/settings" && r.method === "GET") return j(200, { general: this.bazarr.general, sonarr: this.bazarr.sonarr, radarr: this.bazarr.radarr, auth: this.bazarr.auth })
      if (u.pathname === "/api/system/settings" && r.method === "POST") {
        for (const [k, v] of Object.entries(r.form ?? {})) {
          const [, section, field] = /^settings-([a-z]+)-(.+)$/.exec(k)!
          const val = v === "true" ? true : v === "false" ? false : v
          ;(this.bazarr as any)[section][field] = val
        }
        return { status: 204, headers: {}, body: "" }
      }
      return j(404, {})
    }
    if (app === "flaresolverr") return j(200, { msg: "FlareSolverr is ready!" })
    return j(404, {})
  }

  /** The container's shell: answers the setup's scripts by what they ask. */
  sh = async (script: string): Promise<{ code: number; output: string }> => {
    this.log.push(`sh ${script.split("\n").find(l => l && l !== "set -u")?.slice(0, 40)}`)
    if (script.includes("stat -c %d")) return { code: 0, output: Object.entries(this.devs).map(([k, v]) => `@@dev ${k} ${v}`).join("\n") + "\n@@w media yes\n" }
    if (script.includes("<ApiKey>")) {
      const out = ["sonarr", "radarr", "prowlarr", "lidarr", "bazarr", "sabnzbd"].filter(a => script.includes(`/${a}/`)).map(a => `@@key ${a} ${KEY(a)}`)
      return { code: 0, output: out.join("\n") + "\n" }
    }
    if (script.includes("temporary password")) return { code: 0, output: `@@tmp pw ${this.qbit.password}\n` }
    if (script.includes("curl -s -o /dev/null") && script.includes("printf '@@code qbit")) return { code: 0, output: "@@code qbit 403\n" }
    const m = /docker restart (\w+)/.exec(script)
    if (m) { this.restarts.push(m[1]); return { code: 0, output: "" } }
    return { code: 0, output: "" }
  }
}
