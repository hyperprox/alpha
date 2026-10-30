// =============================================================================
//  HyperProx — task template types
//
//  A template owns its fields, constants, derive, validate, preflight and steps.
//  Nothing here talks to a model or a cluster; facts arrive as data.
// =============================================================================

import type { TemplateFacts } from '../facts'
export type { TemplateFacts }

export type FieldType = 'string' | 'int' | 'enum' | 'ipv4cidr' | 'hostname' | 'bool'
export type FieldSource = 'user' | 'fact' | 'derived' | 'fixed'
export interface FieldValue { value: unknown; source: FieldSource; note?: string }
export type Fields = Record<string, FieldValue>

export interface FieldSpec {
  name: string
  type: FieldType
  /** The model's description of the field. */
  describe: string
  required: boolean | ((f: Fields) => boolean)
  source: FieldSource
  /** Only extractable fields are ever offered to, or accepted from, the model. */
  extract: boolean
  question?: (f: Fields, facts: TemplateFacts) => string
  choices?: (facts: TemplateFacts, f: Fields) => string[]
}

export interface FieldIssue { field: string; kind: 'missing' | 'invalid'; message: string; choices?: string[] }
export interface Check { id: string; ok: boolean; message: string; field?: string; warn?: boolean }

export type StepId =
  | 'create_lxc' | 'start_and_verify' | 'install_service' | 'health_check' | 'complete_guest'
  | 'secure_first_run' | 'configure_proxy' | 'create_dns' | 'wait_propagation' | 'request_ssl' | 'verify_url'
export interface StepSpec { id: StepId; label: string }

/** Phase 6 adds naming. */
export interface TemplateSettings { bridge: string }

/** Declared as the plain facts here; Task 21 widens it with what pre-flight probes. */
export type PreflightFacts = TemplateFacts

export interface TaskTemplate {
  id: string
  version: number
  summary: string
  intents: string[]
  nearMisses: string[]
  fields: FieldSpec[]
  constants: Readonly<Record<string, unknown>>
  /** Enum values for the extract schema, filled at request time from the live cluster. */
  enums(facts: TemplateFacts): Record<string, string[]>
  derive(f: Fields, facts: TemplateFacts, s: TemplateSettings): Fields
  validate(f: Fields, facts: TemplateFacts): FieldIssue[]
  /** Phase 1 returns []. */
  preflight(f: Fields, facts: PreflightFacts): Promise<Check[]>
  steps(f: Fields): StepSpec[]
}
