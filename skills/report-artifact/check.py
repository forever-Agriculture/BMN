#!/usr/bin/env python3
# MODULE: check.py - PASS/FAIL checks of a report page: its parts and their order, the Problem | Fix | What happens now table, screenshots and their full-size view, two opinions, look, length and hygiene
"""Check a report page made from template.html. Exit 0 only when every rule passes.

Usage: check.py PAGE.html
"""
import html
import re
import sys
from html.parser import HTMLParser

ORDER = ["in-short", "changes", "still-open", "next", "opinions"]
COLUMNS = ["problem", "fix", "what happens now"]
MAX_ROWS = 6
MAX_WORDS = 900
MAX_COLUMN = 1040
# Element kinds the page leaves behind: the old dashboard's parts and anything that folds, draws or asks
RETIRED_CLASSES = {"hero", "tile", "tiles", "chip", "chips", "card", "bar", "bars", "kpi", "callout", "flow", "pill", "exhibit", "grid"}
RETIRED_TAGS = {"details", "summary", "iframe", "canvas", "svg", "form", "button", "input"}
OPEN_STATE = re.compile(r"^(○|✕|not\b|unverified|pending|failed|blocked)", re.I)
STYLESHEET_HOSTS = ("https://fonts.googleapis.com/",)
RUN_ID = re.compile(r"\b\d{8}T\d{6}-[0-9a-f]{8}\b")
SECRET = re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\d{8,10}:[A-Za-z0-9_-]{30,})\b")
HOME_PATH = re.compile(r"(/home/[a-z_][a-z0-9_-]*/|/Users/[A-Za-z0-9_-]+/|/tmp/claude-)")
DATA_URI = re.compile(r"data:[^\"'\s)]+")
PLACEHOLDERS = re.compile(
    r"Two To Four Words|Project · Work · Date|What Changed In Two To Eight Words|checked where \(build, test bed\)|PASTE_SCREENSHOT|"
    r"What the product is, for someone|Short name of what hurt|One line per smaller fix|N of N tests pass|Person's name|"
    r"Owner's name|Verdict in 1-4 words|Reviewer model|Written by App \(Model\)")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class Node:
    def __init__(self, tag, attrs, parent: "Node | None"):
        self.tag, self.attrs, self.parent = tag, {k: v or "" for k, v in attrs}, parent
        self.children: list[Node] = []
        self.text: list[str] = []

    def classes(self):
        return (self.attrs.get("class") or "").split()

    def walk(self, skip=lambda n: False):
        if skip(self):
            return
        yield self
        for child in self.children:
            yield from child.walk(skip)

    def find(self, pred):
        return [n for n in self.walk() if pred(n)]

    def all_text(self, skip=lambda n: False):
        return " ".join(t for n in self.walk(skip) for t in n.text)

    def within(self, pred):
        p = self.parent
        while p is not None and not pred(p):
            p = p.parent
        return p


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", [], None)
        self.cur: Node = self.root
        self.style = []
        self.skip = None

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag in ("style", "script"):
            self.skip = tag
        if tag not in VOID:
            self.cur = node

    def handle_endtag(self, tag):
        if tag == self.skip:
            self.skip = None
        n = self.cur
        while n.parent is not None and n.tag != tag:
            n = n.parent
        if n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        if self.skip == "style":
            self.style.append(data)
        elif self.skip is None:
            self.cur.text.append(data)


def words(text):
    """A word is a run of characters holding a letter or a digit; separators and status shapes (·, ✓, ○) are not words."""
    return sum(1 for w in html.unescape(text).split() if any(c.isalnum() for c in w))


def check(source):
    tree = Tree()
    tree.feed(source)
    root, css = tree.root, "\n".join(tree.style)
    results = []

    def rule(name, ok, detail=""):
        results.append((name, bool(ok), detail))

    def has_class(cls):
        return lambda n: cls in n.classes()

    rule("a doctype and a utf-8 charset", re.search(r"<!doctype html>", source, re.I) and root.find(
        lambda n: n.tag == "meta" and n.attrs.get("charset", "").lower() == "utf-8"))
    titles = root.find(lambda n: n.tag == "title")
    title = titles[0].all_text().strip() if titles else ""
    rule("title of 2-4 words", 2 <= words(title) <= 4, repr(title))

    # The header: eyebrow, one title, one status line
    headers = root.find(lambda n: n.tag == "header")
    header = headers[0] if len(headers) == 1 else None
    rule("one header", header is not None, f"{len(headers)} headers")
    eyebrow = header.find(has_class("eyebrow")) if header else []
    rule("header: eyebrow 'project · work · date'", eyebrow and eyebrow[0].all_text().count("·") >= 2,
         eyebrow[0].all_text().strip() if eyebrow else "missing")
    h1 = header.find(lambda n: n.tag == "h1") if header else []
    rule("header: one h1 of 2-8 words", len(root.find(lambda n: n.tag == "h1")) == 1 and h1 and 2 <= words(h1[0].all_text()) <= 8)
    status = header.find(has_class("status")) if header else []
    rule("header: one status line", len(status) == 1 and status[0].all_text().strip())
    green_open = [n.all_text().strip() for n in root.find(has_class("ok")) if OPEN_STATE.match(n.all_text().strip())]
    rule("an open status is never marked done (.ok)", not green_open, ", ".join(green_open))

    # The parts, in their fixed order between the header and the footer
    sections = root.find(lambda n: n.tag == "section")
    parts = [s.attrs.get("data-part") for s in sections]
    unknown = [p for p in parts if p not in ORDER]
    rule("every section names a known part", not unknown, ", ".join(map(str, unknown)))
    rule("no part twice", len(parts) == len(set(parts)))
    missing = [p for p in ORDER if p not in parts]
    rule("every part present", not missing, "missing: " + ", ".join(missing) if missing else "")
    sequence = [n.attrs.get("data-part") if n.tag == "section" else n.tag
                for n in root.find(lambda n: n.tag in ("header", "section", "footer"))]
    expected = ["header"] + [p for p in ORDER if p in parts] + ["footer"]
    rule("parts in the fixed order: header, " + ", ".join(ORDER) + ", footer", sequence == expected, " > ".join(map(str, sequence)))
    rule("opinions are the last part before the footer", [p for p in sequence if p != "footer"][-1:] == ["opinions"])
    by = {s.attrs.get("data-part"): s for s in sections}
    for part, section in by.items():
        if part in ORDER:
            rule(f"{part}: has an h2 and content", section.find(lambda n: n.tag == "h2") and any(
                n.tag != "h2" and (n.all_text().strip() or n.find(lambda c: c.tag == "img")) for n in section.children))

    # What changed: one table, Problem | Fix | What happens now, 1-6 complete rows each ending with its proof; one checks line
    tables = root.find(lambda n: n.tag == "table")
    rule("exactly one table on the page", len(tables) == 1, f"{len(tables)} tables")
    table = tables[0] if tables else None
    in_changes = table is not None and table.within(lambda p: p.attrs.get("data-part") == "changes") is not None
    rule("the table sits in What changed (changes)", in_changes)
    heads = [h.all_text().strip().lower() for h in table.find(lambda n: n.tag == "th")] if table else []
    rule("the table is headed Problem | Fix | What happens now", heads == COLUMNS, " | ".join(heads))
    rows = [r for r in table.find(lambda n: n.tag == "tr") if not r.within(lambda p: p.tag == "thead")] if table else []
    rule(f"the table has 1-{MAX_ROWS} rows", 1 <= len(rows) <= MAX_ROWS, f"{len(rows)} rows")
    cells = [[c for c in r.children if c.tag in ("td", "th")] for r in rows]
    rule("every row has three filled cells", rows and all(len(c) == 3 and all(x.all_text().strip() for x in c) for c in cells))
    rule("every cell carries its data-label", rows and all(x.attrs.get("data-label", "").strip() for c in cells for x in c))
    proofless = [i + 1 for i, c in enumerate(cells) if len(c) < 3 or not (
        (p := c[2].find(has_class("proof"))) and p[-1].all_text().strip())]
    rule("every row ends with a proof line (.proof)", rows and not proofless, "rows " + ", ".join(map(str, proofless)) if proofless else "")
    checks = root.find(has_class("checks"))
    rule("exactly one checks line (.checks) in What changed", len(checks) == 1 and checks[0].all_text().strip()
         and checks[0].within(lambda p: p.attrs.get("data-part") == "changes") is not None, f"{len(checks)} lines")

    # Screenshots: embedded, at their declared size, with alt text, a caption and a script-free full-size view
    in_view = lambda n: n.within(has_class("shot")) is not None
    shots = [n for n in root.find(lambda n: n.tag == "img") if not in_view(n)]
    views = {n.attrs.get("id"): n for n in root.find(has_class("shot"))}
    rule("every screenshot has alt text", all(i.attrs.get("alt", "").strip() for i in shots))
    rule("every screenshot is embedded as data", all(i.attrs.get("src", "").startswith("data:image/") for i in shots))
    rule("every screenshot declares its width and height", all(
        i.attrs.get("width", "").isdigit() and i.attrs.get("height", "").isdigit() for i in shots))
    uncaptioned = [i for i in shots if not ((f := i.within(lambda p: p.tag == "figure")) and
                                             any(c.all_text().strip() for c in f.find(lambda c: c.tag == "figcaption")))]
    rule("every screenshot has a caption", not uncaptioned)
    viewless = []
    for i in shots:
        link = i.within(lambda p: p.tag == "a")
        target = (link.attrs.get("href", "") if link else "").removeprefix("#")
        view = views.get(target) if target else None
        home = i.within(lambda p: p.tag == "section")
        close = f"#{home.attrs.get('id')}" if home is not None and home.attrs.get("id") else None
        if not (view and view.find(lambda n: n.tag == "img" and n.attrs.get("src") == i.attrs.get("src"))
                and close and view.find(lambda n: n.tag == "a" and n.attrs.get("href") == close)):
            viewless.append(i.attrs.get("alt", "")[:40])
    rule("every screenshot opens its full-size view (.shot) with a Close link to its section", not viewless, ", ".join(viewless))
    rule("full-size view styles present (.shot:target)", not shots or ".shot:target" in css)

    # Opinions: two blocks, each "Model · role", a bold verdict of 1-4 words and its sentences
    opinions = by["opinions"].find(has_class("opinion")) if "opinions" in by else []
    rule("opinions: exactly two blocks (.opinion)", len(opinions) == 2, f"{len(opinions)} blocks")
    who = [o.find(has_class("who")) for o in opinions]
    rule("each opinion names its model and role ('Model · role')", opinions and all(
        w and "·" in w[0].all_text() and all(s.strip() for s in w[0].all_text().split("·")) for w in who))
    verdicts = [o.find(has_class("verdict")) for o in opinions]
    rule("each opinion has a bold verdict of 1-4 words", opinions and all(
        v and v[0].find(lambda n: n.tag in ("strong", "b")) and 1 <= words(v[0].all_text()) <= 4 for v in verdicts))
    rule("each opinion has its sentences", opinions and all(any(
        p.tag == "p" and not ({"who", "verdict", "marker"} & set(p.classes())) and p.all_text().strip() for p in o.children) for o in opinions))

    retired = sorted({c for n in root.walk() for c in n.classes() if c in RETIRED_CLASSES} |
                     {n.tag for n in root.walk() if n.tag in RETIRED_TAGS})
    rule("only the page's element kinds (no hero, tiles, chips, cards, bars, callouts, flows, folds)", not retired, ", ".join(retired))
    rule("no inline styles", not root.find(lambda n: "style" in n.attrs))

    footers = root.find(lambda n: n.tag == "footer")
    rule("footer names its writer", footers and words(footers[0].all_text()) >= 4)
    rule("footer points to the evidence (a link or a code reference)", footers and footers[0].find(
        lambda n: (n.tag == "a" and n.attrs.get("href", "").strip()) or n.tag == "code"))

    rule("tokens on :root", re.search(r":root\s*\{[^}]*--ink", css))
    rule("light and dark by the system setting and by data-theme", "prefers-color-scheme: dark" in css
         and ':root:not([data-theme="light"])' in css and ':root[data-theme="dark"]' in css)
    rule("body has its own background", re.search(r"body\s*\{[^}]*background", css))
    rule(f"one column of at most {MAX_COLUMN}px", (m := re.search(r"main\s*\{[^}]*max-width:\s*(\d+)px", css)) and int(m.group(1)) <= MAX_COLUMN)
    rule("a phone viewport meta", root.find(lambda n: n.tag == "meta" and n.attrs.get("name") == "viewport"
                                             and "width=device-width" in n.attrs.get("content", "")))

    links = [n.attrs.get("href", "") for n in root.find(lambda n: n.tag == "link" and n.attrs.get("rel") == "stylesheet")]
    rule("stylesheets only from Google Fonts", all(h.startswith(STYLESHEET_HOSTS) for h in links), ", ".join(links))
    rule("no scripts or event handlers", not root.find(lambda n: n.tag == "script" or any(
        k.lower().startswith("on") or v.strip().lower().startswith("javascript:") for k, v in n.attrs.items())))

    # The report text, counted once: everything readable but the title, alt text, image data and the full-size view's bar
    text = root.all_text(skip=lambda n: n.tag == "title" or "shot" in n.classes())
    count = words(text)
    rule(f"at most {MAX_WORDS} words of report text", count <= MAX_WORDS, f"{count} words")
    footer_text = footers[0].all_text() if footers else ""
    rule("no run ids outside the footer", not RUN_ID.search(text.replace(footer_text, "")))
    raw = html.unescape(DATA_URI.sub("data:", source))
    rule("no credential-shaped strings", not SECRET.search(raw))
    rule("no home-folder or session paths", not HOME_PATH.search(raw), (HOME_PATH.search(raw) or [""])[0])
    rule("no template placeholders left", not PLACEHOLDERS.search(source), (PLACEHOLDERS.search(source) or [""])[0])
    return results


def main(argv):
    if len(argv) != 2 or argv[1].startswith("-"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        results = check(fh.read())
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    failed = sum(not ok for _, ok, _ in results)
    print(f"{len(results) - failed} PASS, {failed} FAIL")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
