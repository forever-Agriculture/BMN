export interface NativeTimings {
  mark(stage: string): void
  measure<T>(stage: string, operation: () => T): T
  report(): void
}
export function nativeTimings(name: string, originalBudgetMs?: number): NativeTimings
