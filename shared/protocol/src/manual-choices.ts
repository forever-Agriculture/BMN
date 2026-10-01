import { hasExactKeys } from './closed-shape'
import { hasControlOrFormatCharacter } from './file-reference'
import type { AttentionPromptOption, AttentionPromptQuestion } from './attention-prompt'

export interface ManualChoices {
  options: AttentionPromptOption[]
  allowOther: true
}

export function parseManualChoices(value: unknown, stored = false): ManualChoices | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !hasExactKeys(value, stored ? ['options', 'allowOther'] : ['options'])) return null
  const record = value as Record<string, unknown>
  if (stored && record.allowOther !== true) return null
  if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 8) return null
  const options: AttentionPromptOption[] = []
  for (const item of record.options) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !hasExactKeys(item, ['label', 'description'])) return null
    const { label, description } = item as Record<string, unknown>
    const safe = (text: string): boolean => !hasControlOrFormatCharacter(text)
    if (typeof label !== 'string' || !label.trim() || label.length > 200 || !safe(label) ||
      options.some(option => option.label === label) ||
      (description !== null && (typeof description !== 'string' || description.length > 500 || !safe(description)))) return null
    options.push({ label, description: description as string | null })
  }
  return { options, allowOther: true }
}

export function readStoredManualChoices(value: string | null): ManualChoices | null {
  try { return value === null ? null : parseManualChoices(JSON.parse(value), true) } catch { return null }
}

/** Presentation only; manual data never acquires a native harness or dialog epoch. */
export function manualChoiceQuestion(title: string, choices: ManualChoices): AttentionPromptQuestion {
  return { id: null, header: null, text: title, multiSelect: false, options: choices.options, custom: true }
}
