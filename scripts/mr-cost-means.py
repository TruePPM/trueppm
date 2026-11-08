#!/usr/bin/env python3
"""scripts/mr-cost-means.py - per-MR cost for /kaizen, from the windowed `## Cost of this MR` records.

Why this exists (trueppm/trueppm#4884). The `est-cost-usd:` / `orchestrator-tokens:` lines in an MR's
`## Gates` are a go-ahead SNAPSHOT: their orchestrator share covers session spend that every MR of the
same wave also covers, and an older record with only `Window end:` (no start) is cumulative from the
session start. Averaging them inflated the means and made later MRs in a session look the most expensive.
The records the cost-table renders (`Window: S to U`) do not overlap, so an MR's cost is the SUM of its
windowed records' own **Total** rows. `subagent-tokens:` from `## Gates` is per-branch and stays usable.

An MR with no windowed record is EXCLUDED from cost means, never read as 0, and the excluded count is
printed with the reason. The records are parsed by cost-table.py's parser (one parser), which reads only
notes by the token's own user or the MR's author and treats note text as untrusted data: nothing is echoed.

Usage:
  glab mr list -R trueppm/trueppm -M -P 50 -F json | python3 scripts/mr-cost-means.py --project trueppm/trueppm
  python3 scripts/mr-cost-means.py --self-test
"""

import decimal
import importlib.util
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
import ledger_lines as ll  # noqa: E402

MAX_MRS = 100  # notes reads are bounded: one per MR that carries cost lines, and no more than this
_CT = []


def _cost_table():
    if not _CT:
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location(
            "cost_table_4884", os.path.join(HERE, "cost-table.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _CT.append(mod)
    return _CT[0]


def mr_cost(iid, api, author_id=None):
    """(usd or None, tokens or None, reason or None) for one MR from its windowed records.

    A reason means the MR is excluded from the cost means (never read as 0): no records, only legacy
    `Window end:` records (their orchestrator row is cumulative and overlaps other MRs), any record that
    did not parse, any legacy record beside windowed ones, any note by another user, record numbers that
    are not exactly 1..n, an exact-duplicate window, unreadable notes, or a record whose figure is `n/a`.
    Records without a window start are never summed. Partially overlapping windows ARE summed: records
    of different sessions on one MR overlap in time but never in tokens."""
    ct = _cost_table()
    # Trusted authors: the token user (whoever runs /kaizen) or the MR's author, who is who the hook posts as.
    # A note by anyone else still excludes the MR.
    trusted = (
        (author_id,)
        if isinstance(author_id, int) and not isinstance(author_id, bool)
        else ()
    )
    own, foreign, err = ct.read_records(iid, api, also_trusted=trusted)
    if err:
        return None, None, "notes unreadable"
    # A record by another user is never read, so summing only the own part would read low: exclude.
    if foreign:
        return None, None, "records by another user"
    if not own:
        return None, None, "no cost records"
    # Any record that is not a clean windowed one makes the MR's sum unknowable: a legacy record's cost is
    # missing and an unparsed one may be. A partial sum reads low, so the MR is excluded, not summed.
    if any(r["rec"] is None for r in own):
        return None, None, "a record did not parse"
    recs = [r["rec"] for r in own]
    legacy = [r for r in recs if not r["start"]]
    if legacy:
        return (
            None,
            None,
            "legacy and windowed records: partial"
            if len(legacy) < len(recs)
            else "legacy record (no window start)",
        )
    # Over-count shapes: the same record twice, or the same window twice, would add one stretch twice.
    if len({r["k"] for r in recs}) != len(recs):
        return None, None, "duplicate record"
    if sorted(r["k"] for r in recs) != list(range(1, len(recs) + 1)):
        return None, None, "record numbers not 1..n"
    if len({(r["start"], r["end"]) for r in recs}) != len(recs):
        return None, None, "duplicate window"
    windowed = recs
    usd = [r["total"][("usd", "all")] for r in windowed]
    tok = [r["total"][("tok", "all")] for r in windowed]
    # One n/a record makes the sum unknowable; a partial sum would read low, which is worse than excluding.
    if any(u is None for u in usd):
        return None, None, "record with n/a cost"
    return (
        sum(usd, decimal.Decimal(0)),
        sum(tok) if all(t is not None for t in tok) else None,
        None,
    )


def has_cost_lines(description):
    return any(
        f(description) is not None
        for f in (ll.subagent_tokens, ll.est_cost_usd, ll.orchestrator_tokens)
    )


def summarize(mrs, api):
    """The report lines for a list of MR dicts ({'iid', 'description'})."""
    out = []
    off = [
        m
        for m in mrs
        if any(ll.LEDGER_OFF_RE.match(x) for x in ll.ledger_lines(m.get("description")))
    ]
    live = [m for m in mrs if m not in off]
    tok = [
        t
        for t in (ll.subagent_tokens(m.get("description")) for m in live)
        if t is not None
    ]
    out.append(
        "MRs read: %d | cost ledger off: %d | with subagent-tokens: %d"
        % (len(mrs), len(off), len(tok))
    )
    if len(tok) >= 5:
        med = statistics.median(tok)
        big = [
            m["iid"]
            for m in live
            if (ll.subagent_tokens(m.get("description")) or 0) > 2 * med
        ]
        out.append(
            "median subagent-tokens: %d | outliers (>2x median): %s" % (med, big)
        )
    # The hook posts records whether or not the description carries cost lines, so every live MR is read
    # (bounded by the cap and printed), not only those with `## Gates` cost lines.
    cands = live[:MAX_MRS]
    dropped = len(live) - len(cands)
    costs, excluded = [], {}
    for m in cands:
        a = m.get("author")
        usd, _t, why = mr_cost(
            m["iid"], api, a.get("id") if isinstance(a, dict) else None
        )
        if why:
            excluded[why] = excluded.get(why, 0) + 1
        else:
            costs.append(float(usd))
    ex = sum(excluded.values())
    # Every MR read is accounted for. The total is the SUM of the terms, never len(mrs), so a dropped term
    # shows up as a total that no longer equals the number of MRs read (the self-test asserts it).
    out.append(
        "accounted: %d costed + %d excluded + %d not read (cap %d) + %d ledger off = %d"
        % (
            len(costs),
            ex,
            dropped,
            MAX_MRS,
            len(off),
            len(costs) + ex + dropped + len(off),
        )
    )
    out.append(
        "cost from windowed `## Cost of this MR` records: %d MR(s) | excluded: %d%s"
        % (
            len(costs),
            ex,
            " (" + ", ".join("%s: %d" % kv for kv in sorted(excluded.items())) + ")"
            if ex
            else "",
        )
    )
    if len(costs) >= 5:
        out.append(
            "mean per-MR est cost: %.2f USD (list-price estimate, not billed; records summed per MR)"
            % statistics.mean(costs)
        )
    else:
        out.append("fewer than 5 MRs with windowed cost records: not enough data yet")
    return out


def main(argv, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr, api=None):
    if argv[:1] == ["--self-test"]:
        return self_test()
    ct = _cost_table()
    if argv[:1] == ["--project"] and len(argv) == 2:
        ct.PROJECT["path"] = argv[1]
    elif argv:
        print("usage: mr-cost-means.py [--project ns/repo] < mr-list.json", file=stderr)
        return 2
    try:
        mrs = json.load(stdin)
    except ValueError:
        print("mr-cost-means: stdin is not JSON", file=stderr)
        return 2
    if not isinstance(mrs, list):
        return 2
    mrs = [m for m in mrs if isinstance(m, dict) and isinstance(m.get("iid"), int)]
    for line in summarize(mrs, api or ct.glab_api):
        print(line, file=stdout)
    return 0


# --- self-test --------------------------------------------------------------


def self_test():
    ct = _cost_table()
    fails = []

    def check(name, ok):
        if not ok:
            fails.append(name)

    def rec(k, start, end, usd, tok):
        """A record exactly as cost-table renders it, so the real parser reads it back."""
        head = "## Cost of this MR (#1)" + (" — record %d" % k if k > 1 else "")
        win = (
            "- Window: %s to %s. This record counts only the work in this window."
            % (start, end)
            if start
            else "- Window end: %s. Both figures stop at the go-ahead to push." % end
        )
        total = "| **Total** | **0** | **0.00 USD** | **0** | **0.00 USD** | **{t}** | **{u}** |".format(
            t="{:,}".format(tok) if tok is not None else "n/a (no token line)",
            u=("%s USD" % usd) if usd is not None else "n/a (no price)",
        )
        body = "\n".join(
            [
                head,
                "",
                "| | Sonnet tokens | Sonnet est. cost | Opus tokens | Opus est. cost | Total tokens | Est. cost |",
                "|---|---|---|---|---|---|---|",
                total,
                "",
                win,
                "",
                ct.FOOTER_1 if k == 1 else ct.FOOTER_K,
            ]
        )
        return body

    def fake_api(notes_by_iid, me=7):
        def api(method, path):
            if path == "user":
                return 0, json.dumps({"id": me})
            iid = int(path.split("merge_requests/")[1].split("/")[0])
            if iid not in notes_by_iid:
                return 1, ""
            return 0, json.dumps(
                [
                    {"id": i + 1, "body": b, "author": {"id": a}, "system": False}
                    for i, (b, a) in enumerate(notes_by_iid[iid])
                ]
            )

        return api

    A = "2026-11-04T10:00:00Z"
    B = "2026-11-04T11:00:00Z"
    C = "2026-11-04T12:00:00Z"
    notes = {
        # a wave of overlapping snapshots: the windowed records do not overlap, the snapshots grow
        101: [(rec(1, A, B, "1.50", 1000), 7)],
        102: [(rec(1, B, C, "2.00", 2000), 7)],
        103: [(rec(1, A, B, "1.00", 500), 7), (rec(2, B, C, "0.75", 250), 7)],  # summed
        104: [(rec(1, None, B, "9.99", 99999), 7)],  # legacy only: excluded
        105: [(rec(1, A, B, "5.00", 5), 99)],  # foreign author: not read at all
        106: [(rec(1, A, B, None, None), 7)],  # n/a cost: excluded
    }
    api = fake_api(notes)
    usd, tok, why = mr_cost(103, api)
    check(
        "multi-record MR is summed",
        why is None and usd == decimal.Decimal("1.75") and tok == 750,
    )
    check(
        "single windowed record read", mr_cost(101, api)[0] == decimal.Decimal("1.50")
    )
    check(
        "legacy record excluded, not 0",
        mr_cost(104, api) == (None, None, "legacy record (no window start)"),
    )
    check(
        "no records excluded", mr_cost(999, fake_api({999: []}))[2] == "no cost records"
    )
    check(
        "all-foreign records: MR excluded, not read as no records",
        mr_cost(105, api) == (None, None, "records by another user"),
    )
    check("n/a figure excluded, not 0", mr_cost(106, api)[2] == "record with n/a cost")
    check("unreadable notes excluded", mr_cost(500, api)[2] == "notes unreadable")

    def desc(est, orch):
        return (
            "## Gates\ngate: x — 0 findings\nsubagent-tokens: 10\norchestrator-tokens: %d\nest-cost-usd: %s\n"
            % (orch, est)
        )

    # Snapshot lines grow with the session (5.2M -> 19.8M orchestrator); they must not drive the mean.
    mrs = [
        {"iid": 101, "description": desc("10.00", 5_200_000)},
        {"iid": 102, "description": desc("20.00", 10_100_000)},
        {"iid": 103, "description": desc("30.00", 12_400_000)},
        {"iid": 104, "description": desc("40.00", 16_200_000)},
        {"iid": 106, "description": desc("50.00", 19_800_000)},
        {"iid": 107, "description": "## Gates\ncost-ledger: off\n"},
        {"iid": 108, "description": "## Gates\ngate: x — 0 findings\n"},
    ]
    rep = summarize(mrs, api)
    check(
        "report counts the off MR",
        rep[0].startswith("MRs read: 7 | cost ledger off: 1 | with subagent-tokens: 5"),
    )
    check(
        "report prints excluded count with reasons",
        "excluded: 3 (legacy record (no window start): 1, notes unreadable: 1, record with n/a cost: 1)"
        in rep[3],
    )
    check("snapshot est-cost-usd is not the mean", not any("30.00" in x for x in rep))
    check("under 5 windowed MRs is not enough data", rep[4].startswith("fewer than 5"))
    big = [{"iid": 200 + i, "description": desc("1.00", 1)} for i in range(5)]
    ap2 = fake_api(
        {200 + i: [(rec(1, A, B, "%d.00" % (i + 1), 10), 7)] for i in range(5)}
    )
    check(
        "mean over 5 windowed MRs is the mean of record sums",
        "mean per-MR est cost: 3.00 USD" in "\n".join(summarize(big, ap2)),
    )
    # Mixed, unparsed and over-count shapes are excluded, never partially summed.
    D = "2026-11-04T13:00:00Z"
    E = "2026-11-04T10:30:00Z"
    shapes = {
        301: (
            [(rec(1, None, A, "9.00", 9), 7), (rec(2, A, B, "1.00", 1), 7)],
            "legacy and windowed records: partial",
        ),
        302: (
            [
                (rec(1, A, B, "1.00", 1), 7),
                ("## Cost of this MR (#1) \u2014 record 2\nnot a record", 7),
            ],
            "a record did not parse",
        ),
        303: (
            [(rec(1, A, B, "1.00", 1), 7), (rec(1, B, C, "2.00", 2), 7)],
            "duplicate record",
        ),
        304: (
            [(rec(1, A, B, "1.00", 1), 7), (rec(2, E, C, "2.00", 2), 7)],
            None,
        ),
        309: (
            [(rec(1, A, B, "1.00", 1), 7), (rec(2, A, B, "2.00", 2), 7)],
            "duplicate window",
        ),
        306: (
            [(rec(1, A, B, "1.00", 1), 7), (rec(3, B, C, "2.00", 2), 7)],
            "record numbers not 1..n",
        ),
        307: ([(rec(2, A, B, "1.00", 1), 7)], "record numbers not 1..n"),
        308: (
            [(rec(1, A, B, "1.00", 1), 7), (rec(2, B, C, "2.00", 2), 99)],
            "records by another user",
        ),
        305: (
            [
                (rec(1, A, B, "1.00", 1), 7),
                (rec(2, B, C, "2.00", 2), 7),
                (rec(3, C, D, "3.00", 3), 7),
            ],
            None,
        ),
    }
    sapi = fake_api({k: v[0] for k, v in shapes.items()})
    for iid, (_n, want) in shapes.items():
        got = mr_cost(iid, sapi)
        check(
            "shape %d: %s" % (iid, want),
            got[2] == want and (want is None) == (got[0] is not None),
        )
    check(
        "partially overlapping windows are summed (different sessions)",
        mr_cost(304, sapi)[0] == decimal.Decimal("3.00"),
    )
    # Trusted authors: the token user OR the MR author. Token user 9 (another maintainer) runs /kaizen.
    tapi = fake_api(
        {
            801: [
                (rec(1, A, B, "1.00", 1), 8),
                (rec(2, B, C, "2.00", 2), 8),
            ],  # by the MR author
            802: [
                (rec(1, A, B, "1.00", 1), 8),
                (rec(2, B, C, "2.00", 2), 55),
            ],  # plus a third party
            803: [(rec(1, A, B, "1.00", 1), 9)],  # by the token user
        },
        me=9,
    )
    check(
        "MR author's records are summed when a different user runs it",
        mr_cost(801, tapi, 8)[0] == decimal.Decimal("3.00"),
    )
    check(
        "without the MR author id they are another user's",
        mr_cost(801, tapi)[2] == "records by another user",
    )
    check(
        "a third party's note still excludes",
        mr_cost(802, tapi, 8)[2] == "records by another user",
    )
    check(
        "the token user's records still count",
        mr_cost(803, tapi, 8)[0] == decimal.Decimal("1.00"),
    )
    # The offline fixture path carries the MR author like a live `glab mr list` row does.
    live_rep = summarize([{"iid": 801, "description": "x", "author": {"id": 8}}], tapi)
    check("summarize passes the MR author through", "1 costed" in live_rep[1])
    check("adjacent windows sum", mr_cost(305, sapi)[0] == decimal.Decimal("6.00"))

    # Every MR read is accounted for, and the cap drops are counted (removing the slice fails this).
    many = [
        {"iid": 400 + i, "description": desc("1.00", 1)} for i in range(MAX_MRS + 3)
    ]
    many.append({"iid": 999, "description": "## Gates\ncost-ledger: off\n"})
    cap_rep = "\n".join(summarize(many, fake_api({})))
    check("cap drops are printed", "3 not read (cap %d)" % MAX_MRS in cap_rep)
    check("ledger-off MRs are counted", "1 ledger off" in cap_rep)
    check(
        "accounting total (a sum of its terms) equals MRs read",
        "= %d" % (MAX_MRS + 4) in cap_rep,
    )
    # Records exist whether or not `## Gates` carries cost lines (the hook posts them regardless).
    nolines = summarize(
        [{"iid": 701, "description": "## Gates\ngate: x \u2014 0 findings\n"}],
        fake_api({701: [(rec(1, A, B, "2.00", 2), 7)]}),
    )
    check(
        "an MR with records but no Gates cost lines is costed",
        "1 costed" in nolines[1] and "= 1" in nolines[1],
    )

    # A record rendered by cost-table's own renderer, so a renderer change is caught here.
    gates = "## Gates\nsubagent-tokens: 100\norchestrator-tokens: 200\nest-cost-usd: 1.25 (prices 2026-11-01)\n"
    rend = "\n".join(ct.comment_lines(gates, 4884, B, None, 1, A)) + "\n"
    rapi = fake_api({600: [(rend, 7)]})
    rusd, rtok, rwhy = mr_cost(600, rapi)
    check(
        "a renderer-produced windowed record is read",
        rwhy is None and rusd == decimal.Decimal("1.25") and rtok == 300,
    )
    legacy_rend = "\n".join(ct.comment_lines(gates, 4884, B)) + "\n"
    check(
        "a renderer-produced legacy record is excluded",
        mr_cost(601, fake_api({601: [(legacy_rend, 7)]}))[2]
        == "legacy record (no window start)",
    )
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("mr-cost-means self-test OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
