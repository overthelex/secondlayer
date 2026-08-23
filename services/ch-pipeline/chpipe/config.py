"""Settings, all from the environment so the same code runs under supervise.

Defaults are sized for the prod box: 8 cores shared with live traffic, so CPU
stages get 3 workers, OCR gets 2 at nice 19, and the HTTP stages are I/O bound
and can afford more.
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
        )
