// A pretend authoritative name server for TXT records, on a loopback UDP port. It stands in for a zone's
// name servers in the propagation tests, and lets the Pebble tests make HyperProx's propagation check see
// one thing while Pebble's resolver sees another (the "CA rejects the challenge" path).
import dgram from 'node:dgram'
import type { AddressInfo } from 'node:net'

export interface TxtServer {
  address: string                      // "127.0.0.1:port", as Resolver.setServers takes it
  txt: Map<string, string[]>           // fqdn (lowercase, no trailing dot) -> values
  queries: string[]
  close(): Promise<void>
}

function readName(msg: Buffer, pos: number): { name: string; next: number } {
  const labels: string[] = []
  while (msg[pos] !== 0) {
    const len = msg[pos]
    labels.push(msg.subarray(pos + 1, pos + 1 + len).toString('ascii'))
    pos += len + 1
  }
  return { name: labels.join('.').toLowerCase(), next: pos + 1 }
}

export async function startTxtServer(): Promise<TxtServer> {
  const sock = dgram.createSocket('udp4')
  const txt = new Map<string, string[]>()
  const queries: string[] = []

  sock.on('message', (msg, rinfo) => {
    if (msg.length < 12) return
    const { name, next } = readName(msg, 12)
    const qtype = msg.readUInt16BE(next)
    queries.push(name)
    const question = msg.subarray(12, next + 4)
    const values = txt.get(name) ?? []
    const answers = qtype === 16 ? values : []

    const header = Buffer.alloc(12)
    header.writeUInt16BE(msg.readUInt16BE(0), 0)
    const rd = msg[2] & 0x01
    header[2] = 0x84 | rd                               // response, authoritative
    header[3] = values.length || txt.has(name) ? 0 : 3  // NXDOMAIN for a name with nothing on it
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(answers.length, 6)

    const rrs = answers.map(v => {
      const data = Buffer.from(v, 'utf8')
      const rr = Buffer.alloc(12)
      rr.writeUInt16BE(0xc00c, 0)                       // name: pointer to the question
      rr.writeUInt16BE(16, 2)                           // TXT
      rr.writeUInt16BE(1, 4)                            // IN
      rr.writeUInt32BE(0, 6)                            // TTL 0: nothing is cached between polls
      rr.writeUInt16BE(data.length + 1, 10)
      return Buffer.concat([rr, Buffer.from([data.length]), data])
    })
    sock.send(Buffer.concat([header, question, ...rrs]), rinfo.port, rinfo.address)
  })

  await new Promise<void>(resolve => sock.bind(0, '127.0.0.1', resolve))
  const { port } = sock.address() as AddressInfo
  return {
    address: `127.0.0.1:${port}`,
    txt, queries,
    close: () => new Promise<void>(resolve => sock.close(() => resolve())),
  }
}
