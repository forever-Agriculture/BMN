// MODULE: bmn-opencode-plugin.d.mts - Types for the shipped hook producer's app names, plugin text and the plugin texts shipped before it
export const HOOK_AGENTS: Readonly<Record<'claude' | 'codex' | 'opencode', string>>
export const OPENCODE_PLUGIN: string
export const EARLIER_OPENCODE_PLUGINS: Readonly<Record<string, { kind: 'terminal' | 'server'; commit: string; file: string }>>
