// MODULE: command-guard.test.ts - Story 83.4: the deny-only guard's list, its three possible answers and what it leaves alone
import { describe, expect, it } from 'vitest'
import { GUARDED_TOOLS, guardAnswer, heldCommand } from '../../bin/command-guard.mjs'

const HELD: Array<[string, string]> = [
  // Force pushes in any form.
  ['git push --force origin main', 'force'],
  ['git push -f origin main', 'force'],
  ['git push -uf origin feature', 'force'],
  ['git push --force-with-lease origin feature', 'force'],
  ['git push --force-with-lease=main:abc123 origin main', 'force'],
  ['git push --force-if-includes origin feature', 'force'],
  ['git push origin +main', 'force'],
  ['git push origin +HEAD:refs/heads/main', 'force'],
  ['cd /tmp/x && git -C repo push --force origin main', 'force'],
  ['git -c credential.helper= push -f', 'force'],
  // Deletion on a remote.
  ['git push --delete origin old', 'deletion'],
  ['git push origin -d old', 'deletion'],
  ['git push origin :old', 'deletion'],
  ['git push origin :refs/tags/v1', 'deletion'],
  ['git push --prune origin refs/heads/*:refs/heads/*', 'deletion'],
  // Tags and mirrors.
  ['git push --mirror backup', 'tags'],
  ['git push --tags', 'tags'],
  ['git push --follow-tags origin main', 'tags'],
  ['git push origin refs/tags/v1.0.0', 'tags'],
  // Repository changes.
  ['gh repo delete owner/name --yes', 'repository'],
  ['gh repo edit --visibility public', 'repository'],
  ['gh repo rename new-name', 'repository'],
  ['gh repo archive owner/name', 'repository'],
  ['gh repo transfer owner/name other', 'repository'],
  // Writes to a repository's own path, rulesets or protection.
  ['gh api -X PATCH repos/owner/name -F archived=true', 'repository, its rulesets'],
  ['gh api --method DELETE repos/owner/name', 'repository, its rulesets'],
  ['gh api -XPUT /repos/owner/name/branches/main/protection --input p.json', 'repository, its rulesets'],
  ['gh api repos/owner/name/rulesets --input rules.json', 'repository, its rulesets'],
  ['gh api -X DELETE repos/owner/name/rulesets/42', 'repository, its rulesets'],
  ['gh api repos/{owner}/{repo} -f visibility=private', 'repository, its rulesets'],
  // Releases.
  ['gh release create v1.0.0 --notes x', 'release'],
  ['gh release edit v1.0.0 --draft=false', 'release'],
  ['gh release delete v1.0.0 --yes', 'release'],
  // Merges that bypass, merge later or delete the branch.
  ['gh pr merge 12 --squash --admin', 'merge'],
  ['gh pr merge --auto --squash', 'merge'],
  ['gh pr merge 12 --merge --delete-branch', 'merge'],
  ['gh pr merge 12 -sd', 'merge'],
  ['gh pr merge 12 -d', 'merge'],
  // Publishing.
  ['npm publish', 'publishing'],
  ['npm publish --dry-run', 'publishing'],
  ['pnpm -r publish --access public', 'publishing'],
  ['yarn npm publish', 'publishing'],
  // Stopping packaged BMN.
  ['pkill bmn', 'stopping BMN'],
  ['killall bmn', 'stopping BMN'],
  ['kill $(pgrep -f /opt/BMN/bmn)', 'stopping BMN'],
  ['pgrep -f linux-unpacked/bmn | xargs kill -9', 'stopping BMN'],
  // Ordinary forms the epic review found passing (2026-10-19): a continued line, a repository flag before the subcommand, an
  // attached field.
  ['git push origin \\\n  --force main', 'force'],
  ['git push \\\r\n  --delete origin old', 'deletion'],
  ['gh -R octo/widgets pr merge 7 --admin --squash', 'merge'],
  ['gh --repo octo/widgets pr merge 7 --auto', 'merge'],
  ['gh api -X POST repos/octo/widgets/rulesets -fname=rule', 'repository, its rulesets'],
  ['gh api repos/octo/widgets -Fvisibility=private', 'repository, its rulesets'],
  // Quoting the executable or passing shell code still executes it.
  ["'pkill' 'bmn'", 'stopping BMN'],
  ['env BMN_TEST=1 /usr/bin/pkill bmn', 'stopping BMN'],
  ["bash -lc 'pkill bmn'", 'stopping BMN'],
  ["eval 'killall bmn'", 'stopping BMN'],
  ['echo "$(pkill bmn)"', 'stopping BMN'],
  ['printf "%s" `killall bmn`', 'stopping BMN'],
  ["cat <<EOF\n$(pkill bmn)\nEOF", 'stopping BMN'],
  ["cat <<EOF\n'$(pkill bmn)'\nEOF", 'stopping BMN'],
  ["bash <<'EOF'\npkill bmn\nEOF", 'stopping BMN'],
  ["cat <<'EOF'\nplain data\nEOF\npkill bmn", 'stopping BMN'],
  ["cat <<'FIRST' <<'SECOND'\nkillall bmn\nFIRST\npkill bmn\nSECOND\nkillall bmn", 'stopping BMN'],
  ['echo ok > /tmp/log; pkill bmn', 'stopping BMN'],
  ['cat <(pkill bmn)', 'stopping BMN'],
  ["sh -c 'git push --force origin main'", 'force'],
  ['ps aux | grep bmn | xargs kill', 'stopping BMN'],
  ["bash -c $'pkill bmn'", 'stopping BMN'],
  ['sudo -n pkill bmn', 'stopping BMN'],
  ['exec -a fixture pkill bmn', 'stopping BMN'],
  ["eval -- 'pkill bmn'", 'stopping BMN'],
  ["bash -s -- fixture <<'EOF'\npkill bmn\nEOF", 'stopping BMN'],
  ['sudo -E pkill bmn', 'stopping BMN'],
  ['sudo -k killall bmn', 'stopping BMN'],
  ['eval kill $(pgrep bmn)', 'stopping BMN'],
  ['sudo sh -c "kill -9 $(pgrep -f bmn)"', 'stopping BMN'],
  ["echo 'pkill bmn' | sh", 'stopping BMN'],
  ["printf '%s\\n' 'killall bmn' | bash", 'stopping BMN'],
  ["cat <<'EOF' | bash\npkill bmn\nEOF", 'stopping BMN'],
  ["printf $'it\\'s\\n'; pkill bmn", 'stopping BMN'],
  ['time pkill bmn', 'stopping BMN'],
  ['doas pkill bmn', 'stopping BMN'],
  ['function stop { pkill bmn; }', 'stopping BMN'],
  ['command git push -v --force origin main', 'force'],
  ['yarn workspace pkg npm publish', 'publishing'],
  ['yarn workspaces foreach -A npm publish', 'publishing'],
  ['kill $(cat /run/user/1000/bmn.pid)', 'stopping BMN'],
  ["sh <<<'pkill bmn'", 'stopping BMN']
]

const LEFT: string[] = [
  'git push',
  'git push origin feature-x',
  'git push -u origin feature-fix',
  'git push origin HEAD:refs/heads/feature',
  'git push --dry-run origin main',
  'git push origin main',
  'git push -o ci.skip origin feature',
  'gh pr merge 12 --squash',
  'gh pr merge 12 --rebase',
  'gh pr create --title x --body y',
  'gh pr edit 12 --title x',
  'gh pr ready 12',
  'gh pr comment 12 --body ok',
  'gh repo view --json owner',
  'gh api repos/owner/name',
  'gh api -X GET repos/owner/name/rulesets -f per_page=100',
  'gh api -X POST repos/owner/name/statuses/abc -f state=success',
  'gh api -X POST repos/owner/name/issues/1/comments -f body=x',
  'gh release view v1',
  'pnpm run update:desktop',
  'npm run build',
  'git branch -d old && git status',
  'git tag -d v0 ; git log',
  'kill %1',
  'bmn plan status --json',
  'git push origin feature && git branch -D merged',
  'git push origin \\\n  feature-x',
  'gh -R octo/widgets pr merge 7 --squash',
  'gh -R octo/widgets api repos/octo/widgets/issues/1/comments -fbody=x',
  // String arguments, comments and heredoc bodies are data, not commands.
  'git commit -m "never git push --force to main"',
  "git commit -m 'docs: explain npm publish'",
  "printf '%s\\n' 'pkill bmn; git push --force'",
  'echo "killall bmn"',
  "echo '$(pkill bmn)'",
  'echo "\\$(pkill bmn)"',
  'echo bmn; kill %1',
  'kill %1 # bmn',
  '# pkill bmn\nprintf ok',
  'echo git push --force',
  'git push origin feature # --force',
  "cat > /tmp/bmn-test.mjs <<'JS'\n// bmn fixture\nchild.kill('SIGTERM')\nconst text = 'pkill bmn; git push --force'\n$(killall bmn)\nJS",
  'cat <<"END"\npkill bmn\nEND',
  'cat <<E\\ND\npkill bmn\nEND',
  'cat <<EOF\npkill bmn\nEOF',
  "cat <<-'EOF'\n\tpkill bmn\n\tEOF",
  "cat <<'FIRST' <<'SECOND'\npkill bmn\nFIRST\nkillall bmn\nSECOND",
  "cat <<'EOF'\npkill bmn\nEOF\nprintf '%s' 'killall bmn'",
  "git commit -F - <<'MESSAGE'\nDocument git push --force and npm publish\nMESSAGE",
  'echo "<(pkill bmn)"',
  'cat <<EOF\n<(pkill bmn)\nEOF',
  'cat <<EOF\n\\$(pkill bmn)\nEOF',
  "node - <<'JS'\nconst bmn = spawn('fixture');\nbmn.kill('SIGTERM');\nJS",
  "python3 - <<'PY'\n# bmn diagnostic fixture\nscript = 'timeout --signal=TERM --kill-after=3 116 node probe.mjs'\nPY",
  "npm run example -- 'npm publish'",
  'command -v pkill bmn',
  "bash -n <<'EOF'\npkill bmn\nEOF",
  "bash fixture.sh <<'EOF'\npkill bmn\nEOF",
  "echo 'pkill bmn'; sh",
  "printf '# %s\\n' 'pkill bmn' | sh",
  "cat <<'EOF' | bash -n\npkill bmn\nEOF",
  "cat <<<'pkill bmn'",
  "bash 3<<'EOF'\npkill bmn\nEOF",
  "bash <<'FIRST' <<'SECOND'\npkill bmn\nFIRST\nprintf ok\nSECOND",
  "echo 'pkill bmn' | bash < fixture.sh",
  ''
]

describe('the command guard (Story 83.4)', () => {
  it.each(HELD)('holds %s', (command, what) => {
    expect(heldCommand(command)).toContain(what)
  })

  it.each(LEFT.map((command) => [command]))('leaves %j to the app', (command) => {
    expect(heldCommand(command)).toBeNull()
  })

  it('answers Claude Code with its own permission prompt, never an allow', () => {
    const answer = JSON.parse(guardAnswer('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push -f' } }) ?? '')
    expect(answer).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: expect.stringContaining('a force push') }
    })
  })

  it('answers Codex with a block whose reason tells the agent to ask the owner', () => {
    const answer = JSON.parse(guardAnswer('codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh release create v1' } }) ?? '')
    expect(answer.decision).toBe('block')
    expect(answer.reason).toMatch(/a release.*ask him/)
    expect(answer.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: answer.reason })
  })

  it('has only three outputs: nothing, ask and block', () => {
    const events = [
      ...HELD.map(([command]) => command), ...LEFT
    ].flatMap((command) => (['claude', 'codex', 'opencode'] as const).flatMap((agent) =>
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } },
        { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { command } }].map((event) => [agent, event] as const)))
    const kinds = new Set(events.map(([agent, event]) => {
      const answer = guardAnswer(agent, event)
      if (answer === null) return 'nothing'
      const parsed = JSON.parse(answer)
      return parsed.decision === 'block' ? 'block' : parsed.hookSpecificOutput.permissionDecision
    }))
    expect([...kinds].sort()).toEqual(['ask', 'block', 'nothing'])
  })

  it('answers nothing for input it cannot read, another event, another tool or an app it does not guard', () => {
    expect(guardAnswer('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ['git', 'push', '-f'] } })).toBeNull()
    expect(guardAnswer('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeNull()
    expect(guardAnswer('claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push -f' } })).toBeNull()
    expect(guardAnswer('claude', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { command: 'git push -f' } })).toBeNull()
    expect(guardAnswer('opencode', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push -f' } })).toBeNull()
    expect(GUARDED_TOOLS).toEqual({ claude: 'Bash', codex: 'Bash' })
  })
})
