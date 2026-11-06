"""Reader for the MR cost-ledger lines in a `## Gates` section.

scripts/cost-table.py is the only consumer. The line format has exactly one parser: the
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
    r"^\s*(?:[-*]\s*)?budget-exceeded:\s*(\d+)"
    r"(?:\s*\(\s*(" + _ROLE + r"\s+\d+(?:\s*,\s*" + _ROLE + r"\s+\d+)*)\s*\))?\s*$",
    re.I,
)
BUDGET_ROLE_RE = re.compile(r"(" + _ROLE + r")\s+(\d+)", re.I)
COSTISH_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(cost|turns|tokens|subagent-tokens|orchestrator-tokens|est-cost-usd|budget-exceeded|cost-ledger):",
    re.I,
)
# The only value the cost-ledger line takes; an MR with the ledger on writes no such line.
LEDGER_OFF_RE = re.compile(r"^\s*(?:[-*]\s*)?cost-ledger:\s*off\s*$", re.I)
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


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
                if h.group(2).strip().lower() == title:
                    level = lvl
                continue
            if lvl <= level:
                if h.group(2).strip().lower() == title:
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
