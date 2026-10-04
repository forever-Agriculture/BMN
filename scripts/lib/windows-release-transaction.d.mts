export interface ReleaseDescriptor {
  commit: string
  payloadSha256: string
  schemaVersion: number
}
export interface WindowsInstallation {
  format: 1
  current: ReleaseDescriptor
  previous: ReleaseDescriptor | null
  snapshot: { id: string; sha256: string } | null
}
export function releaseDescriptor(value: unknown): ReleaseDescriptor
export function releaseDirectory(root: string, release: ReleaseDescriptor): string
export function readWindowsInstallation(root: string): WindowsInstallation | null
export function activateWindowsRelease(options: {
  root: string
  candidate: ReleaseDescriptor
  withLease: (operation: () => Promise<WindowsInstallation | null>) => Promise<WindowsInstallation | null>
  waitForExit: () => Promise<void>
  stage: (target: string) => Promise<void>
  validate: (target: string, release: ReleaseDescriptor) => Promise<void>
  smoke: (target: string) => Promise<void>
  inspectData: (release: ReleaseDescriptor) => Promise<{
    schemaVersion: number | null
    snapshot?: { id: string; sha256: string; verified: boolean }
  }>
  refreshMetadata: (target: string, release: ReleaseDescriptor) => Promise<void>
  checkpoint?: (phase: string) => Promise<void>
  beforeActivate?: () => Promise<void>
}): Promise<WindowsInstallation | null>
