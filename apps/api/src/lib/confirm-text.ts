// =============================================================================
//  HyperProx — What a confirmation says
//  One plain-English sentence for each kind of confirmed action (lib/confirm.ts), worked out on the server from the
//  request itself, so the page shows what will really happen. A route a handler confirms with its own words passes
//  them to requireConfirm instead. Anything not listed here gets a sentence built from its address.
// =============================================================================

/** The header a confirmed request carries its token in (lib/confirm.ts). Here so the demo can name it without the store. */
export const CONFIRM_HEADER = 'x-hyperprox-confirm'

type Params = Record<string, unknown>
type Rule = [method: string | RegExp, path: RegExp, say: (m: RegExpExecArray, p: Params, body: any) => string]

const str = (v: unknown, max = 60) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '')
const named = (v: unknown, fallback: string) => (str(v) ? `"${str(v)}"` : fallback)
const guest = (type: string, vmid: string) => `${type === 'qemu' || type === 'vm' ? 'VM' : 'container'} ${vmid}`

const PLUGIN: Record<string, string> = {
  'home-assistant': 'Home Assistant', qnap: 'QNAP NAS', pihole: 'Pi-hole', adguard: 'AdGuard Home', asus: 'ASUS router',
  pbs: 'Proxmox Backup Server', nextcloud: 'Nextcloud', k3s: 'K3s cluster', homepage: 'Homepage', '3proxy': '3proxy',
  'apt-cacher-ng': 'package cache', plex: 'Plex',
}
const pluginName = (id: string) => PLUGIN[id] ?? id

/**
 * Names only a running service knows: the release a person picked from a search, the port the VPN forwards. The route
 * that owns those ids sets the look-up when it is registered (routes/arr-better.ts, routes/arr-vpn.ts); without one, or
 * when it finds nothing, the sentence uses plain words instead. The names come from the server, never from the body.
 */
export interface ConfirmNames {
  betterGrab?: (target: string, releaseId: string, override: boolean) => { item: string; release: string; swap: string | null; app?: string; verdict?: string; group?: string; reasons?: string[] } | null
  vpnPort?: () => number | null
  routerMove?: (app: unknown, id: unknown, folder: unknown) => { title: string; folder: string } | null
  routerGraduate?: (previewId: unknown) => { count: number; folder: string } | null
  routerLibrary?: (previewId: unknown, ids: unknown) => { count: number; groups: string[] } | null
  routerLibraryUndo?: (app: unknown) => { count: number } | null
}
const names: ConfirmNames = {}
export function setConfirmNames(n: ConfirmNames): void { Object.assign(names, n) }

function betterGrabSentence(b: any): string {
  const n = typeof b?.target === 'string' && typeof b?.releaseId === 'string' ? names.betterGrab?.(b.target, b.releaseId, b?.override === true) ?? null : null
  const what = n && str(n.release, 120) ? `"${str(n.release, 120)}"${str(n.item, 80) ? ` for ${str(n.item, 80)}` : ''}` : 'the release you picked'
  const swap = n?.swap && str(n.swap, 120) ? ` Then the slow download, "${str(n.swap, 120)}", is removed and blocklisted.` : ''
  // "Download anyway": the arr's own reasons, said before anything is asked of it.
  if (b?.override === true && n?.verdict === 'refused') {
    const why = (n.reasons ?? []).map(r => str(r, 120)).filter(Boolean).slice(0, 6).map(r => r.charAt(0).toLowerCase() + r.slice(1)).join('; ')
    const second = n.group === 'queue' && !n.swap ? ' This starts a second download alongside the one already downloading. To replace it, use Find a faster copy.' : ''
    return `${str(n.app, 20) || 'The app'} refuses ${what} because: ${why || 'no reason given'}. Download it anyway and move it to the top of the queue?${swap}${second}`
  }
  return `Download ${what} and move it to the top of the queue?${swap}`
}

function vpnFixSentence(b: any): string {
  if (b?.action === 'reconnect') return 'Reconnect the VPN? Downloads pause for about a minute.'
  if (b?.action === 'restart-qbit') return 'Restart qBittorrent? Downloads pause while it starts again.'
  if (b?.action === 'set-port') {
    const p = names.vpnPort?.() ?? null
    return Number.isInteger(p) && p! > 0 && p! < 65536 ? `Put port ${p} into qBittorrent?` : 'Put the port the VPN forwards into qBittorrent?'
  }
  return 'Run this fix on the VPN?'
}

function routerSettingsSentence(b: any): string {
  const what = b?.app === 'sonarr' ? 'shows' : b?.app === 'radarr' ? 'films' : 'requests'
  if (b?.settings?.enabled === true) return `Sort new ${what} into folders? From now on, each new request is moved into the folder its rules pick about a minute after it is added. Nothing already in your library moves.`
  return `Save the folder rules for ${what}? Sorting stays off; nothing moves.`
}

function routerMoveSentence(b: any): string {
  const n = names.routerMove?.(b?.app, b?.id, b?.folder) ?? null
  return n ? `Move ${str(n.title, 100)} to ${str(n.folder, 80)}? Its files move with it.` : 'Move this item to the folder you picked? Its files move with it.'
}

function routerGraduateSentence(b: any): string {
  const n = names.routerGraduate?.(b?.previewId) ?? null
  const what = n ? `${n.count} finished ${n.count === 1 ? 'show' : 'shows'} to ${str(n.folder, 80)}` : 'the finished shows in the preview'
  return `Move ${what}? Their files move with them, and shows that finish from now on move on their own.`
}

function routerLibrarySentence(b: any): string {
  const n = names.routerLibrary?.(b?.previewId, b?.ids) ?? null
  if (!n || !n.count) return 'Move the items you ticked into the folders your rules pick? Their files move with them.'
  const list = n.groups.slice(0, 6).map(g => str(g, 120)).join('; ')
  const more = n.groups.length > 6 ? `; and ${n.groups.length - 6} more groups` : ''
  return `Move ${n.count} ${n.count === 1 ? 'item' : 'items'} in your library into the folders your rules pick? ${list}${more}. Their files move with them, 20 a minute.`
}

const RULES: Rule[] = [
  // ── Updates and node reboots ──
  ['POST', /^\/api\/updates\/nodes\/([^/]+)\/reboot$/, m =>
    `Reboot ${m[1]}? Its HA guests move to other nodes first, then it restarts. This usually takes about 5 minutes.`],
  ['POST', /^\/api\/updates\/jobs$/, (_m, _p, b) =>
    (Array.isArray(b?.select) ? `Install the updates on the ${b.select.length} chosen target${b.select.length === 1 ? '' : 's'}? Guests may restart.`
      : 'Run the updates now? Nodes and guests may restart while they install.')
      + (b?.autoReboot === true ? ' Then, in the next reboot window, whatever this run leaves needing a reboot restarts on its own, where your policy allows it (reboot: auto).' : '')],
  ['POST', /^\/api\/updates\/jobs\/[^/]+\/confirm$/, () => 'Carry on with this update run? The next step starts as soon as you confirm.'],
  ['POST', /^\/api\/updates\/jobs\/[^/]+\/resume$/, () => 'Resume this update run from where it stopped?'],
  ['POST', /^\/api\/updates\/jobs\/[^/]+\/rollback$/, (_m, _p, b) =>
    `Roll back guest ${str(b?.target, 12) || 'this guest'} to the snapshot taken before its update? Changes made since then are lost.`],
  ['PUT', /^\/api\/updates\/reboots\/settings$/, (_m, _p, b) =>
    b?.nodes || b?.guests ? 'Save the automatic reboot settings? Machines that need a reboot will restart on their own in the window, one at a time.' : 'Save the automatic reboot settings?'],
  ['POST', /^\/api\/updates\/reboots\/now$/, (_m, _p, b) =>
    b?.all === true ? 'Reboot every node now, one at a time? HA guests move first; guests that cannot move restart with their node.'
      : 'Reboot everything that is waiting for a reboot now, one at a time? HA guests move first; guests that cannot move restart with their node.'],
  ['POST', /^\/api\/updates\/reboots\/make-safe$/, () => 'Clear what the stopped reboot left on? HA maintenance comes off; Ceph noout comes off only if every OSD is up.'],
  ['POST', /^\/api\/self-update\/install$/, () => 'Update HyperProx now? It restarts and you will need to sign in again.'],
  ['PUT', /^\/api\/self-update\/settings$/, () => 'Save how HyperProx updates itself?'],
  // ── Guests ──
  ['DELETE', /^\/api\/proxmox\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)$/, m =>
    `Delete ${guest(m[2], m[3])} on ${m[1]}? Its disks are destroyed. This cannot be undone.`],
  ['POST', /^\/api\/clusters\/[^/]+\/guests\/([^/]+)\/(lxc|qemu)\/(\d+)\/delete$/, m =>
    `Delete ${guest(m[2], m[3])} on ${m[1]}? Its disks are destroyed. This cannot be undone.`],
  ['POST', /^\/api\/infra\/guest-config\/apply$/, () => 'Apply these changes to the guest\'s configuration? Some take effect only after it restarts.'],
  ['POST', /^\/api\/placement\/guests\/(lxc|qemu)\/(\d+)\/move$/, (m, _p, b) =>
    `Move ${guest(m[1], m[2])}${str(b?.target) ? ` to ${str(b.target)}` : ''}${b?.when === 'next-quiet' ? ' in the next quiet hours' : ' now'}? It may be briefly unreachable.`],
  ['POST', /^\/api\/placement\/plans$/, () => 'Run this balancing plan? Each guest in it moves in turn and may be briefly unreachable.'],
  ['PUT', /^\/api\/placement\/settings$/, () => 'Save the load balancing settings? They decide when approved moves run.'],
  ['PUT', /^\/api\/placement\/auto$/, (_m, _p, b) => b?.apply === true
    ? 'Save automatic balancing and let it move guests by itself?' : 'Save the automatic balancing settings?'],
  ['POST', /^\/api\/ha\/plans\/[^/]+\/apply$/, () => 'Apply these HA changes? They are written to the whole cluster\'s HA configuration.'],
  ['POST', /^\/api\/removed-guests\/(\d+)\/clean-up$/, m =>
    `Clean up after removed guest ${m[1]}? Its saved logins are deleted and it is taken out of backup jobs and HA.`],
  // ── Catalogue, sites ──
  ['POST', /^\/api\/catalogue\/wizard\/apply$/, () => 'Install this app? HyperProx creates the container and sets it up.'],
  ['POST', /^\/api\/catalogue\/wizard\/jobs\/[^/]+\/cleanup$/, () => 'Clean up this failed install? The container it created is destroyed.'],
  ['POST', /^\/api\/catalogue\/wizard\/jobs\/[^/]+\/finish-seerr$/, () => 'Finish setting up Seerr with these choices?'],
  ['PUT', /^\/api\/catalogue\/wizard\/naming$/, () => 'Save the naming and address settings? Every new guest follows them.'],
  ['POST', /^\/api\/sites\/[^/]+\/delete$/, () => 'Delete this website? Its DNS, proxy hosts and anything else you chose go with it.'],
  // ── Plug-ins ──
  ['POST', /^\/api\/plugins\/home-assistant\/instances\/[^/]+\/secure-actions$/, (_m, _p, b) =>
    `${str(b?.action, 30) ? `Send "${str(b.action, 30)}" to` : 'Control'} this security device in Home Assistant? It acts on the real device straight away.`],
  ['POST', /^\/api\/plugins\/qnap\/instances\/[^/]+\/secure-actions$/, (_m, _p, b) =>
    b?.action === 'shutdown' ? 'Shut down this NAS? Everything stored on it is unreachable until someone presses its power button.'
      : b?.action === 'restart' ? 'Restart this NAS? Everything stored on it is unreachable for 3 to 10 minutes.' : 'Run this action on the NAS?'],
  ['POST', /^\/api\/plugins\/asus\/instances\/[^/]+\/actions$/, () => 'Run this action on the router? Your network may drop for a few minutes.'],
  ['POST', /^\/api\/plugins\/(pihole|adguard)\/instances\/[^/]+\/secure-actions$/, m => `Make this change to ${pluginName(m[1])}? It affects DNS for everything that uses it.`],
  ['POST', /^\/api\/plugins\/pbs\/instances\/[^/]+\/actions\/verify$/, () => 'Start a verify on this backup server now? It reads every backup and can take hours.'],
  ['POST', /^\/api\/plugins\/pbs\/instances\/[^/]+\/manage\/apply$/, () => 'Apply these backup changes on the backup server?'],
  ['POST', /^\/api\/plugins\/pbs\/instances\/[^/]+\/manage\/gc$/, () => 'Start garbage collection on this datastore now?'],
  ['POST', /^\/api\/plugins\/nextcloud\/instances\/[^/]+\/secure-actions\/([^/]+)$/, m => `Run "${m[1].replace(/[-_]/g, ' ')}" on this Nextcloud? It may be unavailable while it runs.`],
  ['POST', /^\/api\/plugins\/nextcloud\/instances\/[^/]+\/jobs\/[^/]+\/stop-watching$/, () => 'Stop watching this job? HyperProx forgets it, even if it is still running.'],
  ['POST', /^\/api\/plugins\/k3s\/clusters\/[^/]+\/actions\/([^/]+)$/, m => `Run "${m[1].replace(/[-_]/g, ' ')}" on this K3s cluster?`],
  ['POST', /^\/api\/plugins\/plex\/(clearout|library)\/remove$/, (_m, _p, b) => {
    const n = Array.isArray(b?.items) ? b.items.length : Array.isArray(b?.ids) ? b.ids.length : 0
    return `Remove ${n ? `${n} item${n === 1 ? '' : 's'}` : 'these items'} from your library? Their files are deleted.`
  }],
  ['POST', /^\/api\/plugins\/arrstack\/better\/grab$/, (_m, _p, b) => betterGrabSentence(b)],
  ['POST', /^\/api\/plugins\/arrstack\/vpn\/actions$/, (_m, _p, b) => vpnFixSentence(b)],
  ['POST', /^\/api\/plugins\/arrstack\/router\/settings$/, (_m, _p, b) => routerSettingsSentence(b)],
  ['POST', /^\/api\/plugins\/arrstack\/router\/move$/, (_m, _p, b) => routerMoveSentence(b)],
  ['POST', /^\/api\/plugins\/arrstack\/router\/graduate$/, (_m, _p, b) => routerGraduateSentence(b)],
  ['POST', /^\/api\/plugins\/arrstack\/router\/library\/apply$/, (_m, _p, b) => routerLibrarySentence(b)],
  ['POST', /^\/api\/plugins\/arrstack\/router\/library\/undo$/, (_m, _p, b) => {
    const n = names.routerLibraryUndo?.(b?.app)?.count ?? 0
    const what = b?.app === 'sonarr' ? 'shows' : 'films'
    return n ? `Undo the last library sort of your ${what}? The ${n} ${n === 1 ? 'item' : 'items'} it moved go back where they were, 20 a minute, each only if it is still where the sort put it.`
      : `Undo the last library sort of your ${what}? What it moved goes back where it was, if it is still where the sort put it.`
  }],
  ['POST', /^\/api\/plugins\/arrstack\/router\/library\/stop$/, (_m, _p, b) => `Stop sorting the ${b?.app === 'sonarr' ? 'shows' : 'films'} in your library? It stops before the next move; what has moved stays moved.`],
  ['POST', /^\/api\/local\/([^/]+)\//, m => `Run this ${m[1]} action?`],
  ['POST', /^\/api\/plugins\/apt-cacher-ng\/guests\/repair$/, () =>
    'Write the package cache setting on every guest Updates looks after, and check each can reach it?'],
  ['POST', /^\/api\/plugins\/apt-cacher-ng\/guests\/remove$/, () =>
    'Remove the package cache setting from every guest? They download packages directly again.'],
  ['PUT', /^\/api\/plugins\/apt-cacher-ng\/use$/, (_m, _p, b) => b?.mode === 'off'
    ? 'Stop Updates using the package cache?' : 'Save how Updates uses the package cache for the guests it looks after?'],
  ['PUT', /^\/api\/plugins\/apt-cacher-ng\/caches\/[^/]+\/settings$/, () => 'Save the package cache settings? They decide who may use it.'],
  [/^(PUT|DELETE)$/, /^\/api\/plugins\/([^/]+)\/settings$/, (m, _p, _b) => `Save the connection settings for ${pluginName(m[1])}?`],
  // ── Setup checklist ──
  ['POST', /^\/api\/setup-checklist\/([^/]+)\/run$/, m => `Run "${m[1].replace(/[-_]/g, ' ')}" on your nodes? It runs as root.`],
  // ── Clusters, remote access, settings ──
  ['POST', /^\/api\/clusters\/[^/]+\/monitoring\/apply$/, () => 'Install or change monitoring on this cluster\'s nodes?'],
  ['POST', /^\/api\/remote\/jobs$/, () => 'Start this remote access job? It installs or changes software on the machines you chose.'],
  ['PUT', /^\/api\/remote\/exclusions$/, () => 'Save which guests HyperProx must never look inside?'],
  ['PUT', /^\/api\/settings\/([^/]+)\/([^/]+)$/, m => `Save the ${m[1]} ${m[2]} settings?`],
  ['POST', /^\/api\/settings\/test\/([^/]+)\/([^/]+)$/, m => `Test the ${m[1]} ${m[2]} connection? HyperProx sends the saved login to the saved address.`],
  ['POST', /^\/api\/monitoring\/grafana-admin\/reset$/, () => 'Set a new Grafana admin password? It is saved in the vault; the old one stops working.'],
]

const VERB: Record<string, string> = { POST: 'Run', PUT: 'Save', PATCH: 'Save', DELETE: 'Remove' }

/** The sentence a confirmation shows for this request. */
export function describeAction(method: string, route: string, url: string, params: Params, body: unknown): string {
  const m = method.toUpperCase()
  const path = (url.split('?')[0] || route)
  for (const [rm, re, say] of RULES) {
    if (typeof rm === 'string' ? rm !== m : !rm.test(m)) continue
    const hit = re.exec(path)
    if (hit) {
      try { return say(hit, params, body ?? {}) } catch { break }
    }
  }
  // /api/plugins/<id>/instances/... → "Save this change to Home Assistant?"
  const plugin = /^\/api\/plugins\/([^/]+)\//.exec(path)
  const what = plugin ? pluginName(plugin[1])
    : path.replace(/^\/api\//, '').split('/').filter(s => s && !/^(c[0-9a-f]{10}|\d+|[0-9a-f-]{20,})$/i.test(s)).slice(0, 3).join(' ').replace(/[-_]/g, ' ')
  if (m === 'DELETE') return `Remove this from ${what || 'HyperProx'}? This cannot be undone.`
  return `${VERB[m] ?? 'Make'} this change to ${what || 'HyperProx'}?`
}
