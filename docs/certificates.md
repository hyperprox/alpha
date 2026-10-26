# Certificates

HyperProx lists every certificate your network serves, issues and renews the ones your
reverse proxy cannot (mail, hypervisor and backup consoles, HyperProx itself) over ACME
DNS-01, delivers them where they are used, and checks each endpoint the way a client
would. This page is for the operator: getting started, what Issue and Deploy do, the
daily check, and what happens when something fails. The design behind it is in
`docs/superpowers/specs/2026-10-26-certificates-design.md`.

Everything about Certificates is admin-only, reads included: the inventory maps every
endpoint and what it serves. Every issue, renewal, deploy, probe and housekeeping action
is written to the audit log with the user who started it (`by: schedule` for the daily
check).

## Getting started

1. Copy `config/certs.example.yaml` to `config/certs.yaml` and edit it. The file is
   git-ignored.
2. Open the Certificates page and press **Probe all**. This only makes TLS handshakes; it
   changes nothing, and works without a policy file.
3. Set `acme.directory: staging`, then press **Issue** on one certificate. The whole path
   runs against the CA's staging endpoint, and the result is flagged as staging everywhere
   it appears.
4. Switch to `production` and press **Issue** again.

Every name you issue for becomes public in Certificate Transparency logs.

The first issuance of a certificate is always a person pressing **Issue**. The daily check
only renews certificates that already exist; it never issues one on its own, not even after
a first attempt failed.

## Issue (or Renew)

`POST /api/certs/managed/<label>/issue` returns at once with the certificate `renewing`;
the page polls until it settles. One issuance per certificate at a time: a second press
while one runs gets *already being issued* (409).

1. The ACME order runs through the DNS provider HyperProx already holds (GoDaddy). A zone
   counts as managed only when its NS records point at GoDaddy (`*.domaincontrol.com`); a
   domain registered there with its DNS hosted elsewhere shows "DNS provider not managed".
   A name in no managed zone fails the order before any record is written.
2. On success the private key and full chain go into the vault, as one Secure Note per
   certificate (`hyperprox:certs/cert-<label>`) in the HyperProx collection; the ACME
   account key is `hyperprox:certs/acme-account`. The database holds only metadata: names,
   issuer, serial, fingerprint, dates and the renewal window.
3. The renewal time is decided once: a random moment in the CA's renewal window (ARI) when
   it offers one, otherwise two-thirds of the lifetime. No fixed day counts, so shorter
   lifetimes need no change.
4. The certificate is delivered to every target the policy lists for it, one after another.

On failure nothing that is deployed changes: the previous certificate, its metadata and its
vault entry stay as they were, the certificate is marked `failed` with the reason, and the
event history keeps the error text.

## Deploy

**Deploy** (`POST /api/certs/managed/<label>/deploy`) delivers the current certificate
again, from the vault, without a new issuance. A delivery only counts when the endpoint
serves it: every deploy ends with a probe that must see the new certificate's
fingerprint, retried briefly so a daemon has a moment to reload.

- **`guest-files`**: the files are written inside the container or VM from its node
  (`pct` for containers, the guest agent for VMs, with the node login the Terminal and
  Updates already use; no SSH into the guest). Every file is staged next to its destination
  first and only moved into place when all of them staged, so a key and a certificate from
  different issuances never sit side by side. The files they replace are kept as
  `<path>.hyperprox-prev`. The key gets `key_mode`, the others `0644`, all of them `owner`. A `key_mode` that gives
  "other" any access, or two files on one path, is refused.
  Then `reload` runs, then the probes. The probes used are the policy's `probes:` whose
  host is one of the certificate's names; a guest target with none is reported as
  *unverified*, not as a success.
- **`hyperprox`**: HyperProx's own front door. `certs/cert.pem` (full chain) and
  `certs/key.pem` are replaced, the previous pair kept as `cert.prev.pem` and
  `key.prev.pem`, and `nginx -t` runs in `hyperprox-nginx`. If nginx refuses the new pair
  the old one is put back and nothing is reloaded; otherwise nginx is reloaded (not
  restarted). Then `127.0.0.1:443` is probed with the certificate's name.

A target that fails is marked failed with the reason and the others carry on. The new
certificate is kept, and the daily check tries the failed targets again.

## The daily check

At `schedule.check` (five-field cron, local time, default `15 6 * * *`):

1. For each certificate already issued: the CA's renewal window is fetched again (a
   CA-initiated early renewal is followed within a day), and the certificate is renewed if
   it is due. A failed renewal is retried at the next daily check, never in a tight loop.
2. Deliveries that failed are retried with the certificate already issued.
3. Every known endpoint is probed: the policy's probes, every proxy host, the hypervisor
   and backup node consoles, and each managed certificate's targets.
4. Alerts go to `alerts.webhook_url` (Discord-compatible) on a change of verdict, with a
   daily reminder while anything is critical. A failing renewal alerts once its
   certificate is inside `warn_fraction` of its lifetime or `critical_days`.

A check that falls while HyperProx is locked is skipped and recorded in the history: the
keys, the DNS credential and the node logins are in the vault. It is not caught up later.
A restart while a certificate is `renewing` releases it as `failed` ("interrupted by a
restart"); the certificate in place is unchanged.

## API

All under `/api/certs`, admin only.

| Method + path | Does |
|---|---|
| `GET /overview` | Policy status, inventory, probes, managed certificates. `?refresh=1` probes first. |
| `POST /probe` | `{ host, port }` probes one endpoint HyperProx already knows (unknown: 404); `{}` probes all. |
| `POST /managed/:label/issue` | 202, issue or renew now. |
| `POST /managed/:label/deploy` | 202, deliver the current certificate again. |
| `GET /events` | History, newest first. `?label=&limit=50`. |
| `GET /housekeeping` | Dead proxy certificates (expired, and used by no proxy, redirection or 404 host or stream) and orphaned renewal files (not in the proxy's certificate list and not referenced by its nginx configuration). Refused when any of the proxy's lists cannot be read. |
| `POST /housekeeping/:id/apply` | Act on one item, after listing again. Files are archived, never deleted. |

Errors are `{ error }` with 400 (no policy, never issued, bad input), 404 (unknown
certificate, endpoint or item), 409 (already issuing or deploying) and 503 (a dependency is
down).
