// MODULE: defaults-admission.d.mts - Types for the shared defaults admission boundary
export declare function assertDefaultsAdmission(): void
export declare function defaultsAdmissionToken(): symbol
export declare function withDefaultsAdmission<T>(work: (guard: typeof assertDefaultsAdmission) => T, options?: { directory?: string; flockCommand?: string }): T
