// =============================================================================
//  HyperProx — the deployment wizard's prompt
//
//  The original prompt told the model the JSON shape and a table of memorised
//  service sizes, then asked it to plan a deployment on a cluster it knew
//  nothing about. So it guessed: nodes that do not exist, storages that were
//  never configured, and domains it invented outright.
//
//  This version gives it the cluster. Facts first, rules second, schema last —
//  and every rule is one the executor actually enforces, because a rule the
//  system does not check is a rule the model learns it can ignore.
// =============================================================================

import type { ClusterFacts } from './plan-schema'

/** Static half — identical on every request, so it caches cleanly. */
export const SYSTEM_PROMPT = `You plan service deployments on a Proxmox VE cluster for HyperProx.

You are given the real state of one specific cluster. Plan only against what is
actually there.

HOW A DEPLOYMENT WORKS HERE, in order:

  create_lxc        Create an unprivileged LXC container on a node with room for it.
  install_service   Install the service inside it. NOTE: HyperProx cannot yet run
                    commands inside a new container, so this step is reported as
                    skipped and the commands are shown to the user to run. Include
                    it anyway — the steps after it depend on the service existing.
  configure_proxy   Add a proxy host in Nginx Proxy Manager pointing at the
                    container's address and the service's port.
  create_dns        Create an A record for the domain pointing at the WAN address.
  wait_propagation  Wait for that record to resolve before asking for a certificate.
  request_ssl       Request a Let's Encrypt certificate and attach it.

RULES:

1. Never invent a domain. If the user did not give one, set "domain" to "" and add
   a warning saying which domain you need. Do not use example.com or any
   placeholder. A wrong domain costs a failed certificate request, and five
   failures per hostname per hour locks out issuance.

2. Only name a node or a storage that appears in the cluster facts. If nothing
   has room, still produce the plan and say so in warnings.

3. Size the container for the service, then check it against the free memory in
   the facts. Prefer the node with the most free memory unless the service needs
   something only one node has.

4. If the user's request is missing something you need — no service named, no
   domain, a service you do not recognise — put it in warnings rather than
   choosing for them. Warnings are read; a wrong guess is executed.

5. Every field in the schema must be present. Where a field does not apply to a
   step, use "" for text and 0 for numbers.

6. "understood" is one sentence in plain language, addressed to the user. No
   restating the schema, no listing the steps — they can see the steps.

TYPICAL SIZES, as a starting point only — adjust for what the user says:
  Nextcloud 2048MB/20GB/2   Jellyfin 2048MB/20GB/4   Vaultwarden 512MB/2GB/1
  Gitea 1024MB/10GB/2       Grafana 512MB/5GB/2      Uptime Kuma 256MB/2GB/1
  Home Assistant 2048MB/16GB/2   Paperless 2048MB/20GB/2   Immich 4096MB/40GB/4`

/** Volatile half — the cluster as it is right now. */
export function clusterContext(facts: ClusterFacts): string {
  const nodes = facts.nodes
    .slice()
    .sort((a, b) => b.freeMemMb - a.freeMemMb)
    .map(n => `  ${n.node}: ${n.cores} cores, ${Math.round(n.freeMemMb / 1024)} GB free of ${Math.round(n.totalMemMb / 1024)} GB`)
    .join('\n')

  // Already ranked by gatherFacts — do not re-sort by free space here, or the
  // network share climbs back to the top of the list.
  const stores = facts.storages
    .slice(0, 8)
    .map(s => `  ${s.storage} (${s.type}${s.shared ? ', shared' : ', local'}): ${s.freeGb} GB free`)
    .join('\n')

  return [
    'CLUSTER FACTS',
    '',
    'Nodes:',
    nodes || '  (none reported)',
    '',
    'Storage that can hold a container, best choice first:',
    stores || '  (none reported)',
    '',
    `Next free container ID: ${facts.nextVmid}`,
    `Gateway: ${facts.gateway || 'unknown'}`,
    facts.domains.length
      ? `DNS zones this cluster manages: ${facts.domains.join(', ')}`
      : 'DNS zones: none configured — any domain step will fail until DNS is set up.',
    facts.proxyHosts.length
      ? `Proxy hosts already in use: ${facts.proxyHosts.slice(0, 25).join(', ')}`
      : 'Proxy hosts: none yet.',
  ].join('\n')
}

export function userPrompt(request: string, facts: ClusterFacts): string {
  return `${clusterContext(facts)}

REQUEST
${request.trim()}

Plan this deployment against the cluster above.`
}
