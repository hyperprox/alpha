'use strict'
/**
 * The one way HyperProx's own code changes .env: read it fresh, change it, write it back in one rename, all
 * under a lock file (<.env>.lock) that every writer takes: the setup wizard (setup.js), and the API's credential
 * migration and setup-done marker (apps/api/src/lib/env-file.ts requires this file). A writer that read .env
 * earlier and wrote it back later used to undo what another wrote in between (the setup key came back after the
 * owner's first sign-in because the migration wrote the copy it had read before the key was removed).
 *
 * Synchronous on purpose: inside one Node process nothing else runs between the read and the write, and the
 * lock file covers the other processes. A lock older than STALE_MS is a writer that died; it is taken over.
 */
const fs = require('fs')

const STALE_MS = 30_000
const WAIT_MS = 5_000

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function takeLock(lock) {
  const until = Date.now() + WAIT_MS
  for (;;) {
    try { return fs.openSync(lock, 'wx', 0o600) } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) { fs.unlinkSync(lock); continue } } catch { continue }
      if (Date.now() > until) throw new Error(`.env is being changed by another writer (${lock}); try again`)
      sleepSync(25)
    }
  }
}

/**
 * Change .env under the lock: `change(text)` gets the file as it is now ('' when missing) and returns the new
 * text, or null for no change. Returns true when the file was written. Mode 0600.
 */
function updateEnvFile(envPath, change) {
  const lock = `${envPath}.lock`
  const fd = takeLock(lock)
  try {
    let text = ''
    try { text = fs.readFileSync(envPath, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    const next = change(text)
    if (next === null || next === undefined || next === text) return false
    const tmp = `${envPath}.hpx-tmp-${process.pid}`
    fs.writeFileSync(tmp, next, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, envPath)
    return true
  } finally {
    fs.closeSync(fd)
    try { fs.unlinkSync(lock) } catch { /* already gone */ }
  }
}

module.exports = { updateEnvFile }
