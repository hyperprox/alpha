# VPN (remote access)

HyperProx installs and manages a mesh VPN client, **Tailscale** or **NetBird**, on your Proxmox nodes,
containers, VMs and the hosts you added by hand in the Terminal. You can then reach them from anywhere
without opening a port on your router.

Design: [superpowers/specs/2026-11-03-remote-access-design.md](superpowers/specs/2026-11-03-remote-access-design.md).

## Set up a provider

**Settings → Credentials → Remote access**, then **Save** and **Test**.

### Tailscale

Either an **API access token**, or an **OAuth client** (ID and secret). OAuth is used when both are set.

- An API access token: Tailscale admin console → Settings → Keys → *Generate access token*.
- An OAuth client: Settings → OAuth clients, with the **Devices: Core** (write) and **Keys: Auth keys**
  (write) scopes, and the tags it may assign. Tailscale only lets an OAuth client make keys that carry a
  tag, so set **Default tags** (for example `tag:server`) or choose tags when you install. Every tag must
  exist in your tailnet policy's `tagOwners`.
- **Tailnet**: leave blank for the token's own tailnet.

### NetBird

- **Management URL**: blank for NetBird Cloud, or your self-hosted address (for example
  `https://netbird.example.com`). It must be `https://`, with no exception for local addresses: the token
  travels in a header. HyperProx never follows a redirect, so the token only goes to the address you set.
- **Personal access token**: NetBird dashboard → Team → Users → your user (or a service user) → *Create
  token*. It needs to manage setup keys, peers, groups and routes.
- **Default groups**: groups new peers join, by name. They must already exist in NetBird.

## Install

Open **Remote access**, tick the machines, choose the provider and press **Install on selected**. Machines
are done one at a time, in the order shown, and the run stops at the first failure. Each machine gets:

1. A read-only check of its operating system, and of whether a client is already there.
2. The client from the official repository: `pkgs.tailscale.com` or `pkgs.netbird.io`, through apt
   (Debian, Ubuntu, Proxmox VE and their derivatives) or dnf (RHEL, Rocky, Alma, CentOS Stream, Fedora).
   Other systems are refused before anything is changed. NetBird's dnf repository is set up as NetBird
   publishes it, with `gpgcheck=0` and `repo_gpgcheck=1`: the repository metadata is signed, the packages
   themselves are not individually signature-checked.
3. A key made for this one install: single use, not ephemeral, short-lived. It is recorded (by id) for
   revocation before it leaves HyperProx, handed to the client on a pipe, and revoked as soon as the
   install ends, used or not. HyperProx then asks the provider to confirm the key is dead before it forgets
   it; until then a sweep retries every minute, and at every start-up.
4. A check that it connected, matched to the provider's device list by the identity the client itself
   reports (Tailscale's node id, or the overlay address). Never by name.

If any step fails, the machine is cleaned up: the client is removed again (or, if one was there before, put
back as it was) and the result is in the job.

How HyperProx reaches each machine:

| Machine | How |
|---|---|
| Proxmox node | The node's login (saved in the Terminal) over SSH |
| Container | That node's login, then `pct exec` |
| VM | The QEMU guest agent from its node; without the agent, the VM's Terminal login over SSH |
| Hand-added host | Its Terminal login over SSH |

A login that is not `root` must be able to use `sudo` without a password. Every path needs a pinned host
key: the node's for nodes, containers and the guest agent, the machine's own for SSH. HyperProx refuses an
unpinned host and shows its fingerprint; check it against the machine and press **Trust this key** (or
accept it in the Terminal). Pins are shared with the Terminal, so a node you already opened there works as
it is. A different key already pinned is never replaced from the Remote access page.

### A client that is already there

If Tailscale or NetBird is already on a machine and HyperProx did not install it, the install refuses it
unless you choose what to do in the install dialog:

- **Adopt**: record it as it is. No key, no package, no `up`; nothing on the machine changes. It must
  already be signed in to the configured account.
- **Replace**: sign it in to the configured account. Its state, repository file, systemd unit and its
  environment, the exact package version, and whether the service was enabled and running are copied aside
  first (root-only). If anything goes wrong, all of it is put back, the package downgraded to the version it
  had, and the copy is then overwritten and removed. If putting it back fails, the copy is kept at
  `/var/lib/hyperprox-remote-access/<client>` (mode 0700) and the job says how to remove it.

### Containers and /dev/net/tun

An unprivileged container has no `/dev/net/tun` unless it was given one, and the install stops and tells
you so. You have two choices:

- **Add /dev/net/tun**. HyperProx adds `devN: /dev/net/tun` through the Proxmox API, with the config's
  digest so a concurrent edit is not overwritten (it never edits the container's config file). It takes
  effect when the container next restarts, which HyperProx leaves to you. If Proxmox refuses the change
  from HyperProx's API token, the page shows the equivalent command, `pct set <id> --devN /dev/net/tun`.
  A tun device given through raw `lxc.*` lines is recognised too.
- **Userspace networking**: tick the option when installing. The container can be reached over the
  overlay, but its own outgoing traffic does not use it.

### Windows and macOS

HyperProx does not install on these. The machine shows **Manual install**: use **One-time key…** to get a
single-use key (after re-entering your master password) and the official download link, then sign the
app in with that key. From a terminal on macOS, pass it on stdin, never as an argument
(`tailscale up --auth-key=file:/dev/stdin …` or `netbird up --setup-key-file /dev/stdin …`, paste, Ctrl-D).
The key is shown once and not stored. A Tailscale key expires after 10 minutes; HyperProx revokes either
kind after 30 minutes, and that revocation survives a restart.

## What HyperProx guarantees on a Proxmox node

- **The node keeps its resolver and routing table.** Tailscale runs with `--accept-dns=false
  --accept-routes=false`; NetBird with `--disable-dns=true --disable-client-routes=true
  --disable-server-routes=true`. These are not defaults you can forget to set: they are what HyperProx
  sends, every NetBird flag written out as `=true` or `=false`.
- **The Proxmox firewall stays the only firewall.** Tailscale runs with `--netfilter-mode=off` and
  NetBird with `--disable-firewall=true`, so neither adds rules of its own. NetBird is never given
  `--allow-server-ssh`.
- **Nothing is advertised** (no subnet routes) unless you turn routing on for that node, and a node is
  **never** an exit node.
- **Checked before and after.** HyperProx records, on the node: every routing table and policy rule
  (Tailscale's table 52 included); the route (`ip route get`) to every corosync peer, every Ceph monitor
  (IPv4 and IPv6), the default gateways and the resolvers; the resolver (`/etc/resolv.conf` and
  systemd-resolved's per-link DNS); the firewall rules as text (nftables, iptables and ip6tables on both the
  nft and legacy backends, ipset, ebtables); `corosync-cfgtool -s` link state; IP forwarding; and
  `pvecm status` quorum. Values that tick on their own (router-advertisement lifetimes, cache ages,
  counters and quotas) are ignored, and so is firewall text that changes by itself: fail2ban's chains and
  sets, pve-firewall's per-guest chains and the jumps to them, its `PVESIG` signatures, and the elements of
  sets with timeouts. If only the firewall text differs, HyperProx takes one more sample and discounts what
  is still moving between the two. The client may add routes on its own interface or in its own table only
  inside its overlay (`100.64.0.0/10`, and `fd7a:115c:a1e0::/48` for Tailscale) or of type local,
  broadcast, multicast or throw, and only its own policy rules at their exact priorities; never a default
  route, a `/1` split or anything else in its table. A node that is not quorate, or has a corosync link
  down, is not touched. The after-check runs 15 seconds after the change, so delayed effects have time to
  show.
  If anything differs, HyperProx rolls the change back on the spot, checks again, and reports what changed
  and whether the node is back as it was.
- **A restart cannot skip the check.** A node change is recorded as in flight, with its before-snapshot,
  how to undo it and the device identity the client reported, until its guard passes. If HyperProx restarts
  in the middle, it waits (up to ten minutes) for the interrupted job's own script and for any apt or dpkg
  run to finish, lets the node settle, and re-runs the after-check. An interrupted install is always undone;
  any other change is rolled back if the node differs. If something is still running after ten minutes,
  HyperProx says so, undoes nothing, and checks again later. The page shows such a node until then.
- **One node at a time**, stopping at the first failure. Install, update, routing and uninstall on a node
  are all guarded.

Guests get the DNS and route flags too, and keep their client's own firewall handling.

### Reaching a node's web UI and SSH over the overlay

With the Proxmox firewall on and the client adding no rules, nothing from the overlay reaches the node
until you allow it. Allow exactly SSH and the web UI, on the overlay interface, from the overlay range:

```
# /etc/pve/nodes/<node>/host.fw, [RULES] (or Datacenter/Node → Firewall in the web UI)
IN ACCEPT -i tailscale0 -source 100.64.0.0/10 -p tcp -dport 22,8006 # HyperProx remote access: Tailscale
IN ACCEPT -i wt0 -source 100.64.0.0/10 -p tcp -dport 22,8006        # HyperProx remote access: NetBird
```

When the cluster firewall is enabled, the **Firewall…** action on a node shows this rule and, when you
confirm, adds it through the Proxmox API. It never opens corosync (5405–5412/udp), Ceph (3300, 6789,
6800–7300/tcp) or migration ports. If the cluster firewall is off, nothing blocks the overlay and there is
nothing to add.

## The VPN page

**VPN** in the sidebar lists every node and guest with a column per provider: state (connected, offline,
missing, not installed), overlay IP, MagicDNS or NetBird name, client version, last seen and key expiry. A
key that expires in less than 14 days is flagged.

- **Install** is one click. It uses the defaults from **Settings → Credentials → Remote access**: the
  default tags (Tailscale) or groups (NetBird), and whether a container or a VM lets the client manage its
  DNS (*One-click: MagicDNS on containers/VMs*, off unless set to `yes`). A Proxmox node always gets the
  locked-down node profile. The dialog lists what will happen in a few lines; one confirm (and your master
  password) starts it. **Advanced…** has the full dialog (tags, userspace mode, existing clients, signing in
  with your own account).
- **Settings…** opens the machine's panel. It reads the client's own settings back from the machine and
  lets you change them, with a preview in words of what each change does on that machine:
  - **Accept DNS** (MagicDNS / NetBird DNS): on, the client manages the machine's DNS so overlay names
    resolve; off (the default), `/etc/resolv.conf` is left alone.
  - **Accept routes** other devices offer.
  - **Tailscale SSH / NetBird SSH**: people your ACL or policy allows can open a shell over the overlay.
    For NetBird HyperProx also allows SSH on the peer in the management server.
  - **Use an exit node** (a Tailscale overlay IP or name, or a NetBird network route id), with **Allow LAN
    access** on by default so the machine keeps reaching the local network.
  - **Offer as an exit node** and **subnets to offer**, with the overlap checks below, approved in the
    tailnet through the Tailscale API (NetBird: network routes).
  Every change is confirmed from the client's own read-back (`tailscale debug prefs`, filtered so the node
  keys never leave the machine, or NetBird's config) and put back if the client did not take it. On a
  Proxmox node all of these are locked off.
- **Key expiry**: the panel shows the date and can turn expiry off for a server (Tailscale key expiry,
  NetBird login expiration), or back on.
- **Tags / groups**: shown and edited through the API. A Tailscale tag must be in your tailnet policy's
  `tagOwners` for the credential HyperProx uses, or Tailscale refuses it; tagging a device also removes its
  user ownership.
- **Waiting for approval**: if your tailnet or NetBird account requires device approval, devices waiting
  for it are listed with their OS and who added them, and can be approved or removed.

### Signing in with your own account

Instead of a key, **Advanced… → Sign in with my account** starts the client without one. The client prints
a sign-in link; HyperProx captures it from output it never logs, keeps it in memory only, shows it on the
machine's panel to admins (after your master password, with a copy button), and sends it to your
notification channels **marked private** (Settings → Notifications). The link works once and expires after
about ten minutes; after that, or after HyperProx restarts, it is gone and a **Check** gets a new one. The
same happens when a key has expired and the client is waiting for a sign-in of its own.

### New devices

Every few minutes HyperProx looks at each provider's device list and sends a notification (event family
*VPN*) for each device that was not there before, with its name, OS, who added it, and whether it is
waiting for approval. Devices HyperProx installed itself are not announced. The very first look only
learns what is there. While HyperProx is locked it does not look.

## API for other pages

Other pages (the guest drill-down, list badges) use `/api/remote/v1`, typed as `VpnStatusSource` in
`packages/types/src/remote.ts` and implemented in `apps/frontend/lib/vpn.ts`. Machine ids are `node-<name>`,
`lxc-<vmid>`, `qemu-<vmid>`.

| Call | Who | |
|---|---|---|
| `GET /v1/status` | any role | `{ providers, machines: VpnMachineStatus[] }` |
| `GET /v1/status/:machineId` | any role | one `VpnMachineStatus`, 404 when unknown |
| `GET /v1/machines/:id/:provider/install-preview` | admin | what a one-click install would do |
| `POST /v1/machines/:id/:provider/install` `{ confirm: true }` | admin, re-confirm | `202 { job }` |
| `DELETE /v1/machines/:id/:provider` | admin, re-confirm | uninstall, `202 { job }` |
| `GET /v1/machines/:id/:provider/settings` | admin | `{ current }`, read back from the client |
| `POST /v1/machines/:id/:provider/settings/preview` `{ prefs }` | admin | `{ current, desired, changes, refusal }` |
| `POST /v1/machines/:id/:provider/settings` `{ prefs, confirm: true }` | admin, re-confirm | `202 { job }` |
| `GET /v1/jobs/:id` | admin | progress; poll until `status` is not `running` |

`VpnMachineStatus.providers[p]` has `state`, `installed`, `ip`, `dnsName`, `version`, `lastSeen`,
`expiresAt`, `expiryWarning` and `panel` (a link to the machine's panel on the VPN page) for every role;
admins also get `loginPending`, `pending`, `tags`, `routes`, `exitNode` and `prefs`. A call that needs a
fresh master password answers `403 { code: 'reconfirm_required' }`.

## WireGuard

WireGuard is the third option, next to Tailscale and NetBird, on the same **VPN** page.

- **Servers** run in a container or VM, never on a Proxmox node. **New server…** installs `wireguard-tools`,
  makes the server's key inside the machine (`wg genkey`), and brings up `hp-wg0` with a listen port. The
  key never leaves that machine; wg-quick loads it from its own file, so the interface file HyperProx writes
  has no `PrivateKey` line. Optionally (off by default) a copy of the server key is also kept in the vault:
  a rebuilt server then keeps its key and no peer needs changing, but anyone who can reveal secrets in the
  vault could impersonate the server. A Catalogue recipe (`lib/vpn/wireguard/recipe.ts`) sets up the same
  server container in one click once the Catalogue wires it in.
- **Phones and laptops**: **Add phone or laptop…** makes the client's keypair **in your browser**
  (WebCrypto X25519) and shows the config once, as a QR code and a `.conf` download. The keypair and the
  config are kept in the vault, one item per peer, so you can show the QR again later (after your master
  password, audited), for example after a phone reset. If the browser cannot make the key, the server
  container makes it and it goes straight to the vault. Postgres holds only public keys, addresses and
  names.
- **Rotate key** replaces the vault item and the server's peer. The previous key is kept for seven days,
  marked *rotated*, so **Undo rotation** can put it back; after seven days it is deleted.
- **Peers** are added, changed and removed live (`wg syncconf`): other peers stay connected.
- **Connect a machine…** makes a node or guest a client of a HyperProx server or of the router. Its key is
  made on it and never leaves it; a rebuilt machine gets a new key and the other end is updated
  automatically. On a Proxmox node: no default route or `/1` split through the tunnel, nothing in
  AllowedIPs (or in its site-to-site subnets) may overlap a corosync link, a Ceph network or the node's own
  addresses, and the change goes through the same before/after guard and rollback as the mesh clients.

### The MikroTik router

If the MikroTik plug-in is set up, the VPN page shows the router's WireGuard interfaces and peers
(handshake, traffic, endpoint) as **Router**, read through the plug-in's own read-only connection. Private
and preshared keys in RouterOS's answers are dropped.

To add peers, HyperProx needs its **own login** on the router, never the admin one. Without it the
router view is read-only and shows these commands to create it:

```
/user group add name=hyperprox-wg policy=read,write,api,rest-api comment="HyperProx: WireGuard peers"
/user add name=hyperprox-wg group=hyperprox-wg comment="HyperProx: WireGuard peers" password="<a long random password>"
```

Be clear about what this login can do. RouterOS policies cover whole areas, not menus; RouterOS 7 has no
narrower policy for the WireGuard REST endpoints, and `write` lets the login change other configuration too.
The group leaves out `policy`, `sensitive`, `password`, `ssh`, `ftp`, `telnet`, `winbox`, `web`, `reboot`,
`test` and `sniff`, so it cannot manage users, read secrets or log in interactively. **"WireGuard peers
only" is enforced by HyperProx, not by RouterOS**: its REST writer refuses every path except
`/interface/wireguard/peers`. Keep the password in the vault only.

Then add it under **Settings → Credentials → Remote access → MikroTik WireGuard**. With it, HyperProx can:

- add a phone or laptop to a router WireGuard interface (browser keypair, config in the vault, QR), or
  connect a node or guest to it (its own key), previewed and read back;
- remove the peers it created. Every peer it creates carries `comment=hyperprox:<id>`; anything without
  that mark is never changed or removed;
- site-to-site: a node or guest peer whose AllowedIPs are its own subnets, with the overlap checks.

HyperProx never writes the router's firewall, addresses or routes. If no input rule lets UDP in on an
interface's listen port, the page shows the exact command for you to review and run yourself, nothing more.

### The Infrastructure VPN slot and tab

- **Server side**: `lib/guest-config/vpn.ts` (shared with the Infrastructure pages) defines the slot;
  `lib/remote/vpn-source.ts` fills it from this page's overview and is set with `setVpnStatusSource()` when
  the remote routes start. One status per guest, keyed `lxc/<vmid>` or `qemu/<vmid>`: the connected provider
  first, any other named in `detail`. While HyperProx is locked every guest is `unknown` with "HyperProx is
  locked" in `detail`.
- **The VPN tab**: `components/remote-access/GuestVpnPanel.tsx` exports `GuestVpnPanel`:

  | Prop | Type | |
  |---|---|---|
  | `type` | `'lxc' \| 'qemu'` | the guest's type |
  | `vmid` | `number` | its id |
  | `name` | `string?` | shown in headings |
  | `admin` | `boolean?` | show install, settings and uninstall (default: from the session role) |
  | `source` | `VpnStatusSource?` | default `lib/vpn.ts` (the `/v1` API above) |
  | `onChanged` | `() => void?` | called when a job finishes, to refresh the host page's badges |

  It shows each provider's state, overlay IP, name, version, last seen and key expiry, and for admins a
  one-click install with its preview, settings with a preview in words, and uninstall, asking for the
  master password when the API wants it.

## Per-machine actions

| Action | Who | Notes |
|---|---|---|
| See status | everyone | Below admin: connected or not, overlay IP, client version, last seen. No LAN or cluster addresses |
| Check | admin (re-confirm on a node) | Runs the client's status command on the machine |
| Update | admin (re-confirm on a node) | Upgrades only the client package (guarded on nodes) |
| Routing… | admin, re-confirm | Subnet router and, on guests, exit node; see below |
| Firewall… | admin, re-confirm | Nodes only: the rule above, previewed first |
| Uninstall | admin, re-confirm | Removes the client, its state and repository, then deletes the device or peer by its recorded id |
| Install, One-time key, Add /dev/net/tun | admin, re-confirm | |

Status states: **Connected**, **Offline** (known to the provider, not connected), **Missing** (HyperProx
installed it but the provider no longer lists it), **Not installed**, **Manual install**. A device the
provider lists under the machine's name that HyperProx did not install or adopt shows as *not managed*;
HyperProx never deletes it.

## Routing (subnet router, exit node)

Off by default everywhere. Turning it on asks you to acknowledge:

> Cluster traffic (corosync, Ceph, migration) must stay on the LAN. Advertising a subnet that contains the
> cluster network from a node can move that traffic into the tunnel and get nodes fenced.

- A subnet that overlaps any cluster network is refused: every corosync link, the Ceph public and cluster
  networks and monitors, and the node's own addresses, IPv4 and IPv6, read from the node (for a guest,
  from its node).
- **Tailscale**: `tailscale set --advertise-routes=… --advertise-exit-node=…`, then exactly those routes
  are approved in the Tailscale API, and HyperProx checks the machine really advertises them.
- **NetBird**: the client is reconnected with `--disable-server-routes=false` (or `=true` to turn routing
  off), and HyperProx reads the setting back from the config file the running daemon uses (its `--config`
  argument, else the active profile, else the only config present). If it cannot tell which file that is,
  the change is not confirmed and is rolled back. The routes are created with this
  peer as the router and distributed to the **`hyperprox-routes`** group only, which HyperProx creates the
  first time. Add the peers that should use the routes to that group. An exit node is created with
  *skip auto apply*, so no peer's default route moves until its user picks it.
- **Forwarding**: on a node, HyperProx never changes it. If IP forwarding is off, routing on that node is
  refused; turn it on yourself if you really want the node to route. On a guest, HyperProx records the
  forwarding values, turns forwarding on in `/etc/sysctl.d/99-hyperprox-remote-access.conf`, and puts the
  recorded values back when routing goes off.
- Any failure, or a result the client does not confirm, is rolled back.

## Troubleshooting

- **"Tailscale only lets an OAuth client make keys that carry at least one tag"**: set Default tags, or use
  an API access token.
- **"NetBird has no group called …"**: create the group in NetBird first, or clear Default groups.
- **"No login saved for node …"**: add the node's login in the Terminal. Node logins are never borrowed
  from the shared guest login.
- **"… has no pinned host key"**: open the machine in the Terminal once and accept its key after checking
  the fingerprint the message shows.
- **"… already runs Tailscale/NetBird"**: choose Adopt or Replace in the install dialog.
- **"… reports no release codename"**: the system is too unusual to pick a repository for; install by hand.
- **An install was rolled back**: the job says what changed. Nothing is retried on its own.
- **"N keys have not been confirmed revoked yet"**: the provider did not answer or still lists the key;
  HyperProx retries every minute. Check the provider's console if it persists.
