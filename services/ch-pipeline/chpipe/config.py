"""Settings, all from the environment so the same code runs under supervise.

Defaults are sized for the prod box: 8 cores shared with live traffic, so CPU
stages get 3 workers at nice 10, OCR gets 2 at nice 19, and the HTTP stages
are I/O bound and can afford more. See chpipe/throttle.py for what each stage
actually does with these.

CHPIPE_CPU_WORKERS above 3 buys nothing. `extract` spends about 50 ms per
document inside pdftotext -- a subprocess, so the GIL is released -- and
about 28 ms in pure Python (lxml text extraction, control-character
stripping, tokenising, scoring), which holds it. The GIL-held portion is the
ceiling: at 3 workers throughput is already ~36 documents/second against an
ideal of ~38. A fourth worker adds contention and roughly nothing else.
CHPIPE_HTTP_CONCURRENCY is the lever that actually moves the wall clock.
"""
from __future__ import annotations

import os
import pathlib
from dataclasses import dataclass


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
            load_ceiling=float(os.environ.get("CHPIPE_LOAD_CEILING", "6.0")),
            max_attempts=int(os.environ.get("CHPIPE_MAX_ATTEMPTS", "3")),
            retry_backoff_minutes=_backoff(
                os.environ.get("CHPIPE_RETRY_BACKOFF_MINUTES")),
            keep_raw_pdf=os.environ.get("CHPIPE_KEEP_RAW_PDF", "") not in ("", "0"),
        )
