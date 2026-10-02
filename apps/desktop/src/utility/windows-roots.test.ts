import { describe, expect, it } from 'vitest'
import { resolveApplicationRoots } from './roots'

const fallbacks = { homeDirectory: 'C:\\Users\\Example', runtimeFallback: 'C:\\Temp' }
describe('Windows application roots', () => {
  it('keeps all durable and runtime state under LocalAppData, independent of XDG', () => {
    expect(resolveApplicationRoots({ LOCALAPPDATA: 'D:\\Local Data', XDG_DATA_HOME: '/unix/data' }, fallbacks, 'win32')).toEqual({
      config: 'D:\\Local Data\\BMN\\config', data: 'D:\\Local Data\\BMN\\data',
      state: 'D:\\Local Data\\BMN\\state', runtime: 'D:\\Local Data\\BMN\\runtime'
    })
  })
  it('falls back to the account local profile', () => {
    expect(resolveApplicationRoots({}, fallbacks, 'win32').data).toBe('C:\\Users\\Example\\AppData\\Local\\BMN\\data')
  })
  it('retains exact overrides with BMN taking precedence over legacy aliases', () => {
    expect(resolveApplicationRoots({ BMN_DATA_HOME: 'E:\\My Data\\数据', AITERM_DATA_HOME: 'E:\\Legacy', AITERM_STATE_HOME: 'E:\\State' }, fallbacks, 'win32')).toMatchObject({
      data: 'E:\\My Data\\数据', state: 'E:\\State'
    })
  })
})
