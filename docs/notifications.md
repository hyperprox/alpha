# Notifications

HyperProx tells you when something needs attention: when it locks itself, when an update run ends or
pauses, when the daily updates check finds something new to update, when a certificate changes verdict or
stays critical, when a Prometheus alert starts or clears. Messages are short (a title that makes
sense on its own, two or three lines, a link), so they read well on a phone, a watch or a voice assistant.

Set them up under **Settings → Notifications**. Admins add, edit, delete and test channels; only an owner
can mark a channel **Works while locked**.

Design and later phases (resource rules, mutes, backups, email): `docs/superpowers/specs/2026-10-31-notifications-design.md`.

## Channels

| Kind | What to paste | Severity shown as |
|---|---|---|
| Discord | the webhook URL (`https://discord.com/api/webhooks/...`) | embed colour |
| Slack | an incoming-webhook URL (`https://hooks.slack.com/services/...`) | attachment colour |
| Microsoft Teams | the URL of a "When a Teams webhook request is received" workflow | card style |
| ntfy | the topic URL, and an access token if the topic is protected | priority 5 / 4 / 3 |
| Gotify | the `/message` URL and an application token | priority 8 / 5 / 2 |
| Telegram | a bot token from @BotFather and a chat id | the first word of the title |
| Generic webhook | any URL that takes a JSON POST, optionally a signing secret | the `severity` field |

Each channel has:

- **Send me**: critical only, warnings and critical (the default), or everything (including reports
  that all went well).
- **About**: everything, or chosen families: lock alerts, updates, certificates, cluster health, Home
  Assistant security actions, Plex: new in the library (the others are for later phases).
  Plex: new in the library (`plex.added`) is sent only when the Plex plug-in's "Tell me when something new
  is added" switch is on. It is an ordinary message, so the channel must be set to everything.
  Cluster health is Prometheus's alerts (`alert.firing`, `alert.resolved`): one message when an alert
  starts, one when it clears, and one if Prometheus stops answering for 5 minutes. See
  [Storage and Monitoring](../README.md#storage-and-monitoring) for the rules and the not-forwarded list.
  Jobs covers wizard and catalogue jobs and Send files copies: a failed copy (`files.copy.failed`) is a
  warning; a finished one (`files.copy.finished`) is an ordinary message, sent only to channels set to
  everything.
- **Quiet hours**: a window (time zone, optional days) in which messages are held and sent as one summary
  when it ends. Critical messages come through unless you turn that off. Something that fired and cleared
  inside the window is not sent at all.
- **Self-hosted on my network** (ntfy, Gotify, generic webhook only): allows a private or loopback
  address. Only for a notification server you run yourself.
- **Works while locked** (owner only): see below.

**Send test** posts "HyperProx test" through the same path as a real message and shows what the receiver
answered (`Delivered (HTTP 204)`, `Refused: HTTP 401`, `Could not connect`). The last result of every
channel is on the page, and a channel that keeps failing is reported on the other channels.

## Delivery

- Every event is written to an outbox in Postgres first, so an API restart loses nothing.
- Messages close together are grouped: the first goes at once, anything else for the same channel within
  the next minute goes as one "N new alerts" message.
- At most 6 messages per channel in 10 minutes; past that one "Many alerts at once" message, and the
  rest is only in HyperProx.
- Retries after 10 seconds, 1 minute and 5 minutes, then the message is marked failed. A `429` waits for
  `Retry-After`. Any other 4xx, a redirect or a refused address fails at once: it is configuration, not
  luck.
- While HyperProx is locked, a channel whose secret is in the vault cannot be read: its messages wait and
  arrive as one summary after the next sign-in. Waiting messages older than 24 hours are dropped.
- The delivery history is kept for 30 days.

## Secrets

A channel's URL and token are a vault item (`hyperprox:notify/<channel id>`). The page shows only the host
and the last four characters; editing replaces the value. Logs, the delivery history and the audit log
hold a channel's id, kind, HTTP status and an error code, never the address, a token or a response body.

**Works while locked** moves the secret out of the vault into `data/notify-locked-channels.json` (mode
0600, git-ignored), so lock alerts can be sent while everything else is locked, with Postgres down too.
Anyone who can read that file can post to that channel. Telegram is allowed with a stronger warning (a bot
token controls the whole bot); email (a later phase) never will be.

## Address checks

Every send is checked at send time, after DNS resolution: https only (http with the self-hosted switch),
Discord, Slack, Teams and Telegram only at their public hosts, link-local and metadata addresses always
refused, private and loopback addresses only with the self-hosted switch and never on HyperProx's own
service ports (API, Prometheus, Grafana, exporters, Ollama, Postgres, Redis, the vault, the proxy
manager's admin port 81; add more with `NOTIFY_BLOCKED_PORTS=port,port`), however the address is written
(IPv4 inside IPv6, NAT64, expanded or compressed). Container networks on the HyperProx host (Docker
bridges) are always refused. Name lookups time out after 5 seconds. Redirects are not followed; at most
1 KB of an answer is read.

Every message is scrubbed before it is stored or sent: links, bearer tokens, `key=value` secrets, long
opaque strings, and bare IP addresses (IPv4 and IPv6) and `host:port` are replaced.

## Links

Set `HYPERPROX_PUBLIC_URL` in `.env` to the address you open HyperProx at. Messages then link to the page
that shows the problem; without it they say which page to open.

## Generic webhook payload (version 1)

```json
{
  "version": 1,
  "id": "evt_...",
  "type": "certs.verdict.changed",
  "event": "certs.verdict.changed",
  "severity": "warning",
  "resolved": false,
  "title": "Certificate worse: mail.example.com:993",
  "lines": ["Worse: mail.example.com:993: OK -> WARN - expires in 20 day(s)"],
  "subject": null,
  "at": "2026-11-01T06:15:00.000Z",
  "url": "https://hyperprox.example.com/certificates",
  "fingerprint": null,
  "content": "Warning: Certificate worse: mail.example.com:993: Worse: ... Open: https://...",
  "text": "Warning: Certificate worse: mail.example.com:993: Worse: ... Open: https://..."
}
```

`content` and `text` are there so Discord- and Slack-compatible receivers work without a transform. With
a signing secret, the request carries `X-HyperProx-Timestamp` (Unix seconds) and
`X-HyperProx-Signature: sha256=<hex HMAC-SHA256 of timestamp + "." + body>`; reject timestamps older than
5 minutes. The version changes only for a breaking change.

Event types today: `vault.locked`, `updates.job.finished`, `updates.job.paused`, `updates.available`, `certs.verdict.changed`,
`certs.still.critical`, `notify.channel.failing`, `ha.security.action`, `ha.security.refused`, plus `notify.test`, `notify.group`, `notify.digest` and
`notify.brake` for the messages HyperProx makes itself.

`ha.security.action` is a warning sent after someone uses a security control (a lock, an alarm panel, a
siren, a garage, gate or door cover, or a device marked protected) on a Home Assistant house, when that
house has "Notify my channels after every security action" on (the default). It names the action, the
device, the house and who did it, and whether the device confirmed the change. It belongs to the Home
Assistant family. `ha.security.refused` (warning, same switch, same family) says a security action at a house
was refused (role, API token, confirm step or rate limit), at most once per house every 10 minutes; every
refusal is in the audit log.

`updates.available` comes from the daily updates check (`docs/updates.md`, "The daily check"): one
message per check that found something new on any cluster, grouped by cluster, security fixes first, with
counts and kernel or reboot flags only (no versions or addresses). It is a warning when security fixes, a
kernel or a reboot are involved and info otherwise, belongs to the Updates family, and repeats at most every `check.reminder_days` (default 7) while the same updates stay unapplied.
Messages about an update run on a remote cluster name it ("Remote server (remote): Updates finished") and
link to that cluster's Updates page.

## Moving from the old settings

The three senders that existed before are now channels, created once:

| Old setting | Becomes | When |
|---|---|---|
| `LOCK_ALERT_URL` / `_KIND` / `_TOKEN` in `.env` (or, if empty, the Updates or Certificates webhook the lock alert fell back to) | "Lock alerts": works while locked, lock alerts only, critical | first start of this version, no sign-in needed |
| `notify.webhook_url` in `config/updates.yaml` | "Updates reports": Updates, everything | first Owner sign-in |
| `alerts.webhook_url` in `config/certs.yaml` | "Certificate alerts": Certificates, warnings and critical | first Owner sign-in |

The same URL behind several of them becomes one channel with all their filters, so nothing arrives twice.
Until a setting has been moved it still works as before; after, it is no longer read and the API log says
where it went. The keys are removed from the parsers in a later release.
