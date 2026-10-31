# Notifications and Alerts — design

Status: design, 2026-10-31. Not yet planned or built.

## Why

HyperProx already sends messages from three places, each written separately:

| Today | Where | Channel config | Format |
|---|---|---|---|
| Lock alert | `lib/vault/lock-alert.ts` | `LOCK_ALERT_URL` / `_KIND` / `_TOKEN` in `.env`; falls back to the Updates or Certificates `webhook_url` | ntfy, Gotify, Discord, generic webhook |
| Updates report | `lib/updates/runner.ts` `sendReport()` | `notify.webhook_url` in `config/updates.yaml` | `{"content": ...}` sliced to 1900 chars |
| Certificate alerts | `lib/certs/alerts.ts` | `alerts.webhook_url` in `config/certs.yaml` | `{"content": ...}`, whole lines up to 2000 chars, change-only plus a daily critical reminder |

Meanwhile Prometheus evaluates its own alert rules (`config/prometheus/rules/cluster.yml`: node down, CPU,
memory, root disk, Ceph health, OSD down, pool usage, GPU) and nobody is told: there is no Alertmanager, and
the rules only show on the Monitoring page's Alerts tab.

The request: users enter their own webhook, and HyperProx tells them when something on the cluster needs
attention — space, CPU, RAM and the like. The person reading is often away from a screen: a phone
notification, a watch, or a message read aloud by a voice assistant. So every message must make sense from
its title alone, be short, and arrive rarely enough that it is still read.

This design replaces the three senders with one: a set of **channels** the user configures, an **event bus**
every feature publishes to, and a **rule engine** that turns cluster facts into alerts. It is not a fourth
parallel sender; the existing three are migrated onto it (Phase 1) and their own sending code is removed.

## Goals

- Settings → Notifications: add any number of channels (Discord, Slack, Microsoft Teams, ntfy, Gotify,
  Telegram, email, generic JSON webhook), each with a severity filter, quiet hours and a Send test button.
- Secrets (webhook URLs, tokens, passwords) live in the vault, are masked in the UI and never logged.
- One event bus: vault lock, updates, certificates, wizard and catalogue jobs, backups and resource alerts
  all publish to it; delivery, filtering, grouping and retries happen in one place.
- Resource rules with sensible defaults, durations, hysteresis, cooldowns and a "resolved" message.
- Known, accepted conditions can be muted with a reason, so a standing state never nags.
- Messages a person can take in from a lock screen: one line of title, two or three short lines, a link.
- Lock alerts keep firing while HyperProx is locked, and resource alerts keep working while locked when the
  monitoring profile is installed.

## Non-goals

- Acting on an alert. Alerts inform; the Smart Suggestion Engine (ROADMAP) may later offer an action, and
  the user confirms it there. Nothing here changes the cluster.
- Replacing Grafana or the Monitoring page. They stay the place for graphs and history.
- Alertmanager. HyperProx owns routing, quiet hours and mutes because the UI has to edit them.
- Changing cluster-side settings such as `ceph health mute` or PVE's notification config. A HyperProx mute
  only affects HyperProx.
- Plug-in provided channel kinds (see Open decisions).

## Concepts

- **Event**: something that happened. `{ type, severity, subject, title, lines[], link, fingerprint, at }`.
  Types are dotted: `vault.locked`, `updates.job.finished`, `certs.verdict.changed`,
  `wizard.job.finished`, `catalogue.install.finished`, `backup.job.failed`, `alert.firing`,
  `alert.resolved`, `notify.channel.failing`.
- **Severity**: `info`, `warning`, `critical`. `resolved` is not a severity; it carries the severity of the
  alert it closes, so a channel that only takes critical also gets the "resolved" for a critical.
- **Alert**: a condition with state (`pending` → `firing` → `resolved`), produced by a rule. Each alert has a
  stable fingerprint (`rule + subject`, e.g. `storage.fill:node-a/local-lvm`), so it is announced once,
  not once per evaluation.
- **Rule**: how a cluster fact becomes an alert: metric, scope, thresholds, duration, hysteresis, cooldown.
- **Mute**: a standing exception with a reason: this rule (or this Ceph health code) on this subject does
  not notify.
- **Channel**: a destination with a kind, a secret, a minimum severity, an event filter and quiet hours.

## 1. Channels

### Kinds

| Kind | Secret | Non-secret fields | Severity colour | Notes |
|---|---|---|---|---|
| Discord | webhook URL | — | embed colour | `allowed_mentions: {parse: []}` always, so no name or error text can ping a channel. Host must be `discord.com` / `discordapp.com`, path `/api/webhooks/`. |
| Slack | incoming-webhook URL | — | attachment `color` | Host must be `hooks.slack.com`. |
| Microsoft Teams | Workflows webhook URL | — | Adaptive Card container style (`attention` / `warning` / `good`) | The old Office 365 connector webhooks are retired; Teams now takes a "When a Teams webhook request is received" Workflows URL with an Adaptive Card body. |
| ntfy | topic URL, optional access token | — | priority (5 critical, 4 warning, 3 info) and tags | `Click` header and a `view` action to the HyperProx page, as the lock alert already does. |
| Gotify | `/message` URL, app token | — | priority (8 / 5 / 2) | `client::notification.click.url` for the link. |
| Telegram | bot token | chat id | none: the title starts with the severity word | `https://api.telegram.org/bot<token>/sendMessage`, plain text, `disable_web_page_preview`. The token is in the URL path, which is one more reason no URL is ever logged. |
| Email (SMTP, optional) | SMTP password | host, port, user, from, to | subject prefix `[Critical]` etc. | STARTTLS or implicit TLS required unless the LAN override is on. Phase 4. |
| Generic webhook | URL, optional signing secret | — | `severity` field | Documented JSON payload below. |

Auto-detect from a pasted URL (the existing `detectKind()` extended), but the user can always pick the kind.

### Storage of secrets

- Each channel is a row in `NotifyChannel` (non-secret fields) and one vault Secure Note
  `hyperprox:notify/<channelId>` with hidden fields `url`, `token`, `bot_token`, `smtp_password`,
  `signing_secret` as applicable — the same pattern `lib/credentials.ts` uses. Writes go to the vault as the
  signed-in user; reads come from the unlock cache.
- The UI shows a mask: host plus the last four characters (`discord.com/…/••••3f9a`, `ntfy.example.com/••••`).
  The full value is never sent back to the browser; editing replaces it.
- Logs and the delivery table record channel id, kind, HTTP status and an error *code* (`ECONNREFUSED`,
  `TimeoutError`) — never the URL, never a response body, never an exception message (fetch errors can
  carry the URL). This follows what `sendLockAlert()` already does.
- `AuditLog` gets create / edit / delete / test entries with the channel name and kind only.

### Usable while locked

A channel stored in the vault cannot be read while HyperProx is locked. Lock alerts exist precisely for that
moment, and resource alerts can also fire while locked (see Data sources). So a channel can be marked
**usable while locked**:

- Its secret is then stored **outside the vault** in `data/notify-locked-channels.json`, mode `0600`, owned
  by the API's service user, written atomically, git-ignored. The vault copy is removed so there is one
  source of truth.
- **Trade-off, stated in the UI when the toggle is turned on:** anyone who can read that file (root on the
  HyperProx host, or a copy of its disk or backups) can post to that channel. This is the same exception the
  lock alert and the metrics token already make, and it is why the toggle is per channel and off by default.
- Allowed kinds: ntfy, Gotify, Discord, Slack, Teams, generic webhook — for each of these the secret is a
  send-only capability, so a leak means someone can post to that one channel.
- Telegram is allowed with a stronger warning: a bot token controls the whole bot, not one chat.
- Email is not allowed: an SMTP password is usually a mailbox password.
- Turning it on needs the **owner** role (it takes a secret out of the vault). Everything else on the page
  is admin.

### Severity filter, event filter and quiet hours

- **Minimum severity** per channel (default `warning`). Info events (an updates run finished cleanly) go
  only to channels set to `info`.
- **Event filter**: all events (default), or a chosen set of event families (`vault`, `updates`, `certs`,
  `jobs`, `backups`, `resources`). The seeded lock channel subscribes to `vault` only.
- **Quiet hours** per channel: start, end, time zone (default the server's), days. During quiet hours:
  - critical breaks through (per-channel toggle, default on);
  - everything else is held; at the end of quiet hours one digest is sent with what is **still firing**;
    anything that fired and resolved inside the window is dropped, because nothing is left to do;
  - "resolved" messages for alerts announced before quiet hours are held into the same digest.
- **Rate brake** per channel: at most 6 messages in 10 minutes; past that, one message "Many alerts at once —
  open HyperProx" and silence on that channel until the window clears. A storm must never become 50
  notifications on a watch.

### Send test

`POST /api/settings/notifications/channels/:id/test` sends a real message through the same adapter:
title "HyperProx test", one line "If you can read this, alerts to <channel name> work.", the link. The UI shows
the outcome as the receiver reported it (`Delivered (HTTP 204)` / `Refused: HTTP 401` / `Could not connect`),
and records it as the channel's last result. A test is also offered right after saving.

### SSRF guard

The API sits next to things that must not be reachable by a user-supplied URL: Prometheus on the host
network with `--web.enable-lifecycle` (a `POST /-/quit` shuts it down), Ollama with no authentication,
Grafana, Postgres, the API itself, and on a cloud host the metadata service.

- Only admins can add or edit channels (routes under `/api/settings/notifications`, which `roles.ts`
  already makes admin-only).
- Schemes: `https:` only, `http:` only with the LAN override.
- The host is resolved **at send time** and every resolved address is checked (a hostname that resolves to a
  public address when saved and to loopback later is DNS rebinding); the request goes to the checked address
  with the original `Host`/SNI.
- Always blocked: link-local (`169.254.0.0/16`, `fe80::/10` — cloud metadata lives there and no
  notification service does), `0.0.0.0/8`, `::`, multicast, broadcast.
- Blocked unless the channel's **"Self-hosted on my network"** override is on: loopback (`127.0.0.0/8`,
  `::1`), RFC 1918, CGNAT `100.64.0.0/10` (VPN overlays), ULA `fc00::/7`. The override is offered only for
  ntfy, Gotify and generic webhook, because those are the kinds people self-host on the LAN; Discord, Slack,
  Teams and Telegram are pinned to their public hosts anyway. The UI note: *"Allows a private address. Only
  use this for a notification server you run yourself; HyperProx will send to whatever answers there."*
- Even with the override, loopback is refused on HyperProx's own service ports (API, Prometheus, pve-exporter,
  Grafana, Ollama, Postgres, as configured), so a self-hosted ntfy on the same host works and the
  Prometheus lifecycle endpoint does not.
- Redirects are not followed (`redirect: 'manual'`; a 3xx is reported as a failure).
- Response bodies are read only up to 1 KB, and only to recognise known errors; never stored or shown.
- 10 s timeout per request.

## 2. Events and rules

### The event bus

`lib/notify/bus.ts`: `publish(event)` is the only way anything sends a message. It:

1. drops the event if a mute matches;
2. writes it to the `NotifyOutbox` table, one row per matching channel (severity and event filters applied);
3. hands the rows to the dispatcher, which applies quiet hours, grouping and the rate brake, renders per
   channel kind, sends, and records the result.

Publishers (Phase 1 unless noted):

| Publisher | Events | Replaces |
|---|---|---|
| Vault (`lock-alert.ts`) | `vault.locked` (critical) | its own sender; see Lock-alert migration |
| Updates runner | `updates.job.finished` (info if all ok, warning if anything failed or skipped for a gate, critical if a node update failed), `updates.reboot.pending` (info) | `sendReport()` / `defaultNotify()` |
| Certificates | `certs.verdict.changed`, `certs.still.critical` | `sendWebhook()`; `alertChanges()` stays as the change detector |
| Wizard executor | `wizard.job.finished` (failed → warning) | — (Phase 3) |
| Catalogue installer | `catalogue.install.finished` (failed → warning) | — (Phase 3). Its jobs are in memory only today, so the event is published at the moment of finishing, not reconstructed after a restart. |
| Backups | `backup.job.failed`, `backup.guest.uncovered` | — (Phase 3) |
| Rule engine | `alert.firing`, `alert.resolved` | — (Phase 2) |
| Dispatcher | `notify.channel.failing` | — |

A channel that is failing is not told about it by itself: `notify.channel.failing` goes to the *other*
channels and to the dashboard, so a broken channel is visible somewhere that works.

### Resource and state rules

Defaults are chosen so that a fresh install with nothing tuned stays quiet on a healthy cluster.
"Clear" is the hysteresis: the alert resolves only once the value is back past the clear level **and** stays
there for the clear duration.

| Rule | Subject | Warning | Critical | For | Clear | Default |
|---|---|---|---|---|---|---|
| Node CPU | node | 90% | — | 15 min | < 80% for 5 min | on |
| Node RAM | node | 90% | 97% | 10 min / 5 min | < 85% for 5 min | on |
| Node root disk | node | 85% | 95% | 5 min | < 80% | on |
| Guest CPU | guest | 95% | — | 30 min | < 85% | **off** (transcoders and builds run hot by design) |
| Guest RAM | guest | 95% | — | 15 min | < 90% | **off** (guest page cache makes this noisy); on per guest |
| Guest root disk | guest | 90% | 97% | 10 min | < 85% | on |
| Storage fill (rbd, cephfs, lvmthin, dir, zfs, nfs, cifs, pbs) | storage per node, or once for shared storage | 80% | 90% | 10 min | < 75% | on |
| Ceph health | cluster, per health-check code | `HEALTH_WARN` for 15 min | `HEALTH_ERR` for 2 min | — | code gone for 5 min | on |
| OSD down | OSD | — | down 2 min | — | up 5 min | on |
| OSD out | OSD | out 5 min | — | — | in | on |
| Node offline | node | — | not in cluster / quorum 2 min | — | back 2 min | on |
| Monitoring can't reach node | node | node_exporter scrape failing 5 min while the node is online | — | — | scrape ok 5 min | on |
| Guest stopped unexpectedly | guest | non-HA guest stopped without a stop task | HA guest stopped, HA state `error` or `fence` | 2 min | running again | on |
| HA recovery | guest | — | — | — | — | info: "moved from node-a to node-b by HA" |
| Network mount unreachable | storage per node (nfs, cifs, pbs) | inactive 2 min | — | — | active 2 min | on |
| Backup job failed | backup job | — | job ended with an error | — | next run of that job OK | on |
| Guest not backed up | guest | in no backup job | — | daily check | covered | **off** (many homelabs leave scratch guests out on purpose) |
| HyperProx can't read metrics | HyperProx | Prometheus unreachable 5 min | — | — | reachable | on |

Rules for people, not just thresholds:

- **Storage fill uses the right number.** For Ceph pools, `percent_used` (which accounts for replication
  and the fullest OSD), not raw bytes over raw size. The message says which: "pool 82% full".
- **Ceph health is per check code**, not per overall status. `HEALTH_WARN` caused by one muted code and
  nothing else is not an alert. A new code appearing while another is muted is.
- **Node offline suppresses its children.** While a node is offline, alerts for guests, OSDs, storage and
  mounts on that node are folded into the node alert ("node-a offline — 9 guests, 4 OSDs affected") instead
  of firing separately. When it comes back, one "resolved" covers the lot; anything still wrong afterwards
  fires on its own after its normal duration.
- **Monitoring can't reach node is not node offline.** A hung network mount can make node_exporter time out
  while the node is fine (see ROADMAP, Network Storage Health). Node offline is decided from cluster
  membership (PVE), never from a scrape. When a scrape fails and a mount on that node is unreachable, the
  message names the mount as the likely cause.
- **Stopped is unexpected only when nobody asked.** A guest that stops after a stop/shutdown task by a user,
  by HyperProx (updates, wizard, power actions) or by a backup in stop mode is not an alert. Templates are
  never subjects. A guest can be marked "usually stopped" (a mute with that reason) — a lab VM someone
  starts when they want it.
- **Backup failures are grouped by job.** A job that fails on five nodes because of one bad guest id is one
  alert ("Daily backup failed on 5 nodes"), not five, and names the failing guest when the task log does.

### Durations, hysteresis, cooldown, resolved

- **Duration** ("over 90% for 10 min"): for Prometheus-backed rules it is part of the query
  (`min_over_time(<expr>[10m]) > 90`), so it uses Prometheus's own history and an API restart does not
  reset the clock. For PVE-polled rules, `pendingSince` is stored on the alert row.
- **Hysteresis**: separate clear level and clear duration per rule (table above). A value hovering around
  the threshold produces one alert, not a flapping pair every few minutes.
- **Escalation**: warning → critical for the same fingerprint is one new message ("now critical"); critical →
  warning is not announced (the resolve will be).
- **Cooldown** (default 6 h per fingerprint): an alert that resolves and fires again inside the cooldown is
  not re-announced; its state is updated and the next message, if any, says "fired 3 times since 14:00".
- **Reminders**: critical alerts still firing get one reminder per 24 h (the certificates pattern, with the
  same 20-hour slack). Warnings get no reminders.
- **Resolved message**: always sent for an alert that was announced, to the channels that got the alert
  (subject to their quiet hours), with how long it lasted. An alert never announced (muted, or held and
  resolved within quiet hours) never sends a resolve.

### Mutes

- A mute matches a rule, optionally a subject, and for Ceph health optionally a health-check code (e.g. the
  "pool has no replicas" notice for a pool that is single-copy on purpose).
- Each mute has a required **reason**, who created it, when, and an optional expiry.
- A mute stops notification only. The alert still exists and shows on the Alerts page greyed, with the
  reason, so the state stays visible to someone looking.
- A mute does not cover a worse state: a mute on "storage fill warning" for a pool does not silence its
  critical; a mute on one Ceph health code does not silence another.
- An alert can be muted straight from its Alerts page row ("Mute… why?").
- Expired mutes are kept in history; an alert that was muted and is still firing when its mute expires is
  announced as new.

### Data sources

**Recommendation: Prometheus first for numbers, the PVE API for state and events, and PVE's own
notification webhook for backups.**

- **Prometheus** (node_exporter, pve-exporter, the Ceph mgr exporter, already in `docker-compose.yml`
  under the `monitoring` profile) for CPU, RAM, disk, storage fill, Ceph health codes, OSD up/in and scrape
  health. Why:
  - it already collects all of it, so alerting adds one instant query per rule per minute, not new polling
    load on the cluster;
  - durations come from its history, which survives HyperProx restarts;
  - **it keeps working while HyperProx is locked**: pve-exporter authenticates with its own token in
    `config/pve-exporter/pve.yml`, not with the vault-held Proxmox token, which is unavailable while locked
    (`pveFromEnv()` throws). This is the only way resource alerts can fire while locked.
- **PVE API** (through the existing client, while unlocked) for what Prometheus does not know: cluster
  membership and quorum, HA resource state, task history (who stopped a guest, how a backup ended), storage
  `active` flags, backup coverage (`/cluster/backup-info/not-backed-up`). The evaluator reads the same
  snapshots the dashboard broadcast (`ws-broadcast.ts`, fast 2 s / slow 15 s) already collects, through a
  shared cache, rather than polling a second time.
- **PVE notification webhook** for backup results and fencing. PVE can send its own notifications to a
  webhook target; pointing one at `POST /api/notify/ingest/pve` (authenticated with a dedicated ingest
  token kept outside the vault, like `METRICS_TOKEN`) means backup failures arrive even while HyperProx is
  locked, and HyperProx keeps only the job, node, guest and status — it never forwards the backup log. This
  is the fix for the known overflow: a full VM backup log is longer than Discord's 4096-character embed
  limit, so a forwarded log makes the whole message fail.

Behaviour by situation:

| Situation | Resource rules | State rules (HA, stopped guests, mounts) | Backups |
|---|---|---|---|
| Unlocked, monitoring profile installed | Prometheus | PVE API | PVE webhook, else task-log poll |
| Locked, monitoring installed | Prometheus | Prometheus where it has the fact (`pve_up` for guests and nodes), cause marked "unknown while locked" | PVE webhook only |
| Unlocked, no monitoring profile | PVE API polling (`/cluster/resources`), durations from stored `pendingSince` | PVE API | PVE webhook, else task-log poll |
| Locked, no monitoring profile | paused | paused | PVE webhook only |

When evaluation is paused, the Notifications page and the dashboard say so in one line: *"Resource alerts
pause while HyperProx is locked. Install the monitoring profile to keep them running."* On unlock, the task
log is read back to the last seen task, so a backup that failed while locked is still reported (once).

The existing `cluster.yml` Prometheus rules stay for the Monitoring page and Grafana, but they are not a
notification source (two engines would announce the same disk twice). Their thresholds are aligned with the
defaults above so the two pages agree.

## 3. Message format

Every message is the same three parts, whatever the channel:

```
Disk almost full on node-a                     <- title, at most 60 characters, makes sense alone
Root disk 93% full; warning level is 85%.      <- line 1: what, with the number
Over 85% for 12 minutes.                       <- line 2: how long / what changed
Open: https://hyperprox.example.com/storage    <- link to the page that shows it
```

Rules:

- **Title first, plain words, names not ids**: "Container media-01 stopped", not "lxc/105 pve_up=0".
  The title is what a watch or a voice assistant reads; it must stand on its own.
- **Two or three lines**, each under 100 characters; whole body under 400 characters. Numbers rounded
  ("93%", "1.2 TB free"), durations in words ("12 minutes").
- **Severity**: colour where the channel has one (critical red, warning amber, info blue, resolved green),
  otherwise the first word of the title ("Critical: ...") for Telegram, email and the generic webhook's
  `content`/`text`.
- **Link** to the relevant page (Storage, Alerts with the alert selected, Updates job, Certificates), built
  from `HYPERPROX_PUBLIC_URL`. Without it, the message says where to look ("Storage page") instead of a link.
- **Never** a secret, token, session, URL with credentials, full log, stack trace or raw error body. Error
  text from a remote system is cut to one sentence and stripped of anything URL- or token-shaped.
- **Resolved**: "Resolved: Disk almost full on node-a" / "Back to 78%. Lasted 2 hours 10 minutes."
- **Plain language for home users**: no "PG", "OSD", "rbd" in titles; the line can carry the technical
  word in brackets ("A storage disk is down (OSD 4)").

### Grouping and digests

- **Grouping window**: alerts that fire within 60 s of each other for the same channel are sent as one
  message: "3 new alerts" / three one-line titles / "and 2 more — open Alerts". At most 5 lines.
- **Dependency folding**: node offline absorbs its children (above).
- **Quiet-hours digest** and the **unlock digest** (alerts held for vault-only channels while locked, see
  below) use the same format, at most 10 lines, still-firing first.
- **Per-channel limits** are a backstop, not the design: Discord `content` 2000 characters (embed
  description 4096), Telegram 4096, ntfy 4096 bytes. The renderer cuts whole lines with "and N more", as
  `webhookBody()` does today.

### Generic webhook payload (documented)

```json
{
  "version": 1,
  "id": "evt_01J...",
  "type": "alert.firing",
  "event": "resources.disk.root",
  "severity": "warning",
  "title": "Disk almost full on node-a",
  "lines": ["Root disk 93% full; warning level is 85%.", "Over 85% for 12 minutes."],
  "subject": { "kind": "node", "name": "node-a" },
  "value": 93.1,
  "threshold": 85,
  "since": "2026-10-31T14:02:00Z",
  "at": "2026-10-31T14:14:00Z",
  "url": "https://hyperprox.example.com/storage",
  "fingerprint": "disk.root:node-a",
  "content": "Disk almost full on node-a: Root disk 93% full ...",
  "text": "Disk almost full on node-a: Root disk 93% full ..."
}
```

`content` and `text` are there so Discord-compatible and Slack-compatible receivers work without a
transform, as the lock alert's webhook body does today. With a signing secret set, the request carries
`X-HyperProx-Timestamp` and `X-HyperProx-Signature: sha256=<HMAC of timestamp + "." + body>`; receivers
should reject timestamps older than 5 minutes. The payload version is bumped only for breaking changes.

## 4. Lock-alert migration

- **Seeding** (first start of the new version, no unlock needed): if `LOCK_ALERT_URL` is set, create a
  channel "Lock alerts" of `LOCK_ALERT_KIND` (or detected kind) with `LOCK_ALERT_TOKEN`, **usable while
  locked**, event filter `vault`, minimum severity `critical`. Its secret goes straight to
  `data/notify-locked-channels.json`; it never needed to be in the vault and still must not be.
- If `LOCK_ALERT_URL` is empty but the lock alert was falling back to the Updates or Certificates
  `webhook_url`, that address is seeded the same way (usable while locked): it was already readable while
  locked as plain YAML, so this changes nothing about its exposure.
- The Updates and Certificates `webhook_url`s become channels at the **first owner unlock** (their secrets
  go to the vault, as the credential migration `seedFromEnv()` does), subscribed to `updates` and `certs`
  respectively, minimum severity `info` for Updates (it was a report of every run) and `warning` for
  Certificates. If the same URL backs several of these, it becomes one channel with the union of filters,
  so nobody gets the same message twice.
- After seeding, the `.env` keys and YAML keys are **ignored** and the policy loaders log one line saying so
  and where the channel now lives. `install.sh` stops adding `LOCK_ALERT_*`. `docs/security.md` and the
  example YAMLs are updated in the same change. The keys are removed from the parsers one release later.
- **Lock alerts do not depend on Postgres or the vault.** `vault.locked` is delivered directly from memory
  and `data/notify-locked-channels.json` to the usable-while-locked channels, then logged to the outbox
  table best-effort. The 10-second de-duplication, the manual-lock and restart-reason logic and the
  "was unlocked" marker in `lock-alert.ts` are kept as they are; only `buildAlert()`'s per-kind rendering
  moves into the shared adapters.
- **Alerts while locked for vault-only channels**: they cannot be sent (their secret is unreadable). They
  stay in the outbox as `held-locked`; on unlock, each such channel gets one digest of what is still
  firing plus a count of what came and went. Held rows older than 24 h are dropped.

## 5. Where it lives

**Recommendation: core**, in `apps/api/src/lib/notify/` with routes in `apps/api/src/routes/notify.ts`, not a
plug-in. Reasons:

- The lock alert is part of the vault gate and must work with no plug-in loaded.
- Delivering needs secrets and must run while locked. The plug-in host's whole boundary is that plug-ins
  never see a credential (`lib/plugin-host.ts`); a notifier plug-in would need exactly that.
- Every core feature publishes to it; core cannot depend on an optional plug-in for its own alerts.

Plug-ins get a narrow, later hook (Phase 4): a manifest may declare event types, and the host exposes
`publish({ type, severity, title, lines })` with the plug-in's id prefixed to the type and the rate brake
applied. Plug-ins publish; they never deliver, and never see a channel.

Layout:

```
lib/notify/
  bus.ts          publish(), mute matching, outbox write
  dispatcher.ts   quiet hours, grouping, rate brake, retries, delivery log
  render.ts       title + lines + link -> per-kind body, length limits, secret scrubbing
  adapters/       discord.ts slack.ts teams.ts ntfy.ts gotify.ts telegram.ts email.ts webhook.ts
  ssrf.ts         URL and resolved-address checks
  secrets.ts      vault Secure Notes + the locked-channels file
  rules/          defaults.ts, prometheus.ts (PromQL per rule), pve.ts (state rules), evaluate.ts
  ingest-pve.ts   the PVE notification webhook receiver
frontend: app/settings/notifications/page.tsx (channels, rules, mutes), app/alerts/page.tsx (active + history)
```

The Settings page gets a "Notifications" link beside "Secrets" and "API tokens". The dashboard gets a small
active-alerts strip (count by severity, worst title) from the same alert table.

### Storage (Prisma)

| Table | Holds | Notes |
|---|---|---|
| `NotifyChannel` | id, name, kind, enabled, minSeverity, eventFilter (json), quietHours (json), lanOverride, usableWhileLocked, nonSecret (json: chat id, SMTP host…), lastResult, lastSentAt, failingSince, createdBy | no secrets |
| `NotifyRule` | id, kind, scope (json selector), warn, crit, forSec, clearAt, clearForSec, cooldownSec, enabled, builtIn | defaults seeded as `builtIn`; the user edits values, can reset to default |
| `NotifyMute` | id, ruleId, subject?, code?, reason, createdBy, createdAt, expiresAt? | |
| `NotifyAlert` | fingerprint (unique), ruleId, subject, severity, state, pendingSince, firingSince, lastValue, lastNotifiedAt, notifiedSeverity, fireCount, resolvedAt, mutedBy? | the state the evaluator carries between ticks and restarts |
| `NotifyOutbox` | id, eventId, channelId, payload (json, already scrubbed), status (`queued`, `held-quiet`, `held-locked`, `sent`, `failed`, `dropped`), attempts, nextAttemptAt, httpStatus, errorCode, createdAt, sentAt | also the delivery history; rows older than 30 days pruned |

### The evaluation loop

- One scheduler in the API process: rules evaluated every 60 s; events are dispatched as they are published.
- A Postgres advisory lock (or a row in the existing lock pattern, cf. `UpdateLock`) makes evaluation
  single-runner if a second API process ever runs.
- Each tick: query sources → compute per-fingerprint value → apply duration and hysteresis against the stored
  `NotifyAlert` → publish only on state changes, escalations and due reminders.
- Dispatcher retries: 10 s, 1 min, 5 min, then `failed`. A `429` honours `Retry-After`. Any other `4xx`
  does not retry (it is configuration, not luck) and marks the channel failing.

### Surviving API restarts

- Alert state is in `NotifyAlert`, so a restart does not re-announce anything already announced, and does
  not lose a resolve that is owed. The first tick after a restart compares against the stored state, never
  against nothing (the certificates module's rule: with no saved state, the current state is the baseline
  and is not announced).
- Prometheus-backed durations come from range queries, so a restart in the middle of "for 10 minutes" does
  not start the 10 minutes again.
- Queued and retrying outbox rows are picked up again. A queued "firing" for an alert that has since
  resolved is dropped with its resolve, so a restart never produces a stale alarm.
- The API restarting is itself not an alert; the lock alert already covers the case where a restart locked
  HyperProx.

## 6. Phases and acceptance tests

### Phase 1 — Channels, bus, migration

Settings → Notifications with all kinds except email; vault secrets and the locked-channels file; masks;
SSRF guard; Send test; minimum severity and event filters; quiet hours; rate brake; outbox and retries;
Updates, Certificates and the lock alert publishing to the bus; seeding from `.env` and YAML; their old
senders removed.

Acceptance:

- A Discord, Slack, Teams, ntfy, Gotify, Telegram and generic-webhook channel each receive a Send test,
  verified against a fake receiver that checks the exact body per kind.
- With `LOCK_ALERT_URL` set and nothing else, after upgrade an idle lock delivers one message to the seeded
  channel **with Postgres stopped**, and nothing to vault-only channels.
- An Updates run and a certificate verdict change each produce exactly one message per subscribed channel;
  a URL that backed both is one channel and gets each message once.
- No log line, API response, outbox row or audit entry contains a channel URL or token (grep over a test
  run's logs and DB dump for the test secrets returns nothing).
- SSRF: `http://127.0.0.1:9090/-/quit`, `http://169.254.169.254/`, a hostname resolving to `10.0.0.5`, and
  a public URL that 302s to loopback are all refused; the same private address is accepted for an ntfy
  channel with the override on; link-local is refused even with it on.
- A non-admin gets 403 on every channel route; an admin who is not owner cannot set usable-while-locked.
- Quiet hours: a warning inside the window is held and arrives in the end-of-window digest only if still
  firing; a critical breaks through.
- 20 events in one minute to one channel produce at most 6 messages plus one "many alerts" message.

### Phase 2 — Resource rules from Prometheus

Rule engine, defaults, durations, hysteresis, escalation, cooldown, reminders, resolve messages, mutes
(including Ceph health codes), grouping window, node-offline folding, the "can't read metrics" rule, the
Alerts page and dashboard strip, the locked/no-monitoring banner.

Acceptance (against a fake Prometheus serving recorded series):

- A root disk at 92% for 4 minutes sends nothing; at 5 minutes one warning; at 96% one "now critical";
  oscillating 84–86% after that sends nothing; staying under 80% for the clear duration sends one resolve.
- Restarting the API mid-duration and mid-alert neither repeats the alert nor loses the resolve.
- A Ceph `HEALTH_WARN` whose only code is muted sends nothing; a second code appearing sends one warning
  naming that code; the muted alert shows greyed with its reason on the Alerts page.
- A node going offline with 9 guests sends one message naming the count, and one resolve when it returns.
- With HyperProx locked and the monitoring profile up, a storage fill crossing 90% reaches a
  usable-while-locked channel; a vault-only channel gets it in the unlock digest.
- Every message in the test corpus has a title of at most 60 characters and a body under 400.

### Phase 3 — State and job events from PVE

Guest stopped unexpectedly (HA-aware, task-aware), HA recovery info, network mount unreachable with
scrape-failure correlation, backup job failed (PVE webhook ingest and task-log catch-up), guest not backed
up (off by default), wizard and catalogue job results.

Acceptance:

- A user stop task → no alert; the same guest stopping with no task → one warning; an HA guest in `error` →
  one critical; an HA relocation → one info.
- A backup job failing on five nodes is one alert naming the job; the message never contains log text; a
  recorded 5 KB VM backup log fed through the ingest produces a body under 400 characters.
- A backup that fails while HyperProx is locked is reported once after unlock (no PVE webhook configured),
  and immediately while locked (PVE webhook configured).
- An unreachable NFS mount on a node whose node_exporter scrapes are timing out produces one message
  naming the mount as the likely cause, and no "node offline".
- The ingest endpoint rejects a request without the ingest token.

### Phase 4 — Email, plug-ins, heartbeat, polish

SMTP channel; plug-in `publish()` hook; optional heartbeat URL; per-rule scopes in the UI (this guest only,
all but these); rule test ("what would this have sent last week?" from Prometheus history).

Acceptance:

- An email with STARTTLS reaches a test SMTP server; a plain-text SMTP host is refused without the override.
- A plug-in event is delivered with its id prefixed and counts against the rate brake; a plug-in has no
  route or object through which it can read a channel.
- With the heartbeat on, stopping the evaluator makes the external checker report a missed ping.

## Open decisions

1. **No monitoring profile installed.** Fall back to PVE polling (unlocked only) or require the profile for
   resource rules? *Recommendation: fall back, and show the one-line banner that resource alerts pause while
   locked.* Requiring the profile would leave small installs with no alerts at all.
2. **Where usable-while-locked secrets live.** A root-only file in `data/`, or keep them in `.env`?
   *Recommendation: the `0600` file, one per install, owner-only toggle, email excluded.* It keeps the
   exception explicit, editable from the UI, and out of a file people paste into support threads.
3. **Link-local with the override.** *Recommendation: never.* No notification server lives there; cloud
   metadata does.
4. **Existing Prometheus alert rules.** Generate them from HyperProx rules, or keep them separate?
   *Recommendation: keep them for the Monitoring page, align their thresholds, never notify from them.* Do not
   add Alertmanager.
5. **Configuring PVE's notification webhook.** HyperProx writing the PVE notification target, or showing
   the commands? *Recommendation: opt-in button that shows the exact change and the commands, and applies
   only on confirm* — it is cluster-wide configuration, and the Smart Suggestion rule (suggest, user
   confirms) applies.
6. **Alerts for vault-only channels while locked.** Digest on unlock, or drop? *Recommendation: digest on
   unlock, still-firing first, capped at 10 lines, held rows expire after 24 h.*
7. **Guest CPU and RAM rules.** *Recommendation: off by default, enabled per guest.* They are the noisiest
   rules and the least actionable.
8. **Reminders.** *Recommendation: critical once a day, warnings never.* Matches the certificates module,
   which users already live with.
9. **Plug-in channel kinds** (Matrix, Pushover, ...). *Recommendation: no.* An adapter handles secrets; the
   generic webhook (or a bridge such as Apprise behind it) covers the long tail.
10. **Signing for the generic webhook.** *Recommendation: yes, optional HMAC secret per channel,* so a receiver
    can trust what it gets.
11. **Heartbeat ("dead man's switch").** If the HyperProx host itself dies, nothing alerts. *Recommendation:
    Phase 4, an optional outbound ping to a user-chosen checker URL every 5 minutes, usable while locked.*
12. **pve-exporter token scope.** Locked-state alerting leans on pve-exporter's own token, which a typical
    install creates with broad rights. *Recommendation: the installer creates it as a read-only
    (`PVEAuditor`) token, and the Notifications page warns when it is not.*

## Security summary

- Only admins configure channels; only owners take a secret out of the vault.
- Secrets are vault items or, for usable-while-locked channels, a `0600` file; never in logs, API responses,
  the outbox or audit log.
- Outbound requests pass the SSRF guard on every send, after DNS resolution, with no redirects.
- Messages carry no secret, token, session, log or raw error body.
- Inbound PVE ingest is authenticated by its own token and accepts only the fields it renders.
- Mutes and rules change only HyperProx's notifications, never cluster state.
