/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
