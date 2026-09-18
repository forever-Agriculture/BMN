// MODULE: desktop-entry.mjs - installs the packaged app where this desktop looks for applications; --pin adds it to the GNOME dock
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedApp } from '../lib/packaged-app.mjs'

// Must match "desktopName" in apps/desktop/package.json: Electron derives the Wayland app_id from it.
const DESKTOP_ID = 'bmn.desktop'
const ICON_NAME = 'bmn'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { application, binary } = packagedApp(repoRoot)
const iconSource = join(repoRoot, 'apps/desktop/resources/icons')
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share')
const pin = process.argv.includes('--pin')

if (!existsSync(binary)) {
  console.error(`No packaged app at ${binary}. Run pnpm run package first.`)
  process.exit(1)
}

function writeAtomically(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, content, { mode: 0o644 })
  renameSync(temporary, path)
}

/** macOS finds applications by bundle, so the whole .app is copied into the user's Applications folder. */
function installApplicationBundle() {
  if (pin) {
    console.error('--pin is a GNOME dock setting. On macOS, drag BMN from Applications to the Dock.')
    process.exit(1)
  }
  const destination = join(homedir(), 'Applications', basename(application))
  mkdirSync(dirname(destination), { recursive: true })
  rmSync(destination, { recursive: true, force: true })
  // ditto keeps the ad-hoc code signature that Gatekeeper checks; cp -R does not.
  const copied = spawnSync('/usr/bin/ditto', [application, destination], { encoding: 'utf8' })
  if (copied.status !== 0) {
    console.error(`Could not install ${basename(application)}: ${copied.stderr.trim() || copied.error?.message}`)
    process.exit(1)
  }
  console.log(`Installed ${destination}`)
}

function installDesktopEntry() {
  const icons = join(dataHome, 'icons/hicolor')
  for (const file of readdirSync(join(iconSource, 'hicolor'))) {
    const size = file.replace(/\.png$/, '')
    mkdirSync(join(icons, size, 'apps'), { recursive: true })
    copyFileSync(join(iconSource, 'hicolor', file), join(icons, size, 'apps', `${ICON_NAME}.png`))
  }
  mkdirSync(join(icons, 'scalable/apps'), { recursive: true })
  copyFileSync(join(iconSource, 'bmn.svg'), join(icons, 'scalable/apps', `${ICON_NAME}.svg`))

  const entryPath = join(dataHome, 'applications', DESKTOP_ID)
  writeAtomically(entryPath, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=BMN',
    'Comment=Workspaces for Claude, Codex and shell sessions',
    `Exec="${binary}"`,
    `Icon=${ICON_NAME}`,
    'Terminal=false',
    'Categories=System;TerminalEmulator;',
    'StartupNotify=true',
    `StartupWMClass=${DESKTOP_ID.replace(/\.desktop$/, '')}`,
    ''
  ].join('\n'))

  const validation = spawnSync('desktop-file-validate', [entryPath], { encoding: 'utf8' })
  if (validation.status !== 0 && !validation.error) {
    console.error(`desktop-file-validate rejected ${entryPath}:\n${validation.stdout}${validation.stderr}`)
    process.exit(1)
  }
  spawnSync('update-desktop-database', [dirname(entryPath)])
  spawnSync('gtk-update-icon-cache', ['-f', '-t', icons])
  console.log(`Installed ${entryPath} and ${ICON_NAME} icons under ${icons}`)

  if (!pin) return
  const current = spawnSync('gsettings', ['get', 'org.gnome.shell', 'favorite-apps'], { encoding: 'utf8' })
  if (current.status !== 0) {
    console.error('Could not read GNOME dock favorites; pin BMN from the app grid instead.')
    process.exit(1)
  }
  const favorites = [...current.stdout.matchAll(/'([^']+)'/g)].map((match) => match[1])
  if (favorites.includes(DESKTOP_ID)) {
    console.log('BMN is already pinned to the dock.')
    return
  }
  // Sit beside the other terminals when one is pinned; otherwise go last.
  const terminals = ['io.github.melonamin.agterm.desktop', 'org.gnome.Terminal.desktop']
  const anchor = Math.max(...terminals.map((id) => favorites.indexOf(id)))
  favorites.splice(anchor >= 0 ? anchor + 1 : favorites.length, 0, DESKTOP_ID)
  const value = `[${favorites.map((id) => `'${id}'`).join(', ')}]`
  const set = spawnSync('gsettings', ['set', 'org.gnome.shell', 'favorite-apps', value], { encoding: 'utf8' })
  if (set.status !== 0) {
    console.error(`Could not pin BMN: ${set.stderr.trim()}`)
    process.exit(1)
  }
  console.log('Pinned BMN to the dock.')
}

if (process.platform === 'darwin') installApplicationBundle()
else installDesktopEntry()
