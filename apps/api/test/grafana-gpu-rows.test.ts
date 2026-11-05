// The cluster dashboard is drawn with a GPU row only for the vendors the cluster has. Grafana draws a row
// repeated over an empty variable once anyway ("No data"), so the choice is made before Grafana sees the
// dashboard: packages/hardware/dashboard.js writes the provisioned copy from the template, and target
// sync, the setup wizard and bin/hyperprox-config call it. scripts/test-grafana-gpu-rows.sh renders the
// result in a real Grafana with headless Chromium.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncTargets } from '../src/lib/targets'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dash = require('../../../packages/hardware/dashboard')
const root = join(__dirname, '..', '..', '..')
const template = JSON.parse(readFileSync(join(root, 'config/grafana/dashboards/hyperprox-cluster.json'), 'utf8'))
const rows = (d: any) => d.panels.filter((p: any) => p.type === 'row').map((p: any) => p.title)
const titles = (d: any) => d.panels.map((p: any) => p.title)

function noOverlap(d: any) {
  const cells = new Set<string>()
  for (const p of d.panels) for (let y = p.gridPos.y; y < p.gridPos.y + p.gridPos.h; y++) for (let x = p.gridPos.x; x < p.gridPos.x + p.gridPos.w; x++) {
    const k = `${x},${y}`; assert.ok(!cells.has(k), `${p.title} overlaps at ${k}`); cells.add(k)
  }
}

test('the template has a row per vendor, and no repeat or vendor variable left in it', () => {
  assert.deepEqual(rows(template), ['Intel GPUs', 'AMD GPUs', 'NVIDIA GPUs'])
  assert.ok(template.panels.every((p: any) => p.repeat === undefined))
  assert.deepEqual(template.templating.list, [])
})

test('only AMD: only the AMD row and its panels, laid out with no gap', () => {
  const d = dash.renderClusterDashboard(template, ['amd'])
  assert.deepEqual(rows(d), ['AMD GPUs'])
  assert.ok(titles(d).includes('AMD GPU — Utilization') && titles(d).includes('AMD GPU — VRAM Usage'))
  assert.ok(!titles(d).some((t: string) => /^(Intel|NVIDIA) GPU/.test(t)))
  assert.ok(d.panels.every((p: any) => !(p.targets ?? []).some((t: any) => /igpu_|nvidia_smi_/.test(t.expr))))
  const row = d.panels.find((p: any) => p.type === 'row')
  assert.equal(row.gridPos.y, 16, 'directly below the node panels')
  noOverlap(d)
})

test('no GPUs: no GPU rows at all; all three: all three, in order', () => {
  assert.deepEqual(rows(dash.renderClusterDashboard(template, [])), [])
  assert.equal(dash.renderClusterDashboard(template, []).panels.length, 4)
  const all = dash.renderClusterDashboard(template, ['nvidia', 'intel', 'amd'])
  assert.deepEqual(rows(all), ['Intel GPUs', 'AMD GPUs', 'NVIDIA GPUs'])
  noOverlap(all)
})

test('the vendors come from detection, and the provisioned file is rewritten only when it changes', () => {
  assert.deepEqual(dash.vendorsOf([{ gpus: [{ vendor: 'amd' }] }, { gpus: [{ vendor: 'nvidia' }, { vendor: 'amd' }] }, { gpus: [] }]), ['amd', 'nvidia'])
  const dir = mkdtempSync(join(tmpdir(), 'hpx-dash-'))
  mkdirSync(join(dir, 'config/grafana/dashboards'), { recursive: true })
  copyFileSync(join(root, 'config/grafana/dashboards/hyperprox-cluster.json'), join(dir, 'config/grafana/dashboards/hyperprox-cluster.json'))
  assert.deepEqual(dash.writeClusterDashboard(dir, ['amd']), { changed: true, vendors: ['amd'] })
  const out = join(dir, 'config/grafana/provisioning/dashboards/hyperprox-cluster.json')
  assert.deepEqual(rows(JSON.parse(readFileSync(out, 'utf8'))), ['AMD GPUs'])
  const t = statSync(out).mtimeMs
  assert.deepEqual(dash.writeClusterDashboard(dir), { changed: false, vendors: ['amd'] }, 'a deploy redraws from the saved set')
  assert.equal(statSync(out).mtimeMs, t)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config/grafana/gpu-vendors.json'), 'utf8')), ['amd'])
})

test('target sync draws the dashboard for the GPUs it detected', async () => {
  const tdir = mkdtempSync(join(tmpdir(), 'hpx-targets-dash-'))
  let drawn: string[] | null = null
  await syncTargets({
    nodes: async () => ['a', 'b'], address: async n => n, cephMgrs: async () => new Set(), reload: async () => {}, dir: tdir,
    pci: async n => n === 'a' ? [{ class: '0x030000', vendor: '0x1002', device: '0x15d8', device_name: 'Picasso/Raven 2 [Radeon Vega Series / Radeon Vega Mobile Series]' }] : [],
    dashboard: v => { drawn = v },
  })
  assert.deepEqual(drawn, ['amd'])
})

test('one Grafana dashboard provider, and the provisioned cluster dashboard is drawn, not kept in git', () => {
  const prov = readdirSync(join(root, 'config/grafana/provisioning/dashboards')).filter(f => /\.ya?ml$/.test(f))
  assert.deepEqual(prov, ['provider.yml'])
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
  assert.match(ignore, /^config\/grafana\/provisioning\/dashboards\/hyperprox-cluster\.json$/m)
  assert.match(readFileSync(join(root, 'bin/hyperprox-config'), 'utf8'), /draw_cluster_dashboard/)
  void existsSync
})
