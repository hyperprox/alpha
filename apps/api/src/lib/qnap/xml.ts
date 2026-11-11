// =============================================================================
//  HyperProx — QNAP: a small, forgiving XML reader
//
//  QTS answers its CGI calls with flat XML (<QDocRoot>, values in CDATA). This
//  reads that into a tree of plain objects without a dependency. It never
//  throws: a broken answer gives whatever was readable before it broke, and the
//  parsers turn anything missing into null. No entities beyond the five XML
//  ones and numeric references are expanded, and there is no DTD handling, so
//  an answer cannot make it fetch or expand anything.
// =============================================================================

export interface XNode {
  name: string
  text: string
  children: XNode[]
}

/** The most XML read from one answer: QTS answers are a few KB; anything far larger is not one. */
export const MAX_XML_CHARS = 4 * 1024 * 1024

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
  })
}

/** Parse an XML document into a root node named "#root". */
export function parseXml(input: unknown): XNode {
  const root: XNode = { name: '#root', text: '', children: [] }
  if (typeof input !== 'string') return root
  const src = input.length > MAX_XML_CHARS ? input.slice(0, MAX_XML_CHARS) : input
  const stack: XNode[] = [root]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const top = stack[stack.length - 1]
    if (lt < 0) { top.text += decode(src.slice(i)); break }
    if (lt > i) top.text += decode(src.slice(i, lt))
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      if (end < 0) { top.text += src.slice(lt + 9); break }
      top.text += src.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt + 4); i = end < 0 ? src.length : end + 3; continue }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { const end = src.indexOf('>', lt); i = end < 0 ? src.length : end + 1; continue }
    const gt = src.indexOf('>', lt)
    if (gt < 0) break
    const tag = src.slice(lt + 1, gt).trim()
    i = gt + 1
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim()
      // Close up to the matching open tag; a stray close tag is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break }
      }
      continue
    }
    const selfClosing = tag.endsWith('/')
    const name = (selfClosing ? tag.slice(0, -1) : tag).trim().split(/\s+/)[0]
    if (!name || !/^[A-Za-z_][\w.:-]*$/.test(name)) continue
    const node: XNode = { name, text: '', children: [] }
    top.children.push(node)
    if (!selfClosing && stack.length < 64) stack.push(node)
  }
  return root
}

/** The first descendant (depth-first) with this name, or null. */
export function find(n: XNode | null | undefined, name: string): XNode | null {
  if (!n) return null
  for (const c of n.children) {
    if (c.name === name) return c
    const d = find(c, name)
    if (d) return d
  }
  return null
}

/** Every descendant with this name, in document order. */
export function findAll(n: XNode | null | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out
  for (const c of n.children) {
    if (c.name === name) out.push(c)
    findAll(c, name, out)
  }
  return out
}

/** A direct child with this name, or null. */
export function child(n: XNode | null | undefined, name: string): XNode | null {
  return n?.children.find(c => c.name === name) ?? null
}

/** The trimmed text of the first descendant with this name, or null when absent or empty. */
export function textOf(n: XNode | null | undefined, name: string): string | null {
  const f = find(n, name)
  const t = f?.text.trim()
  return t ? t : null
}

/** A number from text such as "3.4 %", "503.3" or " 34 ", or null. */
export function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const m = /-?\d+(\.\d+)?/.exec(String(v))
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}
