// =============================================================================
//  HyperProx — Certificates: policy
//
//  Everything network-specific about certificates lives in config/certs.yaml,
//  a local git-ignored file; config/certs.example.yaml documents every key.
//
//  As with the Updates policy, unknown keys fail the load with the path of the
//  bad key: a typo in `key_mode` must not silently deploy a private key with
//  the default permissions. Without a file nothing is issued or deployed;
//  only the discovered endpoints are probed.
// =============================================================================

import fs from 'node:fs'
import { z } from 'zod'
import type { CertsStartTls } from './types'
import { parseCron } from '../updates/cron'

// js-yaml ships no types; only load() is used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load(src: string): unknown }

export const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'
export const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

export const DEFAULT_CERTS_POLICY_PATH = '/opt/hyperprox/config/certs.yaml'

export function certsPolicyPath(): string {
  return process.env.CERTS_POLICY_PATH || DEFAULT_CERTS_POLICY_PATH
}

// --- Resolved policy -------------------------------------------------------------

export type KeyType = 'ec256' | 'ec384' | 'rsa2048' | 'rsa4096'

export type TargetSpec =
  | { kind: 'guest-files'; vmid: number; files: { fullchain: string; key: string; cert?: string; chain?: string };
      owner: string; keyMode: string; reload: string | null }
  | { kind: 'hyperprox' }

export interface CertsPolicy {
  acme:   { directoryUrl: string; staging: boolean; email: string | null; keyType: KeyType }
  schedule: { check: string }
  alerts: { warnFraction: number; criticalDays: number; webhookUrl: string | null }
  certificates: Record<string, { names: string[]; deploy: { target: string }[] }>
  probes: { host: string; port: number; starttls: CertsStartTls; internal: boolean }[]
  targets: Record<string, TargetSpec>
  proxy:  { guestVmid: number | null }
}

export function defaultCertsPolicy(): CertsPolicy {
  return {
    acme:     { directoryUrl: LE_PRODUCTION, staging: false, email: null, keyType: 'ec256' },
    schedule: { check: '15 6 * * *' },
    alerts:   { warnFraction: 0.33, criticalDays: 7, webhookUrl: null },
    certificates: {},
    probes:   [],
    targets:  {},
    proxy:    { guestVmid: null },
  }
}

// --- Schema --------------------------------------------------------------------

const cronString = z.string().superRefine((s, ctx) => {
  try { parseCron(s) } catch (e: any) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message }) }
})

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
// A certificate name: a DNS name of two or more labels, optionally a wildcard in the first label only.
function isCertName(s: string): boolean {
  const n = s.startsWith('*.') ? s.slice(2) : s
  const labels = n.split('.')
  return n.length <= 253 && labels.length >= 2 && labels.every(l => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1])
}
function isHost(s: string): boolean {
  return s.split('.').every(l => LABEL.test(l)) || /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
}

const certName = z.string().transform(s => s.trim().toLowerCase())
  .refine(isCertName, 'a DNS name such as mail.example.com or *.example.com')

const absPath = z.string().startsWith('/', 'an absolute path')

const guestFilesSchema = z.object({
  kind:  z.literal('guest-files'),
  vmid:  z.number().int().positive(),
  files: z.object({
    fullchain: absPath,
    key:       absPath,
    cert:      absPath.optional(),
    chain:     absPath.optional(),
  }).strict().superRefine((f, ctx) => {
    // Two roles on one path: whichever is written last wins, and the key may end up under a certificate's name.
    const seen = new Map<string, string>()
    for (const [role, p] of Object.entries(f)) {
      if (p === undefined) continue
      const prior = seen.get(p)
      if (prior) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [role], message: `the same path as ${prior}; every file needs its own path` })
      else seen.set(p, role)
    }
  }),
  owner:    z.string().regex(/^[a-z_][a-z0-9_-]*(:[a-z_][a-z0-9_-]*)?$/i, 'user or user:group').optional(),
  // Unquoted, YAML reads 0600 as the integer 600; its digits are still the octal mode that was meant.
  key_mode: z.union([z.string(), z.number().int().nonnegative()]).transform(String)
    .refine(s => /^0?[0-7]{3}$/.test(s), 'an octal mode such as "0600"')
    .refine(s => !/^0?[0-7]{3}$/.test(s) || (parseInt(s, 8) & 0o007) === 0,
      'a mode that gives other users no access to the private key, such as "0600" or "0640"').optional(),
  reload:   z.string().min(1).nullable().optional(),
}).strict()

const hyperproxSchema = z.object({ kind: z.literal('hyperprox') }).strict()

const fileSchema = z.object({
  acme: z.object({
    directory: z.union([z.enum(['production', 'staging']), z.string().url().startsWith('https://', 'an https:// URL')],
      { errorMap: () => ({ message: 'production, staging or an https:// directory URL' }) }).optional(),
    email:     z.string().email().nullable().optional(),
    key_type:  z.enum(['ec256', 'ec384', 'rsa2048', 'rsa4096']).optional(),
  }).strict().optional(),
  schedule: z.object({
    check: cronString.optional(),
  }).strict().optional(),
  alerts: z.object({
    warn_fraction: z.number().gt(0).lt(1).optional(),
    critical_days: z.number().int().min(0).max(60).optional(),
    webhook_url:   z.string().url().nullable().optional(),
  }).strict().optional(),
  certificates: z.record(z.object({
    names:  z.array(certName).min(1),
    deploy: z.array(z.object({ target: z.string().min(1) }).strict()).optional(),
  }).strict()).optional(),
  probes: z.array(z.object({
    host:     z.string().transform(s => s.trim().toLowerCase()).refine(isHost, 'a host name or IPv4 address'),
    port:     z.number().int().min(1).max(65535),
    starttls: z.enum(['none', 'smtp', 'imap', 'pop3']).optional(),
    internal: z.boolean().optional(),
  }).strict()).optional(),
  targets: z.record(z.discriminatedUnion('kind', [guestFilesSchema, hyperproxSchema])).optional(),
  proxy: z.object({
    guest_vmid: z.number().int().positive().nullable().optional(),
  }).strict().optional(),
}).strict()

function describeIssues(err: z.ZodError): string {
  return err.issues.map(i => {
    const at = i.path.map(String)
    if (i.code === z.ZodIssueCode.unrecognized_keys) {
      return i.keys.map(k => `${[...at, k].join('.')}: unknown key`).join('; ')
    }
    return `${at.join('.') || '(top level)'}: ${i.message}`
  }).join('; ')
}

/** Parse and validate policy text. Throws with every bad key's path. */
export function parseCertsPolicy(text: string): CertsPolicy {
  let doc: unknown
  try { doc = yaml.load(text) } catch (e: any) { throw new Error(`not valid YAML: ${e.message}`) }
  if (doc === undefined || doc === null) doc = {}
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the policy must be a YAML mapping')

  // A section with only comments under it reads as null; treat it as absent.
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) if (v === null) delete (doc as Record<string, unknown>)[k]

  const parsed = fileSchema.safeParse(doc)
  if (!parsed.success) throw new Error(describeIssues(parsed.error))
  const f = parsed.data
  const p = defaultCertsPolicy()

  const dir = f.acme?.directory
  if (dir === 'staging') p.acme.directoryUrl = LE_STAGING
  else if (dir && dir !== 'production') p.acme.directoryUrl = dir
  p.acme.staging = p.acme.directoryUrl === LE_STAGING
  if (f.acme?.email)    p.acme.email = f.acme.email
  if (f.acme?.key_type) p.acme.keyType = f.acme.key_type

  if (f.schedule?.check) p.schedule.check = f.schedule.check
  if (f.alerts?.warn_fraction !== undefined) p.alerts.warnFraction = f.alerts.warn_fraction
  if (f.alerts?.critical_days !== undefined) p.alerts.criticalDays = f.alerts.critical_days
  if (f.alerts?.webhook_url)                 p.alerts.webhookUrl = f.alerts.webhook_url
  if (f.proxy?.guest_vmid)                   p.proxy.guestVmid = f.proxy.guest_vmid

  for (const [name, t] of Object.entries(f.targets ?? {})) {
    p.targets[name] = t.kind === 'hyperprox'
      ? { kind: 'hyperprox' }
      : {
          kind: 'guest-files', vmid: t.vmid,
          files: {
            fullchain: t.files.fullchain, key: t.files.key,
            ...(t.files.cert ? { cert: t.files.cert } : {}),
            ...(t.files.chain ? { chain: t.files.chain } : {}),
          },
          owner: t.owner ?? 'root:root',
          // Normalised to four digits so the deploy step never has to guess whether "600" meant octal.
          keyMode: (t.key_mode ?? '0600').padStart(4, '0'),
          reload: t.reload ?? null,
        }
  }

  const problems: string[] = []
  for (const [label, c] of Object.entries(f.certificates ?? {})) {
    // The label is a policy key and a URL path segment (/api/certs/managed/:label).
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(label)) {
      problems.push(`certificates.${label}: a label is letters, digits, - and _ (at most 63)`)
      continue
    }
    const names = [...new Set(c.names)]
    if (names.length !== c.names.length) problems.push(`certificates.${label}.names: a name is listed twice`)
    if (names.length > 100) problems.push(`certificates.${label}.names: at most 100 names per certificate`)
    const deploy = c.deploy ?? []
    deploy.forEach((d, i) => {
      if (!p.targets[d.target]) problems.push(`certificates.${label}.deploy.${i}.target: no target named "${d.target}" under targets`)
    })
    p.certificates[label] = { names, deploy: deploy.map(d => ({ target: d.target })) }
  }

  const seen = new Set<string>()
  for (const [i, pr] of (f.probes ?? []).entries()) {
    const key = `${pr.host}:${pr.port}`
    if (seen.has(key)) problems.push(`probes.${i}: ${key} is listed twice`)
    seen.add(key)
    p.probes.push({ host: pr.host, port: pr.port, starttls: pr.starttls ?? 'none', internal: pr.internal ?? false })
  }

  if (problems.length) throw new Error(problems.join('; '))
  return p
}

/** Read the policy file. Never throws: a missing or broken file reports why and yields the defaults. */
export function loadCertsPolicy(path = certsPolicyPath()): { loaded: boolean; path: string; error?: string; policy: CertsPolicy } {
  let text: string
  try { text = fs.readFileSync(path, 'utf8') }
  catch (e: any) {
    return {
      loaded: false, path, policy: defaultCertsPolicy(),
      error: e?.code === 'ENOENT'
        ? 'No certificates policy file: discovered endpoints are probed, nothing is issued or deployed'
        : `Cannot read the policy file: ${e.message}`,
    }
  }
  try { return { loaded: true, path, policy: parseCertsPolicy(text) } }
  catch (e: any) { return { loaded: false, path, policy: defaultCertsPolicy(), error: `Policy file rejected: ${e.message}` } }
}
