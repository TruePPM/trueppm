#!/usr/bin/env python3
"""Fail on Breaking API changes against the latest released OpenAPI schema (#4594).

``packages/website/src/content/docs/api/stability.md`` promises a deprecation window
for every *Breaking* change: removing or renaming an endpoint or field, changing a
field type, changing a status code, making an optional field required, removing an
enum value. ``check-schema-regression.py`` compares only path and component-schema
*names* against ``main``, so it sees none of those classes, and a field dropped in
one MR becomes the baseline for the next. This gate diffs the *shape* of the schema
against the latest ``v*`` release tag (prereleases included) instead, so a drift is
measured against what users actually have.

Rules (each finding carries one rule id):

* ``endpoint-removed``    - a path or HTTP method present in the baseline is gone
* ``status-removed``      - a documented response status code is gone
* ``media-type-removed``  - a request/response media type is gone
* ``param-removed``       - a query/header/path parameter is gone
* ``param-required``      - a parameter became required (or a new required one appeared)
* ``property-removed``    - a request/response property is gone
* ``type-changed``        - a ``type`` changed (``integer`` -> ``string``, ...)
* ``enum-value-removed``  - an enum value is gone (additions are NOT breaking)
* ``became-required``     - a request property became required, or a new required
  request property appeared (optional -> required)

Deliberately out of scope (documented, not silent): ``oneOf``/``anyOf`` branches are
not diffed (``allOf`` is flattened), ``format``/``nullable``/constraint changes are
Behavioral per stability.md, and unknown vendor keys such as an ``x-extensible-enum``
marker are ignored, so adding one never trips the gate.

Allowlist (``scripts/schema-breaking-allowlist.txt``): one line per accepted break::

    <rule> | <location glob> | <stability.md heading anchor> | <reason>

The anchor must name a ``###`` heading under ``## Current deprecations`` in
stability.md - the gate verifies the row exists - so a break cannot be waved through
without being published to integrators. Entries that no longer match anything are
reported as stale (not an error: the baseline moves forward at each release).

Usage:
    check-schema-breaking.py [--candidate docs/api/openapi.json]
                             [--baseline-ref v0.4.0-beta.9 | --baseline-file F]
                             [--require-baseline] [--list]
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
_ALLOWLIST = os.path.join(_HERE, "schema-breaking-allowlist.txt")
_STABILITY = os.path.join(
    _REPO, "packages", "website", "src", "content", "docs", "api", "stability.md"
)
_SCHEMA_REL = "docs/api/openapi.json"
_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
_TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")

Finding = tuple[str, str]  # (rule, location)


# --------------------------------------------------------------------------- tags
def _semver_key(tag: str) -> tuple[Any, ...] | None:
    m = _TAG_RE.match(tag)
    if not m:
        return None
    core = tuple(int(x) for x in m.groups()[:3])
    pre = m.group(4)
    if pre is None:
        return (*core, 1, ())  # a release outranks its own prereleases
    ids = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return (*core, 0, ids)


def latest_release_tag(tags: list[str]) -> str | None:
    """Highest SemVer ``vX.Y.Z[-pre]`` tag; ``mcp-v*`` / ``scheduler-v*`` never match."""
    keyed = [(k, t) for t in tags if (k := _semver_key(t)) is not None]
    return max(keyed)[1] if keyed else None


# ------------------------------------------------------------------------- differ
class _Differ:
    def __init__(self, base: dict[str, Any], cand: dict[str, Any]) -> None:
        self.base, self.cand = base, cand
        self.findings: set[Finding] = set()
        self._seen: set[tuple[str, str, str]] = set()

    def add(self, rule: str, loc: str) -> None:
        self.findings.add((rule, loc))

    @staticmethod
    def _deref(doc: dict[str, Any], node: Any) -> tuple[Any, str | None]:
        name = None
        hops = 0
        while isinstance(node, dict) and "$ref" in node and hops < 20:
            ref = node["$ref"]
            name = ref.rsplit("/", 1)[-1]
            cur: Any = doc
            for part in ref.lstrip("#/").split("/"):
                cur = cur.get(part, {}) if isinstance(cur, dict) else {}
            node = cur
            hops += 1
        return node, name

    def _flatten(
        self, doc: dict[str, Any], node: Any
    ) -> tuple[dict[str, Any], str | None]:
        """Resolve ``$ref`` and merge ``allOf`` into one property/required view."""
        node, name = self._deref(doc, node)
        if not isinstance(node, dict):
            return {}, name
        out = {k: v for k, v in node.items() if k != "allOf"}
        props = dict(out.get("properties") or {})
        req = list(out.get("required") or [])
        for part in node.get("allOf") or []:
            sub, _ = self._flatten(doc, part)
            props.update(sub.get("properties") or {})
            req += sub.get("required") or []
            for k in ("type", "enum", "items"):
                if k in sub and k not in out:
                    out[k] = sub[k]
        if props:
            out["properties"] = props
        if req:
            out["required"] = req
        return out, name

    def schema(self, b: Any, c: Any, loc: str, direction: str) -> None:
        bs, bname = self._flatten(self.base, b)
        cs, cname = self._flatten(self.cand, c)
        if bname and cname and bname != cname:
            # The operation now points at a DIFFERENT component. Anchor findings to
            # the operation so an allowlist glob cannot also hide a future removal
            # from either component.
            loc = f"{loc} [{bname}->{cname}]"
        elif bname:  # diff each named component once per direction, not per use
            key = (direction, bname, cname or "")
            if key in self._seen:
                return
            self._seen.add(key)
            loc = f"#/{bname}"
        if not bs or not cs:
            return
        bt, ct = bs.get("type"), cs.get("type")
        if bt and ct and bt != ct:
            self.add("type-changed", f"{direction} {loc}")
            return
        benum, cenum = bs.get("enum"), cs.get("enum")
        if benum and cenum:
            for v in benum:
                if v not in cenum:
                    self.add("enum-value-removed", f"{direction} {loc} ={v}")
        if bt == "array" or "items" in bs:
            self.schema(bs.get("items", {}), cs.get("items", {}), f"{loc}[]", direction)
        bp, cp = bs.get("properties") or {}, cs.get("properties") or {}
        breq, creq = set(bs.get("required") or []), set(cs.get("required") or [])
        for prop, bsub in bp.items():
            ploc = f"{loc}.{prop}"
            if prop not in cp:
                self.add("property-removed", f"{direction} {ploc}")
                continue
            if direction == "request" and prop in creq - breq:
                if not cp[prop].get("readOnly") if isinstance(cp[prop], dict) else True:
                    self.add("became-required", f"{direction} {ploc}")
            self.schema(bsub, cp[prop], ploc, direction)
        if direction == "request":
            for prop in creq - set(bp):
                sub, _ = self._flatten(self.cand, cp.get(prop, {}))
                if prop in cp and not sub.get("readOnly"):
                    self.add("became-required", f"{direction} {loc}.{prop}")

    def operation(self, loc: str, b: dict[str, Any], c: dict[str, Any]) -> None:
        bparams = {(p["name"], p["in"]): p for p in self._params(self.base, b)}
        cparams = {(p["name"], p["in"]): p for p in self._params(self.cand, c)}
        for (name, where), bp in bparams.items():
            if (name, where) not in cparams:
                self.add("param-removed", f"{loc} {where}:{name}")
                continue
            cp = cparams[(name, where)]
            if cp.get("required") and not bp.get("required"):
                self.add("param-required", f"{loc} {where}:{name}")
            self.schema(
                bp.get("schema", {}),
                cp.get("schema", {}),
                f"{loc} {where}:{name}",
                "request",
            )
        for key, cp in cparams.items():
            if key not in bparams and cp.get("required"):
                self.add("param-required", f"{loc} {key[1]}:{key[0]}")
        brb, _ = self._deref(self.base, b.get("requestBody", {}))
        crb, _ = self._deref(self.cand, c.get("requestBody", {}))
        self._content(brb, crb, f"{loc} body", "request")
        bresp, cresp = b.get("responses", {}), c.get("responses", {})
        for code, br in bresp.items():
            if code not in cresp:
                self.add("status-removed", f"{loc} {code}")
                continue
            bd, _ = self._deref(self.base, br)
            cd, _ = self._deref(self.cand, cresp[code])
            self._content(bd, cd, f"{loc} {code}", "response")

    def _content(self, b: Any, c: Any, loc: str, direction: str) -> None:
        bc = (b or {}).get("content") or {}
        cc = (c or {}).get("content") or {}
        for mt, bm in bc.items():
            if mt not in cc:
                self.add("media-type-removed", f"{loc} {mt}")
                continue
            self.schema(bm.get("schema", {}), cc[mt].get("schema", {}), loc, direction)

    def _params(self, doc: dict[str, Any], op: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for p in op.get("parameters", []):
            d, _ = self._deref(doc, p)
            if isinstance(d, dict) and "name" in d and "in" in d:
                out.append(d)
        return out

    def run(self) -> set[Finding]:
        bpaths, cpaths = self.base.get("paths", {}), self.cand.get("paths", {})
        for path, bitem in bpaths.items():
            citem = cpaths.get(path)
            for method in _METHODS:
                if method not in bitem:
                    continue
                loc = f"{method.upper()} {path}"
                if not citem or method not in citem:
                    self.add("endpoint-removed", loc)
                    continue
                bop, cop = dict(bitem[method]), dict(citem[method])
                # path-level parameters apply to every method
                bop["parameters"] = bitem.get("parameters", []) + bop.get(
                    "parameters", []
                )
                cop["parameters"] = citem.get("parameters", []) + cop.get(
                    "parameters", []
                )
                self.operation(loc, bop, cop)
        return self.findings


def diff_schemas(base: dict[str, Any], cand: dict[str, Any]) -> list[Finding]:
    """Return sorted ``(rule, location)`` Breaking findings of ``cand`` vs ``base``."""
    return sorted(_Differ(base, cand).run())


# ---------------------------------------------------------------------- allowlist
def deprecation_anchors(stability_path: str = _STABILITY) -> set[str]:
    """Slugs of the ``###`` headings under ``## Current deprecations``."""
    anchors: set[str] = set()
    if not os.path.exists(stability_path):
        return anchors
    inside = False
    with open(stability_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("## "):
                inside = line.strip().lower() == "## current deprecations"
            elif inside and line.startswith("### "):
                text = re.sub(r"[`*_]", "", line[4:].strip()).lower()
                slug = re.sub(r"[^a-z0-9 -]", "", text).replace(" ", "-")
                anchors.add(slug)
    return anchors


def load_allowlist(
    path: str, anchors: set[str]
) -> tuple[list[tuple[str, str, str, int]], list[str]]:
    """Parse the allowlist; return ``(entries, errors)``."""
    entries: list[tuple[str, str, str, int]] = []
    errors: list[str] = []
    if not os.path.exists(path):
        return entries, errors
    with open(path, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            # full-line comments only: "#" is legal inside a location ("#/Name.prop")
            line = "" if raw.lstrip().startswith("#") else raw.strip()
            if not line:
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 3 or not all(parts[:3]):
                errors.append(
                    f"{path}:{n}: want '<rule> | <location glob> | <anchor> | <reason>'"
                )
                continue
            rule, glob, anchor = parts[:3]
            anchor = anchor.lstrip("#")
            if anchor not in anchors:
                errors.append(
                    f"{path}:{n}: anchor '{anchor}' is not a '###' heading under "
                    "'## Current deprecations' in stability.md - publish the deprecation first"
                )
                continue
            entries.append((rule, glob, anchor, n))
    return entries, errors


def apply_allowlist(
    findings: list[Finding], entries: list[tuple[str, str, str, int]]
) -> tuple[list[Finding], list[int]]:
    used: set[int] = set()
    remaining: list[Finding] = []
    for rule, loc in findings:
        hit = False
        for erule, glob, _a, n in entries:
            if erule in (rule, "*") and fnmatch.fnmatchcase(loc, glob):
                used.add(n)
                hit = True
        if not hit:
            remaining.append((rule, loc))
    stale = [n for *_x, n in entries if n not in used]
    return remaining, stale


# --------------------------------------------------------------------------- main
def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", _REPO, *args], capture_output=True, text=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--candidate", default=os.path.join(_REPO, _SCHEMA_REL))
    ap.add_argument("--baseline-file")
    ap.add_argument("--baseline-ref")
    ap.add_argument("--allowlist", default=_ALLOWLIST)
    ap.add_argument("--stability", default=_STABILITY)
    ap.add_argument(
        "--require-baseline",
        action="store_true",
        help="CI mode: a missing release tag is an error, not a skip",
    )
    ap.add_argument(
        "--list", action="store_true", help="print all findings, ignoring the allowlist"
    )
    ap.add_argument(
        "--self-test",
        action="store_true",
        help="run scripts/tests/check-schema-breaking.test.sh (each Breaking class must fail)",
    )
    args = ap.parse_args()
    if args.self_test:
        test = os.path.join(_HERE, "tests", "check-schema-breaking.test.sh")
        return subprocess.run(["bash", test]).returncode

    if args.baseline_file:
        with open(args.baseline_file, encoding="utf-8") as f:
            base = json.load(f)
        label = args.baseline_file
    else:
        ref = args.baseline_ref
        if not ref:
            ref = latest_release_tag(_git("tag", "-l", "v*").stdout.split())
        if not ref:
            msg = "no v* release tag found (run 'git fetch --tags'; CI needs GIT_DEPTH: 0)"
            if args.require_baseline:
                print(f"ERROR: {msg}", file=sys.stderr)
                return 1
            print(f"skipped: {msg}")
            return 0
        shown = _git("show", f"{ref}:{_SCHEMA_REL}")
        if shown.returncode != 0:
            print(
                f"ERROR: cannot read {_SCHEMA_REL} at {ref}: {shown.stderr.strip()}",
                file=sys.stderr,
            )
            return 1
        base = json.loads(shown.stdout)
        label = ref

    with open(args.candidate, encoding="utf-8") as f:
        cand = json.load(f)

    findings = diff_schemas(base, cand)
    if args.list:
        for rule, loc in findings:
            print(f"{rule} | {loc}")
        print(f"{len(findings)} finding(s) vs {label}")
        return 0

    entries, errors = load_allowlist(
        args.allowlist, deprecation_anchors(args.stability)
    )
    remaining, stale = apply_allowlist(findings, entries)
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    if remaining or errors:
        if remaining:
            print(
                f"ERROR: {len(remaining)} Breaking API change(s) vs {label} "
                "(stability.md 'Change classes'):",
                file=sys.stderr,
            )
            for rule, loc in remaining:
                print(f"  {rule:20} {loc}", file=sys.stderr)
            print(
                "\nA Breaking change needs a deprecation window. Either keep the old shape,"
                "\nor add a '### ' row under 'Current deprecations' in stability.md and an"
                "\nentry in scripts/schema-breaking-allowlist.txt citing it.",
                file=sys.stderr,
            )
        return 1
    if stale:
        print(
            f"note: {len(stale)} allowlist entr(ies) match nothing (stale): lines {stale}"
        )
    print(f"No unallowed Breaking changes vs {label} ({len(findings)} allowlisted).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
