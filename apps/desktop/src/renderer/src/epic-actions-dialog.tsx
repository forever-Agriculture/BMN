// MODULE: epic-actions-dialog.tsx - the owner's per-action approval and run unbind controls
import { useLayoutEffect, useRef, useState } from 'react'
import type { EpicActionAnswer, EpicActionCard } from '@bmn/protocol'
import { Dialog } from './dialog'
import { Segmented } from './history-preferences'
import './before-you-go.css'

export function EpicActionsDialog(props: {
  cards: EpicActionCard[] | null
  sessionName(id: string): string | null
  onClose(): void
  reload(): Promise<void>
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const restore = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (saving) return
    const control = restore.current
    restore.current = null
    if (control?.isConnected) control.focus()
  }, [saving])
  const save = async (operation: () => Promise<unknown>): Promise<void> => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaving(true)
    setMessage('')
    try { await operation() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'The choice could not be saved.') }
    finally { await props.reload(); setSaving(false) }
  }
  const pending = (card: EpicActionCard) => card.actions.filter(action => !card.answers[action.id]).length
  const title = props.cards?.length === 1 ? `Actions for Epic ${props.cards[0]!.epic}` : 'Epic actions'
  return <Dialog label={title} className="before-you-go-dialog" initialFocus=".epic-action-list" onClose={props.onClose}>
    <section className="before-you-go epic-action-list" role="region" aria-label="Epic actions" tabIndex={-1}
      style={{ overflow: 'auto' }}>
      {props.cards === null ? <p>The action approvals could not be read.</p> : props.cards.length === 0 ? <p>No epic actions to answer.</p> : props.cards.map(card =>
        <article className="attention-item grant-card" key={card.id}>
          {card.actions.length > 0 ? <h3>{props.cards!.length > 1 ? `Epic ${card.epic} · ` : ''}{pending(card)} awaiting an answer</h3>
            : props.cards!.length > 1 ? <h3>Epic {card.epic}</h3> : null}
          <div className="grant-terms">{card.actions.map(action => {
            const label = `action-${card.id}-${action.id}`
            const answer = card.answers[action.id]
            return <div className="grant-term" key={action.id}>
              <div className="grant-term-words">
                <span className="grant-term-label exact" id={label}>{action.words}</span>
                {action.rule ? <span className="grant-term-reason">Deploy rule: {action.rule}</span> : null}
                {action.held ? <span className="grant-term-reason">Held: {action.held}</span> : null}
                {answer ? <span className="grant-term-reason">{answer.choice === 'yes' ? 'Approved' : 'Declined'}</span> : null}
              </div>
              <Segmented<'no' | 'yes' | null> labelledBy={label} fit manualActivation again options={action.held ? ['no'] : ['no', 'yes']}
                value={answer?.choice ?? null} disabled={saving} optionLabel={choice => choice === 'yes' ? 'Yes' : 'No'}
                onChange={choice => {
                  if (choice === null) return
                  const input: EpicActionAnswer = { card: card.id, action: action.id, choice, revision: card.revision }
                  void save(() => window.aiTerminal.answerEpicAction(input))
                }} />
            </div>
          })}</div>
          {card.binding ? <div className="grant-footer">
            <span>Bound to {props.sessionName(card.binding.sessionId) ?? card.binding.sessionId} · go {card.binding.go.slice(0, 12)}</span>
            <button type="button" disabled={saving} onClick={() => void save(async () => {
              const removed = await window.aiTerminal.unbindEpicAction(card.project, card.epic, card.binding!.id)
              setMessage(removed ? 'Run unbound.' : 'The run is already unbound.')
            })}>Unbind</button>
          </div> : null}
        </article>)}
      {message ? <p role="status">{message}</p> : null}
    </section>
  </Dialog>
}
