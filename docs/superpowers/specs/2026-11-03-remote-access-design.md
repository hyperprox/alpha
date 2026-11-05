# Remote access — design

Status: design, 2026-11-03. Phase 1 (Tailscale and NetBird clients on nodes, containers and VMs) is
specified here and built alongside this document. Phase 2 items are listed at the end.

## Why

People reach a homelab from outside in one of two ways today: a port forward (which they should not do
for a hypervisor) or a mesh VPN client installed by hand on each machine. The second is right, and it is
tedious and easy to get subtly wrong. On a Proxmox node in particular, the defaults of both popular
clients are dangerous:

- **Tailscale** with `--accept-dns` (the default) rewrites `/etc/resolv.conf` to MagicDNS. If the tailnet
  has DNS settings, the node's resolver changes. With `--accept-routes`, a subnet another device advertises
  can overlap the cluster LAN, and the node then sends corosync and Ceph traffic into the tunnel.
- **NetBird** configures DNS and accepts routes from the management server by default in the same way.
- Either client turned into a **subnet router or exit node** on a hypervisor invites cluster traffic onto
  the overlay. Corosync tolerates a few milliseconds of jitter at best; HA fencing does not forgive it.

HyperProx already holds a login for every node, runs commands inside containers with `pct exec` and inside
VMs through the guest agent, and keeps credentials in the vault. So it can install, configure, check and
remove these clients everywhere, with safe defaults it enforces and checks it runs before and after.

## Goals

- First-class support for **Tailscale** and **NetBird** (NetBird Cloud or a self-hosted management URL).
- Deploy onto **Proxmox nodes**, **LXC containers**, **VMs** and hand-added **Terminal hosts**.
- Keys minted **per install**, single-use where the provider supports it, short-lived, never logged, never
  on a command line, never written to the target's disk by HyperProx, never sent to the browser (one
  deliberate exception, the manual flow below, is gated by re-confirmation).
- Safe defaults on nodes that the admin cannot forget: no DNS changes, no accepted routes, no advertised
  routes, guarded by a before/after check with automatic rollback.
- One page, in plain English, that shows every machine and its state with each provider.

## Non-goals

- Running a control plane. HyperProx talks to Tailscale's or NetBird's; self-hosting NetBird's management
  server is phase 2.
- ACL or policy editing in either provider. Tags (Tailscale) and groups (NetBird) are chosen per install;
  what they may reach is the provider's policy, edited there.
- Headscale, ZeroTier, plain WireGuard. The provider interface leaves room; nothing is built.
- Automated installs on Windows or macOS. Those get the official download link and a one-time key.

## Why core, not a plug-in

Plug-ins never see a credential (lib/plugin-host.ts): the host makes their HTTP calls for them. Remote
access needs node logins, `pct exec`, the guest agent and the Proxmox API to change a container's devices.
That is exactly what plug-ins are designed not to reach, so it lives in core, like Updates and
Certificates.

## Providers

Both live behind one interface (`lib/remote/providers.ts`):

```ts
interface RemoteProvider {
  id: 'tailscale' | 'netbird'
  test(): Promise<string>                                      // "Connected — 12 devices"
  mintKey(o: { name: string; tags: string[] }): Promise<{ id: string; secret: string; expiresAt: string }>
  revokeKey(id: string): Promise<void>
  listDevices(): Promise<ProviderDevice[]>                    // id, name, addresses, online, lastSeen, version
  deleteDevice(id: string): Promise<void>
  setRouting(device: ProviderDevice, r: { subnets: string[]; exitNode: boolean }): Promise<void>
}
```

### Tailscale

- **Credential** (vault item `hyperprox:remote/tailscale`): either an API access token (`api_token`) or an
  OAuth client (`oauth_client_id`, `oauth_client_secret`). OAuth wins when both are set; its access token is
  fetched from `/api/v2/oauth/token` and kept in memory until a minute before it expires. Optional `tailnet`
  (default `-`, the credential's own) and `default_tags`.
- **Keys**: `POST /api/v2/tailnet/{tailnet}/keys` with `reusable: false`, `ephemeral: false`,
  `preauthorized: true`, the install's tags, and `expirySeconds: 600`. A key minted by an OAuth client must
  carry tags (Tailscale's rule); HyperProx refuses before calling when none are given. Tags are validated
  (`tag:[a-z0-9-]+`). The key is revoked (`DELETE …/keys/{id}`) as soon as the install finishes, whether it
  was used or not.
- **Devices**: `GET /api/v2/tailnet/{tailnet}/devices?fields=all`. Matched to a machine by the node id the
  client reports (`tailscale status --json` → `Self.ID` = device `nodeId`).
- **Remove**: `DELETE /api/v2/device/{id}`.
- **Routing**: `tailscale set --advertise-routes=… / --advertise-exit-node` on the machine, then
  `POST /api/v2/device/{id}/routes` to approve exactly those routes.

### NetBird

- **Credential** (`hyperprox:remote/netbird`): `management_url` (default `https://api.netbird.io`, or a
  self-hosted URL) and a personal access token `api_token` (`Authorization: Token …`). The URL must be
  `https://`; plain `http://` is accepted only for a loopback or private address, for testing.
- **Keys**: `POST /api/setup-keys` with `type: one-off`, `usage_limit: 1`, `ephemeral: false` and the
  install's groups (resolved from names to ids through `GET /api/groups`). NetBird's minimum expiry is one
  day (86400 s), so HyperProx asks for exactly that and **deletes the key** (`DELETE /api/setup-keys/{id}`)
  the moment the install ends.
- **Peers**: `GET /api/peers`, matched by the overlay address the client reports (`netbird status --json`
  → `netbirdIp`).
- **Remove**: `DELETE /api/peers/{id}`.
- **Routing**: a network route (`POST /api/routes`) with the peer as routing peer, distributed to the
  `All` group; an exit node is the route `0.0.0.0/0`. Turning it off deletes the routes HyperProx created.

### Secrets handling

- Provider credentials are vault items like every other integration, edited under **Settings →
  Credentials → Remote access**, masked on read, with a **Test** button.
- A minted key exists only in the API's memory for the length of one install. It travels to the target
  inside the script on **stdin** of the SSH channel (`bash -s`, `pct exec … -- bash -s`, or the guest agent's
  `--pass-stdin`), so it is on no command line and in no staged file on the node or in the guest. Inside the
  script it is piped to the client: `tailscale up --auth-key=file:/dev/stdin`, `netbird up
  --setup-key-file /dev/stdin`. The only copy that persists on the target is the state the client keeps
  itself (node key, not the auth key).
- Every line of output that reaches the job log passes through a redactor that replaces the key (and any
  `tskey-`/setup-key-shaped string) with `[redacted]`, before it is stored or streamed.
- Errors from the provider APIs are reduced to status and message; request bodies and headers are never
  included.

## Deploy targets

| Target | Transport | Notes |
|---|---|---|
| Proxmox node | node login over SSH (`bash -s` on stdin) | safety guard (below) |
| LXC container | node login → `pct exec <id> -- bash -s` | `/dev/net/tun` check |
| VM, agent answers | node login → `qm guest exec <id> --pass-stdin 1 -- bash` | agent pinged first through the Proxmox API |
| VM, no agent | the Terminal's saved login for `qemu-<id>` and its remembered address | `sudo -n` when not root |
| Terminal host | the Terminal's saved login for that host | same as above |

Host keys use the Terminal's pins: a changed key is refused.

### Operating systems

The first step on every target is a read-only detection script: `/etc/os-release` (`ID`, `ID_LIKE`,
`VERSION_ID`, `VERSION_CODENAME`), the package manager, the architecture, `systemd` present, whether
`/dev/net/tun` exists and opens, whether the client is already installed, and (on a node) `pvecm status`.

- **apt** (Debian, Ubuntu, Proxmox VE, Raspberry Pi OS, anything `ID_LIKE=debian` with a codename):
  official repositories — `pkgs.tailscale.com/stable/<debian|ubuntu>/<codename>` with its keyring, and
  `pkgs.netbird.io/debian stable main` with its key.
- **dnf** (RHEL, Rocky, Alma, CentOS Stream, Fedora, Oracle): Tailscale's `.repo` file for the family and
  major version; NetBird's `pkgs.netbird.io/yum` repository.
- Anything else — Alpine, Arch, NixOS, no `systemd`, an unknown codename — is **refused** with the reason,
  before anything is changed.
- **Windows and macOS** (a VM whose `ostype` is `win*`, or `uname` says `Darwin`): no automated install.
  The page shows the official download link and offers a one-time key (see Manual flow).

### Containers and `/dev/net/tun`

An unprivileged container has no `/dev/net/tun` unless the admin gave it one. Detection reports it, and
the plan then offers two ways on, in this order:

1. **Give the container the device** — the exact change is `dev<N>: /dev/net/tun` (first free `N`). HyperProx
   makes it through the Proxmox API (`PUT /nodes/{node}/lxc/{id}/config`), never by editing the config file
   and never by appending to it. Proxmox may refuse a device change from an API token (it does for anything
   short of `root@pam` on some versions); HyperProx then shows the one command that makes the same change
   (`pct set <id> --dev<N> /dev/net/tun`) for the admin to run. The device appears after the container's
   next restart, which HyperProx does not do on its own.
2. **Userspace networking** — Tailscale's `tailscaled --tun=userspace-networking` (set in
   `/etc/default/tailscaled`), NetBird's `NB_USE_NETSTACK_MODE=true` service environment. The machine can
   be reached over the overlay; its own outbound traffic does not go through it.

The admin chooses; the install refuses to guess.

## Safe defaults (Proxmox nodes)

These are not options with defaults; they are what HyperProx sends, and the planner rejects any request
that would change them on a node unless the explicit routing action is used.

| | Tailscale | NetBird |
|---|---|---|
| Keep the resolver | `--accept-dns=false` | `--disable-dns` |
| Keep the routing table | `--accept-routes=false` | `--disable-client-routes` |
| Do not route for others | no `--advertise-*` | `--disable-server-routes` |

Guests get the same flags by default: a container whose resolver changes under it is just as broken, and
the admin can still turn on routing per machine.

**Routing on a node** (subnet router or exit node) is a separate per-machine action. It needs
`acknowledge: true` in the request, which the page sends only after showing: "Cluster traffic (corosync,
Ceph, migration) must stay on the LAN. Advertising a subnet that contains the cluster network from a node
can move that traffic into the tunnel and get nodes fenced." A subnet that contains the node's own cluster
address is refused outright.

### Guard: before, after, roll back

On a node, the runner takes a snapshot before and after `up` (and around update and routing changes):

- the default route (`ip -4 route show default`, `ip -6 route show default`),
- the resolver (`nameserver` and `search` lines of `/etc/resolv.conf`, and its symlink target),
- quorum (`pvecm status` → `Quorate: Yes`).

If any of the three changed, or quorum cannot be read, the runner **rolls back at once**: `down`, remove the
package and repository it added, delete the device or peer from the provider, revoke the key, then take the
snapshot again and report both the change and whether the rollback restored the original. A node that is
not quorate before the install is not touched.

### One node at a time

A bulk install runs serially in the order shown, every target type alike. It stops at the first failure
and leaves the rest pending; nothing retries on its own. Only one remote-access job runs at a time.

## Per-machine actions

| Action | Role | Re-confirm |
|---|---|---|
| See status (table, provider device list) | viewer | no |
| Check now (runs the status script on the machine) | admin | no |
| Install (single or bulk) | admin | yes |
| Update the client | admin | no |
| Subnet router / exit node on or off | admin | yes |
| Give a container `/dev/net/tun` | admin | yes |
| Uninstall (client removed, device or peer deleted) | admin | yes |
| One-time key for a manual install | admin | yes |

Every write is in the audit log (`remote.install`, `remote.update`, `remote.routing`, `remote.uninstall`,
`remote.tun`, `remote.manual-key`) with the user, the machine and the provider; never a key. Because each
write needs a re-confirmation, API tokens cannot drive them (a token cannot re-confirm), which is
intended: a leaked token must not be able to open a tunnel into the cluster.

Status shows: connected, provider IP, client version, last seen, and whether the machine matches a device
in the provider's list (an install whose device was deleted from the provider's console shows as
"missing at provider").

## Data

A small table, `RemoteAccessDevice`, one row per machine and provider: machine id
(`node:<name>`, `lxc:<id>`, `qemu:<id>`, `host:<id>`), provider, the provider's device id and node id,
hostname, overlay address, mode (`kernel` or `userspace`), routes and exit node HyperProx turned on, the
NetBird route ids it created, timestamps and the last error. Nothing in it is secret. Jobs are in memory,
like Catalogue installs; the audit log is the history.

## API (`/api/remote`)

```
GET    /overview                       machines × providers, status merged with the provider's device list
GET    /jobs/:id                       one job with steps and its redacted log (admin)
POST   /jobs                           { action: install, provider, machines[], tags?, groups?, mode? } (admin, re-confirm)
POST   /machines/:id/:provider/check   run the status script (admin)
POST   /machines/:id/:provider/update  (admin)
POST   /machines/:id/:provider/routing { subnets[], exitNode, acknowledge } (admin, re-confirm)
DELETE /machines/:id/:provider         uninstall (admin, re-confirm)
POST   /machines/:id/tun               give a container /dev/net/tun through the Proxmox API (admin, re-confirm)
POST   /machines/:id/:provider/manual-key  one-time key + download link, Windows/macOS (admin, re-confirm)
POST   /api/settings/test/remote/:provider  the Test button
```

## UI

- **Remote access** page under MANAGE: a short explanation, a provider strip (configured or not, with a link
  to Settings), and one table — every node and guest, with a column per provider showing a status chip
  (Connected / Offline / Not installed / Missing at provider / Unsupported) and the overlay address. Rows
  are selectable; **Install on selected** picks a provider, tags or groups and the container mode, then
  runs as one job with per-machine steps and live output. Each cell has a menu for the admin actions.
- Viewers and operators see the table without checkboxes or menus.
- Settings → Credentials gains a **Remote access** tab with a Tailscale and a NetBird section, using the
  existing provider form and Test button.

## Manual flow (Windows, macOS, anything unsupported)

The page shows the official download page and, on request, a one-time key: Tailscale `reusable: false`,
10 minutes; NetBird `one-off`, one use, deleted by HyperProx after 30 minutes (NetBird's own one-day
minimum lifetime applies if HyperProx restarts before then). This is the one place a key reaches the browser. It needs a re-confirmation, is shown
once and never stored, and the request is audited. The device is matched on the next overview by hostname.

## Testing

- Provider clients against a mocked `fetch`: request shapes, auth headers, OAuth token caching, tag and
  expiry rules, error reduction that leaves no secret in a message.
- Planner: OS support matrix, refusals, `/dev/net/tun` handling, the exact flags per provider and target,
  node routing refusals.
- Guard: snapshot parsing and every rollback trigger (route, resolver, quorum lost, unreadable quorum).
- Runner with a fake executor: serial order, stop at first failure, key revoked on every path, output
  redacted, device recorded and deleted.
- Routes behind the real gate: viewer reads, admin writes, re-confirmation, token refusal.
- End to end (opt-in, `HP_E2E_DOCKER=1`): a throwaway Debian container, the real repository setup and
  package install, a mocked provider API, and a recording stand-in for the client's `up` that proves the
  key arrived on stdin and never on disk or argv.

## Revision after the security review (2026-11-03)

The review found the first build too trusting in places. These replace the corresponding text above where
they differ; docs/remote-access.md describes the result.

- **Durable revocation.** `RemoteAccessPendingRevoke` holds every key id that has left HyperProx until the
  provider confirms it is revoked (`keyRevoked`). A sweep runs at start-up (revoking every leftover install
  key at once), after unlock and every minute; manual keys are rows due in 30 minutes. `close()` waits,
  with a limit, for revokes in flight.
- **Durable guard.** `RemoteAccessInflight` holds a node change between its before-snapshot and its verdict,
  with a serialisable undo plan. A row left by another process is re-checked on boot and rolled back when
  the node differs. Finished jobs are pruned after six hours.
- **Firewall.** Nodes: Tailscale `--netfilter-mode=off`, NetBird `--disable-firewall=true`; every NetBird
  boolean explicit; never `--allow-server-ssh`. A previewed, confirmed node rule for TCP 22 and 8006 on the
  overlay interface from 100.64.0.0/10, through the Proxmox API, only when the cluster firewall is on.
- **Guard.** All routing tables and policy rules (normalised; the client's own interface, table and rules
  allowed, never a default route), `ip route get` to every corosync and Ceph peer, per-link DNS, ruleset
  hashes, corosync links, forwarding; the after-check 15 s after the change.
- **Routing.** NetBird routes go to a `hyperprox-routes` group; exit nodes carry `skip_auto_apply`; no exit
  node on a node; the overlap check covers every cluster network, IPv4 and IPv6; the result is read back
  from the client (NetBird config, Tailscale advertised routes). No forwarding change on nodes; a guest's
  previous values are restored.
- **Existing clients** need Adopt or Replace; Replace and uninstall keep the client state aside to put back.
  Devices are deleted only by recorded id. A failed install is always cleaned up.
- **Smaller fixes.** Stream redaction across chunks; NetBird https only and no redirects; SSH to VMs and
  hand-added hosts requires a pinned key; raw `lxc` tun entries and the config digest; below-admin overview
  without addresses; re-confirmation for check and update on nodes.

### Round 2 (before any install on a real node)

- **Guard.** A client's own routes only inside its overlay prefixes (100.64.0.0/10, and fd7a:115c:a1e0::/48
  for Tailscale) or of type local, broadcast, multicast or throw; /1 splits and anything else in table
  52/7120 refused; each policy rule pinned to its exact priority and shape; paths to gateways, resolvers and
  IPv6 Ceph monitors.
- **Firewall as text**, not a hash: nftables, iptables/ip6tables on both backends, ipset, ebtables, with
  fail2ban, per-guest chains, PVESIG, timed set elements and counter values left out; a firewall-only
  difference gets a second sample and what keeps moving between the two is discounted.
- **Recovery** waits for the dead job's own script (it records its pid in /run) and apt/dpkg, settles, always
  undoes an interrupted install, and finds its device by the identity `up` reported, which is saved at once.
- **Replace rollback** restores the package version, the unit and its environment, and the enabled/active
  state, and shreds the copy; a failed restore keeps it at 0700 and says how to remove it.
- **Sweeps** never touch a key of an install running in this process. NetBird flags come from the running
  daemon's config. Every SSH path needs a pinned host key, with a check-and-trust action sharing the
  Terminal's pins.
- **Migrations**: the first stays as it was; `20261105170000_remote_access_durability` adds the rest.

## Phase 2

- **Self-hosted NetBird recipe** in the Catalogue. It does not fit the current recipe model cleanly:
  NetBird's management server needs a public DNS name, TLS, UDP 3478 and 51820 open, and an identity
  provider (or the newer embedded one) set up before any token exists to connect it with. That is a
  multi-step guided flow (DNS through HyperProx, certificate through Certificates, then a first-user
  token), not a container plus a script.
- Headscale as a third provider (Tailscale client, `--login-server`).
- Scheduled status refresh and notifications when a node's client goes offline.
- Rolling client updates through the Updates feature rather than per machine.
