// This repository is public: shipped defaults, dashboards and placeholders carry neutral names, never the
// name of the cluster HyperProx was first built on. An applied migration cannot be edited (Prisma records its
// checksum), so the column default is changed by a later migration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const NEUTRAL = 'Proxmox Cluster'

test('the cluster-name column defaults to a neutral name', () => {
  const m = /model ProxmoxCluster \{[\s\S]*?\n\s*name\s+String\s+@default\("([^"]*)"\)/.exec(read('apps/api/prisma/schema.prisma'))
  assert.equal(m?.[1], NEUTRAL)
})

test('a migration after the init one sets that default in the database', () => {
  const dir = 'apps/api/prisma/migrations'
  const all = readdirSync(join(ROOT, dir)).filter(d => /^\d{14}_/.test(d)).sort()
  const last = all.filter(d => read(`${dir}/${d}/migration.sql`).includes('"ProxmoxCluster"')).at(-1)!
  assert.notEqual(last, all[0], 'the init migration must not be the one that changes it')
  assert.match(read(`${dir}/${last}/migration.sql`), new RegExp(`ALTER TABLE "ProxmoxCluster" ALTER COLUMN "name" SET DEFAULT '${NEUTRAL}';`))
})

test('the overview dashboard is titled for the product, not a cluster', () => {
  const j = JSON.parse(read('config/grafana/dashboards/hyperprox-overview.json'))
  const text = JSON.stringify(j)
  assert.match(text, /# HyperProx\\n/)
})

test('the save-arrangement dialog suggests a generic name', () => {
  const src = read('apps/frontend/components/terminal/TerminalDialogs.tsx')
  const m = /function SaveLayoutDialog[\s\S]*?placeholder="([^"]*)"/.exec(src)
  assert.equal(m?.[1], 'Main workspace')
})
