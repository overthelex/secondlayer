#!/usr/bin/env python3
"""Postgres access for the Polish corpus scripts: read worklists, COPY rows in.

Prod Postgres has no public listener, so everything goes through
ssh -> docker exec -i secondlayer-postgres-prod psql, the same route
services/opendata-importers/shared/prod_writer.py and scripts/nl/harvest_bwb_texts.py
take. Set PL_SSH_HOST="" when running ON the prod host to drop the ssh hop.

Why this is not prod_writer.copy_into. That helper's _escape_copy maps newline
to a space:

    .replace("\\t", " ").replace("\\n", " ").replace("\\r", " ")

which is right for the metadata rows it was written for and wrong for statute
text: a Polish article is a stack of numbered paragraphs, and flattening it to
one line destroys the structure that makes "art. 415 § 1" addressable at all.
esc() below emits a literal backslash-n instead, which COPY ... FORMAT text
decodes back into a real newline - the escaping scripts/nl/harvest_bwb_texts.py
already uses for the same reason.
"""
import os
import shlex
import subprocess

SSH_HOST = os.environ.get("PL_SSH_HOST", "prod")
CONTAINER = os.environ.get("PG_CONTAINER", "secondlayer-postgres-prod")
DB_USER = os.environ.get("PG_USER", "secondlayer")
DB_NAME = os.environ.get("PG_DB", "secondlayer_prod")
PSQL_TIMEOUT = int(os.environ.get("PSQL_TIMEOUT", "1800"))


def _argv(extra=()):
    """argv for psql, optionally through ssh.

    extra must be passed in here rather than appended by the caller: over ssh
    the whole remote command is one string handed to a remote shell, so an
    argument containing spaces or parentheses - every "-c COPY t (a, b) FROM
    STDIN" - has to be quoted before it is joined. Appending to the returned
    list works locally and produces a remote bash syntax error.
    """
    inner = ["docker", "exec", "-i", CONTAINER,
             "psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1",
             *extra]
    if not SSH_HOST:
        return inner
    return ["ssh", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30",
            SSH_HOST, " ".join(shlex.quote(a) for a in inner)]


def psql(sql, stdin=None):
    r = subprocess.run(_argv(["-c", sql]), input=stdin,
                       capture_output=True, text=True, timeout=PSQL_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[:600]}")
    return r.stdout


def esc(v):
    r"""One cell for COPY ... WITH (FORMAT text).

    Newlines become the two-character sequence \n, which COPY turns back into a
    newline on load - unlike replacing them with spaces, which is lossy.
    Booleans are emitted as t/f, which is what COPY expects.
    """
    if v is None:
        return r"\N"
    if isinstance(v, bool):
        return "t" if v else "f"
    # An empty string is NOT null here, unlike in prod_writer._escape_copy.
    # A repealed article legitimately has no body - the Kodeks pracy carries
    # "Art. 266-280." as a single unit covering a repealed span, with a heading
    # and nothing else - and mapping that to NULL both loses the distinction
    # between "repealed" and "we failed to extract it" and violates the NOT NULL
    # on pl_act_articles.text.
    return (str(v).replace("\\", "\\\\")
                  .replace("\t", "\\t")
                  .replace("\n", "\\n")
                  .replace("\r", ""))


def copy_rows(table, columns, rows, batch=2000):
    """COPY rows into table. Returns the number of rows sent.

    Straight COPY, no ON CONFLICT: every caller in this corpus writes to a table
    whose worklist is an anti-join, so a row is only produced when it is not
    already there. Upserting is sync_eli_changes.py's job and it stages
    explicitly.
    """
    rows = list(rows)
    if not rows:
        return 0
    col_sql = ", ".join(columns)
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        data = "".join("\t".join(esc(c) for c in r) + "\n" for r in chunk)
        r = subprocess.run(
            _argv(["-c", f"COPY {table} ({col_sql}) FROM STDIN WITH (FORMAT text)"]),
            input=data, capture_output=True, text=True, timeout=PSQL_TIMEOUT)
        if r.returncode != 0:
            raise RuntimeError(f"COPY into {table} failed: {r.stderr.strip()[:600]}")
    return len(rows)


def upsert_rows(table, columns, rows, pk_columns, prefer_new=True, batch=2000):
    """Stage into a TEMP table, then INSERT ... ON CONFLICT DO UPDATE.

    prefer_new uses COALESCE(EXCLUDED.col, table.col) so a re-fetch that
    populates a previously-NULL field fills it in without a fetch that returned
    less blanking what we already hold. That matters here: the source
    retroactively adds legalStatusDate to old obwieszczenia and flips textHTML
    true for acts published without HTML.
    """
    rows = list(rows)
    if not rows:
        return 0
    col_sql = ", ".join(columns)
    if prefer_new:
        sets = ", ".join(
            f"{c} = COALESCE(EXCLUDED.{c}, {table}.{c})"
            for c in columns if c not in pk_columns)
    else:
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in columns if c not in pk_columns)

    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        data = "".join("\t".join(esc(c) for c in r) + "\n" for r in chunk)
        # BEGIN/COMMIT is not decoration. psql autocommits each statement, so a
        # TEMP ... ON COMMIT DROP table is created and dropped before the COPY
        # on the next line can see it ("relation _stage does not exist"). The
        # explicit transaction also makes the batch atomic: a bad row aborts the
        # whole batch instead of leaving it half applied.
        #
        # The COPY data follows the script on the same stdin, terminated by \.,
        # which is how psql scripts feed COPY FROM STDIN.
        sql = (
            "BEGIN;\n"
            f"CREATE TEMP TABLE _stage (LIKE {table} INCLUDING DEFAULTS) ON COMMIT DROP;\n"
            f"COPY _stage ({col_sql}) FROM STDIN WITH (FORMAT text);\n")
        tail = (
            f"INSERT INTO {table} ({col_sql}) SELECT {col_sql} FROM _stage\n"
            f"  ON CONFLICT ({', '.join(pk_columns)}) DO UPDATE SET {sets};\n"
            "COMMIT;\n")
        r = subprocess.run(_argv(), input=sql + data + "\\.\n" + tail,
                           capture_output=True, text=True, timeout=PSQL_TIMEOUT)
        if r.returncode != 0:
            raise RuntimeError(f"upsert into {table} failed: {r.stderr.strip()[:600]}")
    return len(rows)


def rows_of(sql):
    """Run a COPY (...) TO STDOUT and yield tuples of raw strings.

    \\N comes back as None; the two-character \\n sequence is turned back into a
    newline, mirroring esc().
    """
    out = psql(f"COPY ({sql}) TO STDOUT WITH (FORMAT text)")
    for line in out.split("\n"):
        if not line:
            continue
        cells = []
        for c in line.split("\t"):
            cells.append(None if c == r"\N"
                         else c.replace("\\n", "\n").replace("\\t", "\t")
                               .replace("\\\\", "\\"))
        yield tuple(cells)


def scalar(sql):
    return psql(f"SELECT ({sql})").strip().splitlines()[2].strip()
