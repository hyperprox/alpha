// =============================================================================
//  HyperProx — field typing and the extract schema
//
//  The model is offered a flat object of nullable fields and nothing else. What
//  comes back is coerced field by field; a value that does not fit is refused
//  here, never repaired into something the user did not say.
// =============================================================================

import * as z from 'zod/v4'
import type { FieldSpec, Fields, TaskTemplate } from './types'

export type Coerced = { ok: true; value: unknown } | { ok: false; message: string }

const OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function validIpv4(s: string): boolean {
  const m = OCTETS.exec(s)
  // No leading zeros: "010" is octal to some parsers and decimal to others.
  return !!m && m.slice(1).every(o => (o === '0' || !o.startsWith('0')) && Number(o) <= 255)
}

export function coerce(spec: FieldSpec, raw: unknown, enumValues?: string[]): Coerced {
  const bad = (message: string): Coerced => ({ ok: false, message })
  if (raw === null || raw === undefined) return bad(`${spec.name} has no value`)

  switch (spec.type) {
    case 'string': {
      if (typeof raw !== 'string' || !raw.trim()) return bad(`${spec.name} must be text`)
      return { ok: true, value: raw.trim() }
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN
      return Number.isSafeInteger(n) ? { ok: true, value: n } : bad(`${spec.name} must be a whole number`)
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' }
      return bad(`${spec.name} must be true or false`)
    }
    case 'enum': {
      if (typeof raw === 'string' && (enumValues ?? []).includes(raw)) return { ok: true, value: raw }
      return bad(`${String(raw)} is not one of the choices for ${spec.name}`)
    }
    case 'ipv4cidr': {
      if (typeof raw !== 'string') return bad(`${spec.name} must be an address`)
      const s = raw.trim()
      if (s.toLowerCase() === 'dhcp') return { ok: true, value: 'dhcp' }
      const [ip, prefix, ...rest] = s.split('/')
      if (rest.length || !validIpv4(ip)) return bad(`${s} is not an IPv4 address`)
      if (prefix !== undefined && !(/^\d{1,2}$/.test(prefix) && Number(prefix) >= 1 && Number(prefix) <= 32)) {
        return bad(`${s} has an invalid prefix length`)
      }
      return { ok: true, value: s }
    }
    case 'hostname': {
      if (typeof raw !== 'string') return bad(`${spec.name} must be a hostname`)
      const h = raw.trim().toLowerCase().replace(/\.$/, '')
      if (!h || h.length > 253 || !h.split('.').every(l => LABEL.test(l))) return bad(`${raw.trim()} is not a valid hostname`)
      return { ok: true, value: h }
    }
  }
}

export function isRequired(spec: FieldSpec, f: Fields): boolean {
  return typeof spec.required === 'function' ? spec.required(f) : spec.required
}

function extractable(t: TaskTemplate): FieldSpec[] {
  return t.fields.filter(s => s.extract && s.type !== 'bool')
}

/** Flat, every field required and nullable, no extra keys: the shape all three providers accept. */
export function extractJsonSchema(t: TaskTemplate, enums: Record<string, string[]>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const fields = extractable(t)
  for (const s of fields) {
    properties[s.name] = s.type === 'int' ? { type: ['integer', 'null'], description: s.describe }
      : s.type === 'enum' ? { enum: [...(enums[s.name] ?? []), null], description: s.describe }
      : { type: ['string', 'null'], description: s.describe }
  }
  return { type: 'object', properties, required: fields.map(s => s.name), additionalProperties: false }
}

export function extractZod(t: TaskTemplate, enums: Record<string, string[]>): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {}
  for (const s of extractable(t)) {
    const values = enums[s.name] ?? []
    shape[s.name] = s.type === 'int' ? z.number().int().nullable()
      : s.type === 'enum' ? (values.length ? z.enum(values as [string, ...string[]]).nullable() : z.null())
      : z.string().nullable()
  }
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>
}
