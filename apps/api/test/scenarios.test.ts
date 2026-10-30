// One test per scenario file. CI replays the recorded model replies; SCENARIO_PROVIDER (set by
// `pnpm test:scenarios --provider <id>`) calls that provider instead and prints extraction accuracy,
// which never fails the run: it is for choosing a default model, not for gating a change.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { loadScenarios, runPlanOnly, checkScenario, loadRecording, extractionAccuracy, SCENARIOS_ROOT } from "./scenarios/runner"
import type { ProviderId } from "../src/lib/ai/providers"

const provider = process.env.SCENARIO_PROVIDER as ProviderId | undefined
let hit = 0, total = 0

for (const s of loadScenarios(join(SCENARIOS_ROOT, "deploy-service"))) {
  test(s.id, async () => {
    const rec = loadRecording(s.id)
    if (!provider) {
      const r = await runPlanOnly(s, rec)
      assert.deepEqual(checkScenario(s, r), [], `${s.id} (found by ${s.found_by})`)
      return
    }
    try {
      const r = await runPlanOnly(s, "live", provider)
      const a = extractionAccuracy(r.extractions, rec)
      hit += a.hit; total += a.total
      const diffs = checkScenario(s, r)
      console.log(`${s.id}: extraction ${a.hit}/${a.total}${diffs.length ? `; differs: ${diffs.join("; ")}` : ""}`)
    } catch (e) {
      console.log(`${s.id}: live run failed: ${(e as Error).message}`)
    }
  })
}

after(() => {
  if (provider && total) console.log(`${provider}: extraction accuracy ${hit}/${total} (${Math.round(100 * hit / total)}%)`)
})
