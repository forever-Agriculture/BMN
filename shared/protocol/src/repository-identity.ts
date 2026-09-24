/** Git state read at one moment from the directory BMN selected for a session or launch. */
export type RepositoryIdentity =
  | {
      state: 'repository'
      directory: string
      observedAt: string
      root: string
      head: { state: 'branch'; name: string } | { state: 'detached' } | { state: 'unborn'; name: string }
      linkedWorktree: boolean
    }
  | { state: 'not-repository'; directory: string; observedAt: string }
  | { state: 'unavailable'; directory: string; observedAt: string; reason: string }

export interface RepositoryInspectParams {
  directory: string
}

export function isRepositoryInspectParams(value: unknown): value is RepositoryInspectParams {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof (value as RepositoryInspectParams).directory === 'string' &&
    (value as RepositoryInspectParams).directory.length > 0 &&
    (value as RepositoryInspectParams).directory.length <= 4096
}
