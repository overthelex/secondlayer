import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from chpipe.text_damage import markers


def test_markers_counts_glued_refs_and_hyphens():
    m = markers("werden.322 Zusammenschluss-\nvorhaben bestehen\n8\nfoo\nfoo\nfoo\n")
    assert m["glued_refs"] == 1
    assert m["hyphen_breaks"] == 1
    assert m["page_number_lines"] == 1
    assert m["repeated_lines"] == 1


def test_markers_ligatures_nbsp_replacement():
    m = markers("ﬁnanziaria x   �")
    assert (m["ligatures"], m["nbsp"], m["replacement_chars"]) == (1, 1, 1)


def test_markers_line_stats():
    m = markers("a" * 68 + "\n" + "b" * 300)
    assert m["mean_line_len"] == 184
    assert m["short_line_share"] == 0.0


def test_markers_empty():
    m = markers("")
    assert m["mean_line_len"] == 0.0 and m["short_line_share"] == 0.0


PROBE = Path(__file__).resolve().parent.parent / "scripts" / "text_damage_probe.py"
DSN = os.environ.get("CHPIPE_TEST_DSN")
SCHEMA = "probe_t"


@pytest.mark.skipif(not DSN, reason="CHPIPE_TEST_DSN not set")
def test_probe_make_sample_and_out(tmp_path):
    import psycopg

    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        c.execute(f"CREATE SCHEMA {SCHEMA}")
        c.execute(f"SET search_path TO {SCHEMA}")
        c.execute(
            "CREATE TABLE ch_court_decisions(doc_id text, spider text, text_source text,"
            " stage text, full_text text, text_quality text)"
        )
        c.execute(
            "CREATE TABLE ch_act_version(version_id text, source text, lang text,"
            " stage text, full_text text)"
        )
        for i in range(5):
            c.execute(
                "INSERT INTO ch_court_decisions VALUES (%s,'bger','pdf','loaded',%s,'ok')",
                (f"d{i}", "werden.322 Zusammenschluss-\nvorhaben\n8\n"),
            )
        for i, src in enumerate(["fedlex_pdf", "lexfind", "lexwork_pdf", "zhlex"] * 3):
            c.execute(
                "INSERT INTO ch_act_version VALUES (%s,%s,'de','parsed',%s)",
                (f"v{i}", src, "plain text\nline two\n"),
            )
    sep = "&" if "?" in DSN else "?"
    dsn = f"{DSN}{sep}options=-csearch_path%3D{SCHEMA}"
    try:
        sample = tmp_path / "s.json"
        out = tmp_path / "o.json"
        run = lambda *a: subprocess.run(
            [sys.executable, str(PROBE), "--dsn", dsn, *a],
            check=True, capture_output=True, text=True,
        )
        run("--make-sample", "100", "--sample-pct", "100", "--sample", str(sample))
        s = json.loads(sample.read_text())
        assert len(s["decisions"]) == 5 and len(s["editions"]) == 12
        r = run("--sample", str(sample), "--out", str(out))
        o = json.loads(out.read_text())
        assert o["aggregates"]["decisions:bger"]["share_nonzero"]["glued_refs"] == 1.0
        assert o["aggregates"]["editions:fedlex_pdf"]["n"] == 3
        assert "bger" in r.stdout
    finally:
        with psycopg.connect(DSN, autocommit=True) as c:
            c.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
