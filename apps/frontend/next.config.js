const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { writeLocalRegistry } = require('./scripts/local-plugins')

// One version for the whole product: the root package.json, plus the commit the
// bundle was built from. Both are baked in at build time, so the browser never
// has to ask the API what it is.
function readVersion(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version || null } catch { return null }
}
function gitSha() {
  // A Docker build has no .git; GIT_SHA lets the caller pass it in. Neither is fatal.
  const fromEnv = (process.env.GIT_SHA || '').trim()
  if (/^[0-9a-f]{4,40}$/i.test(fromEnv)) return fromEnv.slice(0, 7)
  try {
    const out = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).toString().trim()
    return /^[0-9a-f]{4,40}$/i.test(out) ? out : ''
  } catch { return '' }
}
// `git describe --tags --always`; without .git, VERSION as `git archive` filled it in ("<describe> <sha>").
function versionFile() {
  try {
    const t = fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf8').trim()
    if (!t || t.includes('$Format')) return null
    const parts = t.split(/\s+/)
    // No tag to describe from: git archive leaves only the commit.
    if (parts.length === 1 && /^[0-9a-f]{40}$/.test(parts[0])) return { describe: parts[0].slice(0, 7), sha: parts[0].slice(0, 7) }
    const [describe, sha] = parts
    return { describe, sha: /^[0-9a-f]{40}$/.test(sha || '') ? sha.slice(0, 7) : '' }
  } catch { return null }
}
function gitDescribe() {
  const fromEnv = (process.env.GIT_DESCRIBE || '').trim()
  if (/^[0-9A-Za-z._+-]{1,80}$/.test(fromEnv)) return fromEnv
  try {
    const out = execFileSync('git', ['describe', '--tags', '--always'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).toString().trim()
    return /^[0-9A-Za-z._+-]{1,80}$/.test(out) ? out : ''
  } catch { return '' }
}
const fromFile = versionFile()
const sha = gitSha() || (fromFile ? fromFile.sha : '')
const describe = gitDescribe() || (fromFile ? fromFile.describe : '')
const version = readVersion(path.join(__dirname, '../../package.json'))
             || readVersion(path.join(__dirname, 'package.json'))
             || 'unknown'

// Local plug-in pages: the generated list in the git-ignored local-plugins/, or an empty one.
const localPlugins = writeLocalRegistry()

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // The demo (scripts/demo.sh) builds into its own folder and talks to its own API port; a normal build
  // leaves both unset and gets .next and 3002, as before.
  distDir: process.env.HYPERPROX_NEXT_DIST || '.next',
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_GIT_SHA:     sha,
    NEXT_PUBLIC_GIT_DESCRIBE: describe,
  },
  // Vault sign-in (and the first credential migration) can take ~30 s; the rewrite proxy's default is 30 s.
  experimental: { proxyTimeout: 180_000 },
  webpack(config) {
    config.resolve.alias = { ...(config.resolve.alias || {}), '@local-plugins$': localPlugins }
    return config
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://${process.env.API_HOST || 'localhost'}:${process.env.HYPERPROX_API_PORT || '3002'}/api/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
