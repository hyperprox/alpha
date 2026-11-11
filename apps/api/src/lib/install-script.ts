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

/**
 * The Host allow-list for a recipe that checks it: `address:port` as the health check and the LAN reach
 * it, then the public name the proxy forwards. Empty for a recipe that does not check Host.
 */
export function hostEnv(r: CatalogueRecipe, at: { ip?: string; domain?: string }): Record<string, string> {
  if (!r.allowedHostsEnv) return {}
  if (!at.ip) throw new Error(`${r.name} answers only the hosts in ${r.allowedHostsEnv}, and the container has no address to put there.`)
  return { [r.allowedHostsEnv]: [`${at.ip}:${r.port}`, ...(at.domain ? [at.domain] : [])].join(',') }
}

export function installScript(r: CatalogueRecipe, distro: Distro, env: Record<string, string> = {}): string {
  for (const k of Object.keys(env)) if (!ENV_KEY.test(k)) throw new Error(`Invalid environment variable name "${k}"`)
  const lines: string[] = ['set -e', 'export DEBIAN_FRONTEND=noninteractive']

  // An env-admin recipe must be given its admin password (and any other generated secret); starting
  // without one would leave the service on a vendor default that everyone knows.
  if (r.firstRun.kind === 'env-admin') {
    for (const k of [r.firstRun.passwordEnv, ...(r.firstRun.secrets ?? []).map(s => s.env)]) {
      if (!env[k]) throw new Error(`${r.name} needs ${k} so it does not start with a default or empty password.`)
    }
  }

  if (r.install.kind === 'script') {
    // Values go in the script, which travels on standard input to a file only root can read; they are
    // never on a command line. Unset options are exported empty, so the script sees every key.
    const all: Record<string, string> = {}
    for (const o of r.options ?? []) all[o.key] = o.default ?? ''
    Object.assign(all, env)
    for (const [k, v] of Object.entries(all)) {
      if (!ENV_KEY.test(k)) throw new Error(`Invalid environment variable name "${k}"`)
      lines.push(`export ${k}=${sq(v)}`)
    }
    lines.push(r.install.script.replace(/^\s*set -e\s*\n/, '').replace(/^\s*export DEBIAN_FRONTEND=noninteractive\s*\n/, '').trim())
    return lines.join('\n')
  }
  // Without its allow-list the service refuses every request, its own health check included.
  if (r.allowedHostsEnv && !env[r.allowedHostsEnv]) {
    throw new Error(`${r.name} needs ${r.allowedHostsEnv} so it answers on its own address.`)
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
  if (r.firstRun.kind === 'env-admin') out.push(`# Choose an admin password and export ${r.firstRun.passwordEnv} before the next line.`)
  if (r.allowedHostsEnv) out.push(`# export ${r.allowedHostsEnv}=<this container's address>:${r.port} (add the public name after a comma) before the next line.`)
  out.push('docker compose up -d')
  out.push(`# Service will be available on port ${r.port}`)
  return out
}
