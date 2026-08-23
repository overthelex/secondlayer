import pathlib
import pytest
from chpipe.config import Settings


def test_from_env_reads_every_field(monkeypatch):
    monkeypatch.setenv("CHPIPE_DSN", "postgresql://u@h/db")
    monkeypatch.setenv("CHPIPE_RAW_DIR", "/data/ch-corpus/raw")
    monkeypatch.setenv("CHPIPE_HTTP_CONCURRENCY", "12")
    monkeypatch.setenv("CHPIPE_CPU_WORKERS", "3")
    monkeypatch.setenv("CHPIPE_OCR_WORKERS", "2")
    monkeypatch.setenv("CHPIPE_LOAD_CEILING", "6.0")
    s = Settings.from_env()
    assert s.dsn == "postgresql://u@h/db"
    assert s.raw_dir == pathlib.Path("/data/ch-corpus/raw")
    assert (s.http_concurrency, s.cpu_workers, s.ocr_workers) == (12, 3, 2)
    assert s.load_ceiling == 6.0
    assert s.max_attempts == 3


def test_dsn_is_required(monkeypatch):
    monkeypatch.delenv("CHPIPE_DSN", raising=False)
    with pytest.raises(RuntimeError, match="CHPIPE_DSN"):
        Settings.from_env()


def test_defaults_match_the_eight_core_prod_box(monkeypatch):
    monkeypatch.setenv("CHPIPE_DSN", "postgresql://u@h/db")
    for k in ("CHPIPE_HTTP_CONCURRENCY", "CHPIPE_CPU_WORKERS",
              "CHPIPE_OCR_WORKERS", "CHPIPE_LOAD_CEILING"):
        monkeypatch.delenv(k, raising=False)
    s = Settings.from_env()
    assert s.http_concurrency == 12
    assert s.cpu_workers == 3
    assert s.ocr_workers == 2
    assert s.load_ceiling == 6.0


def test_retry_backoff_defaults_to_the_spec_schedule(monkeypatch):
    """Spec section 8: 1 minute, then 5, then 30."""
    monkeypatch.setenv("CHPIPE_DSN", "postgresql://u@h/db")
    monkeypatch.delenv("CHPIPE_RETRY_BACKOFF_MINUTES", raising=False)
    assert Settings.from_env().retry_backoff_minutes == (1, 5, 30)


def test_retry_backoff_can_be_overridden(monkeypatch):
    monkeypatch.setenv("CHPIPE_DSN", "postgresql://u@h/db")
    monkeypatch.setenv("CHPIPE_RETRY_BACKOFF_MINUTES", "2,10")
    assert Settings.from_env().retry_backoff_minutes == (2, 10)


def test_retry_backoff_can_be_disabled(monkeypatch):
    """An explicit opt-out for a maintenance window, not the default."""
    monkeypatch.setenv("CHPIPE_DSN", "postgresql://u@h/db")
    monkeypatch.setenv("CHPIPE_RETRY_BACKOFF_MINUTES", "")
    assert Settings.from_env().retry_backoff_minutes == ()
