'use strict'
// =============================================================================
//  The cluster dashboard, drawn for the GPUs this cluster actually has
//
//  Grafana draws a row repeated over an empty variable once anyway, with "No data" panels, so hiding a
//  vendor's GPU row has to happen before Grafana sees the dashboard. The template,
//  config/grafana/dashboards/hyperprox-cluster.json, holds a row per vendor (Intel, AMD, NVIDIA). This
//  writes the provisioned copy, config/grafana/provisioning/dashboards/hyperprox-cluster.json, with only
//  the rows for the vendors found, and remembers the set in config/grafana/gpu-vendors.json so a deploy
//  can redraw it without asking the nodes. Target sync and the setup wizard call it when they detect the
//  GPUs; bin/hyperprox-config calls it (node dashboard.js <install dir>) on install and every deploy.
// =============================================================================

const fs = require('fs')
const path = require('path')

const VENDORS = ['intel', 'amd', 'nvidia']
const ROW_TITLE = { intel: 'Intel GPUs', amd: 'AMD GPUs', nvidia: 'NVIDIA GPUs' }

/** The vendors with a GPU on any of these nodes (facts from parseProbe or fromProxmox). */
function vendorsOf(nodes) {
  const found = new Set()
  for (const n of nodes ?? []) for (const g of n.gpus ?? []) if (VENDORS.includes(g.vendor)) found.add(g.vendor)
  return VENDORS.filter(v => found.has(v))
}

/**
 * The template with only these vendors' GPU rows. Sections are laid out again from the top, so nothing
 * leaves a gap. A row's panels are the panels below it, up to the next row.
 */
function renderClusterDashboard(template, vendors) {
  const keep = new Set(vendors ?? [])
  const d = JSON.parse(JSON.stringify(template))
  const panels = [...d.panels].sort((a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x)
  const sections = [{ row: null, panels: [] }]
  for (const p of panels) {
    if (p.type === 'row') sections.push({ row: p, panels: [] })
    else sections[sections.length - 1].panels.push(p)
  }
  const out = []
  let y = 0
  for (const s of sections) {
    if (s.row) {
      const vendor = Object.keys(ROW_TITLE).find(v => ROW_TITLE[v] === s.row.title)
      if (vendor && !keep.has(vendor)) continue
      const { repeat, ...row } = s.row
      void repeat
      out.push({ ...row, panels: [], collapsed: false, gridPos: { ...row.gridPos, y } })
      y += row.gridPos.h
    }
    if (!s.panels.length) continue
    const top = Math.min(...s.panels.map(p => p.gridPos.y))
    let h = 0
    for (const p of s.panels) {
      out.push({ ...p, gridPos: { ...p.gridPos, y: y + (p.gridPos.y - top) } })
      h = Math.max(h, p.gridPos.y - top + p.gridPos.h)
    }
    y += h
  }
  d.panels = out
  // The rows are chosen here, not by Grafana, so the vendor variables are not needed.
  d.templating = { list: (d.templating?.list ?? []).filter(v => !VENDORS.includes(v.name)) }
  return d
}

function paths(dir) {
  return {
    template: path.join(dir, 'config/grafana/dashboards/hyperprox-cluster.json'),
    out: path.join(dir, 'config/grafana/provisioning/dashboards/hyperprox-cluster.json'),
    vendors: path.join(dir, 'config/grafana/gpu-vendors.json'),
  }
}

function savedVendors(dir) {
  try { return JSON.parse(fs.readFileSync(paths(dir).vendors, 'utf8')).filter(v => VENDORS.includes(v)) } catch { return [] }
}

/**
 * Write the provisioned dashboard for these vendors (or the ones saved last time). Returns whether the
 * file changed; an unchanged dashboard is not rewritten, so Grafana does not reload it.
 */
function writeClusterDashboard(dir, vendors) {
  const p = paths(dir)
  const v = vendors ? VENDORS.filter(x => vendors.includes(x)) : savedVendors(dir)
  const text = JSON.stringify(renderClusterDashboard(JSON.parse(fs.readFileSync(p.template, 'utf8')), v), null, 2) + '\n'
  let changed = false
  let current = null
  try { current = fs.readFileSync(p.out, 'utf8') } catch { /* first time */ }
  if (current !== text) {
    fs.mkdirSync(path.dirname(p.out), { recursive: true })
    fs.writeFileSync(`${p.out}.tmp`, text)
    fs.renameSync(`${p.out}.tmp`, p.out)
    changed = true
  }
  const vt = JSON.stringify(v) + '\n'
  let cv = null
  try { cv = fs.readFileSync(p.vendors, 'utf8') } catch { /* none yet */ }
  if (cv !== vt) fs.writeFileSync(p.vendors, vt)
  return { changed, vendors: v }
}

module.exports = { VENDORS, ROW_TITLE, vendorsOf, renderClusterDashboard, writeClusterDashboard, savedVendors }

// node dashboard.js <install dir>: redraw from the saved vendor set. Prints one line when it changed.
if (require.main === module) {
  const dir = process.argv[2] || '/opt/hyperprox'
  const r = writeClusterDashboard(dir)
  if (r.changed) console.log(`cluster dashboard: drawn for ${r.vendors.length ? r.vendors.join(', ') : 'no'} GPUs`)
}
