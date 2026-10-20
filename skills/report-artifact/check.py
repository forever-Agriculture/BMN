#!/usr/bin/env python3
# MODULE: check.py - PASS/FAIL checks of a report artifact: structure and order of its parts, header, tables, look, length and hygiene
"""Check a report artifact made from template.html. Exit 0 only when every rule passes.

Usage: check.py PAGE.html [--owner]
  --owner  the page is for the owner, so the Decided for you part is required
"""
import html
import re
import sys
from html.parser import HTMLParser

ORDER = ["why", "changes", "safety", "money", "checks", "limits", "decided", "next", "opinion"]
REQUIRED = {"why", "changes", "checks", "limits", "next", "opinion"}
MAX_WORDS = 1500
MAX_COLUMN = 1200
OPEN_STATE = re.compile(r"^(not\b|unverified|pending|failed|blocked)", re.I)
STYLESHEET_HOSTS = ("https://fonts.googleapis.com/",)
RUN_ID = re.compile(r"\b\d{8}T\d{6}-[0-9a-f]{8}\b")
SECRET = re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\d{8,10}:[A-Za-z0-9_-]{30,})\b")
HOME_PATH = re.compile(r"(/home/[a-z_][a-z0-9_-]*/|/Users/[A-Za-z0-9_-]+/|/tmp/claude-)")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class Node:
    def __init__(self, tag, attrs, parent: "Node | None"):
        self.tag, self.attrs, self.parent = tag, {k: v or "" for k, v in attrs}, parent
        self.children: list[Node] = []
        self.text: list[str] = []

    def classes(self):
        return (self.attrs.get("class") or "").split()

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()

    def find(self, pred):
        return [n for n in self.walk() if pred(n)]

    def all_text(self):
        return " ".join(t for n in self.walk() for t in n.text)


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
    return len(html.unescape(text).split())


def check(source, owner):
    tree = Tree()
    tree.feed(source)
    root, css = tree.root, "\n".join(tree.style)
    results = []

    def rule(name, ok, detail=""):
        results.append((name, bool(ok), detail))

    titles = root.find(lambda n: n.tag == "title")
    title = titles[0].all_text().strip() if titles else ""
    rule("title of 2-4 words", 2 <= words(title) <= 4, repr(title))

    headers = root.find(lambda n: n.tag == "header")
    header = headers[0] if headers else None
    has = lambda cls: header is not None and header.find(lambda n: cls in n.classes())
    eyebrow = has("eyebrow")
    rule("header present", header is not None)
    rule("eyebrow 'project · epic · date'", eyebrow and eyebrow[0].all_text().count("·") >= 2,
         eyebrow[0].all_text().strip() if eyebrow else "missing")
    h1 = header.find(lambda n: n.tag == "h1") if header else []
    rule("one h1 of 2-8 words", len(root.find(lambda n: n.tag == "h1")) == 1 and h1 and 2 <= words(h1[0].all_text()) <= 8)
    lede = has("lede")
    rule("lede present", lede and lede[0].all_text().strip())
    chips = header.find(lambda n: "chip" in n.classes()) if header else []
    rule("2-5 status chips", 2 <= len(chips) <= 5, f"{len(chips)} chips")
    green_open = [c.all_text().strip() for c in chips if "g" in c.classes() and OPEN_STATE.match(c.all_text().strip())]
    rule("an open status is never green", not green_open, ", ".join(green_open))
    heroes = has("hero")
    rule("one hero card with a big figure and the lede", len(heroes) == 1 and heroes[0].find(lambda n: "big" in n.classes())
         and heroes[0].find(lambda n: "lede" in n.classes()))
    tiles = has("tile")
    rule("number tiles: none, or 2-4 each with a label, a figure and a note", not tiles or 2 <= len(tiles) <= 4 and all(
        all(t.find(lambda n, c=c: c in n.classes()) for c in ("label", "kpi", "note")) for t in tiles), f"{len(tiles)} tiles")

    sections = root.find(lambda n: n.tag == "section")
    parts = [s.attrs.get("data-part") for s in sections]
    unknown = [p for p in parts if p not in ORDER]
    rule("every section names a known part", not unknown, ", ".join(map(str, unknown)))
    rule("no part twice", len(parts) == len(set(parts)))
    known = [p for p in parts if p in ORDER]
    rule("parts in the fixed order", known == sorted(known, key=ORDER.index), " > ".join(known))
    needed = REQUIRED | ({"decided"} if owner else set())
    missing = sorted(needed - set(parts), key=ORDER.index)
    rule("required parts present", not missing, "missing: " + ", ".join(missing) if missing else "")
    by = {s.attrs.get("data-part"): s for s in sections}
    for part, section in by.items():
        if part in ORDER:
            rule(f"{part}: has an h2 and content", section.find(lambda n: n.tag == "h2") and any(
                n.tag != "h2" and n.all_text().strip() for n in section.children))

    if "changes" in by:
        s = by["changes"]
        rule("changes: bullets or cards", s.find(lambda n: n.tag in ("ul", "ol")) or any(
            len(g.find(lambda n: "card" in n.classes())) >= 2 for g in s.find(lambda n: "grid" in n.classes())))
        exhibits = s.find(lambda n: "exhibit" in n.classes())
        rule("changes: exactly one example (.exhibit)", len(exhibits) == 1)
        rule("changes: the example has content", any(
            n.all_text().strip() or n.find(lambda c: c.tag == "img") for n in exhibits))
    if "checks" in by:
        heads = [h.all_text().strip().lower() for h in by["checks"].find(lambda n: n.tag == "th")]
        rule("checks: a Check | Result table", heads[:2] == ["check", "result"], " | ".join(heads))
    if "next" in by:
        rule("next: numbered steps", by["next"].find(lambda n: n.tag == "ol"))
    if "opinion" in by:
        rule("opinion: in an .opinion block", by["opinion"].find(lambda n: "opinion" in n.classes()))

    footers = root.find(lambda n: n.tag == "footer")
    rule("footer names its writer", footers and words(footers[0].all_text()) >= 4)
    rule("footer points to the evidence (a link or a code reference)", footers and footers[0].find(
        lambda n: (n.tag == "a" and n.attrs.get("href", "").strip()) or n.tag == "code"))

    tables = root.find(lambda n: n.tag == "table")
    unwrapped = 0
    for t in tables:
        p = t.parent
        while p is not None and "table-wrap" not in p.classes():
            p = p.parent
        unwrapped += p is None
    rule("every table in a .table-wrap", unwrapped == 0, f"{unwrapped} unwrapped")

    rule("tokens on :root", re.search(r":root\s*\{[^}]*--ink", css))
    dark_only = re.search(r":root\s*\{[^}]*color-scheme:\s*dark", css) and "data-theme" not in css and "prefers-color-scheme" not in css
    rule("a dark theme: one dark theme by choice, or dark by preference and by attribute", dark_only or (
         "prefers-color-scheme: dark" in css and ':root:not([data-theme="light"])' in css and ':root[data-theme="dark"]' in css))
    rule("body has its own background", re.search(r"body\s*\{[^}]*background", css))
    rule(f"one column of at most {MAX_COLUMN}px", (m := re.search(r"main\s*\{[^}]*max-width:\s*(\d+)px", css)) and int(m.group(1)) <= MAX_COLUMN)

    links = [n.attrs.get("href", "") for n in root.find(lambda n: n.tag == "link" and n.attrs.get("rel") == "stylesheet")]
    rule("stylesheets only from Google Fonts", all(h.startswith(STYLESHEET_HOSTS) for h in links), ", ".join(links))
    rule("no scripts or event handlers", not root.find(lambda n: n.tag == "script" or any(
        k.lower().startswith("on") or v.strip().lower().startswith("javascript:") for k, v in n.attrs.items())))

    body = root.find(lambda n: n.tag == "main")
    body_text = body[0].all_text() if body else root.all_text()
    footer_text = footers[0].all_text() if footers else ""
    count = words(body_text)
    rule(f"at most {MAX_WORDS} words", count <= MAX_WORDS, f"{count} words")
    rule("no run ids outside the footer", not RUN_ID.search(body_text.replace(footer_text, "")))
    raw = html.unescape(source)
    rule("no credential-shaped strings", not SECRET.search(raw))
    rule("no home-folder or session paths", not HOME_PATH.search(raw), (HOME_PATH.search(raw) or [""])[0])
    rule("no template placeholders left", not re.search(
        r"Two To Four Words|Project · Epic N|What is different now|A bold opening phrase|The one-line result in bold|Who asked, what hurt|For Dana|example\.webp|Written by …", raw))
    return results


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1 or any(a not in ("--owner",) for a in argv[1:] if a.startswith("--")):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(args[0], encoding="utf-8") as fh:
        results = check(fh.read(), "--owner" in argv)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    failed = sum(not ok for _, ok, _ in results)
    print(f"{len(results) - failed} PASS, {failed} FAIL")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
