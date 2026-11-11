// =============================================================================
//  HyperProx — the User-Agent on HyperProx's own requests to sites
//
//  Every request HyperProx makes to a site it manages (the public check, the
//  catalogue's detection, the address checks when publishing or adopting)
//  says "HyperProx-<what>/1", so the site's own metrics can leave it out
//  instead of counting HyperProx as a visitor or a scanner.
// =============================================================================

export type OwnPurpose = 'site-check' | 'site-discovery' | 'publish-check' | 'site-probe' | 'install-check'

export function ownUserAgent(purpose: OwnPurpose): string { return `HyperProx-${purpose}/1` }

/** Headers for a fetch() from HyperProx to a site. */
export const ownHeaders = (purpose: OwnPurpose): Record<string, string> => ({ 'user-agent': ownUserAgent(purpose) })
