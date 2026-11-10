// =============================================================================
//  HyperProx — take addresses out of text that leaves HyperProx
//
//  Notifications, audit entries and pause reasons are read in places HyperProx does not control (a chat
//  channel, a phone's lock screen). An error from a node or an API often names an address, a URL or a
//  host:port; those are replaced with a placeholder here. Shared by the notification renderer and Updates.
// =============================================================================

/** Replace URLs, IPv4 and IPv6 addresses and host:port with placeholders. */
export function stripAddresses(s: string): string {
  return String(s ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replace(/\[[0-9a-f:.]+\](?::\d{1,5})?/gi, '[address]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '[address]')
    // IPv6: hex groups with colons, holding a "::" or a hex letter (so a time such as 06:30:00 is left alone).
    .replace(/\b[0-9a-f]{1,4}(?::{1,2}[0-9a-f]{0,4}){2,7}/gi, m => (/::|[a-f]/i.test(m) ? '[address]' : m))
    // host.domain:port
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{1,5}\b/gi, '[address]')
}

/** A reason short enough for a message or the page, without addresses. */
export function shortReason(s: string, max = 140): string {
  return stripAddresses(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, max)
}
