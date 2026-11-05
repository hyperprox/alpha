// Re-parsing a guest config file the way Proxmox does (PVE::LXC::Config::parse_pct_config), written
// independently of the HyperProx writer so a test cannot pass because both share one parser's mistakes.
//
// Proxmox, for the main section: a line matching
//   ^\s*(lxc\.[a-z0-9_\-\.]+)(:|\s*=)\s*(.*?)\s*$
// becomes a raw lxc pair; '#' lines are the description; a '[name]' line starts a snapshot section.

export function pveParseRaw(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\r$/, '')
    if (/^\[([a-z][a-z0-9_\-:]+)\]\s*$/i.test(line)) break
    const m = /^\s*(lxc\.[a-z0-9_\-.]+)(:|\s*=)\s*(.*?)\s*$/.exec(line)
    if (m) out.push([m[1], m[3]])
  }
  return out
}

export function pveHasLock(text: string): string | null {
  for (const line of text.split('\n')) {
    if (/^\[/.test(line)) break
    const m = /^lock:\s*(\S+)/.exec(line)
    if (m) return m[1]
  }
  return null
}
