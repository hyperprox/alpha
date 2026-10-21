# Vault gate — MVP build contract (2026-10-21)

Spec: `docs/superpowers/specs/2026-10-14-vault-gate-design.md`. Operator: "Get the vault gate working and push".
This file fixes the MVP scope, the decisions the spec leaves open, the interfaces between the four
workstreams, and who owns which files. Agents build against THIS; the spec is the authority on intent.

## Scope

IN (this MVP):
1. Bundled **Vaultwarden** (`hyperprox-vault` compose service), stock image pinned by digest, bound to
   `127.0.0.1:8222` only, `SIGNUPS_ALLOWED=false`, `INVITATIONS_ALLOWED=true`, `ORG_GROUPS_ENABLED=true`,
   `ADMIN_TOKEN` (argon2 PHC hash in compose env; plain token in `.env` as `VAULT_ADMIN_TOKEN` — the admin
   panel manages users, not vault contents, so zero-knowledge holds; documented).
2. **Owner bootstrap from HyperProx's sign-in page** when the vault has no HyperProx organization yet:
   email + master password (twice) → broker invites the email via the Vaultwarden admin API, registers the
   account with Bitwarden client crypto, creates organization **"HyperProx"** and collection **"HyperProx"**,
   then enrols **TOTP** (QR shown, code verified). 2FA is mandatory for the Owner.
3. **Sign-in = vault login** (email, master password, TOTP). HyperProx has no password of its own
   (the setup-wizard admin password is retired: `create-admin` step removed from the wizard).
4. **Unlock state in memory only.** First successful sign-in unlocks: secrets in the HyperProx collection
   are decrypted into a process-memory cache, and a fresh random **session-signing key** is generated.
   Restart = locked. **Auto-lock** after `VAULT_IDLE_LOCK_MINUTES` (default 30) with no request from any
   signed-in session, or `POST /api/auth/lock`, or `hyperprox lock` CLI → cache + key wiped, all sessions void.
5. **Gate**: every route except `/health*`, `/api/auth/*` returns **423** `{ ok:false, locked:true }` while
   locked; 401 when unlocked but no/invalid session. Role check after the gate.
6. **Roles** from the signed-in user's membership type in the HyperProx organization:
   Owner→`owner`, Admin→`admin`, Manager→`operator`, User→`viewer` (Custom→`viewer`).
   Matrix: `viewer` = any GET + WebSocket read; `operator` = viewer + guest start/stop/shutdown/reboot +
   terminal/console; `admin` = everything except role management; `owner` = everything.
   Re-confirmation (master password again, valid 5 min) required for: reveal secret, destroy guest,
   role changes. (Temporary role: later phase.)
7. **Credentials in the vault.** `lib/credentials.ts` keeps its exported functions and signatures; its
   storage becomes the unlock cache + write-through to the vault (one Secure Note item per
   `category/provider`, named `hyperprox:<category>/<provider>`, one hidden custom field per key).
   **Migration** on the first Owner unlock: every row of the Postgres `credential` table and every env-seeded
   value is written to the vault, verified by read-back, then the rows are deleted and `ENCRYPTION_KEY`,
   `JWT_SECRET` and the seeded secrets are blanked in `.env` (kept in a `.env.pre-vault` backup, mode 0600,
   that the Owner is told to delete).
8. **Secrets page** (Settings → Secrets): names only; Reveal (owner/admin, re-confirm); **Send** (owner/admin):
   creates a text Bitwarden Send (expires 24 h, max 1 view, optional password) and returns the link;
   **Generate**: 24-char password saved to the vault with a note.
9. Docs: `docs/security.md` (what is protected, what is not yet), README Security section, installer text.

LATER (not this MVP — leave stubs/notes, do not build): Temporary users, Master Reset Password escrow and
`--force-reset`, Homelab/Business editions, access modes + WireGuard, tamper check, audit timeline,
least-privilege token split, rotation-in-target.

## Interfaces (the contract between workstreams)

### Broker — `apps/api/src/lib/vault/broker.ts` (owner: BROKER)
Uses `@bitwarden/cli` **2026.10.0** as an `apps/api` dependency (binary `node_modules/.bin/bw`), one
isolated `BITWARDENCLI_APPDATA_DIR` per signed-in session under `/dev/shm/hyperprox-vault/<sid>` (tmpfs,
0700, removed on sign-out/lock). Server URL from `VAULT_URL` (default `http://127.0.0.1:8222`).
Registration/org/TOTP crypto (no CLI support for these) in `apps/api/src/lib/vault/bw-crypto.ts`, using
only Node `crypto` (PBKDF2-SHA256 600000, HKDF expand, AES-256-CBC+HMAC-SHA256 EncString type 2,
RSA-2048 OAEP-SHA1 EncString type 4).

```ts
export type Role = 'owner' | 'admin' | 'operator' | 'viewer'
export interface VaultSession { sid: string; email: string; role: Role; userId: string }
export interface SecretItem { name: string; fields: Record<string, string>; notes?: string; id: string }

export interface VaultBroker {
  status(): Promise<{ reachable: boolean; bootstrapped: boolean }>      // bootstrapped = HyperProx org exists
  bootstrapOwner(email: string, masterPassword: string): Promise<{ totpSecret: string; otpauthUri: string }>
  confirmOwnerTotp(email: string, masterPassword: string, code: string): Promise<void>
  signIn(email: string, masterPassword: string, totp: string): Promise<VaultSession>   // throws VaultAuthError
  verifyPassword(sid: string, masterPassword: string): Promise<boolean>                // re-confirmation
  signOut(sid: string): Promise<void>
  listSecrets(sid: string): Promise<SecretItem[]>                                      // HyperProx collection
  upsertSecret(sid: string, name: string, fields: Record<string, string>, notes?: string): Promise<SecretItem>
  deleteSecret(sid: string, name: string): Promise<void>
  createSend(sid: string, text: string, opts?: { hours?: number; maxViews?: number; password?: string }): Promise<{ url: string; expiresAt: string }>
}
export class VaultAuthError extends Error { code: 'bad_credentials' | 'totp_required' | 'totp_invalid' | 'not_member' | 'locked_out' }
export function getBroker(): VaultBroker
```

### Unlock state — `apps/api/src/lib/vault/state.ts` (owner: BROKER)
```ts
export function isUnlocked(): boolean
export function unlock(fromSid: string): Promise<void>       // loads secrets via broker into memory, new signing key
export function lock(reason: 'idle' | 'manual' | 'restart'): Promise<void>  // wipes cache, key, all bw dirs
export function signingKey(): Buffer | null                  // null when locked
export function cachedSecret(name: string): SecretItem | undefined
export function putCachedSecret(item: SecretItem): void
export function touch(): void                                // resets the idle timer
export function onLock(cb: () => void): void
```

### Gate API — owner: GATE
Routes (`apps/api/src/routes/auth.ts`, replacing the password routes):
- `GET  /api/auth/status` → `{ locked, bootstrapped, reachable, user?: { email, role } }`
- `POST /api/auth/bootstrap` `{ email, password }` → `{ otpauthUri }` (only while not bootstrapped)
- `POST /api/auth/bootstrap/confirm` `{ email, password, code }` → session cookie (owner, unlocked)
- `POST /api/auth/sign-in` `{ email, password, code }` → session cookie
- `POST /api/auth/sign-out`, `POST /api/auth/lock` (owner/admin)
- `POST /api/auth/reconfirm` `{ password }` → `{ until }`
Secrets (`apps/api/src/routes/secrets.ts`): `GET /api/secrets` (names, updatedAt), `POST /api/secrets/reveal`
`{ name }` (re-confirmed), `POST /api/secrets/send` `{ name, field?, hours?, maxViews?, password? }`,
`POST /api/secrets/generate` `{ name, purpose, length? }`.
JWT: `@fastify/jwt` with `secret` as a function returning `signingKey()`; payload `{ sid, email, role }`.
Gate hook in `apps/api/src/index.ts` (the existing `onRequest` hook is replaced). `lib/credentials.ts`
re-implemented over `state.ts`/broker with the same exports; `seedFromEnv` becomes the migration.
CLI: `bin/hyperprox` gains `lock` and `status` (calls the API on localhost).

### UI — owner: UI (`apps/frontend`)
- `/login`: shows **Create the owner account** (email, master password ×2, strength hint, then QR from
  `otpauthUri` + 6-digit confirm) when `bootstrapped=false`; otherwise **Sign in** (email, master password,
  2FA code). Clear copy: "Your vault master password unlocks HyperProx. It is never stored."
- Any API **423** → go to `/login` with "HyperProx is locked"; **401** → `/login`.
- Header: signed-in email + role badge; **Lock now** button (owner/admin).
- `/settings/secrets`: list, Reveal (re-confirm modal), Send (modal → link with copy button), Generate.
- Follow the design language: Barlow Condensed / Barlow / IBM Plex Mono, navy `#0a111c`, teal `#2fd6e8`.

### Infra — owner: INFRA
`docker-compose.yml` service + volume `vault_data`; `install.sh`: pull pinned image, generate admin token
(plain → `.env` `VAULT_ADMIN_TOKEN`, argon2 PHC → compose env via `.env` `VAULT_ADMIN_TOKEN_HASH`), start
the vault **before** the API (systemd `After=`/`Requires=` on a `hyperprox-vault` readiness check), API unit
refuses to start if the vault is unreachable (clear journal message); remove the wizard's create-admin step
and the `SETUP_ADMIN_*` adoption (wizard ends by sending the user to `/login` to create the owner);
`bin/hyperprox` CLI wrapper (`status`, `lock`); `docs/security.md`; README "Security" section + update
Known Issues / roadmap lines that the gate makes stale.

## File ownership (do not edit files you do not own — ask the integrator instead)
- BROKER: `apps/api/src/lib/vault/**`, `apps/api/test/vault-*.test.ts`, `apps/api/package.json` (dep only)
- GATE: `apps/api/src/index.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/routes/secrets.ts`,
  `apps/api/src/lib/auth.ts`, `apps/api/src/lib/credentials.ts`, `apps/api/src/lib/crypto.ts`,
  `apps/api/test/gate-*.test.ts`
- UI: `apps/frontend/**`
- INFRA: `docker-compose.yml`, `install.sh`, `bootstrap.sh`, `apps/setup/**`, `bin/**`, `docs/security.md`,
  `README.md`, systemd unit text inside `install.sh`

## Rules
- Work only in your own git worktree on the build host. Never edit `/opt/hyperprox`
  (the live checkout), never restart `hyperprox-api`/`hyperprox-frontend`/any `hyperprox-*` container, never
  touch ports 3000/3001/3002/80/443/8222 on the host's live services.
- Test containers: name them `vgtest-<you>-*`, bind to `127.0.0.1` on ports 18000–18999, remove them when done.
- **The repo is PUBLIC**: no node names, IPs, guest IDs, hostnames or personal names in code, tests,
  comments or commit messages. Examples use `example.com` / `192.168.1.x`.
- Commit to your branch with messages ending:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01Uuyv3yE5y6oiwCCxFBH49u`.
  Use the repo's existing author: `git -c user.name="$(git log -1 --format=%an)" -c user.email="$(git log -1 --format=%ae)" commit ...`
- Do NOT push. The integrator merges and pushes.
- "Done" = your tests pass against real components (a real Vaultwarden container for BROKER/GATE), and
  `npx tsc --noEmit` is clean for the app you touched.
