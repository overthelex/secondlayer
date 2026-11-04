"""HTML body for the MCP key-usage alert mail (scripts/mcp-key-usage-alert.sh).

The report is psql -H output (already HTML-escaped tables) interleaved with plain
marker lines from the shell scripts; this turns the markers into headings, escapes
every other plain line, and inlines table styles so mail clients keep the layout.
"""
import html
import re

TABLE_STYLE = "border-collapse:collapse;margin:4px 0 14px;font:12px/1.35 Menlo,Consolas,monospace"
CELL_STYLE = "border:1px solid #c8c8c8;padding:3px 7px;text-align:left;vertical-align:top;white-space:nowrap"
TH_STYLE = CELL_STYLE + ";background:#f0f0f0;font-weight:600"


def _style_tables(fragment: str) -> str:
    fragment = re.sub(r"<table[^>]*>", f'<table style="{TABLE_STYLE}">', fragment)
    fragment = re.sub(r'<th align="[a-z]+">|<th>', f'<th style="{TH_STYLE}">', fragment)
    fragment = re.sub(r'<td align="(right|left|center)">',
                      lambda m: f'<td style="{CELL_STYLE};text-align:{m.group(1)}">', fragment)
    return fragment.replace("<td>", f'<td style="{CELL_STYLE}">')


def render_html(subject: str, intro: str, body: str) -> str:
    out = []
    for line in body.splitlines():
        s = line.strip()
        if not s:
            continue
        if m := re.fullmatch(r"#{4,}\s*(.*?)\s*#{4,}", s):
            out.append(f'<h2 style="margin:22px 0 6px;padding-top:10px;border-top:2px solid #333;'
                       f'font:600 16px sans-serif">{html.escape(m.group(1))}</h2>')
        elif m := re.fullmatch(r"===\s*(.*?)\s*===", s):
            out.append(f'<p style="margin:8px 0;font:600 13px sans-serif;color:#444">{html.escape(m.group(1))}</p>')
        elif m := re.fullmatch(r"---\s*(.*?)\s*---", s):
            out.append(f'<h3 style="margin:12px 0 2px;font:600 13px sans-serif">{html.escape(m.group(1))}</h3>')
        elif s.startswith("<"):
            out.append(line)  # psql -H markup, cells already escaped
        else:
            out.append(f'<p style="margin:2px 0;font:13px sans-serif;color:#b00020">{html.escape(s)}</p>')
    intro_html = "<br>".join(html.escape(l) for l in intro.splitlines())
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        f"<title>{html.escape(subject)}</title></head>"
        '<body style="margin:0;padding:16px;background:#fff;color:#111">'
        f'<p style="font:14px/1.45 sans-serif;margin:0 0 10px">{intro_html}</p>'
        f'<div style="overflow-x:auto">{_style_tables(chr(10).join(out))}</div>'
        "</body></html>"
    )
