// MODULE: animation.ts - the Codex-style Sixel animation the self-test runs in a pane; its native PTY test runs the same bytes

/** One 96x75 Sixel frame in eight colors; `seed` varies the palette and pattern between frames. */
export function codexSixelFrame(seed: number): string {
  let body = ''
  for (let color = 0; color < 8; color += 1) {
    body += `#${color};2;${(color * 37 + seed * 11) % 100};${(color * 53) % 100};${(color * 71 + seed * 5) % 100}`
  }
  for (let row = 0; row < 13; row += 1) {
    for (let color = 0; color < 8; color += 1) {
      body += `#${color}`
      for (let x = 0; x < 96; x += 1) body += String.fromCharCode(63 + ((x * 7 + row * 13 + color * 5 + seed) % 64))
      if (color < 7) body += '$'
    }
    if (row < 12) body += '-'
  }
  return `\u001bP9;1;0q"1;1;96;75${body}\u001b\\`
}

/**
 * Arguments: frame count, seconds between frames, label. Each frame blanks the pet's rows, draws frame0.six or
 * frame1.six from its own folder there and restores the cursor; the last line is `<label>-DONE`.
 */
export const POSIX_ANIMATION_SCRIPT = [
  '#!/bin/sh',
  'frames=$1; delay=$2; label=$3; dir=$(dirname "$0"); i=0',
  'while [ "$i" -lt "$frames" ]; do',
  "  printf '\\0337'",
  "  r=2; while [ \"$r\" -le 7 ]; do printf '\\033[%d;40H%24s' \"$r\" ''; r=$((r + 1)); done",
  "  printf '\\033[2;40H'; cat \"$dir/frame$((i % 2)).six\"; printf '\\0338'",
  '  i=$((i + 1)); sleep "$delay"',
  'done',
  "printf '%s-DONE\\r\\n' \"$label\""
].join('\n') + '\n'

/** Windows: the same frames, cursor save/restore and pacing from a Node stand-in. */
export const NODE_ANIMATION_SOURCE = [
  "const { readFileSync } = require('node:fs')",
  'const [frames, delay, label] = process.argv.slice(2)',
  ';(async () => {',
  '  for (let i = 0; i < Number(frames); i += 1) {',
  "    let out = '\\u001b7'",
  "    for (let r = 2; r <= 7; r += 1) out += '\\u001b[' + r + ';40H' + ' '.repeat(24)",
  "    out += '\\u001b[2;40H' + readFileSync(__dirname + '/frame' + (i % 2) + '.six', 'latin1') + '\\u001b8'",
  '    process.stdout.write(out)',
  '    await new Promise((resolve) => setTimeout(resolve, Number(delay) * 1000))',
  '  }',
  "  process.stdout.write(label + '-DONE\\r\\n')",
  '})()',
  ''
].join('\n')
