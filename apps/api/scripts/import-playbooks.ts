// Import a folder of markdown playbooks into THIS instance's handbook (database only; nothing is written to the repo).
//
//   pnpm --filter api exec tsx scripts/import-playbooks.ts /path/to/playbooks [--overwrite]
//
// The folder is the owner's own data and stays outside the repository. Re-running is safe: existing playbooks are
// skipped unless --overwrite is given.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaPlaybookStore } from '../src/lib/ai/operator/playbook-store'
import { importPlaybooks } from '../src/lib/ai/operator/importer'

async function main() {
  const dir = process.argv[2]
  if (!dir || dir.startsWith('--')) { console.error('Usage: import-playbooks.ts <folder> [--overwrite]'); process.exit(2) }
  const files = readdirSync(dir).filter(n => n.endsWith('.md')).map(name => ({ name, content: readFileSync(join(dir, name), 'utf8') }))
  const db = new PrismaClient()
  try {
    const rep = await importPlaybooks(files, new PrismaPlaybookStore(db), { overwrite: process.argv.includes('--overwrite'), by: 'import' })
    console.log(JSON.stringify(rep, null, 2))
    if (rep.failed.length) process.exitCode = 1
  } finally { await db.$disconnect() }
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
