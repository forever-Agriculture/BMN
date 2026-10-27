// MODULE: rules-help.tsx - optional explanations for Skills and Health, closed until requested

export function SkillsDistributionHelp(): React.JSX.Element {
  return (
    <details className="advanced">
      <summary>How skills reach apps</summary>
      <p className="preferences-help">A skill reaches every app unless you keep it to some; an app held to public work gets only the Public&nbsp;skills.</p>
      <p className="preferences-help">A change takes effect on approval; BMN then installs it in each app, and at every start installs what an app lacks.</p>
    </details>
  )
}

export function SkillsCheckHelp(): React.JSX.Element {
  return (
    <details className="advanced">
      <summary>How BMN checks</summary>
      <p className="preferences-help">Skills inside a project folder, and sessions already running, are outside what BMN installs.</p>
    </details>
  )
}

export function LoadingCheckHelp(): React.JSX.Element {
  return (
    <details className="advanced">
      <summary>How BMN checks</summary>
      <p className="preferences-help">A loading test starts the app once with the rules in one prompt; BMN runs it by itself after updates and rules changes.</p>
    </details>
  )
}

export function RoutingCheckHelp(): React.JSX.Element {
  return (
    <details className="advanced">
      <summary>How BMN checks</summary>
      <p className="preferences-help">BMN works out where an app sends data the same way on each version, and notes the version with every check.</p>
    </details>
  )
}
