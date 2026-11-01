// =============================================================================
//  Scenario runner (plan-only tier)
//
//  A scenario is a real prompt, a fake cluster, and the questions and fields the
//  wizard must end with. The model's replies are recorded, one per call, and fed
//  in through callStructured's send layer, so the real request, parse and drop
//  logic runs; only the network does not. Nothing here talks to a cluster.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { startLoop, answerLoop, type LoopDeps, type LoopState, type LoopStateName, type Extraction } from "../../src/lib/ai/loop"
import { extractFields, type ModelCall } from "../../src/lib/ai/extract"
import { matchIntent, type IntentResult } from "../../src/lib/ai/intent"
import { callStructured, type ProviderId } from "../../src/lib/ai/providers"
import type { FieldValue, TemplateFacts } from "../../src/lib/ai/templates/types"

// js-yaml ships no types; only load() is used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require("js-yaml") as { load(src: string): unknown }

export interface Scenario {
  id: string
  prompt: string
  facts: string
  answers: Array<{ field: string; value: unknown } | { text: string }>
  expect: {
    state: LoopStateName
    questions: string[]
    fields?: Record<string, unknown>
    dropped?: string[]
    /** How many intent model calls the run makes. A prompt the keywords are sure of makes none. */
    intent_calls?: number
    preflight?: "all-pass" | Record<string, boolean>
  }
  outcome?: unknown
  found_by: string
}
export interface Recording { intent: IntentResult; extractions: Array<Record<string, unknown>> }
export interface RunResult { state: LoopState; questions: string[]; dropped: string[]; extractions: Array<Record<string, unknown>>; intentCalls: number }

/** test/scenarios: facts paths resolve against it and recordings live under it. */
export const SCENARIOS_ROOT = __dirname
export const recordingPath = (id: string) => join(SCENARIOS_ROOT, "recordings", `${id}.json`)
export const loadRecording = (id: string): Recording => JSON.parse(readFileSync(recordingPath(id), "utf8"))

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort().map(f => {
    const s = yaml.load(readFileSync(join(dir, f), "utf8")) as Partial<Scenario> | null
    if (!s || typeof s !== "object") throw new Error(`${f}: not a scenario`)
    for (const k of ["id", "prompt", "facts", "found_by"] as const) {
      if (typeof s[k] !== "string" || !s[k]) throw new Error(`${f}: ${k} is required`)
    }
    if (!s.expect || typeof s.expect.state !== "string" || !Array.isArray(s.expect.questions)) throw new Error(`${f}: expect.state and expect.questions are required`)
    return { answers: [], ...s } as Scenario
  })
}

// ---------------------------------------------------------------------------
//  Matching
// ---------------------------------------------------------------------------

/** null = match; otherwise why not. */
export function matchField(expected: unknown, actual: FieldValue | undefined): string | null {
  if (expected === null) return actual === undefined ? null : `expected no value, got ${JSON.stringify(actual.value)}`
  if (!actual) return "missing"
  if (expected === "{fact}" || expected === "{derived}") {
    const want = expected.slice(1, -1)
    return actual.source === want ? null : `expected a ${want} value, got ${actual.source} (${JSON.stringify(actual.value)})`
  }
  if (typeof expected === "string") {
    const m = /^(>=|<=)\s*(-?\d+(?:\.\d+)?)$/.exec(expected)
    if (m) {
      const n = Number(m[2])
      const v = actual.value
      if (typeof v !== "number") return `${JSON.stringify(v)} is not a number`
      return (m[1] === ">=" ? v >= n : v <= n) ? null : `${v} is not ${m[1]} ${n}`
    }
  }
  return JSON.stringify(actual.value) === JSON.stringify(expected) ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual.value)}`
}

/** Every way the run differs from what the scenario expects; empty is a pass. */
export function checkScenario(s: Scenario, r: RunResult): string[] {
  const out: string[] = []
  const e = s.expect
  if (r.state.state !== e.state) out.push(`state: expected ${e.state}, got ${r.state.state}`)
  if (JSON.stringify(r.questions) !== JSON.stringify(e.questions)) out.push(`questions: expected [${e.questions}], got [${r.questions}]`)
  for (const [k, want] of Object.entries(e.fields ?? {})) {
    const why = matchField(want, r.state.fields[k])
    if (why) out.push(`field ${k}: ${why}`)
  }
  if (e.dropped && JSON.stringify([...e.dropped].sort()) !== JSON.stringify(r.dropped)) out.push(`dropped: expected [${[...e.dropped].sort()}], got [${r.dropped}]`)
  if (e.intent_calls !== undefined && r.intentCalls !== e.intent_calls) out.push(`intent calls: expected ${e.intent_calls}, got ${r.intentCalls}`)
  if (e.preflight !== undefined) out.push("preflight: not supported by the runner yet")
  return out
}

// ---------------------------------------------------------------------------
//  Running
// ---------------------------------------------------------------------------

export function loadFacts(file: string): TemplateFacts {
  return JSON.parse(readFileSync(join(SCENARIOS_ROOT, file), "utf8"))
}

/**
 * `rec` replays recorded model replies in order, one per call; 'live' calls `provider` instead and
 * returns what it said in `extractions`, for the caller to compare with a recording.
 */
export async function runPlanOnly(s: Scenario, rec: Recording | "live", provider?: ProviderId): Promise<RunResult> {
  const live = rec === "live"
  const replay = live ? [] : [...rec.extractions]
  const seen: Array<Record<string, unknown>> = []

  // The recorded reply goes through the real send layer, so request building and parsing both run.
  const asProvider: ProviderId = provider ?? "anthropic"
  const modelCall = (next: () => unknown): ModelCall => r =>
    live
      ? callStructured({ ...r, parse: raw => { seen.push(raw as Record<string, unknown>); return r.parse(raw) } }, provider)
      : (() => { const reply = next(); return callStructured(r, asProvider, async () => JSON.stringify(reply), { model: "recorded" }) })()

  let intentCalls = 0
  const intentCall = modelCall(() => { intentCalls++; return (rec as Recording).intent })
  const extractCall = modelCall(() => {
    const reply = replay.shift()
    if (!reply) throw new Error("recording has no extraction left for this call")
    seen.push(reply)
    return reply
  })

  const dropped = new Set<string>()
  const deps: LoopDeps = {
    facts: loadFacts(s.facts),
    settings: { bridge: "vmbr0" },
    intent: prompt => matchIntent(prompt, { call: intentCall }),
    extract: async (t, text, facts, opts) => {
      const x: Extraction = await extractFields(t, text, facts, { asking: opts?.asking, call: extractCall, log: () => {} })
      x.dropped.forEach(k => dropped.add(k))
      return x
    },
    now: () => new Date("2026-01-01T00:00:00Z"),
  }

  const questions: string[] = []
  const track = (st: LoopState, before: number) => {
    if (st.state === "asking" && st.pending && st.asked > before) questions.push(st.pending.field)
  }
  let st = await startLoop(s.prompt, deps)
  track(st, 0)
  for (const a of s.answers) {
    if (st.state !== "asking" || !st.pending) throw new Error(`scenario ${s.id}: answer given but the session is ${st.state}, not asking`)
    if ("field" in a && a.field !== st.pending.field) throw new Error(`scenario ${s.id}: asked ${st.pending.field}, answered ${a.field}`)
    const before = st.asked
    st = await answerLoop(st, a, deps)
    track(st, before)
  }

  if (!live) {
    if (replay.length) throw new Error(`scenario ${s.id}: ${replay.length} recorded extraction(s) unused`)
  }
  return { state: st, questions, dropped: [...dropped].sort(), extractions: seen, intentCalls }
}

// ---------------------------------------------------------------------------
//  Live accuracy
// ---------------------------------------------------------------------------

/** Per recorded call, how many of the recorded keys a live reply got exactly right. */
export function extractionAccuracy(live: Array<Record<string, unknown>>, rec: Recording): { hit: number; total: number } {
  let hit = 0, total = 0
  rec.extractions.forEach((want, i) => {
    for (const k of Object.keys(want)) {
      total++
      if (JSON.stringify(live[i]?.[k] ?? null) === JSON.stringify(want[k] ?? null)) hit++
    }
  })
  return { hit, total }
}
