# AI template prompting — design

Status: design, for approval 2026-10-30. Not yet built. Replaces the wizard's free-form plan; keeps its
providers, facts, placement rules and executor steps.

## Why

The wizard asks a model to write a whole deployment plan: steps, sizes, gateway, warnings. The first
end-to-end run of a real prompt ("deploy Uptime Kuma on node pve2 at 10.0.0.37, container 237, at
kuma.example.com") took seven rounds and ten fixes to finish. Almost every failure was the model or the
executor deciding something that was already decided, or that nobody had checked:

- the model invented a gateway when handed the wrong fact;
- the executor ignored the node, container ID and address the user gave;
- a feature flag only root@pam may set was requested, and the create failed with a 403;
- the newest template on a share was built for another CPU; it extracted, then could not start;
- the install used another distribution's package name and, with no `set -e`, ran on to a confusing exit;
- the model's disk size ignored what Docker and the image need;
- a failed start from an earlier guest with the same ID was read as this one's.

The successful run still left the guest without `onboot`, outside the backup job, and with its app's
first-run admin page open on a public hostname.

HyperProx exists to make the operator's life easier. That means the AI understands the request and asks
when something is missing, and HyperProx does everything else the same way every time.

## Goals

- **Template prompting.** Each task type is an engineered template with typed fields. The model extracts
  field values from the user's words. It never writes steps.
- Missing or invalid required fields become **questions, one at a time**. The answer is extracted into
  the same fields and the flow continues.
- Every field is validated against live cluster facts before the user sees a preview.
- **Pre-flight checks** before anything is created catch what most of the rounds above hit.
- Execution fails loudly, stops at the failed step, **resumes from it**, and can **clean up** what this
  job created.
- A deployment is finished when it survives a reboot, is backed up and is safe to publish, not when the
  certificate is issued.
- A **scenario inventory** of real prompts, run end to end, is the wizard's test suite. Every bug adds one.

## Non-goals

- Free-form agents that plan arbitrary multi-step operations. A request no template matches gets an
  answer, not a plan.
- New providers. Anthropic, OpenAI and Ollama stay; nothing here depends on which one is active.
- Templates authored by users at runtime. Templates are code, reviewed and tested like code.
- VM deployment. "Deploy a service" creates an LXC; a VM template can reuse the format.

## Task templates

A template is a TypeScript module under `apps/api/src/lib/ai/templates/`, registered in
`templates/index.ts`. The model sees only the template's field schema and its intent examples.

```ts
interface TaskTemplate<F> {
  id:        string                    // 'deploy-service'
  version:   number                    // bumped when fields or steps change; stored on each session
  summary:   string                    // one line, shown in the UI and given to the intent matcher
  intents:   string[]                  // example requests, positive and near-miss, for matching and tests
  fields:    FieldSpec[]               // order = question order
  extract:   JsonSchema                // derived from `fields`; the only shape the model may return
  constants: Record<string, unknown>   // owned by the template, never by the model
  derive(f: Partial<F>, facts: Facts, settings: Settings): Partial<F>
  validate(f: Partial<F>, facts: Facts): FieldIssue[]
  preflight(f: F, facts: Facts): Promise<Check[]>
  steps(f: F): StepSpec[]              // fixed list; fields only parameterise it
}

interface FieldSpec {
  name:      string
  type:      'string' | 'int' | 'enum' | 'ipv4cidr' | 'hostname' | 'bool'
  required:  boolean | ((f) => boolean)   // e.g. domain is required only when exposure = public
  source:    'user' | 'fact' | 'derived' | 'fixed'
  extract:   boolean                      // false: the model is never asked for it
  question?: string                       // asked when missing or invalid
  choices?:  (facts) => string[]          // offered as buttons when the set is small
}
```

**Sources.** `user`: only from the user's words or answers. `fact`: only from the cluster, never
extracted. `derived`: computed from other fields and settings when the user gave none; the user may
override it. `fixed`: a template constant, not shown as editable.

### `deploy-service` (first template, fully specified)

Intent examples: "deploy Uptime Kuma at status.example.com", "set up Gitea on pve2", "I want a Grafana
container, LAN only", "install vaultwarden as container 250 on 10.0.0.50". Near misses that must not
match: "what is Uptime Kuma?", "is Gitea running?", "remove the Grafana container".

| Field | Type | Req. | Source | Validation against live facts | Question when missing/invalid |
|---|---|---|---|---|---|
| `service` | enum (recipe ids) | yes | user | must match an install recipe; fuzzy match is offered, never assumed | "Which service? I can install: …" (buttons) |
| `exposure` | enum `public` / `lan` | yes | user | `public` needs a reverse proxy and a managed DNS zone | "Should this be reachable from the internet, or only on your network?" |
| `domain` | hostname | if public | user | under a zone the DNS provider manages; not already a proxy host; never invented | "Which hostname should it answer on? Zones I manage: example.com, …" |
| `admin_setup` | enum `now` / `lock` / `later` | if public and recipe has first-run setup | user | `later` is refused when public (see Post-deploy) | "This app's first visitor becomes its admin. Create the admin account now, or keep it LAN-only until you do?" |
| `node` | enum (online nodes) | yes | user, else derived | online; free memory ≥ `memory_mb`; has a stored node login if the install runs; node CPU arch known | only if derivation finds no node with room |
| `vmid` | int | yes | user, else derived | 100–999999999; not in `/cluster/resources` | "Container ID N is taken by another guest. Use M instead?" |
| `ip` | ipv4cidr or `dhcp` | yes | user, else derived, else `dhcp` | on the bridge's subnet; no guest config uses it; not the gateway or the network/broadcast address | "10.0.0.37 is already used by guest 105. Which address, or DHCP?" |
| `gateway` | ipv4 | if static ip | **fact only** | read from the node's bridge; a model-supplied value is discarded | never asked |
| `bridge` | string | yes | fact | exists on the chosen node (`vmbr0` default, from settings) | never asked |
| `storage` | enum | yes | derived | holds `rootdir`, active on the node, free ≥ disk × 1.2; block storage ranked before file shares | only if none qualifies |
| `template` | volid | yes | fact, filtered | same CPU arch as the node; newest Debian standard, then Ubuntu LTS; download offered if none | never asked; a missing one is a pre-flight failure |
| `memory_mb` / `disk_gb` / `cores` | int | yes | recipe default, user may raise | ≥ template floor (Docker: 512 MB, 8 GB); fits node and storage | only if the user's figure is below the floor: "Docker needs at least 8 GB. Use 8?" |
| `hostname` | hostname | yes | derived from service | RFC 1123 label; not used by another guest | never asked |
| `ha` | bool | no | user | HA available on the cluster; guest has no local bind mounts | offered at preview, default off |
| `backup_job` | enum (backup job ids) / `none` | no | derived | job exists and is enabled | offered at preview, default = the job covering most guests |
| `features` | — | — | **fixed** `nesting=1` | — | never |
| `packages` | — | — | **fixed** per distro | — | never |

**Template constants** (`constants`), each with the reason in a comment beside it:

- `features: 'nesting=1'` and `unprivileged: 1`. Proxmox lets only root@pam set any other feature flag,
  and HyperProx authenticates with an API token. Docker runs in an unprivileged container with nesting only.
- `packages`: `{ debian: ['ca-certificates', 'curl', 'docker.io', 'docker-compose'], ubuntu: [..., 'docker-compose-v2'] }`,
  chosen by the template's distro, not by `||` fallbacks.
- `floors: { docker: { memory_mb: 512, disk_gb: 8 } }`. Sizes from the recipe or the model are requests;
  the floor is applied after them and shown in the preview when it changes a value.
- `onboot: 1`, `start: 1`, `firewall: 1` on `net0`.
- `ttl: 600` for the A record; propagation wait 5 minutes against public resolvers.

**Fixed steps** (`steps(f)`), the same for every run, filtered only by `exposure`:

1. `create_lxc` — create from `template` on `node`/`storage` with `vmid`, `ip`, `gateway`, constants; wait on the create UPID.
2. `start_and_verify` — the start task newer than this create's UPID time decides; running twice, 5 s apart.
3. `install_service` — `set -e` script from constants + recipe; quiet pull; the last 12 lines in any error.
4. `health_check` — the recipe's `healthPath` answers on `ip:port` from HyperProx.
5. `complete_guest` — `onboot`, backup-job membership, optional HA resource (see Post-deploy).
6. `secure_first_run` — only when the recipe has first-run setup (see Post-deploy).
7. `configure_proxy` *(public)* — proxy host to `ip:port`.
8. `create_dns` *(public)* — A record to the WAN address in the managed zone.
9. `wait_propagation` *(public)*.
10. `request_ssl` *(public)* — certificate, attached, HTTPS forced.
11. `verify_url` *(public)* — `https://domain` returns the recipe's expected status through the proxy.

`lan` deployments stop after step 6 and report `http://ip:port`.

### Next candidates (not specified here)

- `resize-guest` / `move-guest`: memory, cores, disk grow; migrate to another node (refused for local bind mounts).
- `publish-guest`: proxy host + DNS + certificate for an existing guest and port.
- `remove-deployment`: the reverse of `deploy-service` for a guest HyperProx deployed: certificate, proxy
  host, DNS record, backup-job membership, HA resource, then the guest, each confirmed.

## The loop

```
prompt ─► intent match ─► extract ─► derive ─► validate ─┬─► question ─► answer ─► extract ─┐
                                                          │                                  │
                                                          └◄─────────────────────────────────┘
                     all required fields valid ─► pre-flight ─► preview ─► confirm ─► execute
```

1. **Intent match.** One model call with the template summaries and intent examples returns
   `{ template: id | 'none', question: boolean }`. `none` or `question: true` returns a plain answer
   and, where one applies, an example request. Keyword fallback when no provider is reachable.
2. **Extraction.** One model call with the template's `extract` schema returns only `extract: true`
   fields, each a value or `null`. The prompt says: fill fields from the user's words; `null` when not
   stated; never guess. There is no `steps`, `gateway`, `features` or `packages` field to fill.
3. **Derive.** Fill `derived` and `fact` fields that are still empty (naming convention, best-fit node,
   storage, template, recipe sizes, floors). Every derived value is marked as such in the preview.
4. **Validate.** `validate()` returns issues per field. Invalid user values are not silently replaced.
5. **Questions.** The first required field that is missing or invalid, in `fields` order, becomes one
   question. The answer is extracted against the same schema, merged (a later answer wins for the
   fields it names), and the loop repeats from step 3. Questions are code-authored text with facts
   substituted, not model prose. A session asks at most 8 questions before showing what is still missing.
6. **Pre-flight**, then **preview**: every field with its source, every step, every check, and what
   the floors changed. **Confirm** sends only the session id. **Execute** runs the server-held fields.

**The model never decides:** the gateway, the bridge, feature flags, privilege, packages, the template,
steps or their order, sizes below the floor, the DNS zone list, or anything about another guest. A
model value for a non-extractable field is dropped and logged.

### API

All under `/api/ai/`. Sessions are stored in the database (table `ai_sessions`), not in memory, so a
question survives a restart and a job can be resumed. Sessions expire after 24 h idle.

| Method | Path | Body → response |
|---|---|---|
| POST | `/sessions` | `{ prompt }` → `Session` |
| POST | `/sessions/:id/answer` | `{ field, value }` (button) or `{ text }` (free text) → `Session` |
| PATCH | `/sessions/:id/fields` | `{ field: value, … }` edits from the preview → `Session` |
| POST | `/sessions/:id/execute` | `{}` → `{ jobId }`; refused unless `state = ready` and pre-flight passed within 5 min |
| POST | `/jobs/:id/resume` | `{}` → re-runs pre-flight for remaining steps, continues from the failed step |
| POST | `/jobs/:id/cleanup` | `{ confirm: [resourceIds] }` → removes only what this job created |
| GET | `/jobs/:id` | job, steps, created resources |
| DELETE | `/sessions/:id` | abandon |

```ts
interface Session {
  id: string; template: string | null; templateVersion: number
  state: 'answer' | 'asking' | 'ready' | 'blocked' | 'executing' | 'done' | 'failed'
  answer?: string                                   // state 'answer': not a task
  fields: Record<string, { value: unknown; source: 'user'|'fact'|'derived'|'fixed'; note?: string }>
  pending?: { field: string; question: string; choices?: string[] }   // exactly one, or none
  issues: Array<{ field: string; message: string }>
  preflight?: Array<{ id: string; ok: boolean; message: string }>
  steps?: Array<{ id: string; label: string }>
  transcript: Array<{ role: 'user'|'assistant'; text: string; at: string }>
}
```

`/wizard/plan` and `/wizard/execute` are removed when phase 2 ships. Execution never accepts a plan
from the client.

### UI (AI page, wizard tab)

- The chat thread shows the transcript. A pending question renders as a bubble with buttons when
  `choices` are given, and the text box stays usable for a free answer.
- A **fields card** beside the thread fills in as values arrive: each field with a source badge
  (*you said*, *from cluster*, *derived*, *fixed*). Derived and user fields are editable in place
  (PATCH); fixed and fact fields are read-only with the reason on hover.
- **Preview** replaces the warnings list: fields, steps, pre-flight checks with pass/fail, and the floor
  adjustments. Execute is enabled only when every check passes.
- **Job view** shows steps live. A failed step shows the platform's own message and the output tail,
  with **Resume from this step** and **Clean up this job** (listing exactly what will be removed).

## Derived defaults: naming convention

A setting under Settings → AI, **off by default**. When off: `vmid` = `/cluster/nextid`, `ip` = DHCP
unless the user gives one.

When on, one rule links ID and address, in both directions:

```yaml
naming:
  enabled: false
  subnet: 10.0.0.0/24        # must contain the bridge gateway; checked at save
  id_pattern: "{node}{host}" # tokens: {node} node index, {host} last-octet digits
  host_digits: 2             # {host} width
  host_offset: 200           # host octet = offset + {host}; must stay inside the subnet
  node_index: { pve1: 1, pve2: 2, pve3: 3 }
```

Example: node `pve2`, next free host `37` → ID `237`, IP `10.0.0.237/24`. Given only an ID, the IP is
derived; given only an IP, the ID is derived; given both, they are checked against the rule and a
mismatch is a **notice, not a block** (a user-stated value wins). A derived pair that is taken moves to
the next free host number on that node. Validation is unchanged: free in `/cluster/resources`, unused in
every guest config, on the bridge subnet.

## Pre-flight checks

Run after the last answer and again at execute (facts can change). Each returns `ok` and one sentence.

| Check | Passes when |
|---|---|
| `template-arch` | a template for the node's CPU arch (from `/nodes/{node}/status` `cpuinfo`/kernel arch) exists, or a download for that arch is offered |
| `packages` | the template's distro is in `constants.packages`; on the first install per distro release the package names are verified once in a throwaway container and cached |
| `vmid-free` | not in `/cluster/resources` |
| `ip-free` | no guest config uses it; optional ARP probe from the node, warning only |
| `token-permissions` | the token's ACL (`/access/permissions`) includes `VM.Allocate`, `Datastore.AllocateSpace` on the storage, `SDN.Use` on the bridge, and `Sys.Modify` on `/` for HA and backup-job edits; and the request needs nothing only root@pam may do |
| `storage-room` | free ≥ disk × 1.2 on the chosen storage |
| `node-room` | free memory ≥ `memory_mb` |
| `node-login` | a node login is stored for the chosen node, else the install is shown, not run, and the user is told before execute |
| `dns-zone` *(public)* | the domain's zone is listed by the DNS provider (longest matching zone, not "last two labels") |
| `proxy-free` *(public)* | no proxy host already serves the domain |
| `reverse-proxy` *(public)* | a reverse proxy is configured |

A failed check names the field to change; it never becomes a warning the user can click past.

## Execution guarantees

- **Loud failures.** Every changing platform call is strict: a refusal surfaces with the platform's own
  status and message, never as a later timeout.
- **Wait on UPIDs.** Every Proxmox task is waited on by its UPID; its exit status and log tail decide.
- **Time-filtered history.** Any task-history lookup keyed by guest ID ignores tasks older than this
  job's create UPID.
- **Stop on failure.** A failed step stops the run. Publishing steps never run after a failed install
  or health check.
- **Installs** run `set -e`, a non-interactive frontend and quiet pulls; errors carry the last 12 lines.
- **Resource ledger.** Each step records what it created (`guest`, `proxy_host`, `dns_record`,
  `certificate`, `ha_resource`, `backup_membership`) with ids, in the job row.
- **Resume from the failed step.** Steps are idempotent against the ledger: a step whose resource
  exists and checks out is marked done and skipped. Resume re-runs pre-flight for the remaining steps
  only. Fields may be edited before resume only where no completed step depends on them.
- **Clean up this job.** Lists the ledger in reverse order and removes, on confirmation, only those
  resources. Never removes a resource the ledger does not hold. A guest is stopped then destroyed with
  its disks; its ID leaves every backup job *before* the destroy.
- **Post-deploy completion**, step 5–6, before anything is published:
  - `onboot: 1` is set at create and verified after.
  - Added to the selected backup job (or explicitly `none`, which the summary repeats). Creating is not
    finished until the guest is in a backup job, just as destroying is not finished until it is out.
  - Optional HA resource, with a node-affinity rule preferring the chosen node.
  - **First-run admin lock.** Recipes declare `firstRun: { kind: 'env-admin' | 'setup-url' | 'none', … }`.
    `env-admin`: HyperProx generates the admin credential, passes it to the container, stores it in the
    vault and shows it once. `setup-url`: with `admin_setup = now` the user completes setup on the LAN
    address before step 7 runs (the job waits, with a "done" button); with `lock` the proxy host is
    created with an access list allowing only the LAN until the user marks setup done. A public hostname
    with an unclaimed first-run page is never published.
- Every job ends with a summary: URL, address, ID, node, sizes, backup job, HA, admin credential, ledger.

## Scenario test inventory

Scenarios are YAML files in `apps/api/test/scenarios/<template>/NNN-<slug>.yaml`, run by
`apps/api/test/scenarios.test.ts` (node:test, like the rest of the suite).

```yaml
id: deploy-001-full-public
prompt: "Deploy an Uptime Kuma container on pve2 using IP 10.0.0.37, container number 237, at kuma.example.com"
facts: fixtures/three-node-cluster.json   # fake cluster state; full-run ignores it
answers:                                  # in order; each must match the question asked
  - { field: admin_setup, value: now }
expect:
  questions: [admin_setup]                # exactly these, in this order
  fields: { service: uptime-kuma, node: pve2, vmid: 237, ip: 10.0.0.37/24, gateway: "{fact}",
            domain: kuma.example.com, features: nesting=1, disk_gb: ">=8" }
  state: ready
  preflight: all-pass
  outcome:                                # full-run only
    url: { https: kuma.example.com, status: [200, 302], title: "Uptime Kuma" }
    guest: { onboot: 1, in_backup_job: true }
found_by: "2026-10-30 live test, rounds 1-7"
```

**Two tiers:**

- **Plan-only** (CI, every change, free). Fake Proxmox/DNS/proxy fixtures; the model is either a
  recorded response per provider or, for the deterministic parts, bypassed with the expected
  extraction. Asserts questions, fields, issues and pre-flight. Also runs live against each configured
  provider on demand (`pnpm test:scenarios --provider ollama`) to compare extraction accuracy.
- **Full-run** (manual, `pnpm test:scenarios:full --cluster <name>`). Real cluster, real DNS in a test
  zone, Let's Encrypt staging. Creates, verifies the outcome from outside (resolve via a public
  resolver, fetch the URL, read the guest config), then runs the job's cleanup and verifies the ledger
  is empty. Pass means the outcome, never the wizard's own success message.

**Seed inventory:**

| id | Prompt (generalised) | Expected |
|---|---|---|
| deploy-001 | full request: service, node, IP, ID, domain | domain implies public; asks only admin_setup; ready |
| deploy-002 | "Deploy Uptime Kuma." | asks exposure; `lan` → ready with derived ID/IP, no proxy steps |
| deploy-003 | "Deploy Uptime Kuma, make it public" | asks domain, offering managed zones |
| deploy-004 | "Deploy Plex at plex.example.com" (no recipe) | asks service with recipe choices; never `ready` with an unknown service |
| deploy-005 | "What is Uptime Kuma?" | `state: answer`, no fields, no questions |
| deploy-006 | "Is Gitea running?" | `state: answer`; does not match `deploy-service` |
| deploy-007 | ID already taken | question offers next free ID |
| deploy-008 | IP used by another guest | question names the guest and asks for another or DHCP |
| deploy-009 | IP off the bridge subnet | invalid, asked again; gateway never extracted |
| deploy-010 | domain outside managed zones | asked again, listing zones |
| deploy-011 | "with 2 GB disk" for a Docker recipe | floor question; final `disk_gb: 8` |
| deploy-012 | node has only an arm64 template on shared storage | `template-arch` picks amd64 or offers download; never arm64 on amd64 |
| deploy-013 | Ubuntu template chosen | packages from the ubuntu constant |
| deploy-014 | fake task history holds an old failed start for the same ID | create succeeds; old task ignored |
| deploy-015 | Proxmox answers 403 to create | job fails with the 403's text at `create_lxc` |
| deploy-016 | install exits non-zero | stops at `install_service`; tail present; steps 7–11 not run; resume and cleanup offered |
| deploy-017 | resume after 016 with a fixed recipe | create skipped (ledger), install re-run, job completes |
| deploy-018 | cleanup after 016 | guest leaves backup job, then is destroyed; ledger empty |
| deploy-019 | model returns a gateway / features / steps anyway | dropped, logged, not in session |
| deploy-020 | naming convention on, only node given | ID and IP derived as a pair |

**Every bug adds a scenario**, named after it, with `found_by`, in the same commit as the fix.

## Provider notes

- Anthropic, OpenAI and Ollama all stay, behind the existing interface; each call takes one JSON Schema.
- Constraint by provider: Anthropic structured output (`output_config.format`), OpenAI
  `response_format: json_schema` with `strict: true`, Ollama `format: <schema>`. Every reply is parsed
  with the same zod schema; a parse failure retries once, then the session asks the user to rephrase.
- The extract schema is small and flat: per field `string | integer | enum | null`, `additionalProperties:
  false`, with enums filled from facts at request time (service ids, node names, zones). Enums do most of
  the work a large model did before.
- Because the model only fills a handful of fields from one or two sentences, a small local model is
  viable: the hard decisions it got wrong before (gateway, sizes, steps) are no longer its to make.
  Scenario plan-only runs report per-provider extraction accuracy so the default model is chosen on evidence.
- The system prompt is the template's field descriptions plus "null when not stated"; static per version, so it caches.

## Phasing

| Phase | Delivers | Acceptance |
|---|---|---|
| 1. Template core | `TaskTemplate`, `deploy-service` fields/constants/steps, derive + validate, extraction call per provider; executor reads typed fields instead of `plan.steps` | plan-only scenarios 001–011, 019 pass on recorded responses; no code path reads a model-written step or gateway |
| 2. Sessions and questions | `ai_sessions`, session API, one-question loop, intent match, UI thread + fields card + preview; old `/wizard/*` removed | 001–010 pass through the API; a restart mid-question keeps the session; execute refuses a non-ready session |
| 3. Pre-flight | all checks in the table, re-run at execute | 012, 013, 015 caught before any create; a token without `VM.Allocate` fails `token-permissions` |
| 4. Ledger, resume, cleanup | resource ledger, idempotent steps, resume and cleanup endpoints + UI | 014, 016–018 pass; full-run of 001 then cleanup leaves no guest, proxy host, record or job membership |
| 5. Completion | onboot verify, backup job, optional HA, first-run lock, URL verify, summary | full-run of 001 and 002: guest in backup job, `onboot: 1`, no public first-run page at any point |
| 6. Naming convention | setting, pair derivation | 020 passes; off by default on a fresh install |
| 7. Next templates | `publish-guest`, then `remove-deployment`, then resize/move | each ships with ≥ 5 scenarios including two bad-input cases |

## Open decisions

1. **One install-recipe source.** The wizard's `SERVICE_CATALOG` and the catalogue's `CATALOGUE` both
   describe installs, differently. *Recommendation:* merge into the catalogue format (it already carries
   `healthPath`, defaults and first login), and add `firstRun` and per-distro packages there.
2. **Catalogue installer privilege.** It still creates Docker containers privileged with `keyctl=1`,
   which an API token cannot set. *Recommendation:* switch it to the template constants (unprivileged,
   `nesting=1`) in phase 1, since it will hit the same 403.
3. **Exposure default when a domain is given.** *Recommendation:* a domain in the prompt implies
   `public` without asking; no domain means ask. Fewer questions for the common case.
4. **Intent match: model or keywords.** *Recommendation:* model call with keyword fallback; near-miss
   scenarios guard it.
5. **Backup job default.** *Recommendation:* preselect the job that covers the most guests; `none` is
   allowed but repeated in the summary.
6. **HA default.** *Recommendation:* off, offered at preview; HA with fencing is the operator's decision.
7. **First-run `setup-url` with `lock`.** Needs a reverse-proxy access list. *Recommendation:* ship
   `now` first (job waits for the user); `lock` follows once access lists are supported.
8. **Who can approve cleanup of a guest.** *Recommendation:* the same user who executed, with the guest
   ID typed to confirm, matching the existing deletion guard.
9. **Live-provider scenarios in CI.** *Recommendation:* no; recorded responses in CI, live runs on demand,
   so CI stays free and deterministic.
