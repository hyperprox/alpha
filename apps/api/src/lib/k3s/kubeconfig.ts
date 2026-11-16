// =============================================================================
//  HyperProx — K3s: reading a kubeconfig
//
//  A kubeconfig is how K3s hands out its admin login (/etc/rancher/k3s/k3s.yaml
//  on the server) and how a person pastes one in. Only what HyperProx needs is
//  taken from it: the API address, the cluster's CA, and either a client
//  certificate and key or a bearer token. Exec plug-ins, auth providers, file
//  references, proxies, impersonation, YAML merge keys and turned-off
//  certificate checks are refused on every entry, not only the one used:
//  HyperProx never runs a command, opens a path or goes through a proxy
//  because a kubeconfig said so. What is kept is rebuilt from the checked
//  values (buildKubeconfig), never the text that came in.
// =============================================================================

// js-yaml ships no types; only load() with the failsafe schema (every value a string, nothing constructed) is used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load(src: string, o?: { schema?: unknown }): unknown; FAILSAFE_SCHEMA: unknown }
import { X509Certificate } from 'node:crypto'

export class KubeconfigError extends Error {
  constructor(message: string) { super(message); this.name = 'KubeconfigError' }
}

export interface AdminLogin {
  /** https://host:port, as the kubeconfig names it (127.0.0.1 on the server itself: rewritten by the caller). */
  server: string
  /** The cluster CA, PEM. */
  ca: string
  /** A client certificate and key (K3s's own admin), PEM. */
  cert?: string
  key?: string
  /** Or a bearer token. */
  token?: string
}

const MAX = 64 * 1024
const b64 = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(v)) throw new KubeconfigError(`The kubeconfig's ${what} is not base64.`)
  return Buffer.from(v, 'base64').toString('utf8')
}

/** Keys that make a kubeconfig run something, read a file or act as someone else: refused on every user. */
const USER_FORBIDDEN = ['exec', 'auth-provider', 'tokenFile', 'client-certificate', 'client-key', 'username', 'password', 'as', 'as-groups', 'as-uid', 'as-user-extra']
/** Keys that read a file or change where and how the API is reached: refused on every cluster. */
const CLUSTER_FORBIDDEN = ['certificate-authority', 'proxy-url', 'tls-server-name']

/** Every key anywhere in the document, at any depth. */
function everyKey(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) throw new KubeconfigError('That kubeconfig is nested too deeply.')
  if (Array.isArray(v)) for (const x of v) everyKey(x, out, depth + 1)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); everyKey(x, out, depth + 1) }
  return out
}

const FALSE_WORDS = /^(false|no|off|0|n)$/i
const MERGE = 'That kubeconfig uses a YAML merge key (<<), which HyperProx does not accept. Use the K3s server\'s own k3s.yaml.'

/** The current context's cluster and user, or the only ones there are. Every entry is checked, not only the one used. */
export function parseKubeconfig(text: string): AdminLogin {
  if (typeof text !== 'string' || !text.trim()) throw new KubeconfigError('Paste the kubeconfig (the K3s server keeps it in /etc/rancher/k3s/k3s.yaml).')
  if (text.length > MAX) throw new KubeconfigError('That is too long for a kubeconfig.')
  // A merge key copies one entry into another: what is checked and what a client reads could differ.
  if (/(^|[\s{,[-])<<\s*:/m.test(text)) throw new KubeconfigError(MERGE)
  let doc: any
  try { doc = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA }) } catch { throw new KubeconfigError('That is not a kubeconfig: it does not read as YAML.') }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.clusters) || !Array.isArray(doc.users)) throw new KubeconfigError('That is not a kubeconfig: it has no clusters and users.')
  const keys = everyKey(doc)
  if (keys.includes('<<')) throw new KubeconfigError(MERGE)
  if (keys.includes('proxy-url')) throw new KubeconfigError('That kubeconfig sends its traffic through a proxy (proxy-url). HyperProx talks to your cluster directly; remove it.')
  for (const u of doc.users) {
    const user = u?.user && typeof u.user === 'object' ? u.user : {}
    if ('exec' in user || 'auth-provider' in user) throw new KubeconfigError(`The user ${String(u?.name ?? '')} signs in by running a program or a cloud login, which HyperProx does not accept anywhere in a kubeconfig. Use the K3s server's own k3s.yaml.`)
    const bad = USER_FORBIDDEN.find(k => k in user)
    if (bad) throw new KubeconfigError(`The user ${String(u?.name ?? '')} uses ${bad}, which points at a file or another identity. Use one with the certificates inside it (the K3s server's k3s.yaml is).`)
  }
  for (const c of doc.clusters) {
    const cluster = c?.cluster && typeof c.cluster === 'object' ? c.cluster : {}
    if ('insecure-skip-tls-verify' in cluster && !FALSE_WORDS.test(String(cluster['insecure-skip-tls-verify']).trim())) {
      throw new KubeconfigError('This kubeconfig turns certificate checks off (insecure-skip-tls-verify). HyperProx needs the cluster\'s CA to check it is talking to your cluster.')
    }
    const bad = CLUSTER_FORBIDDEN.find(k => k in cluster)
    if (bad) throw new KubeconfigError(`The cluster ${String(c?.name ?? '')} uses ${bad}, which HyperProx does not accept: it points at a file or changes where or how the API is reached.`)
  }
  const contexts: any[] = Array.isArray(doc.contexts) ? doc.contexts : []
  const ctx = contexts.find(c => c?.name === doc['current-context'])?.context ?? (contexts.length === 1 ? contexts[0]?.context : null)
  const pick = (list: any[], name: unknown) => (typeof name === 'string' ? list.find(x => x?.name === name) : null) ?? (list.length === 1 ? list[0] : null)
  const cluster = pick(doc.clusters, ctx?.cluster)?.cluster
  const user = pick(doc.users, ctx?.user)?.user
  if (!cluster || !user) throw new KubeconfigError('The kubeconfig has several clusters or users and no current context naming one.')
  const server = typeof cluster.server === 'string' ? cluster.server.trim() : ''
  if (!/^https:\/\/[^\s/]+\/?$/.test(server)) throw new KubeconfigError('The kubeconfig\'s server is not an https:// address.')
  if (!cluster['certificate-authority-data']) throw new KubeconfigError('The kubeconfig has no cluster CA in it.')
  const ca = b64(cluster['certificate-authority-data'], 'CA')
  try { new X509Certificate(ca) } catch { throw new KubeconfigError('The kubeconfig\'s cluster CA is not a certificate.') }
  const out: AdminLogin = { server: server.replace(/\/$/, ''), ca }
  if (user['client-certificate-data'] && user['client-key-data']) {
    out.cert = b64(user['client-certificate-data'], 'client certificate')
    out.key = b64(user['client-key-data'], 'client key')
    try { new X509Certificate(out.cert) } catch { throw new KubeconfigError('The kubeconfig\'s client certificate is not a certificate.') }
    if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(out.key.trim())) throw new KubeconfigError('The kubeconfig\'s client key is not a private key.')
  } else if (typeof user.token === 'string' && /^[A-Za-z0-9._~+/=-]{8,4096}$/.test(user.token.trim())) {
    out.token = user.token.trim()
  } else throw new KubeconfigError('The kubeconfig has no client certificate or token for its user.')
  return out
}

/**
 * The kubeconfig HyperProx keeps: rebuilt from the checked values (the server's LAN address, the CA, the client
 * certificate and key or the token), one cluster, one user, one context. Nothing else from the text that came in
 * survives, so nothing unchecked can come back out of the vault.
 */
export function buildKubeconfig(login: AdminLogin, server: string): string {
  if (!/^https:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(server)) throw new KubeconfigError('The server address is https://host:port.')
  const e = (v: string) => Buffer.from(v, 'utf8').toString('base64')
  const user = login.cert && login.key
    ? [`    client-certificate-data: ${e(login.cert)}`, `    client-key-data: ${e(login.key)}`]
    : login.token ? [`    token: ${login.token}`] : null
  if (!user) throw new KubeconfigError('Nothing to sign in with.')
  return [
    'apiVersion: v1', 'kind: Config',
    'clusters:', '- name: k3s', '  cluster:', `    server: ${server}`, `    certificate-authority-data: ${e(login.ca)}`,
    'users:', '- name: k3s-admin', '  user:', ...user,
    'contexts:', '- name: k3s', '  context:', '    cluster: k3s', '    user: k3s-admin',
    'current-context: k3s', '',
  ].join('\n')
}

/** The SHA-256 fingerprint of a PEM certificate, colon-separated, as HyperProx shows pins. */
export function caFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256
}
