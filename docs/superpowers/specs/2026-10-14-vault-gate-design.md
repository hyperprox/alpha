# Vault gate: HyperProx secured by a built-in Vaultwarden — design

Status: design, for review. Not yet planned or built.

## Why

HyperProx can see and change everything it manages: hypervisor, guests, network, DNS, proxy, certificates.
Today that power sits behind one password, and every credential it uses is kept beside the data it protects:

- Provider credentials are encrypted in Postgres, but the key (`ENCRYPTION_KEY`) is in `config/.env` on the
  same machine. Anyone who can read the container can decrypt all of them.
- Sessions are signed with `JWT_SECRET`, also in `.env`. Reading that file is enough to mint an admin
  session without any password.
- Sign-in is a single password with no second factor.

So whoever gets into HyperProx, or gets a copy of its disk or backup, gets everything. That is not
acceptable for a tool whose purpose is to hold the keys to someone's infrastructure.

The fix is to put HyperProx behind a security platform people already trust: **Vaultwarden**, the
open-source, Bitwarden-compatible, zero-knowledge vault. HyperProx keeps nothing of value outside it,
and nobody (person or process) reaches HyperProx except through it.

## Goals

- **Built-in vault.** Every install includes its own Vaultwarden on the same machine. It starts first;
  HyperProx refuses to start without it.
- **One login.** Users sign in to HyperProx with their vault account (email, master password, 2FA).
  That single step identifies them and unlocks HyperProx. HyperProx has no password of its own.
- **Sealed at rest.** HyperProx's disk, database, config and backups contain no usable secret.
- **Secrets flow both ways.** HyperProx reads the credentials it needs from the vault and writes new
  ones it creates (generated passwords, tokens, keys) back into it.
- **Send to a user.** Any password HyperProx holds or generates can be sent to a person as a
  Bitwarden Send: an expiring, view-limited, end-to-end-encrypted link.
- **Multi-user with roles.** Owners, admins, operators, viewers and temporary users, so a company can
  give each person exactly the access they need.
- **Everyday tasks stay fast.** Checking status, viewing graphs and restarting a guest take one click.
  Only dangerous actions ask for re-confirmation.
- **Recoverable by the owner from the command line**, without weakening the zero-knowledge guarantee
  for anyone else.
- **Two editions, Homelab and Business**, chosen at install, with plug-ins filtered by audience.
- **Reachable how the user chooses**, picked from an install menu, with the safest option as the default.

## Non-goals (this version)

- Forking Vaultwarden or the Bitwarden clients. Stock Vaultwarden, kept updated, is the point.
- Large-file Send beyond Bitwarden's 500 MB limit.
- Connecting to an external Vaultwarden or Bitwarden instead of the built-in one.
- Supporting CGNAT for the built-in VPN (a later Headscale option).
- An AI operator. When it comes, it follows the rules in **AI and automation**.

## Components

| Unit | Where | Job |
|---|---|---|
| Vault service | `vaultwarden` container in the HyperProx compose stack | Stock Vaultwarden, pinned and checksum-verified, bound to the internal network only. Signups off. One organization, "HyperProx", holds infrastructure secrets. |
| Vault broker | API, `lib/vault/` | The only code that talks to the vault: sign-in, unlock, read and write items, create Sends, read events. Uses the official Bitwarden SDK or CLI (`bw serve`) so all cryptography is Bitwarden's own. |
| Unlock state | API, in memory only | After sign-in: the decrypted secrets HyperProx needs and a session-signing key generated at unlock. Wiped on lock, auto-lock, restart or `hyperprox lock`. |
| Gate | API middleware | Every route except sign-in and health refuses with "locked" until unlocked. Role checks run after the gate. |
| Roles | API + vault groups | Owner, Admin, Operator, Viewer and Temporary, mapped to vault organization groups and collections. |
| Sign-in page | Frontend | Vault email, master password and 2FA. The master password never leaves the browser-to-API TLS session and is never stored or logged. |
| Secrets UI | Frontend | Lists the credentials HyperProx holds (names only), with "use", "rotate", "send to user" and, for Owner and Admin with re-confirmation, "reveal". |
| Access modes | Installer + Settings | Local-network only (default), built-in WireGuard VPN, hardened internet, or an existing tunnel/VPN. |
| Recovery | CLI, `hyperprox --force-reset <email>` | Owner recovery using the Master Reset Password escrow. |
| Audit view | Frontend | Vault event log plus HyperProx's own action log, in one timeline. |

## What moves into the vault

Everything that grants access, both external and internal:

- Hypervisor API tokens; DNS-provider keys (GoDaddy now, Cloudflare and others later); proxy-manager
  login; notification webhooks.
- SSH private keys used by the terminal and node-exec; device credentials such as the router's.
- Internal service passwords (Postgres, Redis, Grafana admin). The containers keep their own config to
  start, but HyperProx reads its copies from the vault at unlock, and rotation goes through the vault.
- Credentials HyperProx creates: passwords for new guests, databases, service accounts and temporary users.

`ENCRYPTION_KEY` and `JWT_SECRET` stop existing as stored values: the session key is generated at each
unlock, and stored credentials live in the vault instead of in an encrypted table.

**The one exception is the metrics exporter**, which runs around the clock for the graphs. It gets its own
**read-only** hypervisor token (audit role) kept in its config file. A stolen copy can only look.

## Sign-in and unlock flow

1. The user opens HyperProx and sees the vault sign-in page (HyperProx is locked).
2. They enter email, master password and 2FA code. The API's vault broker signs in to the built-in
   Vaultwarden as that user.
3. The vault checks the account and 2FA (and rate-limits failures). The broker decrypts only the items in
   the collections that user's role may use.
4. The API generates a fresh session-signing key and issues a session. The decrypted items stay in memory.
5. **Auto-lock:** after a configurable idle time (default 30 minutes with no signed-in user), or on
   `hyperprox lock`, memory is wiped and HyperProx is locked again. A restart always starts locked.

While locked, the dashboards show nothing, by design: there are no unattended jobs that need secrets. The
metrics exporter keeps the graph history going with its read-only token.

## Roles

| Role | Can | Cannot |
|---|---|---|
| **Owner** | Everything, including role management, recovery setup, revealing secrets | — |
| **Admin** | Manage infrastructure, users and secrets; reveal secrets with re-confirmation | Change the Owner or recovery |
| **Operator** | View everything; start, stop and restart guests; open consoles; create temporary guests from approved templates | Destroy, change storage or network, see secrets |
| **Viewer** | Dashboards, status, network activity, logs | Any change |
| **Temporary** | One named guest, or a small set, until an expiry date; account and guest disabled automatically on expiry | Anything else |

Roles are vault organization groups, so adding a person is "invite to the vault, put in a group".
Removing them from the vault removes them from HyperProx. Their personal vault, if they have one, is theirs
alone and is never readable by HyperProx or any admin.

**Re-confirmation** (master password again) is required for: destroying or restoring over a guest,
storage and network changes, revealing a secret, rotating hypervisor tokens, role changes, and recovery
settings. Restart, start, stop, console and viewing never re-confirm.

## Generating, storing and sending credentials

- When HyperProx creates something that needs a credential (a guest's root password, a database user, a
  temporary user's login), it generates one (default 24 characters, or a passphrase), saves it to the vault
  in the relevant collection with a note of what it is for, and never shows it unless asked.
- **Send to user:** from any item, or straight after creating one, an Owner or Admin can send it to a person.
  HyperProx creates a text Send (default: expires in 24 hours, 1 view, optional access password) and emails
  the link through the vault's SMTP settings, or shows it for copying.
- **Rotate:** generates a new value, applies it where the target supports it, updates the vault, and
  records the event.

## Editions: Homelab and Business

HyperProx serves two very different audiences, and the edition is chosen in the installer's first menu.

| | **Homelab** | **Business** |
|---|---|---|
| Media plug-ins (Arr Stack, Plex activity, Unmanic and similar) | Available | **Not available**: absent from the catalogue, never suggested by "Scan for services", and refused by the API if installed by hand |
| Home-automation plug-ins (Home Assistant and similar) | Available | Not available |
| General plug-ins (router, network activity, guest status, power) | Available | Available |
| Roles and Temporary users | Optional (a single Owner is fine) | On by default, front and centre |
| 2FA | Required for the Owner, recommended for others | Required for every account |
| Auto-lock | 30 minutes idle | 10 minutes idle |
| Re-confirmation | The list in **Roles** | Also console access to production guests, and any Send |
| Audit timeline | Available | On the home screen |

Every plug-in declares its audience in its manifest: `homelab`, `business` or `both`. The catalogue, the
scanner and the plug-in loader all filter on it, so a new plug-in lands in the right edition by itself, and a
business install cannot be talked into loading a media plug-in.

**Changing edition.** Homelab → Business is allowed: Owner only, from Settings, with re-confirmation. The
switch removes every homelab-only plug-in and its stored data, applies the Business defaults, and records the
change in the audit timeline. **Business → Homelab is not offered**, in the UI, the API or the CLI. A company
install cannot be turned back into a media server; the only way back is a fresh install.

## Access modes (chosen at install, changeable in Settings)

| Mode | Extra setup | Exposure |
|---|---|---|
| **1. Local network only** (default) | None | Sign-in page answers only on private address ranges. |
| **2. Built-in VPN** | WireGuard app plus QR code per device | Sign-in answers on the VPN and the LAN. Devices belong to vault users; removing a user revokes their devices. Needs one forwarded UDP port (the installer can create it on supported routers). |
| **3. Internet, hardened** | None | Public sign-in with 2FA required for every account, lockout after failed attempts, optional country and IP allowlists, and security headers. |
| **4. Existing tunnel or VPN** | Point at it | For people already using Tailscale, Cloudflare Tunnel or their own VPN. |

The vault gate, sealing and auto-lock apply in every mode. The first setup always happens on the local
network, before any of these exist.

## Recovery: `hyperprox --force-reset <email>`

- At install, the Owner chooses a **Master Reset Password**: separate from the vault master password,
  minimum 5 words or 24 characters, entered twice.
- The installer writes an **escrow** file: the Owner account's vault key and the HyperProx organization key,
  encrypted with a key derived from the Master Reset Password with Argon2id (memory-hard, deliberately slow).
  It lives in `config/` with mode `0600` and is useless without the password.
- `hyperprox --force-reset <email>`, run as root on the HyperProx machine, prompts for the Master Reset
  Password. It then sets a new vault master password for that account, clears its 2FA so a new device can be
  enrolled, and ends every session.
- Every reset is written to both audit logs and emailed to the account.
- Only escrowed accounts (the Owner, and Admins the Owner enrols) are recoverable. **Personal vaults are
  never escrowed:** a family member or employee who forgets their own master password loses their own
  vault, exactly as in Bitwarden.

## Hardening that ships with it (required, not optional)

- **Tamper check.** At startup and before every unlock, HyperProx verifies its installed files against the
  release's signed checksums. It refuses to unlock if they changed, because a modified login page could
  capture master passwords.
- **Least privilege.** The installer creates hypervisor tokens with only the rights each role needs, not a
  root-equivalent token.
- **No secrets in crash output.** Core dumps disabled for the API, and secrets excluded from logs and error
  reports.
- **Pinned supply chain.** Vaultwarden and every other image pinned by digest. Updates go through HyperProx's
  release process (checksums, rollback), never `:latest`.
- **Vault kept current.** Vaultwarden security releases are surfaced on the Updates page as high priority.

## AI and automation (rules for later features)

When an AI operator or automation is added, it uses secrets through the broker ("use key X to connect to
host Y") and never receives the value. It has its own vault identity with the narrowest collections, and
dangerous actions require a human's re-confirmation. A prompt-injected instruction must not be able to make
it reveal or exfiltrate a secret.

## Failure handling

- **Vault container won't start:** HyperProx stays down with a clear message and `hyperprox status`
  says why. This is deliberate: there is no "HyperProx without the gate".
- **Wrong password or 2FA:** vault rate limits apply; repeated failures lock the account temporarily and
  are logged.
- **Tamper check fails:** HyperProx won't unlock. It shows which files differ and how to reinstall the
  release.
- **Lost Owner login:** `hyperprox --force-reset`. **Lost Master Reset Password and Owner login:** no
  recovery by design; reinstall and re-enter credentials.

## Threat model summary

| Attack | Result |
|---|---|
| Stolen disk, backup or image | Nothing usable |
| Reading `.env` or the database | Nothing usable; no session can be forged |
| Stolen account password | Useless without 2FA |
| Root on the machine while **locked** | Nothing usable; a reset still needs the Master Reset Password |
| Root on the machine while **unlocked** | The unlocked secrets in memory, limited by least-privilege tokens and auto-lock; code changes are caught by the tamper check at the next unlock |
| Breach of HyperProx, then users' personal vaults | Not reachable |

## Testing

- Unit: escrow round-trip (Argon2id parameters, wrong password fails), role-to-route matrix, session key
  rotation on unlock, auto-lock timer, generated-password policy.
- Integration (throwaway install): sign-in with 2FA; locked routes refuse; secrets absent from disk after
  lock (search the container filesystem and database for known values); force-reset end to end; tamper check
  blocks unlock; each access mode's exposure (local-only page unreachable from a public address); Send
  created, viewed once, then gone.
- Part of the release test from the installer design: every release must pass the "no secrets on disk" scan.

## Docs

- `docs/security.md`: the model above, written for users, including what recovery can and cannot do.
- Installer screens for the access mode and the Master Reset Password, with plain-language warnings.
- `README.md`: "Security" section linking to the above.
