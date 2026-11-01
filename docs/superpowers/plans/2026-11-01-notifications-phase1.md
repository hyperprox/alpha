# Notifications — Phase 1 build plan (2026-11-01)

Spec: `docs/superpowers/specs/2026-10-31-notifications-design.md` (approved 2026-10-31, open decisions as
recommended). This plan covers **Phase 1 only**: channels, the event bus, and moving the three existing
senders (lock alert, Updates `notify.webhook_url`, Certificates `alerts.webhook_url`) onto it. Rules, mutes,
the Alerts page, PVE ingest and email are later phases and are not started here.

Branch `notifications-p1` from `main` (2d8e959). TDD: each task lands its tests first.

## Decisions this plan fixes

- **Channel kinds:** `discord`, `slack`, `teams`, `ntfy`, `gotify`, `telegram`, `webhook`. Email is Phase 4.
- **Secret fields per kind** (vault item `hyperprox:notify/<channelId>`, hidden fields):
  discord/slack/teams `url`; ntfy `url` + optional `token`; gotify `url` + `token`; telegram `bot_token`
  (chat id is non-secret); webhook `url` + optional `signing_secret`.
- **Usable while locked:** the secret moves to `data/notify-locked-channels.json` (0600, atomic write, under
  the git-ignored `data/`), together with a copy of the channel's non-secret delivery settings, so the lock
  alert needs neither Postgres nor the vault. Owner only to turn on. Telegram allowed with a stronger warning.
- **Families** come from the event type's first segment: `vault`, `updates`, `certs`, `jobs`
  (`wizard.*`, `catalogue.*`), `backups` (`backup.*`), `resources` (`alert.*`). `notify.*` (channel failing)
  goes to channels whose filter is "all events".
- **Grouping:** the first message to a channel goes at once; anything else for that channel within 60 s of a
  send waits for the end of those 60 s and goes as one grouped message (at most 5 lines).
- **Rate brake:** at most 6 messages per channel per 10 minutes, then one "Many alerts at once" message and
  nothing more on that channel until the window clears (held rows `dropped`).
- **Retries:** 10 s, 1 min, 5 min, then `failed`. 429 honours `Retry-After`. Any other 4xx and any 3xx fail
  at once and mark the channel failing. Network errors and 5xx retry.
- **Fired then resolved while held** (quiet hours or locked): an event with `resolved: true` and the same
  `fingerprint` drops both rows. Phase 1 publishers do not set fingerprints yet; Phase 2's rule engine will.
- **Seeding:** the lock channel at startup from `LOCK_ALERT_*` (or the YAML webhook it used to fall back to),
  recorded in the locked-channels file, no unlock needed. The Updates and Certificates webhooks at the first
  Owner sign-in, after the credential migration, recorded in `NotifyState`. Same URL → one channel, union of
  families, lowest minimum severity. Until a seed has run, the old setting is still delivered through the
  same adapters as a virtual "legacy" channel, so nothing that alerts today goes quiet.
- **Updates** `updates.reboot.pending` is folded into the `updates.job.finished` lines (one message per run).
- **Single runner:** in-process mutex only; the advisory lock waits for Phase 2's evaluator.

## Files

```
apps/api/prisma/schema.prisma                        + NotifyChannel, NotifyOutbox, NotifyState
apps/api/prisma/migrations/20261101120000_add_notifications/migration.sql
apps/api/src/lib/notify/types.ts                     kinds, severities, events, records
apps/api/src/lib/notify/ssrf.ts                      URL rules, address classes, guarded send
apps/api/src/lib/notify/render.ts                    message limits, scrubbing, group/digest/brake messages
apps/api/src/lib/notify/adapters/{discord,slack,teams,ntfy,gotify,telegram,webhook,index}.ts
apps/api/src/lib/notify/secrets.ts                   vault items, locked-channels file, masks
apps/api/src/lib/notify/store.ts                     NotifyStore: Memory + Prisma
apps/api/src/lib/notify/bus.ts                       publish(): filters, outbox rows
apps/api/src/lib/notify/dispatcher.ts                quiet hours, grouping, brake, retries, digests
apps/api/src/lib/notify/migrate.ts                   seeding + legacy fallback channels
apps/api/src/lib/notify/service.ts                   channel CRUD, Send test, wiring, singleton publish()
apps/api/src/routes/notify.ts                        /api/settings/notifications/*
apps/api/src/lib/vault/lock-alert.ts                 delivery via notify; rendering via shared adapters
apps/api/src/lib/updates/runner.ts                   publish() replaces sendReport()/defaultNotify()
apps/api/src/lib/certs/{alerts,modules,service}.ts   publish() replaces sendWebhook()
apps/api/src/lib/credentials.ts                      + deleteProviderCredentials()
apps/api/src/routes/auth.ts, src/index.ts            wiring
apps/frontend/app/settings/notifications/page.tsx    the page; link on Settings
docs/notifications.md, docs/security.md, docs/updates.md, docs/certificates.md, config/*.example.yaml, install.sh
```

## Interfaces

```ts
// types.ts
export type ChannelKind = 'discord' | 'slack' | 'teams' | 'ntfy' | 'gotify' | 'telegram' | 'webhook'
export type Severity = 'info' | 'warning' | 'critical'
export type Family = 'vault' | 'updates' | 'certs' | 'jobs' | 'backups' | 'resources'
export interface QuietHours { start: string; end: string; tz?: string; days?: number[]; criticalBreaksThrough: boolean }
export interface NotifyEventInput {
  type: string; severity: Severity; title: string; lines?: string[]
  link?: string | null            // absolute URL, or an app path joined to HYPERPROX_PUBLIC_URL
  linkLabel?: string; where?: string; subject?: { kind: string; name: string }
  fingerprint?: string; resolved?: boolean; at?: Date
}
export interface NotifyMessage { id; type; severity; resolved; title; lines: string[]; link: string | null;
  linkLabel; where; subject?; fingerprint?; at: string }          // scrubbed, limits applied
export interface ChannelSecret { url?: string; token?: string; botToken?: string; signingSecret?: string }
export interface ChannelRecord { id; name; kind; enabled; minSeverity; eventFilter: 'all' | Family[];
  quietHours: QuietHours | null; lanOverride; usableWhileLocked; nonSecret: { chatId?: string };
  lastResult: DeliveryResult | null; lastSentAt; failingSince; seededFrom: string | null; createdBy; createdAt; updatedAt }
export interface DeliveryResult { ok: boolean; status?: number; code?: string; retryAfterSec?: number; at: string }

// ssrf.ts
export function checkChannelUrl(kind, url, lanOverride): { ok: true } | { ok: false; reason: string }
export function classifyAddress(ip): 'public' | 'private' | 'loopback' | 'blocked'
export function guardedSend(req: OutboundRequest, o: GuardOptions): Promise<SendOutcome>  // resolve, check, pin, no redirects, 1 KB, 10 s

// adapters/index.ts
export function buildRequest(kind, secret, nonSecret, msg: NotifyMessage): OutboundRequest
export function detectKind(url): ChannelKind

// bus.ts / service.ts
export function publish(e: NotifyEventInput): Promise<void>        // the only way anything sends
export class NotifyService { listChannels(); createChannel(input, actor); updateChannel(id, input, actor);
  deleteChannel(id, actor); testChannel(id, actor); deliveries(channelId?); deliverLocked(e) }
export class Dispatcher { tick(now?): Promise<void>; kick(): void }
```

## Tasks

1. **Schema + store** — Prisma models, migration SQL, `MemoryNotifyStore`/`PrismaNotifyStore`.
   Tests: `notify-store.test.ts` — `due rows by status and time`, `sent rows per channel since`, `prune keeps 30 days`.
2. **SSRF guard** — `notify-ssrf.test.ts`: `link-local refused even with the override`,
   `loopback and RFC 1918 need the self-hosted switch`, `own service ports refused on loopback`,
   `pinned hosts per kind`, `http only with the override`, `checked at send time (DNS rebinding)`,
   `a 302 is a failure and is not followed`, `response read only up to 1 KB`.
3. **Render + adapters** — `notify-render.test.ts`: `title at most 60 characters`, `two or three lines, body
   under 400`, `URLs and tokens scrubbed`, `grouped message caps at five lines`, `digest caps at ten lines`.
   `notify-adapters.test.ts`: `exact body per kind` (all seven), `Discord embed within 4096`, `no mention can
   ping`, `severity colour or word`, `webhook signature`, `telegram token only in the URL path`.
4. **Secrets** — `notify-secrets.test.ts`: `locked file is 0600 and written atomically`, `vault item named
   hyperprox:notify/<id>`, `mask shows host and last four only`, `moving a secret between vault and file`.
5. **Bus + dispatcher** — `notify-dispatcher.test.ts`: `severity and family filters`, `quiet hours hold a
   warning and digest it at the end`, `fired and resolved inside quiet hours is dropped`, `critical breaks
   through`, `20 events: at most 6 messages plus one brake`, `grouped within 60 s`, `retries 10 s, 1 min,
   5 min then failed`, `429 honours Retry-After`, `4xx fails at once and the other channels hear about it`,
   `held while locked, one digest on unlock, older than 24 h dropped`, `a new dispatcher picks up queued rows`.
6. **Migration** — `notify-migrate.test.ts`: `lock channel seeded once from LOCK_ALERT_*`, `the YAML webhook the
   lock alert fell back to is seeded usable-while-locked`, `owner unlock seeds Updates and Certificates once`,
   `one URL behind both becomes one channel`, `legacy settings still deliver until seeded`, `idle lock with
   Postgres down reaches the seeded channel and no vault-only channel`, `no secret in logs, outbox or audit`.
7. **Publishers** — runner `publish` dep (`updates-runner.test.ts`: `a finished run publishes one event with
   severity from its steps`), certs service `publish` dep (`certs-service.test.ts` reworked), lock alert
   (`vault-lock-alert.test.ts` adapted: same rendering rules through the shared adapters).
8. **Routes** — `notify-routes.test.ts`: `non-admin 403 on every route`, `admin who is not owner cannot set
   usable-while-locked`, `create/edit/delete/test audited without secrets`, `responses carry masks only`.
9. **Frontend** — Settings → Notifications page and link; `tsc --noEmit` for the frontend.
10. **Docs** — `docs/notifications.md`; security/updates/certificates docs and example YAMLs say where the
    settings now live; `install.sh` stops adding `LOCK_ALERT_*`.

Gate for every commit: `pnpm --filter @hyperprox/api test`, `test:scenarios`, `npx tsc --noEmit` (api and
frontend). No real webhook is ever called: tests use fake transports and a local receiver.
