#!/usr/bin/env bash
# =============================================================================
#  HyperProx — Monorepo Scaffold
#  Run inside CT 751: bash /opt/hyperprox/hyperprox-init.sh
#  Creates: frontend (Next.js 14), api (Fastify + Prisma), setup wizard
# =============================================================================

set -euo pipefail

BASE="/opt/hyperprox"
NODE_VERSION="20"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${CYAN}[INIT]${RESET} $*"; }
ok()   { echo -e "${GREEN}[  OK  ]${RESET} $*"; }
warn() { echo -e "${YELLOW}[ WARN ]${RESET} $*"; }

cd "$BASE"

# =============================================================================
#  NODE.JS 20 LTS
# =============================================================================

log "Installing Node.js ${NODE_VERSION} LTS..."

curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y -qq nodejs
npm install -g npm@latest pnpm

node --version
pnpm --version

ok "Node.js $(node --version) + pnpm ready."

# =============================================================================
#  ROOT WORKSPACE (pnpm monorepo)
# =============================================================================

log "Initialising pnpm workspace..."

cat > $BASE/package.json << 'EOF'
{
  "name": "hyperprox",
  "version": "0.1.0",
  "private": true,
  "description": "Your Proxmox infrastructure, hypercharged.",
  "scripts": {
    "dev":       "pnpm --parallel --filter './apps/*' dev",
    "build":     "pnpm --filter './apps/*' build",
    "lint":      "pnpm --filter './apps/*' lint",
    "typecheck": "pnpm --filter './apps/*' typecheck"
  }
}
EOF

cat > $BASE/pnpm-workspace.yaml << 'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF

cat > $BASE/.gitignore << 'EOF'
# Dependencies
node_modules/
.pnpm-store/

# Build outputs
.next/
dist/
build/

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
logs/
npm-debug.log*

# Runtime
.DS_Store
*.pem
.turbo/

# Docker
data/
EOF

mkdir -p $BASE/apps $BASE/packages

ok "Workspace ready."

# =============================================================================
#  SHARED PACKAGES
# =============================================================================

log "Creating shared packages..."

# packages/types — shared TypeScript types
mkdir -p $BASE/packages/types/src
cat > $BASE/packages/types/package.json << 'EOF'
{
  "name": "@hyperprox/types",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
EOF

cat > $BASE/packages/types/src/index.ts << 'EOF'
// =============================================================================
//  HyperProx — Shared Types
// =============================================================================

// --- Proxmox -----------------------------------------------------------------

export type NodeStatus = 'online' | 'offline' | 'unknown'
export type VMStatus   = 'running' | 'stopped' | 'paused' | 'suspended'

export interface ProxmoxNode {
  id:         string
  name:       string
  status:     NodeStatus
  cpu:        number        // 0-1
  maxcpu:     number
  mem:        number        // bytes
  maxmem:     number
  disk:       number
  maxdisk:    number
  uptime:     number        // seconds
  type:       'node'
  roles?:     string[]      // e.g. ['gpu', 'primary']
}

export interface ProxmoxVM {
  vmid:       number
  name:       string
  status:     VMStatus
  type:       'qemu' | 'lxc'
  node:       string
  cpu:        number
  cpus:       number
  mem:        number
  maxmem:     number
  disk:       number
  maxdisk:    number
  uptime:     number
  netIn:      number
  netOut:     number
  tags?:      string[]
}

// --- Proxy -------------------------------------------------------------------

export type ProxyProvider  = 'npm' | 'traefik' | 'caddy' | 'haproxy' | 'pangolin'
export type SSLStatus      = 'valid' | 'expiring' | 'expired' | 'none' | 'pending'

export interface ProxyHost {
  id:           string
  domain:       string
  target:       string
  port:         number
  ssl:          SSLStatus
  sslExpiry?:   string
  enabled:      boolean
  provider:     ProxyProvider
  containerId?: number
}

// --- DNS ---------------------------------------------------------------------

export type DNSProvider  = 'godaddy' | 'cloudflare' | 'namecheap' | 'route53' | 'porkbun'
export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'SRV' | 'NS'

export interface DNSRecord {
  id:       string
  type:     DNSRecordType
  name:     string
  value:    string
  ttl:      number
  domain:   string
  provider: DNSProvider
}

// --- Events ------------------------------------------------------------------

export type EventSeverity = 'info' | 'warning' | 'error' | 'success'

export interface ClusterEvent {
  id:        string
  timestamp: string
  severity:  EventSeverity
  source:    string
  message:   string
  nodeId?:   string
  vmid?:     number
}

// --- API Response envelope ---------------------------------------------------

export interface ApiResponse<T> {
  success: boolean
  data?:   T
  error?:  string
  meta?: {
    page?:  number
    total?: number
  }
}

// --- WebSocket messages ------------------------------------------------------

export type WSEventType =
  | 'node:update'
  | 'vm:update'
  | 'cluster:event'
  | 'proxy:update'
  | 'dns:update'
  | 'task:update'

export interface WSMessage {
  type:      WSEventType
  payload:   unknown
  timestamp: string
}
EOF

ok "Shared types package ready."

# =============================================================================
#  API — Fastify + Prisma
# =============================================================================

log "Scaffolding API (Fastify + Prisma)..."

mkdir -p $BASE/apps/api/src/{routes,services,plugins,jobs,lib}
mkdir -p $BASE/apps/api/prisma

# package.json
cat > $BASE/apps/api/package.json << 'EOF'
{
  "name": "@hyperprox/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev":        "tsx watch src/index.ts",
    "build":      "tsc -p tsconfig.json",
    "start":      "node dist/index.js",
    "typecheck":  "tsc --noEmit",
    "db:migrate": "prisma migrate dev",
    "db:push":    "prisma db push",
    "db:studio":  "prisma studio",
    "db:seed":    "tsx prisma/seed.ts"
  },
  "dependencies": {
    "@fastify/cors":       "^9.0.1",
    "@fastify/helmet":     "^11.1.1",
    "@fastify/jwt":        "^8.0.1",
    "@fastify/rate-limit": "^9.1.0",
    "@fastify/websocket":  "^10.0.1",
    "@hyperprox/types":    "workspace:*",
    "@prisma/client":      "^5.22.0",
    "bullmq":              "^5.13.0",
    "fastify":             "^4.28.1",
    "ioredis":             "^5.4.1",
    "node-proxmox":        "^1.1.1",
    "pino":                "^9.4.0",
    "zod":                 "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "prisma":      "^5.22.0",
    "tsx":         "^4.19.1",
    "typescript":  "^5.6.2"
  }
}
EOF

# TypeScript config
cat > $BASE/apps/api/tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target":           "ES2022",
    "module":           "CommonJS",
    "lib":              ["ES2022"],
    "outDir":           "./dist",
    "rootDir":          "./src",
    "strict":           true,
    "esModuleInterop":  true,
    "skipLibCheck":     true,
    "resolveJsonModule": true,
    "declaration":      true,
    "declarationMap":   true,
    "sourceMap":        true,
    "paths": {
      "@hyperprox/types": ["../../packages/types/src/index.ts"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

# Prisma schema
cat > $BASE/apps/api/prisma/schema.prisma << 'EOF'
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// --- Cluster config ----------------------------------------------------------

model ProxmoxCluster {
  id          String   @id @default(uuid())
  name        String   @default("TitanCluster")
  host        String
  port        Int      @default(8006)
  tokenId     String
  tokenSecret String
  verified    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  nodes       Node[]
}

model Node {
  id         String         @id @default(uuid())
  clusterId  String
  cluster    ProxmoxCluster @relation(fields: [clusterId], references: [id])
  name       String         // e.g. "titan7"
  ip         String
  roles      String[]       @default([])
  online     Boolean        @default(false)
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt
}

// --- Proxy -------------------------------------------------------------------

model ProxyProvider {
  id        String      @id @default(uuid())
  type      String      // npm | traefik | caddy
  name      String
  url       String
  apiKey    String?
  username  String?
  password  String?
  active    Boolean     @default(true)
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
  hosts     ProxyHost[]
}

model ProxyHost {
  id         String        @id @default(uuid())
  providerId String
  provider   ProxyProvider @relation(fields: [providerId], references: [id])
  domain     String        @unique
  target     String
  port       Int
  ssl        String        @default("none")
  sslExpiry  DateTime?
  enabled    Boolean       @default(true)
  createdAt  DateTime      @default(now())
  updatedAt  DateTime      @updatedAt
}

// --- DNS ---------------------------------------------------------------------

model DNSProvider {
  id        String      @id @default(uuid())
  type      String      // godaddy | cloudflare | namecheap
  name      String
  apiKey    String
  apiSecret String?
  active    Boolean     @default(true)
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
  records   DNSRecord[]
}

model DNSRecord {
  id         String      @id @default(uuid())
  providerId String
  provider   DNSProvider @relation(fields: [providerId], references: [id])
  type       String      // A | CNAME | TXT | MX
  name       String
  value      String
  ttl        Int         @default(3600)
  domain     String
  createdAt  DateTime    @default(now())
  updatedAt  DateTime    @updatedAt
}

// --- Setup -------------------------------------------------------------------

model SetupState {
  id          String   @id @default("singleton")
  completed   Boolean  @default(false)
  currentStep Int      @default(0)
  completedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

// --- Audit log ---------------------------------------------------------------

model AuditLog {
  id        String   @id @default(uuid())
  action    String
  resource  String
  details   Json?
  createdAt DateTime @default(now())
}
EOF

# Main entry point
cat > $BASE/apps/api/src/index.ts << 'EOF'
import Fastify from 'fastify'
import cors       from '@fastify/cors'
import helmet     from '@fastify/helmet'
import jwt        from '@fastify/jwt'
import rateLimit  from '@fastify/rate-limit'
import websocket  from '@fastify/websocket'

import { healthRoute }     from './routes/health'
import { proxmoxRoutes }   from './routes/proxmox'
import { proxyRoutes }     from './routes/proxy'
import { dnsRoutes }       from './routes/dns'
import { wsRoutes }        from './routes/ws'
import { prismaPlugin }    from './plugins/prisma'
import { redisPlugin }     from './plugins/redis'

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

async function main() {
  // Plugins
  await server.register(helmet, { contentSecurityPolicy: false })
  await server.register(cors,   { origin: true })
  await server.register(rateLimit, { max: 100, timeWindow: '1 minute' })
  await server.register(jwt,    { secret: process.env.JWT_SECRET! })
  await server.register(websocket)
  await server.register(prismaPlugin)
  await server.register(redisPlugin)

  // Routes
  await server.register(healthRoute,   { prefix: '/health' })
  await server.register(proxmoxRoutes, { prefix: '/api/proxmox' })
  await server.register(proxyRoutes,   { prefix: '/api/proxy' })
  await server.register(dnsRoutes,     { prefix: '/api/dns' })
  await server.register(wsRoutes,      { prefix: '/ws' })

  const port = Number(process.env.PORT ?? 3002)
  await server.listen({ port, host: '0.0.0.0' })
  server.log.info(`HyperProx API running on port ${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
EOF

# Health route
cat > $BASE/apps/api/src/routes/health.ts << 'EOF'
import { FastifyPluginAsync } from 'fastify'

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    return {
      status:  'ok',
      version: '0.1.0',
      uptime:  process.uptime(),
      ts:      new Date().toISOString(),
    }
  })
}
EOF

# Proxmox route (stub)
cat > $BASE/apps/api/src/routes/proxmox.ts << 'EOF'
import { FastifyPluginAsync } from 'fastify'

export const proxmoxRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/nodes', async (request, reply) => {
    // TODO: wire to ProxmoxService
    return { success: true, data: [] }
  })

  fastify.get('/vms', async (request, reply) => {
    return { success: true, data: [] }
  })

  fastify.get('/storage', async (request, reply) => {
    return { success: true, data: [] }
  })
}
EOF

# Proxy route (stub)
cat > $BASE/apps/api/src/routes/proxy.ts << 'EOF'
import { FastifyPluginAsync } from 'fastify'

export const proxyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/hosts', async () => ({ success: true, data: [] }))
}
EOF

# DNS route (stub)
cat > $BASE/apps/api/src/routes/dns.ts << 'EOF'
import { FastifyPluginAsync } from 'fastify'

export const dnsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/records', async () => ({ success: true, data: [] }))
}
EOF

# WebSocket route
cat > $BASE/apps/api/src/routes/ws.ts << 'EOF'
import { FastifyPluginAsync } from 'fastify'

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { websocket: true }, (socket, req) => {
    socket.on('message', (message) => {
      socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }))
    })

    // Send a welcome ping
    socket.send(JSON.stringify({
      type:    'connected',
      payload: { message: 'HyperProx WS connected' },
      ts:      new Date().toISOString(),
    }))
  })
}
EOF

# Prisma plugin
cat > $BASE/apps/api/src/plugins/prisma.ts << 'EOF'
import fp           from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

export const prismaPlugin = fp(async (fastify) => {
  const prisma = new PrismaClient()
  await prisma.$connect()
  fastify.decorate('prisma', prisma)
  fastify.addHook('onClose', async () => { await prisma.$disconnect() })
})
EOF

# Redis plugin
cat > $BASE/apps/api/src/plugins/redis.ts << 'EOF'
import fp      from 'fastify-plugin'
import Redis   from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

export const redisPlugin = fp(async (fastify) => {
  const redis = new Redis(process.env.REDIS_URL!)
  fastify.decorate('redis', redis)
  fastify.addHook('onClose', async () => { await redis.quit() })
})
EOF

ok "API scaffold complete."

# =============================================================================
#  FRONTEND — Next.js 14 + shadcn/ui
# =============================================================================

log "Scaffolding Frontend (Next.js 14)..."

mkdir -p $BASE/apps/frontend

cat > $BASE/apps/frontend/package.json << 'EOF'
{
  "name": "@hyperprox/frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev":       "next dev -p 3000",
    "build":     "next build",
    "start":     "next start -p 3000",
    "lint":      "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hyperprox/types":     "workspace:*",
    "@radix-ui/react-dialog":      "^1.1.2",
    "@radix-ui/react-dropdown-menu": "^2.1.2",
    "@radix-ui/react-label":       "^2.1.0",
    "@radix-ui/react-scroll-area": "^1.2.0",
    "@radix-ui/react-separator":   "^1.1.0",
    "@radix-ui/react-slot":        "^1.1.0",
    "@radix-ui/react-tabs":        "^1.1.1",
    "@radix-ui/react-tooltip":     "^1.1.3",
    "class-variance-authority":    "^0.7.0",
    "clsx":                        "^2.1.1",
    "lucide-react":                "^0.453.0",
    "next":                        "14.2.15",
    "react":                       "^18.3.1",
    "react-dom":                   "^18.3.1",
    "recharts":                    "^2.13.0",
    "tailwind-merge":              "^2.5.3",
    "tailwindcss-animate":         "^1.0.7",
    "swr":                         "^2.2.5",
    "zustand":                     "^5.0.0"
  },
  "devDependencies": {
    "@types/node":       "^20.16.0",
    "@types/react":      "^18.3.3",
    "@types/react-dom":  "^18.3.0",
    "autoprefixer":      "^10.4.20",
    "eslint":            "^8.57.0",
    "eslint-config-next": "14.2.15",
    "postcss":           "^8.4.47",
    "tailwindcss":       "^3.4.13",
    "typescript":        "^5.6.2"
  }
}
EOF

# Next.js config
cat > $BASE/apps/frontend/next.config.js << 'EOF'
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: { serverComponentsExternalPackages: [] },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002/api'}/:path*`,
      },
    ]
  },
}
module.exports = nextConfig
EOF

# TypeScript config
cat > $BASE/apps/frontend/tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target":             "ES2017",
    "lib":                ["dom", "dom.iterable", "esnext"],
    "allowJs":            true,
    "skipLibCheck":       true,
    "strict":             true,
    "noEmit":             true,
    "esModuleInterop":    true,
    "module":             "esnext",
    "moduleResolution":   "bundler",
    "resolveJsonModule":  true,
    "isolatedModules":    true,
    "jsx":                "preserve",
    "incremental":        true,
    "plugins":            [{ "name": "next" }],
    "paths": {
      "@/*":               ["./*"],
      "@hyperprox/types":  ["../../packages/types/src/index.ts"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
EOF

# Tailwind config
cat > $BASE/apps/frontend/tailwind.config.ts << 'EOF'
import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // HyperProx brand
        cyan:  { DEFAULT: '#00e5ff', 500: '#00e5ff' },
        prox:  { DEFAULT: '#00e5ff' },
        // Dark backgrounds
        base:  { DEFAULT: '#080c14', 900: '#080c14', 800: '#0d1220', 700: '#111827' },
      },
      fontFamily: {
        display: ['Rajdhani', 'sans-serif'],
        mono:    ['IBM Plex Mono', 'monospace'],
      },
      animation: {
        'fade-in':    'fadeIn 0.3s ease-in-out',
        'slide-up':   'slideUp 0.3s ease-out',
        'pulse-cyan': 'pulseCyan 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn:    { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp:   { '0%': { transform: 'translateY(8px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        pulseCyan: { '0%, 100%': { boxShadow: '0 0 0 0 rgba(0,229,255,0.4)' }, '50%': { boxShadow: '0 0 0 8px rgba(0,229,255,0)' } },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
export default config
EOF

# App directory structure
mkdir -p $BASE/apps/frontend/app
mkdir -p $BASE/apps/frontend/components/{ui,dashboard,proxy,dns,storage,shared}
mkdir -p $BASE/apps/frontend/lib
mkdir -p $BASE/apps/frontend/hooks
mkdir -p $BASE/apps/frontend/store
mkdir -p $BASE/apps/frontend/public

# Root layout
cat > $BASE/apps/frontend/app/layout.tsx << 'EOF'
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title:       'HyperProx',
  description: 'Your Proxmox infrastructure, hypercharged.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-base text-white font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
EOF

# Global CSS
cat > $BASE/apps/frontend/app/globals.css << 'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --cyan:       #00e5ff;
  --violet:     #7c3aed;
  --base-900:   #080c14;
  --base-800:   #0d1220;
  --base-700:   #111827;
  --base-600:   #1f2937;
}

body {
  background-color: var(--base-900);
}

/* Scrollbar */
::-webkit-scrollbar       { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: var(--base-800); }
::-webkit-scrollbar-thumb { background: var(--base-600); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--cyan); }
EOF

# Home page
cat > $BASE/apps/frontend/app/page.tsx << 'EOF'
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="font-display text-5xl font-light tracking-wider">
        HYPER<span className="font-bold text-cyan-500">PROX</span>
      </h1>
      <p className="text-gray-400 text-sm font-mono">Your Proxmox infrastructure, hypercharged.</p>
      <div className="mt-4 flex gap-3 text-xs font-mono text-gray-500">
        <span className="px-2 py-1 rounded border border-gray-800">v0.1.0</span>
        <span className="px-2 py-1 rounded border border-cyan-500/30 text-cyan-400">connecting...</span>
      </div>
    </main>
  )
}
EOF

# Utility lib
cat > $BASE/apps/frontend/lib/utils.ts << 'EOF'
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function pct(used: number, total: number): number {
  if (!total) return 0
  return Math.round((used / total) * 100)
}
EOF

ok "Frontend scaffold complete."

# =============================================================================
#  INSTALL DEPENDENCIES
# =============================================================================

log "Installing dependencies (this takes a minute)..."

cd $BASE
pnpm install

ok "Dependencies installed."

# =============================================================================
#  PRISMA — Generate client
# =============================================================================

log "Generating Prisma client..."

cd $BASE/apps/api
npx prisma generate

ok "Prisma client generated."

# =============================================================================
#  SUMMARY
# =============================================================================

echo ""
echo -e "${BOLD}${CYAN}============================================${RESET}"
echo -e "${BOLD}${CYAN}  HyperProx Monorepo Ready${RESET}"
echo -e "${BOLD}${CYAN}============================================${RESET}"
echo ""
echo -e "  ${BOLD}Structure:${RESET}"
echo -e "  ${CYAN}apps/api${RESET}       Fastify + Prisma + WebSockets"
echo -e "  ${CYAN}apps/frontend${RESET}  Next.js 14 + shadcn/ui + Tailwind"
echo -e "  ${CYAN}packages/types${RESET} Shared TypeScript types"
echo ""
echo -e "  ${BOLD}Start dev servers:${RESET}"
echo -e "  ${CYAN}cd /opt/hyperprox && pnpm dev${RESET}"
echo ""
echo -e "  ${BOLD}Run DB migrations:${RESET}"
echo -e "  ${CYAN}cd apps/api && npx prisma migrate dev --name init${RESET}"
echo ""

