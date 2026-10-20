// MODULE: select-fields.tsx - The settings and launcher choices, preserving each native select's saved values
import { VOICE_LANGUAGES, type BackgroundChoice, type TerminalGraphicsChoice, type VoiceLanguage } from '@bmn/protocol'
import { BACKGROUND_CHOICE_OPTIONS } from './launch-template'
import { SelectMenu } from './select-menu'

export function BackgroundChoiceSelect(props: { value: BackgroundChoice | null; disabled?: boolean; onChange(value: BackgroundChoice | null): void }): React.JSX.Element {
  return <SelectMenu aria-label="When windows close" value={props.value ?? ''} options={BACKGROUND_CHOICE_OPTIONS}
    disabled={props.disabled} onChange={(value) => props.onChange(value === 'hide' || value === 'stop' ? value : null)} />
}

export function TerminalGraphicsSelect(props: { value: TerminalGraphicsChoice; disabled?: boolean; onChange(value: TerminalGraphicsChoice): void }): React.JSX.Element {
  return <SelectMenu aria-label="Terminal images (Sixel)" value={props.value ?? ''} disabled={props.disabled}
    options={[{ value: '', label: 'Default (on)' }, { value: 'sixel', label: 'On' }, { value: 'standard', label: 'Off' }]}
    onChange={(value) => props.onChange(value === 'sixel' || value === 'standard' ? value : null)} />
}

export function NotifyOnSelect(props: { value: 'attention' | 'attention-and-exit'; disabled: boolean; onChange(value: 'attention' | 'attention-and-exit'): void }): React.JSX.Element {
  return <SelectMenu id="preferences-telegram-notify-on" aria-label="Notify on" value={props.value} disabled={props.disabled}
    options={[{ value: 'attention', label: 'Needs-you requests' }, { value: 'attention-and-exit', label: 'Needs-you requests and session exits' }]}
    onChange={props.onChange} />
}

export function VoiceLanguageSelect(props: { value: VoiceLanguage; disabled: boolean; onChange(value: VoiceLanguage): void }): React.JSX.Element {
  return <SelectMenu id="preferences-voice-language" aria-label="Language" value={props.value} disabled={props.disabled}
    options={VOICE_LANGUAGES.map((language) => ({ value: language.code, label: language.label }))} onChange={props.onChange} />
}
