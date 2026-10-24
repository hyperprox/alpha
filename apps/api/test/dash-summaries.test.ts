// The dashboard's arithmetic, each case a fault seen on a fresh install: HA read 0 with a dozen resources,
// the storage gauge and the Ceph bar disagreed, and power showed a bare dash.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  formatBinary, summarizeStorage, summarizeHA, powerStatus, serviceState,
} from "../../frontend/components/dashboard/summaries"

const TiB = 1024 ** 4

test("formatBinary names binary units as binary", () => {
  assert.equal(formatBinary(0), "0 B")
  assert.equal(formatBinary(1536), "1.5 KiB")
  assert.equal(formatBinary(27.2 * TiB), "27.2 TiB")
  assert.equal(formatBinary(NaN), "0 B")
})

test("storage: a shared storage counts once, a node-local one counts per node", () => {
  const s = summarizeStorage([
    { storage: "pool", node: "node-a", shared: 1, total: 10 * TiB, used: 4 * TiB },
    { storage: "pool", node: "node-b", shared: 1, total: 10 * TiB, used: 4 * TiB },
    { storage: "local", node: "node-a", shared: 0, total: 20, used: 10 },
    { storage: "local", node: "node-b", shared: 0, total: 20, used: 5 },
  ])
  assert.equal(s.count, 3)
  assert.equal(s.total, 10 * TiB + 40)
  assert.equal(s.used, 4 * TiB + 15)
})

test("storage: disabled, inactive and zero-size entries are ignored; junk input is an empty summary", () => {
  const s = summarizeStorage([
    { storage: "a", node: "n", total: 100, used: 50 },
    { storage: "b", node: "n", total: 100, used: 50, active: 0 },
    { storage: "c", node: "n", total: 100, used: 50, enabled: 0 },
    { storage: "d", node: "n", total: 0, used: 0 },
  ])
  assert.deepEqual(s, { used: 50, total: 100, pct: 50, count: 1 })
  assert.deepEqual(summarizeStorage(null), { used: 0, total: 0, pct: 0, count: 0 })
})

test("HA: counts service entries from the status feed, not a per-guest field", () => {
  const h = summarizeHA([
    { id: "quorum", type: "quorum" },
    { id: "master", type: "master" },
    { id: "service:ct:101", type: "service", crm_state: "started" },
    { id: "service:vm:102", type: "service", crm_state: "stopped" },
    { id: "service:ct:103", type: "service", crm_state: "started" },
  ])
  assert.deepEqual(h, { state: "ok", services: 3, started: 2 })
})

test("HA: no data is unavailable, never zero; a live cluster with no HA guests is a true zero", () => {
  assert.deepEqual(summarizeHA(null), { state: "unavailable" })
  assert.deepEqual(summarizeHA([]), { state: "unavailable" })
  assert.deepEqual(summarizeHA([{ id: "quorum", type: "quorum" }]), { state: "ok", services: 0, started: 0 })
})

test("power: shown when anything reports; otherwise hidden with the reason", () => {
  assert.deepEqual(powerStatus({ reporting: 2, of: 5 }), { show: true })
  const none = powerStatus({ reporting: 0, of: 5 })
  assert.equal(none.show, false)
  assert.match(none.note!, /no node reports watts/)
  assert.match(powerStatus({ reporting: 0, of: 5, prometheusUnreachable: true }).note!, /Prometheus is not answering/)
  assert.deepEqual(powerStatus(null), { show: false })
})

test("service state: explicit state wins; the legacy feed degrades without losing not-configured", () => {
  assert.equal(serviceState({ state: "not-configured", connected: false }), "not-configured")
  assert.equal(serviceState({ connected: true }), "connected")
  assert.equal(serviceState({ connected: false }), "unreachable")
  assert.equal(serviceState({ connected: false }, "not-configured"), "not-configured")
  assert.equal(serviceState(undefined), "unreachable")
})
