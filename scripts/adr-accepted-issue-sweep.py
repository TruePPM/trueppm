#!/usr/bin/env python3
"""Find open issues whose scope may predate the ADR they name.

Run this when an ADR moves to **Accepted** — it is the mechanical half of the
checklist line in `.claude/skills/architect/SKILL.md` ("When an ADR moves to
Accepted"). It is deliberately NOT a CI gate: it cannot tell a genuine divergence
from an issue that legitimately implements one section of an ADR, and an advisory
gate that fires on every pipeline gets muted (#3271, rule 300(c)).

The delta between "the issue that proposed it" and "the ADR that settled it" is
exactly the set of REJECTED options — the most expensive thing to accidentally
implement. Nothing else in the pipeline reads an issue body against an ADR.

Usage:
    python3 scripts/adr-accepted-issue-sweep.py                 # whole corpus
    python3 scripts/adr-accepted-issue-sweep.py --adr 942       # one ADR
    python3 scripts/adr-accepted-issue-sweep.py --since 2026-06-29
    python3 scripts/adr-accepted-issue-sweep.py --show-unrankable

Exit status is always 0. This reports; a human decides.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from glob import glob

PROJECT = "trueppm%2Ftrueppm"
ADR_REF = re.compile(r"ADR-(\d{3,4})")
STATUS_SECTION = re.compile(r"^##\s*Status\s*$(.*?)(?=^##\s|\Z)", re.M | re.S)
ACCEPTED = re.compile(r"\bAccepted\b|\bRATIFIED\b", re.I)
DATE = re.compile(r"(20\d\d-\d\d-\d\d)")

# A Status date is NOT always an acceptance date. Three bulk audit sweeps
# (2026-06-30, 2026-07-29, 2026-08-02) rewrote 81 of 314 Accepted ADRs to read
# "Accepted — implemented on main; status corrected <date> after ADR audit". Those
# ADRs were accepted, and usually implemented, long before the date they carry.
# Ranking an issue against a correction date produces a false positive every time:
# on the 0.4 corpus it inflated 2 real candidates to 40. This is the single thing
# a future automation of this check must not get wrong.
CORRECTION = re.compile(r"correct|audit|reconcil|back-?fill|restat", re.I)


def adr_index(root: str) -> dict[int, str]:
    out = {}
    for path in glob(os.path.join(root, "docs/adr/*.md")):
        m = re.match(r"(\d{4})-", os.path.basename(path))
        if m:
            out[int(m.group(1))] = path
    return out


def adr_status(path: str) -> tuple[str, str | None, bool, str]:
    """Return (state, date, date_is_correction, headline)."""
    text = open(path, encoding="utf-8", errors="replace").read()
    m = STATUS_SECTION.search(text)
    if not m:
        return ("UNPARSED", None, False, "")
    # Skip blockquote errata — they carry their own, later dates.
    stripped = (line.strip() for line in m.group(1).split("\n"))
    lines = [line for line in stripped if line and not line.startswith(">")]
    head = " ".join(lines[:2])[:240]
    if not ACCEPTED.search(head):
        return ("not-accepted", None, False, head)
    d = DATE.search(head)
    return ("Accepted", d.group(1) if d else None, bool(CORRECTION.search(head)), head)


def open_issues() -> list[dict]:
    issues: list[dict] = []
    for page in range(1, 30):
        r = subprocess.run(
            [
                "glab",
                "api",
                f"projects/{PROJECT}/issues?state=opened&per_page=100&page={page}",
            ],
            capture_output=True,
            text=True,
        )
        try:
            batch = json.loads(r.stdout)
        except json.JSONDecodeError:
            break
        if not batch:
            break
        issues += batch
    return issues


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adr", type=int, help="only this ADR number")
    ap.add_argument(
        "--since", default=None, help="only ADRs accepted on/after YYYY-MM-DD"
    )
    ap.add_argument(
        "--show-unrankable",
        action="store_true",
        help="also list references to Accepted ADRs carrying no date",
    )
    args = ap.parse_args()

    root = (
        subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
        ).stdout.strip()
        or "."
    )
    adrs = adr_index(root)
    issues = open_issues()

    risk, suppressed, unrankable = [], [], []
    for issue in issues:
        blob = (issue.get("title") or "") + " " + (issue.get("description") or "")
        for n in sorted({int(x) for x in ADR_REF.findall(blob)}):
            if args.adr and n != args.adr:
                continue
            path = adrs.get(n)
            if not path:
                continue
            state, date, is_corr, head = adr_status(path)
            if state != "Accepted":
                continue
            created = issue["created_at"][:10]
            row = (
                issue["iid"],
                created,
                n,
                date,
                (issue.get("milestone") or {}).get("title"),
                (issue.get("title") or "")[:62],
            )
            if date is None:
                unrankable.append(row)
                continue
            if args.since and date < args.since:
                continue
            if created >= date:
                continue
            (suppressed if is_corr else risk).append(row)

    print(f"open issues scanned                 : {len(issues)}")
    print(
        f"suppressed (Status date is a bulk-audit CORRECTION, not acceptance) : {len(suppressed)}"
    )
    print(
        f"unrankable (Accepted ADR carries no date)                           : {len(unrankable)}"
    )
    print()
    print(f"REVIEW — open issue written BEFORE its ADR was accepted: {len(risk)}")
    for iid, created, n, date, ms, title in sorted(risk, key=lambda r: -r[0]):
        print(
            f"   #{iid:<6} created {created} | ADR-{n:04d} accepted {date} | ms={ms or '-':<5} | {title}"
        )
    if not risk:
        print("   (none — a zero here is a real outcome, record it)")

    if args.show_unrankable:
        print()
        print(
            f"--- unrankable: Accepted ADR with no date in its Status section ({len(unrankable)}) ---"
        )
        for iid, created, n, _d, ms, title in sorted(unrankable, key=lambda r: -r[0]):
            print(
                f"   #{iid:<6} created {created} | ADR-{n:04d} | ms={ms or '-':<5} | {title}"
            )

    print()
    print("Each row is a QUESTION, not a defect. Re-read the issue against the ADR's")
    print("rejected options; if it diverges, rewrite the TITLE as well as the body and")
    print("lead with a dated correction note. Check the branch first — in #3136 the")
    print("branch was right and the issue was wrong.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
