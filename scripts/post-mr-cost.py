#!/usr/bin/env python3
"""scripts/post-mr-cost.py - post the `## Cost of this MR` comment right after `glab mr create`.

Why this exists. The cost comment used to appear only when an agent followed the /wave prose
(Step 5.4 measures, Step 6 posts). Any MR opened another way (a plain /mr, a hand-run
`glab mr create`) got no comment, and nothing noticed: of !1736-!1744 only !1737 had one. This
runs as a Claude Code PostToolUse hook on Bash (.claude/settings.json), so the comment no longer
depends on anyone remembering. It reuses the existing scripts; it measures nothing itself.

What it does, only when the Bash command was a `glab mr create` that printed an MR URL:
  1. Opt-out first. `scripts/cost-ledger enabled` must exit 0 (off or unreadable: do nothing),
     and the MR description must not carry the `cost-ledger: off` marker.
  2. Skip when this user already has a `## Cost of this MR` comment on the MR (/wave posts a
     richer one with named agents; this never overwrites it).
  2b. When the description already carries ledger lines (a /wave MR), render from them and
     stop: post_from_description() never measures. Only a plain /mr falls through to step 3.
  3. Measure this session since the last MR it posted for (or the session start): the
     orchestrator, every top-level subagent that started in the window, and the estimate.
  4. Render and post record 1 through scripts/cost-table.py.
Any failure is fail-soft: the hook exits 0 and tells the model what to run by hand, so a broken
transcript layout can never block an MR. Opt out for yourself with
`scripts/cost-ledger off --local`; see docs/harness/cost-ledger.md.

Subagents are found by listing <session>/subagents/agent-*.meta.json without a parentAgentId
(descendants are added by subagent-tokens.py) and keeping those whose transcript starts in the
window. /wave names its agents explicitly and stays more exact; this is the fallback.

Fix rounds. The hook cannot see them (no `glab mr create`), so /fix-mr calls
`python3 scripts/post-mr-cost.py --round --mr <iid>` after its push: it posts
`## Cost of this MR (#N) - record K` (this round's window plus a running total) through
cost-table.py, and prints one line saying what it did. It posts nothing when the ledger is off,
the MR opts out, or record 1 is missing or unreadable.

Usage: reads the hook JSON on stdin.  python3 scripts/post-mr-cost.py --self-test
       python3 scripts/post-mr-cost.py --round --mr <iid> [--session <sid>]
       python3 scripts/post-mr-cost.py --retry --mr <iid> [--session <sid>]   (re-run the hook for an MR)
Exit:  always 0 as a hook; --self-test 0 ok, 1 failed.
"""

import contextlib
import datetime
import glob
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
MR_CREATE_RE = re.compile(r"(?:^|[\s;&|(])glab\s+mr\s+create(?:\s|$)")
MR_URL_RE = re.compile(r"/-/merge_requests/(\d{1,9})(?![\d])")
SESSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,127}\Z")
AGENT_RE = re.compile(r"^agent-([0-9A-Za-z][0-9A-Za-z_-]{0,127})\.meta\.json\Z")
TS_FMT = "%Y-%m-%dT%H:%M:%SZ"
EPOCH = "1970-01-01T00:00:00Z"
ISSUE_RE = re.compile(r"(?:^|/)(?:feat|fix|docs|chore)/(\d{1,9})-")
OFF_MARKER_RE = re.compile(r"^\s*(?:[-*]\s*)?cost-ledger:\s*off\s*$", re.I | re.M)


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime(TS_FMT)


def mr_iid(command, response):
    """The new MR's iid when `command` ran `glab mr create` and `response` printed its URL."""
    if not MR_CREATE_RE.search(command or ""):
        return None
    text = response if isinstance(response, str) else json.dumps(response or "")
    m = MR_URL_RE.search(text)
    return int(m.group(1)) if m else None


def run(cmd, cwd, env=None, timeout=300):
    try:
        r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", type(e).__name__
    return (
        r.returncode,
        r.stdout.decode("utf-8", "replace"),
        r.stderr.decode("utf-8", "replace"),
    )


def first_timestamp(path):
    """The first parseable `timestamp` in a transcript, or None."""
    import transcript_usage as tu

    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for _, line in zip(range(50), f):
                try:
                    ts = json.loads(line).get("timestamp")
                except (ValueError, AttributeError):
                    continue
                t = tu.parse_time(ts) if isinstance(ts, str) else None
                if t is not None:
                    return t
    except OSError:
        return None
    return None


def top_level_agents(session_dir, since):
    """Ids of top-level subagents (no parentAgentId) whose transcript starts at or after `since`."""
    import transcript_usage as tu

    floor = tu.parse_time(since)
    ids = []
    for meta in sorted(
        glob.glob(
            os.path.join(glob.escape(session_dir), "subagents", "agent-*.meta.json")
        )
    ):
        m = AGENT_RE.match(os.path.basename(meta))
        if not m:
            continue
        try:
            with open(meta, encoding="utf-8") as f:
                if json.load(f).get("parentAgentId"):
                    continue
        except (OSError, ValueError, AttributeError):
            continue
        started = first_timestamp(meta[: -len(".meta.json")] + ".jsonl")
        if started is not None and floor is not None and started >= floor:
            ids.append(m.group(1))
    return ids


def find_session_dir(sid, projects_dir):
    hits = sorted(
        h
        for h in glob.glob(os.path.join(glob.escape(projects_dir), "*", sid))
        if os.path.isdir(h)
    )
    return hits[0] if len(hits) == 1 else None


READ_ATTEMPTS = 3
READ_TIMEOUT = 15
BACKOFF = (2, 5)
SLEEP = [time.sleep]
TS_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z")


def glab_json(path, cwd):
    """JSON of a GET, retried (a read is idempotent) so one hung call is not a skipped comment."""
    for n in range(READ_ATTEMPTS):
        if n:
            SLEEP[0](BACKOFF[min(n - 1, len(BACKOFF) - 1)])
        rc, out, _ = run(["glab", "api", path], cwd, timeout=READ_TIMEOUT)
        if rc != 0:
            continue
        try:
            return json.loads(out)
        except ValueError:
            continue
    return None


_CT = []


def _cost_table():
    """cost-table.py loaded as a module (its constants and parser), once."""
    if not _CT:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "cost_table_mod", os.path.join(HERE, "cost-table.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _CT.append(mod)
    return _CT[0]


def cost_table_timeout():
    """Outer timeout for a cost-table.py run: its own worst case (it retries internally, and walks
    up to NOTES_MAX_PAGES notes pages per attempt) plus margin.

    Derived, not hard-coded: a kill before cost-table's last attempt would lose its stderr reason and
    leave the window marker un-advanced even when a POST had landed.

    Budget for the hook (600s in .claude/settings.json), all stages at their worst: description
    read + this hook's 2 notes pages + user read, each 3 x READ_TIMEOUT + backoff = 52s (4 reads,
    208s), plus this timeout (337s), plus ~30s of local measuring: 575s.
    """
    return int(_cost_table().worst_case_seconds()) + 30


COST_NOTES_PAGES = (
    2  # the hook's own time budget; cost-table reads up to NOTES_MAX_PAGES
)


def cost_notes(iid, cwd, max_pages=COST_NOTES_PAGES):
    """[(body, author id)] of the `## Cost of this MR` notes, [] when none, None when unreadable.

    Unreadable is not 'exists': treating it as such made a flaky `glab api` skip the comment with
    no trace. The caller reports it and posts nothing, so a flaky API still never duplicates.
    Pages past 100 notes, up to max_pages (the hook's time budget); more reads as unreadable.
    """
    found = []
    for page in range(1, max_pages + 1):
        notes = glab_json(
            "projects/:id/merge_requests/%d/notes?per_page=100&page=%d" % (iid, page),
            cwd,
        )
        if not isinstance(notes, list):
            return None
        for n in notes:
            if isinstance(n, dict) and "## Cost of this MR" in str(n.get("body", "")):
                a = n.get("author")
                found.append(
                    (
                        str(n.get("body", "")),
                        a.get("id") if isinstance(a, dict) else None,
                    )
                )
        if len(notes) < 100:
            return found
    return None


def window_end(notes, me, now):
    """The latest window end among THIS token user's existing cost records, or None.

    Only notes by the token's own user whose body starts with the heading count (as cost-table's
    read_records does), and an end later than `now` is ignored: a foreign or hand-edited record
    dated 2099 would otherwise push this session's marker past every later MR's window.
    """
    if me is None:
        return None
    ct = _cost_table()
    ends = []
    for body, aid in notes:
        if aid != me or not body.lstrip().startswith("## Cost of this MR"):
            continue
        rec = ct.parse_record(body)
        if rec and isinstance(rec.get("end"), str) and TS_RE.match(rec["end"]):
            if rec["end"] <= now:
                ends.append(rec["end"])
    return max(ends) if ends else None


def measure(runner, cwd, env, sdir, since, until):
    """Run the three measuring scripts for since..until. Returns (stdout lines, stderr chunks).

    A session that never spawned a subagent has no <sid>/ directory; that is --no-agents, not a failure.
    """
    agents = top_level_agents(sdir, since) if sdir else []
    agent_args = [a for i in agents for a in ("--agent", i)] or ["--no-agents"]
    lines, split = [], []
    for script, extra in (
        ("subagent-tokens.py", agent_args + ["--until", until]),
        ("orchestrator-tokens.py", ["--since", since, "--until", until]),
        ("est-cost.py", agent_args + ["--since", since, "--until", until]),
    ):
        rc, out, err = runner(
            [sys.executable, os.path.join(HERE, script)] + extra, cwd, env=env
        )
        split.append(err)
        if rc == 0 and out.strip():
            lines.append(out.strip().splitlines()[0])
    return lines, split


OUTCOME = {"why": ""}


def state_path(gitdir, sid):
    """Where this session's window start lives: <git common dir>/mr-cost-last-until.<sid>.

    Why keyed: the common dir is shared by every worktree and parallel session, but the window is
    per session. One unkeyed file let session B's MR advance A's window start, so A's next MR
    undercounted by A's own spend in between.
    """
    return os.path.join(gitdir, "mr-cost-last-until." + sid)


def read_since(gitdir, sid):
    """This session's window start. Falls back to the legacy unkeyed file only when no keyed one exists."""
    for path in (state_path(gitdir, sid), os.path.join(gitdir, "mr-cost-last-until")):
        try:
            with open(path, encoding="utf-8") as f:
                cand = f.read().strip()
        except OSError:
            continue
        if re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z", cand):
            return cand
        return EPOCH  # a keyed file that is unreadable text is not a reason to fall through to another session's
    return EPOCH


def write_since(gitdir, sid, until):
    try:
        with open(state_path(gitdir, sid), "w", encoding="utf-8") as f:
            f.write(until + "\n")
    except OSError:
        pass


def reason_of(err, cap=200):
    """The last non-empty stderr line of a failed script, capped, for the message and the log."""
    lines = [ln.strip() for ln in (err or "").splitlines() if ln.strip()]
    return lines[-1][:cap] if lines else ""


def quiet(why):
    """Record why the hook stayed silent (for the log) and return None."""
    OUTCOME["why"] = why
    return None


def log_firing(cwd, payload, msg):
    """Append one line to <git common dir>/mr-cost-hook.log for a `glab mr create` the hook saw.

    Why: every skip used to be silent, so 'the hook never fired' and 'the hook fired and skipped'
    looked identical. No command text, token or transcript content is logged: only the time, the
    session id, the MR iid (when printed) and a fixed outcome string.
    """
    try:
        rc, out, _ = run(["git", "rev-parse", "--git-common-dir"], cwd, timeout=15)
        base = (
            os.path.abspath(os.path.join(cwd, out.strip()))
            if rc == 0 and out.strip()
            else tempfile.gettempdir()
        )
        path = os.path.join(base, "mr-cost-hook.log")
        try:
            if os.path.getsize(path) > (256 << 10):
                os.replace(path, path + ".1")
        except OSError:
            pass
        iid = mr_iid(
            (payload.get("tool_input") or {}).get("command", ""),
            payload.get("tool_response"),
        )
        outcome = (msg or OUTCOME["why"] or "silent").replace("\n", " ")[:300]
        sid = payload.get("session_id") or "-"
        sid = sid if SESSION_RE.match(str(sid)) else "-"
        with open(path, "a", encoding="utf-8") as f:
            f.write(
                "%s session=%s mr=%s outcome=%s\n"
                % (now_utc(), sid, iid if iid else "-", outcome)
            )
    except Exception:  # noqa: BLE001 - logging must never break the hook
        pass


SPLIT_NAME = "wave-cost-split.txt"
SPLIT_MAX_AGE_S = 2 * 3600
# A cost key at the start of a line, optionally behind a list marker, quote or fence indent. Raw
# text on purpose: cost-table only reads unfenced `## Gates` lines, but a ledger pasted under
# `## Notes`, in a fence or in a quote still means the figures were written down by someone.
LEDGER_KEY_RE = re.compile(
    r"^[ \t>]*(?:[-*][ \t]+)?(?:subagent-tokens|orchestrator-tokens|est-cost-usd)[ \t]*:",
    re.I | re.M,
)


def ledger_in_description(description):
    """True when any cost ledger key appears anywhere in the description, in any shape.

    Why raw text: a re-measured window cannot be right for a wave MR, so once a ledger is written
    anywhere the hook must never measure. cost-table.py then renders it (a cell may read n/a).
    """
    return LEDGER_KEY_RE.search(description or "") is not None


def split_matches(description, split_path):
    """(ok, why): True only when the split's per-model token sums equal the description's lines.

    Reuses cost-table.py's own parsing. Any failure to load or read it drops the split rather than
    raising: the totals come from the description either way.
    """
    try:
        import importlib.util

        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location(
            "cost_table_for_hook", os.path.join(HERE, "cost-table.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with open(split_path, encoding="utf-8") as f:
            sp = mod.parse_split(f.read(4 << 20))
        fig = mod.figures(description or "")
        compared = 0
        for side in ("subagent", "orchestrator"):
            want = fig[side][0]
            got = sum(sp["tokens"].get(side, {}).values())
            if want:
                compared += 1
            if want is not None and got != want:
                return (
                    False,
                    "its %s tokens (%d) differ from the description's (%d)"
                    % (
                        side,
                        got,
                        want,
                    ),
                )
        if not compared:
            # Nothing non-zero to compare against: a match would be vacuous.
            return (
                False,
                "the description has no non-zero token figure to check it against",
            )
        return True, None
    except Exception as e:  # noqa: BLE001 - a bad import must not disable the comment
        return False, "it could not be checked (%s)" % type(e).__name__


def wave_split(runner, cwd, created_at, description):
    """(split path, mtime as UTC timestamp, why-not) for this checkout's wave-cost-split.txt.

    /wave writes the file into the implementer worktree's git dir, which is where `glab mr create`
    ran, so only `git rev-parse --git-dir` from cwd is looked at. It is used only when it is older
    than the MR, at most two hours older, and its token sums equal the description's lines;
    otherwise it belongs to some other MR in the same worktree and is ignored.
    """
    rc, out, _ = runner(["git", "rev-parse", "--git-dir"], cwd)
    if rc != 0 or not out.strip():
        return None, None, "no git dir"
    path = os.path.join(os.path.abspath(os.path.join(cwd, out.strip())), SPLIT_NAME)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None, None, "no %s" % SPLIT_NAME
    try:
        made = datetime.datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        age = made.timestamp() - mtime
    except ValueError:
        return None, None, "MR created_at unreadable"
    if age <= 0 or age > SPLIT_MAX_AGE_S:
        return None, None, "%s is not from this MR (stale)" % SPLIT_NAME
    ok, why = split_matches(description, path)
    if not ok:
        return None, None, "%s ignored: %s" % (SPLIT_NAME, why)
    stamp = datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc).strftime(
        TS_FMT
    )
    return path, stamp, None


def created_at_utc(created_at):
    """The MR's creation time as fixed-format UTC, or None when it cannot be read."""
    try:
        made = datetime.datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        if made.tzinfo is None:
            return None
        return made.astimezone(datetime.timezone.utc).strftime(TS_FMT)
    except ValueError:
        return None


def post_from_description(iid, d, cwd, gitdir, command, runner, manual):
    """Post record 1 from the description's own ledger lines; never re-measures.

    Why: a wave opens its MRs minutes apart with agents started earlier, so a window since the last
    post excludes this MR's agents and can include another's. The orchestrator already wrote the
    right figures into the description; the description wins over any measurement.

    Always passes --until (the split's mtime, else the MR's creation time, else now) so record 1 has a readable window end,
    which `cost-table.py --next-since` and --round need. It does not touch mr-cost-last-until.<sid>:
    this path measures nothing, and that file is shared by every worktree, so writing the split's
    older mtime could move the plain-/mr window backward.
    """
    desc_text = str(d.get("description", ""))
    split, until, why = wave_split(runner, cwd, d.get("created_at"), desc_text)
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
    desc = os.path.join(tmp, "desc.md")
    with open(desc, "w", encoding="utf-8") as f:
        f.write(desc_text)
    cmd = [
        sys.executable,
        os.path.join(HERE, "cost-table.py"),
        "--file",
        desc,
        "--comment",
        "--post",
        "--mr",
        str(iid),
        "--until",
        until or created_at_utc(d.get("created_at")) or now_utc(),
    ]
    if split:
        cmd += ["--split", split]
    m = ISSUE_RE.search(str(command)) or ISSUE_RE.search(
        str(d.get("source_branch", ""))
    )
    if m:
        cmd += ["--issue", m.group(1)]
    rc, _, err = runner(cmd, cwd, timeout=cost_table_timeout())
    try:
        os.remove(desc)
        os.rmdir(tmp)
    except OSError:
        pass
    if rc != 0:
        why_f = reason_of(err)
        return "MR cost comment failed for !%d (cost-table exit %d%s). %s" % (
            iid,
            rc,
            ": " + why_f if why_f else "",
            manual,
        )
    note = (
        ""
        if split
        else " (per-model split n/a: %s; the window end is the MR creation time)" % why
    )
    return (
        "Posted the `## Cost of this MR` comment on !%d from the description's ledger lines%s (opt out: scripts/cost-ledger off --local)."
        % (iid, note)
    )


def process(payload, projects_dir=None, runner=run):
    """(message or None). The only function with side effects beyond the scripts it runs."""
    OUTCOME["why"] = ""
    if payload.get("tool_name") not in (None, "Bash"):
        return quiet("not a Bash call")
    ti = payload.get("tool_input") or {}
    iid = mr_iid(ti.get("command", ""), payload.get("tool_response"))
    if iid is None:
        return quiet(
            "glab mr create ran but no MR URL was printed"
            if MR_CREATE_RE.search(ti.get("command", "") or "")
            else "not an MR create"
        )
    cwd = payload.get("cwd") or os.getcwd()
    sid = payload.get("session_id") or ""
    manual = (
        "Retry it with: python3 scripts/post-mr-cost.py --retry --mr %d%s (see docs/harness/cost-ledger.md)."
        % (iid, " --session " + sid if SESSION_RE.match(sid) else "")
    )
    rc, _, _ = runner(
        [sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd
    )
    if rc == 2:
        # Unreadable is not "off": a person chose off, nobody chose a broken setting file.
        return (
            "MR cost comment not posted for !%d: the cost-ledger setting is unreadable (scripts/cost-ledger status). %s"
            % (
                iid,
                manual,
            )
        )
    if rc != 0:
        return quiet("cost-ledger off (enabled exit %d)" % rc)  # the opt-out
    d = glab_json("projects/:id/merge_requests/%d" % iid, cwd)
    if not isinstance(d, dict):
        # The opt-out marker lives in the description, so an unreadable one cannot be checked.
        return (
            "MR cost comment not posted for !%d: could not read its description (glab api failed), so `cost-ledger: off` could not be checked. %s"
            % (
                iid,
                manual,
            )
        )
    if OFF_MARKER_RE.search(str(d.get("description", ""))):
        return quiet("MR description carries cost-ledger: off")
    seen = cost_notes(iid, cwd)
    if seen is None:
        return (
            "MR cost comment not posted for !%d: could not read its notes (glab api failed). %s"
            % (iid, manual)
        )
    if seen:
        # A comment that landed while the hook was killed or reported a failure: advance this
        # session's window to its end, or the next MR re-counts the same work.
        user = glab_json("user", cwd)
        end = window_end(
            seen, user.get("id") if isinstance(user, dict) else None, now_utc()
        )
        rc, gd, _ = runner(["git", "rev-parse", "--git-common-dir"], cwd)
        if end and rc == 0 and gd.strip():
            gd = os.path.abspath(os.path.join(cwd, gd.strip()))
            if (
                SESSION_RE.match(sid)
                and not ledger_in_description(d.get("description"))
                and end > read_since(gd, sid)
            ):
                write_since(gd, sid, end)
        return quiet("a cost comment already exists")
    if ledger_in_description(d.get("description")):
        # Structural: past this return nothing below (the measuring path) can run.
        rc, gd, _ = runner(["git", "rev-parse", "--git-common-dir"], cwd)
        if rc != 0 or not gd.strip():
            return "MR cost comment skipped for !%d: not in a git checkout. %s" % (
                iid,
                manual,
            )
        return post_from_description(
            iid,
            d,
            cwd,
            os.path.abspath(os.path.join(cwd, gd.strip())),
            ti.get("command", ""),
            runner,
            manual,
        )
    if not SESSION_RE.match(sid):
        return "MR cost comment skipped for !%d: no usable session id. %s" % (
            iid,
            manual,
        )
    projects_dir = projects_dir or os.path.join(
        os.path.expanduser("~"), ".claude", "projects"
    )
    sdir = find_session_dir(sid, projects_dir)
    has_transcript = bool(
        glob.glob(os.path.join(glob.escape(projects_dir), "*", sid + ".jsonl"))
    )
    if sdir is None and not has_transcript:
        return "MR cost comment skipped for !%d: session transcript not found. %s" % (
            iid,
            manual,
        )
    rc, gitdir, _ = runner(["git", "rev-parse", "--git-common-dir"], cwd)
    gitdir = (
        os.path.abspath(os.path.join(cwd, gitdir.strip()))
        if rc == 0 and gitdir.strip()
        else None
    )
    if not gitdir:
        return "MR cost comment skipped for !%d: not in a git checkout. %s" % (
            iid,
            manual,
        )
    since = read_since(gitdir, sid)
    until = now_utc()
    env = dict(os.environ, CLAUDE_CODE_SESSION_ID=sid)
    lines, split = measure(runner, cwd, env, sdir, since, until)
    if not any(
        ln.startswith(("subagent-tokens:", "orchestrator-tokens:")) for ln in lines
    ):
        return (
            "MR cost comment skipped for !%d: nothing measurable in this session window. %s"
            % (iid, manual)
        )
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
    desc, splitf = os.path.join(tmp, "desc.md"), os.path.join(tmp, "split.txt")
    with open(desc, "w", encoding="utf-8") as f:
        f.write("## Gates\n" + "\n".join(lines) + "\n")
    with open(splitf, "w", encoding="utf-8") as f:
        f.write("".join(split))
    cmd = [
        sys.executable,
        os.path.join(HERE, "cost-table.py"),
        "--file",
        desc,
        "--comment",
        "--post",
        "--mr",
        str(iid),
        "--until",
        until,
        "--split",
        splitf,
    ]
    m = re.search(
        r"(?:^|/)(?:feat|fix|docs|chore)/(\d{1,9})-", str(ti.get("command", ""))
    )
    if not m:
        m = ISSUE_RE.search(str(d.get("source_branch", "")))
    if m:
        cmd += ["--issue", m.group(1)]
    rc, out, err = runner(cmd, cwd, timeout=cost_table_timeout())
    for p in (desc, splitf):
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp)
    except OSError:
        pass
    if rc != 0:
        why = reason_of(err)
        return "MR cost comment failed for !%d (cost-table exit %d%s). %s" % (
            iid,
            rc,
            ": " + why if why else "",
            manual,
        )
    write_since(gitdir, sid, until)
    return (
        "Posted the `## Cost of this MR` comment on !%d (opt out: scripts/cost-ledger off --local)."
        % iid
    )


def process_round(iid, sid, cwd, projects_dir=None, runner=run):
    """Post `## Cost of this MR (#N) - record K` for a fix round on an MR that already has record 1.

    Why a separate entry point: the PostToolUse hook only sees `glab mr create`. A fix round has no
    such event, and the /fix-mr prose step was the only thing posting its cost, so rounds went
    unrecorded. /fix-mr calls this after its push. The window is the latest record's end (the
    cost-table.py --next-since value) to now; the record itself, its running total and the
    "never edit an earlier record" rule are cost-table.py's. Returns a message (never raises).
    """
    manual = (
        "Retry it from the checkout root with: python3 scripts/post-mr-cost.py --round --mr %d%s "
        "(see docs/harness/cost-ledger.md)."
        % (
            iid,
            " --session " + sid if SESSION_RE.match(sid or "") else " --session <sid>",
        )
    )
    rc, _, _ = runner(
        [sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd
    )
    if rc == 2:
        return "cost-ledger setting is unreadable: no record posted for !%d. %s" % (
            iid,
            manual,
        )
    if rc != 0:
        return "cost-ledger is off: no record posted for !%d." % iid
    if not SESSION_RE.match(sid or ""):
        return "Record skipped for !%d: no usable session id (pass --session). %s" % (
            iid,
            manual,
        )
    d = glab_json("projects/:id/merge_requests/%d" % iid, cwd)
    if not isinstance(d, dict):
        return (
            "Record not posted for !%d: could not read its description (glab api failed), so `cost-ledger: off` could not be checked. %s"
            % (
                iid,
                manual,
            )
        )
    if OFF_MARKER_RE.search(str(d.get("description", ""))):
        return "MR !%d carries `cost-ledger: off`: no record posted." % iid
    rc, out, nerr = runner(
        [
            sys.executable,
            os.path.join(HERE, "cost-table.py"),
            "--next-since",
            "--mr",
            str(iid),
        ],
        cwd,
        timeout=cost_table_timeout(),
    )
    since = out.strip()
    if rc not in (0, 1):
        return (
            "Record not posted for !%d: could not read its notes (cost-table exit %d%s). %s"
            % (
                iid,
                rc,
                ": " + reason_of(nerr) if reason_of(nerr) else "",
                manual,
            )
        )
    if rc != 0 or not re.match(
        r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\Z", since
    ):
        return (
            "Record skipped for !%d: it has no readable record 1 to continue from. %s"
            % (iid, manual)
        )
    projects_dir = projects_dir or os.path.join(
        os.path.expanduser("~"), ".claude", "projects"
    )
    sdir = find_session_dir(sid, projects_dir)
    rc, gitdir, _ = runner(["git", "rev-parse", "--git-common-dir"], cwd)
    gitdir = (
        os.path.abspath(os.path.join(cwd, gitdir.strip()))
        if rc == 0 and gitdir.strip()
        else None
    )
    if not gitdir:
        return "Record skipped for !%d: not in a git checkout. %s" % (iid, manual)
    until = now_utc()
    env = dict(os.environ, CLAUDE_CODE_SESSION_ID=sid)
    lines, split = measure(runner, cwd, env, sdir, since, until)
    if not any(
        ln.startswith(("subagent-tokens:", "orchestrator-tokens:")) for ln in lines
    ):
        return "Record skipped for !%d: nothing measurable between %s and now. %s" % (
            iid,
            since,
            manual,
        )
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
    ledger, splitf = os.path.join(tmp, "lines.txt"), os.path.join(tmp, "split.txt")
    with open(ledger, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(splitf, "w", encoding="utf-8") as f:
        f.write("".join(split))
    cmd = [
        sys.executable,
        os.path.join(HERE, "cost-table.py"),
        "--comment",
        "--ledger",
        ledger,
        "--split",
        splitf,
        "--since",
        since,
        "--until",
        until,
        "--mr",
        str(iid),
        "--post",
    ]
    rc, br, _ = runner(["git", "branch", "--show-current"], cwd)
    m = ISSUE_RE.search(br) if rc == 0 else None
    if m:
        cmd += ["--issue", m.group(1)]
    rc, out, err = runner(cmd, cwd, timeout=cost_table_timeout())
    for p in (ledger, splitf):
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp)
    except OSError:
        pass
    if rc != 0:
        why = reason_of(err)
        return "Record failed for !%d (cost-table exit %d%s). %s" % (
            iid,
            rc,
            ": " + why if why else "",
            manual,
        )
    # Advance this session's marker so its next `glab mr create` does not re-count this round's tokens.
    write_since(gitdir, sid, until)
    return "Posted the cost record for this fix round on !%d (window %s to %s)." % (
        iid,
        since,
        until,
    )


def round_main(argv):
    import argparse

    ap = argparse.ArgumentParser(prog="post-mr-cost.py --round")
    ap.add_argument("--mr", type=int, required=True)
    ap.add_argument("--session", default=os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    a = ap.parse_args(argv)
    print(process_round(a.mr, a.session, os.getcwd()))
    return 0


def retry_main(argv, runner=run, projects_dir=None):
    """Re-run the hook's own logic for an MR that already exists (the working manual fallback)."""
    import argparse

    ap = argparse.ArgumentParser(prog="post-mr-cost.py --retry")
    ap.add_argument("--mr", type=int, required=True)
    ap.add_argument("--session", default=os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    a = ap.parse_args(argv)
    payload = {
        "tool_name": "Bash",
        "tool_input": {"command": "glab mr create"},
        "tool_response": "/-/merge_requests/%d" % a.mr,
        "session_id": a.session,
        "cwd": os.getcwd(),
    }
    msg = process(payload, projects_dir=projects_dir, runner=runner)
    print(msg or "Nothing to post for !%d: %s." % (a.mr, OUTCOME["why"] or "silent"))
    return 0


def cli(argv, runner=run, projects_dir=None):
    if argv[:1] == ["--round"]:
        return round_main(argv[1:])
    if argv[:1] == ["--retry"]:
        return retry_main(argv[1:], runner, projects_dir)
    return main()


def main():
    try:
        payload = json.load(sys.stdin)
        msg = process(payload) if isinstance(payload, dict) else None
        if isinstance(payload, dict) and MR_CREATE_RE.search(
            (payload.get("tool_input") or {}).get("command", "") or ""
        ):
            log_firing(payload.get("cwd") or os.getcwd(), payload, msg)
    except Exception as e:  # noqa: BLE001 - a hook must never break the tool call it follows
        msg = (
            "MR cost comment hook errored (%s); post it by hand, see docs/harness/cost-ledger.md."
            % type(e).__name__
        )
        OUTCOME["why"] = "errored: " + type(e).__name__
    if msg:
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": msg,
            }
        }
        if not msg.startswith("Posted"):
            # additionalContext reaches only the model; systemMessage is what the user sees.
            out["systemMessage"] = msg
        print(json.dumps(out))
    return 0


def self_test():
    SLEEP[0] = lambda secs: None
    # A git hook (pre-push) exports GIT_DIR and friends, which would point the throwaway `git init`
    # repos below at the real checkout.
    for k in (
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_PREFIX",
    ):
        os.environ.pop(k, None)
    fails, n = [], [0]

    def check(name, cond, detail=""):
        n[0] += 1
        if not cond:
            fails.append(name + (" " + detail if detail else ""))

    url = "https://gitlab.com/trueppm/trueppm-suite/-/merge_requests/1745\n"
    check(
        "create + url -> iid",
        mr_iid("glab mr create --title x --yes", {"stdout": url}) == 1745,
    )
    check("create in a chain", mr_iid("git push && glab mr create --yes", url) == 1745)
    check("no create -> none", mr_iid("glab mr view 5", url) is None)
    check("no url -> none", mr_iid("glab mr create --yes", "boom") is None)
    check(
        "huge digit run is not an iid",
        mr_iid("glab mr create", "/-/merge_requests/" + "9" * 12) is None,
    )

    calls = []

    def runner_for(enabled_rc):
        def r(cmd, cwd, env=None, timeout=300):
            calls.append(cmd)
            if cmd[-1:] == ["enabled"]:
                return enabled_rc, "", ""
            return 0, "", ""

        return r

    payload = {
        "tool_name": "Bash",
        "tool_input": {"command": "glab mr create --yes"},
        "tool_response": {"stdout": url},
        "session_id": "abc-123",
        "cwd": os.getcwd(),
    }
    calls.clear()
    check(
        "ledger off -> silent no-op",
        process(payload, runner=runner_for(1)) is None and len(calls) == 1,
    )
    calls.clear()
    check(
        "ledger unreadable -> reported, nothing else runs",
        "unreadable" in (process(payload, runner=runner_for(2)) or "")
        and len(calls) == 1,
    )
    calls.clear()
    check(
        "non-MR command never touches anything",
        process(dict(payload, tool_input={"command": "ls"}), runner=runner_for(0))
        is None
        and not calls,
    )
    real_glab0 = globals()["glab_json"]
    try:
        globals()["glab_json"] = lambda path, cwd: [] if "notes" in path else {}
        check(
            "bad session id on a plain /mr is reported, not fatal",
            "no usable session id"
            in (process(dict(payload, session_id="../x"), runner=runner_for(0)) or ""),
        )
    finally:
        globals()["glab_json"] = real_glab0

    tmp = tempfile.mkdtemp(prefix="post-mr-cost-test-")
    sdir = os.path.join(tmp, "slug", "abc-123", "subagents")
    os.makedirs(sdir)
    for aid, parent, ts in (
        ("top1", None, "2026-11-07T10:00:00Z"),
        ("kid1", "top1", "2026-11-07T10:01:00Z"),
        ("old1", None, "2026-11-01T10:00:00Z"),
    ):
        with open(os.path.join(sdir, "agent-%s.meta.json" % aid), "w") as f:
            json.dump({"parentAgentId": parent} if parent else {}, f)
        with open(os.path.join(sdir, "agent-%s.jsonl" % aid), "w") as f:
            f.write(json.dumps({"type": "assistant", "timestamp": ts}) + "\n")
    got = top_level_agents(os.path.join(tmp, "slug", "abc-123"), "2026-11-05T00:00:00Z")
    check(
        "top-level agents in the window only (no descendants, none before since)",
        got == ["top1"],
    )
    check(
        "session dir resolves",
        find_session_dir("abc-123", tmp) == os.path.join(tmp, "slug", "abc-123"),
    )
    check("missing session dir -> None", find_session_dir("zzz", tmp) is None)
    check(
        "off marker regex",
        OFF_MARKER_RE.search("## Gates\ncost-ledger: off\n") is not None
        and OFF_MARKER_RE.search("cost-ledger: on") is None,
    )
    # The notes read: unreadable is reported (never the old silent 'exists'), readable-and-present is quiet.
    real_glab = globals()["glab_json"]
    try:
        globals()["glab_json"] = lambda path, cwd: (
            {} if path.endswith("%d" % 1745) else None
        )
        msg = process(payload, runner=runner_for(0))
        check(
            "unreadable notes are reported, not silent",
            msg is not None and "could not read its notes" in msg,
        )
        globals()["glab_json"] = lambda path, cwd: (
            [{"body": "## Cost of this MR (#1)"}] if "notes" in path else {}
        )
        check(
            "existing comment -> quiet",
            process(payload, runner=runner_for(0)) is None
            and OUTCOME["why"] == "a cost comment already exists",
        )
    finally:
        globals()["glab_json"] = real_glab
    # The log: one line per seen `glab mr create`, outcome text, no command text.
    gd = tempfile.mkdtemp(prefix="post-mr-cost-log-")
    subprocess.run(["git", "init", "-q", gd], check=False)
    secret = "glab mr create --description SECRET-TOKEN-xyz"
    log_firing(gd, dict(payload, tool_input={"command": secret}), None)
    try:
        with open(os.path.join(gd, ".git", "mr-cost-hook.log"), encoding="utf-8") as f:
            logged = f.read()
    except OSError:
        logged = ""
    check(
        "log line written with the outcome",
        "session=abc-123" in logged and "outcome=" in logged,
    )
    check("log never carries command text", "SECRET-TOKEN" not in logged)

    # --round: every gate must stop before anything is measured or posted.
    def round_runner(enabled_rc, since_rc=0, since="2026-11-07T14:00:00Z"):
        def r(cmd, cwd, env=None, timeout=300):
            calls.append(cmd)
            if cmd[-1:] == ["enabled"]:
                return enabled_rc, "", ""
            if "--next-since" in cmd:
                return since_rc, since + "\n", ""
            return 0, "", ""

        return r

    calls.clear()
    check(
        "round: ledger off -> nothing else runs",
        "is off" in process_round(7, "abc-123", os.getcwd(), runner=round_runner(1))
        and len(calls) == 1,
    )
    check(
        "round: bad session id is reported",
        "no usable session id"
        in process_round(7, "../x", os.getcwd(), runner=round_runner(0)),
    )
    check(
        "round: ISSUE_RE reads the branch",
        ISSUE_RE.search("fix/1234-thing").group(1) == "1234"
        and ISSUE_RE.search("chore/mr-cost-comment-enforcement") is None,
    )

    # --- paths the stub runner can reach: each has a negative control.
    base_url = "https://gitlab.com/trueppm/trueppm-suite/-/merge_requests/77\n"
    pl = {
        "tool_name": "Bash",
        "tool_input": {"command": "glab mr create --yes"},
        "tool_response": {"stdout": base_url},
        "session_id": "abc-123",
        "cwd": os.getcwd(),
    }
    gdir = tempfile.mkdtemp(prefix="post-mr-cost-git-")
    pdir = tempfile.mkdtemp(prefix="post-mr-cost-proj-")
    os.makedirs(os.path.join(pdir, "slug", "abc-123"))
    open(os.path.join(pdir, "slug", "abc-123.jsonl"), "w").close()

    TIMEOUTS = []

    def full_runner(
        log,
        git_ok=True,
        measure_ok=True,
        table_rc=0,
        table_err="",
        enabled_rc=0,
        since_rc=0,
        next_err="",
        branch="feat/321-x",
    ):
        def r(cmd, cwd, env=None, timeout=300):
            log.append(cmd)
            name = os.path.basename(cmd[1]) if len(cmd) > 1 else cmd[0]
            if cmd[-1:] == ["enabled"]:
                return enabled_rc, "", ""
            if cmd[:2] == ["git", "rev-parse"]:
                return (0, gdir + "\n", "") if git_ok else (128, "", "")
            if cmd[:2] == ["git", "branch"]:
                return 0, branch + "\n", ""
            if name == "cost-table.py":
                TIMEOUTS.append(timeout)
            if "--next-since" in cmd:
                return since_rc, "2026-11-07T14:00:00Z\n", next_err
            if name in ("subagent-tokens.py", "orchestrator-tokens.py"):
                if not measure_ok:
                    return 3, "", ""
                line = (
                    "subagent-tokens: 5"
                    if name.startswith("sub")
                    else "orchestrator-tokens: 6"
                )
                return 0, line + "\n", ""
            if name == "est-cost.py":
                return 0, "", ""
            if name == "cost-table.py":
                return table_rc, "", table_err
            return 0, "", ""

        return r

    marker = state_path(gdir, "abc-123")
    legacy = os.path.join(gdir, "mr-cost-last-until")

    def posted_until(cmds):
        """The --until value of the cost-table.py post, i.e. the window end the marker must hold."""
        for c in cmds:
            if len(c) > 1 and c[1].endswith("cost-table.py") and "--post" in c:
                return c[c.index("--until") + 1]
        return None

    def with_glab(desc, notes, fn):
        g = globals()["glab_json"]
        try:
            globals()["glab_json"] = lambda path, cwd: (
                notes if "notes" in path else desc
            )
            return fn()
        finally:
            globals()["glab_json"] = g

    ok_desc = {"description": "## Summary\nplain /mr, no ledger lines\n"}
    log = []
    msg = with_glab(
        ok_desc, [], lambda: process(pl, projects_dir=pdir, runner=full_runner(log))
    )
    check("happy path posts", msg is not None and msg.startswith("Posted"))
    check(
        "happy path writes mr-cost-last-until",
        posted_until(log) is not None
        and os.path.exists(marker)
        and open(marker).read() == posted_until(log) + "\n",
    )
    check(
        "happy path passes --issue from the command only when present",
        any("cost-table.py" in c[1] and "--post" in c for c in log if len(c) > 1),
    )
    os.remove(marker)
    msg = with_glab(
        ok_desc,
        [],
        lambda: process(pl, projects_dir=pdir, runner=full_runner([], table_rc=4)),
    )
    check("cost-table non-zero is reported", msg is not None and "failed" in msg)
    check("cost-table failure does not advance the marker", not os.path.exists(marker))

    # --- #4861: reason, working fallback, visible failure, per-session window.
    why_err = (
        "cost-table: could not post the note (glab api POST x timed out after 40s)\n"
    )
    msg = with_glab(
        ok_desc,
        [],
        lambda: process(
            pl,
            projects_dir=pdir,
            runner=full_runner([], table_rc=4, table_err="noise\n" + why_err),
        ),
    )
    check(
        "failure message carries cost-table's stderr reason",
        msg is not None and "timed out after 40s" in msg and "exit 4:" in msg,
        repr(msg),
    )
    gd2 = tempfile.mkdtemp(prefix="post-mr-cost-log2-")
    subprocess.run(["git", "init", "-q", gd2], check=False)
    log_firing(gd2, pl, msg)
    with open(os.path.join(gd2, ".git", "mr-cost-hook.log"), encoding="utf-8") as f:
        check("hook log carries the reason", "timed out after 40s" in f.read())
    m = re.search(
        r"python3 (scripts/post-mr-cost\.py [^ ]+(?: [^ ]+)*?) \(see", msg or ""
    )
    argv = shlex.split(m.group(1))[1:] if m else []
    check(
        "manual fallback names a real mode with --mr and --session",
        argv[:1] == ["--retry"] and "--mr" in argv and "--session" in argv,
        repr(argv),
    )
    # Execute the printed argv shape through the same dispatcher the script's __main__ uses.
    printed = io.StringIO()
    cwd0 = os.getcwd()
    with contextlib.redirect_stdout(printed):
        rc_cli = with_glab(
            ok_desc,
            [],
            lambda: cli(argv, runner=full_runner([]), projects_dir=pdir),
        )
    check(
        "manual fallback runs as printed and posts",
        rc_cli == 0 and printed.getvalue().startswith("Posted"),
        printed.getvalue(),
    )
    check("manual fallback runs in the checkout it was given", os.getcwd() == cwd0)
    if os.path.exists(marker):
        os.remove(marker)

    # G1: the outer cost-table timeout is derived from cost-table's own worst case, with margin.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "ct_consts", os.path.join(HERE, "cost-table.py")
    )
    ctm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ctm)
    TIMEOUTS.clear()
    with_glab(
        ok_desc, [], lambda: process(pl, projects_dir=pdir, runner=full_runner([]))
    )
    check(
        "cost-table's outer timeout exceeds its own retry worst case and fits the hook's 600s",
        TIMEOUTS
        and all(t == cost_table_timeout() for t in TIMEOUTS)
        and cost_table_timeout() > ctm.worst_case_seconds()
        and cost_table_timeout() == 337
        # reads: description + notes pages (cost_notes default max_pages) + user, each fully retried
        and cost_table_timeout()
        + (2 + COST_NOTES_PAGES) * (READ_ATTEMPTS * READ_TIMEOUT + sum(BACKOFF))
        + 30  # local measuring scripts
        < 600
        and ctm.NOTES_MAX_PAGES >= COST_NOTES_PAGES,
        repr((TIMEOUTS, ctm.worst_case_seconds())),
    )
    if os.path.exists(marker):
        os.remove(marker)

    # A comment that already exists advances the session window, but only from the token user's own
    # record that starts with the heading and ends no later than now; never backwards.
    def record(until):
        return "\n".join(
            ctm.comment_lines(
                "## Gates\nsubagent-tokens: 1\norchestrator-tokens: 2\n", 5, until
            )
        )

    def with_notes(notes, fn, me=1):
        g = globals()["glab_json"]
        try:
            globals()["glab_json"] = lambda path, cwd: (
                {"id": me} if path == "user" else notes if "notes" in path else ok_desc
            )
            return fn()
        finally:
            globals()["glab_json"] = g

    def run_hook():
        return process(pl, projects_dir=pdir, runner=full_runner([]))

    def marker_value():
        return open(marker).read().strip() if os.path.exists(marker) else None

    def fresh():
        for f in (marker, legacy):
            if os.path.exists(f):
                os.remove(f)

    OK_END = "2026-11-07T14:00:00Z"
    fresh()
    msg = with_notes([{"body": record(OK_END), "author": {"id": 1}}], run_hook)
    check(
        "own valid record: quiet, and the window marker moves to its end",
        msg is None and marker_value() == OK_END,
        repr((msg, marker_value())),
    )
    fresh()
    with_notes([{"body": record(OK_END), "author": {"id": 2}}], run_hook)
    check(
        "a FOREIGN record with a valid past end does not move the marker either",
        marker_value() is None,
        repr(marker_value()),
    )
    fresh()
    with_notes(
        [{"body": record("2099-01-01T00:00:00Z"), "author": {"id": 2}}], run_hook
    )
    check(
        "a FOREIGN record with a far-future end does not move the marker",
        marker_value() is None,
        repr(marker_value()),
    )
    fresh()
    msg = with_notes(
        [{"body": record("2099-01-01T00:00:00Z"), "author": {"id": 1}}], run_hook
    )
    check(
        "an OWN record ending after now does not move the marker past now (still quiet)",
        msg is None and marker_value() is None,
        repr(marker_value()),
    )
    fresh()
    with_notes([{"body": "intro\n" + record(OK_END), "author": {"id": 1}}], run_hook)
    check(
        "an own note that merely contains the heading (does not start with it) is ignored",
        marker_value() is None,
    )
    fresh()
    with_notes([{"body": record(OK_END)}], run_hook, me=None)
    check("an unreadable token user leaves the marker alone", marker_value() is None)
    write_since(gdir, "abc-123", "2026-11-07T18:00:00Z")
    with_notes([{"body": record(OK_END), "author": {"id": 1}}], run_hook)
    check(
        "existing record never moves the marker backwards",
        marker_value() == "2026-11-07T18:00:00Z",
    )
    fresh()
    # G2: reads are retried; paging reaches past 100 notes.
    real_run = globals()["run"]
    seq = []

    def flaky_run(cmd, cwd, env=None, timeout=300):
        seq.append(timeout)
        return (1, "", "boom") if len(seq) == 1 else (0, '{"ok": 1}', "")

    try:
        globals()["run"] = flaky_run
        got = glab_json("x", ".")
        n_after = len(seq)
        seq.clear()
        globals()["run"] = lambda cmd, cwd, env=None, timeout=300: (1, "", "boom")
        got_none = glab_json("x", ".")
    finally:
        globals()["run"] = real_run
    check(
        "glab_json retries a failed first read",
        got == {"ok": 1} and n_after == 2 and got_none is None,
        repr((got, n_after, got_none)),
    )
    pages = []

    def paged(path, cwd):
        pages.append(path)
        if path.endswith("&page=1"):
            return [{"body": "x"}] * 99 + [{"body": "## Cost of this MR (#1)"}]
        return [{"body": "## Cost of this MR (#2)"}]

    try:
        globals()["glab_json"] = paged
        found = cost_notes(77, ".")
    finally:
        globals()["glab_json"] = real_glab
    check(
        "cost_notes pages past 100 notes",
        found == [("## Cost of this MR (#1)", None), ("## Cost of this MR (#2)", None)]
        and len(pages) == 2,
        repr((found, pages)),
    )
    # G2: exit 1 (no record) and exit 4 (API failure) are told apart in --round.
    msg = with_glab(
        ok_desc,
        [],
        lambda: process_round(
            77,
            "abc-123",
            os.getcwd(),
            projects_dir=pdir,
            runner=full_runner(
                [], since_rc=4, next_err="x\ncost-table: HTTP 502 boom\n"
            ),
        ),
    )
    check(
        "round: exit 4 says the notes could not be read, with the reason",
        "could not read its notes" in msg
        and "HTTP 502 boom" in msg
        and "no readable record" not in msg,
        msg,
    )
    # G3 + G5(d): the printed fallback commands run as printed, from a sandboxed checkout root, via
    # subprocess, against a stub glab that dispatches on the full argv and records every call. The
    # sandbox owns its ledger setting ("on"), transcript and git dir, so nothing depends on the
    # developer's real environment.
    sandbox = tempfile.mkdtemp(prefix="post-mr-cost-sandbox-")
    shutil.copytree(
        HERE,
        os.path.join(sandbox, "scripts"),
        ignore=shutil.ignore_patterns("__pycache__", "tests"),
    )
    os.makedirs(os.path.join(sandbox, ".claude"))
    with open(os.path.join(sandbox, ".claude", "cost-ledger.json"), "w") as f:
        json.dump({"_doc": "test", "schema": 1, "cost-ledger": "on"}, f)
    subprocess.run(["git", "init", "-q", sandbox], check=False)
    home = os.path.join(sandbox, "home")
    tdir = os.path.join(home, ".claude", "projects", "slug")
    os.makedirs(tdir)
    with open(os.path.join(tdir, "abc-123.jsonl"), "w") as f:
        f.write(
            json.dumps(
                {
                    "type": "assistant",
                    "timestamp": "2026-11-05T12:00:00Z",
                    "message": {
                        "id": "m1",
                        "model": "claude-sonnet-5-5",
                        "usage": {
                            "input_tokens": 10,
                            "cache_creation_input_tokens": 0,
                            "cache_read_input_tokens": 0,
                            "output_tokens": 5,
                        },
                    },
                }
            )
            + "\n"
        )
    empty_cfg = os.path.join(sandbox, "empty-gitconfig")
    open(empty_cfg, "w").close()
    stubdir = os.path.join(sandbox, "bin")
    os.makedirs(stubdir)
    calls_file = os.path.join(sandbox, "glab-calls.jsonl")
    state_file = os.path.join(sandbox, "glab-state.json")
    with open(os.path.join(stubdir, "glab"), "w") as f:
        f.write(
            "#!/usr/bin/env python3\n"
            "import json, os, re, sys\n"
            "a = sys.argv[1:]\n"
            "assert a[:1] == ['api'], a\n"
            "a = a[1:]\n"
            "method, path, body, i = 'GET', None, None, 0\n"
            "while i < len(a):\n"
            "    if a[i] == '-X': method = a[i + 1]; i += 2\n"
            "    elif a[i] == '--input': body = sys.stdin.read(); i += 2\n"
            "    elif a[i] == '-H': i += 2\n"
            "    elif path is None: path = a[i]; i += 1\n"
            "    else: i += 1\n"
            "open(os.environ['STUB_CALLS'], 'a').write(json.dumps({'method': method, 'path': path, 'body': body}) + '\\n')\n"
            "st = json.load(open(os.environ['STUB_STATE']))\n"
            "out = {}\n"
            "if path == 'user': out = {'id': 1}\n"
            "elif re.search(r'merge_requests/\\d+/notes', path) and method == 'GET':\n"
            "    pg = int(re.search(r'[?&]page=(\\d+)', path).group(1))\n"
            "    out = st['notes'][(pg - 1) * 100: pg * 100]\n"
            "elif re.search(r'notes/(\\d+)$', path) and method == 'PUT':\n"
            "    nid = int(re.search(r'notes/(\\d+)$', path).group(1))\n"
            "    for n in st['notes']:\n"
            "        if n['id'] == nid: n['body'] = json.loads(body)['body']\n"
            "elif re.search(r'merge_requests/\\d+/notes$', path) and method == 'POST':\n"
            "    st['notes'].append({'id': 900 + len(st['notes']), 'system': False, 'author': {'id': 1}, 'body': json.loads(body)['body']})\n"
            "elif re.search(r'merge_requests/\\d+$', path):\n"
            "    out = {'description': 'x', 'source_branch': 'feat/321-x'}\n"
            "json.dump(st, open(os.environ['STUB_STATE'], 'w'))\n"
            "print(json.dumps(out))\n"
        )
    os.chmod(os.path.join(stubdir, "glab"), 0o755)
    penv = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "CLAUDE"))}
    penv.update(
        PATH=stubdir + os.pathsep + os.environ.get("PATH", ""),
        HOME=home,
        GIT_CONFIG_GLOBAL=empty_cfg,
        GIT_CONFIG_NOSYSTEM="1",
        STUB_CALLS=calls_file,
        STUB_STATE=state_file,
    )

    def sandbox_run(printed, notes):
        """Run the printed command line exactly as written, from the sandbox root; (proc, calls, state)."""
        with open(state_file, "w") as f:
            json.dump({"notes": notes}, f)
        if os.path.exists(calls_file):
            os.remove(calls_file)
        mm = re.search(r"python3 (scripts/post-mr-cost\.py .*?) \(see", printed or "")
        pargs = shlex.split(mm.group(1)) if mm else []
        if not pargs:
            return None, [], {}
        r = subprocess.run(
            [sys.executable] + pargs,
            cwd=sandbox,
            env=penv,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=120,
        )
        try:
            with open(calls_file) as f:
                made = [json.loads(ln) for ln in f if ln.strip()]
        except OSError:
            made = []
        with open(state_file) as f:
            return r, made, json.load(f)

    rec1_note = {
        "id": 10,
        "system": False,
        "author": {"id": 1},
        "body": "\n".join(
            ctm.comment_lines(
                "## Gates\nsubagent-tokens: 1\norchestrator-tokens: 2\n",
                5,
                "2026-11-04T12:00:00Z",
            )
        ),
    }
    fail_round = with_glab(
        ok_desc,
        [],
        lambda: process_round(
            77,
            "abc-123",
            os.getcwd(),
            projects_dir=pdir,
            runner=full_runner([], table_rc=4),
        ),
    )
    fail_hook = with_glab(
        ok_desc,
        [],
        lambda: process(pl, projects_dir=pdir, runner=full_runner([], table_rc=4)),
    )
    for label, text, mode in (
        ("round", fail_round, "--round"),
        ("retry", fail_hook, "--retry"),
    ):
        mm = re.search(r"python3 (scripts/post-mr-cost\.py .*?) \(see", text or "")
        pargs = shlex.split(mm.group(1)) if mm else []
        check(
            "%s message prints a %s command" % (label, mode),
            pargs[1:2] == [mode] and "..." not in (text or ""),
            repr(text),
        )
        notes = [] if mode == "--retry" else [rec1_note]
        r, made, state = sandbox_run(text, notes)
        check(
            "%s command runs as printed from the checkout root" % label,
            r is not None
            and r.returncode == 0
            and "usage" not in r.stderr.lower()
            and "error" not in r.stderr.lower(),
            repr(r and (r.returncode, r.stdout, r.stderr)),
        )
        writes = [c for c in made if c["method"] in ("POST", "PUT")]
        bodies = [json.loads(c["body"])["body"] for c in writes if c["body"]]
        if mode == "--retry":
            check(
                "printed --retry command POSTs a record 1 body",
                len(writes) == 1
                and writes[0]["method"] == "POST"
                and bodies[0].startswith("## Cost of this MR")
                and "record" not in bodies[0].split("\n")[0],
                repr((r and r.stdout, r and r.stderr, writes)),
            )
        else:
            check(
                "printed --round command posts record 2",
                len(writes) == 1
                and bodies[0].startswith("## Cost of this MR")
                and "record 2" in bodies[0].split("\n")[0],
                repr((r and r.stdout, r and r.stderr, writes)),
            )
    # G5(e): a REAL failed cost-table run (stubbed glab exits 1 with stderr) puts its reason in the log line.
    bad = tempfile.mkdtemp(prefix="post-mr-cost-badglab-")
    with open(os.path.join(bad, "glab"), "w") as f:
        f.write("#!/bin/sh\necho 'HTTP 502 boom' >&2\nexit 1\n")
    os.chmod(os.path.join(bad, "glab"), 0o755)
    benv = dict(os.environ, PATH=bad + os.pathsep + os.environ.get("PATH", ""))
    driver = (
        "import importlib.util,sys;"
        "s=importlib.util.spec_from_file_location('ct',sys.argv[1]);"
        "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
        "m.SLEEP[0]=lambda x:None;"
        "sys.exit(m.main(sys.argv[2:],enabled=lambda:0))"
    )
    base_runner = full_runner([])

    def real_table_runner(cmd, cwd, env=None, timeout=300):
        if len(cmd) > 1 and cmd[1].endswith("cost-table.py"):
            return run(
                [sys.executable, "-c", driver, cmd[1]] + cmd[2:],
                cwd,
                env=benv,
                timeout=120,
            )
        return base_runner(cmd, cwd, env=env, timeout=timeout)

    msg = with_glab(
        ok_desc, [], lambda: process(pl, projects_dir=pdir, runner=real_table_runner)
    )
    gd3 = tempfile.mkdtemp(prefix="post-mr-cost-log3-")
    subprocess.run(["git", "init", "-q", gd3], check=False)
    log_firing(gd3, pl, msg)
    with open(os.path.join(gd3, ".git", "mr-cost-hook.log"), encoding="utf-8") as f:
        logged3 = f.read()
    check(
        "a real failed cost-table run: its stderr reason reaches the hook message and log line",
        "HTTP 502 boom" in (msg or "") and "HTTP 502 boom" in logged3,
        repr((msg, logged3)),
    )
    if os.path.exists(marker):
        os.remove(marker)

    # A failure reaches the user as a systemMessage; success does not.
    def hook_out(fn_msg):
        real_process = globals()["process"]
        real_stdin = sys.stdin
        buf = io.StringIO()
        try:
            globals()["process"] = lambda payload: fn_msg
            sys.stdin = io.StringIO(json.dumps(dict(pl)))
            with contextlib.redirect_stdout(buf):
                main()
        finally:
            globals()["process"] = real_process
            sys.stdin = real_stdin
        return json.loads(buf.getvalue()) if buf.getvalue().strip() else None

    out = hook_out("MR cost comment failed for !77 (cost-table exit 4). x")
    check(
        "failure emits a systemMessage",
        out is not None
        and out.get("systemMessage", "").startswith("MR cost comment failed"),
        repr(out),
    )
    out = hook_out("Posted the `## Cost of this MR` comment on !77")
    check(
        "success has no systemMessage", out is not None and "systemMessage" not in out
    )
    # Two sessions: neither moves the other's window; the legacy unkeyed file is a fallback only.
    for f in (marker, legacy, state_path(gdir, "other-9")):
        if os.path.exists(f):
            os.remove(f)
    write_since(gdir, "abc-123", "2026-11-07T10:00:00Z")
    write_since(gdir, "other-9", "2026-11-07T12:00:00Z")
    check(
        "per-session window: each session reads its own",
        read_since(gdir, "abc-123") == "2026-11-07T10:00:00Z"
        and read_since(gdir, "other-9") == "2026-11-07T12:00:00Z",
    )
    write_since(gdir, "other-9", "2026-11-07T15:00:00Z")
    check(
        "per-session window: B's post leaves A's untouched",
        read_since(gdir, "abc-123") == "2026-11-07T10:00:00Z",
    )
    check("no state at all -> epoch", read_since(gdir, "fresh-1") == EPOCH)
    with open(legacy, "w") as f:
        f.write("2026-11-06T09:00:00Z\n")
    check(
        "legacy unkeyed file is read only when no keyed one exists",
        read_since(gdir, "fresh-1") == "2026-11-06T09:00:00Z"
        and read_since(gdir, "abc-123") == "2026-11-07T10:00:00Z",
    )
    os.remove(legacy)
    log = []
    with_glab(
        ok_desc, [], lambda: process(pl, projects_dir=pdir, runner=full_runner(log))
    )
    check(
        "process writes only the keyed file",
        os.path.exists(marker) and not os.path.exists(legacy),
    )
    os.remove(marker)
    log = []
    msg = with_glab(
        {"description": "## Gates\ncost-ledger: off\n"},
        [],
        lambda: process(pl, projects_dir=pdir, runner=full_runner(log)),
    )
    check(
        "description cost-ledger: off -> quiet, nothing measured",
        msg is None and not any("cost-table.py" in " ".join(c) for c in log),
    )
    log = []
    msg = with_glab(
        None, [], lambda: process(pl, projects_dir=pdir, runner=full_runner(log))
    )
    check(
        "unreadable description is reported and nothing is posted",
        msg is not None
        and "could not read its description" in msg
        and not any("cost-table.py" in " ".join(c) for c in log),
    )
    msg = with_glab(
        ok_desc,
        [],
        lambda: process(pl, projects_dir=tempfile.mkdtemp(), runner=full_runner([])),
    )
    check(
        "no transcript -> reported", msg is not None and "transcript not found" in msg
    )
    msg = with_glab(
        ok_desc,
        [],
        lambda: process(pl, projects_dir=pdir, runner=full_runner([], git_ok=False)),
    )
    check(
        "not a git checkout -> reported",
        msg is not None and "not in a git checkout" in msg,
    )
    msg = with_glab(
        ok_desc,
        [],
        lambda: process(
            pl, projects_dir=pdir, runner=full_runner([], measure_ok=False)
        ),
    )
    check(
        "nothing measurable -> reported",
        msg is not None and "nothing measurable" in msg,
    )
    msg = process(pl, runner=full_runner([], enabled_rc=2))
    check(
        "unreadable ledger setting is surfaced to the session",
        msg is not None and "unreadable" in msg,
    )
    check(
        "plain off stays silent",
        process(pl, runner=full_runner([], enabled_rc=1)) is None,
    )
    # Wave-shaped: the description's ledger lines win; the measuring path is unreachable.
    import importlib.util as ilu

    spec_ = ilu.spec_from_file_location(
        "ct_selftest", os.path.join(HERE, "cost-table.py")
    )
    ctm = ilu.module_from_spec(spec_)
    spec_.loader.exec_module(ctm)
    ledger = "## Gates\nsubagent-tokens: 3571566\norchestrator-tokens: 7213540\nest-cost-usd: 3.08\n"
    created = datetime.datetime(2026, 11, 7, 15, 0, tzinfo=datetime.timezone.utc)
    ct = created.timestamp()
    measuring = ("subagent-tokens.py", "orchestrator-tokens.py", "est-cost.py")

    def split_for(sub, orch):
        return (
            "subagent-tokens: model claude-sonnet-5-5 %d\n"
            "orchestrator-tokens: model claude-opus-4-8 %d\n" % (sub, orch)
        )

    def wave_mr(
        iid_,
        description,
        split_age=None,
        split_text=None,
        sid="abc-123",
        created_at="2026-11-07T15:00:00.000Z",
    ):
        """Run the hook for one MR of a wave; return (msg, commands, desc as cost-table saw it)."""
        for fn in (marker, os.path.join(gdir, SPLIT_NAME)):
            if os.path.exists(fn):
                os.remove(fn)
        if split_age is not None:
            sp = os.path.join(gdir, SPLIT_NAME)
            with open(sp, "w") as f:
                f.write(
                    split_text
                    if split_text is not None
                    else split_for(3571566, 7213540)
                )
            os.utime(sp, (ct - split_age, ct - split_age))
        log_, seen_ = [], []
        base = full_runner(log_)

        def r(cmd, cwd, env=None, timeout=300):
            if len(cmd) > 2 and cmd[1].endswith("cost-table.py") and "--file" in cmd:
                with open(cmd[cmd.index("--file") + 1], encoding="utf-8") as f:
                    seen_.append(f.read())
            return base(cmd, cwd, env=env, timeout=timeout)

        pl_ = dict(
            pl,
            session_id=sid,
            tool_response={
                "stdout": "https://gitlab.com/x/-/merge_requests/%d\n" % iid_
            },
        )
        d_ = {"description": description, "created_at": created_at}
        m_ = with_glab(d_, [], lambda: process(pl_, projects_dir=pdir, runner=r))
        return m_, log_, seen_

    def cmds(log_, names):
        return [c for c in log_ if len(c) > 1 and os.path.basename(c[1]) in names]

    def readable_end(cmd, description):
        """Render record 1 with the hook's own argv for real and read its window end back."""
        until_ = cmd[cmd.index("--until") + 1]
        rec = ctm.parse_record(
            "\n".join(ctm.comment_lines(description, None, until_, None))
        )
        return rec is not None and rec["end"] is not None

    for k, iid_ in enumerate((3245, 3246, 3248)):
        desc_k = ledger.replace("3571566", str(3571566 + k))
        m_, log_, seen_ = wave_mr(
            iid_, desc_k, split_age=600, split_text=split_for(3571566 + k, 7213540)
        )
        tbl = cmds(log_, ("cost-table.py",))
        check(
            "wave MR %d: posted from the description's ledger" % iid_,
            m_ is not None and m_.startswith("Posted") and len(tbl) == 1,
        )
        check(
            "wave MR %d: cost-table saw the description's own figures" % iid_,
            seen_ == [desc_k],
        )
        check(
            "wave MR %d: nothing was re-measured" % iid_,
            not cmds(log_, measuring),
        )
        check(
            "wave MR %d: a matching split is passed with its mtime as --until" % iid_,
            "--split" in tbl[0]
            and tbl[0][tbl[0].index("--until") + 1]
            == datetime.datetime.fromtimestamp(
                ct - 600, datetime.timezone.utc
            ).strftime(TS_FMT),
        )
        check(
            "wave MR %d: neither the keyed nor the legacy marker is written" % iid_,
            not os.path.exists(marker) and not os.path.exists(legacy),
        )
    for label, age, txt in (
        ("absent", None, None),
        ("newer than the MR", -60, None),
        ("more than 2h older than the MR", 3 * 3600, None),
        ("not matching the description's sums", 600, split_for(5, 6)),
    ):
        m_, log_, _ = wave_mr(3249, ledger, split_age=age, split_text=txt)
        tbl = cmds(log_, ("cost-table.py",))
        check(
            "split %s: totals only, --until still passed, never measured" % label,
            m_ is not None
            and "split n/a" in m_
            and len(tbl) == 1
            and "--split" not in tbl[0]
            and "--until" in tbl[0]
            and tbl[0][tbl[0].index("--until") + 1] == "2026-11-07T15:00:00Z"
            and "MR creation time" in m_
            and not cmds(log_, measuring),
        )
        check(
            "split %s: record 1 still has a readable window end (--next-since)" % label,
            len(tbl) == 1 and readable_end(tbl[0], ledger),
        )
    m_, log_, _ = wave_mr(3249, ledger, created_at="garbage")
    tbl = cmds(log_, ("cost-table.py",))
    check(
        "unparseable created_at falls back to now for --until",
        len(tbl) == 1
        and re.match(
            r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z", tbl[0][tbl[0].index("--until") + 1]
        )
        is not None
        and tbl[0][tbl[0].index("--until") + 1] != "2026-11-07T15:00:00Z",
    )
    # A split with nothing non-zero to compare against is dropped, not vacuously accepted.
    vac = "## Gates\norchestrator-tokens: current session only\nest-cost-usd: 3.08\n"
    sp_ = os.path.join(gdir, SPLIT_NAME)
    with open(sp_, "w") as f:
        f.write(split_for(0, 7213540))
    check(
        "split is dropped when the description has no figure to compare",
        split_matches(vac, sp_)[0] is False,
    )
    zero = "## Gates\nsubagent-tokens: 0\n"
    with open(sp_, "w") as f:
        f.write("")
    check(
        "a zero figure matching an empty split is vacuous, so dropped",
        split_matches(zero, sp_)[0] is False,
    )
    with open(sp_, "w") as f:
        f.write(split_for(0, 7213540))
    check(
        "one non-zero matching side keeps the split",
        split_matches(
            "## Gates\nsubagent-tokens: 0\norchestrator-tokens: 7213540\n", sp_
        )[0]
        is True,
    )
    # Marker: never written on this path, so it cannot move backward.
    with open(marker, "w") as f:
        f.write("2026-11-07T16:00:00Z\n")
    base_ = full_runner([])
    sp_ = os.path.join(gdir, SPLIT_NAME)
    with open(sp_, "w") as f:
        f.write(split_for(3571566, 7213540))
    os.utime(sp_, (ct - 3000, ct - 3000))  # older than the marker
    with_glab(
        {"description": ledger, "created_at": "2026-11-07T15:00:00.000Z"},
        [],
        lambda: process(pl, projects_dir=pdir, runner=base_),
    )
    check(
        "an older split cannot lower mr-cost-last-until",
        open(marker).read() == "2026-11-07T16:00:00Z\n",
    )
    # Ledger keys in any shape (Notes, fence, quote, list item) are still a ledger: never measured.
    for label, body in (
        ("under ## Notes", "## Notes\nsubagent-tokens: 5\n"),
        ("in a fence", "## Notes\n```\norchestrator-tokens: 5\n```\n"),
        ("in a blockquote", "> est-cost-usd: 3.08\n"),
        ("as a list item", "## Summary\n- subagent-tokens: 5\n"),
        ("malformed", "## Gates\nest-cost-usd: lots\n"),
    ):
        m_, log_, _ = wave_mr(3252, body)
        check(
            "ledger key %s: rendered by cost-table, never measured" % label,
            len(cmds(log_, ("cost-table.py",))) == 1 and not cmds(log_, measuring),
        )
    # --retry re-runs process(), so a wave MR must go through the description branch there too.
    retry_log = []
    out_ = io.StringIO()
    with contextlib.redirect_stdout(out_):
        with_glab(
            {"description": ledger, "created_at": "2026-11-07T15:00:00.000Z"},
            [],
            lambda: cli(
                ["--retry", "--mr", "3245", "--session", "abc-123"],
                runner=full_runner(retry_log),
                projects_dir=pdir,
            ),
        )
    check(
        "--retry on a wave MR posts from the description and never measures",
        "from the description's ledger lines" in out_.getvalue()
        and len(cmds(retry_log, ("cost-table.py",))) == 1
        and not cmds(retry_log, measuring),
        out_.getvalue(),
    )
    check(
        "ledger_in_description: plain text is not a ledger",
        not ledger_in_description(
            "## Summary\nthe subagent-tokens: figure is in prose\nx"
        )
        and ledger_in_description("a\n  - Est-Cost-USD : 1.00\n"),
    )
    m_, log_, _ = wave_mr(3250, "## Summary\nplain\n")
    check(
        "plain /mr (no ledger key anywhere) is still measured and posted",
        m_ is not None
        and m_.startswith("Posted")
        and bool(cmds(log_, ("subagent-tokens.py",))),
    )
    m_, log_, _ = wave_mr(3253, ledger, sid="../x")
    check(
        "a wave MR still gets its comment with no usable session id",
        m_ is not None and m_.startswith("Posted") and not cmds(log_, measuring),
    )
    m_, log_, _ = wave_mr(3254, ledger, sid="no-such-session")
    check(
        "a wave MR still gets its comment with no transcript",
        m_ is not None and m_.startswith("Posted") and not cmds(log_, measuring),
    )
    # A cost-table that cannot be loaded drops the split; the comment is not suppressed.
    real_here = HERE
    sp_ = os.path.join(gdir, SPLIT_NAME)
    with open(sp_, "w") as f:
        f.write(split_for(3571566, 7213540))
    os.utime(sp_, (ct - 600, ct - 600))
    broken = tempfile.mkdtemp(prefix="post-mr-cost-broken-")
    with open(os.path.join(broken, "cost-table.py"), "w") as f:
        f.write("raise ImportError('boom')\n")
    try:
        globals()["HERE"] = broken
        ok_, why_ = split_matches(ledger, sp_)
    finally:
        globals()["HERE"] = real_here
    check(
        "an unloadable cost-table drops the split instead of raising",
        ok_ is False and "could not be checked" in why_,
    )
    for fn in (marker, sp_):
        if os.path.exists(fn):
            os.remove(fn)
    # process_round
    msg = with_glab(
        ok_desc,
        [],
        lambda: process_round(
            77,
            "abc-123",
            os.getcwd(),
            projects_dir=pdir,
            runner=full_runner([], since_rc=1),
        ),
    )
    check("round: record 1 missing -> skipped", "no readable record 1" in msg)
    log = []
    msg = with_glab(
        {"description": "cost-ledger: off"},
        [],
        lambda: process_round(
            77, "abc-123", os.getcwd(), projects_dir=pdir, runner=full_runner(log)
        ),
    )
    check(
        "round: off marker -> nothing measured",
        "cost-ledger: off" in msg
        and not any("cost-table.py" in " ".join(c) for c in log),
    )
    msg = with_glab(
        None,
        [],
        lambda: process_round(
            77, "abc-123", os.getcwd(), projects_dir=pdir, runner=full_runner([])
        ),
    )
    check(
        "round: unreadable description is reported",
        "could not read its description" in msg,
    )
    check(
        "round: unreadable ledger setting is reported",
        "unreadable"
        in process_round(
            77, "abc-123", os.getcwd(), runner=full_runner([], enabled_rc=2)
        ),
    )
    if os.path.exists(marker):
        os.remove(marker)
    log = []
    msg = with_glab(
        ok_desc,
        [],
        lambda: process_round(
            77, "abc-123", os.getcwd(), projects_dir=pdir, runner=full_runner(log)
        ),
    )
    check("round: happy path posts", msg.startswith("Posted"))
    check(
        "round: mr-cost-last-until holds the posted window end",
        posted_until(log) is not None
        and os.path.exists(marker)
        and open(marker).read() == posted_until(log) + "\n",
    )
    check(
        "round: issue number comes from the branch name",
        any("--issue" in c and "321" in c for c in log),
    )
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("self-test OK (%d checks)" % n[0])
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    sys.exit(cli(sys.argv[1:]))
