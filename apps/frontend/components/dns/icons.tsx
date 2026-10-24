// Inline stroke icons for the DNS page. The design language has no emoji: they render differently on every
// platform and ignore the theme colour, where these follow currentColor.

type IconProps = { size?: number }

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {children}
    </svg>
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

export function SplitIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 8h4l4-4.5h4.5M5.5 8l4 4.5h4.5" />
      <path d="M12.5 2l1.5 1.5L12.5 5M12.5 11l1.5 1.5-1.5 1.5" />
    </Svg>
  )
}

export function MailIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M2 4.5l6 4.5 6-4.5" />
    </Svg>
  )
}

export function CheckCircleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.2 8.2l1.9 1.9 3.7-4" />
    </Svg>
  )
}

export function WrenchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.6 1.7a3.6 3.6 0 0 0-3.4 4.7L2 11.6a1.4 1.4 0 0 0 2 2l5.2-5.2a3.6 3.6 0 0 0 4.7-3.4l-2.1 2.1-1.9-.4-.4-1.9 2.1-2.1z" />
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
