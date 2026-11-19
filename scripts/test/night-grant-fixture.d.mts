// MODULE: night-grant-fixture.d.mts - the disposable plan fixture used by the Electron self-test
interface FixtureAllowanceRead {
  current: { fields: { limits: Record<string, { limit: number; ceiling: number; per: string; unit: string }> } }
  changes: Array<{ source: string }>
}

export function seedNightPlan(project: string, cliExecutable: string, environment: NodeJS.ProcessEnv, cliArgs?: string[]): {
  written(name: string, text: string): string
  git(where: string, ...argv: string[]): string
  plan(action: 'allowances', epic: string): FixtureAllowanceRead
  plan(...argv: string[]): unknown
}
