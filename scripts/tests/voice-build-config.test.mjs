import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { engineBuildConfig } from '../voice/engine-build-config.mjs'

describe('portable voice distribution', () => {
  it.each(['linux', 'win32'])('never enables host or post-SSE2 x64 instructions on %s', platform => {
    const config = engineBuildConfig({ platform, arch: 'x64', portable: true })
    expect(config.cmakeOptions).toContain('-DGGML_NATIVE=OFF')
    for (const instruction of ['SSE42', 'AVX', 'AVX2', 'AVX512', 'FMA', 'F16C', 'BMI2', 'AVX_VNNI', 'AMX_TILE']) {
      expect(config.cmakeOptions).toContain(`-DGGML_${instruction}=OFF`)
    }
    expect(config.cmakeOptions).not.toContain('-DGGML_NATIVE=ON')
  })

  it('keeps native tuning separate from the packaged build and closes Windows runtime dependencies', () => {
    expect(engineBuildConfig({ portable: false }).baseline).not.toBe(engineBuildConfig({ portable: true }).baseline)
    const windows = engineBuildConfig({ platform: 'win32', arch: 'x64', portable: true })
    expect(windows.suffix).toBe('.exe')
    expect(windows.cmakeOptions).toContain('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded')
    expect(windows.cmakeOptions).toContain('-DGGML_OPENMP=OFF')
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.scripts.package).toMatch(/^node scripts\/voice\/build-whisper\.mjs --portable &&/)
  })
})
