"""Being a good neighbour on a box that is also serving live traffic.

Two mechanisms, both from spec section 8:

  renice      static priority, set once at start-up. index and fetch run at
              nice 10 (I/O bound, but they still hold the GIL and a
              connection pool); ocr at nice 19, the lowest thing on the box;
              extract at nice 10, because it is the multi-hour CPU stage.
              The legislation stages take the same treatment: acts,
              versions, fetch-xml and project-legacy at NICE_IO, parse-akn
              and diff at NICE_CPU.

  wait_for_capacity
              dynamic backpressure: stop CLAIMING new work while the
              one-minute load average is at or above the ceiling. Renicing
              alone is not enough for a stage that will run for hours --
              nice only decides who wins a contended core, it does not stop
              three worker threads from filling every core in the first
              place.

Both were previously implemented inside ocr_stage and available nowhere
else, while the README claimed all stages were throttled. `extract` is the
one that most needed the ceiling: measured at ~17 CPU-hours for 800,000
documents, it occupies roughly 4 of 8 cores at cpu_workers=3 and it was
running at normal priority.

That defect then shipped a second time, on the legislation half: all six of
its stages ran at normal priority with no ceiling, `parse-akn` (12,033 lxml
parses) and `diff` (a corpus walk holding two article sets per comparison)
among them. Both of those now wait_for_capacity() before claiming, and all
six renice in main(). A stage added later belongs in that list too -- this
module exists because "it is only a few hours" was already wrong once.

renice() is deliberately called from each stage's main(), not from run().
os.nice() is irreversible for a non-root process, so a library function that
renices its own caller would permanently drag down anything that imports it
-- including the test suite, which is what the previous placement inside
ocr_stage.run() did.
"""
from __future__ import annotations

import logging
import os
import time

log = logging.getLogger(__name__)

PAUSE_SECONDS = 60

# Spec section 8. index/fetch are I/O bound; extract is the CPU stage; ocr is
# the heaviest thing here and yields to everything.
NICE_IO = 10
NICE_CPU = 10
NICE_OCR = 19


def renice(increment: int) -> None:
    """Lower this process's priority. Never raises: a box that will not let
    us renice is a reason to warn, not to refuse to do the work."""
    try:
        os.nice(increment)
    except (AttributeError, OSError):
        log.warning("could not renice by %d; this stage will compete with "
                    "live traffic at normal priority", increment)


def should_pause(load_ceiling: float, load1: float) -> bool:
    """A ceiling of 0 or less disables the guard -- an explicit opt-out for a
    maintenance window, not the default."""
    if load_ceiling <= 0:
        return False
    return load1 >= load_ceiling


def wait_for_capacity(load_ceiling: float, stage: str,
                      pause_seconds: int = PAUSE_SECONDS) -> None:
    """Block until the one-minute load average is under the ceiling.

    Called before claiming a batch, not before each document: the point is
    to stop taking on new work while the box is busy, while letting work
    already in flight finish rather than abandoning it half-done.
    """
    if load_ceiling <= 0:
        return
    while True:
        load1 = os.getloadavg()[0]
        if not should_pause(load_ceiling, load1):
            return
        log.info("%s: load %.2f >= %.2f, pausing %ds",
                 stage, load1, load_ceiling, pause_seconds)
        time.sleep(pause_seconds)
