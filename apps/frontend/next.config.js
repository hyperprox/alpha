/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
