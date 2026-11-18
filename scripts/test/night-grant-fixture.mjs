// MODULE: night-grant-fixture.mjs - make a throwaway recorded plan with an exhausted limit for the grant drivers
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function seedNightPlan(project, cliPath, environment, nodePath = process.execPath) {
  const written = (name, text) => {
    const target = join(project, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    return target
  }
  const git = (where, ...argv) => execFileSync('git', ['-C', where, ...argv], { env: environment, encoding: 'utf8' }).trim()
  mkdirSync(project, { recursive: true, mode: 0o700 })
  git(project, 'init', '-qb', 'main')
  for (const name of ['.', 'plan']) {
    const repo = join(project, name)
    if (name === 'plan') {
      mkdirSync(repo)
      git(repo, 'init', '-qb', 'main')
    }
    git(repo, 'config', 'user.name', 'Synthetic Fixture')
    git(repo, 'config', 'user.email', 'sample@example.invalid')
  }
  written('.gitignore', '/plan/\n/.dev-auto/\n')
  git(project, 'add', '.gitignore')
  git(project, 'commit', '-qm', 'chore: fixture checkout')
  written('plan/status.yaml', 'format: bmn-plan\nschema_version: 1\nqueue: []\ndevelopment_status:\n  epic-7: backlog\n  7-1-sample: backlog\n')
  written('plan/epics/007-sample.md', '# Epic 7: Sample\n\n## Run needs\n\nSee plan/allowances/007.yaml.\n\n## Decisions\n\nSynthetic fixture.\n')
  written('plan/allowances/007.yaml', 'schema: 1\nepic: 7\nlimits:\n  rechecks: {limit: 4, ceiling: 4, per: boundary}\n')
  git(join(project, 'plan'), 'add', '-A')
  git(join(project, 'plan'), 'commit', '-qm', 'docs: fixture plan')
  const plan = (...argv) => JSON.parse(execFileSync(nodePath, [cliPath, 'plan', ...argv, '--json'], { cwd: project, env: environment, encoding: 'utf8' }))
  const showing = plan('status', '--epic', '7')
  plan('go', '7', '--expect', showing.rows[0].token, '--approved', `sha256:${showing.approval_texts[0].sha256}`,
    '--source', "synthetic owner 2026-11-18T20:00Z: 'Go'")
  written('.dev-auto/handoff.md', '- Project / selected epics: Epic 7\n- Run id: fixture-epic-7\n')
  const ledger = join(environment.XDG_STATE_HOME, 'dev-auto/budgets')
  mkdirSync(ledger, { recursive: true })
  writeFileSync(join(ledger, '0123456789abcdef-epic-7.json'), JSON.stringify({
    plan_root: join(project, 'plan'), uses: { one: { answer: 'TAKEN', limit: 'rechecks', boundary: '7.1', amount: 4 } }
  }))
  return { written, git, plan }
}

export function seedNativeNight(project, tested, environment, composer) {
  const { written, git, plan } = seedNightPlan(project, tested.cliPath, environment)
  const executable = (name, body) => chmodSync(written(name, '#!/bin/sh\n' + body), 0o700)
  const run = 'fixture-epic-7'
  const head = git(project, 'rev-parse', 'HEAD')
  // A synthetic repository, served exclusively by the fixture's read-only gh.
  git(project, 'remote', 'add', 'origin', 'https://github.com/example-fixture/night-probe.git')
  git(project, 'update-ref', 'refs/remotes/origin/main', head)
  git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const repo = { owner: { login: 'example-fixture' }, defaultBranchRef: { name: 'main' }, name: 'night-probe' }
  const pulls = [{ number: 7, headRefName: 'main', headRefOid: head, baseRefName: 'release-fixture', isCrossRepository: false }]
  executable('.fixture-bin/gh', `case "$1 $2" in
  'repo view') printf '%s\\n' '${JSON.stringify(repo)}';;
  'pr list') printf '%s\\n' '${JSON.stringify(pulls)}';;
  'pr checks') printf '%s\\n' '[{"state":"SUCCESS","bucket":"pass"}]';;
  *) exit 1;;
esac
`)
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  executable('.fixture-bin/bmn', `exec ${quote(process.execPath)} ${quote(tested.cliPath)} "$@"\n`)
  environment.PATH = `${join(project, '.fixture-bin')}:${environment.PATH}`
  copyFileSync(composer, join(project, 'night_card.py'))
  const secretLooking = 'SYNTHETIC_LOGIN_CHECK_CANARY_131'
  executable('fixture-access', `[ -f signed-in ] || exit 1\nprintf '%s\\n' '${secretLooking}'\n`)
  const access = { name: 'Fixture sign-in', command: 'gh auth login', reason: 'The synthetic Prepared check failed' }
  const prepared = execFileSync('/bin/sh', ['-c', './fixture-access >/dev/null 2>&1; printf "%s" "$?"'], { cwd: project, encoding: 'utf8' })
  if (prepared !== '1') throw Error('The synthetic Prepared check did not start signed out')
  written('fixture-work.txt', `Epic 7. Story 7.1 still has two required review rechecks.
Prepared need: "${access.name}". Check it with ./fixture-night prepared before composing. The login command is ${access.command}. Only the owner can sign in.
If that Prepared check fails, include an entry in access with the need's name, login command, and the reason it is needed. This asks the owner to sign in.
Story 7.1 also needs to deliver its current pull request if policy requires approval. BMN facts have the current head and policy.
For the composer use title and scope, a limits array of {name,boundary,uses,reason}, and an access array of {name,command,reason}. BMN facts supply the PR so leave actions out.
`)
  executable('fixture-night', `set -eu
PATH="$PWD/.fixture-bin:$PATH"
export PATH
case "$1" in
  facts) bmn grant facts --run ${run} --epic 7 --json;;
  work) cat fixture-work.txt;;
  prepared)
    if ./fixture-access >/dev/null 2>&1; then printf 'Prepared check: works\n'
    else printf 'failed\n' >prepared-result; printf 'Prepared check: not signed in\n'; fi
    ;;
  ask)
    if bmn grant ask --run ${run} --nothing --reason "No fixture work" >empty-result 2>&1; then exit 7; fi
    grep -qF 'limit:rechecks:7.1' empty-result
    test "$(cat prepared-result)" = failed
    printf '%s\n' "$2" >remaining.json
    python3 night_card.py --run ${run} --epic 7 --remaining remaining.json --key fixture-night
    ;;
  apply) bmn grant apply --run ${run} --item "$2" --use-id fixture-raise;;
  check)
    if ./fixture-access >/dev/null 2>&1; then bmn grant report --run ${run} --item "$2" --access works --attempt "$3"
    else bmn grant report --run ${run} --item "$2" --access fails --cause not-signed-in --attempt "$3"; fi
    ;;
  *) exit 2;;
esac
`)
  return { run, head, access, plan, markSignedIn: () => written('signed-in', ''),
    leakedOutput: () => ['state.sqlite3', 'state.sqlite3-wal'].some(file => {
      const path = join(environment.BMN_DATA_HOME, file)
      return existsSync(path) && readFileSync(path).includes(secretLooking)
    }), emptyWasRefused: () =>
    existsSync(join(project, 'empty-result')) && readFileSync(join(project, 'empty-result'), 'utf8').includes('limit:rechecks:7.1') }
}
