// MODULE: progress-strip.tsx - the one progress strip, shown in a pane and in the session inspector
import type { ProgressPresentation } from './session-presentation'

/**
 * What a reporter said about this session, in its own words. The state word is a button because it
 * is the way into the detail: the strip itself carries no more than a line, and `detail` was
 * previously reachable only as a mouse tooltip. The evidence word is always present, for every
 * state, so "Reported verified" is never read without knowing whether anything backs it.
 *
 * One component for every site — the pane strip and the inspector/overview summaries — so the
 * wording cannot drift between them. `.progress-strip` and the order of its text are load-bearing:
 * the renderer self-test reads them.
 */
export function ProgressStrip(props: {
  progress: ProgressPresentation | null
  onOpen(anchor: HTMLElement): void
}): React.JSX.Element | null {
  const progress = props.progress
  if (!progress) return null
  return (
    <div className="progress-strip" role="group" aria-label="Progress">
      <span className="label">{progress.label}</span>
      <button
        type="button"
        className={`state ${progress.state} progress-open`}
        aria-haspopup="dialog"
        title={progress.detail ?? undefined}
        onClick={(event) => props.onOpen(event.currentTarget)}
      >
        {progress.word}
        <span className="evidence">{progress.evidenceWord}</span>
      </button>
      {progress.stale ? <span className="stale">stale</span> : null}
      <span className="source">{progress.source} · {progress.age}</span>
    </div>
  )
}
