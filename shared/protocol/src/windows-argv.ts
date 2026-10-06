// Windows argument-field grammar. This is argv serialization, never shell code.
// Double quotes group whitespace; backslashes are literal except immediately
// before double quotes, where the Windows CRT even/odd rule applies.
export function quoteWindowsArgv(argv: readonly string[]): string {
  return argv.map((value) => {
    if (value.includes('\0')) throw new Error('Arguments cannot contain NUL')
    if (value !== '' && !/[\s"]/.test(value)) return value
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
  }).join(' ')
}

export function splitWindowsArgv(text: string): string[] {
  if (text.includes('\0')) throw new Error('Arguments cannot contain NUL')
  const result: string[] = []
  let index = 0
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '') && index < text.length) index++
    if (index === text.length) break
    let value = ''
    let quoted = false
    while (index < text.length && (quoted || !/\s/.test(text[index]!))) {
      let slashes = 0
      while (text[index] === '\\') { slashes++; index++ }
      if (text[index] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) { value += '"'; index++ }
        else if (quoted && text[index + 1] === '"') { value += '"'; index += 2 }
        else { quoted = !quoted; index++ }
      } else {
        value += '\\'.repeat(slashes)
        if (index < text.length && (quoted || !/\s/.test(text[index]!))) value += text[index++]
      }
    }
    result.push(value)
  }
  return result
}
