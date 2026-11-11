// MODULE: agents-small-work.mjs - Epic120.2: a Small work reference names one stored reviewer configuration
export const EPIC_REVIEW = 'epic-reviewer'
export const SMALL_EPIC_REVIEW = 'small-epic-reviewer'
export function isSmallWorkReference(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.role === SMALL_EPIC_REVIEW
}
export function linkedSmallWork(data, role) {
  return role?.id === EPIC_REVIEW && isSmallWorkReference(role.small_work)
    ? data.roles.find(entry => entry.id === SMALL_EPIC_REVIEW) ?? null : null
}
export function sharedSmallWork(data) {
  const outer = data.roles.find(entry => entry.id === EPIC_REVIEW)
  const target = linkedSmallWork(data, outer)
  return target ? { outer, target } : null
}
export function smallWorkCandidates(data, role) {
  const target = linkedSmallWork(data, role)
  return target ? target.candidates : typeof role.small_work === 'string' ? [role.small_work] : []
}
