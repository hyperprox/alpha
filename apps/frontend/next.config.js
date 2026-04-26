/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://192.0.2.251:3002/api/:path*',
      },
    ]
  },
}

module.exports = nextConfig
