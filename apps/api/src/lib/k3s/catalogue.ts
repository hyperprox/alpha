// =============================================================================
//  HyperProx — K3s: the Catalogue install's own steps
//
//  Around the generic installer (lib/catalogue-installer.ts):
//    preview    an agent names a server HyperProx already looks after, whose
//               join token is in the vault
//    prepare    keyctl on the new container, from the node (an API token cannot
//               set it), then the container starts again; read back after
//    env        the server's own address for its certificate; for an agent the
//               server's address and its join token (from the vault, into the
//               root-only script, never into a log)
//    setup      server: read K3s's admin login from inside the container, make
//               HyperProx's two accounts, connect the K3s page, check it reads.
//               agent: wait until the node has joined and reports Ready.
// =============================================================================

import type { StepRef } from '../arr/setup'
import { K3S_AGENT_RECIPE_ID, K3S_API_PORT, K3S_RECIPE_ID, parseServer } from './recipe'
import { READ_LOGIN_SCRIPT, parseLoginOutput } from './accounts'
import type { K3sService } from './service'
import { plainK3s } from './service'

export const isK3s = (recipe: { setup?: string }) => recipe.setup === 'k3s'

export const K3S_SERVER_STEPS = [
  { id: 'k3s-login', label: 'Read the cluster\'s admin login into the vault' },
  { id: 'k3s-connect', label: 'Make HyperProx\'s read-only and action accounts' },
  { id: 'k3s-check', label: 'Check the K3s page can read the cluster' },
]
export const K3S_AGENT_STEPS = [
  { id: 'k3s-join', label: 'Wait for the agent to join the cluster' },
]
export const k3sSteps = (recipeId: string) => (recipeId === K3S_AGENT_RECIPE_ID ? K3S_AGENT_STEPS : K3S_SERVER_STEPS)

/** Node-side: keyctl and nesting on the new container (the API token can set nesting only), then start it again. */
export function prepareScript(vmid: number): string {
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new Error('Bad container id.')
  return [
    'set -eu',
    `V=${vmid}`,
    'if pct status "$V" | grep -q running; then pct stop "$V"; fi',
    'pct set "$V" --features nesting=1,keyctl=1',
    'pct start "$V"',
    'echo "@@k3s prepared"',
  ].join('\n') + '\n'
}

/** What the container's settings must read back as before K3s goes in. */
export function configProblems(cfg: Record<string, unknown> | null): string[] {
  const out: string[] = []
  const f = String(cfg?.features ?? '')
  if (!/(^|,)nesting=1(,|$)/.test(f)) out.push('nesting is not on.')
  if (!/(^|,)keyctl=1(,|$)/.test(f)) out.push('keyctl is not on.')
  if (Number(cfg?.unprivileged) !== 1) out.push('it is not unprivileged.')
  return out
}

export interface K3sCatalogueDeps {
  service: () => K3sService
  nodeRun?: (node: string, script: string, timeoutMs: number) => Promise<{ code: number; output: string }>
  client: { fetchStrict<T>(path: string, method?: string, body?: string): Promise<T> }
}

export async function k3sPrepare(plan: { node: string; vmid: number }, d: K3sCatalogueDeps): Promise<string> {
  if (!d.nodeRun) throw new Error('HyperProx cannot reach the node to finish the container.')
  const r = await d.nodeRun(plan.node, prepareScript(plan.vmid), 3 * 60_000)
  if (r.code !== 0 || !/@@k3s prepared/.test(r.output)) throw new Error(`The container could not be given keyctl on ${plan.node} (exit ${r.code}).`)
  const cfg = await d.client.fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(plan.node)}/lxc/${plan.vmid}/config`)
  const bad = configProblems(cfg)
  if (bad.length) throw new Error(`CT ${plan.vmid}'s settings did not read back: ${bad.join(' ')}`)
  return 'unprivileged, with nesting and keyctl'
}

/** An agent's server: one HyperProx looks after, with its join token in the vault. */
export async function k3sPreview(recipeId: string, values: Record<string, string>, d: Pick<K3sCatalogueDeps, 'service'>): Promise<{ errors: string[]; checks: string[] }> {
  if (recipeId !== K3S_AGENT_RECIPE_ID) return { errors: [], checks: [] }
  const s = parseServer(values.K3S_SERVER ?? '')
  if (!s) return { errors: ['The K3s server is its address and port, like 10.0.0.40:6443.'], checks: [] }
  const found = await d.service().byServerUrl(s.url).catch(() => null)
  if (!found) return { errors: [`HyperProx does not look after a K3s server at ${s.url}. Install one with the K3s entry, or connect it on the K3s page first.`], checks: [] }
  if (!found.nodeToken) return { errors: [`${found.meta.name}'s join token is not in the vault. Add it on the K3s page (it is /var/lib/rancher/k3s/server/node-token on the server).`], checks: [] }
  return { errors: [], checks: [`Joins ${found.meta.name} at ${s.url}, with its join token from the vault.`] }
}

/** The script's variables. The join token travels only in the script, which reaches the guest on stdin as a root-only file. */
export async function k3sInstallEnv(recipeId: string, o: { ip?: string; options: Record<string, string> }, d: Pick<K3sCatalogueDeps, 'service'>): Promise<Record<string, string>> {
  const env: Record<string, string> = { K3S_NODE_IP: o.ip ?? '' }
  if (recipeId !== K3S_AGENT_RECIPE_ID) return env
  const s = parseServer(o.options.K3S_SERVER ?? '')
  if (!s) throw new Error('The K3s server address is not usable.')
  const found = await d.service().byServerUrl(s.url)
  if (!found?.nodeToken) throw new Error(`The join token for ${s.url} is no longer in the vault. Check the plan again.`)
  return { ...env, K3S_SERVER_URL: s.url, K3S_TOKEN: found.nodeToken }
}

export interface K3sSetupResult { url: string; followUp?: { recipeId: string; label: string; url: string; options: Record<string, string> }; detail: string }

/** Replace every known secret in a message, so nothing read from the guest reaches a job or its steps. */
const redact = (msg: string, secrets: string[]) => secrets.filter(s => s.length >= 8).reduce((m, s) => m.split(s).join('[hidden]'), msg)

export async function k3sRunSetup(o: {
  recipeId: string; ip: string; vmid: number; hostname: string; owner: string; options: Record<string, string>
}, step: (id: string) => StepRef, d: {
  service: () => K3sService
  /** A script in the new container (the installer's pct exec). Its output is never logged. */
  sh: (script: string, timeoutMs: number) => Promise<{ code: number; output: string; timedOut?: boolean }>
}): Promise<K3sSetupResult> {
  const svc = d.service()
  if (o.recipeId === K3S_AGENT_RECIPE_ID) {
    const s = parseServer(o.options.K3S_SERVER ?? '')!
    const found = await svc.byServerUrl(s.url)
    if (!found) throw new Error(`HyperProx no longer looks after ${s.url}.`)
    const st = step('k3s-join')
    const ok = await svc.waitNodeReady(found.meta.id, o.hostname)
    if (!ok) throw new Error(`${o.hostname} did not show as a Ready node of ${found.meta.name} within four minutes. Its log: journalctl -u k3s-agent in the container.`)
    await svc.addAgent(found.meta.id, { kind: 'lxc', vmid: o.vmid })
    st.status = 'done'; st.detail = `${o.hostname} is a Ready node of ${found.meta.name}`
    return { url: s.url, detail: st.detail, followUp: { recipeId: K3S_AGENT_RECIPE_ID, label: 'Add another agent on another node', url: s.url, options: { K3S_SERVER: `${s.host}:${s.port}` } } }
  }
  if (o.recipeId !== K3S_RECIPE_ID) throw new Error(`${o.recipeId} is not a K3s recipe.`)
  const url = `https://${o.ip}:${K3S_API_PORT}`
  const s1 = step('k3s-login')
  const r = await d.sh(READ_LOGIN_SCRIPT, 60_000)
  const login = r.code === 0 ? parseLoginOutput(r.output) : { found: false as const }
  if (!login.found) throw new Error(`K3s's admin login (/etc/rancher/k3s/k3s.yaml) could not be read from the container (exit ${r.code}).`)
  s1.status = 'done'; s1.detail = `kubeconfig${login.nodeToken ? ' and join token' : ''} read; kept only in the vault`
  const s2 = step('k3s-connect')
  const secrets = [login.kubeconfig, ...(login.nodeToken ? [login.nodeToken] : [])]
  let meta
  try {
    meta = await svc.connect({ kubeconfig: login.kubeconfig, address: url, nodeToken: login.nodeToken, name: o.hostname || 'K3s', guest: { kind: 'lxc', vmid: o.vmid }, via: 'catalogue' }, o.owner)
  } catch (e: any) { throw new Error(redact(plainK3s(e, 'Connecting the cluster'), secrets)) }
  s2.status = 'done'; s2.detail = 'hyperprox-reader (read only, no secrets) and hyperprox-operator (the confirmed actions) in kube-system'
  const s3 = step('k3s-check')
  const reading = await svc.reading(meta.id, { fresh: true }).catch((e: any) => { throw new Error(plainK3s(e, 'Reading the new cluster')) })
  const ready = reading.nodes.filter(n => n.ready).length
  s3.status = ready ? 'done' : 'failed'
  s3.detail = `${reading.version.current ?? 'K3s'}: ${ready} of ${reading.nodes.length} node${reading.nodes.length === 1 ? '' : 's'} Ready, ${reading.counts.running} pods running`
  return { url, detail: s3.detail, followUp: { recipeId: K3S_AGENT_RECIPE_ID, label: 'Add an agent on another node', url, options: { K3S_SERVER: `${o.ip}:${K3S_API_PORT}` } } }
}
