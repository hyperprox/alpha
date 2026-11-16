// Test helper: the import graph of apps/api/src, read from the source text (no build needed).
// Every relative import counts: static, type-only, re-exports, and dynamic import('...') (a lazy import is still a
// dependency at run time, and a cycle through one is still a cycle).

import fs from 'node:fs'
import path from 'node:path'

export const SRC = path.resolve(__dirname, '../../src')

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g

function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

/** The relative imports of one file, as absolute paths. Comments are skipped, so a path named in prose is not an edge. */
export function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out = new Set<string>()
  for (const m of text.matchAll(SPEC)) {
    const r = resolve(file, m[1])
    if (r) out.add(r)
  }
  return [...out]
}

/** Every file reachable from `entry` through relative imports. */
export function closure(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const d of importsOf(f)) if (!seen.has(d)) stack.push(d)
  }
  return seen
}

/**
 * Import cycles among the files under `dirs` (relative to `base`, default src): each strongly connected group of two or more files
 * (or a file importing itself), following edges between those files only.
 */
export function cyclesAmong(dirs: string[], base = SRC): string[][] {
  const roots = dirs.map(d => path.join(base, d))
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  roots.forEach(walk)
  const inSet = new Set(files)
  const edges = new Map(files.map(f => [f, importsOf(f).filter(d => inSet.has(d))]))
  // Tarjan's strongly connected components.
  let index = 0
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), st: string[] = []
  const out: string[][] = []
  const strong = (v: string) => {
    idx.set(v, index); low.set(v, index); index++; st.push(v); on.add(v)
    for (const w of edges.get(v)!) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []
      let w: string
      do { w = st.pop()!; on.delete(w); comp.push(w) } while (w !== v)
      if (comp.length > 1 || edges.get(v)!.includes(v)) out.push(comp.map(f => path.relative(base, f)).sort())
    }
  }
  for (const f of files) if (!idx.has(f)) strong(f)
  return out
}
