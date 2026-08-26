"""Print Gate F (chpipe.reports_cantonal) for one canton or all of them."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from .. import db, reports_cantonal
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class ReportsCantonalReport:
    rows: list[dict] = field(default_factory=list)
    text: str = ""


def run(settings: Settings, canton_code: str | None = None) -> ReportsCantonalReport:
    conn = db.connect(settings)
    try:
        rows = reports_cantonal.gate_f(conn, canton_code or None)
    finally:
        conn.close()
    return ReportsCantonalReport(rows=rows, text=reports_cantonal.format_gate_f(rows))


def main() -> ReportsCantonalReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. Read-only; no renice needed."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(), canton_code=os.environ.get("CHPIPE_CANTON") or None)
    print(result.text)
    return result


if __name__ == "__main__":
    main()
