// A pretend ASUS router for the ASUS plug-in's tests. Every value is made up: the model, the names, the
// addresses (documentation ranges) and the MACs (the 00:00:5E:00:53 documentation block). It speaks the app
// protocol: POST /login.cgi -> {"asus_token"}, POST /appGet.cgi with hook=..., GET /Logout.asp,
// POST /applyapp.cgi {"rc_service":"reboot"}. It records what it was sent.
import http from 'node:http'
import https from 'node:https'

export const FAKE_UA = 'asusrouter-Android-DUTUtil-1.0.0.245'

export const CLIENTLIST = {
  get_clientlist: {
    '00:00:5E:00:53:01': { mac: '00:00:5E:00:53:01', name: 'desk-pc', nickName: 'Desk PC', ip: '10.9.8.20', vendor: 'Example Corp', isWL: '0', isOnline: '1', rssi: '0', wlConnectTime: '' },
    '00:00:5E:00:53:02': { mac: '00:00:5E:00:53:02', name: 'tablet', nickName: '', ip: '10.9.8.21', vendor: 'Sample Devices', isWL: '1', isOnline: '1', rssi: '-48', wlConnectTime: '01:02:03' },
    '00:00:5E:00:53:03': { mac: '00:00:5E:00:53:03', name: '', nickName: '', ip: '10.9.8.22', vendor: 'Widget Co', isWL: '2', isOnline: '1', rssi: '-71', wlConnectTime: '2:03:04:05' },
    '00:00:5E:00:53:04': { mac: '00:00:5E:00:53:04', name: 'old-phone', nickName: 'Old phone', ip: '10.9.8.23', vendor: '', isWL: '2', isOnline: '0', rssi: '-80', wlConnectTime: '' },
    'not-a-mac': { mac: 'zz', name: 'junk', isOnline: '1' },
    maclist: ['00:00:5E:00:53:01', '00:00:5E:00:53:02', '00:00:5E:00:53:03', '00:00:5E:00:53:04'],
    ClientAPILevel: '2',
  },
}

export const WANLINK_UP = `function wanlink_status() { return 1;}
function wanlink_statusstr() { return 'Connected';}
function wanlink_type() { return 'dhcp';}
function wanlink_ipaddr() { return '198.51.100.7';}
function wanlink_netmask() { return '255.255.255.0';}
function wanlink_gateway() { return '198.51.100.1';}
function wanlink_dns() { return '198.51.100.53';}`

export const WANLINK_DOWN = `function wanlink_status() { return 0;}
function wanlink_statusstr() { return 'Disconnected';}
function wanlink_type() { return 'dhcp';}
function wanlink_ipaddr() { return '0.0.0.0';}
function wanlink_gateway() { return '0.0.0.0';}`

export interface FakeState {
  user: string; pass: string
  flavour: 'stock' | 'merlin'
  /** error_status to answer every login with, instead of checking the password. */
  loginError: null | { status: number; extra?: Record<string, unknown> }
  /** Drop the session after this many hook calls (answers error_status 8 once). */
  expireAfter: number | null
  wanUp: boolean
  memUsedPct: number
  update: null | string
  /** Bytes per poll the INTERNET counters advance by. */
  rxStep: bigint; txStep: bigint
  cpuBusy: number
  uptime: number
  /** Answer the reboot with run_service, or drop the connection. */
  reboot: 'ok' | 'drop'
  /** How the unit is used: a router, an access point leading an AiMesh network, or an AiMesh node. */
  mode: 'router' | 'ap-main' | 'node'
  /** Answer get_cfg_clientlist() with a one-node list (for the redaction test). */
  meshList: boolean
  /** The unit's own names: its AiMesh location and its host name. */
  alias: string; hostname: string
}

export interface Seen { method: string; path: string; ua: string | undefined; cookie: string | undefined; body: string }

export function fakeRouter(over: Partial<FakeState> = {}) {
  const st: FakeState = {
    user: 'admin', pass: 'correct horse', flavour: 'stock', loginError: null, expireAfter: null, wanUp: true, memUsedPct: 40, update: null,
    rxStep: 1_250_000n, txStep: 125_000n, cpuBusy: 0.2, uptime: 86_400 * 3, reboot: 'ok', mode: 'router', meshList: false, alias: '', hostname: '', ...over,
  }
  const seen: Seen[] = []
  const tokens = new Set<string>()
  let n = 0, hooks = 0, rx = 0xfffff000n, tx = 0x1000n, cpuTotal = 100_000, cpuUsed = 20_000
  const tick = () => { rx += st.rxStep; tx += st.txStep; cpuTotal += 1000; cpuUsed += Math.round(1000 * st.cpuBusy) }

  function nvram(): Record<string, string> {
    const merlin = st.flavour === 'merlin'
    return {
      productid: 'RT-XX9000', odmpid: '', firmver: '3.0.0.4', buildno: merlin ? '388.8' : '388', extendno: merlin ? '2' : '24198-gdeadbee', '3rd-party': merlin ? 'merlin' : '',
      webs_state_flag: st.update ? '1' : '0', webs_state_info: st.update ?? '', link_internet: st.wanUp ? '2' : '1',
      wl0_ssid: 'Example Net', wl0_nband: '2', wl0_radio: '1', wl0_chanspec: '6', wl0_channel: '0', wl0_bw: '1',
      wl1_ssid: 'Example Net 5G', wl1_nband: '1', wl1_radio: '1', wl1_chanspec: '36/80', wl1_channel: '36', wl1_bw: '3',
      wl2_ssid: '', wl2_nband: '', wl3_ssid: '', wl3_nband: '',
      sw_mode: st.mode === 'router' ? '1' : '3', re_mode: st.mode === 'node' ? '1' : '0', cfg_master: st.mode === 'node' ? '0' : '1',
      cfg_alias: st.alias, computer_name: st.hostname, lan_hostname: st.hostname,
      lan_proto: st.mode === 'router' ? 'static' : 'dhcp', lan_gateway: st.mode === 'router' ? '0.0.0.0' : '10.9.8.1',
    }
  }

  function hookAnswer(hook: string): string {
    const parts = hook.split(';')
    if (parts.length === 1 && parts[0] === 'wanlink()') return st.wanUp ? WANLINK_UP : WANLINK_DOWN
    const out: Record<string, unknown> = {}
    const nv = nvram()
    for (const p of parts) {
      const m = /^nvram_get\(([^)]+)\)$/.exec(p)
      if (m) { out[m[1]] = nv[m[1]] ?? ''; continue }
      if (p === 'uptime()') out.uptime = `Mon, 02 Nov 2026 10:00:00 +0000(${st.uptime} secs since boot)`
      if (p === 'get_wan_unit()') out.get_wan_unit = '0'
      if (p === 'cpu_usage(appobj)') { tick(); out.cpu_usage = { cpu1_total: String(cpuTotal), cpu1_usage: String(cpuUsed), cpu2_total: String(cpuTotal), cpu2_usage: String(cpuUsed) } }
      if (p === 'memory_usage(appobj)') out.memory_usage = { mem_total: '524288', mem_free: String(Math.round(524288 * (1 - st.memUsedPct / 100))), mem_used: String(Math.round(524288 * st.memUsedPct / 100)) }
      if (p === 'netdev(appobj)') out.netdev = { INTERNET_rx: '0x' + rx.toString(16).padStart(16, '0'), INTERNET_tx: '0x' + tx.toString(16).padStart(16, '0'), WIRED_rx: '0x00000000000000ff' }
      if (p === 'get_clientlist()') Object.assign(out, CLIENTLIST)
      if (p === 'wl_control_channel()') out.wl_control_channel = ['6', '36', '0']
      // A mesh list the way a main unit might answer it, with a secret and MACs in it (for the redaction test).
      if (p === 'get_cfg_clientlist()' && st.meshList) out.get_cfg_clientlist = [{ alias: 'Hall', model_name: 'XX-NODE', mac: '00:00:5E:00:53:20', pap2g: '00005E005321', backhalctrl: { key: 'mesh-secret-value' }, ip: '10.9.8.40' }]
    }
    // Asuswrt really does leave a trailing comma now and then.
    return JSON.stringify(out).replace(/}$/, ',}')
  }

  const handler: http.RequestListener = (req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      seen.push({ method: req.method ?? '', path, ua: req.headers['user-agent'], cookie: req.headers.cookie, body })
      const json = (v: unknown, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(typeof v === 'string' ? v : JSON.stringify(v)) }
      const token = /asus_token=([A-Za-z0-9]+)/.exec(req.headers.cookie ?? '')?.[1]
      if (path === '/login.cgi' && req.method === 'POST') {
        if (st.loginError) return json({ error_status: String(st.loginError.status), ...(st.loginError.extra ?? {}) })
        const auth = decodeURIComponent(/login_authorization=([^&]*)/.exec(body)?.[1] ?? '')
        if (req.headers['user-agent'] !== FAKE_UA) return json('<html>ASUS Login</html>')
        if (Buffer.from(auth, 'base64').toString('utf8') !== `${st.user}:${st.pass}`) return json({ error_status: '3' })
        const t = `tok${++n}x`
        tokens.add(t)
        return json({ asus_token: t })
      }
      if (path === '/Logout.asp') { if (token) tokens.delete(token); res.end('<html></html>'); return }
      if (!token || !tokens.has(token)) return json({ error_status: '2' })
      if (path === '/appGet.cgi' && req.method === 'POST') {
        hooks++
        if (st.expireAfter !== null && hooks > st.expireAfter) { st.expireAfter = null; tokens.delete(token); return json({ error_status: '8' }) }
        const hook = /^hook=(.*)$/s.exec(body)?.[1] ?? ''
        return json(hookAnswer(hook))
      }
      if (path === '/applyapp.cgi' && req.method === 'POST') {
        if (st.reboot === 'drop') { req.socket.destroy(); return }
        const j = JSON.parse(body)
        if (j.rc_service === 'reboot') { st.uptime = 5; return json({ modify: '0', run_service: 'reboot' }) }
        return json({ modify: '0' })
      }
      json({ error: 'not found' }, 404)
    })
  }
  return { st, seen, handler, logins: () => seen.filter(s => s.path === '/login.cgi').length, tokens }
}

export async function listen(handler: http.RequestListener, tls?: { key: Buffer; cert: Buffer }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  return { port, close: () => new Promise(r => { (server as any).closeAllConnections?.(); server.close(() => r()) }) }
}
