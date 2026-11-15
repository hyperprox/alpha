// What the Updates page offers on each kind of cluster. One page serves home and every remote
// (/clusters/<id>/updates), and every part of it works on both, through that cluster's own executor, except
// the two that are about this HyperProx install rather than the cluster:
//   - HyperProx's own update: it updates the HyperProx install itself, which never runs on a remote server;
//   - app updates from plug-ins: they use plug-in settings and proxy hosts kept for the home cluster.
// Those are left off a remote's page, so no control is shown that could only answer "home only".

import { NODE_LOGIN_HREF } from './node-login'

export interface UpdatesPageParts {
  /** HyperProx's own version and update. */
  selfUpdate: boolean
  /** App updates from plug-in providers (the apps count, app rows). */
  apps: boolean
  /** "Find compose projects in every guest". */
  discoverCompose: boolean
  /** Where "Add node login" goes: home's setup checklist, or the remote server's own logins. */
  nodeLoginHref: string
}

export function updatesPageParts(c: { id: string; kind: 'home' | 'remote' }): UpdatesPageParts {
  if (c.kind !== 'remote') return { selfUpdate: true, apps: true, discoverCompose: true, nodeLoginHref: NODE_LOGIN_HREF }
  return { selfUpdate: false, apps: false, discoverCompose: true, nodeLoginHref: `/clusters/${encodeURIComponent(c.id)}?tab=settings` }
}
