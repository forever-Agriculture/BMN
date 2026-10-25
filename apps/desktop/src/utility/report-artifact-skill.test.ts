// MODULE: report-artifact-skill.test.ts - the report-artifact skill's check: the template filled with the Epic 101 sample passes; a wrong shape, a long, unsafe or unfilled page fails
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SKILL = fileURLToPath(new URL('../../../../skills/report-artifact', import.meta.url))
const TEMPLATE = readFileSync(join(SKILL, 'template.html'), 'utf8')
const SAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/report-artifact/epic-101-body.html', import.meta.url)), 'utf8')
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** The template's head and look with the Epic 101 sample as its body, its screenshot embedded. */
function filled(): string {
  const head = TEMPLATE.slice(0, TEMPLATE.indexOf('<div class="band">')).replace('<title>Two To Four Words</title>', '<title>Epic 101 report</title>')
  const body = SAMPLE.slice(SAMPLE.indexOf('<div class="band">'))
  return head + body.replaceAll('SCREENSHOT_DATA', PIXEL)
}

/** `page` with the text from `from` up to (not including) `to` replaced. */
function splice(page: string, from: string, to: string, by: string): string {
  const start = page.indexOf(from)
  const end = page.indexOf(to, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return page.slice(0, start) + by + page.slice(end)
}

const ROW = /<tr>\s*<td data-label="Problem">[\s\S]*?<\/tr>/u
const OPINION = /<div class="opinion">[\s\S]*?<\/div>\s*(?=<div class="opinion">|<\/div>)/u

describe('the report-artifact skill check', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bmn-report-artifact-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function check(page: string, ...flags: string[]): { code: number; out: string; err: string } {
    const file = join(dir, 'page.html')
    writeFileSync(file, page)
    try {
      return { code: 0, out: execFileSync('python3', [join(SKILL, 'check.py'), file, ...flags], { encoding: 'utf8', stdio: 'pipe' }), err: '' }
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string }
      return { code: failed.status, out: failed.stdout, err: failed.stderr }
    }
  }

  function fails(page: string, rule: string): void {
    const result = check(page)
    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain(`FAIL  ${rule}`)
  }

  it('passes the template filled with the Epic 101 sample, and fails the template left unfilled on its placeholders only', () => {
    const page = check(filled())
    expect(page.code, page.out).toBe(0)
    expect(page.out).toContain('PASS  parts in the fixed order: header, in-short, changes, still-open, next, opinions, footer')
    const raw = check(TEMPLATE)
    expect(raw.code).toBe(1)
    expect(raw.out.split('\n').filter((line) => line.startsWith('FAIL'))).toEqual([expect.stringMatching(/^FAIL {2}no template placeholders left/u)])
  })

  it('fails a table of zero or seven rows, another header, a second table, an empty cell, a row without proof and a missing checks line', () => {
    const page = filled()
    const row = ROW.exec(page)![0]
    fails(page.replace(/<tbody>[\s\S]*<\/tbody>/u, '<tbody></tbody>'), 'the table has 1-6 rows')
    fails(page.replace('</tbody>', `${row}</tbody>`), 'the table has 1-6 rows')
    fails(page.replace('<th scope="col">Fix</th>', '<th scope="col">Change</th>'), 'the table is headed Problem | Fix | What happens now')
    fails(page.replace('<h3>Also fixed</h3>', '<table><tr><td>x</td></tr></table><h3>Also fixed</h3>'), 'exactly one table on the page')
    fails(page.replace('<td data-label="Fix">The client\'s own company is removed from target lists.</td>', '<td data-label="Fix"> </td>'), 'every row has three filled cells')
    fails(page.replace('<p class="proof"><span class="ok">✓ backend tests</span></p>', ''), 'every row ends with a proof line (.proof)')
    fails(page.replace('<p class="checks">', '<p>'), 'exactly one checks line (.checks) in What changed')
  })

  it('counts the report text once and fails 901 words while 900 pass with the screenshot present', () => {
    const page = filled()
    const padded = (n: number) => page.replace('<p>This work fixes', `<p>${'word '.repeat(n)}This work fixes`)
    const over = check(padded(2000)).out.match(/at most 900 words of report text {2}\((\d+) words\)/u)
    const base = Number(over![1]) - 2000
    expect(base).toBeGreaterThan(600)
    expect(check(padded(900 - base))).toMatchObject({ code: 0 })
    fails(padded(901 - base), 'at most 900 words of report text')
    // Alt text, the image data and the full-size view's bar are not report text
    const long = page.replace('alt="The Report evidence admin page at full size"', `alt="${'word '.repeat(400)}"`)
      .replace('Scroll to see all of it.', `${'word '.repeat(400)}`)
    expect(check(long.replace('<p>This work fixes', `<p>${'word '.repeat(900 - base)}This work fixes`))).toMatchObject({ code: 0 })
  })

  it('fails one or three opinions, an opinion without its model and role or its verdict, and opinions that are not last', () => {
    const page = filled()
    const opinion = OPINION.exec(page)![0]
    fails(page.replace(opinion, ''), 'opinions: exactly two blocks (.opinion)')
    fails(page.replace(opinion, opinion + opinion), 'opinions: exactly two blocks (.opinion)')
    fails(page.replace('<p class="who">Astra · independent review</p>', ''), "each opinion names its model and role ('Model · role')")
    fails(page.replace('<p class="who">Astra · independent review</p>', '<p class="who">Astra</p>'), "each opinion names its model and role ('Model · role')")
    fails(page.replace('<p class="verdict"><strong>Worth shipping.</strong></p>', ''), 'each opinion has a bold verdict of 1-4 words')
    fails(page.replace('<strong>Worth shipping.</strong>', '<strong>Worth shipping, in my view, today.</strong>'), 'each opinion has a bold verdict of 1-4 words')
    const opinions = /\s*<section data-part="opinions">[\s\S]*?<\/section>/u.exec(page)![0]
    fails(page.replace(opinions, '').replace('<section data-part="next">', `${opinions.trim()}\n  <section data-part="next">`), 'opinions are the last part before the footer')
  })

  it('fails the old dashboard parts and a screenshot without alt text, caption or full-size view', () => {
    const page = filled()
    for (const kind of ['card hero', 'card tile', 'chip g', 'card', 'bar']) {
      fails(page.replace('<h3>Also fixed</h3>', `<div class="${kind}">x</div><h3>Also fixed</h3>`), 'only the page\'s element kinds')
    }
    fails(page.replace('<h3>Also fixed</h3>', '<details><summary>More</summary>x</details><h3>Also fixed</h3>'), 'only the page\'s element kinds')
    fails(page.replace(/alt="The Report evidence admin page: [^"]*"/u, 'alt=""'), 'every screenshot has alt text')
    fails(page.replace(/<figcaption>[\s\S]*?<\/figcaption>/u, ''), 'every screenshot has a caption')
    fails(page.replace(/<div class="shot" id="shot-1">[\s\S]*?<\/div>/u, ''), 'every screenshot opens its full-size view')
    fails(page.replace('<a href="#what-changed">Close</a>', '<a href="#top">Close</a>'), 'every screenshot opens its full-size view')
    fails(page.replace('<a href="#shot-1">', '<a href="#shot-2">'), 'every screenshot opens its full-size view')
    fails(page.replace(`src="${PIXEL}" width="1440" height="1636" alt="The Report evidence admin page:`, 'src="evidence.png" width="1440" height="1636" alt="The Report evidence admin page:'), 'every screenshot is embedded as data')
  })

  it('fails a missing doctype or charset, scripts, credentials, home paths, placeholders and run ids as before, and passes "None known." and "Nothing."', () => {
    const page = filled()
    fails(page.replace('<!doctype html>', ''), 'a doctype and a utf-8 charset')
    fails(page.replace('<meta charset="utf-8">', ''), 'a doctype and a utf-8 charset')
    fails(page.replace('</main>', '<script>1</script></main>'), 'no scripts or event handlers')
    fails(page.replace('<h1>', '<h1 onclick="x()">'), 'no scripts or event handlers')
    fails(page.replace('<h2>Still open</h2>', `<h2>Still open</h2><p>${'sk-' + 'a'.repeat(24)}</p>`), 'no credential-shaped strings')
    fails(page.replace('<h2>Still open</h2>', '<h2>Still open</h2><p>/home/someone/x</p>'), 'no home-folder or session paths')
    fails(page.replace('<h3>Also fixed</h3>', '<h3>Person\'s name</h3>'), 'no template placeholders left')
    fails(page.replace('<h2>Still open</h2>', '<h2>Still open</h2><p>run 20261025T142226-84d73b70</p>'), 'no run ids outside the footer')
    expect(check(page.replace('</footer>', '<p>run 20261025T142226-84d73b70</p></footer>'))).toMatchObject({ code: 0 })
    const quiet = page.replace(/(<h2>Still open<\/h2>)\s*<ul>[\s\S]*?<\/ul>/u, '$1<p>None known.</p>')
      .replace(/(<h2>Next steps<\/h2>)[\s\S]*?(<\/section>)/u, '$1<p>Nothing.</p>$2')
    expect(check(quiet)).toMatchObject({ code: 0 })
  })

  it('refuses --owner, which is gone, with a usage line', () => {
    const result = check(filled(), '--owner')
    expect(result.code).toBe(2)
    expect(result.err).toContain('Usage: check.py PAGE.html')
  })
})
