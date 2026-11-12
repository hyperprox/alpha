// =============================================================================
//  HyperProx — self-update: the updater process
//
//    systemd-run --unit=hyperprox-update-<id> ... flock -n <deploy lock> \
//      node <data/self-update/run-<id>>/updater-main.js <job.json>
//
//  Started by the API (lib/self-update/service.ts) from a copy of these files,
//  so replacing the checkout (and the API restarting) does not touch the code
//  that is doing it. It reads the job, runs the steps (runner.ts), and writes
//  its progress to the state file the API reads back.
//
//  Builtins only (see state.ts).
// =============================================================================

import fs from 'fs'
import { RealShell, realHttpGet } from './shell'
import { FileStateSink, initialState, type UpdateJob } from './state'
import { redactorForInstall } from './redact'
import { runUpdate } from './runner'

async function main(): Promise<number> {
  const file = process.argv[2]
  if (!file) { console.error('usage: updater-main.js <job.json>'); return 2 }
  const job = JSON.parse(fs.readFileSync(file, 'utf8')) as UpdateJob
  const redact = redactorForInstall(job.dir)
  const unit = process.env.INVOCATION_ID ? `hyperprox-update-${job.id}` : undefined
  const sink = new FileStateSink(job.stateFile, initialState(job, unit), job.logFile)
  // The journal gets the same lines as the page, secrets removed the same way.
  const echo = sink.line.bind(sink)
  sink.line = (l: string) => { console.log(l); echo(l) }
  const end = await runUpdate(job, { sh: new RealShell(), http: realHttpGet, state: sink, redact })
  sink.flush()
  return end.status === 'succeeded' ? 0 : end.status === 'rolled-back' ? 3 : 1
}

main().then(code => process.exit(code), (e) => { console.error(`updater crashed: ${e?.message ?? e}`); process.exit(1) })
