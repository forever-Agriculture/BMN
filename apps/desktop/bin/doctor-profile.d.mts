// MODULE: doctor-profile.d.mts - Selected-profile descriptor and private identity types
export interface SelectedDoctorProfile {
  paths: Record<string, string>; invalid: boolean; unavailable: boolean; inline: boolean; home: string; claude: string; codex: string
  opencode: string; claudeJson: string; bmn: string; opencodeFiles: string[]
}
export declare function selectedProfile(environment?: NodeJS.ProcessEnv): SelectedDoctorProfile
export declare function profileFingerprint(profile: SelectedDoctorProfile, key: string): string
