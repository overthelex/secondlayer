import gzip
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
