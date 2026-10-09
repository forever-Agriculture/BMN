// MODULE: text-diff.mjs - the unified diff bmn shows before it writes an owner file (hooks install, Epic 60 rules and roster)

/** Longest common subsequence of two line arrays, as the indices that match. */
function commonLines(before, after) {
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row][column] = before[row] === after[column]
        ? table[row + 1][column + 1] + 1
        : Math.max(table[row + 1][column], table[row][column + 1])
    }
  }
  const pairs = []
  let row = 0
  let column = 0
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      pairs.push([row, column])
      row += 1
      column += 1
    } else if (table[row + 1][column] >= table[row][column + 1]) row += 1
    else column += 1
  }
  return pairs
}

/** A unified diff with three lines of context, so the owner sees exactly what install added. */
export function unifiedDiff(beforeText, afterText, path) {
  const before = beforeText === '' ? [] : beforeText.replace(/\n$/, '').split('\n')
  const after = afterText === '' ? [] : afterText.replace(/\n$/, '').split('\n')
  const matched = commonLines(before, after)
  const rows = []
  let row = 0
  let column = 0
  for (const [beforeIndex, afterIndex] of [...matched, [before.length, after.length]]) {
    while (row < beforeIndex) rows.push({ sign: '-', text: before[row++] })
    while (column < afterIndex) rows.push({ sign: '+', text: after[column++] })
    if (beforeIndex < before.length) {
      rows.push({ sign: ' ', text: before[beforeIndex] })
      row += 1
      column += 1
    }
  }
  const context = 3
  const keep = rows.map((entry, index) => entry.sign !== ' ' ||
    rows.some((other, position) => other.sign !== ' ' && Math.abs(position - index) <= context))
  const lines = [`--- ${path}`, `+++ ${path}`]
  let index = 0
  let beforeLine = 1
  let afterLine = 1
  while (index < rows.length) {
    if (!keep[index]) {
      if (rows[index].sign !== '+') beforeLine += 1
      if (rows[index].sign !== '-') afterLine += 1
      index += 1
      continue
    }
    const start = index
    const startBefore = beforeLine
    const startAfter = afterLine
    let beforeCount = 0
    let afterCount = 0
    while (index < rows.length && keep[index]) {
      if (rows[index].sign !== '+') { beforeCount += 1; beforeLine += 1 }
      if (rows[index].sign !== '-') { afterCount += 1; afterLine += 1 }
      index += 1
    }
    lines.push(`@@ -${beforeCount === 0 ? startBefore - 1 : startBefore},${beforeCount} +${afterCount === 0 ? startAfter - 1 : startAfter},${afterCount} @@`)
    for (const entry of rows.slice(start, index)) lines.push(`${entry.sign}${entry.text}`)
  }
  return lines.length === 2 ? '' : lines.join('\n')
}
