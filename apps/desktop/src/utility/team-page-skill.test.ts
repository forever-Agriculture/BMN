// MODULE: team-page-skill.test.ts - the team-page skill's check: the template's look passes, a filled page passes, an unfilled or unsafe page fails
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SKILL = fileURLToPath(new URL('../../../../skills/team-page', import.meta.url))
const TEMPLATE = readFileSync(join(SKILL, 'template.html'), 'utf8')

/** The template with every placeholder replaced by synthetic content. */
function filled(): string {
  return TEMPLATE
    .replace('<title>Two To Four Words</title>', '<title>Reminders Reach Phones</title>')
    .replace('Project · Epic N · 17 October 2026', 'Harbor Notes · Epic 12 · 17 October 2026')
    .replace('What is different now', 'Reminders reach your phone')
    .replace('<strong>A bold opening phrase.</strong>', '<strong>Push messages for reminders.</strong>')
    .replace('Written by … (app, model).', 'Written by the Epic 12 lead (Claude Code, Opus 5.5).')
}

describe('the team-page skill check', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bmn-team-page-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function check(page: string, ...flags: string[]): { code: number; out: string } {
    const file = join(dir, 'page.html')
    writeFileSync(file, page)
    try {
      return { code: 0, out: execFileSync('python3', [join(SKILL, 'check.py'), file, ...flags], { encoding: 'utf8' }) }
    } catch (error) {
      const failed = error as { status: number; stdout: string }
      return { code: failed.status, out: failed.stdout }
    }
  }

  it('passes the filled template for the owner, and fails the template left unfilled', () => {
    expect(check(filled(), '--owner')).toMatchObject({ code: 0 })
    const raw = check(TEMPLATE)
    expect(raw.code).toBe(1)
    expect(raw.out).toContain('FAIL  no template placeholders left')
  })

  it('requires Decided for you only on an owner page, and keeps the parts in their order', () => {
    const page = filled().replace(/\s*<!-- owner page only -->\s*<section data-part="decided">[\s\S]*?<\/section>/u, '')
    expect(check(page).code).toBe(0)
    expect(check(page, '--owner').out).toContain('FAIL  required parts present')
    const swapped = filled().replace('data-part="why"', 'data-part="tmp"').replace('data-part="limits"', 'data-part="why"').replace('data-part="tmp"', 'data-part="limits"')
    expect(check(swapped).out).toContain('FAIL  parts in the fixed order')
  })

  it('fails scripts, an empty example, a footer without evidence, home paths and credentials', () => {
    const page = filled()
    expect(check(page.replace('</main>', '<script>1</script></main>')).out).toContain('FAIL  no scripts or event handlers')
    expect(check(page.replace('<h1>', '<h1 onclick="x()">')).out).toContain('FAIL  no scripts or event handlers')
    expect(check(page.replace(/<div class="exhibit"[\s\S]*?<\/div>/u, '<div class="exhibit"></div>')).out).toContain('FAIL  changes: the example has content')
    expect(check(page.replace(/Details:[^<]*<a[^>]*>[^<]*<\/a>, records in <code>[^<]*<\/code>\./u, 'Thanks.')).out).toContain('FAIL  footer points to the evidence')
    expect(check(page.replace('Known limits</h2>', 'Known limits</h2><p>/home/someone/x</p>')).out).toContain('FAIL  no home-folder or session paths')
    expect(check(page.replace('Known limits</h2>', `Known limits</h2><p>${'sk-' + 'a'.repeat(24)}</p>`)).out).toContain('FAIL  no credential-shaped strings')
  })

  it('passes a one-step "Nothing." list and a short lede', () => {
    const page = filled()
      .replace(/<ol>\s*<li>The most urgent step first\.<\/li>\s*<\/ol>/u, '<ol><li>Nothing.</li></ol>')
      .replace(/<p class="lede">[^<]*<\/p>/u, '<p class="lede">Reminders arrive on phones now.</p>')
    expect(check(page, '--owner')).toMatchObject({ code: 0 })
  })
})
