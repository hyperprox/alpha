// =============================================================================
//  HyperProx — reading an NGINX configuration (`nginx -T`)
//
//  Just enough of nginx's syntax to list what a person sees on a reverse proxy:
//  each server block's names, ports, where it forwards, its certificate, and
//  each upstream with its servers. Read-only: nothing here writes a config.
//
//  `nginx -T` prints every file it loaded, each after a line
//  "# configuration file /path:", so every block is tied to its file. Quoted
//  strings, comments and nested blocks are handled; `include` is already
//  expanded by nginx itself.
// =============================================================================

export interface NginxServer {
  file:        string
  names:       string[]
  listens:     string[]
  ssl:         boolean
  /** The first proxy_pass target in the server, as written ("http://app:8080", "http://backend"). */
  proxyPass:   string | null
  certificate: string | null
  /** A `return` or `root` site rather than a proxy. */
  kind:        'proxy' | 'static' | 'redirect' | 'other'
  defaultServer: boolean
}

export interface NginxUpstream { file: string; name: string; servers: string[] }

export interface NginxConf { servers: NginxServer[]; upstreams: NginxUpstream[]; files: string[] }

type Tok = { t: 'word'; v: string } | { t: '{' } | { t: '}' } | { t: ';' }

function tokens(text: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (/\s/.test(c)) { i++; continue }
    if (c === '{' || c === '}' || c === ';') { out.push({ t: c } as Tok); i++; continue }
    if (c === '"' || c === "'") {
      let j = i + 1, v = ''
      while (j < text.length && text[j] !== c) { if (text[j] === '\\' && j + 1 < text.length) { v += text[j + 1]; j += 2 } else v += text[j++] }
      out.push({ t: 'word', v }); i = j + 1; continue
    }
    let j = i
    while (j < text.length && !/[\s{};#]/.test(text[j])) j++
    // A "#" inside a word (a URL fragment) is part of it; one after white space starts a comment.
    while (j < text.length && text[j] === '#' && j > i) { j++; while (j < text.length && !/[\s{};]/.test(text[j])) j++ }
    out.push({ t: 'word', v: text.slice(i, j) }); i = j
  }
  return out
}

interface Block { name: string; args: string[]; children: Array<Block | Directive> }
interface Directive { name: string; args: string[] }

function parseBlock(toks: Tok[], pos: { i: number }): Array<Block | Directive> {
  const out: Array<Block | Directive> = []
  let words: string[] = []
  while (pos.i < toks.length) {
    const t = toks[pos.i++]
    if (t.t === 'word') { words.push(t.v); continue }
    if (t.t === ';') { if (words.length) out.push({ name: words[0], args: words.slice(1) }); words = []; continue }
    if (t.t === '{') { const children = parseBlock(toks, pos); out.push({ name: words[0] ?? '', args: words.slice(1), children }); words = []; continue }
    if (t.t === '}') return out
  }
  return out
}

const isBlock = (x: Block | Directive): x is Block => 'children' in x

function walk(items: Array<Block | Directive>, fn: (d: Block | Directive) => void): void {
  for (const x of items) { fn(x); if (isBlock(x)) walk(x.children, fn) }
}

/** Split `nginx -T` output into its files (path → text). Text before the first header is nginx's own messages. */
export function splitFiles(dump: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  const re = /^# configuration file (.+):\s*$/gm
  const heads = [...dump.matchAll(re)]
  heads.forEach((m, n) => {
    const start = m.index! + m[0].length
    const end = n + 1 < heads.length ? heads[n + 1].index! : dump.length
    out.push({ file: m[1].trim(), text: dump.slice(start, end) })
  })
  return out
}

/** Every server and upstream block in an `nginx -T` dump, with the file each came from. */
export function parseNginxDump(dump: string): NginxConf {
  const servers: NginxServer[] = [], upstreams: NginxUpstream[] = []
  const files = splitFiles(dump)
  for (const f of files) {
    const items = parseBlock(tokens(f.text), { i: 0 })
    walk(items, x => {
      if (!isBlock(x)) return
      if (x.name === 'upstream' && x.args[0]) {
        upstreams.push({ file: f.file, name: x.args[0], servers: x.children.filter(c => !isBlock(c) && c.name === 'server').map(c => c.args[0]).filter(Boolean) })
      }
      if (x.name !== 'server' || x.args.length) return
      const s: NginxServer = { file: f.file, names: [], listens: [], ssl: false, proxyPass: null, certificate: null, kind: 'other', defaultServer: false }
      let ret = false, root = false
      walk(x.children, d => {
        if (isBlock(d)) return
        if (d.name === 'server_name') s.names.push(...d.args.filter(a => a && a !== '_' && a !== '""'))
        if (d.name === 'listen' && d.args[0]) {
          s.listens.push(d.args[0])
          if (d.args.includes('ssl') || d.args.includes('quic')) s.ssl = true
          if (d.args.includes('default_server') || d.args.includes('default')) s.defaultServer = true
        }
        if (d.name === 'proxy_pass' && !s.proxyPass) s.proxyPass = d.args[0] ?? null
        if (d.name === 'ssl_certificate' && !s.certificate && d.args[0] && !d.args[0].startsWith('data:')) s.certificate = d.args[0]
        if (d.name === 'return') ret = true
        if (d.name === 'root') root = true
      })
      s.kind = s.proxyPass ? 'proxy' : ret && !root ? 'redirect' : root ? 'static' : 'other'
      s.names = [...new Set(s.names.map(n => n.toLowerCase()))]
      servers.push(s)
    })
  }
  return { servers, upstreams, files: files.map(f => f.file) }
}
