"""Settings, all from the environment so the same code runs under supervise.

Defaults are sized for the prod box: 8 cores shared with live traffic, so CPU
stages get 3 workers at nice 10, OCR gets 2 at nice 19, and the HTTP stages
are I/O bound and can afford more. See chpipe/throttle.py for what each stage
actually does with these.

CHPIPE_CPU_WORKERS = 3 is a neighbourliness choice, not a throughput one.
Measured per document on the real PDF fixture (15 repeats): 58.82 ms inside
pdftotext, which is a subprocess and releases the GIL, and 18.78 ms of pure
Python that holds it (0.45 ms decode + control-character strip, 18.33 ms
text_quality.score). The GIL-held share caps extract at roughly 53
documents/second however many threads run, with the knee at about 4 workers
(~51/s) rather than 3 (~39/s) -- so a fourth worker would buy something, at
the cost of a core the box needs for live traffic. Raise it only in a window
where nothing else needs the machine.

Re-measure before changing it: the control-character fix moved the GIL-held
share from ~29 ms to 18.78 ms and shifted the knee from 3 workers to 4.
Anything that moves work between the two columns moves it again.
"""
from __future__ import annotations

import math
import os
import pathlib
from dataclasses import dataclass


def _load_ceiling(raw: str | None) -> float:
    """The one-minute load average at or above which a stage stops claiming.

    float() happily parses "nan", "inf" and "-inf", and nan is the dangerous
    one: every comparison against it is False, so throttle.should_pause()
    returns False for any load whatsoever and the guard is off -- silently,
    with the setting still printed in the log as though it were in effect.
    A stage set to nan then runs at full tilt on a box already at load 30.

    Rejected here rather than in throttle.py: throttle's contract ("0 or
    less disables the guard") is a real opt-out an operator may want, and
    the honest way to ask for it is 0, not a value that happens to defeat
    the comparison. Non-finite is a typo or a bad template, and a nightly
    job should refuse to start on one rather than quietly drop its guard.
    """
    value = float(raw) if raw is not None else 6.0
    if not math.isfinite(value):
        raise ValueError(
            f"CHPIPE_LOAD_CEILING must be a finite number, got {raw!r}. "
            "nan disables the load guard silently (every comparison against "
            "it is False); set 0 to disable it deliberately.")
    return value


def _backoff(raw: str | None) -> tuple[int, ...]:
    """"1,5,30" -> (1, 5, 30). An empty value means no wait at all."""
    if raw is None:
        return (1, 5, 30)
    return tuple(int(part) for part in raw.split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    dsn: str
    raw_dir: pathlib.Path
    http_concurrency: int
    cpu_workers: int
    ocr_workers: int
    load_ceiling: float
    max_attempts: int
    # Spec section 8: a failed row waits this many minutes before it is
    # offered again, indexed by attempt number. Set CHPIPE_RETRY_BACKOFF_MINUTES
    # to an empty string to disable the wait entirely (tests, and a
    # maintenance window where the source is known to be healthy).
    retry_backoff_minutes: tuple[int, ...] = (1, 5, 30)
    # Spec section 8: a PDF is deleted once its text has been extracted
    # successfully, EXCEPT when the quality was below the threshold or OCR
    # was involved -- those are kept for a possible second reading. Set
    # CHPIPE_KEEP_RAW_PDF=1 to keep everything, which is what Gate A wants
    # (the sample's PDFs have to survive for inspection) and what anyone
    # re-tuning the extractor wants, since the alternative is re-downloading
    # ~160 GB from a volunteer-run mirror.
    keep_raw_pdf: bool = False
    # Per-host concurrency for the cantonal (Lexwork) stages. 19 cantonal
    # hosts are 19 small government servers; http_concurrency is the global
    # cap across all of them, this is the cap on any one of them.
    cantonal_per_host: int = 2

    @classmethod
    def from_env(cls) -> "Settings":
        dsn = os.environ.get("CHPIPE_DSN", "")
        if not dsn:
            raise RuntimeError("CHPIPE_DSN is required")
        return cls(
            dsn=dsn,
            raw_dir=pathlib.Path(os.environ.get("CHPIPE_RAW_DIR", "/data/ch-corpus/raw")),
            http_concurrency=int(os.environ.get("CHPIPE_HTTP_CONCURRENCY", "12")),
            cpu_workers=int(os.environ.get("CHPIPE_CPU_WORKERS", "3")),
            ocr_workers=int(os.environ.get("CHPIPE_OCR_WORKERS", "2")),
            load_ceiling=_load_ceiling(os.environ.get("CHPIPE_LOAD_CEILING")),
            max_attempts=int(os.environ.get("CHPIPE_MAX_ATTEMPTS", "3")),
            retry_backoff_minutes=_backoff(
                os.environ.get("CHPIPE_RETRY_BACKOFF_MINUTES")),
            keep_raw_pdf=os.environ.get("CHPIPE_KEEP_RAW_PDF", "") not in ("", "0"),
            cantonal_per_host=int(os.environ.get("CHPIPE_CANTONAL_PER_HOST", "2")),
        )
