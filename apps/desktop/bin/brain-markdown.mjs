// MODULE: brain-markdown.mjs - One section reader for online and closed-BMN commands
/** Return a heading and its children verbatim, ignoring fenced code examples. */
export function brainSection(markdown, name) {
  const lines = markdown.split('\n')
  let start = -1, end = lines.length, level = 0, fence = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      continue
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) { fence = marker[1]; continue }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line)
    if (!heading) continue
    const title = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
    if (start < 0 && title === name) { start = index; level = heading[1].length }
    else if (start >= 0 && heading[1].length <= level) { end = index; break }
  }
  return start < 0 ? null : lines.slice(start, end).join('\n')
}
