// MODULE: doctor.d.mts - Local doctor execution, safe persistence and view types
import type { DoctorView } from '../../../shared/protocol/src/doctor'
import type { SavedDoctorState } from './doctor-state.mjs'
import type { doctorVersions, qualifyDoctor, runAppDoctor, runBmnDoctor, runLeftoversDoctor } from './doctor-adapters.mjs'
export declare function doctorPaths(environment?: NodeJS.ProcessEnv): { directory: string; state: string; lock: string }
export declare function loadDoctorState(environment?: NodeJS.ProcessEnv): SavedDoctorState
export declare function saveDoctorState(state: SavedDoctorState, environment?: NodeJS.ProcessEnv): void
export declare function readDoctorView(options?: { environment?: NodeJS.ProcessEnv; now?: number; appVersions?: Partial<SavedDoctorState['appVersions']> | null }): Promise<DoctorView>
export declare function runDoctor(options?: { environment?: NodeJS.ProcessEnv; startupId?: string | null }): Promise<DoctorView>
export declare function doctorWorker(options?: {
  environment?: NodeJS.ProcessEnv; startupId?: string | null; observedId?: string | null; now?: () => number
  versions?: typeof doctorVersions; qualify?: typeof qualifyDoctor; appCheck?: typeof runAppDoctor; bmnCheck?: typeof runBmnDoctor
  leftoversCheck?: typeof runLeftoversDoctor
  save?: typeof saveDoctorState
}): Promise<void>
export declare function runDoctorCommand(args: string[], options?: { environment?: NodeJS.ProcessEnv; out?: (text: string) => void }): Promise<number>
