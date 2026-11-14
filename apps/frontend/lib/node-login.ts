// One way to say "this page needs a login for your nodes", and one place to go to add it. The login is saved
// on Settings -> Setup checklist (one login, tested on every node, kept in the vault per node).

export const NODE_LOGIN_LABEL = 'Add node login'
export const NODE_LOGIN_HREF = '/settings/setup-checklist#node-login'
export const NODE_LOGIN_WHY = 'HyperProx needs a saved login for each node to do this.'

/** Whether an error from the API is the "no saved login for a node" refusal, whatever its wording. */
export function isNoLoginText(text: string | null | undefined): boolean {
  return !!text && /\b(no (saved )?login|login (is )?not saved|there is none \(or HyperProx is locked\))\b/i.test(text)
}

/**
 * The same refusal with the advice stripped: the API's own sentences name different places to add the login
 * ("in the Terminal", "under Settings -> Nodes"), and the action beside it is the one place that is right.
 */
export function withoutLoginAdvice(text: string): string {
  return text
    .replace(/\s*\(node logins are never borrowed from guests\)/gi, '')
    .replace(/\s*(Add (one|it)|add (one|it))\s+(in the Terminal|under Settings\s*(→|->)\s*\w+( and [^.]*)?|on Settings\s*(→|->)\s*[\w ]+)[^.]*\.?/g, '')
    .replace(/:\s*add one under Settings\s*(→|->)\s*Nodes to list its devices\./i, '.')
    .replace(/\s+/g, ' ').trim()
}

/** What a guest row on Updates says about why it is not managed. */
export function unmanagedWords(g: { unmanagedReason?: string; error?: string }, reasons: Record<string, string>): string {
  if (g.unmanagedReason) return reasons[g.unmanagedReason] ?? g.unmanagedReason
  if (isNoLoginText(g.error)) return 'needs a node login'
  if (g.error) return 'could not be read'
  return 'not reported'
}
