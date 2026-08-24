"""run-delta.sh's OK/FAILED marker, exercised as a real script.

The final gate's B2 asserted that the FAILED marker never reaches the log,
because the EXIT trap is armed INSIDE the `{ ... } >> "$LOG"` group and an
EXIT trap fires only once the redirection is torn down. That reasoning is
correct for a script WITHOUT `set -e` -- and run-delta.sh sets
`set -euo pipefail` on line 26, so a failing command inside the group makes
the shell exit from INSIDE it, with the redirection still live. Measured on
bash 3.2.57 and 5.3.0, across a failing payload, a missing
POSTGRES_PASSWORD line, a missing cd target and a signal-shaped exit 143:
the marker reached the log every time.

That is not a reason to leave the invariant untested. It was believed
broken by one review and believed sound by the code comment next to it,
with nothing in the suite able to settle it -- and a future edit that moves
the trap, drops `set -e`, or wraps the payload in an `if` would silently
restore exactly the failure B2 described. These tests run the shipped
script and read the log file.

`flock` and GNU `date -Is` are stubbed on PATH: neither exists on macOS,
and neither is the subject here -- the subject is which channel the marker
lands on. Everything else is the real script, byte for byte.
"""
import os
import pathlib
import shutil
import subprocess

import pytest

SCRIPT = pathlib.Path(__file__).parent.parent / "run-delta.sh"

BASH = shutil.which("bash")


def _harness(tmp_path, python_exit: int):
    """A tree run-delta.sh can actually run in, with LOG_DIR redirected."""
    home = tmp_path / "home"
    (home / "SecondLayer" / "deployment").mkdir(parents=True)
    (home / "SecondLayer" / "services" / "ch-pipeline").mkdir(parents=True)
    (home / "SecondLayer" / "deployment" / ".env.prod").write_text(
        "POSTGRES_PASSWORD=unused\n")

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    for name, body in (
            ("python3", f"#!/bin/sh\nexit {python_exit}\n"),
            # Stubbed, not exercised: see the module docstring.
            ("flock", "#!/bin/sh\nexit 0\n"),
            ("date", "#!/bin/sh\necho TIMESTAMP\n")):
        path = stub_bin / name
        path.write_text(body)
        path.chmod(0o755)

    log_dir = tmp_path / "logs"
    script = tmp_path / "run-delta.sh"
    script.write_text("\n".join(
        f"LOG_DIR={log_dir}" if line.startswith("LOG_DIR=") else line
        for line in SCRIPT.read_text().splitlines()) + "\n")

    env = dict(os.environ, HOME=str(home),
               PATH=f"{stub_bin}:{os.environ['PATH']}")
    proc = subprocess.run([BASH, str(script)], env=env,
                          capture_output=True, text=True, timeout=60)
    return proc, (log_dir / "delta.log").read_text()


@pytest.mark.skipif(BASH is None, reason="no bash on PATH")
def test_a_failing_run_writes_FAILED_with_its_exit_code_to_the_log(tmp_path):
    proc, log = _harness(tmp_path, python_exit=7)
    assert proc.returncode == 7
    assert "starting delta" in log
    assert "delta finished: FAILED (exit 7)" in log, log
    # The marker must be in the LOG, not on the channel cron discards.
    assert "FAILED" not in proc.stdout


@pytest.mark.skipif(BASH is None, reason="no bash on PATH")
def test_a_successful_run_writes_OK_to_the_log(tmp_path):
    proc, log = _harness(tmp_path, python_exit=0)
    assert proc.returncode == 0
    assert "delta finished: OK" in log, log
    assert "FAILED" not in log
    assert "OK" not in proc.stdout


@pytest.mark.skipif(BASH is None, reason="no bash on PATH")
def test_every_run_ends_on_exactly_one_marker(tmp_path):
    """Neither marker may be emitted twice, and never both: an operator
    reading `tail delta.log` decides whether last night was good from the
    last line alone."""
    for code in (0, 3):
        _, log = _harness(tmp_path / f"run{code}", python_exit=code)
        markers = [line for line in log.splitlines()
                   if "delta finished:" in line]
        assert len(markers) == 1, markers
