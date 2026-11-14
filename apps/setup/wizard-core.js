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
 * The step-3 "Existing services" map from a scan. A toggle starts ON only for a service the scan found;
 * `saved` ({ key: boolean }) is what the owner chose earlier, and can only switch off or on a found one.
 */
function servicesFromScan(list, saved) {
  const out = {}
  for (const s of list || []) {
    if (!s || !s.key) continue
    const choice = saved && typeof saved[s.key] === 'boolean' ? saved[s.key] : true
    out[s.key] = Object.assign({}, s, { enabled: Boolean(s.found) && choice })
  }
  return out
}

/** The toggles as the server receives them: { key: boolean }. */
function serviceToggles(services) {
  const out = {}
  for (const k of Object.keys(services || {})) out[k] = Boolean(services[k] && services[k].enabled)
  return out
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
  return ({ done: 'done', ok: 'checked', already: 'already there', skipped: 'skipped', failed: 'failed' })[status] || 'failed'
}

/** "Step 3 of 5" for the eyebrow above a step's title; index is 0-based. */
function stepLabel(index, total) {
  return 'Step ' + (index + 1) + ' of ' + total
}

module.exports = { retryAsync, servicesFromScan, serviceToggles, takenLabel, bootstrapSummary, statusLabel, stepLabel }
