// =============================================================================
//  HyperProx — WireGuard on a MikroTik router (RouterOS REST)
//
//  Reads go through the MikroTik plug-in's own read-only connection. Writes
//  need a separate login in the vault (remote/routeros-write): a RouterOS
//  group with only read, write, api and rest-api. RouterOS policies are not
//  per-menu, so `write` lets that login change other configuration too; the
//  "WireGuard peers only" limit is enforced here (restWriter refuses every
//  other path), not by RouterOS. Without the login the router view is
//  read-only and says how to create the group and user. HyperProx never uses
//  or asks for the router's admin login.
//
//  Only peers HyperProx created are ever changed or removed: they carry
//  comment=hyperprox:<id>. Interfaces, addresses, routes and firewall rules are
//  never written; a missing input rule is shown as a command for the owner.
// =============================================================================

export const MARK = 'hyperprox:'

export interface RouterWgInterface { id: string; name: string; listenPort: number | null; publicKey: string | null; running: boolean; disabled: boolean }
export interface RouterWgPeer {
  id: string; interface: string; name: string | null; publicKey: string | null; allowedAddress: string[]; endpoint: string | null
  currentEndpoint: string | null; lastHandshake: string | null; rx: number; tx: number; keepalive: string | null; comment: string | null
  /** HyperProx created it, so HyperProx may change or remove it. */
  managed: boolean
}

/** The REST calls this feature makes. Reads always; writes only when the limited write login exists. */
export interface RouterApi {
  read(path: string): Promise<any>
  write: null | { put(path: string, body: Record<string, string>): Promise<any>; del(path: string): Promise<void> }
}

/** Never let a private or preshared key out of a RouterOS answer, whatever the account could see. */
function clean(x: any): any {
  if (!x || typeof x !== 'object') return x
  const { 'private-key': _p, 'preshared-key': _s, ...rest } = x
  return rest
}

export function mapInterfaces(rows: any[]): RouterWgInterface[] {
  return (Array.isArray(rows) ? rows : []).map(clean).map((r: any) => ({
    id: String(r['.id'] ?? ''), name: String(r.name ?? ''), listenPort: r['listen-port'] ? Number(r['listen-port']) : null,
    publicKey: r['public-key'] ? String(r['public-key']) : null, running: r.running === 'true' || r.running === true, disabled: r.disabled === 'true' || r.disabled === true,
  }))
}

export function mapPeers(rows: any[]): RouterWgPeer[] {
  return (Array.isArray(rows) ? rows : []).map(clean).map((r: any) => {
    const comment = r.comment ? String(r.comment) : null
    const ep = r['endpoint-address'] ? `${r['endpoint-address']}:${r['endpoint-port'] ?? ''}` : null
    const cur = r['current-endpoint-address'] ? `${r['current-endpoint-address']}:${r['current-endpoint-port'] ?? ''}` : null
    return {
      id: String(r['.id'] ?? ''), interface: String(r.interface ?? ''), name: r.name ? String(r.name) : null,
      publicKey: r['public-key'] ? String(r['public-key']) : null,
      allowedAddress: String(r['allowed-address'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
      endpoint: ep, currentEndpoint: cur, lastHandshake: r['last-handshake'] ? String(r['last-handshake']) : null,
      rx: Number(r.rx ?? 0) || 0, tx: Number(r.tx ?? 0) || 0, keepalive: r['persistent-keepalive'] ? String(r['persistent-keepalive']) : null,
      comment, managed: !!comment && comment.startsWith(MARK),
    }
  })
}

/** The RouterOS commands that create the write login. Shown, never run. */
export const WRITE_ACCESS_COMMANDS = [
  '/user group add name=hyperprox-wg policy=read,write,api,rest-api comment="HyperProx: WireGuard peers"',
  '/user add name=hyperprox-wg group=hyperprox-wg comment="HyperProx: WireGuard peers" password="<a long random password>"',
]

/** What that login can and cannot do, said plainly. */
export const WRITE_ACCESS_NOTE =
  'RouterOS cannot limit a login to WireGuard peers: its policies cover whole areas, and "write" allows other configuration changes too. ' +
  'This group leaves out policy, sensitive, password, ssh, ftp, telnet, winbox, web, reboot, test and sniff, so it cannot manage users, read secrets or log in interactively. ' +
  '"WireGuard peers only" is enforced by HyperProx, which sends writes to /interface/wireguard/peers and nothing else; keep the password in the vault only.'

/** The only REST paths HyperProx writes: the peer list, or one peer by its RouterOS id. */
const WRITE_PATH = /^\/rest\/interface\/wireguard\/peers(?:\/\*[0-9A-Fa-f]{1,8}|\/%2A[0-9A-Fa-f]{1,8})?$/

const quoteRos = (v: string) => `"${v.replace(/["\\$]/g, c => `\\${c}`)}"`

/** The peer HyperProx would add, as the REST body and as the equivalent RouterOS command. */
export function peerBody(o: { iface: string; publicKey: string; allowedAddress: string[]; keepalive?: number | null; id: string; name: string }): { body: Record<string, string>; command: string } {
  const body: Record<string, string> = {
    interface: o.iface, 'public-key': o.publicKey, 'allowed-address': o.allowedAddress.join(','), comment: `${MARK}${o.id} ${o.name}`.slice(0, 100),
    ...(o.keepalive ? { 'persistent-keepalive': `${o.keepalive}s` } : {}),
  }
  const command = `/interface wireguard peers add ${Object.entries(body).map(([k, v]) => `${k}=${quoteRos(v)}`).join(' ')}`
  return { body, command }
}

const isTrue = (v: unknown) => v === true || v === 'true' || v === 'yes'

function ports(spec: unknown): number[] {
  return String(spec ?? '').split(',').map(p => p.trim()).filter(Boolean).flatMap(p => {
    const [a, b] = p.split('-').map(Number)
    return Number.isFinite(b) && b >= a ? Array.from({ length: Math.min(b - a + 1, 65536) }, (_, k) => a + k) : [a]
  })
}

/**
 * Does an input rule accept UDP to this port from anywhere, before a rule that would drop it? Rules are read
 * in order, as RouterOS applies them. An accept limited to some sources or interfaces does not count.
 */
export function firewallAllows(rules: any[], port: number): boolean {
  for (const r of (Array.isArray(rules) ? rules : [])) {
    if (r.chain !== 'input' || isTrue(r.disabled)) continue
    const proto = !r.protocol || r.protocol === 'udp'
    const portOk = !r['dst-port'] || ports(r['dst-port']).includes(port)
    if (!proto || !portOk) continue
    const fromSome = r['src-address'] || r['src-address-list'] || r['dst-address'] || r['connection-state']
    const onSome = r['in-interface'] || r['in-interface-list']
    if (r.action === 'accept' && r['dst-port'] && !fromSome && !onSome) return true
    if ((r.action === 'drop' || r.action === 'reject') && !fromSome) return false
  }
  return false
}

/** The input rule for a WireGuard listen port, as a command for the owner to run. HyperProx never adds it. */
export function firewallRule(port: number, iface: string): { command: string } {
  const body: Record<string, string> = { chain: 'input', action: 'accept', protocol: 'udp', 'dst-port': String(port), comment: `wg-${iface}` }
  return { command: `/ip firewall filter add ${Object.entries(body).map(([k, v]) => `${k}=${quoteRos(v)}`).join(' ')} place-before=0` }
}

// ── Production binding ──────────────────────────────────────────────────────

/** A REST client for the router with the limited write login. Self-signed TLS only when the plug-in allows it. */
export function restWriter(base: { url: string; insecureTLS: boolean }, cred: { username: string; password: string }): NonNullable<RouterApi['write']> {
  const auth = 'Basic ' + Buffer.from(`${cred.username}:${cred.password}`).toString('base64')
  async function call(method: 'PUT' | 'DELETE', path: string, body?: Record<string, string>): Promise<any> {
    if (!WRITE_PATH.test(path)) throw new Error(`HyperProx only writes WireGuard peers on the router; refused ${method} ${path.slice(0, 80)}`)
    const url = new URL(base.url + path)
    const payload = body ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { authorization: auth, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) }
    const out = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      import(url.protocol === 'https:' ? 'node:https' : 'node:http').then(mod => {
        const req = (mod as any).request(url, { method, headers, timeout: 15_000, ...(url.protocol === 'https:' ? { rejectUnauthorized: !base.insecureTLS } : {}) }, (res: any) => {
          let t = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { t += c }); res.on('end', () => resolve({ status: res.statusCode ?? 500, text: t }))
        })
        req.on('timeout', () => req.destroy(new Error('the router did not answer in 15 s')))
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
      }).catch(reject)
    })
    if (out.status >= 300) {
      let m = ''
      try { const j = JSON.parse(out.text); m = String(j.detail ?? j.message ?? '').slice(0, 200) } catch { /* not JSON */ }
      throw new Error(`RouterOS ${method} ${path}: HTTP ${out.status}${m ? ` — ${m}` : ''}`)
    }
    try { return out.text ? clean(JSON.parse(out.text)) : null } catch { return null }
  }
  return { put: (p, b) => call('PUT', p, b), del: p => call('DELETE', p).then(() => undefined) }
}
