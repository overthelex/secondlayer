"""The second reader's page (PAPER-237): the gold test set, blind.

One reader wrote protocol v2 and labelled the gold set the judges were graded
on. A second reader labels the 33 test propositions on their own, against the
same eight passages the first reader and the judges saw (packet.json), with
protocol v2 verbatim as the guide and nothing of the first reader's or the
judges' labels on the page. The page is the labelling page (page/labels.html)
with the guide replaced by the protocol and the interface in English; it is
published as its own artifact, so its labels never mix with the first
reader's.

    python3 page_second.py --out labels_second.html
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE / "page" / "labels.html"
PROTOCOL = HERE / "protocol.md"
GOLD = HERE / "gold_set_2026-10-02.json"
PACKET = pathlib.Path("/data/ch-corpus/weko-bek/packet.json")
PROTOCOL_SHA = "00523dcf38f94632478051079684c0f1422c9e09f6c1fe60752d18a5b301dc19"


def inline(s: str) -> str:
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<i>\1</i>", s)
    return s


def md(text: str) -> str:
    """The protocol's markdown: headings, paragraphs, lists, quotes, emphasis."""
    out, para, items, kind = [], [], [], None

    def flush():
        nonlocal para, items, kind
        if para:
            out.append("<p>" + inline(" ".join(para)) + "</p>")
        if items:
            tag = "ol" if kind == "ol" else "ul"
            out.append(f"<{tag}>" + "".join("<li>" + inline(" ".join(i)) + "</li>" for i in items) + f"</{tag}>")
        para, items, kind = [], [], None

    quote = []
    for line in text.splitlines():
        if line.startswith(">"):
            flush()
            quote.append(line.lstrip("> ").rstrip())
            continue
        if quote:
            out.append('<p class="ex">' + inline(" ".join(quote)) + "</p>")
            quote = []
        m = re.match(r"^(#{1,4})\s+(.*)", line)
        if m:
            flush()
            n = len(m.group(1))
            out.append(f"<h{min(n + 1, 4)}>" + inline(m.group(2)) + f"</h{min(n + 1, 4)}>")
            continue
        m = re.match(r"^\s*(?:[-*]|(\d+)\.)\s+(.*)", line)
        if m:
            k = "ol" if m.group(1) else "ul"
            if para or (items and kind != k):
                flush()
            kind = k
            items.append([m.group(2)])
            continue
        if not line.strip():
            flush()
            continue
        if items and line.startswith("  "):
            items[-1].append(line.strip())
        else:
            if items:
                flush()
            para.append(line.strip())
    if quote:
        out.append('<p class="ex">' + inline(" ".join(quote)) + "</p>")
    flush()
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=pathlib.Path, required=True)
    args = ap.parse_args()
    protocol = PROTOCOL.read_text(encoding="utf-8")
    assert hashlib.sha256(protocol.encode()).hexdigest() == PROTOCOL_SHA, "protocol is not v2"

    test = [(r["version"], r["pid"]) for r in json.loads(GOLD.read_text())["labels"] if r["set"] == "test"]
    packet = {(p["version"], p["pid"]): p for p in json.loads(PACKET.read_text())}
    keep = ("version", "pid", "part", "heading", "lead", "text", "evidence")
    items = [{k: packet[t][k] for k in keep if k in packet[t]} for t in test]
    items.sort(key=lambda p: (p["version"], p["pid"]))
    for p in items:
        for e in p["evidence"]:
            for k in [k for k in e if k.startswith("judge") or k in ("label", "votes")]:
                del e[k]
    assert len(items) == 33

    page = TEMPLATE.read_text(encoding="utf-8")
    guide = ('<aside class="guide" id="guide" role="dialog" aria-label="Reading protocol">\n'
             '  <button class="btn close" id="guide-close">Close ✕</button>\n'
             '  <p><b>On this page.</b> Mark every passage that <i>applies</i> or <i>partially</i> applies the rule '
             'with “supports (applies / partial)”, then give the proposition one label with the buttons or keys '
             '<kbd>1</kbd>–<kbd>4</kbd>. A line of doubt goes in the note. Everything saves as you go.</p>\n'
             + md(protocol) + "\n</aside>")
    page, n = re.subn(r'<aside class="guide".*?</aside>', lambda _: guide, page, flags=re.S)
    assert n == 1
    swaps = [
        ('<button class="help-btn" id="help">Как размечать</button>', '<button class="help-btn" id="help">Protocol</button>'),
        ('<h1>Vertikalbekanntmachung — Befundprüfung</h1>', '<h1>Vertikalbekanntmachung — second reader</h1>'),
        ('<title>Vertikalbekanntmachung Audit</title>', '<title>VertBek Second Reader</title>'),
        ('{ v: "supported", de: "gestützt", hint: "Eine Behörde wendet den Satz als Regel an" }',
         '{ v: "supported", de: "supported", hint: "at least one passage applies the rule" }'),
        ('{ v: "fragment", de: "Bruchstück", hint: "Nur ein Teil, beiläufig oder zitiert ohne Anwendung" }',
         '{ v: "fragment", de: "fragment", hint: "none applies, at least one partially" }'),
        ('{ v: "absent", de: "nicht belegt", hint: "Im Bestand nichts dazu" }',
         '{ v: "absent", de: "absent", hint: "all passages unrelated or contradicting" }'),
        ('{ v: "recites", de: "nur zitiert", hint: "Der Bestand wiederholt den Satz, wendet ihn aber nicht an" }',
         '{ v: "recites", de: "recites", hint: "none applies or partially, at least one recites" }'),
        ('(on ? "stützt den Satz ✓" : "stützt den Satz")', '(on ? "supports (applies / partial) ✓" : "supports (applies / partial)")'),
        ('" Sätze zum Lesen, je acht Fundstellen; die Richter erscheinen nach Ihrer Bewertung"',
         '" propositions, eight passages each"'),
        ('"Gespeichert: " + snap.size + " Bewertungen. Tasten: 1 gestützt, 2 Bruchstück, 3 nicht belegt, 4 nur zitiert, j/k blättern."',
         '"Saved: " + snap.size + " labels. Keys: 1 supported, 2 fragment, 3 absent, 4 recites, j/k next/previous."'),
        ('placeholder="Begründung, Fundstelle, Zweifel — optional"', 'placeholder="Reason, passage, doubt (optional)"'),
        ('localStorage.getItem("vb-guide-seen-v2")', 'localStorage.getItem("vb-second-guide-seen")'),
        ('localStorage.setItem("vb-guide-seen-v2", "1")', 'localStorage.setItem("vb-second-guide-seen", "1")'),
    ]
    for a, b in swaps:
        assert page.count(a) == 1, a
        page = page.replace(a, b)
    data = json.dumps(items, ensure_ascii=False).replace("</", "<\\/")
    assert page.count("__PACKET__") == 1
    page = page.replace("__PACKET__", data)
    args.out.write_text(page, encoding="utf-8")
    print(f"{len(items)} propositions, {sum(len(p['evidence']) for p in items)} passages -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
