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
const crypto = require('crypto')

const STALE_MS = 30_000
const WAIT_MS = 5_000

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/**
 * The lock is a file made with O_EXCL that holds its owner's token ("<pid>:<nonce>"). The shell writers
 * (install.sh, bootstrap.sh's in-container step, bin/hyperprox-config) take the same file the same way
 * (set -C, a token, the same stale rule), so every .env writer excludes every other.
 *
 * A lock older than STALE_MS belongs to a writer that died. It is taken over by renaming it to a name of our
 * own first: of two writers that both see it stale, only one rename succeeds, so only one of them deletes it
 * (deleting by name could remove a lock the other had just taken). Released only if it still holds our token.
 */
function takeLock(lock) {
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`
  const until = Date.now() + WAIT_MS
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      try { fs.writeSync(fd, token) } finally { fs.closeSync(fd) }
      return token
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let st = null
      try { st = fs.statSync(lock) } catch { continue }   // released meanwhile: try again
      if (Date.now() - st.mtimeMs > STALE_MS) {
        const aside = `${lock}.stale-${token.replace(':', '-')}`
        try { fs.renameSync(lock, aside); fs.unlinkSync(aside) } catch { /* another writer took it over first */ }
        continue
      }
      if (Date.now() > until) throw new Error(`.env is being changed by another writer (${lock}); try again`)
      sleepSync(25)
    }
  }
}

/**
 * Remove the lock only if it is still ours. It can stop being ours only if we held it past STALE_MS and another
 * writer took it over; a writer holds it for milliseconds, so the read-then-unlink window is not a practical race.
 */
function releaseLock(lock, token) {
  let held = null
  try { held = fs.readFileSync(lock, 'utf8').trim() } catch { return }
  if (held === token) { try { fs.unlinkSync(lock) } catch { /* gone */ } }
}

/**
 * Change .env under the lock: `change(text)` gets the file as it is now ('' when missing) and returns the new
 * text, or null for no change. Returns true when the file was written. Mode 0600.
 */
function updateEnvFile(envPath, change) {
  const lock = `${envPath}.lock`
  const token = takeLock(lock)
  try {
    let text = ''
    try { text = fs.readFileSync(envPath, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    const next = change(text)
    if (next === null || next === undefined || next === text) return false
    const tmp = `${envPath}.hpx-tmp-${process.pid}`
    try { fs.unlinkSync(tmp) } catch { /* none */ }
    fs.writeFileSync(tmp, next, { mode: 0o600, flag: 'wx' })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, envPath)
    return true
  } finally {
    releaseLock(lock, token)
  }
}

module.exports = { updateEnvFile, takeLock, releaseLock, STALE_MS }
