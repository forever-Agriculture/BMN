// A hidden, explicitly partial self-test prefix; ordinary runs never select it.
export type ScrolledDiagnosticArm = 'with-fixture' | 'without-fixture'

export function scrolledDiagnosticArm(argv: readonly string[]): ScrolledDiagnosticArm | null {
  if (!argv.includes('--self-test')) return null
  const arms = argv.filter(value => value.startsWith('--scrolled-diagnostic='))
  if (arms.length === 0) return null
  if (arms.length !== 1) throw new Error('Select exactly one scrolled diagnostic arm')
  const arm = arms[0]!.slice('--scrolled-diagnostic='.length)
  if (arm !== 'with-fixture' && arm !== 'without-fixture') throw new Error('Unknown scrolled diagnostic arm')
  return arm
}
