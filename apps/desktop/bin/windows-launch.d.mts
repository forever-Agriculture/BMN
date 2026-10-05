type Environment = Readonly<Record<string, string | undefined>>

export function windowsEnvironmentValue(environment: Environment, name: string): string | undefined
export function windowsEnvironment(...layers: readonly Environment[]): Record<string, string>
export function findWindowsExecutable(
  command: string,
  cwd: string,
  environment: Environment,
  exists?: (path: string) => boolean
): string | null
export function npmNodeShimTarget(contents: string): string | null
export function prepareWindowsExecutableLaunch(
  executable: string,
  argv: readonly string[],
  cwd: string,
  environment: Environment
): { executable: string; argv: string[] }
