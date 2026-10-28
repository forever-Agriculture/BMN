// MODULE: health-order.ts - The order of Health's section rows: those that need the owner first, steady while the pointer is over the page (Stories 75.10, 96.6)
import { createContext, useCallback, useRef, type RefObject } from 'react'

/** A Health section's rows with those that need the owner first, the rest in their order. */
export function needsFirst<Row>(rows: readonly Row[], needs: (row: Row) => boolean): Row[] {
  return [...rows].sort((a, b) => Number(needs(b)) - Number(needs(a)))
}

export type SteadyOrder = <Row extends { harness: string }>(section: string, rows: readonly Row[], needs: (row: Row) => boolean) => Row[]
export const SteadyOrderContext = createContext<SteadyOrder>((_section, rows, needs) => needsFirst(rows, needs))

/**
 * Story 96.6 AC2: while the pointer is over Health, a refresh keeps each section's rows where they were (a row new to it
 * goes last), so nothing moves under it; with the pointer elsewhere the rows that need the owner come first.
 */
export function useSteadyOrder(top: RefObject<HTMLElement | null>): SteadyOrder {
  const orders = useRef(new Map<string, string[]>())
  return useCallback(<Row extends { harness: string },>(section: string, rows: readonly Row[], needs: (row: Row) => boolean): Row[] => {
    const before = orders.current.get(section)
    const hovered = top.current?.closest('.preferences-main')?.matches(':hover') ?? false
    const rank = (row: Row): number => { const at = before?.indexOf(row.harness) ?? -1; return at < 0 ? Number.MAX_SAFE_INTEGER : at }
    const sorted = hovered && before !== undefined ? [...rows].sort((a, b) => rank(a) - rank(b)) : needsFirst(rows, needs)
    orders.current.set(section, sorted.map((row) => row.harness))
    return sorted
  }, [top])
}
