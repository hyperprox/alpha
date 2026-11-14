// =============================================================================
//  HyperProx — the one way the API changes .env
//
//  apps/setup/env-file.js, shared with the setup wizard: read fresh, change, write in one rename, under a lock
//  file every writer takes. A writer must never write back a copy of .env it read before an await.
// =============================================================================

import path from 'node:path'

// The wizard's file, not a copy. src/lib and dist/lib are both two levels below apps/api.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared: { updateEnvFile(envPath: string, change: (text: string) => string | null): boolean } =
  require(path.join(__dirname, '../../../setup/env-file.js'))

/** Change .env under the shared lock. `change` gets the file as it is now; null means no change. */
export function updateEnvFile(envPath: string, change: (text: string) => string | null): boolean {
  return shared.updateEnvFile(envPath, change)
}
