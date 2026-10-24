const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

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
const version = readVersion(path.join(__dirname, '../../package.json'))
             || readVersion(path.join(__dirname, 'package.json'))
             || 'unknown'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_GIT_SHA:     gitSha(),
  },
  // Vault sign-in (and the first credential migration) can take ~30 s; the rewrite proxy's default is 30 s.
  experimental: { proxyTimeout: 180_000 },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://${process.env.API_HOST || 'localhost'}:3002/api/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
