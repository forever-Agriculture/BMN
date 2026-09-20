// MODULE: icons.tsx - 16px stroke icons for shell controls; always paired with a visible or accessible label
const PATHS = {
  cross: 'M8 1.5v13M3.5 5.5h9',
  trophy: 'M4.5 2h7v4.5a3.5 3.5 0 0 1-7 0zM4.5 3H2.5v1.5a2 2 0 0 0 2 2M11.5 3h2v1.5a2 2 0 0 1-2 2M8 10v4M5.5 14h5',
  sword: 'M5.4 9.4 11.9 2.9 13.5 2.5 13.1 4.1 6.6 10.6M4 8l4 4M5.5 10.5l-2 2M3.7 13.2a.9.9 0 1 1-1.8 0 .9.9 0 1 1 1.8 0',
  split: 'M2.5 3.5h11v9h-11zM8 3.5v9',
  focus: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  files: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  mic: 'M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2zM4 7.5a4 4 0 0 0 8 0M8 11.5v3',
  clip: 'M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4.2-4.2',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.5h.01',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3l3.2 3.2',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3',
  close: 'M4 4l8 8M12 4l-8 8'
} as const

export type IconName = keyof typeof PATHS

export function Icon(props: { name: IconName; size?: number }): React.JSX.Element {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[props.name]} />
    </svg>
  )
}
