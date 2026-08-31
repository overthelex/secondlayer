"""reextract-citations.sh's spider-argument guard, exercised as a real script.

The argument is interpolated into the reset statement's SQL literal (psql -c,
not a bound parameter), so what the guard accepts is the whole of what stands
between an operator's typo and an injection. It is therefore tested by running
the shipped script, the way tests/test_run_delta_sh.py does, rather than by
re-implementing the pattern in Python and asserting about that.

The multiline case is the one worth having a test for. `grep -Eq '^...$'`
validates PER LINE: given "CH_BGer\\nDROP TABLE ...", grep finds a line that
matches and reports success, and the rest of the argument rides along into the
SQL. bash's own `[[ =~ ]]` matches against the whole string, where `$` is the
end of the string and the character class cannot span the newline.

The guard is the first thing the script does -- before the `cd`, before it
reads deployment/.env.prod, before psql -- so a rejected run needs no harness
at all. An ACCEPTED value gets past the guard and then fails on the missing
prod environment, which is why these tests assert on the refusal message
rather than on the exit status alone.
"""
import pathlib
import shutil
import subprocess

import pytest

SCRIPT = pathlib.Path(__file__).parent.parent / "scripts" / "reextract-citations.sh"
BASH = shutil.which("bash")

REFUSAL = "refusing spider name"

pytestmark = pytest.mark.skipif(BASH is None, reason="no bash on PATH")


def _run(*args, tmp_path=None):
    """The script, with HOME pointed somewhere empty so an accepted argument
    cannot reach a real deployment/.env.prod."""
    return subprocess.run([BASH, str(SCRIPT), *args], capture_output=True,
                          text=True, timeout=60,
                          env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)})


@pytest.mark.parametrize("spider", [
    "A;DROP TABLE ch_case_citations",
    "CH_BGer'",
    "' OR '1'='1",
    "a b",
    "CH-BGer",
    # The finding: a first line that passes, and a second line that does not.
    # grep validates per line and lets this through; the whole argument is
    # what ends up inside the SQL literal.
    "CH_BGer\nDROP TABLE ch_case_citations",
    "CH_BGer\n' OR '1'='1",
])
def test_a_spider_name_that_is_not_one_word_is_refused(spider, tmp_path):
    proc = _run(spider, tmp_path=tmp_path)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert REFUSAL in proc.stderr


def test_a_real_spider_name_gets_past_the_guard(tmp_path):
    """The guard must not be so tight that it refuses the names the corpus
    actually uses. It does not run to completion here -- HOME has no
    deployment/.env.prod -- but it must not be refused as malformed."""
    proc = _run("CH_BGer", tmp_path=tmp_path)
    assert REFUSAL not in proc.stderr


def test_no_argument_at_all_is_the_whole_corpus_and_not_a_refusal(tmp_path):
    proc = _run(tmp_path=tmp_path)
    assert REFUSAL not in proc.stderr
