'use strict'

/**
 * Small pure helpers of the setup wizard's page. They live here, not inside the page template, so the
 * tests can load and run them; setup.js copies each one's source into the page's script (every function
 * is self-contained: no closures over module state, no require).
 */

/**
 * Run fn(attempt) until it returns, at most `tries` times, waiting delays[i] ms after the i-th failure.
 * Throws the last error. `shouldRetry(err)` can refuse a retry (a wrong setup key will not fix itself);
 * `onRetry(err, attempt, waitMs)` is told before each wait; `sleep` is replaceable for tests.
 */
async function retryAsync(fn, opts) {
  const o = opts || {}
  const tries = o.tries || 4
  const delays = o.delays || [1000, 2000, 4000]
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  let last
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(attempt) }
    catch (err) {
      last = err
      if (attempt >= tries || (o.shouldRetry && !o.shouldRetry(err))) break
      const wait = delays[Math.min(attempt - 1, delays.length - 1)]
      if (o.onRetry) o.onRetry(err, attempt, wait)
      await sleep(wait)
    }
  }
  throw last
}

/**
 * The addresses a scanned service was found at: `candidates` ([{ host, port, detail }]) when the scan lists them,
 * else the single host an older scan result carries.
 */
function serviceCandidates(s) {
  if (s && Array.isArray(s.candidates)) return s.candidates.filter(function (c) { return c && c.host })
  return s && s.found && s.host ? [{ host: s.host, port: s.port, detail: s.detail || (s.host + ':' + s.port) }] : []
}

/**
 * The step-3 "Existing services" map from a scan. Exactly one address found: the toggle starts ON (unless the
 * owner saved it off). Several found: nothing is picked for the owner, `chosen` is '' and the toggle is off
 * until they pick one. `saved` ({ key: boolean }) and `savedHosts` ({ key: host }) are what the owner chose
 * earlier; a saved address that the scan did not find is ignored.
 */
function servicesFromScan(list, saved, savedHosts) {
  const out = {}
  for (const s of list || []) {
    if (!s || !s.key) continue
    const cands = serviceCandidates(s)
    const choice = saved && typeof saved[s.key] === 'boolean' ? saved[s.key] : true
    const want = savedHosts && typeof savedHosts[s.key] === 'string' ? savedHosts[s.key] : ''
    let chosen = ''
    if (cands.length === 1) chosen = cands[0].host
    else if (cands.length > 1 && cands.some(function (c) { return c.host === want })) chosen = want
    out[s.key] = Object.assign({}, s, { candidates: cands, chosen: chosen, enabled: cands.length > 0 && Boolean(chosen) && choice })
  }
  return out
}

/** The toggles as the server receives them: { key: boolean }. */
function serviceToggles(services) {
  const out = {}
  for (const k of Object.keys(services || {})) out[k] = Boolean(services[k] && services[k].enabled)
  return out
}

/** The address picked for each switched-on service, as the server receives it: { key: host }. */
function serviceHosts(services) {
  const out = {}
  for (const k of Object.keys(services || {})) if (services[k] && services[k].enabled && services[k].chosen) out[k] = String(services[k].chosen)
  return out
}

/**
 * The setup key from the page's address. The installer's link carries it in the fragment (/setup#k=...), which a
 * browser never sends to the server, so it stays out of access logs. An older link has it in the query (?k=...).
 * Returns { key, fromQuery }; key is '' when there is none.
 */
function setupKeyFromLocation(search, hash) {
  function dec(v) { try { return decodeURIComponent(v) } catch (e) { return v } }
  const h = /(?:^#|&)k=([^&]*)/.exec(String(hash || ''))
  if (h && h[1]) return { key: dec(h[1]), fromQuery: false }
  const q = /(?:^\?|&)k=([^&]*)/.exec(String(search || ''))
  if (q && q[1]) return { key: dec(q[1]), fromQuery: true }
  return { key: '', fromQuery: false }
}

/** "taken 3 hours ago" from an ISO time; empty when the time is unknown. */
function takenLabel(iso, nowMs) {
  const t = Date.parse(iso || '')
  if (!isFinite(t)) return ''
  const s = Math.max(0, Math.round(((nowMs == null ? Date.now() : nowMs) - t) / 1000))
  if (s < 90) return 'taken just now'
  const m = Math.round(s / 60)
  if (m < 90) return 'taken ' + m + ' minutes ago'
  const h = Math.round(m / 60)
  if (h < 48) return 'taken ' + h + ' hours ago'
  return 'taken ' + Math.round(h / 24) + ' days ago'
}

/**
 * What bootstrap.sh's result rows add up to, in plain words. Statuses: done (it changed something),
 * already (it was there before), ok (a check from the HyperProx machine passed), skipped, failed.
 */
function bootstrapSummary(rows, taken) {
  const c = { done: 0, already: 0, ok: 0, skipped: 0, failed: 0 }
  for (const r of rows || []) {
    const s = r && r.status
    if (s in c) c[s]++
    else if (s) c.failed++
  }
  const parts = []
  if (c.done) parts.push(c.done + ' set up on your nodes')
  if (c.already) parts.push(c.already + ' already in place')
  if (c.ok) parts.push(c.ok + ' checked from here')
  if (c.skipped) parts.push(c.skipped + ' skipped')
  if (c.failed) parts.push(c.failed + ' failed')
  if (!parts.length) return 'bootstrap.sh ran but recorded no results.'
  return 'When you ran bootstrap.sh: ' + parts.join(', ') + '.' + (taken ? ' Readings ' + taken + '.' : '')
}

/** The badge text for a result row's status. */
function statusLabel(status) {
  return ({ done: 'done', ok: 'checked', already: 'already there', skipped: 'skipped', failed: 'failed', found: 'found: add its login', unknown: 'unknown', partly: 'partly' })[status] || 'failed'
}

/** "Step 3 of 5" for the eyebrow above a step's title; index is 0-based. */
function stepLabel(index, total) {
  return 'Step ' + (index + 1) + ' of ' + total
}

/**
 * The Done page's line for a service the scan found and the person kept on. Found is not connected: NPM and PBS
 * need a login HyperProx does not have yet (the wizard never asks for one), so they say where they were found and
 * where to add the login, with a link there. Ollama needs no login, so it is connected.
 */
function serviceDoneRow(a) {
  const LOGIN_PLACE = {
    npm: { where: 'Settings → Proxy', href: '/proxy' },
    pbs: { where: 'Plug-ins → Proxmox Backup Server', href: '/plugins' },
  }
  if (!a.enabled) return { label: a.name, status: 'skipped', reason: 'found, and left off as you chose' }
  const at = `${a.host}:${a.port}`
  const place = LOGIN_PLACE[a.key]
  if (place && !a.hasLogin) {
    return { label: a.name, status: 'found', reason: `found at ${at}; not connected yet: add its login in ${place.where}`, href: place.href, action: 'Add its login' }
  }
  return { label: a.name, status: 'done', reason: `connected at ${at}` }
}

module.exports = { serviceDoneRow, retryAsync, serviceCandidates, servicesFromScan, serviceToggles, serviceHosts, setupKeyFromLocation, takenLabel, bootstrapSummary, statusLabel, stepLabel }
