// Inline stroke icons for the dashboard. Text glyphs (✓ ⚠ →) pick up whatever
// font the browser finds, and some platforms draw them as colour emoji.

type IconProps = { size?: number; className?: string }

const base = (size: number) => ({
  width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
})

export function CheckIcon({ size = 12, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>
}

export function WarnIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2L1.5 13.5h13L8 2z" />
      <path d="M8 6.5v3.2" />
      <path d="M8 11.7v.1" />
    </svg>
  )
}

export function ArrowRightIcon({ size = 12, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M3 8h10M9 4l4 4-4 4" /></svg>
}
