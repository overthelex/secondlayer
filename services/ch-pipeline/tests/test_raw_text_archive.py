import gzip
import os
import stat
import zlib
import pathlib

import pytest

from chpipe.raw_text_archive import load, path_for, save, sha256_of


def test_save_then_load_roundtrip(tmp_path):
    sha = save(tmp_path / "raw", "CH_BVGer", "A-1_2020", "raw text ä")
    assert load(tmp_path / "raw", "CH_BVGer", "A-1_2020") == "raw text ä"
    assert path_for(tmp_path / "raw", "CH_BVGer", "A-1_2020") == (
        tmp_path / "raw-text" / "CH_BVGer" / "A-1_2020.txt.gz")
    assert sha == sha256_of("raw text ä")


def test_save_does_not_overwrite_different_existing(tmp_path):
    save(tmp_path / "raw", "S", "d", "first")
    with pytest.raises(FileExistsError):
        save(tmp_path / "raw", "S", "d", "second")
    assert load(tmp_path / "raw", "S", "d") == "first"


def test_save_same_content_is_noop(tmp_path):
    save(tmp_path / "raw", "S", "d", "same")
    p = path_for(tmp_path / "raw", "S", "d")
    before = p.stat().st_mtime_ns
    assert save(tmp_path / "raw", "S", "d", "same") == sha256_of("same")
    assert p.stat().st_mtime_ns == before


def test_no_temp_files_left(tmp_path):
    save(tmp_path / "raw", "S", "d", "x")
    assert [f.name for f in (tmp_path / "raw-text" / "S").iterdir()] == ["d.txt.gz"]


def test_unicode_doc_id(tmp_path):
    save(tmp_path / "raw", "CH_EDÖB", "CH_EDÖB_999", "t")
    assert load(tmp_path / "raw", "CH_EDÖB", "CH_EDÖB_999") == "t"


@pytest.mark.parametrize("doc_id", ["../x", "a/b", "..", "x\n"])
def test_unsafe_doc_id_rejected(tmp_path, doc_id):
    with pytest.raises(ValueError):
        save(tmp_path / "raw", "S", doc_id, "x")
    assert not (tmp_path / "raw-text").exists() or not any(
        (tmp_path / "raw-text").rglob("*.gz"))


def test_unsafe_spider_rejected(tmp_path):
    with pytest.raises(ValueError):
        path_for(tmp_path / "raw", "../S", "d")


def test_content_is_gzip(tmp_path):
    save(tmp_path / "raw", "S", "d", "hello")
    with gzip.open(path_for(tmp_path / "raw", "S", "d"), "rt", encoding="utf-8") as f:
        assert f.read() == "hello"


def test_corrupt_existing_archive_raises_and_is_untouched(tmp_path):
    save(tmp_path / "raw", "S", "d", "hello world " * 100)
    p = path_for(tmp_path / "raw", "S", "d")
    truncated = p.read_bytes()[:-10]
    p.write_bytes(truncated)
    with pytest.raises((EOFError, OSError, zlib.error, UnicodeDecodeError)):
        save(tmp_path / "raw", "S", "d", "hello world " * 100)
    assert p.read_bytes() == truncated
    assert [f.name for f in p.parent.iterdir()] == ["d.txt.gz"]


def test_failure_mid_write_leaves_nothing(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise OSError("disk gone")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        save(tmp_path / "raw", "S", "d", "x")
    d = tmp_path / "raw-text" / "S"
    assert not path_for(tmp_path / "raw", "S", "d").exists()
    assert list(d.iterdir()) == []


def test_archive_mode_is_0644(tmp_path):
    save(tmp_path / "raw", "S", "d", "x")
    assert stat.S_IMODE(path_for(tmp_path / "raw", "S", "d").stat().st_mode) == 0o644
