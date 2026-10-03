// Distribution builds must not inherit the CI worker's CPU instruction set.
export function engineBuildConfig({ platform = process.platform, arch = process.arch, portable = false } = {}) {
  const suffix = platform === 'win32' ? '.exe' : ''
  const cpuOptions = portable ? [
    '-DGGML_NATIVE=OFF',
    ...['SSE42', 'AVX', 'AVX2', 'AVX_VNNI', 'AVX512', 'AVX512_VBMI', 'AVX512_VNNI', 'AVX512_BF16',
      'FMA', 'F16C', 'BMI2', 'AMX_TILE', 'AMX_INT8', 'AMX_BF16'].map(name => `-DGGML_${name}=OFF`),
    ...(arch === 'arm64' ? ['-DGGML_CPU_ARM_ARCH=armv8-a'] : [])
  ] : ['-DGGML_NATIVE=ON']
  return {
    suffix, baseline: portable ? `${arch}-portable` : `${arch}-local-native`,
    cmakeOptions: [...cpuOptions, ...(platform === 'win32' ? [
      '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DGGML_OPENMP=OFF'
    ] : [])]
  }
}
