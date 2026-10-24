interface IconProps {
  size?: number
}

function svgProps(size: number): {
  viewBox: string
  width: number
  height: number
  fill: string
  stroke: string
  strokeWidth: number
  'aria-hidden': boolean
} {
  return {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    'aria-hidden': true
  }
}

export function IconServer({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <path d="M4.5 4.75h.01M4.5 11.25h.01" strokeLinecap="round" />
    </svg>
  )
}

export function IconDatabase({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <ellipse cx="8" cy="3.6" rx="5" ry="1.9" />
      <path d="M3 3.6v8.8c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9V3.6" />
      <path d="M3 8c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9" />
    </svg>
  )
}

export function IconSchema({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h2.1l1.3 1.6h4.4c.9 0 1.6.7 1.6 1.6v5.6c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6z" />
    </svg>
  )
}

export function IconTable({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M2.5 6.3h11M2.5 9.6h11M6.3 3v10" />
    </svg>
  )
}

export function IconView({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M1.8 8s2.4-4 6.2-4 6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.7" />
    </svg>
  )
}

export function IconRoutine({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M5.5 3.5L3 8l2.5 4.5M10.5 3.5L13 8l-2.5 4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconFolder({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h2.1l1.3 1.6h4.4c.9 0 1.6.7 1.6 1.6v5.6c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6z" />
    </svg>
  )
}

export function IconFolderPlus({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h2.1l1.3 1.6h4.4c.9 0 1.6.7 1.6 1.6v5.6c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6z" />
      <path d="M8 8v3M6.5 9.5h3" strokeLinecap="round" />
    </svg>
  )
}

export function IconCaret({
  size = 12,
  open = false
}: IconProps & { open?: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`icon-caret${open ? ' is-open' : ''}`}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

export function IconActivity({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M1.8 8h2.6l1.8-4 2.4 8 1.8-4h3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconSearch({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="7" cy="7" r="3.8" />
      <path d="M9.8 9.8l3.4 3.4" strokeLinecap="round" />
    </svg>
  )
}

export function IconKey({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="5.4" cy="5.4" r="2.6" />
      <path d="M7.3 7.3l5.4 5.4M10.4 10.4l1.3-1.3M12 12l1.2-1.2" strokeLinecap="round" />
    </svg>
  )
}

export function IconPlus({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3.2v9.6M3.2 8h9.6" strokeLinecap="round" />
    </svg>
  )
}

export function IconRefresh({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4" strokeLinecap="round" />
      <path d="M12.9 2.6V5h-2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconTrash({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M3 4h10M6.5 4V2.8h3V4M5 4l.6 8.4h4.8L11 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconCheck({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconQuery({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 5.5L3.5 8 6 10.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 5.5L12.5 8 10 10.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconImport({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 2.5v7.5" strokeLinecap="round" />
      <path d="M5 7l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12.5h10" strokeLinecap="round" />
    </svg>
  )
}

// Two arrows pointing opposite ways: moving data from one place to another.
export function IconTransfer({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 5.5h8" strokeLinecap="round" />
      <path d="M8 3l2.5 2.5L8 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 10.5h-8" strokeLinecap="round" />
      <path d="M8 8l-2.5 2.5L8 13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A database cylinder with a circular arrow: comparing and aligning two
// databases. Distinct from IconTransfer, which moves rows in one direction.
export function IconSync({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <ellipse cx="8" cy="4" rx="4.5" ry="1.8" />
      <path d="M3.5 4v5.5c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4" />
      <path d="M11.5 9.2v2.6" strokeLinecap="round" />
      <path d="M10 10.6l1.5 1.4 1.5-1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A stack with a downward arrow: writing a backup archive.
export function IconArchive({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="2.5" y="2.5" width="11" height="3" rx="1" />
      <path d="M3.5 5.5v7c0 .6.4 1 1 1h7c.6 0 1-.4 1-1v-7" />
      <path d="M8 8v3" strokeLinecap="round" />
      <path d="M6.5 9.5L8 11l1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A table with a plus: browsing and creating objects.
export function IconTablePlus({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="3" width="9.5" height="9" rx="1" />
      <path d="M2 6h9.5M5.5 3v9" />
      <path d="M12.5 9.5v4M10.5 11.5h4" strokeLinecap="round" />
    </svg>
  )
}

export function IconUsers({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="6" cy="5.5" r="2.2" />
      <path d="M2.5 13c0-2 1.6-3.4 3.5-3.4S9.5 11 9.5 13" strokeLinecap="round" />
      <path d="M10.5 4a2 2 0 0 1 0 3.6" strokeLinecap="round" />
      <path d="M11.5 9.8c1.3.4 2.2 1.5 2.2 3.2" strokeLinecap="round" />
    </svg>
  )
}

export function IconClose({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  )
}

export function IconPencil({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9z" strokeLinejoin="round" />
      <path d="M9.8 4l2.2 2.2" />
    </svg>
  )
}

export function IconPlug({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M6 2.5v3M10 2.5v3M4.5 5.5h7v1.6a3.5 3.5 0 0 1-7 0z"
        strokeLinejoin="round"
      />
      <path d="M8 10.6v2.9" strokeLinecap="round" />
    </svg>
  )
}

export function IconUnplug({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M6 2.5v3M10 2.5v3M4.5 5.5h7v1.6a3.5 3.5 0 0 1-7 0z"
        strokeLinejoin="round"
      />
      <path d="M8 10.6v2.9" strokeLinecap="round" />
      <path d="M2 2l12 12" strokeLinecap="round" />
    </svg>
  )
}

export function IconSun({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="2.9" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconMoon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M13 9.5A5.3 5.3 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Speech bubble with text lines: the assistant is a conversation surface, not a
// "magic" feature. Chosen over a sparkle because the sparkle implies automatic
// generation, which is not what this panel does.
export function IconChat({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h7.8c.9 0 1.6.7 1.6 1.6v5c0 .9-.7 1.6-1.6 1.6H6.4L3.6 13c-.4.3-1.1 0-1.1-.5z"
        strokeLinejoin="round"
      />
      <path d="M5.2 5.9h5.6M5.2 8.3h3.6" strokeLinecap="round" />
    </svg>
  )
}

// Sidebar layout glyph: two panes, used for the dock toggle.
export function IconSidebar({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="3" width="12" height="10" rx="1.4" />
      <path d="M9.4 3v10" />
    </svg>
  )
}

// Gear: a ring with teeth and a hub. The previous glyph was a circle with eight
// rays, which reads as a brightness control rather than settings.
export function IconSettings({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="2.1" />
      <path
        d="M8 1.6l1 1.5 1.8-.4.4 1.8 1.6 1-.7 1.7.7 1.7-1.6 1-.4 1.8-1.8-.4-1 1.5-1-1.5-1.8.4-.4-1.8-1.6-1 .7-1.7-.7-1.7 1.6-1 .4-1.8 1.8.4z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Run/stop pair. A filled triangle and a filled square are the two shapes every
// database client uses for these actions, so they need no label to be read.
export function IconPlay({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M5 3.2c0-.6.7-1 1.2-.6l6 4.2c.4.3.4.9 0 1.2l-6 4.2c-.5.4-1.2 0-1.2-.6z" />
    </svg>
  )
}

export function IconStop({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
    </svg>
  )
}

// Floppy disk: save. The outline (not a filled block) keeps it quiet next to the
// filled run button, which is the only primary action in the toolbar.
export function IconSave({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 2.8h7.4L13 5.4v7.8H3z" strokeLinejoin="round" />
      <path d="M5.5 2.8v3.4h4.2V2.8M5.5 13.2V9.4h5v3.8" strokeLinejoin="round" />
    </svg>
  )
}

// Document with decreasing line lengths: format/prettify. Not a wand, because
// this action is deterministic local formatting, not generation.
export function IconFormat({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M2.6 3.6h10.8M2.6 6.8h7.4M2.6 10h10.8M2.6 13.2h5.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

// Clock with a counter-clockwise arrow: query history.
export function IconHistory({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" strokeLinecap="round" />
      <path d="M2.4 2.6v2.6h2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5.4V8l1.9 1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Branching tree: the shape of an execution plan, so the button reads as
// "show how the server will run this" rather than a generic chart.
export function IconPlan({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="5.8" y="1.8" width="4.4" height="3.2" rx="0.8" />
      <rect x="1.6" y="11" width="4.4" height="3.2" rx="0.8" />
      <rect x="10" y="11" width="4.4" height="3.2" rx="0.8" />
      <path d="M8 5v3.2M3.8 11V8.2h8.4V11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Wrench: fix and optimize actions that rewrite the SQL. Distinct from the chat
// bubble so the two AI surfaces are not confused at a glance.
export function IconWrench({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M10.9 2.2a3.3 3.3 0 0 0-3.9 4.3l-4.4 4.4a1.4 1.4 0 0 0 0 2l.5.5a1.4 1.4 0 0 0 2 0l4.4-4.4a3.3 3.3 0 0 0 4.3-3.9l-1.9 1.9-1.7-.4-.4-1.7z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconMore({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3.4" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.6" cy="8" r="1.2" />
    </svg>
  )
}

// Severity glyphs for notifications. A triangle for a failure and a circled
// letter for information are the two shapes desktop notification trays use, so
// the row reads at a glance without a tinted background.
export function IconAlert({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 2.6 14 13H2z" strokeLinejoin="round" />
      <path d="M8 6.6v3.2" strokeLinecap="round" />
      <path d="M8 11.6h.01" strokeLinecap="round" strokeWidth={2} />
    </svg>
  )
}

export function IconInfo({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 7.2v3.6" strokeLinecap="round" />
      <path d="M8 4.9h.01" strokeLinecap="round" strokeWidth={2} />
    </svg>
  )
}
