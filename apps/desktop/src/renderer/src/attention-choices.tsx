// MODULE: attention-choices.tsx - answer an open choice card in the desktop window
import { useState } from 'react'
import {
  stripFormatCharacters,
  type AnswerOutcome,
  type AttentionPromptQuestion,
  type QuestionChoice
} from '@bmn/protocol'

function QuestionOptions({ question, context, immediate, disabled, onChange }: {
  question: AttentionPromptQuestion
  context?: string | undefined
  immediate: boolean
  disabled: boolean
  onChange(choice: QuestionChoice | null): void
}): React.JSX.Element {
  const [selected, setSelected] = useState<number[]>([])
  const [other, setOther] = useState(false)
  const [typed, setTyped] = useState('')
  const change = (options: number[], useOther: boolean, value: string): void => {
    setSelected(options)
    setOther(useOther)
    setTyped(value)
    const hasText = useOther && !!value.trim()
    if (question.multiSelect) {
      onChange(options.length || hasText ? { set: options, ...(hasText ? { typed: value } : {}) } : null)
    } else {
      onChange(useOther ? hasText ? { typed: value } : null : options[0] ?? null)
    }
  }
  return <section aria-label={stripFormatCharacters(question.text)}>
    <h4>{stripFormatCharacters(question.text)}</h4>
    {context ? <pre>{stripFormatCharacters(context)}</pre> : null}
    <ul className="attention-choice-options">
      {question.options.map((option, index) => <li key={index}>
        <button type="button" disabled={disabled} aria-pressed={immediate ? undefined : selected.includes(index)} onClick={() => {
          if (immediate) { onChange(index); return }
          if (!question.multiSelect) { change([index], false, typed); return }
          const next = selected.includes(index) ? selected.filter(value => value !== index) : [...selected, index].sort((a, b) => a - b)
          change(next, other, typed)
        }}>
          <span>{stripFormatCharacters(option.label)}</span>
          {option.description ? <span className="attention-prompt-description">{stripFormatCharacters(option.description)}</span> : null}
        </button>
      </li>)}
      <li>
        <button type="button" disabled={disabled} aria-expanded={other} onClick={() =>
          change(question.multiSelect ? selected : [], !other, typed)}>Other…</button>
        {other ? <input aria-label={`Other answer for ${stripFormatCharacters(question.text)}`} autoFocus maxLength={4000}
          disabled={disabled} value={typed} onChange={event => change(selected, true, event.target.value)} /> : null}
      </li>
    </ul>
  </section>
}

export function AttentionChoices({ questions, context, onAnswer }: {
  questions: AttentionPromptQuestion[]
  context?: string | undefined
  onAnswer(choices: QuestionChoice[]): Promise<AnswerOutcome>
}): React.JSX.Element {
  const [choices, setChoices] = useState<Record<number, QuestionChoice | null>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  const immediate = questions.length === 1 && !questions[0]?.multiSelect
  const ready = questions.every((_, index) => choices[index] != null)
  const answer = async (values: QuestionChoice[]): Promise<void> => {
    if (busy || sent) return
    setBusy(true)
    setMessage('')
    try {
      const outcome = await onAnswer(values)
      setSent(outcome.state !== 'refused')
      if (outcome.state === 'refused') {
        setMessage(outcome.reason === 'claimed' ? 'An answer is already recorded or in progress.' :
          'Nothing sent. Check the current question in the terminal.')
      } else if (outcome.state === 'sent-unconfirmed' || outcome.state === 'partial') {
        setMessage('Check the terminal to see what was received.')
      } else {
        setMessage(outcome.state === 'submitted' ? 'Answer submitted.' : 'Answer confirmed.')
      }
    } catch {
      setSent(true)
      setMessage('Could not confirm the answer. Check the terminal before retrying.')
    } finally {
      setBusy(false)
    }
  }
  return <form className="attention-questions" onSubmit={event => {
    event.preventDefault()
    if (ready) void answer(questions.map((_, index) => choices[index]!))
  }}>
    {questions.map((question, index) => <QuestionOptions key={index} question={question} context={index === 0 ? context : undefined}
      immediate={immediate} disabled={busy || sent} onChange={choice => {
        if (immediate && typeof choice === 'number') { void answer([choice]); return }
        setChoices(current => ({ ...current, [index]: choice }))
      }} />)}
    {!immediate || choices[0] != null ? <div className="actions">
      <button type="submit" className="primary" disabled={!ready || busy || sent}>Send answer</button>
    </div> : null}
    {message ? <p className="seen" role="status">{message}</p> : null}
  </form>
}
