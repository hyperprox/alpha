// Inline stroke icons for the AI deployment page. The design language has no emoji: they render differently
// on every platform and ignore the theme colour, where these follow currentColor.

type IconProps = { size?: number }

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, display: 'inline-block', verticalAlign: '-0.15em' }}>
      {children}
    </svg>
  )
}

export function BoxIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 5.5L8 2.5l6 3v5L8 13.5l-6-3v-5z" />
      <path d="M2 5.5L8 8.5l6-3M8 8.5v5" />
    </Svg>
  )
}

export function SplitIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 8h4l4-4.5h4.5M5.5 8l4 4.5h4.5" />
      <path d="M12.5 2l1.5 1.5L12.5 5M12.5 11l1.5 1.5-1.5 1.5" />
    </Svg>
  )
}

export function GlobeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13" />
      <path d="M8 1.5c1.9 1.9 2.8 4.1 2.8 6.5S9.9 12.6 8 14.5C6.1 12.6 5.2 10.4 5.2 8S6.1 3.4 8 1.5z" />
    </Svg>
  )
}

export function HourglassIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 1.5h8M4 14.5h8" />
      <path d="M5 1.5v2.2L8 8l3-4.3V1.5M5 14.5v-2.2L8 8l3 4.3v2.2" />
    </Svg>
  )
}

export function LockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  )
}

export function GearIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2" />
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </Svg>
  )
}

export function BoltIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8l1-5.5z" />
    </Svg>
  )
}
