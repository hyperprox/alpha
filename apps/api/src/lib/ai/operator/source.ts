// The read-only knowledge source behind "how is the AI operator set up?" (lib/ai/ask-sources.ts pattern).
// A summary of settings and spend: no key, no question text, no answer text.
import type { AskSource, SourceSummary } from '../ask'
import { LOCKED_NOTE } from '../ask'
import { isCloud, type Tier } from './types'
import type { OperatorService } from './service'

const word = (t: Tier) => (t === 'local' ? 'local model' : t[0].toUpperCase() + t.slice(1))
const usd = (n: number) => `$${n.toFixed(2)}`

export async function operatorSummary(svc: OperatorService): Promise<SourceSummary> {
  const { tiers, spend, settings } = await svc.summary()
  const lines = tiers.map(t => `${word(t.tier)}: ${t.ready ? 'ready' : t.enabled ? `not ready, needs ${t.missing || 'setup'}` : 'turned off'} (model ${t.model}).`)
  lines.push(`Opus ${settings.opusNeedsApproval ? 'asks for approval each time' : 'runs without asking'}.`)
  lines.push(`This month's estimated cloud spend is ${usd(spend.monthUsd)}${spend.capUsd > 0 ? ` of a ${usd(spend.capUsd)} cap` : ' (no cap set)'}.`)
  lines.push(`Addresses and host names are ${settings.redactBeforeCloud ? 'hidden' : 'NOT hidden'} before anything goes to the cloud.`)
  if (settings.localOnlyTopics.length) lines.push(`Kept on the local model: ${settings.localOnlyTopics.length} topic${settings.localOnlyTopics.length === 1 ? '' : 's'}.`)
  const ready = tiers.filter(t => t.ready)
  const cloudReady = ready.filter(t => isCloud(t.tier)).length
  return { headline: `AI operator: ${ready.length} of 4 tiers ready${cloudReady ? '' : ', none in the cloud'}.`, lines, data: { spend } }
}

export function operatorSource(d: { unlocked: () => boolean; service: () => OperatorService | null }): AskSource {
  return {
    id: 'operator', title: 'AI operator', blurb: 'the tier ladder (local, Haiku, Sonnet, Opus), approvals, monthly spend and privacy settings',
    aliases: /\b(operator|tiers?|haiku|sonnet|opus|escalat\w*|ai spend|monthly cap|keep(?:\s+it)? local|local[- ]only)\b/,
    overview: false,
    load: async () => {
      const svc = d.service()
      if (!d.unlocked()) return { headline: 'AI operator: locked.', lines: [LOCKED_NOTE], locked: true }
      if (!svc) return { headline: 'AI operator: not started.', lines: [], unread: ['the AI operator (not started)'] }
      return operatorSummary(svc)
    },
  }
}
