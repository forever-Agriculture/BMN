// MODULE: native-test-guard.mjs - Epic 125 D2: imported first by every native driver, so his real home and profiles are refused before any other module of the driver is evaluated
import { assertNativeTestEnvironment } from './native-test-home.mjs'

/** The tests' own folders; reaching this line means the driver was started with them and nothing else. */
export const nativeTest = assertNativeTestEnvironment(process.env)
