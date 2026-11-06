import type { ReactElement, SVGProps } from 'react'

// The preview's inline icons (`const I`), path for path. `size` is the preview's own width/height where it set one;
// the others take their size from CSS (.btn svg, .chip svg, .drop svg, .hint svg).
type IconDef = { size?: number; attrs: SVGProps<SVGSVGElement>; body: ReactElement }

const line = (width: number): SVGProps<SVGSVGElement> => ({ fill: 'none', stroke: 'currentColor', strokeWidth: width })
const round = { strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const ICONS = {
  next: { attrs: { ...line(2.4), ...round }, body: <path d="M5 12h14M13 6l6 6-6 6" /> },
  back: { attrs: { ...line(2.4), ...round }, body: <path d="M19 12H5M11 6l-6 6 6 6" /> },
  info: {
    attrs: line(2),
    body: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7.5v.5" strokeLinecap="round" />
      </>
    ),
  },
  lock: {
    size: 14,
    attrs: line(2),
    body: (
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
  video: {
    attrs: { ...line(1.8), strokeLinejoin: 'round' },
    body: (
      <>
        <rect x="3" y="6" width="13" height="12" rx="2.5" />
        <path d="M16 10.5 21 8v8l-5-2.5z" />
        <path d="M9.5 9.5v5M7 12h5" strokeLinecap="round" />
      </>
    ),
  },
  send: { attrs: { ...line(2.2), strokeLinejoin: 'round' }, body: <path d="M4 12 20 4l-5 16-3-7z" /> },
  sword: {
    attrs: { ...line(1.9), ...round },
    body: (
      <>
        <path d="M14.5 4H20v5.5L10 19.5 4.5 14z" />
        <path d="M4 20l3-3" />
      </>
    ),
  },
  home: { attrs: { ...line(1.9), strokeLinejoin: 'round' }, body: <path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z" /> },
  shop: {
    attrs: { ...line(1.9), strokeLinejoin: 'round' },
    body: (
      <>
        <path d="M5 8h14l-1.2 12H6.2z" />
        <path d="M9 8V6a3 3 0 0 1 6 0v2" />
      </>
    ),
  },
  crate: {
    attrs: { ...line(1.9), strokeLinejoin: 'round' },
    body: (
      <>
        <rect x="4" y="8" width="16" height="12" rx="1.5" />
        <path d="M3 8h18V5H3zM12 5v15" />
      </>
    ),
  },
  clan: { attrs: { ...line(1.9), strokeLinejoin: 'round' }, body: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /> },
  dots: {
    attrs: { fill: 'currentColor' },
    body: (
      <>
        <circle cx="6" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="18" cy="12" r="1.8" />
      </>
    ),
  },
  phone: {
    attrs: line(1.9),
    body: (
      <>
        <rect x="7" y="3" width="10" height="18" rx="2.5" />
        <path d="M11 18h2" strokeLinecap="round" />
      </>
    ),
  },
  pc: {
    attrs: line(1.9),
    body: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M9 20h6M12 16v4" />
      </>
    ),
  },
  tablet: {
    attrs: line(1.9),
    body: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2.5" />
        <path d="M11 18h2" strokeLinecap="round" />
      </>
    ),
  },
  pad: {
    attrs: { ...line(1.9), strokeLinecap: 'round' },
    body: (
      <>
        <path d="M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L14.5 13h-5l-1.1 1.8A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4z" />
        <path d="M8 10.5v3M6.5 12h3" />
      </>
    ),
  },
  check: { size: 20, attrs: { ...line(3), ...round }, body: <path d="m5 12 5 5 9-10" /> },
  eye: {
    size: 20,
    attrs: line(2.2),
    body: (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  },
  wrench: {
    size: 20,
    attrs: { ...line(2.2), strokeLinecap: 'round' },
    body: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  },
} satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS

export function Icon({ name, size }: { name: IconName; size?: number }) {
  const def: IconDef = ICONS[name]
  const px = size ?? def.size
  return (
    <svg viewBox="0 0 24 24" width={px} height={px} aria-hidden="true" focusable="false" {...def.attrs}>
      {def.body}
    </svg>
  )
}
