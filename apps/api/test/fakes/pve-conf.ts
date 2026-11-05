// Re-parsing a guest config file the way Proxmox does, written independently of the HyperProx writer so a test
// cannot pass because both share one parser's mistakes. Transcribed from pve-container's
// PVE::LXC::Config::parse_pct_config and is_valid_lxc_conf_key (read on a node, not copied from the writer):
//
//   split(/\n/, $raw); skip /^\s*$/
//   /^\[pve:pending\]\s*$/i            → pending section
//   /^\[([a-z][a-z0-9_\-]+)\]\s*$/i    → snapshot section
//   /^(lxc\.[a-z0-9_\-\.]+)(:|\s*=)\s*(.*?)\s*$/  → raw pair (no leading whitespace), kept only when the key is
//   valid; lxc.environment.runtime goes to `env` instead.

const VALID = new Set([
  'lxc.apparmor.profile', 'lxc.apparmor.allow_incomplete', 'lxc.apparmor.allow_nesting', 'lxc.apparmor.raw',
  'lxc.selinux.context', 'lxc.include', 'lxc.arch', 'lxc.uts.name', 'lxc.signal.halt', 'lxc.signal.reboot',
  'lxc.signal.stop', 'lxc.init.cmd', 'lxc.init.cwd', 'lxc.init.uid', 'lxc.init.gid', 'lxc.init.groups',
  'lxc.pty.max', 'lxc.console.logfile', 'lxc.console.path', 'lxc.tty.max', 'lxc.devtty.dir', 'lxc.hook.autodev',
  'lxc.autodev', 'lxc.kmsg', 'lxc.mount.fstab', 'lxc.mount.entry', 'lxc.mount.auto', 'lxc.rootfs.mount',
  'lxc.cap.drop', 'lxc.cap.keep', 'lxc.seccomp.profile', 'lxc.seccomp.notify.proxy', 'lxc.seccomp.notify.cookie',
  'lxc.idmap', 'lxc.hook.pre-start', 'lxc.hook.pre-mount', 'lxc.hook.mount', 'lxc.hook.start', 'lxc.hook.stop',
  'lxc.hook.post-stop', 'lxc.hook.clone', 'lxc.hook.destroy', 'lxc.hook.version', 'lxc.log.level', 'lxc.log.file',
  'lxc.start.auto', 'lxc.start.delay', 'lxc.start.order', 'lxc.group', 'lxc.environment', 'lxc.environment.runtime',
  'lxc.environment.hooks', 'lxc.sysctl.fs.mqueue', 'lxc.sysctl.kernel.msgmax', 'lxc.sysctl.kernel.msgmnb',
  'lxc.sysctl.kernel.msgmni', 'lxc.sysctl.kernel.sem', 'lxc.sysctl.kernel.shmall', 'lxc.sysctl.kernel.shmmax',
  'lxc.sysctl.kernel.shmmni', 'lxc.sysctl.kernel.shm_rmid_forced',
])
const DEPRECATED = new Set(['lxc.aa_profile', 'lxc.aa_allow_incomplete', 'lxc.console', 'lxc.devttydir', 'lxc.haltsignal',
  'lxc.rebootsignal', 'lxc.stopsignal', 'lxc.id_map', 'lxc.init_cmd', 'lxc.loglevel', 'lxc.logfile', 'lxc.mount',
  'lxc.network.type', 'lxc.network.flags', 'lxc.network.link', 'lxc.network.mtu', 'lxc.network.name', 'lxc.network.hwaddr',
  'lxc.network.ipv4', 'lxc.network.ipv4.gateway', 'lxc.network.ipv6', 'lxc.network.ipv6.gateway', 'lxc.network.script.up',
  'lxc.network.script.down', 'lxc.pts', 'lxc.se_context', 'lxc.seccomp', 'lxc.tty', 'lxc.utsname'])

function valid(key: string): boolean {
  if (/^lxc\.limit\./.test(key) || DEPRECATED.has(key) || VALID.has(key)) return true
  if (key === 'lxc.rootfs.path' || key === 'lxc.rootfs.options') return false
  return /^lxc\.cgroup\./.test(key) || /^lxc\.cgroup2\./.test(key) || /^lxc\.prlimit\./.test(key) || /^lxc\.net\./.test(key)
}

/** The main section's `lxc` array exactly as the API would return it. */
export function pveParseRaw(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of text.split(/\n/)) {
    if (/^\s*$/.test(line)) continue
    if (/^\[pve:pending\]\s*$/i.test(line) || /^\[([a-z][a-z0-9_\-]+)\]\s*$/i.test(line)) break
    const m = /^(lxc\.[a-z0-9_\-.]+)(:|\s*=)\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    if (m[1] === 'lxc.environment.runtime') continue   // goes to env, not lxc
    if (valid(m[1])) out.push([m[1], m[3]])
  }
  return out
}

export function pveHasLock(text: string): string | null {
  for (const line of text.split(/\n/)) {
    if (/^\[pve:pending\]\s*$/i.test(line) || /^\[([a-z][a-z0-9_\-]+)\]\s*$/i.test(line)) break
    const m = /^lock:\s*(\S+)/.exec(line)
    if (m) return m[1]
  }
  return null
}

export function pveHasPending(text: string): boolean { return text.split(/\n/).some(l => /^\[pve:pending\]\s*$/i.test(l)) }
