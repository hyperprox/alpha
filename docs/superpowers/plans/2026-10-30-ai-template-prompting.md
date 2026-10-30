# AI Template Prompting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wizard's model-written deployment plan with engineered task templates: the model extracts typed fields, HyperProx asks for what is missing one question at a time, validates every field against the live cluster, runs pre-flight checks, and executes a fixed step list from server-held fields only.

**Architecture:** A template (`apps/api/src/lib/ai/templates/`) owns its fields, constants, `derive`, `validate`, `preflight` and `steps`. A pure question loop (`lib/ai/loop.ts`) drives intent match → extract → derive → validate → question; phase 2 persists its state in `ai_sessions` behind a session API, and phase 3 gates `ready` on pre-flight. The executor reads typed fields; nothing the browser or the model sends is ever executed. The first task closes today's hole in `/api/ai/wizard/execute` before any of that starts.

**Tech Stack:** TypeScript, Fastify 4, Prisma 5 (Postgres), zod (`zod/v4`), `node:test` via `tsx`, js-yaml 4.1.1, `@anthropic-ai/sdk`, raw HTTP for OpenAI and Ollama, Next.js (frontend).

**Spec:** `docs/superpowers/specs/2026-10-30-ai-template-prompting-design.md`. Its nine open decisions are approved as recommended. Phases 1–3 are planned in full here; phases 4–7 are outlined at the end and get their own plans.

## Global Constraints

- The repository is public: no real node names, IP addresses, guest IDs, domains or personal names in code, tests, fixtures, comments or commit messages. Examples use nodes `pve1`/`pve2`/`pve3`, network `10.0.0.0/24` with gateway `10.0.0.1`, zone `example.com`, guest IDs as in the spec's examples.
- HyperProx authenticates to Proxmox with an API token, never `root@pam`. Every container it creates is `unprivileged: 1` with `features: 'nesting=1'` and no other feature flag (no `keyctl`, `fuse`, `mount=`).
- Tests use fakes only: never the live cluster, DNS, proxy or a provider (live provider runs are manual, on demand). Tests never start, stop or restart the API process; route tests use `Fastify().inject()`.
- No task deploys, runs `deploy.sh`, or restarts `hyperprox-api` (a restart locks the vault). Implementation ends at a commit.
- Run one test file: `cd apps/api && node --import tsx --test test/<name>.test.ts`. Whole suite: `pnpm --filter @hyperprox/api test` (script added in Task 1). Typecheck: `pnpm --filter @hyperprox/api typecheck` and, for UI tasks, `pnpm --filter @hyperprox/frontend typecheck`; both must exit 0.
- Import zod as `import * as z from 'zod/v4'` (the Anthropic helper is typed against v4). No new runtime dependencies; js-yaml is already present.
- Providers stay Anthropic, OpenAI and Ollama behind one interface; nothing depends on which is active. No references to unrelated products in code, docs or commits.
- **The model never decides:** the gateway, the bridge, feature flags, privilege, packages, the template, steps or their order, sizes below the floor, the DNS zone list, or anything about another guest. A model value for a non-extractable field is dropped and logged.
- Questions are code-authored text with facts substituted, never model prose. Copy fixed by the spec is used verbatim (quoted in the tasks).
- Template constants, verbatim: `features: 'nesting=1'`, `unprivileged: 1`; `packages: { debian: ['ca-certificates', 'curl', 'docker.io', 'docker-compose'], ubuntu: ['ca-certificates', 'curl', 'docker.io', 'docker-compose-v2'] }` chosen by distro, never by `||` fallback; `floors: { docker: { memory_mb: 512, disk_gb: 8 } }`; `onboot: 1`, `start: 1`, `firewall: 1` on `net0`; A-record `ttl: 600`; propagation wait 5 minutes against public resolvers.
- Limits: at most 8 questions per session; sessions expire after 24 h idle; execute refused unless pre-flight passed within 5 minutes; VMID range 100–999999999; storage needs free ≥ disk × 1.2.
- New `/api/ai/*` routes take the role matrix default (admin). Do not add exceptions to `lib/roles.ts`.
- Every bug fixed in this area adds a scenario named after it, with `found_by`, in the same commit.
- Commit messages follow the repo style `Area: one plain sentence` (e.g. `AI wizard: …`), end with the session's attribution lines, and stage only the task's files.
- Model routing: each task is tagged **[Opus]** (security, design judgment), **[Sonnet]** (implementation) or **[Haiku]** (pure transcription).

## Review Focus

1. **Two answers, edits or executes on one session at once** (double-clicked choice button, two tabs): the second gets `409` and the session is never half-merged; one session never starts two jobs. Tests in Task 15 (`save` with a stale `updatedAt` throws) and Task 17 (`two concurrent executes start one job`).
2. **A service named loosely** ("uptime kuma", "Uptime-Kuma", "kuma", "toString"): exact match by normalised id or name; a partial match is offered as a suggestion, never assumed; prototype keys never match. Test in Task 2 (`matchRecipe normalises, suggests, and never matches prototype keys`).
3. **An address written the way people write it**: bare `10.0.0.37` takes the bridge's prefix (noted in the field); `10.0.0.37/16` on a /24 bridge, the gateway itself, and the network or broadcast address are invalid and asked again, never rewritten. Test in Task 7 (`ip: bare address gets the bridge prefix; wrong prefix, gateway, network and broadcast are refused`).
4. **The cluster changes between preview and execute** (another guest takes the ID or address, the node goes offline): execute re-checks and refuses naming the field; nothing is created. Tests in Task 1 (`facts that changed since planning re-block at execute`) and Task 24 (`execute re-runs pre-flight and refuses on a new failure`).
5. **A session that outlived its context**: a session from an older template version cannot execute (`409`, "start again"); one idle over 24 h is `404`; one left `executing` by a process restart reads as `failed` with a reason, not as forever running. Tests in Task 16 (`an older template version cannot execute`, `executing without a live job reads as failed`) and Task 15 (`an idle session expires`).

---

## Phase 1 — Template core

### Task 1: Execute refuses any plan the server did not produce and audit **[Opus]**

**Files:**
- Create: `apps/api/src/lib/ai/prepared.ts`
- Modify: `apps/api/src/routes/ai.ts` (export `buildAiRoutes(deps)`; keep `export const aiRoutes = buildAiRoutes()` so `index.ts` is unchanged)
- Modify: `apps/frontend/app/ai/page.tsx` (`handleExecute` posts `{ planId }`; Execute hidden when `blocked` or no `planId`)
- Modify: `apps/api/package.json` (add `"test": "node --import tsx --test test/*.test.ts"`)
- Test: `apps/api/test/wizard-execute-guard.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Prepared<T> { id: string; owner: string; createdAt: number; payload: T }
  export class PreparedStore<T> {
    constructor(ttlMs?: number /* 30 * 60_000 */, now?: () => number)
    put(owner: string, payload: T): string                     // returns an unguessable id (crypto.randomUUID)
    take(id: string, owner: string): Prepared<T> | null        // one-shot; null when unknown, expired or another owner's
  }
  export interface AiRouteDeps {
    gatherFacts(): Promise<ClusterFacts>
    generatePlan(text: string, provider?: ProviderId): Promise<Plan>
    execute(jobId: string, plan: Plan): Promise<void>
    prepared: PreparedStore<Plan>
    whoami(req: FastifyRequest): string                        // default: currentContext()?.email ?? ''
  }
  export function buildAiRoutes(deps?: Partial<AiRouteDeps>): FastifyPluginAsync
  ```
- `POST /wizard/plan` response gains `planId` only when `blocked` is false.
- `POST /wizard/execute` body `{ planId: string }` → `{ ok, jobId }`.

- [ ] **Step 1: Write the failing tests** (register `buildAiRoutes(fakeDeps)` on a bare Fastify; `fakeDeps.execute` records calls)

```ts
test("a plan posted by the browser is refused and never executed", async () => {
  const res = await inject("/wizard/execute", { plan: { steps: [{ type: "create_lxc" }] } })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /never run/)
  assert.equal(executed.length, 0)
})
test("a blocked plan gets no planId", async () => {   // fake plan with a service that has no recipe
  const body = (await inject("/wizard/plan", { prompt: "deploy mystery app" })).json()
  assert.equal(body.blocked, true); assert.equal(body.planId, undefined)
})
test("execute runs the server's copy of the plan, once", async () => {
  const { planId, plan } = (await inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  assert.equal((await inject("/wizard/execute", { planId })).statusCode, 200)
  assert.deepEqual(executed[0].plan.steps, plan.steps)
  assert.equal((await inject("/wizard/execute", { planId })).statusCode, 404)
})
test("an unknown, expired or another user's planId is 404", async () => { /* advance fake clock 30 min + 1; whoami returns another email */ })
test("facts that changed since planning re-block at execute", async () => {
  // second gatherFacts() call returns usedVmids containing the plan's vmid
  const res = await inject("/wizard/execute", { planId })
  assert.equal(res.statusCode, 409); assert.equal(res.json().blocked, true)
  assert.equal(executed.length, 0)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && node --import tsx --test test/wizard-execute-guard.test.ts`
Expected: FAIL (`buildAiRoutes` is not exported).

- [ ] **Step 3: Implement `PreparedStore` and `buildAiRoutes`**

`/wizard/plan` stores `{ plan }` under `whoami(req)` when `auditPlan` finds nothing. `/wizard/execute` returns 400 with `"Execution takes a planId from /wizard/plan; a plan sent by the browser is never run."` if the body has `plan`, 400 if `planId` is not a string, 404 `"That plan has expired or was already run. Plan it again."` from `take()`, then re-runs `auditPlan(stored, await gatherFacts())` and returns 409 `{ ok: false, blocked: true, warnings }` on any problem. Only then `execute(jobId, stored)`. The frontend change is two lines plus the disabled condition.

- [ ] **Step 4: Run tests, the whole suite and typecheck**

Run: `cd apps/api && node --import tsx --test test/wizard-execute-guard.test.ts && pnpm --filter @hyperprox/api test && pnpm --filter @hyperprox/api typecheck && pnpm --filter @hyperprox/frontend typecheck`
Expected: all PASS, both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/ai/prepared.ts apps/api/src/routes/ai.ts apps/api/package.json apps/frontend/app/ai/page.tsx apps/api/test/wizard-execute-guard.test.ts
git commit -m "AI wizard: execute runs only a plan the server produced and audited, once, for the user who asked"
```

### Task 2: One install-recipe source: the catalogue **[Sonnet]**

Open decision 1. `SERVICE_CATALOG` moves into `CATALOGUE`; installs are built by one function from per-distro packages.

**Files:**
- Create: `apps/api/src/lib/install-script.ts`
- Modify: `apps/api/src/lib/catalogue.ts` (new fields; the seven app recipes; NPM/Tautulli become `compose` installs)
- Delete: `apps/api/src/lib/service-recipes.ts`
- Modify: `apps/api/src/lib/ai/plan-schema.ts`, `apps/api/src/lib/ai/prompt.ts`, `apps/api/src/lib/wizard-executor.ts` (imports only: `matchRecipe`, `wizardRecipes`, `installScript`)
- Test: `apps/api/test/catalogue-recipes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // install-script.ts
  export type Distro = 'debian' | 'ubuntu'
  export const DOCKER_PACKAGES: Readonly<Record<Distro, readonly string[]>>   // the spec constant, verbatim
  export function distroOf(volidOrOstype: string): Distro | null              // 'debian-13-standard_…' | 'ubuntu-24.04-…' | 'debian' | 'ubuntu'
  export function installScript(r: CatalogueRecipe, distro: Distro, env?: Record<string, string>): string
  export function manualCommands(r: CatalogueRecipe, distro: Distro): string[]
  // catalogue.ts
  export type FirstRun = { kind: 'none' } | { kind: 'setup-url'; path: string } | { kind: 'env-admin'; userEnv?: string; passwordEnv: string; user: string }
  export interface CatalogueRecipe {
    id; name; summary; category: 'proxy' | 'ai' | 'media' | 'monitoring' | 'apps'
    satisfies?; port: number; healthPath: string; expectStatus: number[]   // e.g. [200, 302]
    needsDocker: boolean; defaults: { cores: number; memoryMb: number; diskGb: number }
    firstLogin?: string; notes?: string[]; firstRun: FirstRun; wizard: boolean
    install: { kind: 'compose'; dir: string; compose: string } | { kind: 'script'; script: string }
    packages?: Partial<Record<Distro, string[]>>                         // extras on top of DOCKER_PACKAGES
  }
  export function findRecipe(id: string): CatalogueRecipe | undefined    // unchanged
  export function matchRecipe(name: string): { recipe?: CatalogueRecipe; suggestions: CatalogueRecipe[] }
  export function wizardRecipes(): CatalogueRecipe[]                     // wizard: true
  ```
- App recipes (compose and ports copied from `service-recipes.ts`; sizes from the old prompt's table; `wizard: true`):
  `nextcloud` 2048/20/2 `/status.php` setup-url · `jellyfin` 2048/20/4 `/health` setup-url · `vaultwarden` 512/8/1 `/alive` none · `gitea` 1024/12/2 `/` setup-url · `uptime-kuma` 512/8/1 `/` setup-url, `expectStatus [200, 302]` · `homepage` 512/8/1 `/` none · `grafana` 512/8/2 `/api/health` env-admin (`passwordEnv: 'GF_SECURITY_ADMIN_PASSWORD'`, `user: 'admin'`). NPM, Ollama and Tautulli keep `wizard: false` and their current values.

- [ ] **Step 1: Write the failing tests**

```ts
test("installScript: set -e, noninteractive, distro packages, quiet pull, no || fallback", () => {
  const deb = installScript(findRecipe("uptime-kuma")!, "debian")
  assert.equal(deb.split("\n")[0], "set -e")
  assert.match(deb, /DEBIAN_FRONTEND=noninteractive/)
  assert.match(deb, /apt-get install -y -qq ca-certificates curl docker\.io docker-compose$/m)
  assert.doesNotMatch(deb, /docker-compose-v2|\|\|/)
  assert.match(deb, /docker compose up -d --quiet-pull/)
  assert.match(installScript(findRecipe("uptime-kuma")!, "ubuntu"), /docker-compose-v2/)
})
test("a script recipe gets set -e and no Docker packages", () => {
  const s = installScript(findRecipe("ollama")!, "debian")
  assert.equal(s.split("\n")[0], "set -e"); assert.doesNotMatch(s, /docker\.io/)
})
test("distroOf reads template volids and ostype", () => {
  assert.equal(distroOf("tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"), "debian")
  assert.equal(distroOf("ubuntu"), "ubuntu"); assert.equal(distroOf("alpine-3.20-default"), null)
})
test("matchRecipe normalises, suggests, and never matches prototype keys", () => {
  for (const n of ["uptime kuma", "Uptime-Kuma", "UPTIME KUMA "]) assert.equal(matchRecipe(n).recipe?.id, "uptime-kuma")
  const k = matchRecipe("kuma"); assert.equal(k.recipe, undefined); assert.equal(k.suggestions[0].id, "uptime-kuma")
  for (const n of ["toString", "__proto__", "constructor"]) assert.equal(matchRecipe(n).recipe, undefined)
})
test("every wizard recipe has a health path, an expected status and a first-run kind", () => { /* loop wizardRecipes() */ })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && node --import tsx --test test/catalogue-recipes.test.ts`
Expected: FAIL (`install-script` module not found).

- [ ] **Step 3: Implement** `install-script.ts` and the catalogue changes; delete `service-recipes.ts` and repoint its three importers. `matchRecipe`: normalise with `serviceKey` (lowercase, trim, spaces → `-`), exact on `id` or normalised `name` among `CATALOGUE` via `Array.find` (no object-key lookup); suggestions are wizard recipes whose id or name contains the normalised input.

- [ ] **Step 4: Run tests, suite and typecheck**

Run: `cd apps/api && node --import tsx --test test/catalogue-recipes.test.ts && pnpm --filter @hyperprox/api test && pnpm --filter @hyperprox/api typecheck`
Expected: PASS; exit 0. (`wizard-audit.test.ts` still passes: `auditPlan` now uses `matchRecipe`.)

- [ ] **Step 5: Commit** `Catalogue: the one source of install recipes, with per-distro packages and first-run kinds`

### Task 3: The catalogue installer creates unprivileged, nesting-only containers **[Sonnet]**

Open decision 2.

**Files:**
- Modify: `apps/api/src/lib/catalogue-installer.ts` (export `createContainer` with an injectable client; use `installScript`)
- Modify: `apps/api/src/lib/proxmox-client.ts` (`createLXC` params gain `onboot?: boolean` → `onboot: 1|0` when given)
- Test: `apps/api/test/catalogue-installer.test.ts`

**Interfaces:**
- Consumes: `installScript`, `distroOf` (Task 2).
- Produces: `export async function createContainer(recipe: CatalogueRecipe, res: { cores: number; memoryMb: number; diskGb: number }, preferNode: string | undefined, client?: CreatePVE): Promise<{ vmid: number; node: string; distro: Distro }>` (`CreatePVE` from `wizard-executor.ts`).

- [ ] **Step 1: Write the failing tests** (fake client in the style of `wizard-create-lxc.test.ts`)

```ts
test("a Docker recipe is created unprivileged with nesting only", async () => {
  await createContainer(findRecipe("nginx-proxy-manager")!, NPM_DEFAULTS, undefined, fake.pve)
  assert.equal(fake.calls.create.params.unprivileged, true)
  assert.equal(fake.calls.create.params.features, "nesting=1")
})
test("a non-Docker recipe is created the same way", async () => { /* ollama */ })
test("the install into an existing container uses that container's ostype for packages", async () => { /* config ostype: ubuntu → script has docker-compose-v2 */ })
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && node --import tsx --test test/catalogue-installer.test.ts` → FAIL (`createContainer` not exported).
- [ ] **Step 3: Implement.** Replace the privileged branch and its comment (the comment says the opposite of the truth now) with the template constants; distro from the chosen template volid, or from `GET /nodes/{node}/lxc/{vmid}/config` `ostype` for `intoVmid`; a distro of `null` throws `"<template> is neither Debian nor Ubuntu; HyperProx installs only on those."`.
- [ ] **Step 4: Run** `cd apps/api && node --import tsx --test test/catalogue-installer.test.ts && pnpm --filter @hyperprox/api typecheck` → PASS; exit 0.
- [ ] **Step 5: Commit** `Catalogue: installs create unprivileged containers with nesting only, which an API token may set`

### Task 4: Template types, field typing and the extract schema **[Sonnet]**

**Files:**
- Create: `apps/api/src/lib/ai/templates/types.ts`, `apps/api/src/lib/ai/templates/fields.ts`
- Test: `apps/api/test/ai-template-fields.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type FieldType = 'string' | 'int' | 'enum' | 'ipv4cidr' | 'hostname' | 'bool'
  export type FieldSource = 'user' | 'fact' | 'derived' | 'fixed'
  export interface FieldValue { value: unknown; source: FieldSource; note?: string }
  export type Fields = Record<string, FieldValue>
  export interface FieldSpec {
    name: string; type: FieldType; describe: string            // describe = the model's field description
    required: boolean | ((f: Fields) => boolean); source: FieldSource; extract: boolean
    question?: (f: Fields, facts: TemplateFacts) => string
    choices?: (facts: TemplateFacts, f: Fields) => string[]
  }
  export interface FieldIssue { field: string; kind: 'missing' | 'invalid'; message: string; choices?: string[] }
  export interface Check { id: string; ok: boolean; message: string; field?: string; warn?: boolean }
  export type StepId = 'create_lxc' | 'start_and_verify' | 'install_service' | 'health_check' | 'complete_guest'
    | 'secure_first_run' | 'configure_proxy' | 'create_dns' | 'wait_propagation' | 'request_ssl' | 'verify_url'
  export interface StepSpec { id: StepId; label: string }
  export interface TemplateSettings { bridge: string }       // phase 6 adds naming
  export interface TaskTemplate {
    id: string; version: number; summary: string; intents: string[]; nearMisses: string[]
    fields: FieldSpec[]; constants: Readonly<Record<string, unknown>>
    enums(facts: TemplateFacts): Record<string, string[]>     // filled at request time
    derive(f: Fields, facts: TemplateFacts, s: TemplateSettings): Fields
    validate(f: Fields, facts: TemplateFacts): FieldIssue[]
    preflight(f: Fields, facts: PreflightFacts): Promise<Check[]>   // phase 1: returns []
    steps(f: Fields): StepSpec[]
  }
  ```
  (`TemplateFacts` from Task 5; `PreflightFacts` is declared here as `TemplateFacts` and widened in Task 21.) This deviates from the spec's `extract: JsonSchema` only in that the schema is a function of facts, which the spec's provider notes require.
- Produces (fields.ts):
  ```ts
  export function coerce(spec: FieldSpec, raw: unknown, enumValues?: string[]): { ok: true; value: unknown } | { ok: false; message: string }
  export function isRequired(spec: FieldSpec, f: Fields): boolean
  export function extractJsonSchema(t: TaskTemplate, enums: Record<string, string[]>): Record<string, unknown>
  export function extractZod(t: TaskTemplate, enums: Record<string, string[]>): z.ZodType<Record<string, unknown>>
  ```

- [ ] **Step 1: Write the failing tests** (a two-field toy template in the test file)

```ts
test("extract schema: only extract:true fields, all required, each nullable, no extra keys", () => {
  const s: any = extractJsonSchema(toy, { service: ["uptime-kuma", "gitea"] })
  assert.deepEqual(Object.keys(s.properties).sort(), ["service", "vmid"])
  assert.deepEqual(s.required.sort(), ["service", "vmid"]); assert.equal(s.additionalProperties, false)
  assert.deepEqual(s.properties.service.enum, ["uptime-kuma", "gitea", null])
  assert.deepEqual(s.properties.vmid.type, ["integer", "null"])
})
test("coerce: ints from numeric strings; ipv4cidr accepts bare, cidr and dhcp; hostname lowercases and strips the dot", () => {
  assert.deepEqual(coerce(int, "237"), { ok: true, value: 237 })
  assert.equal(coerce(int, "two").ok, false)
  assert.deepEqual(coerce(ip, "10.0.0.37"), { ok: true, value: "10.0.0.37" })
  assert.deepEqual(coerce(ip, "DHCP"), { ok: true, value: "dhcp" })
  assert.equal(coerce(ip, "10.0.0.300/24").ok, false)
  assert.deepEqual(coerce(host, "Kuma.Example.com."), { ok: true, value: "kuma.example.com" })
  assert.equal(coerce(enumSpec, "plex", ["gitea"]).ok, false)
})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-template-fields.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement.** JSON Schema per field: `string`/`hostname`/`ipv4cidr` → `{type:['string','null']}`, `int` → `{type:['integer','null']}`, `enum` → `{enum:[...values, null]}`; `bool` fields are never extractable in this plan. `extractZod` mirrors it with `.nullable()`.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: template field types and the flat, nullable extract schema`

### Task 5: Cluster facts for templates **[Sonnet]**

**Files:**
- Modify: `apps/api/src/lib/ai/facts.ts` (add `gatherTemplateFacts`; the old `gatherFacts` stays until Task 12)
- Modify: `apps/api/src/lib/wizard-placement.ts` (add `bridgeInfo`, `isHostAddress`)
- Test: `apps/api/test/ai-facts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BridgeFact { iface: string; gateway: string; prefix: number }   // from /nodes/{n}/network cidr
  export interface NodeFact { node: string; online: boolean; cores: number; freeMemMb: number; totalMemMb: number
                              arch: 'amd64' | 'arm64' | ''; hasLogin: boolean; bridges: BridgeFact[] }
  export interface StorageFact { storage: string; node: string; type: string; content: string[]; active: boolean; shared: boolean; freeGb: number }
  export interface TemplateFact { node: string; storage: string; volid: string; arch: string; distro: Distro | null }
  export interface DownloadFact { node: string; name: string; arch: string; distro: Distro | null }
  export interface GuestFact { vmid: number; node: string; type: 'lxc' | 'qemu'; name: string; addresses: string[] }
  export interface TemplateFacts { nodes: NodeFact[]; storages: StorageFact[]; templates: TemplateFact[]; downloadable: DownloadFact[]
                                   guests: GuestFact[]; nextVmid: number; zones: string[]; proxyHosts: string[]; hasReverseProxy: boolean }
  export interface FactsDeps { pve: Pick<ProxmoxClient, 'fetchNode' | 'fetchStrict' | 'getNodes'>; zones(): Promise<string[]>
                               proxyHosts(): Promise<string[]>; hasReverseProxy(): Promise<boolean>; hasLogin(node: string): Promise<boolean> }
  export async function gatherTemplateFacts(deps?: Partial<FactsDeps>): Promise<TemplateFacts>
  // wizard-placement.ts
  export function bridgeInfo(networks: unknown[] | null | undefined, bridge?: string): BridgeFact | null
  export function isHostAddress(ip: string, gateway: string, prefix: number): boolean   // not network, broadcast or gateway
  ```
- Arch: `/nodes/{n}/status` `current-kernel.machine`: `x86_64` → `amd64`, `aarch64` → `arm64`, else `''`. Template arch from `_<arch>.tar.` in the volid; a volid naming none counts as `amd64`.

- [ ] **Step 1: Write the failing tests** (fake `pve` returning canned paths)

```ts
test("node arch comes from the running kernel", async () => { assert.equal(f.nodes.find(n => n.node === "pve2")!.arch, "arm64") })
test("bridges carry gateway and prefix; a bridge with no gateway is kept with gateway ''", async () => {})
test("storage is per node, with content and free space", async () => {})
test("guest addresses come from each guest's config", async () => { assert.deepEqual(f.guests.find(g => g.vmid === 105)!.addresses, ["10.0.0.45"]) })
test("one unreachable source empties only its own fact", async () => { /* zones() throws → zones [], nodes intact */ })
test("isHostAddress refuses network, broadcast and gateway", () => {
  assert.equal(isHostAddress("10.0.0.0", "10.0.0.1", 24), false); assert.equal(isHostAddress("10.0.0.255", "10.0.0.1", 24), false)
  assert.equal(isHostAddress("10.0.0.1", "10.0.0.1", 24), false); assert.equal(isHostAddress("10.0.0.37", "10.0.0.1", 24), true)
})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-facts.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `Promise.allSettled` per source, as `gatherFacts` does; guest configs read with the lenient `fetchNode`; addresses via `configAddresses`.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: per-node facts for templates — arch, bridges, storage, templates and guest addresses`

### Task 6: `deploy-service`: fields, constants, derive and steps **[Opus]**

**Files:**
- Create: `apps/api/src/lib/ai/templates/deploy-service.ts`, `apps/api/src/lib/ai/templates/index.ts`
- Test: `apps/api/test/ai-deploy-derive.test.ts`
- Create: `apps/api/test/scenarios/fixtures/three-node-cluster.json` (a `TemplateFacts`: `pve1`–`pve3` online, amd64, logins stored, `vmbr0` gateway `10.0.0.1/24`; storage `fast` (rbd, shared, 400 GB) and `share` (cifs, 900 GB, vztmpl+rootdir); template `share:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst`; guests 101 on pve1 at `10.0.0.50` and 105 on pve2 at `10.0.0.45`; `nextVmid` 102; zones `["example.com"]`; proxy host `old.example.com`; reverse proxy configured)

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces:
  ```ts
  export const deployService: TaskTemplate                       // id 'deploy-service', version 1
  export interface DeployFields { service: string; exposure: 'public' | 'lan'; domain?: string; admin_setup?: 'now' | 'lock'
    node: string; vmid: number; ip: string /* 'dhcp' | a.b.c.d/nn */; gateway?: string; bridge: string; storage: string
    template: string; memory_mb: number; disk_gb: number; cores: number; hostname: string; features: 'nesting=1'; packages: string[] }
  export function toDeployFields(f: Fields): DeployFields        // throws if a required field is absent
  export const TEMPLATES: Record<string, TaskTemplate>; export function getTemplate(id: string): TaskTemplate | undefined
  ```
- Fields, in this order (= question order), as the spec's table: `service` enum user extract · `exposure` enum user extract · `domain` hostname user extract, required when `exposure = public` · `admin_setup` enum user extract, required when public and the recipe's `firstRun.kind = 'setup-url'` · `node` enum user extract · `vmid` int user extract · `ip` ipv4cidr user extract · `memory_mb`/`disk_gb`/`cores` int user extract · `gateway` fact · `bridge` fact · `storage` derived · `template` fact · `hostname` derived · `features` fixed · `packages` fixed. `ha` and `backup_job` arrive in phase 5 with a version bump.
- Derive rules (recompute every non-`user` field on every pass; never touch a `user` value):
  - `exposure`: empty and `domain` given → `public`, source `derived` (decision 3).
  - sizes: empty → recipe defaults (derived); a derived value below the Docker floor is raised, note `"raised to the Docker minimum of 8 GB"`. A `user` value below the floor is left for `validate`.
  - `node`: empty → online node with `hasLogin`, free memory ≥ `memory_mb`, most free memory; none → stays empty.
  - `bridge` = `settings.bridge` when the node has it. `vmid` empty → `nextVmid`. `ip` empty → `dhcp`; a bare user address gets the bridge prefix (value rewritten, source stays `user`, note `"prefix /24 from vmbr0"`).
  - `gateway` = bridge gateway when `ip` is static, else removed; any incoming value is discarded first.
  - `storage`: active on the node, holds `rootdir`, free ≥ `disk_gb × 1.2`, ranked rbd > zfspool > lvmthin/lvm/btrfs > dir > nfs/cifs, then free space.
  - `template`: `pickTemplate(volids on the node, node.arch)`; none → a `downloadable` for that arch as `<first vztmpl storage>:vztmpl/<name>`, note `"download"`; none → `''`.
  - `hostname`: recipe id, cleaned, suffixed `-2`, `-3`… if a guest has that name. `features` = `'nesting=1'`, `packages` = `DOCKER_PACKAGES[distroOf(template)]`, both `fixed`.
- `steps(f)` in phase 1: `create_lxc`, `start_and_verify`, `install_service`, `health_check`, then for `public` `configure_proxy`, `create_dns`, `wait_propagation`, `request_ssl`. (`complete_guest`, `secure_first_run`, `verify_url` are added in phase 5.)

- [ ] **Step 1: Write the failing tests** (load the fixture; helper `user(obj)` marks values `source: 'user'`)

```ts
test("a domain implies public without asking", () => { assert.deepEqual(d({ service: "uptime-kuma", domain: "kuma.example.com" }).exposure, { value: "public", source: "derived" }) })
test("a model-supplied gateway is discarded; the bridge's is used for a static ip", () => {
  const f = d({ ip: "10.0.0.37/24", gateway: "10.9.9.9" }); assert.deepEqual(f.gateway, { value: "10.0.0.1", source: "fact" })
})
test("a bare address takes the bridge prefix", () => { assert.equal(d({ ip: "10.0.0.37" }).ip.value, "10.0.0.37/24") })
test("unstated vmid and ip derive to nextid and dhcp", () => { const f = d({}); assert.equal(f.vmid.value, 102); assert.equal(f.ip.value, "dhcp") })
test("a stated node, vmid and ip are kept exactly", () => {})
test("derived sizes are raised to the Docker floor with a note; user sizes are not touched", () => {})
test("storage prefers block storage over a larger file share", () => { assert.equal(d({}).storage.value, "fast") })
test("template is for the node's arch; an arm64-only list offers an amd64 download", () => {})
test("features and packages are fixed; packages follow the template's distro", () => {})
test("lan stops after health_check; public adds the four publishing steps", () => {})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-deploy-derive.test.ts` → FAIL.
- [ ] **Step 3: Implement** `deployService.fields`, `constants` (each with its reason in a comment beside it, as the spec lists), `enums` (`service`: wizard recipe ids; `node`: online node names; `exposure`; `admin_setup`), `derive`, `steps`, `toDeployFields`; `validate` returns `[]` and `preflight` returns `[]` until Tasks 7 and 21.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: the deploy-service template — fields, constants, derived defaults and fixed steps`

### Task 7: `deploy-service` validation and code-authored questions **[Opus]**

**Files:**
- Modify: `apps/api/src/lib/ai/templates/deploy-service.ts`
- Create: `apps/api/src/lib/dns-zones.ts`
- Test: `apps/api/test/ai-deploy-validate.test.ts`

**Interfaces:**
- Produces: `deployService.validate`; `export function zoneFor(domain: string, zones: string[]): { zone: string; name: string } | null` (longest matching zone; `name` is `'@'` at the apex).
- Issues carry the question text in `message` and buttons in `choices`. Copy fixed by the spec, verbatim:
  - `service` missing or unknown: `"Which service? I can install: <names, comma-separated>"`, choices = suggestions first, then wizard recipe ids.
  - `exposure`: `"Should this be reachable from the internet, or only on your network?"`, choices `['public', 'lan']`.
  - `domain`: `"Which hostname should it answer on? Zones I manage: <zones>"`.
  - `admin_setup`: `"This app's first visitor becomes its admin. Create the admin account now, or keep it LAN-only until you do?"`, choices `['now']` (decision 7: `lock` follows access lists; answering `lock` gives `"Keeping it LAN-only until setup needs proxy access lists, which HyperProx does not support yet. Choose now, or make it LAN-only."`).
  - `vmid` taken: `"Container ID <n> is taken by another guest. Use <next free> instead?"`, choices `[String(nextFree)]`.
  - `ip` used: `"<ip> is already used by guest <vmid>. Which address, or DHCP?"`, choices `['dhcp']`.
  - size below floor: `"Docker needs at least 8 GB. Use 8?"` (and `"Docker needs at least 512 MB. Use 512?"`), choices `['8']` / `['512']`.
- Other rules from the spec's table: node online and fits; vmid 100–999999999 and free; ip on the bridge subnet with the bridge's prefix and `isHostAddress`, unused by any guest; domain under a managed zone (`zoneFor`), not already a proxy host, never invented; hostname RFC 1123.

- [ ] **Step 1: Write the failing tests**

```ts
test("a full valid request has no issues", () => { assert.deepEqual(v(full), []) })
test("unknown service asks with suggestions first", () => { const [i] = v({ ...full, service: u("kuma") }); assert.equal(i.field, "service"); assert.equal(i.choices![0], "uptime-kuma") })
test("ip: bare address gets the bridge prefix; wrong prefix, gateway, network and broadcast are refused", () => {
  for (const ip of ["10.0.0.37/16", "10.0.0.1/24", "10.0.0.0/24", "10.0.0.255/24", "10.5.0.9/24"]) assert.equal(v({ ...full, ip: u(ip) })[0].field, "ip")
})
test("an ip used by another guest names the guest and offers DHCP", () => {
  const [i] = v({ ...full, ip: u("10.0.0.45/24") }); assert.equal(i.message, "10.0.0.45 is already used by guest 105. Which address, or DHCP?"); assert.deepEqual(i.choices, ["dhcp"])
})
test("a taken vmid offers the next free one", () => { assert.equal(v({ ...full, vmid: u(101) })[0].message, "Container ID 101 is taken by another guest. Use 102 instead?") })
test("a domain outside the managed zones is asked again, listing zones; one already proxied is refused", () => {})
test("a user disk below the Docker floor asks to use 8", () => { assert.equal(v({ ...full, disk_gb: u(2) })[0].message, "Docker needs at least 8 GB. Use 8?") })
test("admin_setup is required only for public setup-url recipes", () => {})
test("zoneFor picks the longest zone, not the last two labels", () => {
  assert.deepEqual(zoneFor("a.b.example.co.uk", ["co.uk", "example.co.uk"]), { zone: "example.co.uk", name: "a.b" })
  assert.equal(zoneFor("evil-example.com", ["example.com"]), null)
})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-deploy-validate.test.ts` → FAIL.
- [ ] **Step 3: Implement** `validate` (issues in `fields` order) and `zoneFor` (match `domain === zone || domain.endsWith('.' + zone)`).
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: deploy-service validates every field against the cluster and asks in its own words`

### Task 8: One structured-output call for every provider **[Sonnet]**

**Files:**
- Modify: `apps/api/src/lib/ai/providers.ts` (add `callStructured`; `generatePlan` stays until Task 12)
- Test: `apps/api/test/ai-structured.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StructuredRequest<T> { name: string; system: string; user: string; schema: Record<string, unknown>; parse(raw: unknown): T }
  export type RawSend = (provider: ProviderId, body: Record<string, unknown>) => Promise<string>   // returns the reply's text
  export function anthropicBody(r: StructuredRequest<unknown>, model: string): Record<string, unknown>  // output_config: { format: { type: 'json_schema', schema } }
  export function openaiBody(r: StructuredRequest<unknown>, model: string): Record<string, unknown>     // response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }
  export function ollamaBody(r: StructuredRequest<unknown>, model: string): Record<string, unknown>     // format: schema, options.temperature 0.1
  export class StructuredOutputError extends Error {}
  export async function callStructured<T>(r: StructuredRequest<T>, provider?: ProviderId, send?: RawSend): Promise<T>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("each provider's body carries the one schema the way it expects", () => {
  assert.deepEqual((anthropicBody(req, "m") as any).output_config.format, { type: "json_schema", schema: req.schema })
  assert.equal((openaiBody(req, "m") as any).response_format.json_schema.strict, true)
  assert.deepEqual((ollamaBody(req, "m") as any).format, req.schema)
})
test("a reply that fails to parse is retried once, then succeeds", async () => {})
test("two bad replies ask the user to rephrase", async () => { await assert.rejects(callStructured(req, "ollama", alwaysBad), /rephrase/i) })
test("fenced or prose-wrapped JSON from a small model is unwrapped", async () => {})
test("a refusal stop reason is an error, not an empty result", async () => {})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-structured.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The default `send` reuses the existing credential lookups, base URLs, timeouts (180 s) and error texts; the Anthropic path uses `client.messages.create` with the body above and reads the first text block; the Ollama unwrapping is moved, not rewritten.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI providers: one structured-output call, constrained natively by each provider and parsed the same way`

### Task 9: Extraction and intent match **[Opus]**

This is the boundary where model output enters; it enforces "the model never decides".

**Files:**
- Create: `apps/api/src/lib/ai/extract.ts`, `apps/api/src/lib/ai/intent.ts`
- Test: `apps/api/test/ai-extract.test.ts`, `apps/api/test/ai-intent.test.ts`

**Interfaces:**
- Consumes: `callStructured` (Task 8), `extractJsonSchema`, `coerce` (Task 4), `TEMPLATES` (Task 6).
- Produces:
  ```ts
  export interface Extraction { values: Record<string, unknown>; dropped: string[]; invalid: Array<{ field: string; raw: unknown; message: string }> }
  export type ModelCall = <T>(r: StructuredRequest<T>) => Promise<T>          // default: r => callStructured(r)
  export function extractSystemPrompt(t: TaskTemplate): string               // static per template version
  export async function extractFields(t: TaskTemplate, text: string, facts: TemplateFacts,
    opts?: { asking?: { field: string; question: string }; call?: ModelCall; log?: (msg: string, data: object) => void }): Promise<Extraction>
  export interface IntentResult { template: string | 'none'; question: boolean; answer: string }
  export function keywordIntent(prompt: string): IntentResult
  export async function matchIntent(prompt: string, opts?: { call?: ModelCall }): Promise<IntentResult>
  export const NO_TASK_ANSWER = 'I can deploy services on this cluster. Try: "Deploy Uptime Kuma at status.example.com".'
  ```
- The system prompt is the template's field `describe` lines plus: `"Fill fields only from the user's words. Use null when a field is not stated. Never guess."` The call's `parse` keeps the raw object so unknown keys are seen before zod strips them.

- [ ] **Step 1: Write the failing tests**

```ts
test("keys the template does not extract are dropped and logged", async () => {
  const call = fakeCall({ service: "uptime-kuma", gateway: "10.0.0.254", features: "keyctl=1", steps: [] })
  const x = await extractFields(deployService, "deploy kuma", facts, { call, log })
  assert.deepEqual(x.dropped.sort(), ["features", "gateway", "steps"]); assert.equal("gateway" in x.values, false)
  assert.equal(logged[0].msg, "ai.extract.dropped")
})
test("nulls are omitted; numeric strings are coerced; an off-enum value is reported invalid, not kept", async () => {})
test("the extract request's schema has enums filled from facts", async () => { /* captured request: service enum = wizard ids + null */ })
test("an answer is extracted with the pending question in the prompt", async () => {})
test("keywordIntent: deploy requests match; questions, status checks and removals do not", () => {
  for (const p of ["deploy Uptime Kuma at status.example.com", "set up Gitea on pve2", "I want a Grafana container, LAN only", "install vaultwarden as container 250 on 10.0.0.50"])
    assert.equal(keywordIntent(p).template, "deploy-service")
  for (const p of ["what is Uptime Kuma?", "is Gitea running?", "remove the Grafana container"]) assert.equal(keywordIntent(p).template, "none")
})
test("matchIntent falls back to keywords when the provider fails", async () => {})
test("a none or question result carries an answer", async () => {})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-extract.test.ts test/ai-intent.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The intent request's schema is `{ template: enum(['deploy-service','none']), question: boolean, answer: string }` and its prompt is each template's `summary`, `intents` and `nearMisses`. `answer` is shown as text only; it is never parsed for actions.
- [ ] **Step 4: Run** both files and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: the model extracts named fields and nothing else; intent match falls back to keywords`

### Task 10: The question loop, as pure functions **[Sonnet]**

**Files:**
- Create: `apps/api/src/lib/ai/loop.ts`
- Test: `apps/api/test/ai-loop.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 7, 9.
- Produces:
  ```ts
  export type LoopStateName = 'answer' | 'asking' | 'ready' | 'blocked' | 'executing' | 'done' | 'failed'
  export interface Pending { field: string; question: string; choices?: string[] }
  export interface Turn { role: 'user' | 'assistant'; text: string; at: string }
  export interface LoopState { template: string | null; templateVersion: number; state: LoopStateName; answer?: string
    fields: Fields; pending?: Pending; issues: FieldIssue[]; steps?: StepSpec[]; transcript: Turn[]; asked: number }
  export interface LoopDeps { facts: TemplateFacts; settings: TemplateSettings; intent: typeof matchIntent; extract: typeof extractFields; now(): Date }
  export const MAX_QUESTIONS = 8
  export async function startLoop(prompt: string, deps: LoopDeps): Promise<LoopState>
  export async function answerLoop(s: LoopState, a: { field: string; value: unknown } | { text: string }, deps: LoopDeps): Promise<LoopState>
  export function editFields(s: LoopState, edits: Record<string, unknown>, deps: LoopDeps): LoopState   // throws FieldLockedError for fact/fixed
  export function settle(s: LoopState, deps: LoopDeps): LoopState      // derive → validate → pending → state
  export class FieldLockedError extends Error { field: string }
  ```
- Rules: extracted values merge as `source: 'user'` (a later answer wins for the fields it names; `null` never overwrites); a button answer is coerced against its field and does not call the model; the first issue in `fields` order becomes `pending` and its question is appended to the transcript; `asked` counts questions; at `MAX_QUESTIONS` with issues left, state `blocked` and the assistant turn lists every remaining issue; no issues → `ready` with `steps`. Intent `none` or `question: true` → state `answer`, `fields: {}`.

- [ ] **Step 1: Write the failing tests** (fake `intent`/`extract` deps returning canned values)

```ts
test("one question at a time, in field order", async () => { const s = await startLoop("deploy uptime kuma", deps({})); assert.equal(s.pending!.field, "exposure") })
test("a button answer is coerced and merged without a model call", async () => {})
test("a later answer wins for the fields it names; null keeps the earlier value", async () => {})
test("an invalid user value is asked again, not replaced", async () => {})
test("after 8 questions the session is blocked and lists what is missing", async () => {})
test("a non-task prompt is an answer with no fields", async () => {})
test("fact and fixed fields cannot be edited", () => { assert.throws(() => editFields(s, { gateway: "10.0.0.9" }, d), FieldLockedError) })
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-loop.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `loop.ts`; no I/O beyond the two deps.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: the question loop — extract, derive, validate, ask one thing, repeat`

### Task 11: The executor runs typed fields **[Sonnet]**

**Files:**
- Modify: `apps/api/src/lib/wizard-executor.ts`
- Modify: `apps/api/test/wizard-create-lxc.test.ts` (plans → fields)
- Test: `apps/api/test/wizard-executor-fields.test.ts`

**Interfaces:**
- Consumes: `DeployFields`, `toDeployFields`, `StepSpec` (Task 6); `zoneFor` (Task 7); `installScript`, `distroOf` (Task 2); `createLXC({ onboot })` (Task 3).
- Produces:
  ```ts
  export interface DeployRun { template: 'deploy-service'; version: number; owner: string; fields: DeployFields; steps: StepSpec[] }
  export interface JobState { jobId; status; run: DeployRun; steps: StepState[]; currentStep; startedAt; completedAt?; error?
    lxcVmid?; lxcNode?; lxcIp?; proxyHostId?; certId?; wanIp?; createUpid?: string; serviceInstalled?: boolean }
  export async function executeDeployJob(jobId: string, run: DeployRun, deps?: Partial<ExecDeps>): Promise<void>
  export interface ExecDeps { pve: CreatePVE; wait(ms: number): Promise<unknown>; fetch: typeof fetch; exec: typeof execInGuest; npm(): Promise<NPMClient | null>; dns(): Promise<GoDaddyClient | null> }
  export async function stepCreateLXC(job: JobState, pve?: CreatePVE, wait?: (ms: number) => Promise<unknown>): Promise<string>
  export async function stepStartAndVerify(job: JobState, pve?: CreatePVE, wait?: (ms: number) => Promise<unknown>): Promise<string>
  export async function stepHealthCheck(job: JobState, fetchImpl?: typeof fetch, wait?: (ms: number) => Promise<unknown>): Promise<string>
  ```
- `executeWizardJob(jobId, plan)` is removed; Task 12 repoints its only caller.

- [ ] **Step 1: Write the failing tests** (rewrite `wizard-create-lxc.test.ts` around a `fields()` builder; new file for the rest)

```ts
test("create uses the fields exactly: node, storage, template, vmid, address", async () => {
  await stepCreateLXC(job(fields({ node: "alpha" })), pve, noWait)   // alpha has less free memory than beta
  assert.equal(calls.create.node, "alpha"); assert.equal(calls.create.params.storage, "pool")
  assert.match(calls.create.params.net0, /^name=eth0,bridge=vmbr0,ip=10\.0\.0\.37\/24,gw=10\.0\.0\.1,firewall=1$/)
})
test("create sends the constants: unprivileged, nesting only, onboot, start", async () => {})
test("a bridge gateway that changed since the preview stops the create", async () => {})
test("a template volid not yet on its storage is downloaded and waited on", async () => {})
test("start_and_verify ignores start tasks older than this create", async () => {})
test("health_check passes on the recipe's expected status and fails loudly otherwise", async () => {})
test("a failed install or health check stops the run; publishing steps stay pending", async () => {})
test("publishing a recipe with a first-run page is refused until the first-run lock exists", async () => {
  // run with steps through request_ssl for uptime-kuma: configure_proxy fails with /first-run/, create_dns pending
})
test("create_dns writes to the longest matching zone", async () => {})
test("with no node login the install is shown, not run; health_check is skipped and no publishing step runs", async () => {})
test("the install script follows the template's distro", async () => {})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/wizard-create-lxc.test.ts test/wizard-executor-fields.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The executor no longer chooses a node, ID, storage or template; it still refuses a taken ID or address at create (loud, before anything exists). The first-run guard is a check at the top of `configure_proxy`: `firstRun.kind !== 'none'` and the run has no `secure_first_run` step → throw `"<app> shows a first-run setup page to whoever visits first, so HyperProx will not publish it yet. Finish setup at http://<ip>:<port>, then publish it."` Phase 5 removes the guard.
- [ ] **Step 4: Run** both files, the suite and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: the executor runs the template's fixed steps from typed fields`

### Task 12: The wizard routes run on the template; the free-form plan is gone **[Opus]**

Interim until phase 2: the existing `/wizard/plan` and `/wizard/execute` keep their shape for the current UI, but are backed by the loop and server-held fields.

**Files:**
- Modify: `apps/api/src/routes/ai.ts`
- Modify: `apps/api/src/lib/ai/prepared.ts` (payload becomes `DeployRun`)
- Delete: `apps/api/src/lib/ai/plan-schema.ts`, `apps/api/src/lib/ai/prompt.ts`, `apps/api/test/wizard-audit.test.ts`; remove `gatherFacts` and `generatePlan`
- Modify: `apps/api/test/wizard-execute-guard.test.ts`
- Modify: `apps/frontend/app/ai/page.tsx` (render `fields`, show `issues` as the warnings list; no other UI change)

**Interfaces:**
- Consumes: Tasks 5, 6, 9, 10, 11.
- `AiRouteDeps` becomes `{ facts(): Promise<TemplateFacts>; settings(): Promise<TemplateSettings>; intent; extract; execute(jobId: string, run: DeployRun): Promise<void>; prepared: PreparedStore<DeployRun>; whoami }`.
- `POST /wizard/plan` → `{ ok, plan: { service, domain, understood, steps, warnings }, fields, blocked, planId? }` where `steps` = `template.steps(f)`, `warnings` = issue messages (and the pending question), `planId` only when the loop is `ready`. `POST /provider/test` extracts from `'Deploy Uptime Kuma. No domain yet.'` and returns `sample: { service, fields: <count> }`.
- `POST /wizard/execute { planId }` re-derives and re-validates the stored fields against fresh facts; any issue → 409.

- [ ] **Step 1: Update the failing tests** in `wizard-execute-guard.test.ts` to the new deps; add:

```ts
test("the executed run is built from server fields; a gateway or step the model returned never reaches it", async () => {
  // extract fake returns gateway "10.9.9.9" and steps [...]; executed[0].run.fields.gateway === "10.0.0.1"; steps === template.steps
})
test("a request that is not ready gets warnings and no planId", async () => {})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/wizard-execute-guard.test.ts` → FAIL.
- [ ] **Step 3: Implement** the route changes and the deletions.
- [ ] **Step 4: Verify the acceptance condition and the suite**

Run: `grep -rnE "plan\.steps|params\.gateway|generatePlan|auditPlan|SERVICE_CATALOG" apps/api/src; pnpm --filter @hyperprox/api test && pnpm --filter @hyperprox/api typecheck && pnpm --filter @hyperprox/frontend typecheck`
Expected: grep prints nothing; tests PASS; typechecks exit 0.

- [ ] **Step 5: Commit** `AI wizard: plans come from the deploy-service template; no model-written step or gateway is read anywhere`

### Task 13: The scenario runner **[Sonnet]**

**Files:**
- Create: `apps/api/test/scenarios.test.ts`, `apps/api/test/scenarios/runner.ts`, `apps/api/test/run-scenarios.ts`
- Modify: `apps/api/package.json` (`"test:scenarios": "tsx test/run-scenarios.ts"`)
- Test: `apps/api/test/scenario-runner.test.ts`

**Interfaces:**
- Consumes: `startLoop`, `answerLoop` (Task 10); `TemplateFacts` fixtures.
- Produces:
  ```ts
  export interface Scenario { id: string; prompt: string; facts: string; answers: Array<{ field: string; value: unknown } | { text: string }>
    expect: { state: LoopStateName; questions: string[]; fields?: Record<string, unknown>; dropped?: string[]; preflight?: 'all-pass' | Record<string, boolean> }
    outcome?: unknown; found_by: string }
  export interface Recording { intent: IntentResult; extractions: Array<Record<string, unknown>> }   // replayed in order
  export function loadScenarios(dir: string): Scenario[]
  export async function runPlanOnly(s: Scenario, rec: Recording | 'live', provider?: ProviderId): Promise<{ state: LoopState; questions: string[]; dropped: string[] }>
  export function matchField(expected: unknown, actual: FieldValue | undefined): string | null   // null = match; else a reason
  ```
- Matchers: a literal equals the value; `">=N"`/`"<=N"`; `"{fact}"` and `"{derived}"` assert the source. Each answer must answer the question just asked (`field` equals `pending.field`) or the scenario fails. A recording with calls left over, or too few, fails. Recordings live at `test/scenarios/recordings/<scenario id>.json`; hand-written expected extractions are the recording for CI (decision 9). `run-scenarios.ts` parses `--provider <id>`, sets `SCENARIO_PROVIDER`, and spawns `node --import tsx --test test/scenarios.test.ts`; in live mode each extraction is also compared field by field with the recording and a per-provider accuracy line is printed (no CI failure on accuracy).

- [ ] **Step 1: Write the failing tests** for the runner itself: `matchField(">=8", {value: 8})` is null; `"{fact}"` against a derived value gives a reason; an answer for the wrong field fails with `/asked exposure, answered domain/`; a leftover recording call fails.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/scenario-runner.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `scenarios.test.ts` creates one `test()` per YAML file under `test/scenarios/deploy-service/`.
- [ ] **Step 4: Run** `cd apps/api && node --import tsx --test test/scenario-runner.test.ts && pnpm --filter @hyperprox/api test:scenarios` → PASS (zero scenarios yet: `# tests 0`).
- [ ] **Step 5: Commit** `AI wizard: scenario runner — real prompts, recorded extractions, questions and fields asserted`

### Task 14: Seed scenarios 001–011 and 019 **[Haiku]**

Transcription of the spec's seed inventory onto the fixture from Task 6.

**Files:**
- Create: `apps/api/test/scenarios/deploy-service/001-full-public.yaml` … `011-disk-below-floor.yaml`, `019-model-returns-forbidden-fields.yaml`
- Create: `apps/api/test/scenarios/recordings/deploy-001-full-public.json` … (one per scenario)

**Interfaces:**
- Consumes: the `Scenario` and `Recording` formats (Task 13). `facts: fixtures/three-node-cluster.json` for all.

- [ ] **Step 1: Write the scenarios**, `found_by: "2026-10-30 live test"` for 001 and `"spec seed inventory"` for the rest:
  - 001: the spec's YAML verbatim (prompt uses `pve2`, `10.0.0.37`, `237`, `kuma.example.com`); answers `admin_setup: now`; `questions: [admin_setup]`; `state: ready`; omit `preflight` until Task 24.
  - 002 `"Deploy Uptime Kuma."` → `[exposure]`, answer `lan` → ready, `vmid: "{derived}"`, `ip: dhcp`.
  - 003 `"Deploy Uptime Kuma, make it public"` → `[domain]`, no answer, `state: asking`.
  - 004 `"Deploy Plex at plex.example.com"` → `[service]`, `state: asking`.
  - 005 `"What is Uptime Kuma?"`, 006 `"Is Gitea running?"` → `state: answer`, `questions: []`.
  - 007 `"Deploy Uptime Kuma as container 101, LAN only"` → `[vmid]`, answer `vmid: 102` → ready.
  - 008 `"Deploy Uptime Kuma on 10.0.0.45, LAN only"` → `[ip]`, answer `ip: dhcp` → ready.
  - 009 `"Deploy Uptime Kuma at 10.5.0.9, LAN only"` (recording also returns `gateway: "10.5.0.1"`) → `[ip]`, answer `ip: 10.0.0.40` → ready, `gateway: "{fact}"`.
  - 010 `"Deploy Uptime Kuma at kuma.other.org"` → `[domain, admin_setup]`, answers `domain: kuma.example.com`, `admin_setup: now` → ready.
  - 011 `"Deploy Uptime Kuma with 2 GB disk, LAN only"` → `[disk_gb]`, answer `disk_gb: 8` → ready, `disk_gb: 8`.
  - 019 `"Deploy Uptime Kuma, LAN only"` with a recording returning `gateway`, `features: "keyctl=1"`, `steps: []` → ready, `dropped: [features, gateway, steps]`, `features: nesting=1`.
- [ ] **Step 2: Run** `cd apps/api && pnpm --filter @hyperprox/api test:scenarios` → expected PASS, `# tests 12`. A failure is a bug in Tasks 6–10, not in the YAML: fix it there and say so in the commit.
- [ ] **Step 3: Commit** `AI wizard: seed scenarios 001–011 and 019 pass on recorded extractions`

**Phase 1 acceptance:** `pnpm --filter @hyperprox/api test:scenarios` passes 12 scenarios; the Task 12 grep prints nothing.

---

## Phase 2 — Sessions and questions

### Task 15: Shared session type, `ai_sessions` table and the session store **[Sonnet]**

**Files:**
- Create: `packages/types/src/ai.ts` (export from `packages/types/src/index.ts`)
- Modify: `apps/api/prisma/schema.prisma`; Create: `apps/api/prisma/migrations/20261030120000_add_ai_sessions/migration.sql`
- Create: `apps/api/src/lib/ai/session-store.ts`
- Test: `apps/api/test/ai-session-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // @hyperprox/types — the spec's Session, plus two server-set fields
  export type AiSessionState = 'answer' | 'asking' | 'ready' | 'blocked' | 'executing' | 'done' | 'failed'
  export interface AiSession { id: string; template: string | null; templateVersion: number; state: AiSessionState; answer?: string
    fields: Record<string, { value: unknown; source: 'user' | 'fact' | 'derived' | 'fixed'; note?: string }>
    pending?: { field: string; question: string; choices?: string[] }; issues: Array<{ field: string; message: string }>
    preflight?: Array<{ id: string; ok: boolean; message: string; warn?: boolean }>; steps?: Array<{ id: string; label: string }>
    transcript: Array<{ role: 'user' | 'assistant'; text: string; at: string }>; jobId?: string; preflightAt?: string }
  // session-store.ts
  export const SESSION_IDLE_MS = 24 * 3600_000
  export interface SessionRow { id: string; owner: string; data: LoopState; preflightAt: Date | null; jobId: string | null; createdAt: Date; updatedAt: Date }
  export interface SessionStore {
    create(owner: string, data: LoopState): Promise<SessionRow>
    get(id: string): Promise<SessionRow | null>                // null when missing or idle > SESSION_IDLE_MS (and deletes it)
    save(id: string, data: LoopState, o: { expectUpdatedAt: Date; preflightAt?: Date | null; jobId?: string | null }): Promise<SessionRow>
    delete(id: string): Promise<void>
    sweep(now?: Date): Promise<number>
  }
  export class StaleSessionError extends Error {}
  export class MemorySessionStore implements SessionStore { constructor(now?: () => Date) }
  export class PrismaSessionStore implements SessionStore { constructor(db?: PrismaClient) }
  ```
- Prisma model `AiSession` mapped to `ai_sessions`: `id String @id @default(cuid())`, `owner String`, `template String?`, `templateVersion Int`, `state String`, `data Json`, `preflightAt DateTime?`, `jobId String?`, `createdAt`, `updatedAt @updatedAt`, `@@index([updatedAt])`, `@@index([owner])`. `save` is an `updateMany` on `{ id, updatedAt: expectUpdatedAt }` and throws `StaleSessionError` when it matched 0 rows.

- [ ] **Step 1: Write the failing tests** (run against `MemorySessionStore`; the same suite runs against `PrismaSessionStore` only when `DATABASE_URL` is set, else `t.skip("no database")`)

```ts
test("save with a stale updatedAt throws and changes nothing", async () => {})
test("an idle session expires", async () => { clock.advance(SESSION_IDLE_MS + 1); assert.equal(await store.get(row.id), null) })
test("sweep removes only idle sessions", async () => {})
test("a session round-trips its LoopState exactly", async () => {})
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-session-store.test.ts` → FAIL.
- [ ] **Step 3: Implement**; write `migration.sql` by hand in the style of `20261027120000_add_api_tokens` (`CREATE TABLE "ai_sessions"` plus the two indexes). Never run `prisma migrate dev` or `db push` against the live database.
- [ ] **Step 4: Run** the test file, `npx prisma validate` (expected `The schema at prisma/schema.prisma is valid`) and both typechecks → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: sessions are stored in ai_sessions, expire after a day idle, and refuse stale writes`

### Task 16: The session service **[Sonnet]**

**Files:**
- Create: `apps/api/src/lib/ai/sessions.ts`
- Test: `apps/api/test/ai-sessions.test.ts`

**Interfaces:**
- Consumes: Tasks 10, 11, 15.
- Produces:
  ```ts
  export interface SessionDeps extends Omit<LoopDeps, 'facts' | 'settings'> { store: SessionStore; facts(): Promise<TemplateFacts>
    settings(): Promise<TemplateSettings>; execute(jobId: string, run: DeployRun, onEnd: (ok: boolean) => Promise<void>): void
    jobAlive(jobId: string): boolean }
  export class SessionError extends Error { status: 400 | 404 | 409; constructor(status, message) }
  export function toView(row: SessionRow, jobAlive: (id: string) => boolean): AiSession
  export async function createSession(owner: string, prompt: string, d: SessionDeps): Promise<AiSession>
  export async function answerSession(id: string, owner: string, body: unknown, d: SessionDeps): Promise<AiSession>
  export async function patchSession(id: string, owner: string, edits: Record<string, unknown>, d: SessionDeps): Promise<AiSession>
  export async function executeSession(id: string, owner: string, d: SessionDeps): Promise<{ jobId: string }>
  export async function abandonSession(id: string, owner: string, d: SessionDeps): Promise<void>
  ```
- Rules: another owner's session is `404` (decision 8 for cleanup follows the same binding). `answer` is valid only in `asking`; `patch` only in `asking`/`ready`/`blocked`; `execute` only in `ready` — else `409` naming the state. A session whose `templateVersion` differs from the current template's cannot answer, patch or execute: `409 "This request was prepared by an older version of HyperProx. Start it again."`. `executing` with `jobAlive(jobId) === false` reads as `failed` with transcript line `"HyperProx restarted while this job was running. Check the guest before starting again."` (jobs are in memory until phase 4). `execute` saves `state: executing` and `jobId` with `expectUpdatedAt` before starting the job, so a second concurrent execute gets `StaleSessionError` → `409`.

- [ ] **Step 1: Write the failing tests**: `another owner's session is 404`; `answer outside asking is 409`; `an older template version cannot execute`; `executing without a live job reads as failed`; `execute moves to executing then done or failed through onEnd`; `fact and fixed edits are 400 naming the field`.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-sessions.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `body` for answer is `{ field: string; value: unknown }` or `{ text: string }`, anything else `400`.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: the session service — one owner, one state at a time, one job per session`

### Task 17: Session routes; `/wizard/*` removed **[Opus]**

**Files:**
- Create: `apps/api/src/routes/ai-sessions.ts`
- Modify: `apps/api/src/routes/ai.ts` (remove `/wizard/plan`, `/wizard/execute`, `/wizard/jobs/:jobId`), `apps/api/src/index.ts` (register `aiSessionRoutes` at `/api/ai`)
- Delete: `apps/api/src/lib/ai/prepared.ts`, `apps/api/test/wizard-execute-guard.test.ts` (its cases move here)
- Test: `apps/api/test/ai-session-routes.test.ts`

**Interfaces:**
- Consumes: Task 16.
- Produces: `export function buildAiSessionRoutes(deps?: Partial<SessionDeps> & { whoami?(req: FastifyRequest): string }): FastifyPluginAsync` and `export const aiSessionRoutes = buildAiSessionRoutes()`. Routes exactly as the spec's API table, plus `GET /sessions/:id` → `Session`. `GET /jobs/:id` returns the job view previously served at `/wizard/jobs/:jobId`, `404` for another owner's job. `POST /jobs/:id/resume` and `/jobs/:id/cleanup` are not registered until phase 4.

- [ ] **Step 1: Write the failing tests** (`inject` against a bare Fastify with `MemorySessionStore` and fake deps)

```ts
test("execute refuses a session that is not ready, and never accepts fields or a plan in the body", async () => {
  assert.equal((await post(`/sessions/${asking.id}/execute`, {})).statusCode, 409)
  assert.equal((await post(`/sessions/${ready.id}/execute`, { fields: { gateway: "10.9.9.9" } })).statusCode, 400)
})
test("two concurrent executes start one job", async () => {
  const [a, b] = await Promise.all([post(`/sessions/${id}/execute`, {}), post(`/sessions/${id}/execute`, {})])
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]); assert.equal(started.length, 1)
})
test("a question survives a restart", async () => {
  // create on app1, close it; build app2 with the same store; answer on app2 → next question
})
test("another user's session and job are 404", async () => {})
test("the old wizard routes are gone", async () => { assert.equal((await post("/wizard/execute", { plan: {} })).statusCode, 404) })
```

- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-session-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `execute` rejects any non-empty body with `400 "Execute takes no body; it runs the session's own fields."`.
- [ ] **Step 4: Run** the test file, the suite and typecheck; then `grep -rn "wizard/plan\|wizard/execute" apps/api/src apps/frontend` → prints only frontend call sites, which Task 19 removes.
- [ ] **Step 5: Commit** `AI wizard: sessions over HTTP; the browser can no longer send anything that is executed`

### Task 18: Scenarios run through the API **[Sonnet]**

**Files:**
- Modify: `apps/api/test/scenarios/runner.ts` (add `runViaApi`), `apps/api/test/scenarios.test.ts` (each of 001–010 also runs via the API)

**Interfaces:**
- Produces: `export async function runViaApi(s: Scenario, rec: Recording): Promise<{ session: AiSession; questions: string[] }>`: builds `buildAiSessionRoutes` with the fixture facts and the recording, `POST /sessions`, answers each `pending` with `POST /sessions/:id/answer`, returns the final session.

- [ ] **Step 1:** Add `via: [loop, api]` to scenarios 001–010 (019 stays loop-only: `dropped` is not in the session view).
- [ ] **Step 2: Run** `pnpm --filter @hyperprox/api test:scenarios` → FAIL (`runViaApi` missing).
- [ ] **Step 3: Implement** `runViaApi`.
- [ ] **Step 4: Run** again → PASS, `# tests 22`.
- [ ] **Step 5: Commit** `AI wizard: seed scenarios also pass through the session API`

### Task 19: AI page: thread, questions and fields card **[Sonnet]**

**Files:**
- Create: `apps/frontend/app/ai/session-view.ts` (pure helpers), `apps/frontend/app/ai/session-view.test.ts`
- Create: `apps/frontend/app/ai/WizardThread.tsx`, `apps/frontend/app/ai/FieldsCard.tsx`
- Modify: `apps/frontend/app/ai/page.tsx` (wizard tab uses the session API; removes `/wizard/plan` and the old plan state)

**Interfaces:**
- Consumes: `AiSession` (`@hyperprox/types`), the session routes (Task 17).
- Produces (session-view.ts):
  ```ts
  export const SOURCE_BADGE: Record<'user' | 'fact' | 'derived' | 'fixed', string>   // 'you said' | 'from cluster' | 'derived' | 'fixed'
  export function editable(source: 'user' | 'fact' | 'derived' | 'fixed'): boolean   // user, derived
  export function lockedReason(field: string, source: string): string | null        // hover text for fact/fixed
  export function fieldRows(s: AiSession): Array<{ name: string; label: string; value: string; badge: string; editable: boolean; note?: string }>
  ```
- Thread renders `transcript`; a `pending` with `choices` renders buttons that `POST /answer {field, value}`; the text box stays enabled and posts `{ text }`. The fields card edits with `PATCH /sessions/:id/fields`. Follow the HyperProx design language already used on the page.

- [ ] **Step 1: Write the failing test** `session-view.test.ts`: `editable('fact') === false`; `fieldRows` puts `features` with badge `fixed`, `editable: false`, and a `lockedReason` mentioning the API token.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test ../frontend/app/ai/session-view.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helpers and the two components; the page keeps its provider and model tabs unchanged.
- [ ] **Step 4: Run** the test and `pnpm --filter @hyperprox/frontend typecheck` → PASS; exit 0; `grep -n "wizard/plan" apps/frontend/app/ai/page.tsx` prints nothing.
- [ ] **Step 5: Commit** `AI page: the wizard is a conversation — one question at a time, with a fields card that fills in`

### Task 20: AI page: preview, execute and job view **[Sonnet]**

**Files:**
- Create: `apps/frontend/app/ai/Preview.tsx`
- Modify: `apps/frontend/app/ai/session-view.ts` (+ test), `apps/frontend/app/ai/page.tsx` (`ExecutionView` polls `GET /api/ai/jobs/:id`)

**Interfaces:**
- Produces: `export function canExecute(s: AiSession, now: Date): boolean` — `state === 'ready'` and every non-`warn` pre-flight check `ok` (phase 3 adds the 5-minute rule here too); `export function floorChanges(s: AiSession): string[]` (field notes that start `raised to`).
- Preview replaces the warnings list: fields, steps, pre-flight checks with pass/fail, floor adjustments. Execute posts `{}` to `/sessions/:id/execute`. The job view shows the failing step's own message and output tail; Resume and Clean up arrive in phase 4.

- [ ] **Step 1: Write the failing tests**: `canExecute` false for `blocked`, false with one failed check, true with only a failed `warn` check; `floorChanges` lists the disk note.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test ../frontend/app/ai/session-view.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and frontend typecheck → PASS; exit 0; `grep -n "wizard/" apps/frontend/app/ai/page.tsx` prints nothing.
- [ ] **Step 5: Commit** `AI page: preview with every field, step and check; execute sends only the session id`

**Phase 2 acceptance:** 001–010 pass via the API; `a question survives a restart` passes; execute refuses a non-ready session.

---

## Phase 3 — Pre-flight

### Task 21: Pre-flight checks over facts **[Sonnet]**

**Files:**
- Create: `apps/api/src/lib/ai/preflight.ts`
- Modify: `apps/api/src/lib/ai/templates/types.ts` (`PreflightFacts`), `apps/api/src/lib/ai/templates/deploy-service.ts` (`preflight`)
- Test: `apps/api/test/ai-preflight.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CheckId = 'template-arch' | 'packages' | 'vmid-free' | 'ip-free' | 'token-permissions' | 'storage-room'
    | 'node-room' | 'node-login' | 'dns-zone' | 'proxy-free' | 'reverse-proxy'
  export interface PreflightFacts extends TemplateFacts {
    permissions: Record<string, Record<string, number>>          // path → privilege → 1 (Task 22 fills it)
    packageChecks: Record<string, 'ok' | 'failed' | 'running' | 'unverified'>   // release key → status (Task 23 fills it)
    arp?: (node: string, ip: string) => Promise<boolean>         // true = something answered
  }
  export type CheckFn = (f: DeployFields, facts: PreflightFacts) => Check | Promise<Check>
  export const CHECKS: Record<CheckId, CheckFn>
  export async function runPreflight(f: DeployFields, facts: PreflightFacts): Promise<Check[]>   // public-only checks only for exposure public
  export async function gatherPreflightFacts(f: DeployFields, base: TemplateFacts, deps?: Partial<PreflightDeps>): Promise<PreflightFacts>
  ```
- Each check passes exactly as the spec's table says and, failing, names `field`. `ip-free` adds a separate `warn: true` check `ip-arp` when `arp` reports an answer ("Something on the network answered at <ip>. It is not a guest HyperProx can see; check before using it."). `node-login` failing is a block for `public`, and `warn: true` for `lan` (the job then creates the guest and shows the install commands) — see spec gap 3. `dns-zone` uses `zoneFor`. `template-arch` passes for a `download` note when the download's arch matches the node.

- [ ] **Step 1: Write the failing tests**: one pass and one fail per check id against the fixture; `public-only checks are skipped for lan`; `an ARP answer is a warning, never a block`; `node-login blocks public and warns lan`.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-preflight.test.ts` → FAIL.
- [ ] **Step 3: Implement**; the ARP probe (default `arp`) runs `ping -c1 -W1 <ip> >/dev/null 2>&1; ip neigh show <ip>` on the node through `execOnNode` only when the node has a login, and is `undefined` otherwise.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: pre-flight checks that block, each naming the field to change`

### Task 22: `token-permissions` **[Opus]**

**Files:**
- Modify: `apps/api/src/lib/ai/preflight.ts`
- Test: `apps/api/test/ai-preflight-permissions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function requiredPrivileges(f: DeployFields & { ha?: boolean; backup_job?: string }): Array<{ path: string; priv: string }>
  export async function readPermissions(pve: Pick<ProxmoxClient, 'fetchStrict'>, paths: string[]): Promise<Record<string, Record<string, number>>>
  export function rootOnlyRequest(createParams: { features?: string; unprivileged?: boolean }): string | null   // reason, or null
  ```
- Required: `VM.Allocate` on `/vms/<vmid>`; `Datastore.AllocateSpace` on `/storage/<storage>`; `SDN.Use` on `/sdn/zones/localnetwork/<bridge>`; `Datastore.AllocateTemplate` on `/storage/<template storage>` when the template has the `download` note; `Sys.Modify` on `/` when `ha` or `backup_job` is set (phase 5 fields). Read with `GET /access/permissions?path=<path>` per path (the token's own effective privileges). A `rootOnlyRequest` (any feature other than `nesting=1`, or a privileged container) fails the check whatever the ACL says.

- [ ] **Step 1: Write the failing tests**: `a token without VM.Allocate fails token-permissions, naming the privilege and path`; `inherited privileges from / count`; `Sys.Modify is required only with HA or a backup job`; `a feature flag other than nesting fails even with full privileges`; `a permissions read that errors fails the check with the platform's message` (never passes by default).
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-preflight-permissions.test.ts` → FAIL.
- [ ] **Step 3: Implement**; the failure message is `"The API token lacks <priv> on <path>. Grant it in Proxmox (Datacenter → Permissions) and check again."`.
- [ ] **Step 4: Run** the test file and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: pre-flight proves the API token may do everything the job will ask, before anything is created`

### Task 23: `packages`: verified once per distro release **[Opus]**

**Files:**
- Create: `apps/api/src/lib/ai/package-check.ts`
- Modify: `apps/api/prisma/schema.prisma` + migration `20261030130000_add_ai_package_checks` (model `AiPackageCheck` → `ai_package_checks`: `key String @id`, `status String`, `detail String?`, `checkedAt DateTime`)
- Test: `apps/api/test/ai-package-check.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function releaseKey(volid: string): string | null     // 'debian-13' | 'ubuntu-24.04'
  export interface PackageCheck { key: string; status: 'ok' | 'failed' | 'running'; detail?: string; checkedAt: Date }
  export interface PackageCheckStore { get(key: string): Promise<PackageCheck | null>; put(c: PackageCheck): Promise<void> }
  export class MemoryPackageCheckStore implements PackageCheckStore {}; export class PrismaPackageCheckStore implements PackageCheckStore {}
  export const PACKAGE_CHECK_TAG = 'hyperprox:package-check'
  export async function verifyPackages(key: string, f: DeployFields, d: { pve: CreatePVE & Pick<ProxmoxClient, 'fetchStrict'>; exec: typeof execInGuest; store: PackageCheckStore; wait(ms: number): Promise<unknown> }): Promise<PackageCheck>
  ```
- `verifyPackages` creates one throwaway container (next free ID, hostname `hp-pkgcheck`, description `"<PACKAGE_CHECK_TAG>:<key>"`, the template constants, 2 GB on `f.storage`, DHCP on `f.bridge`), runs `set -e; apt-get update -qq; apt-cache show <packages> >/dev/null`, records `ok` or `failed` with the last 12 lines, then stops and destroys **only that ID, and only after re-reading its config and finding the tag in its description**; a mismatch is logged and the guest left in place. The `packages` check: cached `ok` passes; `failed` blocks naming the template; none cached → starts `verifyPackages` in the background, records `running`, and returns `ok: false, "Checking that <key> has these packages; this takes a minute."`. No node login → passes (the install is not run there; `node-login` already says so).

- [ ] **Step 1: Write the failing tests**: `a cached ok passes without creating anything`; `an uncached release starts one verification and reports running`; `two pre-flights at once start one verification`; `the throwaway is destroyed only when its description carries the tag`; `a failed apt-cache records failed with the output tail`.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-package-check.test.ts` → FAIL.
- [ ] **Step 3: Implement**; in-flight verifications are tracked per key in a `Map<string, Promise<PackageCheck>>`.
- [ ] **Step 4: Run** the test file, `npx prisma validate` and typecheck → PASS; exit 0.
- [ ] **Step 5: Commit** `AI wizard: package names are proven once per distro release, in a throwaway container that only it may remove`

### Task 24: Pre-flight gates ready and execute **[Sonnet]**

**Files:**
- Modify: `apps/api/src/lib/ai/sessions.ts`, `apps/api/src/routes/ai-sessions.ts` (add `POST /sessions/:id/preflight` → `Session`, see spec gap 2), `apps/frontend/app/ai/session-view.ts` (`canExecute` 5-minute rule) and `Preview.tsx` (a "Check again" button)
- Create: scenarios `012-arm64-template-only.yaml`, `013-ubuntu-template.yaml`, `015-token-without-allocate.yaml` with fixtures `fixtures/arm64-template-only.json`, `fixtures/ubuntu-template.json`, `fixtures/token-without-allocate.json` (each the three-node fixture plus `permissions` and `packageChecks`); add `permissions` (full) and `packageChecks: { "debian-13": "ok" }` to `three-node-cluster.json` and `preflight: all-pass` to scenarios 001, 002, 007–011
- Test: `apps/api/test/ai-session-preflight.test.ts`

**Interfaces:**
- Consumes: Tasks 16, 17, 21–23.
- Produces: `export const PREFLIGHT_FRESH_MS = 5 * 60_000`; `SessionDeps.preflightFacts(f: DeployFields, base: TemplateFacts): Promise<PreflightFacts>`.
- Rules: when `settle` leaves no issues, pre-flight runs; all non-`warn` checks pass → `ready`, `preflightAt = now`; else `blocked` with `preflight` set and the first failure's field named in an assistant turn. `execute`: `preflightAt` older than 5 minutes → `409 "The checks are more than five minutes old. Check again."`; then pre-flight re-runs; any failure → `409`, state `blocked`, nothing created. Resume re-runs pre-flight in phase 4.

- [ ] **Step 1: Write the failing tests**: `ready requires a passing pre-flight`; `execute refuses stale checks`; `execute re-runs pre-flight and refuses on a new failure` (the vmid becomes taken between preview and execute; `started.length === 0`); `POST /preflight refreshes preflightAt`. Scenarios: 012 → `ready` with `template` noted `download` and an amd64 name, never `_arm64`; 013 → `packages` field equals the ubuntu constant and the install script contains `docker-compose-v2`; 015 → `state: blocked`, `preflight: { token-permissions: false }`.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/ai-session-preflight.test.ts && pnpm --filter @hyperprox/api test:scenarios` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both again, the suite and both typechecks → PASS (`test:scenarios` `# tests 25`); exit 0.
- [ ] **Step 5: Commit** `AI wizard: nothing is ready, or runs, until pre-flight passes on facts no older than five minutes`

**Phase 3 acceptance:** 012, 013 and 015 are caught before any create; a token without `VM.Allocate` fails `token-permissions`.

---

## Phases 4–7 — outlines (each gets its own plan)

### Phase 4 — Ledger, resume, cleanup
- **4.1 [Sonnet]** `ai_jobs` table (job, steps, `ledger Json`, `createUpid`, owner); jobs move out of memory; Task 16's "restarted while running" becomes a resumable `failed`.
- **4.2 [Opus]** Resource ledger and idempotent steps: each step records `guest`, `proxy_host`, `dns_record`, `certificate`, `ha_resource`, `backup_membership`; a step whose resource exists and checks out is marked done and skipped; scenario 014.
- **4.3 [Opus]** `POST /jobs/:id/resume`: re-runs pre-flight for remaining steps only; fields editable only where no completed step depends on them; scenarios 016, 017.
- **4.4 [Opus]** `POST /jobs/:id/cleanup { confirm }`: reverse ledger order, only ledger resources, guest leaves every backup job before stop + destroy with disks; same user who executed, guest ID typed to confirm (decision 8); scenario 018.
- **4.5 [Sonnet]** Job view: Resume from this step, Clean up this job (listing exactly what is removed); `test:scenarios:full --cluster <name>` harness with Let's Encrypt staging and a test zone; full-run of 001 then cleanup leaves nothing.

### Phase 5 — Completion
- **5.1 [Sonnet]** `complete_guest`: `onboot` verified after create; backup-job membership (default = the job covering most guests, decision 5; `none` repeated in the summary); `backup_job` field; template version 2.
- **5.2 [Opus]** Optional HA resource with a node-affinity rule preferring the chosen node; `ha` field, default off, offered at preview (decision 6); `Sys.Modify` path in `token-permissions` exercised.
- **5.3 [Opus]** `secure_first_run`: `env-admin` generates the credential, stores it in the vault, shows it once; `setup-url` + `now` waits for the user's "done" before step 7; remove Task 11's interim publish guard. (`lock` waits for proxy access lists.)
- **5.4 [Sonnet]** `verify_url` through the proxy against the recipe's `expectStatus`; job summary (URL, address, ID, node, sizes, backup job, HA, admin credential, ledger).
- **5.5 [Sonnet]** Full-run of 001 and 002: guest in a backup job, `onboot: 1`, no public first-run page at any point.

### Phase 6 — Naming convention
- **6.1 [Sonnet]** Settings → AI `naming` block (off by default), validated at save (subnet contains the bridge gateway; offset stays inside the subnet).
- **6.2 [Opus]** Pair derivation both directions, mismatch as a notice not a block, taken pair moves to the next free host on that node; scenario 020; fresh install off.

### Phase 7 — Next templates
- **7.1 [Opus]** `publish-guest` (proxy host + DNS + certificate for an existing guest and port), ≥ 5 scenarios including two bad-input cases.
- **7.2 [Opus]** `remove-deployment` (certificate, proxy host, DNS record, backup membership, HA resource, then the guest, each confirmed), ≥ 5 scenarios.
- **7.3 [Sonnet]** `resize-guest` / `move-guest` (refused for local bind mounts), ≥ 5 scenarios each.

---

## Spec gaps resolved in this plan

1. **Phase 1 acceptance needs intent match and the question loop**, which the phasing table lists under phase 2 (scenarios 005/006 need intent; 001, 007–011 need questions). Both are built in phase 1 as pure code (Tasks 9, 10); phase 2 adds persistence, the API and the UI.
2. **No way to refresh pre-flight.** Execute needs checks under 5 minutes old, but the API has no call to re-run them except editing a field. Task 24 adds `POST /sessions/:id/preflight`.
3. **`node-login` contradicts "never a warning you can click past".** Resolved as: block for `public`, warning for `lan` (Task 21), because publishing never runs after an install that did not run.
4. **Phases 1–4 could still publish an unclaimed first-run page** (the first-run lock is phase 5). Task 11 refuses publishing steps for recipes with a first-run page until Task 5.3 removes the guard.
5. **`answer` text for non-task prompts** comes from the intent call and is shown as text only (Task 9); the spec did not say who writes it. **A bare address's prefix** is taken from the bridge (Task 6). Pre-flight checks gain `warn` for the ARP probe, which the spec's `Session.preflight` shape lacked (Task 15).
