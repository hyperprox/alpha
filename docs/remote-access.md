# Remote access

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
  `https://netbird.example.com`). It must be `https://`.
- **Personal access token**: NetBird dashboard → Team → Users → your user (or a service user) → *Create
  token*. It needs to manage setup keys, peers and routes.
- **Default groups**: groups new peers join, by name. They must already exist in NetBird.

## Install

Open **Remote access**, tick the machines, choose the provider and press **Install on selected**. Machines
are done one at a time, in the order shown, and the run stops at the first failure. Each machine gets:

1. A read-only check of its operating system.
2. The client from the official repository: `pkgs.tailscale.com` or `pkgs.netbird.io`, through apt
   (Debian, Ubuntu, Proxmox VE and their derivatives) or dnf (RHEL, Rocky, Alma, CentOS Stream, Fedora).
   Other systems are refused before anything is changed.
3. A key made for this one install: single use, not ephemeral, short-lived. It is handed to the client on
   a pipe and revoked as soon as the install finishes, whether it was used or not.
4. A check that it connected, matched to the provider's device list.

How HyperProx reaches each machine:

| Machine | How |
|---|---|
| Proxmox node | The node's login (saved in the Terminal) over SSH |
| Container | That node's login, then `pct exec` |
| VM | The QEMU guest agent from its node; without the agent, the VM's Terminal login over SSH |
| Hand-added host | Its Terminal login over SSH |

A login that is not `root` must be able to use `sudo` without a password.

### Containers and /dev/net/tun

An unprivileged container has no `/dev/net/tun` unless it was given one, and the install stops and tells
you so. You have two choices:

- **Add /dev/net/tun**. HyperProx adds `devN: /dev/net/tun` through the Proxmox API (it never edits the
  container's config file). It takes effect when the container next restarts, which HyperProx leaves to
  you. If Proxmox refuses the change from HyperProx's API token, the page shows the equivalent command,
  `pct set <id> --devN /dev/net/tun`, to run on the node.
- **Userspace networking**: tick the option when installing. The container can be reached over the
  overlay, but its own outgoing traffic does not use it.

### Windows and macOS

HyperProx does not install on these. The machine shows **Manual install**: use **One-time key…** to get a
single-use key (after re-entering your master password) and the official download link, then sign the
app in with that key. The key is shown once and not stored. A Tailscale key expires after 10 minutes;
HyperProx deletes a NetBird key after 30 minutes.

## What HyperProx guarantees on a Proxmox node

- **The node keeps its resolver and routing table.** Tailscale runs with `--accept-dns=false
  --accept-routes=false`; NetBird with `--disable-dns --disable-client-routes --disable-server-routes`.
  These are not defaults you can forget to set: they are what HyperProx sends.
- **Nothing is advertised** (no subnet routes, no exit node) unless you turn routing on for that machine.
- **Checked before and after.** HyperProx records the IPv4 and IPv6 default routes, the resolver
  (`/etc/resolv.conf` and where it points) and `pvecm status` quorum. A node that is not quorate is not
  touched. If anything differs afterwards, HyperProx rolls the install back on the spot (client removed,
  device deleted from the provider), checks again, and reports what changed and whether the node is back as
  it was.
- **One node at a time**, stopping at the first failure.

Guests get the same safe flags.

## Per-machine actions

| Action | Who | Notes |
|---|---|---|
| See status | everyone | Connected, provider IP, version, last seen, matched to the provider's device list |
| Check | admin | Runs the client's status command on the machine |
| Update | admin | Upgrades only the client package (guarded on nodes) |
| Routing… | admin, re-confirm | Subnet router and exit node; see below |
| Uninstall | admin, re-confirm | Removes the client, its state and repository, then deletes the device or peer |
| Install, One-time key, Add /dev/net/tun | admin, re-confirm | |

Status states: **Connected**, **Offline** (known to the provider, not connected), **Missing** (HyperProx
installed it but the provider no longer lists it), **Not installed**, **Manual install**. A device the
provider lists under the machine's name that HyperProx did not install shows as *not managed*.

## Routing (subnet router, exit node)

Off by default everywhere. Turning it on asks you to acknowledge:

> Cluster traffic (corosync, Ceph, migration) must stay on the LAN. Advertising a subnet that contains the
> cluster network from a node can move that traffic into the tunnel and get nodes fenced.

A subnet that contains the node's own cluster address is refused outright. With Tailscale, HyperProx runs
`tailscale set --advertise-routes=… --advertise-exit-node=…` and approves exactly those routes in the
Tailscale API. With NetBird, it creates network routes with this peer as the router, for the `All` group,
and removes exactly those when you turn routing off. Either way it turns IP forwarding on in
`/etc/sysctl.d/99-hyperprox-remote-access.conf` and removes that file when routing goes off.

## Troubleshooting

- **"Tailscale only lets an OAuth client make keys that carry at least one tag"**: set Default tags, or use
  an API access token.
- **"NetBird has no group called …"**: create the group in NetBird first, or clear Default groups.
- **"No login saved for node …"**: add the node's login in the Terminal. Node logins are never borrowed
  from the shared guest login.
- **"… reports no release codename"**: the system is too unusual to pick a repository for; install by hand.
- **An install was rolled back**: the job says what changed. Nothing is retried on its own.
