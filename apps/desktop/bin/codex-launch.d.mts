type Environment = Readonly<Record<string, string | undefined>>

export function codexWithoutSharedDaemon(argv: readonly string[]): readonly string[]
export function pathWithoutFolders(path: string, folders: readonly string[], compare?: (folder: string) => string): string
export function realCodexLaunch(
  argv: readonly string[],
  environment: Environment,
  cwd: string,
  scriptFolder: string
): { executable: string; argv: string[]; environment: Record<string, string> }
