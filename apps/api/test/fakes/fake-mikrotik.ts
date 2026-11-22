// A made-up MikroTik that keeps its tables, for the change-engine tests. It speaks the same REST shapes the real
// router does (PUT adds, PATCH edits, DELETE removes, POST runs a command) and records what was written.
import type { ChangeRouter } from '../../src/lib/mikrotik-change'

type Row = Record<string, any>

export interface FakeOpts {
  /** Make reading /system/resource fail once this many writes have happened (the router "went away"). */
  dropAfterWrites?: number
  noExport?: boolean
  noScheduler?: boolean
  pingFails?: boolean
  /** Makes the first matching write throw (once: a transient failure): matched against "METHOD path". */
  failOn?: string
  /** The write goes through on the router but its answer is lost (a timeout): matched against "METHOD path". */
  landThenFail?: string
  /** Deleting a row of a real table fails (so a rollback cannot finish). */
  failRollback?: boolean
  /** The export is this many bytes (default: a few lines). The file table, like the real router's, shows only 4095 characters of it. */
  exportBytes?: number
  /** Reading the export back in chunks fails after this many chunks. */
  readFailsAfter?: number
}

export function makeRouter(seed: Record<string, Row[]> = {}, opts: FakeOpts = {}) {
  let n = 100
  const tables: Record<string, Row[]> = {
    '/ip/address': [
      { '.id': '*a1', address: '10.0.0.1/24', interface: 'bridge-lan', 'actual-interface': 'bridge-lan' },
      { '.id': '*a2', address: '203.0.113.5/24', interface: 'ether1', 'actual-interface': 'ether1' },
    ],
    '/ip/dhcp-server': [{ '.id': '*d1', name: 'dhcp1', interface: 'bridge-lan' }],
    '/ip/dhcp-server/network': [{ '.id': '*n1', address: '10.0.0.0/24', gateway: '10.0.0.1' }],
    '/ip/dhcp-server/lease': [
      { '.id': '*l1', address: '10.0.0.31', 'mac-address': '00:00:5E:00:53:31', 'host-name': 'laptop', server: 'dhcp1', dynamic: 'true', status: 'bound' },
      { '.id': '*l2', address: '10.0.0.20', 'mac-address': '00:00:5E:00:53:20', server: 'dhcp1', dynamic: 'false', comment: 'nas', status: 'bound' },
      { '.id': '*l3', address: '10.0.0.40', 'mac-address': '00:00:5E:00:53:40', 'host-name': 'tv', server: 'dhcp1', dynamic: 'true', status: 'bound' },
    ],
    '/ip/arp': [
      { address: '10.0.0.31', 'mac-address': '00:00:5E:00:53:31', interface: 'bridge-lan' },
      { address: '10.0.0.20', 'mac-address': '00:00:5E:00:53:20', interface: 'bridge-lan' },
      { address: '10.0.0.50', 'mac-address': '00:00:5E:00:53:50', interface: 'bridge-lan' },
    ],
    '/ip/firewall/nat': [
      { '.id': '*f1', chain: 'dstnat', action: 'dst-nat', protocol: 'tcp', 'dst-port': '443', 'to-addresses': '10.0.0.20', 'to-ports': '443', 'in-interface-list': 'WAN', comment: 'existing web', disabled: 'false' },
      { '.id': '*f2', chain: 'srcnat', action: 'masquerade', 'out-interface-list': 'WAN' },
    ],
    '/ip/firewall/filter': [
      { '.id': '*i1', chain: 'input', action: 'accept', 'connection-state': 'established,related' },
      { '.id': '*i2', chain: 'forward', action: 'accept', 'connection-state': 'established,related' },
    ],
    '/interface/list/member': [{ list: 'WAN', interface: 'ether1' }, { list: 'LAN', interface: 'bridge-lan' }],
    '/ip/service': [
      { '.id': '*s1', name: 'www', port: '80', disabled: 'false' }, { '.id': '*s2', name: 'ssh', port: '22', disabled: 'false' },
      { '.id': '*s3', name: 'api', port: '8728', disabled: 'false' }, { '.id': '*s4', name: 'winbox', port: '8291', disabled: 'false' },
    ],
    '/user': [{ '.id': '*u1', name: 'hp', group: 'writers' }],
    '/user/group': [{ name: 'writers', policy: 'read,write,api,rest-api,test' }],
    '/interface': [{ '.id': '*e1', name: 'ether1', type: 'ether' }, { '.id': '*e2', name: 'bridge-lan', type: 'bridge' }],
    '/ip/route': [{ '.id': '*r1', 'dst-address': '0.0.0.0/0', gateway: '203.0.113.1', active: 'true' }],
    '/ip/neighbor': [], '/ip/firewall/connection': [],
    '/system/scheduler': [], '/system/script': [], '/file': [],
    ...structuredClone(seed),
  }
  const files = new Map<string, string>()
  let chunkReads = 0
  let failedOnce = false
  const writes: string[] = []
  const log: Array<{ w: string; scheduler: boolean }> = []
  let writeCount = 0
  const tableOf = (p: string) => { const t = tables[p]; if (!t) throw new Error('MikroTik returned HTTP 404'); return t }
  const split = (p: string) => { const q = p.replace(/^\/rest/, ''); const i = q.lastIndexOf('/'); return { base: q.slice(0, i), id: q.slice(i + 1) } }
  const gone = () => opts.dropAfterWrites !== undefined && writeCount >= opts.dropAfterWrites
  const note = (w: string) => {
    writes.push(w); writeCount++
    log.push({ w, scheduler: tables['/system/scheduler'].length > 0 })
    if (opts.failOn && !failedOnce && w.includes(opts.failOn)) { failedOnce = true; throw new Error('MikroTik returned HTTP 500') }
  }
  let landedOnce = false
  const lost = (w: string) => { if (opts.landThenFail && !landedOnce && w.includes(opts.landThenFail)) { landedOnce = true; throw new Error('MikroTik did not answer (timeout)') } }
  const r: ChangeRouter & { tables: Record<string, Row[]>; writes: string[]; log: typeof log; files: Map<string, string> } = {
    tables, writes, log, files,
    async get(p) {
      const q = p.replace(/^\/rest/, '')
      if (q === '/system/resource' || q === '/system/identity') { if (gone()) throw new Error('MikroTik did not answer'); return { name: 'edge', version: '7.20' } }
      if (q === '/system/clock') return { date: '2026-11-21', time: '12:00:00' }
      const [path, query] = q.split('?')
      const rows = structuredClone(tableOf(path))
      if (!query) return rows
      const want = [...new URLSearchParams(query).entries()]
      return rows.filter(r => want.every(([k, v]) => String(r[k] ?? '') === v))
    },
    async put(p, body: any) {
      const q = p.replace(/^\/rest/, '')
      if (q === '/system/scheduler' && opts.noScheduler) throw new Error('MikroTik returned HTTP 403')
      note(`PUT ${q}`)
      const row = { '.id': `*N${n++}`, ...body }
      tableOf(q).push(row); lost(`PUT ${q}`); return row
    },
    async patch(p, body) {
      const { base, id } = split(p); note(`PATCH ${base}`)
      const row = tableOf(base).find(x => x['.id'] === id); if (!row) throw new Error('MikroTik returned HTTP 404')
      Object.assign(row, body); lost(`PATCH ${base}`); return row
    },
    async delete(p) {
      const { base, id } = split(p); note(`DELETE ${base}`)
      if (opts.failRollback && !base.startsWith('/system') && base !== '/file') throw new Error('MikroTik returned HTTP 500')
      const t = tableOf(base); const i = t.findIndex(x => x['.id'] === id); if (i < 0) throw new Error('MikroTik returned HTTP 404')
      if (base === '/file') files.delete(t[i].name)
      t.splice(i, 1); lost(`DELETE ${base}`); return null
    },
    async post(p, body: any) {
      const q = p.replace(/^\/rest/, '')
      if (q === '/tool/ping') return opts.pingFails ? [{ received: '0', 'packet-loss': '100' }] : [{ received: '1' }, { received: '3', 'packet-loss': '0' }]
      if (q === '/file/read') {
        const text = files.get(String(body.file))
        if (text === undefined) throw new Error('MikroTik returned HTTP 404')
        if (opts.readFailsAfter !== undefined && chunkReads++ >= opts.readFailsAfter) throw new Error('MikroTik did not answer')
        return [{ data: text.slice(Number(body.offset), Number(body.offset) + Number(body['chunk-size'])) }]
      }
      note(`POST ${q}`)
      if (q === '/export') {
        if (opts.noExport) throw new Error('MikroTik returned HTTP 403')
        let text = `# export ${body.file}\n/ip address\nadd address=10.0.0.1/24 interface=bridge-lan\n`
        while (opts.exportBytes && text.length < opts.exportBytes) text += `/ip firewall address-list add list=x${text.length} address=10.1.${text.length % 250}.1\n`
        files.set(`${body.file}.rsc`, text)
        tables['/file'].push({ '.id': `*F${n++}`, name: `${body.file}.rsc`, contents: text.slice(0, 4095), size: String(text.length) }); return []
      }
      if (q.endsWith('/move')) {
        const t = tableOf(q.replace(/\/move$/, ''))
        const i = t.findIndex(x => x['.id'] === body.numbers), j = t.findIndex(x => x['.id'] === body.destination)
        const [row] = t.splice(i, 1); t.splice(j, 0, row); return null
      }
      if (q === '/ip/dhcp-server/lease/make-static') {
        for (const id of String(body.numbers).split(',')) { const row = tables['/ip/dhcp-server/lease'].find(x => x['.id'] === id); if (row) row.dynamic = 'false' }
        return null
      }
      throw new Error(`unexpected POST ${q}`)
    },
  }
  return r
}
