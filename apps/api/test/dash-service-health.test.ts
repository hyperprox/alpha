// Probes must end in a real state quickly, and the version must come from the one place it is kept.
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { AddressInfo } from "node:net"
import {
  candidateUrls, checkGrafana, checkPrometheus, npmHealth, withTimeout, resolvePrometheusUrl, _resetPrometheusCache,
} from "../src/lib/service-health"
import { clusterPower } from "../src/lib/power"
import { resolveVersion, readGitSha } from "../src/lib/version"

function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const srv = http.createServer(handler)
    srv.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      close: () => new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()) }),
    }))
  })
}

// A port nothing listens on: bind, note, release.
async function deadUrl(): Promise<string> {
  const s = await serve((_, res) => res.end())
  const url = s.url
  await s.close()
  return url
}

test("candidates: an override is the only candidate; otherwise loopback, HOST_IP, then the compose name", () => {
  assert.deepEqual(candidateUrls("http://x:1/", 9090, "prometheus", {}), ["http://x:1"])
  assert.deepEqual(candidateUrls(undefined, 9090, "prometheus", {}), ["http://127.0.0.1:9090", "http://prometheus:9090"])
  assert.deepEqual(candidateUrls(undefined, 3003, "grafana", { HOST_IP: "10.0.0.5" }),
    ["http://127.0.0.1:3003", "http://10.0.0.5:3003", "http://grafana:3003"])
})

test("grafana: connected carries version and the address that answered", async () => {
  const g = await serve((_, res) => res.end(JSON.stringify({ version: "11.0.0", database: "ok" })))
  try {
    const h = await checkGrafana([await deadUrl(), g.url])
    assert.equal(h.state, "connected")
    assert.equal(h.connected, true)
    assert.equal(h.version, "11.0.0")
    assert.equal(h.url, g.url)
  } finally { await g.close() }
})

test("prometheus: a refused connection ends as unreachable, not as an open question", async () => {
  const h = await checkPrometheus([await deadUrl()])
  assert.equal(h.state, "unreachable")
  assert.equal(h.connected, false)
  assert.match(h.message!, /no answer from/)
})

test("a service that accepts the connection and never replies still ends within the timeout", async () => {
  const hang = await serve(() => { /* never respond */ })
  try {
    const t0 = Date.now()
    const h = await checkPrometheus([hang.url], 300)
    assert.equal(h.state, "unreachable")
    assert.ok(Date.now() - t0 < 2000, "bounded by the timeout")
  } finally { await hang.close() }
})

test("a non-2xx answer is not 'connected'", async () => {
  const bad = await serve((_, res) => { res.statusCode = 503; res.end() })
  try { assert.equal((await checkPrometheus([bad.url])).state, "unreachable") } finally { await bad.close() }
})

test("npm: no credentials is not-configured, failure is unreachable with the reason, stats are connected", () => {
  assert.equal(npmHealth({ configured: false }).state, "not-configured")
  const down = npmHealth({ configured: true, stats: null, error: "timed out", url: "https://npm.example" })
  assert.equal(down.state, "unreachable")
  assert.equal(down.message, "timed out")
  const up = npmHealth({ configured: true, stats: { total: 4, enabled: 3 }, url: "https://npm.example" })
  assert.equal(up.state, "connected")
  assert.equal(up.total, 4)
})

test("withTimeout rejects a promise that never settles", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 50, "thing"), /thing timed out/)
  assert.equal(await withTimeout(Promise.resolve(7), 50, "thing"), 7)
})

test("prometheus URL: an explicit override is used as given, even when it is down", async () => {
  _resetPrometheusCache()
  assert.equal(await resolvePrometheusUrl({ PROMETHEUS_URL: "http://example.invalid:9090/" } as any), "http://example.invalid:9090")
})

test("power: no data from a reachable Prometheus is 'no meter', an unreachable one says so", async () => {
  const empty = await serve((_, res) => res.end(JSON.stringify({ status: "success", data: { result: [] } })))
  const saved = process.env.PROMETHEUS_URL
  try {
    process.env.PROMETHEUS_URL = empty.url
    const ok = await clusterPower(["node-a", "node-b"])
    assert.equal(ok.reporting, 0)
    assert.equal(ok.of, 2)
    assert.equal(ok.prometheusUnreachable, false)

    process.env.PROMETHEUS_URL = await deadUrl()
    const down = await clusterPower(["node-a"])
    assert.equal(down.prometheusUnreachable, true)
  } finally {
    if (saved === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = saved
    await empty.close()
  }
})

test("power: a node reporting RAPL is counted", async () => {
  const prom = await serve((req, res) => {
    const q = new URL(req.url!, "http://x").searchParams.get("query") ?? ""
    const result = q.includes("rapl_package") ? [{ metric: { node: "node-a" }, value: [0, "12.5"] }] : []
    res.end(JSON.stringify({ status: "success", data: { result } }))
  })
  const saved = process.env.PROMETHEUS_URL
  try {
    process.env.PROMETHEUS_URL = prom.url
    const p = await clusterPower(["node-a", "node-b"])
    assert.equal(p.reporting, 1)
    assert.deepEqual(p.silent, ["node-b"])
    assert.equal(p.total, 13)
  } finally {
    if (saved === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = saved
    await prom.close()
  }
})

test("version: read from the root package.json, with the commit from GIT_SHA when git is absent", () => {
  const v = resolveVersion()
  assert.match(v.version, /^\d+\.\d+\.\d+/)
  assert.equal(readGitSha("/nonexistent", { GIT_SHA: "ABCDEF1234" } as any), "ABCDEF1")
  assert.equal(readGitSha("/nonexistent", {} as any), "")
})
