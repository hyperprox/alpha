// =============================================================================
//  Privacy before the cloud: take addresses and host names out of a prompt, and put them back in the reply.
//
//  Every distinct address becomes addr-1, addr-2 ... and every distinct host name host-1, host-2 ..., the same
//  placeholder each time it appears, so the model can still reason about "host-1 talks to addr-2". The reply is
//  mapped back before the person sees it. lib/redact-addresses.ts is one-way ([address]) and is for text that is
//  shown to others; this one has to be reversible, so it is separate.
// =============================================================================

export interface Redaction { text: string; map: Record<string, string> }

// File names that look like host names (config.yml, app.py) are not hosts.
const FILE_EXT = new Set(['conf', 'cfg', 'json', 'yml', 'yaml', 'txt', 'log', 'py', 'sh', 'js', 'ts', 'md', 'xml', 'ini', 'toml', 'service', 'timer', 'sql', 'html', 'css', 'tar', 'gz', 'zip', 'img', 'iso', 'pem', 'crt', 'key', 'env', 'lock', 'rb', 'php', 'go', 'rs', 'c', 'h', 'csv', 'pdf', 'png', 'jpg', 'rsc', 'backup', 'bak', 'tmp', 'local'])

const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/@]*@)?(\[[0-9a-f:.]+\]|[^\s/:?#]+)/gi
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g
const IPV6_RE = /\b[0-9a-f]{1,4}(?::{1,2}[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?/gi
const FQDN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi
const LABELLED_RE = /\b(host(?:name)?|node|server|machine|vm|ct|container|ssh(?: to)?|on|from)\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)+|[a-z]+\d+[a-z0-9-]*)\b/gi

export function redactForCloud(input: string, extraHosts: string[] = []): Redaction {
  const map: Record<string, string> = {}
  const forward = new Map<string, string>()
  let nAddr = 0, nHost = 0
  const place = (orig: string, kind: 'addr' | 'host'): string => {
    const key = `${kind}:${orig.toLowerCase()}`
    let p = forward.get(key)
    if (!p) {
      p = kind === 'addr' ? `addr-${++nAddr}` : `host-${++nHost}`
      forward.set(key, p)
      map[p] = orig
    }
    return p
  }
  let t = String(input ?? '')
  // Known names first (the caller's own node and guest names), longest first so "node10" is not eaten by "node1".
  const known = [...new Set(extraHosts.map(h => h.trim()).filter(h => h.length >= 2))].sort((a, b) => b.length - a.length)
  for (const h of known) {
    const re = new RegExp(`(?<![\\w.-])${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi')
    t = t.replace(re, m => place(m, 'host'))
  }
  t = t.replace(URL_RE, (m, _scheme, host) => {
    if (/^(addr|host)-\d+$/.test(host)) return m
    const isIp = /^[\d.]+$/.test(host) || host.startsWith('[')
    return m.replace(host, place(host.replace(/^\[|\]$/g, ''), isIp ? 'addr' : 'host'))
  })
  t = t.replace(IPV4_RE, m => (m.split('/')[0].split('.').every(o => Number(o) <= 255) ? place(m, 'addr') : m))
  t = t.replace(IPV6_RE, m => (/::|[a-f]/i.test(m) ? place(m, 'addr') : m))
  t = t.replace(FQDN_RE, m => {
    const tld = m.slice(m.lastIndexOf('.') + 1).toLowerCase()
    return FILE_EXT.has(tld) || /^(addr|host)-\d+$/.test(m) ? m : place(m, 'host')
  })
  t = t.replace(LABELLED_RE, (m, label, name) => (/^(addr|host)-\d+$/.test(name) ? m : `${label} ${place(name, 'host')}`))
  return { text: t, map }
}

/** Put the real names back into a reply. Placeholders the model invented that are not in the map are left alone. */
export function unredact(text: string, map: Record<string, string>): string {
  return String(text ?? '').replace(/\b(?:addr|host)-\d+\b/g, p => map[p] ?? p)
}
