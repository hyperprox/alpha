import { alpha } from '@/lib/theme'
import { ACCENT } from '@/components/dashboard/Viz'
import { styles as vs } from '@/components/visual/kit'

// One title treatment for every card: the kit's uppercase condensed heading, led by a status dot in the
// card's colour. The name itself never takes the colour, so a card titled in green or red is never mistaken for
// a card reporting green or red; the badge beside it says the state in words.
export function CardTitle({ title, accent = ACCENT, badge, right }: { title: string; accent?: string; badge?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <h2 className={vs.panelTitle} style={{ alignItems: 'center' }}>
      <span aria-hidden className="w-2 h-2 rounded-full flex-shrink-0" style={{ background:accent, boxShadow:`0 0 8px ${alpha(accent, 60)}` }}/>
      <span className="truncate min-w-0">{title}</span>
      {badge}
      {right && <span className={vs.panelActs} style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{right}</span>}
    </h2>
  )
}
