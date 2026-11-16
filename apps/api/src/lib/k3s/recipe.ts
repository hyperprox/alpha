// =============================================================================
//  HyperProx — K3s (lightweight Kubernetes): the Catalogue recipes
//
//  Two recipes:
//    k3s         a K3s server (control plane and a worker in one), the cluster
//    k3s-agent   one more worker for a K3s server HyperProx already looks after,
//                placed on another node where it can
//
//  Why a container, not a VM. HyperProx's installer makes containers only, and
//  a K3s server runs in an UNPRIVILEGED Debian 13 container on Proxmox 9 when
//  the container has nesting and keyctl and kubelet is told it is inside a user
//  namespace (the KubeletInUserNamespace feature gate, which K3s's own rootless
//  mode uses). It was tested that way: node Ready, CoreDNS, Traefik, ServiceLB,
//  metrics-server and a workload behind the ingress all ran. The well-known
//  "K3s in LXC" guides make the container privileged with AppArmor off and
//  every device allowed; that is root on the node in all but name, so it is
//  not done here. Flannel runs host-gw: the nodes share one LAN, so no VXLAN
//  device is needed inside a container.
//
//  Pinned: the K3s release binary is checked against the SHA-256 written here
//  (taken from the release's own sha256sum file), and K3s's install script is
//  the one from the same release tag, checked against its SHA-256 too. Nothing
//  "latest" is fetched.
// =============================================================================

import type { CatalogueRecipe, RecipeOption } from '../catalogue'
import { DETECT } from '../catalogue-detect'

export const K3S_RECIPE_ID = 'k3s'
export const K3S_AGENT_RECIPE_ID = 'k3s-agent'
export const K3S_RECIPE_IDS = [K3S_RECIPE_ID, K3S_AGENT_RECIPE_ID] as const

/** The K3s release: the stable channel's newest that is at least two weeks old when it was picked (2026-11-16). */
export const K3S_VERSION = 'v1.37.1+k3s1'
/** sha256sum-amd64.txt and sha256sum-arm64.txt of that release. */
export const K3S_SHA256 = {
  amd64: '92b94582eb7b34a8cf532e6006842b9ed215a6783cf56a3dd6271fd35243b2c0',
  arm64: 'a1561ca4aef8b99f5588a840d4468ac39c8c1cd92470bbcb9634823fa221741a',
} as const
/** install.sh at the release's git tag. */
export const K3S_INSTALL_SH_SHA256 = 'ed01f89fd977bf20ac1516bbebf8370bf3ddbaa55dac8aba610956a4c78cc00b'
/** The Kubernetes API port. LAN only: HyperProx never gives it a public name or a port forward. */
export const K3S_API_PORT = 6443

const urlVersion = K3S_VERSION.replace('+', '%2B')

/**
 * The part both recipes share: packages, the pinned binary, the pinned install script, and the settings that let
 * K3s run in an unprivileged container. `$K3S_ROLE` is server or agent. Every value arrives as an exported variable
 * the installer checked; a secret (the agent's join token) is written to a root-only file and taken out of the
 * environment before anything else runs, so no child process sees it.
 */
const COMMON = String.raw`umask 022
apt-get update -qq
apt-get install -y -qq curl ca-certificates iptables >/dev/null

ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) BIN=k3s;       SUM=` + K3S_SHA256.amd64 + String.raw` ;;
  arm64) BIN=k3s-arm64; SUM=` + K3S_SHA256.arm64 + String.raw` ;;
  *) echo "K3s is offered here for amd64 and arm64 only; this container is $ARCH." >&2; exit 1 ;;
esac

V='` + K3S_VERSION + String.raw`'
cd /tmp
curl -fsSLo k3s.bin "https://github.com/k3s-io/k3s/releases/download/` + urlVersion + String.raw`/$BIN"
echo "$SUM  k3s.bin" | sha256sum -c --quiet
install -m 755 k3s.bin /usr/local/bin/k3s
rm -f k3s.bin
curl -fsSLo k3s-install.sh "https://raw.githubusercontent.com/k3s-io/k3s/` + urlVersion + String.raw`/install.sh"
echo "` + K3S_INSTALL_SH_SHA256 + String.raw`  k3s-install.sh" | sha256sum -c --quiet

mkdir -p /etc/rancher/k3s
umask 077
{
  echo '# Written by HyperProx. K3s in an unprivileged container: kubelet knows it is in a user namespace,'
  echo '# kube-proxy leaves the node-wide conntrack limit alone, and flannel routes on the LAN (host-gw).'
  echo 'flannel-backend: host-gw'
  echo 'kubelet-arg:'
  echo '  - feature-gates=KubeletInUserNamespace=true'
  echo 'kube-proxy-arg:'
  echo '  - conntrack-max-per-core=0'
  if [ -n "$K3S_NODE_IP" ]; then echo "node-ip: $K3S_NODE_IP"; fi
} > /etc/rancher/k3s/config.yaml
`

export const K3S_SERVER_SCRIPT = COMMON + String.raw`{
  echo 'write-kubeconfig-mode: "0600"'
  echo 'kube-apiserver-arg:'
  echo '  - feature-gates=KubeletInUserNamespace=true'
  echo 'kube-controller-manager-arg:'
  echo '  - feature-gates=KubeletInUserNamespace=true'
  if [ -n "$K3S_NODE_IP" ]; then printf 'tls-san:\n  - %s\n' "$K3S_NODE_IP"; fi
  if [ "$K3S_TRAEFIK" != 1 ] || [ "$K3S_SERVICELB" != 1 ]; then
    echo 'disable:'
    if [ "$K3S_TRAEFIK" != 1 ]; then echo '  - traefik'; fi
    if [ "$K3S_SERVICELB" != 1 ]; then echo '  - servicelb'; fi
  fi
} >> /etc/rancher/k3s/config.yaml
umask 022

INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION="$V" sh /tmp/k3s-install.sh server
rm -f /tmp/k3s-install.sh

# Ready means the API answers and this node reports Ready, not merely that the service started.
for i in $(seq 1 60); do
  if /usr/local/bin/k3s kubectl get node "$(hostname)" --no-headers 2>/dev/null | grep -q ' Ready'; then
    echo "K3s $V server is running; this node is Ready."
    exit 0
  fi
  sleep 5
done
echo "K3s started but its node did not report Ready within five minutes." >&2
journalctl -u k3s --no-pager -n 30 >&2 || true
exit 1`

export const K3S_AGENT_SCRIPT = String.raw`# The join token stays in this shell only (export -n), and reaches K3s in its root-only config file.
TOKEN="$K3S_TOKEN"; export -n K3S_TOKEN
[ -n "$TOKEN" ] || { echo "The installer did not pass the server's join token." >&2; exit 1; }
[ -n "$K3S_SERVER_URL" ] || { echo "The installer did not pass the server's address." >&2; exit 1; }
` + COMMON + String.raw`{
  echo "server: $K3S_SERVER_URL"
  printf 'token: %s\n' "$TOKEN"
} >> /etc/rancher/k3s/config.yaml
umask 022

INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION="$V" sh /tmp/k3s-install.sh agent
rm -f /tmp/k3s-install.sh
for i in $(seq 1 36); do
  if systemctl is-active --quiet k3s-agent; then echo "K3s $V agent is running and joining $K3S_SERVER_URL."; exit 0; fi
  sleep 5
done
echo "The K3s agent did not start within three minutes." >&2
journalctl -u k3s-agent --no-pager -n 30 >&2 || true
exit 1`

const bool = (key: string, label: string, def: boolean, hint: string): RecipeOption => ({ key, label, kind: 'boolean', default: def ? '1' : '0', hint })

/** The address of a K3s server: `10.0.0.40` or `10.0.0.40:6443`, or a host name. */
export const SERVER_OPTION: RecipeOption = {
  key: 'K3S_SERVER', label: 'K3s server', kind: 'text', required: true, maxLength: 100, placeholder: '10.0.0.40:6443',
  hint: 'The server this agent joins: one HyperProx already looks after (its join token is in the vault).',
}

/** `host` or `host:port` (6443 when left out), or null. Never loopback, link-local or "any". */
export function parseServer(raw: string): { host: string; port: number; url: string } | null {
  const m = /^(?:https:\/\/)?((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*))(?::(\d{1,5}))?\/?$/.exec(String(raw ?? '').trim())
  if (!m) return null
  const host = m[1]
  const port = m[2] ? Number(m[2]) : K3S_API_PORT
  if (port < 1 || port > 65535) return null
  if (/^(localhost|localhost\.localdomain)$/i.test(host)) return null
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const o = host.split('.').map(Number)
    if (o.some(x => x > 255) || o[0] === 127 || o[0] === 0 || (o[0] === 169 && o[1] === 254) || o[0] >= 224) return null
  }
  return { host, port, url: `https://${host}:${port}` }
}

export function checkAgentOptions(v: Record<string, string>): string[] {
  return parseServer(v.K3S_SERVER ?? '') ? [] : ['The K3s server is its address and port, like 10.0.0.40:6443.']
}

const UNPRIVILEGED_NOTE = 'Runs in an unprivileged container with nesting and keyctl (set from the node, as for the Arr Stack). Kubelet is told it runs in a user namespace, so a pod cannot raise node-wide kernel limits. A privileged pod still cannot touch the Proxmox node, but it does control this container and the K3s cluster, so treat "privileged" in a pod as root on this cluster. Not a privileged container: nothing here turns AppArmor off or opens every device.'
const VERSION_NOTE = `Pinned to K3s ${K3S_VERSION}: the release binary and K3s's own install script from that release are checked against their SHA-256 before they run. The K3s page says when a newer stable release exists.`

export const K3S_RECIPE: CatalogueRecipe = {
  id: K3S_RECIPE_ID,
  detect: DETECT[K3S_RECIPE_ID],
  name: 'K3s (Kubernetes)',
  summary: 'Lightweight Kubernetes: a K3s server with its built-in ingress, load balancer and storage, connected to the K3s page for you. Add agents on other nodes afterwards.',
  category: 'apps',
  port: K3S_API_PORT,
  // Answered 401 to anyone without a credential: the setup steps prove it with the cluster's own CA and token instead.
  healthPath: '/version',
  expectStatus: [401],
  needsDocker: false,
  defaults: { cores: 2, memoryMb: 4096, diskGb: 20, swapMb: 0 },
  minimum: { cores: 2, memoryMb: 2048, diskGb: 10 },
  firstRun: { kind: 'none' },
  firstLogin: 'No password. The admin kubeconfig and the join token are kept in the vault (K3s item); the K3s page uses a read-only account for everything it shows and a separate, narrower one for the actions you confirm.',
  notes: [
    UNPRIVILEGED_NOTE,
    VERSION_NOTE,
    `The Kubernetes API (port ${K3S_API_PORT}) is for your network only: HyperProx gives it no public name and no port forward. Publish an app by its ingress instead.`,
    'Swap is off: Kubernetes expects it. Give the container the memory its workloads need.',
    'Built in: Traefik for ingress, ServiceLB for LoadBalancer services, local-path storage and metrics-server. Turn the first two off here if you bring your own.',
    'More nodes: the finished page offers "Add an agent on another node", which places it away from the nodes that already run this cluster.',
    'Not automatic yet: a backup job for the container. Its state is /var/lib/rancher/k3s; back the container up in Proxmox.',
  ],
  wizard: false,
  options: [
    bool('K3S_TRAEFIK', 'Built-in ingress (Traefik)', true, 'Serves your apps on ports 80 and 443 of the nodes. Turn off if you will install another ingress controller.'),
    bool('K3S_SERVICELB', 'Built-in load balancer (ServiceLB)', true, 'Gives LoadBalancer services the nodes\' own addresses. Turn off if you will use MetalLB or similar.'),
  ],
  install: { kind: 'script', script: K3S_SERVER_SCRIPT },
  setup: 'k3s',
}

export const K3S_AGENT_RECIPE: CatalogueRecipe = {
  id: K3S_AGENT_RECIPE_ID,
  name: 'K3s agent',
  summary: 'One more worker node for a K3s cluster HyperProx looks after, placed away from the nodes that already run it.',
  category: 'apps',
  port: K3S_API_PORT,
  healthPath: '/version',
  expectStatus: [401],
  needsDocker: false,
  defaults: { cores: 2, memoryMb: 4096, diskGb: 20, swapMb: 0 },
  minimum: { cores: 1, memoryMb: 1024, diskGb: 10 },
  firstRun: { kind: 'none' },
  firstLogin: 'Nothing to sign in to: the agent joins the server with the join token from the vault and shows on the K3s page as a node.',
  notes: [
    UNPRIVILEGED_NOTE,
    VERSION_NOTE,
    'Joins on your network: the agent and the server must reach each other directly (flannel host-gw routes pod traffic over the LAN).',
    'Placement avoids the nodes that already hold this cluster, so one Proxmox node going down does not take every worker with it.',
  ],
  wizard: false,
  options: [SERVER_OPTION],
  checkOptions: checkAgentOptions,
  install: { kind: 'script', script: K3S_AGENT_SCRIPT },
  setup: 'k3s',
  spreadWith: [K3S_RECIPE_ID, K3S_AGENT_RECIPE_ID],
}

export const K3S_RECIPES: CatalogueRecipe[] = [K3S_RECIPE, K3S_AGENT_RECIPE]
