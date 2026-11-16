// =============================================================================
//  HyperProx — K3s: reading a kubeconfig
//
//  A kubeconfig is how K3s hands out its admin login (/etc/rancher/k3s/k3s.yaml
//  on the server) and how a person pastes one in. Only what HyperProx needs is
//  taken from it: the API address, the cluster's CA, and either a client
//  certificate and key or a bearer token. Exec plug-ins, auth providers and
//  file references are refused: HyperProx never runs a command or opens a path
//  because a kubeconfig said so.
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

/** The current context's cluster and user, or the only ones there are. */
export function parseKubeconfig(text: string): AdminLogin {
  if (typeof text !== 'string' || !text.trim()) throw new KubeconfigError('Paste the kubeconfig (the K3s server keeps it in /etc/rancher/k3s/k3s.yaml).')
  if (text.length > MAX) throw new KubeconfigError('That is too long for a kubeconfig.')
  let doc: any
  try { doc = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA }) } catch { throw new KubeconfigError('That is not a kubeconfig: it does not read as YAML.') }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.clusters) || !Array.isArray(doc.users)) throw new KubeconfigError('That is not a kubeconfig: it has no clusters and users.')
  const contexts: any[] = Array.isArray(doc.contexts) ? doc.contexts : []
  const ctx = contexts.find(c => c?.name === doc['current-context'])?.context ?? (contexts.length === 1 ? contexts[0]?.context : null)
  const pick = (list: any[], name: unknown) => (typeof name === 'string' ? list.find(x => x?.name === name) : null) ?? (list.length === 1 ? list[0] : null)
  const cluster = pick(doc.clusters, ctx?.cluster)?.cluster
  const user = pick(doc.users, ctx?.user)?.user
  if (!cluster || !user) throw new KubeconfigError('The kubeconfig has several clusters or users and no current context naming one.')
  if (user.exec || user['auth-provider']) throw new KubeconfigError('This kubeconfig signs in by running a program or a cloud login, which HyperProx does not do. Use the K3s server\'s own k3s.yaml.')
  if (cluster['certificate-authority'] || user['client-certificate'] || user['client-key'] || user.tokenFile) {
    throw new KubeconfigError('This kubeconfig points at files on another machine. Use one with the certificates inside it (the K3s server\'s k3s.yaml is).')
  }
  if (cluster['insecure-skip-tls-verify'] === 'true') throw new KubeconfigError('This kubeconfig turns certificate checks off. HyperProx needs the cluster\'s CA to check it is talking to your cluster.')
  const server = typeof cluster.server === 'string' ? cluster.server.trim() : ''
  if (!/^https:\/\/[^\s/]+\/?$/.test(server)) throw new KubeconfigError('The kubeconfig\'s server is not an https:// address.')
  if (!cluster['certificate-authority-data']) throw new KubeconfigError('The kubeconfig has no cluster CA in it.')
  const ca = b64(cluster['certificate-authority-data'], 'CA')
  try { new X509Certificate(ca) } catch { throw new KubeconfigError('The kubeconfig\'s cluster CA is not a certificate.') }
  const out: AdminLogin = { server: server.replace(/\/$/, ''), ca }
  if (user['client-certificate-data'] && user['client-key-data']) {
    out.cert = b64(user['client-certificate-data'], 'client certificate')
    out.key = b64(user['client-key-data'], 'client key')
  } else if (typeof user.token === 'string' && /^[A-Za-z0-9._~+/=-]{8,4096}$/.test(user.token.trim())) {
    out.token = user.token.trim()
  } else throw new KubeconfigError('The kubeconfig has no client certificate or token for its user.')
  return out
}

/** K3s writes its kubeconfig for the server itself (127.0.0.1); the copy HyperProx keeps names the server's address. */
export function rewriteServer(text: string, server: string): string {
  return text.replace(/^(\s*server:\s*)https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\s*$/m, `$1${server}`)
}

/** The SHA-256 fingerprint of a PEM certificate, colon-separated, as HyperProx shows pins. */
export function caFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256
}
