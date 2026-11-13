"""Gzip archive of the raw (pre-clean) full_text of a decision.

The clean-text stage rewrites full_text in place, and for these rows the raw
text exists nowhere else (the PDFs were deleted after extraction). So every
row's raw text is saved here BEFORE its UPDATE. Layout, next to the raw dir:
<raw_dir.parent>/raw-text/<spider>/<doc_id>.txt.gz
"""
from __future__ import annotations

import gzip
import hashlib
import os
import pathlib
import tempfile

from .stages.fetch_stage import raw_path


def sha256_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def path_for(raw_dir: pathlib.Path, spider: str, doc_id: str) -> pathlib.Path:
    """Same \\w guard and resolve-based containment as fetch_stage.raw_path,
    so a doc_id such as '../x' can never leave the archive directory."""
    return raw_path(pathlib.Path(raw_dir).parent / "raw-text", spider, doc_id,
                    "txt.gz")


def load(raw_dir: pathlib.Path, spider: str, doc_id: str) -> str:
    with gzip.open(path_for(raw_dir, spider, doc_id), "rt", encoding="utf-8",
                   newline="") as f:
        return f.read()


def save(raw_dir: pathlib.Path, spider: str, doc_id: str, text: str) -> str:
    """Archive text crash-safely; return its sha256. An existing identical
    archive is left untouched; a different one raises FileExistsError (the
    first raw text is the only true one, never overwrite it).

    An existing archive that cannot be read raises EOFError (truncated
    gzip), gzip.BadGzipFile / OSError (not gzip), zlib.error (corrupt
    stream) or UnicodeDecodeError. All of these mean "existing archive
    unreadable": a hard failure, do not retry; the file is left untouched
    for an operator. ValueError means an unsafe spider/doc_id."""
    path = path_for(raw_dir, spider, doc_id)
    sha = sha256_of(text)
    if path.exists():
        if sha256_of(load(raw_dir, spider, doc_id)) == sha:
            return sha
        raise FileExistsError(f"raw-text archive differs: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".gz")
    try:
        with os.fdopen(fd, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
                gz.write(text.encode("utf-8"))
            raw.flush()
            os.fsync(raw.fileno())
        os.chmod(tmp, 0o644)  # mkstemp makes 0600; backup/app uid must read
        os.replace(tmp, path)
        dfd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dfd)  # make the rename itself durable
        finally:
            os.close(dfd)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return sha
