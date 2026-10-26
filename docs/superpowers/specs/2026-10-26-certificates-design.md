# Certificates — design

Status: design, approved for spec 2026-10-26 (scope "A": monitoring, issuance, deployment, housekeeping). Not
yet planned or built.

## Why

Let's Encrypt is shortening certificate lifetimes: 64 days for certificates issued from 10 February 2027, 45
days in 2028, with authorization reuse cut from 30 days to 10. Renewal that is pinned to fixed day counts, or
that fails quietly, stops working without anyone noticing until a browser or a mail client complains.

A typical self-hosted network already has three kinds of certificate, and only one of them is watched:

- **Behind the reverse proxy.** Nginx Proxy Manager issues and renews these itself over HTTP-01. They are
  usually fine.
- **Everything the proxy does not front**: mail (SMTP/IMAP), hypervisor and backup consoles, the management
  platform itself. HTTP-01 cannot reach them when port 80 belongs to the proxy, so their own ACME clients fail
  every night and fall back to self-signed certificates. The failure is silent.
- **What is actually served.** A valid certificate on disk proves nothing if the daemon serves another one.

HyperProx already holds the DNS provider credential and the proxy's API. With DNS it can answer ACME DNS-01
challenges for any name in a managed zone, with no inbound port and no manual TXT record. So it should issue
the certificates the proxy cannot, deliver them where they are used, and check every endpoint the way a
client would.

## Goals

- One page listing every certificate the network serves, wherever it comes from, with days left, issuer,
  lifetime, how it renews, and whether the served certificate is trusted, current and the expected one.
- Issue and renew certificates over ACME DNS-01 through the DNS integration, writing and removing the
  `_acme-challenge` TXT records itself.
- Renewal timing that survives the lifetime changes without configuration: the CA's ACME Renewal Information
  (ARI) window when offered, otherwise at two-thirds of the lifetime.
- Deliver issued certificates to configured targets and prove each delivery by checking what is served.
- Alert on what matters, in proportion to the certificate's lifetime, and say why.
- Clean up dead proxy certificates that can only ever fail to renew.

## Non-goals

- Replacing the proxy's own certificate management. Hosts the proxy fronts keep the proxy's certificates;
  HyperProx monitors them.
- Private CAs, client certificates, S/MIME.
- DNS providers other than the ones implemented (GoDaddy first). A name whose zone is served elsewhere is
  shown as "DNS provider not managed" rather than attempted.

## Policy (`config/certs.yaml`, local, git-ignored)

Everything specific to a network lives here. A commented `config/certs.example.yaml` ships in the repo.
Unknown keys fail validation at load, as with `updates.yaml`.

```yaml
acme:
  directory: production          # production | staging | https://custom/directory
  email: admin@example.com
  key_type: ec256                # ec256 | ec384 | rsa2048 | rsa4096
schedule:
  check: "15 6 * * *"            # daily probes + renewal decisions, local time
alerts:
  warn_fraction: 0.33            # warn when less than a third of the lifetime remains
  critical_days: 7
  notify_webhook: true           # the existing notification webhook
certificates:
  mail:
    names: [mail.example.com]
    deploy:
      - target: mail-guest
probes:                          # endpoints to check besides the ones discovered automatically
  - { host: mail.example.com, port: 993, starttls: none }
  - { host: mail.example.com, port: 587, starttls: smtp }
targets:
  mail-guest:
    kind: guest-files             # files pushed into a container or VM, then a reload
    vmid: 101
    files:
      fullchain: /etc/ssl/mail/fullchain.pem
      key:       /etc/ssl/mail/privkey.pem
    owner: "root:root"
    key_mode: "0600"
    reload: "systemctl reload postfix dovecot"
  self:
    kind: hyperprox               # HyperProx's own front door
```

## Components

| Unit | File | Job |
|---|---|---|
| Policy | `lib/certs/policy.ts` | Load, validate and default `certs.yaml`. |
| DNS challenge | `lib/certs/dns01.ts` | Provider interface `present(fqdn, value)` / `cleanup(fqdn, value)`, zone lookup, propagation wait. GoDaddy implementation over the existing client. |
| ACME | `lib/certs/acme.ts` | Account (key in the vault), order, DNS-01 authorizations, finalize, download. Built on `acme-client` (RFC 8555); ARI fetched directly. |
| Renewal timing | `lib/certs/timing.ts` | Pure: ARI window or two-thirds of the lifetime, plus jitter; "renew now" decisions. |
| Probe | `lib/certs/probe.ts` | TLS handshake to host:port with SNI, STARTTLS for smtp/imap/pop3; returns chain, trust verdict, names, dates, fingerprint. |
| Inventory | `lib/certs/inventory.ts` | Merges the proxy's certificates (API), HyperProx-issued ones, hypervisor/backup node certificates (their APIs), and probe results into one list with a status per entry. |
| Deploy | `lib/certs/deploy.ts` | Target kinds `guest-files` (node-exec push + reload), `hyperprox` (own nginx), later `pve-node` and `pbs` (their certificate APIs). Every deploy ends with a probe that must see the new fingerprint. |
| Housekeeping | `lib/certs/housekeeping.ts` | Proxy certificates that are expired and attached to nothing; with a configured proxy guest, renewal configs on disk that the proxy no longer knows about. Reports; acts only on confirmation, and archives rather than deletes. |
| Scheduler | `lib/certs/scheduler.ts` | Daily check from `schedule.check`; skipped and logged while HyperProx is locked. |
| API | `routes/certs.ts` | Inventory, probe now, issue/renew now, deploy now, history, housekeeping (list + confirm). Admin-only. |
| UI | `app/certificates/page.tsx` | Inventory table with status badges and reasons, per-certificate detail and history, Issue / Renew / Deploy buttons, housekeeping panel. |

Reused: `godaddy-client.ts`, `npm-client.ts`, `node-exec.ts`, `proxmox-client.ts`, the vault (keys and
account), the notification webhook, Prisma, the audit log, the existing cron parser from Updates.

## Data

```prisma
model ManagedCertificate {
  id          String   @id @default(cuid())
  label       String   @unique        // policy key
  names       String[]
  status      String                  // pending | valid | renewing | failed
  issuer      String?
  serial      String?
  notBefore   DateTime?
  notAfter    DateTime?
  ariStart    DateTime?
  ariEnd      DateTime?
  renewAfter  DateTime?               // decided time, ARI or two-thirds
  staging     Boolean  @default(false)
  lastError   String?
  updatedAt   DateTime @updatedAt
  events      CertEvent[]
}
model CertProbe {
  id          String   @id @default(cuid())
  host        String
  port        Int
  starttls    String                  // none | smtp | imap | pop3
  source      String                  // policy | proxy | node | managed
  checkedAt   DateTime?
  verdict     String?                 // ok | warn | critical | error
  reason      String?
  fingerprint String?
  notAfter    DateTime?
  @@unique([host, port])
}
model CertEvent {
  id        String   @id @default(cuid())
  certId    String?
  cert      ManagedCertificate? @relation(fields: [certId], references: [id])
  kind      String                     // issue | renew | deploy | probe | housekeeping | alert
  ok        Boolean
  detail    String
  at        DateTime @default(now())
}
```

Private keys and the ACME account key are stored in the vault, never in the database or on disk outside a
deploy target.

## Issuing a certificate (DNS-01)

1. Order for the configured names. For each authorization, find the managed zone that contains the name. A
   name in no managed zone fails the order before anything is written.
2. Add a TXT record `_acme-challenge.<name>` with the key authorization digest, TTL 600. The provider adds a
   value next to any existing TXT values of that name rather than replacing them: an apex and its wildcard
   need two values at once, and unrelated TXT records must survive.
3. Wait for propagation by asking the zone's authoritative nameservers directly (resolved from its NS
   records, not a recursive resolver), every 15 s, up to 10 minutes.
4. Tell the CA to validate; poll until valid or invalid.
5. Remove exactly the values this order added, always (in a `finally`), including after failure or timeout.
6. Finalize with a fresh key, download the chain, store key and chain in the vault, record dates, serial and
   ARI window.
7. Deploy to every target listed for the certificate, then probe each one.

With `acme.directory: staging` the whole path runs against the CA's staging endpoint; staging certificates
are flagged everywhere they appear.

## Renewal timing

- When the CA offers ARI, `renewAfter` is a random moment inside the suggested window; the window is
  re-fetched daily, so a CA-initiated early renewal (mass revocation) is followed within a day.
- Otherwise `renewAfter = notBefore + 2/3 × lifetime`, with up to 12 hours of jitter. No fixed day counts,
  so 90, 64 and 45-day certificates need no change.
- A failed renewal retries on the next daily check, and in the meantime raises an alert once the alert
  thresholds below are reached. There is no tight retry loop (CA rate limits, failed-validation limits).

## Monitoring and alerts

Probes run daily and on demand. The probe list is the union of policy probes, every proxy host (port 443 with
its own name), hypervisor and backup node consoles, and every deploy target of a managed certificate.

A probe's verdict:

- **critical**: expired, untrusted chain where a public certificate is expected, name mismatch, served
  fingerprint differs from the managed certificate just deployed, or fewer than `critical_days` left.
- **warn**: less than `warn_fraction` of the lifetime left, or a staging certificate.
- **ok** otherwise. A self-signed or private-CA certificate on an endpoint marked internal-only is ok, with
  the reason "private certificate, expected here"; expiry, name and fingerprint still apply to it.

Each verdict carries a one-line reason ("serves a self-signed certificate", "expires in 5 days and its last
renewal failed: <error>"). Notifications go out on a change of verdict, plus a daily reminder while anything
is critical.

## Failure handling

- **DNS provider error or propagation timeout**: order abandoned, challenge records removed, certificate stays
  as it was, event recorded, alert per thresholds.
- **CA rejects validation**: same, with the CA's error text kept.
- **Deploy fails or the probe sees the old certificate**: the target is marked failed with the reason; other
  targets continue; the new certificate is kept for the next attempt.
- **Another tool overwrites a deployed certificate** (a panel's own renewal job, say): the daily probe sees the
  wrong fingerprint and goes critical, naming the target.
- **HyperProx locked at check time**: skipped and logged; nothing is caught up silently.

## Security

- The routes and page are admin-only; every issue, renew, deploy and housekeeping action is written to the
  audit log.
- No new credential is introduced for DNS: the provider key already in the vault is used. Deploy targets use
  the existing node-exec credential.
- Every issued name becomes public in Certificate Transparency logs. The UI says so before the first issuance
  of a name.

## Testing

- **Unit**: policy (unknown keys, defaults), renewal timing (ARI window, two-thirds rule for 90/64/45 days,
  jitter bounds), probe verdicts, inventory merge, zone matching.
- **DNS provider**: adding a TXT value preserves existing values, cleanup removes only ours, wildcard + apex
  together, failure paths always clean up.
- **End to end**: Pebble (the ACME test server) plus its challenge test DNS in containers on loopback, through
  the full issue → deploy → probe path with a fake target.
- **Rollout**: probes only → staging certificate for a test name → production certificate for one service and
  its deploy target → enable the schedule.
