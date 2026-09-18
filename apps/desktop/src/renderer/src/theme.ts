// MODULE: theme.ts - Knight and Cross identities, and the Steel, Brown, Dark and Black palettes for app chrome and the terminal
import type { AppearanceSettings, ColorModeName, IdentityName } from '@bmn/protocol'
import type { ITheme } from '@xterm/xterm'

/** The header's emblem and motto. */
export const IDENTITY_PRESENTATION: Readonly<Record<IdentityName, { label: string; icon: 'sword' | 'cross'; motto: string }>> = Object.freeze({
  knight: { label: 'Knight', icon: 'sword', motto: 'Audentes Fortuna Iuvat' },
  cross: { label: 'Cross', icon: 'cross', motto: 'Soli Deo Gloria' }
})

export const COLOR_MODE_PRESENTATION: Readonly<Record<ColorModeName, { label: string; description: string }>> = Object.freeze({
  steel: { label: 'Steel', description: 'cool' },
  brown: { label: 'Brown', description: 'warm' },
  dark: { label: 'Dark', description: 'neutral' },
  black: { label: 'Black', description: 'default, near-black' }
})

const SHARED_ANSI = {
  red: '#e5816c',
  green: '#9cbb91',
  yellow: '#e0b36a',
  blue: '#8aa9ec',
  magenta: '#b9a3e0',
  cyan: '#86bdb5',
  brightRed: '#f0a08e',
  brightGreen: '#b5d1aa',
  brightYellow: '#ecc88a',
  brightBlue: '#a9c0f2',
  brightMagenta: '#cdbbeb',
  brightCyan: '#a4d2cb'
} as const

export const TERMINAL_THEMES: Readonly<Record<ColorModeName, ITheme>> = Object.freeze({
  steel: {
    ...SHARED_ANSI,
    background: '#14171b',
    foreground: '#e3e6ea',
    cursor: '#e3e6ea',
    cursorAccent: '#14171b',
    selectionBackground: '#3b4552',
    selectionForeground: '#e3e6ea',
    black: '#20252b',
    brightBlack: '#78828e',
    white: '#cfd4da',
    brightWhite: '#f3f5f7'
  },
  brown: {
    ...SHARED_ANSI,
    background: '#1b1917',
    foreground: '#e8e2d6',
    cursor: '#e8e2d6',
    cursorAccent: '#1b1917',
    selectionBackground: '#524b3f',
    selectionForeground: '#e8e2d6',
    black: '#292521',
    brightBlack: '#7d7368',
    white: '#d5cdc0',
    brightWhite: '#f4efe6'
  },
  dark: {
    ...SHARED_ANSI,
    background: '#161616',
    foreground: '#e6e4e0',
    cursor: '#e6e4e0',
    cursorAccent: '#161616',
    selectionBackground: '#3f3f3f',
    selectionForeground: '#e6e4e0',
    black: '#222222',
    brightBlack: '#767370',
    white: '#d2d0cc',
    brightWhite: '#f5f4f2'
  },
  black: {
    ...SHARED_ANSI,
    background: '#0a0a0a',
    foreground: '#e8e8e8',
    cursor: '#e8e8e8',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#333333',
    selectionForeground: '#e8e8e8',
    black: '#1a1a1a',
    brightBlack: '#7a7a7a',
    white: '#d4d4d4',
    brightWhite: '#f5f5f5'
  }
})

/** Chrome colors come from CSS custom properties keyed by `data-color-mode` and `data-identity` on the root element. */
export function applyChromeTheme(
  appearance: Pick<AppearanceSettings, 'identity' | 'colorMode'>,
  root: HTMLElement = document.documentElement
): void {
  if (root.dataset.colorMode !== appearance.colorMode) root.dataset.colorMode = appearance.colorMode
  if (root.dataset.identity !== appearance.identity) root.dataset.identity = appearance.identity
}
