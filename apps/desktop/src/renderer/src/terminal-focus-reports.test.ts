// MODULE: terminal-focus-reports.test.ts - focus reports tell the agent the owner is away when idle
import { describe, expect, it } from 'vitest'
import { FOCUS_IN, FOCUS_OUT, createFocusReports } from './terminal-focus-reports'

function harness(reportsEnabled = true): { reports: ReturnType<typeof createFocusReports>; sent: string[]; mode: { on: boolean } } {
  const sent: string[] = []
  const mode = { on: reportsEnabled }
  const reports = createFocusReports({ reportsEnabled: () => mode.on, send: (report) => sent.push(report) })
  return { reports, sent, mode }
}

describe('terminal focus reports', () => {
  it('reports focus out when the owner goes away while the pane keeps focus', () => {
    const { reports, sent } = harness()
    reports.paneFocus(true)
    reports.presence({ away: true })
    reports.presence({ away: false })
    expect(sent).toEqual([FOCUS_IN, FOCUS_OUT, FOCUS_IN])
  })

  it('swallows the reports xterm writes itself so only presence-aware reports reach the process', () => {
    const { reports } = harness()
    expect(reports.isFocusReport(FOCUS_IN)).toBe(true)
    expect(reports.isFocusReport(FOCUS_OUT)).toBe(true)
    expect(reports.isFocusReport('\x1b[A')).toBe(false)
    expect(reports.isFocusReport(`${FOCUS_IN}x`)).toBe(false)
  })

  it('does not claim focus when the pane gains focus while the owner is away', () => {
    const { reports, sent } = harness()
    reports.presence({ away: true })
    reports.paneFocus(true)
    expect(sent).toEqual([])
    reports.presence({ away: false })
    expect(sent).toEqual([FOCUS_IN])
  })

  it('sends nothing for presence changes of an unfocused pane', () => {
    const { reports, sent } = harness()
    reports.presence({ away: true })
    reports.presence({ away: false })
    reports.paneFocus(false)
    expect(sent).toEqual([])
  })

  it('stays silent while the process has not enabled focus reporting', () => {
    const { reports, sent, mode } = harness(false)
    reports.paneFocus(true)
    reports.presence({ away: true })
    expect(sent).toEqual([])
    mode.on = true
    reports.presence({ away: false })
    expect(sent).toEqual([FOCUS_IN])
  })

  it('reports focus out when a focused pane is torn down so the process never believes the owner stayed', () => {
    const { reports, sent } = harness()
    reports.paneFocus(true)
    reports.dispose()
    reports.presence({ away: true })
    expect(sent).toEqual([FOCUS_IN, FOCUS_OUT])
  })
})
