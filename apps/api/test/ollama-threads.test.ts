// num_thread defaults to the bundled Ollama's CPU limit; a stored setting or the environment still wins.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cpuLimitFromNano, resolveThreads, bundledCpuLimit, isLocalAddress } from "../src/lib/ai/providers"

test("docker's NanoCpus becomes whole cores; unset or garbage is no limit", () => {
  assert.equal(cpuLimitFromNano("3000000000\n"), 3)
  assert.equal(cpuLimitFromNano("2500000000"), 2, "rounded down: a thread more than the quota gives is slower, not faster")
  assert.equal(cpuLimitFromNano("500000000"), 1)
  assert.equal(cpuLimitFromNano("0"), undefined, "0 is 'no limit'")
  assert.equal(cpuLimitFromNano(""), undefined)
  assert.equal(cpuLimitFromNano("<no value>"), undefined)
})

test("precedence: stored setting, then OLLAMA_NUM_THREAD, then the container's limit", () => {
  assert.equal(resolveThreads({ stored: 6, env: 4, cpuLimit: 3 }), 6)
  assert.equal(resolveThreads({ env: 4, cpuLimit: 3 }), 4)
  assert.equal(resolveThreads({ cpuLimit: 3 }), 3)
  assert.equal(resolveThreads({}), undefined)
  assert.equal(resolveThreads({ stored: 2.5, env: 4 }), 4, "a fractional setting is not a thread count")
})

test("only a loopback address is the bundled server", () => {
  for (const a of ["http://127.0.0.1:11434", "http://localhost:11434/", "http://[::1]:11434"]) assert.equal(isLocalAddress(a), true, a)
  for (const a of ["http://192.168.1.5:11434", "https://ollama.example.com", "", "not a url"]) assert.equal(isLocalAddress(a), false, a)
})

test("the limit is read only for a local address, and a failed probe is no limit", async () => {
  let calls = 0
  const probe = async () => { calls++; return 3 }
  assert.equal(await bundledCpuLimit("http://192.168.1.5:11434", probe), undefined)
  assert.equal(calls, 0, "a remote server's container is not ours to inspect")
  assert.equal(await bundledCpuLimit("http://127.0.0.1:11434", probe), 3)
  assert.equal(await bundledCpuLimit("http://127.0.0.1:11434", async () => { throw new Error("no docker") }), undefined)
})
