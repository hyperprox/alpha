// =============================================================================
//  HyperProx — building an install script from a catalogue recipe
//
//  One function turns a recipe into the script that runs inside the container,
//  so the wizard and the catalogue page cannot drift apart. Two facts it keeps
//  true: Debian packages Compose v2 as `docker-compose` and Ubuntu as
//  `docker-compose-v2`, chosen by distro and never by trying one and falling
//  back to the other; and the script stops at its first failure (`set -e`), so
//  the exit code and the last output point at the step that broke.
// =============================================================================

import type { CatalogueRecipe } from './catalogue'

export type Distro = 'debian' | 'ubuntu'

export const DOCKER_PACKAGES: Readonly<Record<Distro, readonly string[]>> = {
  debian: ['ca-certificates', 'curl', 'docker.io', 'docker-compose'],
  ubuntu: ['ca-certificates', 'curl', 'docker.io', 'docker-compose-v2'],
}

/** Distro of a template volume id (`…debian-13-standard_…`) or of a guest's `ostype`. */
export function distroOf(volidOrOstype: string): Distro | null {
  const s = String(volidOrOstype ?? '').toLowerCase()
  const name = s.slice(s.lastIndexOf('/') + 1)
  if (name === 'debian' || name.startsWith('debian-')) return 'debian'
  if (name === 'ubuntu' || name.startsWith('ubuntu-')) return 'ubuntu'
  return null
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const sq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`

function packagesFor(r: CatalogueRecipe, distro: Distro): string[] {
  const base = r.install.kind === 'compose' || r.needsDocker ? [...DOCKER_PACKAGES[distro]] : []
  return [...new Set([...base, ...(r.packages?.[distro] ?? [])])]
}

export function installScript(r: CatalogueRecipe, distro: Distro, env: Record<string, string> = {}): string {
  for (const k of Object.keys(env)) if (!ENV_KEY.test(k)) throw new Error(`Invalid environment variable name "${k}"`)
  const lines: string[] = ['set -e', 'export DEBIAN_FRONTEND=noninteractive']

  if (r.install.kind === 'script') {
    for (const [k, v] of Object.entries(env)) lines.push(`export ${k}=${sq(v)}`)
    lines.push(r.install.script.replace(/^\s*set -e\s*\n/, '').replace(/^\s*export DEBIAN_FRONTEND=noninteractive\s*\n/, '').trim())
    return lines.join('\n')
  }

  const pkgs = packagesFor(r, distro)
  lines.push('apt-get update -qq')
  if (pkgs.length) lines.push(`apt-get install -y -qq ${pkgs.join(' ')}`)
  lines.push('systemctl enable --now docker')
  lines.push(`mkdir -p ${r.install.dir} && cd ${r.install.dir}`)
  const envEntries = Object.entries(env)
  if (envEntries.length) {
    // Compose reads .env beside the compose file for ${VAR} substitution; keep it private.
    lines.push('umask 077')
    lines.push(`cat > .env <<'HP_ENV'`)
    for (const [k, v] of envEntries) lines.push(`${k}=${String(v).replace(/\n/g, ' ')}`)
    lines.push('HP_ENV')
    lines.push('umask 022')
  }
  lines.push(`cat > docker-compose.yml <<'HP_COMPOSE'`, r.install.compose, 'HP_COMPOSE')
  // --quiet-pull keeps progress bars out of the output, so a failure's last lines are the error.
  lines.push('docker compose up -d --quiet-pull')
  return lines.join('\n')
}

/** The same install as commands a person can run by hand. Secrets in `env` are never printed. */
export function manualCommands(r: CatalogueRecipe, distro: Distro): string[] {
  const out = ['# Run these commands inside the container:']
  const pkgs = packagesFor(r, distro)
  if (r.install.kind === 'script') {
    out.push(...r.install.script.split('\n').filter(l => l.trim() && !/^\s*set -e\s*$/.test(l)))
    return out
  }
  out.push(`apt-get update -qq && apt-get install -y ${pkgs.join(' ')}`)
  out.push('systemctl enable --now docker')
  out.push(`mkdir -p ${r.install.dir} && cd ${r.install.dir}`)
  out.push(`cat > docker-compose.yml << 'EOF'`, r.install.compose, 'EOF')
  out.push('docker compose up -d')
  out.push(`# Service will be available on port ${r.port}`)
  return out
}
