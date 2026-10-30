// Disconnecting Ollama must clear the settings where they are read from (the vault), not the old table.
import { test } from "node:test"
import assert from "node:assert/strict"
import { clearOllamaConnection } from "../src/routes/ollama"

test("disconnect clears url and model through setCredential with empty strings", async () => {
  const calls: unknown[][] = []
  await clearOllamaConnection(async (...a: unknown[]) => { calls.push(a) })
  assert.deepEqual(calls.map(c => c.slice(0, 4)), [
    ["ai", "ollama", "url", ""],
    ["ai", "ollama", "model", ""],
  ])
})
