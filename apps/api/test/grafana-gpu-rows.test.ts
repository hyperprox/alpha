// The cluster dashboard draws each GPU vendor's panels only on clusters that have that vendor: every
// vendor's panels sit under a row repeated over a hidden variable that has a value only when one of that
// vendor's metrics exists. So a cluster with no AMD GPU shows no empty "AMD GPU" panels saying "No data".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', '..')
const file = join(root, 'config/grafana/provisioning/dashboards/hyperprox-cluster.json')
const d = JSON.parse(readFileSync(file, 'utf8'))

const VENDORS: Array<[string, string, RegExp]> = [
  ['intel', 'igpu_power_package', /\bigpu_/],
  ['amd', 'node_drm_gpu_busy_percent', /\bnode_drm_/],
  ['nvidia', 'nvidia_smi_memory_total_bytes', /\bnvidia_smi_/],
]
const exprs = (p: any) => (p.targets ?? []).map((t: any) => String(t.expr ?? ''))

test('each vendor has a hidden variable that exists only when that vendor reports data', () => {
  for (const [name, metric] of VENDORS) {
    const v = d.templating.list.find((x: any) => x.name === name)
    assert.ok(v, name)
    assert.equal(v.type, 'query'); assert.equal(v.hide, 2, `${name} is hidden`)
    assert.equal(v.includeAll, false, `${name}: no "All" value, which would exist with no data`)
    assert.equal(v.query.query, `label_values(${metric}, job)`)
    assert.equal(v.refresh, 2, `${name} re-reads on time range change`)
  }
})

test('every GPU panel sits under its vendor\'s repeated row, and only there', () => {
  const ordered = [...d.panels].sort((a: any, b: any) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x)
  let row: any = null
  const seen: Record<string, number> = {}
  for (const p of ordered) {
    if (p.type === 'row') { row = p; continue }
    const vendor = VENDORS.find(([, , re]) => exprs(p).some((e: string) => re.test(e)))
    if (!vendor) { assert.equal(row, null, `${p.title} is above the GPU rows`); continue }
    assert.ok(row, `${p.title} has no row`)
    assert.equal(row.repeat, vendor[0], `${p.title} is under the ${vendor[0]} row`)
    assert.ok(exprs(p).every((e: string) => vendor[2].test(e)), `${p.title} uses only ${vendor[0]} metrics`)
    seen[vendor[0]] = (seen[vendor[0]] ?? 0) + 1
  }
  assert.deepEqual(Object.keys(seen).sort(), ['amd', 'intel', 'nvidia'])
  for (const r of d.panels.filter((p: any) => p.type === 'row')) {
    assert.equal(r.collapsed, false); assert.deepEqual(r.panels, [])
  }
})

test('the AMD panels read node_exporter\'s drm collector, which HyperProx now turns on', () => {
  const amd = d.panels.filter((p: any) => exprs(p).some((e: string) => /node_drm_/.test(e)))
  const all = amd.flatMap(exprs).join(' ')
  assert.match(all, /node_drm_gpu_busy_percent/)
  assert.match(all, /node_drm_memory_vram_used_bytes/)
  assert.match(all, /node_drm_memory_vram_size_bytes/)
})

test('the unmounted copy matches the provisioned dashboard, and no panel overlaps another', () => {
  assert.equal(readFileSync(join(root, 'config/grafana/dashboards/hyperprox-cluster.json'), 'utf8'), readFileSync(file, 'utf8'))
  const cells = new Set<string>()
  for (const p of d.panels) for (let y = p.gridPos.y; y < p.gridPos.y + p.gridPos.h; y++) for (let x = p.gridPos.x; x < p.gridPos.x + p.gridPos.w; x++) {
    const k = `${x},${y}`; assert.ok(!cells.has(k), `${p.title} overlaps at ${k}`); cells.add(k)
  }
  assert.equal(new Set(d.panels.map((p: any) => p.id)).size, d.panels.length, 'ids are unique')
})
