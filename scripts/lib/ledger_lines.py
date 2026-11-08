"""Reader for the MR cost-ledger lines in a `## Gates` section.

Its consumers are scripts/cost-table.py and scripts/mr-cost-means.py (the /kaizen cost reader, .claude/skills/kaizen § 1g;
per-MR cost comes from the windowed records there, only subagent-tokens: is read from the description). The line format has exactly one parser: the
regexes below, applied to the `## Gates` section outside code fences. Keep them in step with
what `.claude/skills/mr/SKILL.md` tells an agent to write.
"""

import collections
import re

GATE_PREFIX_RE = re.compile(r"^\s*(?:[-*]\s*)?gate:", re.I)
SUBAGENT_TOKENS_RE = re.compile(r"^\s*(?:[-*]\s*)?subagent-tokens:\s*(\d+)\s*$", re.I)
# A list-price ESTIMATE on its own line, never mixed with a billed-cost figure.
EST_COST_RE = re.compile(
    r"^\s*(?:[-*]\s*)?est-cost-usd:\s*(\d+(?:\.\d+)?)(?:\s*\(prices\s+\d{4}-\d{2}-\d{2}\))?\s*$",
    re.I,
)
ORCH_TOKENS_RE = re.compile(r"^\s*(?:[-*]\s*)?orchestrator-tokens:\s*(\d+)\s*$", re.I)
_ROLE = r"(?:implementer|gate|completeness-check)"
BUDGET_RE = re.compile(
    r"^\s*(?:[-*]\s*)?budget-exceeded:\s*([0-9]{1,18})"
    r"(?:\s*\(\s*("
    + _ROLE
    + r"\s+[0-9]{1,18}(?:\s*,\s*"
    + _ROLE
    + r"\s+[0-9]{1,18})*)\s*\))?\s*$",
    re.I,
)
# ASCII digits, at most 18: `\d` also matches other scripts' digits, and int() raises past 4,300.
BUDGET_ROLE_RE = re.compile(r"(" + _ROLE + r")\s+([0-9]{1,18})", re.I)
COSTISH_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(cost|turns|tokens|subagent-tokens|orchestrator-tokens|est-cost-usd|budget-exceeded|cost-ledger):",
    re.I,
)
# The only value the cost-ledger line takes; an MR with the ledger on writes no such line.
LEDGER_OFF_RE = re.compile(r"^\s*(?:[-*]\s*)?cost-ledger:\s*off\s*$", re.I)
# Linear on purpose: `^(#{1,6})\s+(.*?)\s*#*\s*$` backtracks cubically on a heading padded with
# spaces, and an MR description is user-written. The closing `#`s are stripped in heading_title().
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


def heading_title(m):
    """The lowercased title of a HEADING_RE match, closing `#`s and spaces stripped."""
    return m.group(2).rstrip(" \t#").strip().lower()


def section_lines(body, title="gates"):
    """Yield only the lines of the `## <title>` section, outside code fences.

    Reading the whole description let an MR that quotes the /mr template (in a fence or a
    Notes section) create phantom ledger lines, so only the real section counts.
    """
    level, in_fence = None, False
    for line in (body or "").splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        h = HEADING_RE.match(line)
        if h:
            lvl = len(h.group(1))
            if level is None:
                if heading_title(h) == title:
                    level = lvl
                continue
            if lvl <= level:
                if heading_title(h) == title:
                    level = lvl
                    continue
                level = None
                continue
        if level is not None:
            yield line


def ledger_lines(body):
    return section_lines(body, "gates")


def budget_line(line):
    """(total, {role: k}) for a well-formed `budget-exceeded:` line, False when the per-role
    counts do not sum to the total, None when it is not such a line."""
    b = BUDGET_RE.match(line)
    if not b:
        return None
    total, roles = int(b.group(1)), collections.Counter()
    for role, k in BUDGET_ROLE_RE.findall(b.group(2) or ""):
        roles[role.lower()] += int(k)
    if b.group(2) and sum(roles.values()) != total:
        return False
    return total, roles


def budget_exceeded(body):
    """The MR's (`budget-exceeded:` total, role split), or None when the ledger has no
    well-formed line. A malformed line is never counted; a second line is ignored (first
    kept), so one MR cannot be counted twice."""
    for line in ledger_lines(body):
        b = budget_line(line)
        if b is not None:
            return b or None
    return None


def subagent_tokens(body):
    """The first well-formed `subagent-tokens:` value, or None."""
    for line in ledger_lines(body):
        m = SUBAGENT_TOKENS_RE.match(line)
        if m:
            return int(m.group(1))
    return None


def est_cost_usd(body):
    """The first well-formed `est-cost-usd:` value in USD (a list-price estimate), or None."""
    for line in ledger_lines(body):
        m = EST_COST_RE.match(line)
        if m:
            return float(m.group(1))
    return None


def orchestrator_tokens(body):
    """The first well-formed `orchestrator-tokens:` value, or None."""
    for line in ledger_lines(body):
        m = ORCH_TOKENS_RE.match(line)
        if m:
            return int(m.group(1))
    return None


def _self_test():
    import sys
    import time

    fails = []

    def check(name, ok):
        if not ok:
            fails.append(name)

    def wrap(*lines):
        return "## Gates\n" + "\n".join(lines) + "\n"

    check("subagent-tokens read", subagent_tokens(wrap("subagent-tokens: 7")) == 7)
    check(
        "est-cost-usd read",
        est_cost_usd(wrap("est-cost-usd: 1.50 (prices 2026-11-01)")) == 1.5,
    )
    check(
        "orchestrator-tokens read",
        orchestrator_tokens(wrap("orchestrator-tokens: 9")) == 9,
    )
    check(
        "a line outside ## Gates is ignored",
        subagent_tokens("## Notes\nsubagent-tokens: 7\n") is None,
    )
    check(
        "a fenced line is ignored",
        subagent_tokens("## Gates\n```\nsubagent-tokens: 7\n```\n") is None,
    )
    check(
        "first of two lines wins",
        subagent_tokens(wrap("subagent-tokens: 1", "subagent-tokens: 2")) == 1,
    )
    check(
        "budget with roles",
        budget_exceeded(wrap("budget-exceeded: 3 (implementer 2, gate 1)"))[0] == 3,
    )
    check(
        "budget role split mismatch is dropped",
        budget_exceeded(wrap("budget-exceeded: 3 (gate 1)")) is None,
    )
    check(
        "budget 5000 digits is None, not a crash",
        budget_exceeded(wrap("budget-exceeded: " + "9" * 5000)) is None,
    )
    check(
        "budget role 5000 digits is None",
        budget_exceeded(wrap("budget-exceeded: 1 (gate " + "9" * 5000 + ")")) is None,
    )
    check(
        "budget non-ASCII digits are None",
        budget_exceeded(wrap("budget-exceeded: \u0663\u0663")) is None,
    )
    check(
        "cost-ledger: off marker",
        any(LEDGER_OFF_RE.match(ln) for ln in ledger_lines(wrap("cost-ledger: off"))),
    )
    t0 = time.time()
    padded = (
        "## Gates"
        + " " * 20000
        + "x\n# a"
        + " " * 20000
        + "b\n## Gates ##\nsubagent-tokens: 7\n"
    )
    got = subagent_tokens(padded)
    check("a heading padded with 20k spaces reads in under 1s", time.time() - t0 < 1)
    check("a closed ATX heading (`## Gates ##`) still opens the section", got == 7)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("ledger_lines self-test OK")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(_self_test() if sys.argv[1:] == ["--self-test"] else 2)
