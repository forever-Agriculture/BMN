/**
 * Closed-shape rule shared by every protocol record, params, layout and terminal message validator:
 * all required keys are present and no key outside required + optional exists. Unknown fields are
 * rejected by construction instead of being point-checked one legacy name at a time.
 * Internal to the protocol package; not re-exported from the package index.
 */
export function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
}
