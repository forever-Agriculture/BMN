// MODULE: report-artifact-skill.test.ts - the report-artifact skill's check: the template's look passes, a filled page passes, an unfilled, dishonest or unsafe page fails
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SKILL = fileURLToPath(new URL('../../../../skills/report-artifact', import.meta.url))
const TEMPLATE = readFileSync(join(SKILL, 'template.html'), 'utf8')

/** The template with every placeholder replaced by synthetic content. */
function filled(): string {
  return TEMPLATE
    .replace('<title>Two To Four Words</title>', '<title>Reminders Reach Phones</title>')
    .replace('Project · Epic N · 17 October 2026', 'Harbor Notes · Epic 12 · 17 October 2026')
    .replace('What is different now', 'Reminders reach your phone')
    .replace('The one-line result in bold:', 'Reminders now reach phones:')
    .replace('Who asked, what hurt, and the source.', 'Ana asked on 3 October: reminders were missed on the road.')
    .replace('<h3>A bold opening phrase</h3>', '<h3>Push messages for reminders</h3>')
    .replace('<h3>For Dana</h3>', '<h3>For Ana</h3>')
    .replace('example.webp', 'reminder.webp')
    .replace('Written by … (app, model).', 'Written by the Epic 12 lead (Claude Code, Opus 5.5).')
}

/** `page` with the text from `from` up to (not including) `to` replaced. */
function splice(page: string, from: string, to: string, by: string): string {
  const start = page.indexOf(from)
  const end = page.indexOf(to, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return page.slice(0, start) + by + page.slice(end)
}

describe('the report-artifact skill check', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bmn-report-artifact-')) })
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
    const page = filled().replace(/\s*<section data-part="decided">[\s\S]*?<\/section>/u, '')
    expect(check(page).code).toBe(0)
    expect(check(page, '--owner').out).toContain('FAIL  required parts present')
    const swapped = filled().replace('data-part="why"', 'data-part="tmp"').replace('data-part="opinion"', 'data-part="why"').replace('data-part="tmp"', 'data-part="opinion"')
    expect(check(swapped).out).toContain('FAIL  parts in the fixed order')
  })

  it('fails scripts, an empty example, a footer without evidence, home paths and credentials', () => {
    const page = filled()
    expect(check(page.replace('</main>', '<script>1</script></main>')).out).toContain('FAIL  no scripts or event handlers')
    expect(check(page.replace('<h1>', '<h1 onclick="x()">')).out).toContain('FAIL  no scripts or event handlers')
    expect(check(page.replace(/<figure class="exhibit"[\s\S]*?<\/figure>/u, '<figure class="exhibit"></figure>')).out).toContain('FAIL  changes: the example has content')
    expect(check(page.replace(/Details:[^<]*<a[^>]*>[^<]*<\/a>, records in <code>[^<]*<\/code>\./u, 'Thanks.')).out).toContain('FAIL  footer points to the evidence')
    expect(check(page.replace('Known limits</h2>', 'Known limits</h2><p>/home/someone/x</p>')).out).toContain('FAIL  no home-folder or session paths')
    expect(check(page.replace('Known limits</h2>', `Known limits</h2><p>${'sk-' + 'a'.repeat(24)}</p>`)).out).toContain('FAIL  no credential-shaped strings')
  })

  it('passes a one-step "Nothing." list, a short lede, bullets instead of cards and a page without number tiles', () => {
    let page = filled()
      .replace(/<ol>\s*<li>The most urgent step first\.<\/li>\s*<\/ol>/u, '<ol><li>Nothing.</li></ol>')
      .replace(/<div class="lede">[\s\S]*?<\/div>/u, '<div class="lede"><p>Reminders arrive on phones now.</p></div>')
    page = splice(page, '<div class="grid g2">', '<figure', '<ul><li><strong>Push messages.</strong> Reminders reach the phone.</li></ul>\n    ')
    page = splice(page, '<div class="grid g4" style="margin-top: 14px">', '</header>', '')
    expect(check(page, '--owner')).toMatchObject({ code: 0 })
  })

  it('fails a green open status, a lone number tile, a header without its hero, and a page with no dark theme', () => {
    const page = filled()
    expect(check(page.replace('<span class="chip o">Phone not yet verified</span>', '<span class="chip g">Not yet verified on a phone</span>')).out)
      .toContain('FAIL  an open status is never green')
    const lone = splice(page, '<div class="grid g4" style="margin-top: 14px">', '</header>',
      '<div class="grid g4"><div class="card tile"><p class="label">Phones</p><p class="kpi">3</p><p class="note">tested</p></div></div>\n  ')
    expect(check(lone).out).toContain('FAIL  number tiles: none, or 2-4 each with a label, a figure and a note')
    expect(check(page.replace('class="card hero"', 'class="card"')).out).toContain('FAIL  one hero card with a big figure and the lede')
    expect(check(page.replace('color-scheme: dark;', '')).out).toContain('FAIL  a dark theme')
  })
})
