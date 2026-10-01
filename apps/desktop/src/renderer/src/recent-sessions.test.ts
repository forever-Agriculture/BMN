import { expect, it } from 'vitest'
import { rememberRecentSession } from './recent-sessions'

it('keeps unique focus commits newest first and discards only the oldest beyond twenty', () => {
  let ids: string[] = []
  for (let index = 0; index < 25; index += 1) ids = rememberRecentSession(ids, String(index))
  expect(ids).toHaveLength(20); expect(ids[0]).toBe('24'); expect(ids.at(-1)).toBe('5')
  ids = rememberRecentSession(ids, '10')
  expect(ids[0]).toBe('10'); expect(ids.filter(id => id === '10')).toHaveLength(1)
  expect(ids.at(-1)).toBe('5')
})
