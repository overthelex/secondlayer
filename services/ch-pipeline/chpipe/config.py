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


def _budget_seconds(raw: str | None) -> float:
    """The wall-clock ceiling the nightly shab-detail pass stops at.

    Refused for the same values as _load_ceiling and for the same reason:
    the stage stops on `time.monotonic() - started > budget`, and every
    comparison against nan is False, so a budget of nan is no budget at all
    -- silently, with the setting still printed in the log. `inf` is that
    spelled honestly and is refused too, because "unbounded" is what the
    standalone backfill under tmux is for (shab_detail_stage.budget_seconds()
    reads "" that way); the nightly delta shares the box with live traffic.

    A negative budget is refused rather than clamped: it is not a way to ask
    for anything -- the loop checks the clock between batches, so it means
    "one batch a night" while looking like a duration. 0 says that outright
    and is allowed.
    """
    text = (raw or "").strip()
    if not text:
        return 5400.0
    value = float(text)
    if not math.isfinite(value) or value < 0:
        raise ValueError(
            f"CHPIPE_SHAB_BUDGET_SECONDS must be a finite number of seconds, "
            f"zero or more, got {raw!r}. nan and inf both disable the budget "
            "silently (the stage stops on a comparison that is never true); "
            "leave it unset for the 5400 s default.")
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
    # The nightly delta's budget for shab-detail (chpipe/delta.py's
    # run_registries): 90 minutes, so a 2.5M-row backlog fetched at
    # CHPIPE_SHAB_RPS=10 (~70 hours end to end) never turns the nightly cron
    # job into an unbounded run -- it takes its bite and stops, and tomorrow
    # picks the queue up where tonight left it (the queue IS
    # detail_fetched_at IS NULL, so there is nothing to resume explicitly).
    # This is a SEPARATE reading of CHPIPE_SHAB_BUDGET_SECONDS from
    # shab_detail_stage.budget_seconds(): that one treats "" as "no budget"
    # for a supervised backfill run under tmux, this one defaults to 5400
    # because the nightly delta must never run unbounded.
    shab_budget_seconds: float = 5400.0

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
            shab_budget_seconds=_budget_seconds(
                os.environ.get("CHPIPE_SHAB_BUDGET_SECONDS")),
        )
