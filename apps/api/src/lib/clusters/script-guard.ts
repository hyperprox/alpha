// =============================================================================
//  HyperProx — the one rule for every script sent to a remote cluster's node
//
//  A safety net, not a sandbox: HyperProx's own scripts are fixed text, and this catches a mistake in one of
//  them (or a value that slipped into one) before it reaches a node. It refuses any script naming corosync,
//  pve-cluster or pmxcfs, and any /etc/pve path except the HyperProx documents: a container's own config
//  file (the guest config editor's write, and its temp files), reading ceph.conf (the hardware probe), and
//  reading the cluster's record of its nodes' SSH host keys (host-key verification). That last one is allowed
//  only as a whole line of exactly `cat -- <path> 2>/dev/null`: a read, never a write, and never part of a
//  longer command. A script that reads the record may not continue any command over a line break (a backslash
//  at the end of a line), so no line can be glued to a record read. (Other HyperProx scripts, the monitoring
//  install and the hardware probe, use such continuations, so they are not refused for it.)
// =============================================================================

const ALLOWED_PVE = [
  /\/etc\/pve\/nodes\/[A-Za-z0-9.-]+\/lxc\/\d+\.conf(\.tmp\.hpx\.[A-Za-z0-9_.*$]*)?/g,
  /\/etc\/pve\/ceph\.conf/g,
]

// The record reads, as whole lines only (leading spaces allowed). Nothing before or after on that line.
const RECORD_READ_LINE = /^[ \t]*cat -- \/etc\/pve\/(priv\/known_hosts|nodes\/[A-Za-z0-9.-]+\/ssh_known_hosts) 2>\/dev\/null[ \t]*$/

export function assertSafeScript(script: string): void {
  if (/corosync|pve-cluster|pmxcfs/i.test(script)) {
    throw new Error('Refused: this script names corosync or pve-cluster, which HyperProx never touches on any cluster.')
  }
  const lines = script.split('\n')
  const reads = lines.some(l => RECORD_READ_LINE.test(l))
  if (reads && /\\\r?\n/.test(script)) throw new Error('Refused: a script that reads the host-key record may not continue a command over a line break (a backslash at the end of a line).')
  let rest = lines.filter(l => !RECORD_READ_LINE.test(l)).join('\n')
  for (const re of ALLOWED_PVE) rest = rest.replace(re, '')
  if (/\/etc\/pve\b/.test(rest)) throw new Error('Refused: this script names a path under /etc/pve that HyperProx does not write on a remote cluster.')
}

// =============================================================================
//  Packages: install one named thing, never upgrade
//
//  Monitoring scripts may only ask apt to simulate, to install, to remove what HyperProx itself added, or to
//  refresh the package lists (which moves no package). Anything that upgrades, removes in bulk, changes holds or
//  boot kernels is refused before the script is sent, and so is naming a kernel, header, NVIDIA or Proxmox
//  package in an install. Comment lines are not commands and are skipped. The node-side helpers add the second
//  half of the rule: they ask apt what it would do first, and install nothing if that upgrades or removes anything.
// =============================================================================

const APT_TOOL = /\b(apt-get|apt-mark|aptitude|apt|dpkg|proxmox-boot-tool|unattended-upgrades?)\b([^\n;|&)]*)/g
const APT_VERBS = new Set(['install', 'reinstall', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'full-upgrade', 'autoremove', 'autopurge', 'update', 'build-dep', 'source', 'download', 'clean', 'autoclean', 'markauto', 'unmarkauto', 'satisfy', 'changelog', 'check'])
const APT_GET_ALLOWED = new Set(['install', 'remove', 'update'])
const PROTECTED_PKG = /\b(linux-(image|headers|modules)|proxmox-(kernel|headers|default-kernel|ve|boot)|pve-(kernel|headers|manager|firmware)|nvidia|libnvidia|firmware-)[\w.+-]*/i

export function assertAptInstallOnly(script: string): void {
  const lines = String(script).split('\n').filter(l => !/^\s*#/.test(l))
  for (const line of lines) {
    for (const m of line.matchAll(APT_TOOL)) {
      const tool = m[1], args = m[2] ?? ''
      // Words after the tool, up to the end of the command; the first non-option word is apt's verb.
      const words = args.trim().split(/\s+/).filter(Boolean)
      const verb = words.find(w => !w.startsWith('-'))?.replace(/^["']|["']$/g, '') ?? ''
      if (tool === 'apt-mark' || tool === 'aptitude' || tool === 'proxmox-boot-tool' || tool.startsWith('unattended-upgrade')) {
        throw new Error(`Refused: monitoring never runs ${tool}.`)
      }
      if (tool === 'dpkg') {
        if (words.some(w => /^(-i|--install|-r|--remove|-P|--purge|--configure|--set-selections|--unpack|-a|--pending)$/.test(w))) throw new Error('Refused: monitoring never installs or removes packages with dpkg.')
        continue
      }
      if (!APT_VERBS.has(verb)) continue
      if (tool === 'apt') throw new Error('Refused: monitoring uses apt-get, never apt.')
      if (!APT_GET_ALLOWED.has(verb)) throw new Error(`Refused: monitoring never runs apt-get ${verb}; it only installs the one package it names.`)
      if (words.some(w => /^--(allow-downgrades|allow-remove-essential|allow-change-held-packages|force-yes)$/.test(w))) throw new Error('Refused: monitoring never overrides apt\'s safety checks.')
      if (verb === 'install' && PROTECTED_PKG.test(args)) throw new Error('Refused: monitoring never installs a kernel, header, firmware, NVIDIA or Proxmox package.')
    }
  }
}
