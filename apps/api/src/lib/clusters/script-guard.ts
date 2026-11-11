// =============================================================================
//  HyperProx — the one rule for every script sent to a remote cluster's node
//
//  A SAFETY NET, NOT A SECURITY BOUNDARY. HyperProx's own scripts are fixed text, and this catches a mistake in one of
//  them (or a value that slipped into one) before it reaches a node. It refuses any script naming corosync,
//  pve-cluster or pmxcfs, and any /etc/pve path except the HyperProx documents: a container's own config
//  file (the guest config editor's write, and its temp files), reading ceph.conf (the hardware probe), and
//  reading the cluster's record of its nodes' SSH host keys (host-key verification). That last one is allowed
//  only as a whole line of exactly `cat -- <path> 2>/dev/null`, in a script made of nothing but those reads, its
//  `echo "@@hpx ..."` markers and `true`: a read, never a write, and no other line that could redefine `cat`.
//  Every check runs on the script as bash reads it, with backslash-newline continuations joined.
// =============================================================================

const ALLOWED_PVE = [
  /\/etc\/pve\/nodes\/[A-Za-z0-9.-]+\/lxc\/\d+\.conf(\.tmp\.hpx\.[A-Za-z0-9_.*$]*)?/g,
  /\/etc\/pve\/ceph\.conf/g,
]

// The record reads, as whole lines only (leading spaces allowed). Nothing before or after on that line.
const RECORD_READ_LINE = /^[ \t]*cat -- \/etc\/pve\/(priv\/known_hosts|nodes\/[A-Za-z0-9.-]+\/ssh_known_hosts) 2>\/dev\/null[ \t]*$/
// The only other lines a record-reading script may have: the section markers HyperProx writes, and `true`.
const RECORD_SCRIPT_LINE = /^[ \t]*(echo "@@hpx (priv|end|node [A-Za-z0-9.-]+)"|true)[ \t]*$/

export function assertSafeScript(script: string): void {
  // Checked as bash reads it: a backslash at the end of a line joins it to the next, so the checks see the join.
  const joined = String(script).replace(/\\\r?\n/g, '')
  if (/corosync|pve-cluster|pmxcfs/i.test(joined)) {
    throw new Error('Refused: this script names corosync or pve-cluster, which HyperProx never touches on any cluster.')
  }
  const lines = joined.split('\n')
  if (lines.some(l => RECORD_READ_LINE.test(l))) {
    // A script that reads the record is HyperProx's fixed reading script and nothing else, so no line of it can
    // redefine `cat` (an alias, a function, PATH) or do anything besides read.
    const other = lines.find(l => l.trim() && !RECORD_READ_LINE.test(l) && !RECORD_SCRIPT_LINE.test(l))
    if (other !== undefined) throw new Error('Refused: a script that reads the host-key record may contain only those reads and its own markers.')
    return
  }
  let rest = joined
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
//
//  Like assertSafeScript, this is a net for HyperProx's own mistakes, not a security boundary: it reads shell text
//  with patterns, and a script written to get past it (variables, eval, quoting) can. What keeps a node safe from
//  a hostile script is that only HyperProx's fixed scripts are ever sent, never text a person or a device supplied.
// =============================================================================

const APT_TOOL = /\b(apt-get|apt-mark|aptitude|apt|dpkg|proxmox-boot-tool|unattended-upgrades?)\b([^\n;|&)]*)/g
const APT_VERBS = new Set(['install', 'reinstall', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'full-upgrade', 'autoremove', 'autopurge', 'update', 'build-dep', 'source', 'download', 'clean', 'autoclean', 'markauto', 'unmarkauto', 'satisfy', 'changelog', 'check'])
const APT_GET_ALLOWED = new Set(['install', 'remove', 'update'])
const PROTECTED_PKG = /\b(linux-(image|headers|modules)|proxmox-(kernel|headers|default-kernel|ve|boot)|pve-(kernel|headers|manager|firmware)|nvidia|libnvidia|firmware-)[\w.+-]*/i

const APT_ALLOWED_OPTION = 'Dpkg::Options::=--force-confold'

/** apt-get options that take the next word as their value (`-o Foo=bar`, `-t bookworm-backports`). */
const APT_OPT_WITH_VALUE = new Set(['-o', '--option', '-t', '--target-release', '--default-release', '-c', '--config-file', '-a', '--host-architecture'])

/** apt's verb and the words after it, skipping options and the values they take. */
export function aptVerb(words: string[]): { verb: string; rest: string[]; options: string[] } {
  const options: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.startsWith('-')) {
      options.push(w)
      if (APT_OPT_WITH_VALUE.has(w) && i + 1 < words.length) options.push(words[++i])
      continue
    }
    const rest: string[] = []
    for (let j = i + 1; j < words.length; j++) {
      const x = words[j]
      if (!x.startsWith('-')) { rest.push(x); continue }
      options.push(x)
      if (APT_OPT_WITH_VALUE.has(x) && j + 1 < words.length) options.push(words[++j])
    }
    return { verb: w.replace(/^["']|["']$/g, ''), rest, options }
  }
  return { verb: '', rest: [], options }
}

export function assertAptInstallOnly(script: string): void {
  const lines = String(script).split('\n').filter(l => !/^\s*#/.test(l))
  for (const line of lines) {
    for (const m of line.matchAll(APT_TOOL)) {
      const tool = m[1], args = m[2] ?? ''
      // Words after the tool, up to the end of the command; the first word that is not an option (or an option's
      // value) is apt's verb.
      const words = args.trim().split(/\s+/).filter(Boolean)
      const { verb, rest, options } = aptVerb(words)
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
      if (options.some(w => /^--(allow-downgrades|allow-remove-essential|allow-change-held-packages|force-yes)(=|$)/.test(w))) throw new Error('Refused: monitoring never overrides apt\'s safety checks.')
      // An option value can change what apt does (a dpkg option, another config file, a different release).
      // The one dpkg option HyperProx's own install line uses (keep a changed config file) is allowed; any other
      // option value is refused.
      for (let i = 0; i < options.length; i++) {
        const w = options[i]
        if (w === '-o' || w === '--option') { if (options[i + 1] !== APT_ALLOWED_OPTION) throw new Error('Refused: monitoring never passes apt-get configuration or dpkg options other than keeping changed config files.'); i++; continue }
        if (/^-o\S|^--option=/.test(w) && w.replace(/^-o|^--option=/, '') !== APT_ALLOWED_OPTION) throw new Error('Refused: monitoring never passes apt-get configuration or dpkg options other than keeping changed config files.')
        if (/^(-t|--target-release|--default-release|-c|--config-file)(=|$)|^-t\S|^-c\S/.test(w)) throw new Error('Refused: monitoring never picks another release or config file for apt-get.')
      }
      if (verb === 'install' && options.some(w => w === '--only-upgrade')) throw new Error('Refused: monitoring never upgrades a package, even one at a time.')
      if ((verb === 'install' || verb === 'remove') && rest.some(w => PROTECTED_PKG.test(w.replace(/^["']|["']$/g, '')))) {
        throw new Error('Refused: monitoring never installs or removes a kernel, header, firmware, NVIDIA or Proxmox package.')
      }
    }
  }
}
