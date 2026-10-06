// Worker copies of process.env are case-sensitive, including on Windows.
// Preserve Windows variable-name semantics without modifying the caller's environment.
/** @param {Readonly<Record<string, string | undefined>>} environment @param {string} name */
export function windowsEnvironmentValue(environment, name) {
  let value
  for (const [key, candidate] of Object.entries(environment)) {
    if (key.toLowerCase() !== name.toLowerCase() || candidate === undefined) continue
    if (value !== undefined && candidate !== value) throw new Error(`Conflicting Windows environment values for ${name}`)
    value = candidate
  }
  return value
}
